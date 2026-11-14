import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.REFRAMED_DIR || path.resolve(here, "../..");
const REPO = path.resolve(here, "../..");
const CLI = path.join(REPO, "tools/reframed.py"); // tools live in the repo, recordings in WORKSPACE
const EXTRACTED = path.join(WORKSPACE, "extracted");
const VENV_PY = path.join(REPO, "tools/.venv/bin/python");
const PYTHON = process.env.PYTHON || (fs.existsSync(VENV_PY) ? VENV_PY : "python3");
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());

const num = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);
const stem = (d) => d.replace(/\.frm$/, "");
const frmDirs = () =>
  fs.readdirSync(WORKSPACE).filter((d) => d.endsWith(".frm") && fs.statSync(path.join(WORKSPACE, d)).isDirectory());

const dirSize = (d) =>
  !fs.existsSync(d) ? 0 : fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
    const f = path.join(d, e.name);
    return n + (e.isDirectory() ? dirSize(f) : fs.statSync(f).size);
  }, 0);

function readProject(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORKSPACE, dir, "project.json"), "utf8"));
  } catch {
    return null;
  }
}

app.get("/api/projects", (_req, res) => {
  res.json(
    frmDirs().map((dir) => {
      const p = readProject(dir);
      const out = path.join(EXTRACTED, stem(dir));
      const outFiles = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => /\.(mp4|m4a)$/.test(f)) : [];
      return {
        dir,
        name: stem(dir),
        fps: p?.fps,
        screenSize: p?.screenSize,
        webcamSize: p?.webcamSize,
        trim: p && [p.editorState.trimStartSeconds, p.editorState.trimEndSeconds],
        extracted: outFiles,
        camera: p && {
          x: p.editorState.cameraLayout?.relativeX,
          y: p.editorState.cameraLayout?.relativeY,
          w: p.editorState.cameraLayout?.relativeWidth,
          mirror: !!p.editorState.cameraMirrored,
        },
        sizeBytes: dirSize(path.join(WORKSPACE, dir)),
        extractedBytes: dirSize(out),
      };
    })
  );
});

// Browser-playable copy of the original mic track: Reframed records ALAC, which Chrome/Firefox
// cannot play. Transcoded once to AAC (no gain change) and cached in extracted/<project>/.preview/.
app.get("/api/preview-audio/:project", (req, res) => {
  const project = req.params.project;
  if (!frmDirs().some((d) => stem(d) === project)) return res.status(404).end();
  const src = path.join(EXTRACTED, project, "mic-audio.m4a");
  if (!fs.existsSync(src)) return res.status(404).json({ error: "run extract first" });
  const dst = path.join(EXTRACTED, project, ".preview", "mic-audio.m4a");
  if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) return res.sendFile(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + ".tmp.m4a";
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-c:a", "aac", "-b:a", "256k", tmp]);
  ff.on("error", () => res.status(500).json({ error: "ffmpeg not found" }));
  ff.on("close", () => {
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return res.status(500).json({ error: "transcode failed" });
    fs.renameSync(tmp, dst);
    res.sendFile(dst);
  });
});

// Serve extracted media (supports range requests for <video>)
app.use("/media", express.static(EXTRACTED));

// ---- editor settings (saved per project in extracted/<project>/editor.json) ----
const CAMERAS = ["none", "webcam.mp4", "webcam_blurred.mp4"];
const editorFile = (project) => path.join(EXTRACTED, project, "editor.json");
const known = (project) => frmDirs().some((d) => stem(d) === project);
const readEditor = (project) => {
  try { return JSON.parse(fs.readFileSync(editorFile(project), "utf8")); } catch { return null; }
};
app.get("/api/editor/:project", (req, res) => {
  if (!known(req.params.project)) return res.status(404).end();
  res.json(readEditor(req.params.project));
});
app.put("/api/editor/:project", (req, res) => {
  const project = req.params.project;
  if (!known(project)) return res.status(404).end();
  const b = req.body || {};
  const cfg = {
    camera: CAMERAS.includes(b.camera) ? b.camera : "webcam.mp4",
    audio: b.audio === "normalized" ? "normalized" : "original",
    x: num(b.x, 0, 1, 0.7), y: num(b.y, 0, 1, 0.04), w: num(b.w, 0.05, 1, 0.25),
    radius: num(b.radius, 0, 50, 4), mirror: !!b.mirror,
    shape: b.shape === "circle" ? "circle" : "rect",
    zoom: num(b.zoom, 1, 4, 1), fx: num(b.fx, 0, 1, 0.5), fy: num(b.fy, 0, 1, 0.5),
    cuts: (Array.isArray(b.cuts) ? b.cuts : []).slice(0, 500)
      .map((c) => ({ start: num(c?.start, 0, 1e6, NaN), end: num(c?.end, 0, 1e6, NaN) }))
      .filter((c) => c.end > c.start)
      .sort((a, b2) => a.start - b2.start),
  };
  fs.mkdirSync(path.dirname(editorFile(project)), { recursive: true });
  fs.writeFileSync(editorFile(project), JSON.stringify(cfg, null, 2));
  res.json(cfg);
});

// ---- waveform peaks for the timeline (cached in extracted/<project>/.preview/waveform.json) ----
app.get("/api/waveform/:project", (req, res) => {
  const project = req.params.project;
  if (!known(project)) return res.status(404).end();
  const src = path.join(EXTRACTED, project, "mic-audio.m4a");
  if (!fs.existsSync(src)) return res.status(404).json({ error: "run extract first" });
  const cache = path.join(EXTRACTED, project, ".preview", "waveform.json");
  if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= fs.statSync(src).mtimeMs) return res.sendFile(cache);
  const RATE = 8000, BUCKETS = 8000;
  const chunks = [];
  const ff = spawn("ffmpeg", ["-v", "quiet", "-i", src, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]);
  ff.stdout.on("data", (c) => chunks.push(c));
  ff.on("error", () => res.status(500).json({ error: "ffmpeg not found" }));
  ff.on("close", () => {
    const buf = Buffer.concat(chunks);
    const n = buf.length >> 1;
    if (!n) return res.status(500).json({ error: "could not decode audio" });
    const size = Math.max(1, Math.ceil(n / BUCKETS));
    const peaks = [];
    for (let i = 0; i < n; i += size) {
      let m = 0;
      for (let j = i, end = Math.min(n, i + size); j < end; j++) m = Math.max(m, Math.abs(buf.readInt16LE(j * 2)));
      peaks.push(+(m / 32768).toFixed(4));
    }
    const out = { duration: n / RATE, peaks };
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(out));
    res.json(out);
  });
});

// ---- jobs ----
const jobs = new Map();
let seq = 0;

function buildArgs({ command, project, options = {} }) {
  const dir = frmDirs().find((d) => stem(d) === project);
  if (!dir) throw new Error("unknown project");
  const frm = path.join(WORKSPACE, dir);
  const out = path.join(EXTRACTED, project);
  switch (command) {
    case "info":
      return ["info", frm];
    case "extract":
      return ["extract", frm];
    case "blur-bg": {
      const src = path.join(out, "webcam.mp4");
      if (!fs.existsSync(src)) throw new Error("run extract first (webcam.mp4 missing)");
      return [
        "blur-bg", src,
        "--strength", String(num(options.strength, 3, 201, 51) | 0),
        "--threshold", String(num(options.threshold, 0, 0.95, 0.5)),
        "--smooth", String(num(options.smooth, 0, 0.95, 0.5)),
        "--seg-scale", String(num(options.segScale, 0.1, 1, 0.5)),
      ];
    }
    case "normalize-audio": {
      const src = path.join(out, "mic-audio.m4a");
      if (!fs.existsSync(src)) throw new Error("run extract first (mic-audio.m4a missing)");
      const args = [
        "normalize-audio", src,
        "--lufs", String(num(options.lufs, -30, -5, -14)),
        "--true-peak", String(num(options.truePeak, -6, 0, -1.5)),
        "--lra", String(num(options.lra, 1, 30, 11)),
      ];
      if (options.measureOnly) args.push("--measure-only");
      return args;
    }
    case "compose": {
      const blur = path.join(out, "webcam_blurred.mp4");
      const args = ["compose", frm, "-o", path.join(out, "composed.mp4")];
      const ex = options.export || {};
      const height = [0, 720, 1080, 1440, 2160].includes(+ex.height) ? +ex.height : 0;
      const fps = [0, 24, 30, 60].includes(+ex.fps) ? +ex.fps : 0;
      args.push(
        "--height", String(height), "--fps", String(fps),
        "--codec", ex.codec === "hevc" ? "hevc" : "h264",
        "--quality", ["high", "medium", "low"].includes(ex.quality) ? ex.quality : "high",
        "--encoder", ex.encoder === "x264" ? "x264" : "videotoolbox",
      );
      const ed = options.fromEditor && readEditor(project);
      if (options.fromEditor && !ed) throw new Error("no editor settings saved for this project");
      if (ed) {
        // export exactly what the editor shows
        options = { useBlurred: ed.camera === "webcam_blurred.mp4", useNormalized: ed.audio === "normalized" };
        if (ed.camera === "none") args.push("--no-webcam");
        else args.push("--cam-x", String(ed.x), "--cam-y", String(ed.y), "--cam-width", String(ed.w), ...(ed.mirror ? ["--mirror"] : []),
          "--cam-shape", ed.shape === "circle" ? "circle" : "rect", "--cam-radius", String(num(ed.radius, 0, 50, 0) / 100),
          "--cam-zoom", String(num(ed.zoom, 1, 4, 1)), "--cam-fx", String(num(ed.fx, 0, 1, 0.5)), "--cam-fy", String(num(ed.fy, 0, 1, 0.5)));
        if (ed.cuts?.length) args.push("--cuts", ed.cuts.map((c) => `${c.start.toFixed(3)}-${c.end.toFixed(3)}`).join(","));
      }
      if (options.useBlurred) {
        if (!fs.existsSync(blur)) throw new Error("webcam_blurred.mp4 missing, run blur-bg first");
        args.push("--webcam", blur);
      }
      const norm = path.join(out, "mic-audio_normalized.m4a");
      if (options.useNormalized) {
        if (!fs.existsSync(norm)) throw new Error("mic-audio_normalized.m4a missing, run normalize-audio first");
        args.push("--audio", norm);
      }
      fs.mkdirSync(out, { recursive: true });
      return args;
    }
    default:
      throw new Error("unknown command");
  }
}

app.post("/api/jobs", (req, res) => {
  let args;
  try {
    args = buildArgs(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const id = ++seq;
  const job = { id, command: req.body.command, project: req.body.project, status: "running", progress: 0, log: "", startedAt: Date.now() };
  jobs.set(id, job);
  const child = spawn(PYTHON, ["-I", CLI, ...args], { cwd: WORKSPACE, detached: true });
  // Split output into lines; "PROGRESS <pct>" lines update job.progress instead of the log
  let buf = "";
  const line = (l) => {
    const m = /^PROGRESS ([\d.]+)$/.exec(l);
    if (m) job.progress = Math.min(100, +m[1]);
    else job.log += l + "\n";
  };
  const add = (b) => {
    const lines = (buf + b.toString().replace(/\r/g, "\n")).split("\n");
    buf = lines.pop();
    lines.forEach(line);
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (e) => { job.log += `spawn error: ${e.message}\n`; job.status = "failed"; });
  child.on("close", (code) => {
    if (buf) line(buf);
    if (job.status === "running") job.status = code === 0 ? "done" : "failed";
    if (job.status === "done") job.progress = 100;
    job.endedAt = Date.now();
  });
  job.cancel = () => {
    if (job.status !== "running") return;
    job.status = "cancelled";
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } // whole group: python + ffmpeg
    if (job.command === "compose") child.once("close", () => fs.rmSync(path.join(EXTRACTED, job.project, "composed.mp4"), { force: true }));
  };
  res.json({ id });
});

const view = ({ cancel, ...j }) => j;
app.get("/api/jobs", (_req, res) => res.json([...jobs.values()].reverse().map(view)));
app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(+req.params.id);
  j ? res.json(view(j)) : res.status(404).end();
});
app.delete("/api/jobs/:id", (req, res) => {
  const j = jobs.get(+req.params.id);
  if (!j) return res.status(404).end();
  j.cancel?.();
  res.json({ ok: true });
});

// Production: serve built UI
const dist = path.resolve(here, "../client/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, "127.0.0.1", () => console.log(`Reframed Studio API on http://127.0.0.1:${PORT}  (workspace: ${WORKSPACE})`));
