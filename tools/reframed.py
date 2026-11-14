#!/usr/bin/env python3
"""Quick manipulation of Reframed (.frm) recordings.

Subcommands:
  info      <frm>                      print tracks, size, fps, duration, trim
  extract   <frm> [-o OUT]             copy screen/webcam/mic tracks out of the package
  blur-bg   <frm|webcam.mp4> [opts]    blur the webcam background, keep the person sharp
  normalize-audio <frm|audio> [opts]   two-pass EBU R128 loudness normalization (YouTube: -14 LUFS)
  compose   <frm> [opts]               screen + webcam overlay + mic -> one MP4

Requires: ffmpeg/ffprobe on PATH. blur-bg also needs: python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

TRACKS = ("screen.mp4", "webcam.mp4", "mic-audio.m4a")


def run(cmd):
    print("+", " ".join(map(str, cmd)), file=sys.stderr)
    subprocess.run(cmd, check=True)


def probe(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,avg_frame_rate:format=duration", "-of", "json", str(path)])
    j = json.loads(out)
    s = j["streams"][0]
    return s["width"], s["height"], s["avg_frame_rate"], float(j["format"]["duration"])


def load_project(frm):
    return json.loads((Path(frm) / "project.json").read_text())


def cmd_info(a):
    frm = Path(a.frm)
    p = load_project(frm)
    e = p["editorState"]
    print(f"name: {p['name']}  fps: {p['fps']}  screen: {p['screenSize']}  webcam: {p['webcamSize']}")
    print(f"trim: {e['trimStartSeconds']:.2f} -> {e['trimEndSeconds']:.2f}  camera layout: {e['cameraLayout']}")
    total = sum(f.stat().st_size for f in frm.rglob("*") if f.is_file())
    print(f"total size: {total/1e6:.1f} MB")
    for t in TRACKS:
        f = frm / t
        if f.exists():
            print(f"{t}: {f.stat().st_size/1e6:.1f} MB")


def cmd_extract(a):
    frm = Path(a.frm)
    out = Path(a.output) if a.output else frm.parent / "extracted" / frm.stem
    out.mkdir(parents=True, exist_ok=True)
    for t in TRACKS:
        if (frm / t).exists():
            shutil.copy2(frm / t, out / t)
            print("copied", out / t)


def cmd_blur_bg(a):
    import queue, threading, time
    import cv2, numpy as np, mediapipe as mp

    src = Path(a.input)
    if src.is_dir():
        src = src / "webcam.mp4"
    dst = Path(a.output) if a.output else src.with_name(src.stem + "_blurred" + src.suffix)
    w, h, fps, dur = probe(src)
    fn, fd = fps.split("/")
    total = max(1, dur * float(fn) / float(fd))
    if a.encoder == "videotoolbox":  # Apple Silicon hardware encoder
        enc = ["-c:v", "h264_videotoolbox", "-b:v", a.bitrate, "-allow_sw", "1"]
    else:
        enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", fps, "-i", "-", "-i", str(src), "-map", "0:v", "-map", "1:a?",
         *enc, "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", str(dst)],
        stdin=subprocess.PIPE)

    # decode and encode-feed run in their own threads (cv2/pipe IO release the GIL)
    rq, wq = queue.Queue(maxsize=32), queue.Queue(maxsize=32)

    def reader():
        cap = cv2.VideoCapture(str(src))
        while True:
            ok, frame = cap.read()
            rq.put(frame if ok else None)
            if not ok:
                break

    def writer():
        while True:
            buf = wq.get()
            if buf is None:
                break
            ff.stdin.write(buf)

    tr = threading.Thread(target=reader, daemon=True)
    tw = threading.Thread(target=writer, daemon=True)
    tr.start(); tw.start()

    seg = mp.solutions.selfie_segmentation.SelfieSegmentation(model_selection=1)
    # The model works at 256x144 internally, so segment a small frame; blur a small frame too
    # (blurring at 1/4 size then upscaling is visually the same as a 4x larger kernel, far cheaper).
    sw, sh = max(2, int(w * a.seg_scale)), max(2, int(h * a.seg_scale))
    bw, bh = max(2, int(w * a.blur_scale)), max(2, int(h * a.blur_scale))
    k = max(3, int(a.strength * a.blur_scale)) | 1  # kernel must be odd
    fk = max(3, int(15 * a.seg_scale)) | 1          # mask feather
    prev = None
    n, t0 = 0, time.time()
    while True:
        frame = rq.get()
        if frame is None:
            break
        small = cv2.cvtColor(cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        mask = seg.process(small).segmentation_mask
        if prev is not None:  # temporal smoothing to reduce edge flicker
            mask = cv2.addWeighted(prev, a.smooth, mask, 1 - a.smooth, 0)
        prev = mask
        m = np.clip((mask - a.threshold) / max(1e-3, 1 - a.threshold), 0, 1)
        m = cv2.GaussianBlur(m, (fk, fk), 0)  # feather edge
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        bg = cv2.GaussianBlur(cv2.resize(frame, (bw, bh), interpolation=cv2.INTER_AREA), (k, k), 0)
        bg = cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)
        out = cv2.blendLinear(frame, bg, m, 1.0 - m)
        wq.put(out.tobytes())
        n += 1
        if n % 150 == 0:
            print(f"{n} frames ({n / (time.time() - t0):.1f} fps)", file=sys.stderr, flush=True)
            print(f"PROGRESS {min(100.0, n / total * 100):.1f}", file=sys.stderr, flush=True)
    wq.put(None)
    tw.join()
    ff.stdin.close()
    rc = ff.wait()
    dt = time.time() - t0
    print(f"wrote {dst}: {n} frames in {dt:.1f}s ({n / max(dt, 1e-6):.1f} fps), ffmpeg exit {rc}", file=sys.stderr)
    if rc:
        sys.exit(rc)


def _loudnorm_json(stderr):
    """Extract the JSON block printed by ffmpeg's loudnorm print_format=json."""
    i = stderr.rfind("{")
    j = stderr.rfind("}")
    return json.loads(stderr[i:j + 1])


def cmd_normalize_audio(a):
    src = Path(a.input)
    if src.is_dir():
        src = src / "mic-audio.m4a"
    dst = Path(a.output) if a.output else src.with_name(src.stem + "_normalized.m4a")
    target = f"I={a.lufs}:TP={a.true_peak}:LRA={a.lra}"
    # pass 1: measure
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-af",
           f"loudnorm={target}:print_format=json", "-f", "null", "-"]
    print("+", " ".join(cmd), file=sys.stderr)
    m = _loudnorm_json(subprocess.run(cmd, capture_output=True, text=True, check=True).stderr)
    print(f"measured: {m['input_i']} LUFS, TP {m['input_tp']} dB, LRA {m['input_lra']}", file=sys.stderr)
    if a.measure_only:
        print(json.dumps(m, indent=2))
        return
    # pass 2: apply with measured values (linear = no dynamic compression when possible)
    af = (f"loudnorm={target}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
          f"offset={m['target_offset']}:linear=true:print_format=summary")
    run(["ffmpeg", "-y", "-hide_banner", "-i", str(src), "-af", af, "-ar", "48000",
         "-c:a", "aac", "-b:a", "192k", str(dst)])
    print(f"wrote {dst}", file=sys.stderr)


def run_progress(cmd, total_seconds):
    """Run ffmpeg with -progress and print 'PROGRESS <percent>' lines (parsed by the web app)."""
    print("+", " ".join(map(str, cmd)), file=sys.stderr, flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
    last = -1.0
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                pct = min(100.0, int(line.split("=")[1]) / 1e4 / max(total_seconds, 1e-6))
            except ValueError:
                continue
            if pct - last >= 0.5:
                last = pct
                print(f"PROGRESS {pct:.1f}", file=sys.stderr, flush=True)
    if proc.wait():
        sys.exit(proc.returncode)
    print("PROGRESS 100", file=sys.stderr, flush=True)


def make_mask(w, h, r):
    """Write a grayscale PNG: white rounded rectangle (corner radius r px; r = w/2 on a square = circle)."""
    import tempfile
    path = Path(tempfile.mkstemp(suffix=".png", prefix="reframed-mask-")[1])
    expr = (f"255*clip({r}-hypot(max(abs(X+0.5-{w / 2})-({w / 2}-{r}),0),"
            f"max(abs(Y+0.5-{h / 2})-({h / 2}-{r}),0))+0.5,0,1)")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=black:s={w}x{h},format=gray,geq=lum='{expr}'",
                    "-frames:v", "1", str(path)], check=True)
    return path


def encoder_args(a, width, height):
    hevc = a.codec == "hevc"
    if a.encoder == "x264":  # software
        return ["-c:v", "libx265" if hevc else "libx264", "-preset", "veryfast",
                "-crf", {"high": "18", "medium": "22", "low": "26"}[a.quality]] + (["-tag:v", "hvc1"] if hevc else [])
    # Apple VideoToolbox hardware encoder; bitrate scaled from a 1080p reference
    mbps = {"high": 12, "medium": 7, "low": 4}[a.quality] * (width * height) / (1920 * 1080) * (0.65 if hevc else 1)
    return ["-c:v", "hevc_videotoolbox" if hevc else "h264_videotoolbox", "-b:v", f"{max(mbps, 1):.1f}M",
            "-allow_sw", "1"] + (["-tag:v", "hvc1"] if hevc else [])


def keep_segments(ts, te, cuts):
    """Complement of the cut ranges inside [ts, te], as (start, end) relative to ts."""
    segs, cur = [], ts
    for cs, ce in sorted(cuts):
        cs, ce = max(cs, ts), min(ce, te)
        if ce <= cs:
            continue
        if cs - cur > 0.02:
            segs.append((cur - ts, cs - ts))
        cur = max(cur, ce)
    if te - cur > 0.02:
        segs.append((cur - ts, te - ts))
    return segs


def cmd_compose(a):
    import time
    frm = Path(a.frm)
    p = load_project(frm)
    e = p["editorState"]
    sw, sh = p["screenSize"]["width"], p["screenSize"]["height"]
    lay = e["cameraLayout"]
    rx = lay["relativeX"] if a.cam_x is None else a.cam_x
    ry = lay["relativeY"] if a.cam_y is None else a.cam_y
    rw = lay["relativeWidth"] if a.cam_width is None else a.cam_width
    ts, te = e["trimStartSeconds"], e["trimEndSeconds"]
    t = ["-ss", str(ts), "-to", str(te)]
    hw = ["-hwaccel", "videotoolbox"] if a.encoder == "videotoolbox" else []  # hardware decode
    out = Path(a.output) if a.output else frm.parent / f"{frm.stem}-composed.mp4"
    audio = a.audio or frm / "mic-audio.m4a"
    oh = (a.height or sh) // 2 * 2
    ow = int(sw * oh / sh) // 2 * 2
    post = ",".join(([f"scale={ow}:{oh}"] if a.height else []) + ["format=yuv420p"])
    # Drop to the output frame rate first: the hardware encoder (~250 frames/s at 1080p on an M5) is the
    # bottleneck and the screen track is ~69 fps, so every later stage then handles fewer frames.
    pre = f"fps={a.fps}" if a.fps else "null"
    mask = None
    inputs = [*hw, *t, "-i", str(frm / "screen.mp4")]

    # 1) picture-in-picture -> [vfull]
    if a.no_webcam:
        inputs += [*t, "-i", str(audio)]
        ai = 1
        graph = f"[0:v]{pre}[vfull]"
    else:
        cam = frm / (a.webcam or "webcam.mp4")
        if not cam.exists():  # allow a processed webcam next to the package
            cam = Path(a.webcam)
        cw = int(sw * rw) // 2 * 2
        x, y = int(sw * rx), int(sh * ry)
        circle = a.cam_shape == "circle"
        ws, hs = p["webcamSize"]["width"], p["webcamSize"]["height"]
        chh = cw if circle else int(cw * hs / ws) // 2 * 2
        radius = cw / 2 if circle else min(max(a.cam_radius, 0) * cw, cw / 2, chh / 2)
        chain = ""
        zoom = max(a.cam_zoom, 1)
        if circle or zoom > 1:  # crop: zoom + focus point choose which part of the camera frame is shown
            kw = int((min(ws, hs) if circle else ws) / zoom) // 2 * 2
            kh = int((min(ws, hs) if circle else hs) / zoom) // 2 * 2
            cx = int(min(max(a.cam_fx * ws - kw / 2, 0), ws - kw))
            cy = int(min(max(a.cam_fy * hs - kh / 2, 0), hs - kh))
            chain = f"crop={kw}:{kh}:{cx}:{cy},"
        chain += f"scale={cw}:{chh}" + (",hflip" if a.mirror else "")
        inputs += [*hw, *t, "-i", str(cam), *t, "-i", str(audio)]
        ai = 2
        if radius >= 1:  # rounded corners / circle: alpha mask rendered once, then merged per frame
            mask = make_mask(cw, chh, radius)
            inputs += ["-loop", "1", "-i", str(mask)]
            graph = (f"[1:v]{chain},format=yuva420p[c];[3:v]format=gray[m];[c][m]alphamerge[cam];"
                     f"[0:v]{pre}[scr];[scr][cam]overlay={x}:{y}[vfull]")
        else:
            graph = f"[1:v]{chain}[cam];[0:v]{pre}[scr];[scr][cam]overlay={x}:{y}[vfull]"

    # 2) cuts: keep the segments between the cut ranges and join them
    cuts = [tuple(float(v) for v in c.split("-")) for c in a.cuts.split(",") if c] if a.cuts else []
    segs = keep_segments(ts, te, cuts)
    if not segs:
        sys.exit("nothing left to export: the cuts cover the whole recording")
    total = sum(e2 - s2 for s2, e2 in segs)
    if cuts:
        n = len(segs)
        graph += (f";[vfull]split={n}" + "".join(f"[vs{i}]" for i in range(n)) +
                  f";[{ai}:a]asplit={n}" + "".join(f"[as{i}]" for i in range(n)))
        for i, (s2, e2) in enumerate(segs):
            graph += (f";[vs{i}]trim={s2:.3f}:{e2:.3f},setpts=PTS-STARTPTS[v{i}]"
                      f";[as{i}]atrim={s2:.3f}:{e2:.3f},asetpts=PTS-STARTPTS[a{i}]")
        graph += ";" + "".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vc][ac]"
        vlabel, amap = "[vc]", "[ac]"
    else:
        vlabel, amap = "[vfull]", f"{ai}:a"
    graph += f";{vlabel}{post}[v]"

    cmd = ["ffmpeg", "-y", "-hide_banner", "-v", "warning", "-nostats", "-progress", "pipe:1", *inputs,
           "-filter_complex", graph, "-map", "[v]", "-map", amap, *encoder_args(a, ow, oh),
           "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", "-shortest", str(out)]
    t0 = time.time()
    try:
        run_progress(cmd, total)
    finally:
        if mask:
            mask.unlink(missing_ok=True)
    dt = time.time() - t0
    print(f"wrote {out}: {ow}x{oh}, {total:.1f}s of video ({len(segs)} segment(s)), {out.stat().st_size / 1e6:.1f} MB "
          f"in {dt:.1f}s ({total / max(dt, 1e-6):.1f}x realtime)", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("info"); s.add_argument("frm"); s.set_defaults(f=cmd_info)
    s = sp.add_parser("extract"); s.add_argument("frm"); s.add_argument("-o", "--output"); s.set_defaults(f=cmd_extract)
    s = sp.add_parser("blur-bg"); s.add_argument("input", help=".frm dir, folder, or webcam.mp4")
    s.add_argument("-o", "--output")
    s.add_argument("--strength", type=int, default=51, help="blur kernel size (bigger = blurrier)")
    s.add_argument("--threshold", type=float, default=0.5, help="person mask cutoff 0-1")
    s.add_argument("--smooth", type=float, default=0.5, help="temporal mask smoothing 0-1")
    s.add_argument("--seg-scale", type=float, default=0.25, help="downscale for segmentation (speed)")
    s.add_argument("--blur-scale", type=float, default=0.25, help="downscale for the background blur (speed)")
    s.add_argument("--encoder", choices=["videotoolbox", "x264"], default="videotoolbox",
                   help="videotoolbox = Apple hardware encoder (fast), x264 = software")
    s.add_argument("--bitrate", default="8M", help="video bitrate for videotoolbox")
    s.set_defaults(f=cmd_blur_bg)
    s = sp.add_parser("normalize-audio"); s.add_argument("input", help=".frm dir, folder, or audio file")
    s.add_argument("-o", "--output")
    s.add_argument("--lufs", type=float, default=-14.0, help="integrated loudness target (YouTube ~ -14)")
    s.add_argument("--true-peak", type=float, default=-1.5, help="true peak ceiling in dBTP")
    s.add_argument("--lra", type=float, default=11.0, help="loudness range target")
    s.add_argument("--measure-only", action="store_true", help="only print measured loudness as JSON")
    s.set_defaults(f=cmd_normalize_audio)
    s = sp.add_parser("compose"); s.add_argument("frm"); s.add_argument("-o", "--output")
    s.add_argument("--audio", help="alternate audio file, e.g. mic-audio_normalized.m4a")
    s.add_argument("--webcam", help="alternate webcam file, e.g. webcam_blurred.mp4")
    s.add_argument("--no-webcam", action="store_true", help="screen + audio only")
    s.add_argument("--cam-x", type=float, help="camera left edge, fraction of screen width (default: project.json)")
    s.add_argument("--cam-y", type=float, help="camera top edge, fraction of screen height")
    s.add_argument("--cam-width", type=float, help="camera width, fraction of screen width")
    s.add_argument("--mirror", action="store_true", help="flip the camera horizontally")
    s.add_argument("--cam-shape", choices=["rect", "circle"], default="rect", help="circle = centre-cropped round camera")
    s.add_argument("--cam-radius", type=float, default=0, help="corner radius as a fraction of camera width (rect only)")
    s.add_argument("--cam-zoom", type=float, default=1, help="zoom into the camera frame (1 = widest)")
    s.add_argument("--cam-fx", type=float, default=0.5, help="horizontal focus point 0-1 (used when zoomed or circle)")
    s.add_argument("--cam-fy", type=float, default=0.5, help="vertical focus point 0-1 (used when zoomed or circle)")
    s.add_argument("--cuts", default="", help="ranges to remove, in seconds: 'start-end,start-end'")
    s.add_argument("--height", type=int, default=0, help="output height, e.g. 1080 or 720 (0 = same as the recording)")
    s.add_argument("--fps", type=int, default=0, help="output frame rate (0 = same as the recording)")
    s.add_argument("--codec", choices=["h264", "hevc"], default="h264")
    s.add_argument("--quality", choices=["high", "medium", "low"], default="high")
    s.add_argument("--encoder", choices=["videotoolbox", "x264"], default="videotoolbox",
                   help="videotoolbox = Apple hardware decode + encode, x264 = software")
    s.set_defaults(f=cmd_compose)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
