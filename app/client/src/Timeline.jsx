import { useEffect, useLayoutEffect, useRef, useState } from "react";

const fmtT = (t = 0) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// merge overlapping / touching ranges
export const mergeCuts = (cuts) => {
  const out = [];
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 0.01) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
};

export default function Timeline({ project, duration, time, cuts, onSeek, onCuts }) {
  const [peaks, setPeaks] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState(null); // {a, b} seconds
  const [width, setWidth] = useState(0);
  const innerRef = useRef(), canvasRef = useRef(), scrollRef = useRef(), dragging = useRef(false);

  useEffect(() => {
    fetch(`/api/waveform/${project.name}`).then((r) => (r.ok ? r.json() : null)).then(setPeaks).catch(() => setPeaks(null));
  }, [project.name]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, []);

  // draw the waveform (only when data / size changes; playhead, cuts and selection are plain divs)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.min(16000, Math.round(width * dpr)), H = Math.round(96 * dpr);
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (!peaks?.peaks?.length) return;
    const p = peaks.peaks, max = Math.max(0.05, ...p);
    g.fillStyle = getComputedStyle(cv).color;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((x / W) * p.length), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * p.length));
      let m = 0;
      for (let i = i0; i < i1 && i < p.length; i++) m = Math.max(m, p[i]);
      const h = Math.max(1, Math.pow(m / max, 0.7) * (H - 4)); // slight boost so quiet speech is still visible
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [peaks, width]);

  const total = duration || peaks?.duration || 0;

  // Zoom 1 = the whole clip fits. Zooming keeps the playhead centred; while playing zoomed-in, follow it.
  const centre = () => {
    const sc = scrollRef.current;
    if (sc && total) sc.scrollLeft = (time / total) * sc.scrollWidth - sc.clientWidth / 2;
  };
  useLayoutEffect(centre, [zoom]);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || zoom === 1 || !total || dragging.current) return;
    const x = (time / total) * sc.scrollWidth;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth) centre();
  }, [time]);
  const pct = (t) => `${(clamp(t / (total || 1), 0, 1)) * 100}%`;
  const timeAt = (clientX) => {
    const r = innerRef.current.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1) * total;
  };

  const down = (e) => {
    if (e.button !== 0 || !total) return;
    const x0 = e.clientX, t0 = timeAt(x0);
    let dragged = false;
    dragging.current = true;
    const move = (ev) => {
      if (!dragged && Math.abs(ev.clientX - x0) < 4) return;
      dragged = true;
      const t1 = timeAt(ev.clientX);
      setSel({ a: Math.min(t0, t1), b: Math.max(t0, t1) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragging.current = false;
      if (!dragged) { setSel(null); onSeek(t0); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cut = () => {
    if (!sel || sel.b - sel.a < 0.05) return;
    onCuts(mergeCuts([...cuts, { start: +sel.a.toFixed(3), end: +sel.b.toFixed(3) }]));
    setSel(null);
  };
  const restore = (c) => onCuts(cuts.filter((x) => x !== c));

  useEffect(() => {
    const key = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (sel && (e.key === "x" || e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); cut(); }
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  return (
    <div className="timeline">
      <div className="tlbar">
        <b>Timeline</b>
        <button disabled={!sel} onClick={cut}>Cut selection</button>
        <button className="tab" disabled={!sel} onClick={() => onSeek(sel.a)}>Go to start</button>
        <button className="tab" disabled={!sel} onClick={() => setSel(null)}>Clear</button>
        <span className="muted">{sel ? `Selected ${fmtT(sel.a)} – ${fmtT(sel.b)} (${(sel.b - sel.a).toFixed(1)} s)` : "Drag on the waveform to select, click to seek"}</span>
        <label className="vol">Zoom<input type="range" min="1" max="40" step="0.5" value={zoom} onChange={(e) => setZoom(+e.target.value)} /></label>
      </div>
      <div className="tlscroll" ref={scrollRef}>
        <div className="tlinner" ref={innerRef} style={{ width: `${zoom * 100}%` }} onPointerDown={down}>
          <canvas ref={canvasRef} />
          {cuts.map((c) => (
            <div key={c.start} className="tlcut" style={{ left: pct(c.start), width: `calc(${pct(c.end)} - ${pct(c.start)})` }} title={`Cut ${fmtT(c.start)} – ${fmtT(c.end)}`}>
              <button title="Remove this cut (restore the section)" onPointerDown={(e) => e.stopPropagation()} onClick={() => restore(c)}>✕</button>
            </div>
          ))}
          {sel && <div className="tlsel" style={{ left: pct(sel.a), width: `calc(${pct(sel.b)} - ${pct(sel.a)})` }} />}
          <div className="tlhead" style={{ left: pct(time) }} />
          {!peaks && <span className="muted tlmsg">Loading waveform…</span>}
        </div>
      </div>
      {cuts.length > 0 && (
        <div className="cutlist">
          <span className="muted">Cuts:</span>
          {cuts.map((c) => (
            <span key={c.start} className="chip">
              <a onClick={() => onSeek(Math.max(0, c.start - 2))} title="Play from 2 s before this cut">{fmtT(c.start)} – {fmtT(c.end)}</a>
              <button title="Restore this part" onClick={() => restore(c)}>✕</button>
            </span>
          ))}
          <button className="tab" onClick={() => onCuts([])}>Restore all</button>
        </div>
      )}
    </div>
  );
}
