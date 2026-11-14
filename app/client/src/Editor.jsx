import { useEffect, useRef, useState } from "react";
import Timeline from "./Timeline.jsx";

const fmtT = (t = 0) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const EXPORT_DEFAULTS = { height: 0, fps: 30, codec: "h264", quality: "high", encoder: "videotoolbox" };
const loadExport = () => {
  try { return { ...EXPORT_DEFAULTS, ...JSON.parse(localStorage.getItem("reframed.export") || "{}") }; } catch { return EXPORT_DEFAULTS; }
};

export default function Editor({ project, busy, lastJob, onExport, onCancel }) {
  const has = (f) => project.extracted.includes(f);
  const { width: sw, height: sh } = project.screenSize;
  const { width: cw, height: ch } = project.webcamSize || { width: 16, height: 9 };
  // camera height as a fraction of the stage height (a circle is a centre-cropped square)
  const camH = (w, shape) => (shape === "circle" ? (w * sw) / sh : (w * sw * ch) / cw / sh);

  const defaults = {
    camera: has("webcam_blurred.mp4") ? "webcam_blurred.mp4" : has("webcam.mp4") ? "webcam.mp4" : "none",
    audio: has("mic-audio_normalized.m4a") ? "normalized" : "original",
    x: project.camera?.x ?? 0.72, y: project.camera?.y ?? 0.04, w: project.camera?.w ?? 0.25,
    radius: 4, mirror: project.camera?.mirror ?? false, shape: "rect",
    zoom: 1, fx: 0.5, fy: 0.5, cuts: [],
  };
  const fit = (c) => {
    const w = clamp(c.w, 0.08, c.shape === "circle" ? Math.min(1, sh / sw) : 1);
    return { ...c, w, x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, Math.max(0, 1 - camH(w, c.shape))) };
  };

  const [cfg, setCfg] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [saved, setSaved] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [ex, setEx] = useState(loadExport);
  const setExport = (k) => (e) => {
    const next = { ...ex, [k]: ["height", "fps"].includes(k) ? +e.target.value : e.target.value };
    setEx(next);
    try { localStorage.setItem("reframed.export", JSON.stringify(next)); } catch {}
  };
  const audioRef = useRef(), screenRef = useRef(), camRef = useRef(), stageRef = useRef();
  const playingRef = useRef(false), pendingTime = useRef(null), loaded = useRef(false), cutsRef = useRef([]);
  cutsRef.current = cfg?.cuts || [];

  // load saved settings (falling back to what Reframed stored / what files exist)
  useEffect(() => {
    fetch(`/api/editor/${project.name}`).then((r) => r.json()).catch(() => null).then((s) => {
      const c = { ...defaults, ...(s || {}) };
      if (c.camera !== "none" && !has(c.camera)) c.camera = defaults.camera;
      if (c.audio === "normalized" && !has("mic-audio_normalized.m4a")) c.audio = "original";
      setCfg(fit(c));
    });
  }, []);

  // autosave (debounced)
  useEffect(() => {
    if (!cfg) return;
    if (!loaded.current) { loaded.current = true; return; }
    setSaved(false);
    const t = setTimeout(() => {
      fetch(`/api/editor/${project.name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) })
        .then(() => setSaved(true));
    }, 400);
    return () => clearTimeout(t);
  }, [cfg]);

  // The audio element is the master clock; both videos are slaved to it.
  useEffect(() => {
    let raf;
    const tick = () => {
      const a = audioRef.current;
      if (a && pendingTime.current == null && a.readyState >= 1) {
        let t = a.currentTime;
        if (playingRef.current) { // skip over cut ranges while playing
          const c = cutsRef.current.find((c) => t >= c.start && t < c.end - 0.01);
          if (c) {
            if (c.end >= a.duration - 0.05) a.pause();
            else { a.currentTime = c.end; t = c.end; }
          }
        }
        setTime(t);
        for (const v of [screenRef.current, camRef.current]) {
          if (!v || v.readyState < 1 || v.seeking) continue;
          const d = v.currentTime - t;
          if (playingRef.current) {
            if (v.paused && t < v.duration) v.play().catch(() => {});
            if (Math.abs(d) > 0.4) v.currentTime = t + 0.05;       // far off: jump
            else v.playbackRate = d > 0.04 ? 0.94 : d < -0.04 ? 1.06 : 1; // close: nudge speed, no stutter
          } else {
            if (!v.paused) v.pause();
            if (Math.abs(d) > 0.02) v.currentTime = t;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume, cfg?.audio]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { if (a.ended || a.currentTime >= a.duration) a.currentTime = 0; a.play(); } else a.pause();
  };
  const seek = (t) => { const a = audioRef.current; if (a) { a.currentTime = clamp(t, 0, a.duration || 0); setTime(a.currentTime); } };
  const setPlay = (p) => { playingRef.current = p; setPlaying(p); };

  useEffect(() => {
    const key = (e) => {
      if (["INPUT", "BUTTON", "SELECT"].includes(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      if (e.code === "ArrowLeft") seek(audioRef.current.currentTime - 5);
      if (e.code === "ArrowRight") seek(audioRef.current.currentTime + 5);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  if (!has("screen.mp4") || !has("mic-audio.m4a"))
    return <p className="muted">This project is not extracted yet – open the Tools tab and run "Extract" first.</p>;
  if (!cfg) return <p className="muted">Loading…</p>;

  const update = (patch) => setCfg((c) => fit({ ...c, ...patch }));
  const switchAudio = (audio) => {
    pendingTime.current = audioRef.current?.currentTime ?? 0; // restored in onLoadedMetadata
    update({ audio });
  };

  // drag to move / resize the camera on the stage
  const drag = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    const start = { px: e.clientX, py: e.clientY, x: cfg.x, y: cfg.y, w: cfg.w };
    const move = (ev) => {
      const dx = (ev.clientX - start.px) / rect.width, dy = (ev.clientY - start.py) / rect.height;
      update(mode === "move" ? { x: start.x + dx, y: start.y + dy } : { w: clamp(start.w + dx, 0.08, 1 - start.x) });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const mx = 0.02, my = (0.02 * sw) / sh;
  const corner = (right, bottom) => update({ x: right ? 1 - cfg.w - mx : mx, y: bottom ? 1 - camH(cfg.w, cfg.shape) - my : my });

  const v = project.extractedBytes;
  const audioSrc = cfg.audio === "normalized" ? `/media/${project.name}/mic-audio_normalized.m4a?v=${v}` : `/api/preview-audio/${project.name}`;
  const circle = cfg.shape === "circle";
  // which part of the camera frame is shown (same maths as `compose --cam-zoom/--cam-fx/--cam-fy`)
  const kw = (circle ? Math.min(cw, ch) : cw) / cfg.zoom, kh = (circle ? Math.min(cw, ch) : ch) / cfg.zoom;
  const cropX = clamp(cfg.fx * cw - kw / 2, 0, cw - kw), cropY = clamp(cfg.fy * ch - kh / 2, 0, ch - kh);
  const camStyle = {
    position: "absolute", maxWidth: "none", objectFit: "fill", width: `${(cw / kw) * 100}%`, height: `${(ch / kh) * 100}%`,
    left: `${(-(cfg.mirror ? cw - kw - cropX : cropX) / kw) * 100}%`, top: `${(-cropY / kh) * 100}%`, transform: cfg.mirror ? "scaleX(-1)" : "none",
  };
  const cutTotal = cfg.cuts.reduce((n, c) => n + (c.end - c.start), 0);
  const exporting = busy && lastJob?.command === "compose";

  return (
    <div className="editor">
      <div className="stagecol">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${sw} / ${sh}`, maxWidth: `calc(72vh * ${sw / sh})` }} onClick={toggle}>
          <video ref={screenRef} className="screen" muted playsInline preload="auto" src={`/media/${project.name}/screen.mp4`} />
          {cfg.camera !== "none" && (
            <div
              className="cam"
              style={{ left: `${cfg.x * 100}%`, top: `${cfg.y * 100}%`, width: `${cfg.w * 100}%`, aspectRatio: circle ? "1 / 1" : `${cw} / ${ch}`, borderRadius: circle ? "50%" : `${cfg.radius}% / ${(cfg.radius * cw) / ch}%` }}
              onPointerDown={drag("move")}
              onClick={(e) => e.stopPropagation()}
            >
              <video
                ref={camRef} key={cfg.camera} muted playsInline preload="auto" draggable={false}
                style={camStyle}
                src={`/media/${project.name}/${cfg.camera}?v=${v}`}
                onLoadedMetadata={(e) => { e.target.currentTime = audioRef.current?.currentTime ?? 0; }}
              />
              <span className="handle" onPointerDown={drag("resize")} />
            </div>
          )}
        </div>

        <div className="transport">
          <button onClick={toggle}>{playing ? "Pause" : "Play"}</button>
          <span className="time">{fmtT(time)} / {fmtT(duration)}{cutTotal > 0 && ` (${fmtT(duration - cutTotal)} after cuts)`}</span>
          <input type="range" min="0" max={duration || 0} step="0.01" value={Math.min(time, duration || 0)} onChange={(e) => seek(+e.target.value)} />
          <label className="vol">Vol<input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => setVolume(+e.target.value)} /></label>
        </div>
        <audio
          ref={audioRef} src={audioSrc} preload="auto"
          onLoadedMetadata={(e) => {
            setDuration(e.target.duration);
            if (pendingTime.current != null) { e.target.currentTime = pendingTime.current; pendingTime.current = null; if (playingRef.current) e.target.play(); }
          }}
          onPlay={() => setPlay(true)} onPause={() => { if (pendingTime.current == null) setPlay(false); }} onEnded={() => setPlay(false)}
        />
        <Timeline project={project} duration={duration} time={time} cuts={cfg.cuts} onSeek={seek} onCuts={(cuts) => update({ cuts })} />
        <p className="muted">Click the video or press Space to play/pause, ←/→ to skip 5 s. Drag the camera to move it, drag its corner handle to resize.</p>
      </div>

      <div className="settings">
        <section>
          <h2>Camera</h2>
          {[["none", "No camera"], ["webcam.mp4", "Original"], ["webcam_blurred.mp4", "Blurred background"]].map(([f, label]) => (
            <label key={f} className="check">
              <input type="radio" name="camera" checked={cfg.camera === f} disabled={f !== "none" && !has(f)} onChange={() => update({ camera: f })} />
              {label}{f !== "none" && !has(f) && <span className="muted"> (not generated)</span>}
            </label>
          ))}
        </section>
        <section>
          <h2>Audio</h2>
          {[["original", "Original", true], ["normalized", "Normalized (LUFS)", has("mic-audio_normalized.m4a")]].map(([f, label, ok]) => (
            <label key={f} className="check">
              <input type="radio" name="audio" checked={cfg.audio === f} disabled={!ok} onChange={() => switchAudio(f)} />
              {label}{!ok && <span className="muted"> (not generated)</span>}
            </label>
          ))}
        </section>
        <section>
          <h2>Picture in picture</h2>
          <div className="corners">
            <button className="tab" onClick={() => corner(false, false)}>↖</button>
            <button className="tab" onClick={() => corner(true, false)}>↗</button>
            <button className="tab" onClick={() => corner(false, true)}>↙</button>
            <button className="tab" onClick={() => corner(true, true)}>↘</button>
          </div>
          <div className="corners">
            <button className={"tab" + (!circle ? " active" : "")} onClick={() => update({ shape: "rect" })}>Rectangle</button>
            <button className={"tab" + (circle ? " active" : "")} onClick={() => update({ shape: "circle" })}>Circle</button>
          </div>
          <label>Size ({Math.round(cfg.w * 100)}% of width)<input type="range" min="0.08" max="1" step="0.01" value={cfg.w} onChange={(e) => update({ w: +e.target.value })} /></label>
          <label>Corner radius ({cfg.radius})<input type="range" min="0" max="50" step="1" disabled={circle} value={cfg.radius} onChange={(e) => update({ radius: +e.target.value })} /></label>
          {(
            <>
              <label>Camera zoom ({cfg.zoom.toFixed(1)}×)<input type="range" min="1" max="4" step="0.05" value={cfg.zoom} onChange={(e) => update({ zoom: +e.target.value })} /></label>
              <label>Move left / right<input type="range" min="0" max="1" step="0.01" value={cfg.fx} onChange={(e) => update({ fx: +e.target.value })} /></label>
              <label>Move up / down<input type="range" min="0" max="1" step="0.01" value={cfg.fy} onChange={(e) => update({ fy: +e.target.value })} /></label>
            </>
          )}
          <label className="check"><input type="checkbox" checked={cfg.mirror} onChange={(e) => update({ mirror: e.target.checked })} /> Mirror camera</label>
          <button className="tab" onClick={() => update({ x: defaults.x, y: defaults.y, w: defaults.w, mirror: defaults.mirror, shape: "rect", zoom: 1, fx: 0.5, fy: 0.5 })}>Reset to Reframed layout</button>
        </section>
        <section>
          <h2>Export</h2>
          {!exportOpen && !exporting && <button disabled={busy || !saved} onClick={() => setExportOpen(true)}>Export…</button>}
          {exportOpen && !exporting && (
            <div className="exportform">
              <label>Resolution
                <select value={ex.height} onChange={setExport("height")}>
                  <option value={0}>Same as recording ({sw}×{sh})</option>
                  <option value={2160}>2160p (4K)</option>
                  <option value={1440}>1440p</option>
                  <option value={1080}>1080p</option>
                  <option value={720}>720p</option>
                </select>
              </label>
              <label>Frame rate
                <select value={ex.fps} onChange={setExport("fps")}>
                  <option value={30}>30 fps (fastest export)</option>
                  <option value={60}>60 fps</option>
                  <option value={0}>Same as recording (slowest)</option>
                  <option value={24}>24 fps</option>
                </select>
              </label>
              <label>Format
                <select value={ex.codec} onChange={setExport("codec")}>
                  <option value="h264">H.264 (most compatible)</option>
                  <option value="hevc">HEVC / H.265 (smaller file)</option>
                </select>
              </label>
              <label>Quality
                <select value={ex.quality} onChange={setExport("quality")}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low (small file)</option>
                </select>
              </label>
              <label>Encoder
                <select value={ex.encoder} onChange={setExport("encoder")}>
                  <option value="videotoolbox">Apple hardware (fast)</option>
                  <option value="x264">Software (slow, smaller)</option>
                </select>
              </label>
              <button disabled={busy || !saved} onClick={() => { setExportOpen(false); onExport(ex); }}>Start export</button>
              <button className="tab" onClick={() => setExportOpen(false)}>Cancel</button>
            </div>
          )}
          {exporting && (
            <div>
              <div className="bar"><div style={{ width: `${lastJob.progress || 0}%` }} /></div>
              <p className="muted">Exporting… {Math.round(lastJob.progress || 0)}%</p>
              <button className="tab" onClick={() => onCancel(lastJob.id)}>Cancel export</button>
            </div>
          )}
          {!exporting && lastJob?.command === "compose" && lastJob.project === project.name && (
            <p className={lastJob.status === "failed" ? "error" : "muted"}>
              Last export: {lastJob.status}.{" "}
              {lastJob.status === "done" && <a href={`/media/${project.name}/composed.mp4?v=${lastJob.endedAt}`} target="_blank" rel="noreferrer">Open composed.mp4</a>}
              {lastJob.status === "failed" && <span> {lastJob.log.trim().split("\n").slice(-2).join(" ")}</span>}
            </p>
          )}
          <p className="muted">Writes extracted/{project.name}/composed.mp4 with the selected camera, audio, position, size, shape and cuts. {saved ? "Settings saved." : "Saving…"}</p>
        </section>
      </div>
    </div>
  );
}
