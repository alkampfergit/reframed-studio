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
    w, h, fps, _ = probe(src)
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


def cmd_compose(a):
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
    out = Path(a.output) if a.output else frm.parent / f"{frm.stem}-composed.mp4"
    audio = a.audio or frm / "mic-audio.m4a"
    cmd = ["ffmpeg", "-y", *t, "-i", str(frm / "screen.mp4")]
    if a.no_webcam:
        cmd += [*t, "-i", str(audio), "-map", "0:v", "-map", "1:a"]
    else:
        cam = frm / (a.webcam or "webcam.mp4")
        if not cam.exists():  # allow a processed webcam next to the package
            cam = Path(a.webcam)
        cw = int(sw * rw) // 2 * 2
        x, y = int(sw * rx), int(sh * ry)
        flip = ",hflip" if a.mirror else ""
        cmd += [*t, "-i", str(cam), *t, "-i", str(audio), "-filter_complex",
                f"[1:v]scale={cw}:-2{flip}[cam];[0:v][cam]overlay={x}:{y}[v]", "-map", "[v]", "-map", "2:a"]
    run(cmd + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", "-shortest", str(out)])


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
    s.set_defaults(f=cmd_compose)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
