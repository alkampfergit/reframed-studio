import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.REFRAMED_DIR || path.resolve(here, "../..");
const CLI = path.join(WORKSPACE, "tools/reframed.py");
const EXTRACTED = path.join(WORKSPACE, "extracted");
const VENV_PY = path.join(WORKSPACE, "tools/.venv/bin/python");
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
  };
  fs.mkdirSync(path.dirname(editorFile(project)), { recursive: true });
  fs.writeFileSync(editorFile(project), JSON.stringify(cfg, null, 2));
  res.json(cfg);
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
      const ed = options.fromEditor && readEditor(project);
      if (options.fromEditor && !ed) throw new Error("no editor settings saved for this project");
      if (ed) {
        // export exactly what the editor shows
        options = { useBlurred: ed.camera === "webcam_blurred.mp4", useNormalized: ed.audio === "normalized" };
        if (ed.camera === "none") args.push("--no-webcam");
        else args.push("--cam-x", String(ed.x), "--cam-y", String(ed.y), "--cam-width", String(ed.w), ...(ed.mirror ? ["--mirror"] : []));
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
  const job = { id, command: req.body.command, project: req.body.project, status: "running", log: "", startedAt: Date.now() };
  jobs.set(id, job);
  const child = spawn(PYTHON, ["-I", CLI, ...args], { cwd: WORKSPACE });
  const add = (b) => (job.log += b.toString().replace(/\r/g, "\n"));
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("error", (e) => { job.log += `spawn error: ${e.message}\n`; job.status = "failed"; });
  child.on("close", (code) => { if (job.status === "running") job.status = code === 0 ? "done" : "failed"; job.endedAt = Date.now(); });
  job.cancel = () => child.kill("SIGTERM");
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
  j.status = "cancelled";
  res.json({ ok: true });
});

// Production: serve built UI
const dist = path.resolve(here, "../client/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(PORT, "127.0.0.1", () => console.log(`Reframed Studio API on http://127.0.0.1:${PORT}  (workspace: ${WORKSPACE})`));
