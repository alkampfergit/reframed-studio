import { useEffect, useRef, useState } from "react";
import Editor from "./Editor.jsx";

const api = (url, opts) => fetch(url, opts).then((r) => r.json());
const post = (url, body) =>
  api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const VIDEOS = ["screen.mp4", "webcam.mp4", "webcam_blurred.mp4", "composed.mp4"];
const fmt = (b = 0) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB");

export default function App() {
  const [projects, setProjects] = useState([]);
  const [sel, setSel] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [openJob, setOpenJob] = useState(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [view, setView] = useState("editor");
  const [opts, setOpts] = useState({ strength: 51, threshold: 0.5, smooth: 0.5, segScale: 0.25, useBlurred: true, useNormalized: true, lufs: -14, truePeak: -1.5, lra: 11, measureOnly: false });

  const loadProjects = () =>
    api("/api/projects").then((p) => {
      setProjects(p);
      setSel((s) => s ?? p[0]?.name ?? null);
    });
  useEffect(() => { loadProjects(); }, []);

  // poll jobs while any is running
  useEffect(() => {
    const t = setInterval(async () => {
      const list = await api("/api/jobs");
      setJobs((prev) => {
        if (prev.some((j) => j.status === "running") && list.every((j) => j.status !== "running")) loadProjects();
        return list;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const project = projects.find((p) => p.name === sel);
  const run = async (command, options = opts) => {
    setError("");
    const r = await post("/api/jobs", { command, project: sel, options });
    if (r.error) setError(r.error);
    else setOpenJob(r.id);
  };
  const set = (k) => (e) => setOpts({ ...opts, [k]: e.target.type === "checkbox" ? e.target.checked : +e.target.value });
  const current = jobs.find((j) => j.id === openJob);
  const has = (f) => project?.extracted.includes(f);
  const busy = jobs.some((j) => j.status === "running");
  const videos = VIDEOS.filter(has);
  const shown = videos.includes(preview) ? preview : videos[videos.length - 1];

  return (
    <div className="app">
      <header>
        <h1>Reframed Studio</h1>
        <nav>
          <button className={"tab" + (view === "editor" ? " active" : "")} onClick={() => setView("editor")}>Editor</button>
          <button className={"tab" + (view === "tools" ? " active" : "")} onClick={() => setView("tools")}>Tools</button>
        </nav>
        {busy && <span className="muted">job running…</span>}
      </header>
      <aside>
        <h2>Projects</h2>
        {projects.map((p) => (
          <button key={p.name} className={"proj" + (p.name === sel ? " active" : "")} onClick={() => setSel(p.name)}>
            <b>{p.name}</b>
            <small>{p.screenSize?.width}x{p.screenSize?.height} · {p.fps}fps · {fmt(p.sizeBytes)}</small>
          </button>
        ))}
        {!projects.length && <p className="muted">No .frm projects found.</p>}
      </aside>

      {view === "editor" && (
        <div className="editorwrap">
          {project ? (
            <Editor key={project.name} project={project} busy={busy} lastJob={jobs[0]} onExport={() => run("compose", { fromEditor: true })} />
          ) : (
            <p className="muted">Select a project.</p>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {view === "tools" && <main>
        {project && (
          <>
            <section>
              <h2>1. Extract tracks</h2>
              <button disabled={busy} onClick={() => run("extract")}>Extract</button>
              <button disabled={busy} onClick={() => run("info")}>Info</button>
              <p className="muted">Project size: {fmt(project.sizeBytes)} · Extracted copies: {fmt(project.extractedBytes)} ({project.extracted.length} files)</p>
            </section>

            <section>
              <h2>2. Blur webcam background</h2>
              <div className="grid">
                <label>Blur strength ({opts.strength})<input type="range" min="5" max="151" step="2" value={opts.strength} onChange={set("strength")} /></label>
                <label>Mask threshold ({opts.threshold})<input type="range" min="0.1" max="0.9" step="0.05" value={opts.threshold} onChange={set("threshold")} /></label>
                <label>Smoothing ({opts.smooth})<input type="range" min="0" max="0.9" step="0.05" value={opts.smooth} onChange={set("smooth")} /></label>
                <label>Segmentation scale ({opts.segScale}) – lower is faster<input type="range" min="0.2" max="1" step="0.1" value={opts.segScale} onChange={set("segScale")} /></label>
              </div>
              <button disabled={busy || !has("webcam.mp4")} onClick={() => run("blur-bg")}>Blur background</button>
              {!has("webcam.mp4") && <span className="muted"> extract first</span>}
            </section>

            <section>
              <h2>3. Normalize audio (LUFS)</h2>
              <div className="grid">
                <label>Target LUFS ({opts.lufs}) – YouTube ≈ -14<input type="range" min="-24" max="-9" step="0.5" value={opts.lufs} onChange={set("lufs")} /></label>
                <label>True peak dBTP ({opts.truePeak})<input type="range" min="-6" max="0" step="0.5" value={opts.truePeak} onChange={set("truePeak")} /></label>
                <label>Loudness range LRA ({opts.lra})<input type="range" min="3" max="20" step="1" value={opts.lra} onChange={set("lra")} /></label>
              </div>
              <label className="check"><input type="checkbox" checked={opts.measureOnly} onChange={set("measureOnly")} /> Measure only (don't write a file)</label>
              <button disabled={busy || !has("mic-audio.m4a")} onClick={() => run("normalize-audio")}>{opts.measureOnly ? "Measure" : "Normalize"}</button>
              {!has("mic-audio.m4a") && <span className="muted"> extract first</span>}
              {has("mic-audio.m4a") && (
                <div className="grid audio">
                  <figure>
                    <figcaption>Original</figcaption>
                    <audio controls preload="none" src={`/api/preview-audio/${project.name}`} />
                  </figure>
                  <figure>
                    <figcaption>Normalized</figcaption>
                    {has("mic-audio_normalized.m4a") ? (
                      <audio controls preload="none" src={`/media/${project.name}/mic-audio_normalized.m4a?v=${project.extractedBytes}`} />
                    ) : (
                      <span className="muted">not generated yet</span>
                    )}
                  </figure>
                </div>
              )}
            </section>

            <section>
              <h2>4. Compose final video</h2>
              <label className="check"><input type="checkbox" checked={opts.useBlurred} onChange={set("useBlurred")} /> Use blurred webcam</label>
              <label className="check"><input type="checkbox" checked={opts.useNormalized} onChange={set("useNormalized")} /> Use normalized audio</label>
              <button disabled={busy || !has("screen.mp4")} onClick={() => run("compose")}>Compose</button>
            </section>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </main>}

      {view === "tools" && <aside className="right">
        <section className="preview">
          <div className="tabs">
            <h2>Preview</h2>
            {videos.map((f) => (
              <button key={f} className={"tab" + (f === shown ? " active" : "")} onClick={() => setPreview(f)}>{f}</button>
            ))}
          </div>
          {shown ? (
            <video key={project.name + shown + project.extractedBytes} controls preload="metadata" src={`/media/${project.name}/${shown}?v=${project.extractedBytes}`} />
          ) : (
            <p className="muted">No video yet – extract the project first.</p>
          )}
        </section>

        <section className="jobs">
          <h2>Jobs</h2>
          <div className="joblist">
            {jobs.map((j) => (
              <button key={j.id} className={"job " + j.status + (j.id === openJob ? " active" : "")} onClick={() => setOpenJob(j.id)}>
                #{j.id} {j.command} <small>{j.status}</small>
              </button>
            ))}
            {!jobs.length && <span className="muted">No jobs yet.</span>}
          </div>
          {current && <Log job={current} />}
          {current?.status === "running" && <button onClick={() => fetch(`/api/jobs/${current.id}`, { method: "DELETE" })}>Cancel</button>}
        </section>
      </aside>}
    </div>
  );
}

function Log({ job }) {
  const ref = useRef();
  useEffect(() => { ref.current && (ref.current.scrollTop = ref.current.scrollHeight); }, [job.log]);
  return <pre ref={ref} className="log">{job.log || "(no output yet)"}</pre>;
}
