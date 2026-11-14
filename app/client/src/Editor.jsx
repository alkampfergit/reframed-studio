import { useEffect, useRef, useState } from "react";

const fmtT = (t = 0) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export default function Editor({ project, busy, lastJob, onExport }) {
  const has = (f) => project.extracted.includes(f);
  const { width: sw, height: sh } = project.screenSize;
  const { width: cw, height: ch } = project.webcamSize || { width: 16, height: 9 };
  const camH = (w) => (w * sw * ch) / cw / sh; // camera height as a fraction of the stage height

  const defaults = {
    camera: has("webcam_blurred.mp4") ? "webcam_blurred.mp4" : has("webcam.mp4") ? "webcam.mp4" : "none",
    audio: has("mic-audio_normalized.m4a") ? "normalized" : "original",
    x: project.camera?.x ?? 0.72, y: project.camera?.y ?? 0.04, w: project.camera?.w ?? 0.25,
    radius: 4, mirror: project.camera?.mirror ?? false,
  };
  const fit = (c) => {
    const w = clamp(c.w, 0.08, 1);
    return { ...c, w, x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, Math.max(0, 1 - camH(w))) };
  };

  const [cfg, setCfg] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [saved, setSaved] = useState(true);
  const audioRef = useRef(), screenRef = useRef(), camRef = useRef(), stageRef = useRef();
  const playingRef = useRef(false), pendingTime = useRef(null), loaded = useRef(false);

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
        const t = a.currentTime;
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
  const corner = (right, bottom) => update({ x: right ? 1 - cfg.w - mx : mx, y: bottom ? 1 - camH(cfg.w) - my : my });

  const v = project.extractedBytes;
  const audioSrc = cfg.audio === "normalized" ? `/media/${project.name}/mic-audio_normalized.m4a?v=${v}` : `/api/preview-audio/${project.name}`;
  const exporting = busy && lastJob?.command === "compose";

  return (
    <div className="editor">
      <div className="stagecol">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${sw} / ${sh}`, maxWidth: `calc(72vh * ${sw / sh})` }} onClick={toggle}>
          <video ref={screenRef} className="screen" muted playsInline preload="auto" src={`/media/${project.name}/screen.mp4`} />
          {cfg.camera !== "none" && (
            <div
              className="cam"
              style={{ left: `${cfg.x * 100}%`, top: `${cfg.y * 100}%`, width: `${cfg.w * 100}%`, aspectRatio: `${cw} / ${ch}`, borderRadius: `${cfg.radius}% / ${(cfg.radius * cw) / ch}%` }}
              onPointerDown={drag("move")}
              onClick={(e) => e.stopPropagation()}
            >
              <video
                ref={camRef} key={cfg.camera} muted playsInline preload="auto" draggable={false}
                style={{ transform: cfg.mirror ? "scaleX(-1)" : "none" }}
                src={`/media/${project.name}/${cfg.camera}?v=${v}`}
                onLoadedMetadata={(e) => { e.target.currentTime = audioRef.current?.currentTime ?? 0; }}
              />
              <span className="handle" onPointerDown={drag("resize")} />
            </div>
          )}
        </div>

        <div className="transport">
          <button onClick={toggle}>{playing ? "Pause" : "Play"}</button>
          <span className="time">{fmtT(time)} / {fmtT(duration)}</span>
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
          <label>Size ({Math.round(cfg.w * 100)}% of width)<input type="range" min="0.08" max="1" step="0.01" value={cfg.w} onChange={(e) => update({ w: +e.target.value })} /></label>
          <label>Corner radius ({cfg.radius})<input type="range" min="0" max="50" step="1" value={cfg.radius} onChange={(e) => update({ radius: +e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={cfg.mirror} onChange={(e) => update({ mirror: e.target.checked })} /> Mirror camera</label>
          <button className="tab" onClick={() => update({ x: defaults.x, y: defaults.y, w: defaults.w, mirror: defaults.mirror })}>Reset to Reframed layout</button>
        </section>
        <section>
          <h2>Export</h2>
          <button disabled={busy || !saved} onClick={onExport}>{exporting ? "Exporting…" : "Export composed.mp4"}</button>
          {lastJob?.command === "compose" && <p className={lastJob.status === "failed" ? "error" : "muted"}>Last export: {lastJob.status}</p>}
          <p className="muted">Writes extracted/{project.name}/composed.mp4 with the selected camera, audio, position, size and mirror. Corner radius is preview-only for now. {saved ? "Settings saved." : "Saving…"}</p>
        </section>
      </div>
    </div>
  );
}
