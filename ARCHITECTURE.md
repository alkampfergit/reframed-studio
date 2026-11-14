# Architecture

Local, single-user tooling for recordings made with the Reframed macOS app. Runs only on this
machine (Apple M5, macOS). Three layers, each usable on its own:

```
browser (React, Vite :5173)  --/api, /media-->  Express (127.0.0.1:3001)  --spawn-->  tools/reframed.py  --> ffmpeg / OpenCV+MediaPipe
```

- `tools/reframed.py` does all media work. The web app never touches media itself, except two small
  ffmpeg calls in the server for browser previews (AAC preview audio, waveform peaks).
- The server is a thin job runner + file server. The UI holds the editing state and saves it as JSON.
- Source recordings (`*.frm/`) are never modified. Everything generated goes to `extracted/<project>/`.

See `AGENTS.md` for the `.frm` package format, measured performance numbers and test notes, and
`specs/` for the user stories per area (with Done / Partial / Planned status).

## Directory map

| Path | Role |
|---|---|
| `*.frm/` | Reframed packages: `screen.mp4`, `webcam.mp4`, `mic-audio.m4a`, `project.json`, ... (git-ignored, read-only) |
| `extracted/<project>/` | Working folder per project (git-ignored): copied tracks, `webcam_blurred.mp4`, `mic-audio_normalized.m4a`, `composed.mp4`, `editor.json`, `.preview/` cache |
| `tools/reframed.py` | CLI: `info`, `extract`, `blur-bg`, `normalize-audio`, `compose` |
| `tools/.venv/` | Python venv (mediapipe 0.10.21, opencv, numpy<2) needed only by `blur-bg` |
| `app/server/index.js` | Express API, job runner, media server |
| `app/client/src/App.jsx` | Shell: project list, Editor/Tools tabs, job polling |
| `app/client/src/Editor.jsx` | Player + picture-in-picture + settings + export dialog |
| `app/client/src/Timeline.jsx` | Waveform, selection, cuts |
| `.claude/skills/reframed/SKILL.md` | Skill wrapping the CLI |

## CLI (`tools/reframed.py`)

Plain Python 3.9, standard library only, except `blur-bg` (imports cv2/mediapipe lazily).

- `blur-bg`: OpenCV decode thread -> MediaPipe selfie segmentation on a 1/4-size frame -> mask
  smoothing/feather -> blur on a 1/4-size frame -> `cv2.blendLinear` -> raw frames piped to ffmpeg
  (`h264_videotoolbox`). Output frame rate = source *average* frame rate (webcam is VFR).
- `normalize-audio`: two-pass ffmpeg `loudnorm` (default -14 LUFS, -1.5 dBTP, LRA 11).
- `compose`: builds one ffmpeg `-filter_complex` graph:
  1. screen `[0:v]` -> optional `fps=N` first (fewer frames for everything after it)
  2. camera `[1:v]` -> optional `crop` (zoom / focus point; square when circle) -> `scale` -> optional `hflip`
     -> optional alpha mask (`make_mask` renders a rounded-rect/circle PNG once; `alphamerge`) -> `overlay` => `[vfull]`
  3. cuts: `split`/`asplit` into the kept segments, `trim`/`atrim` each, `concat` => `[vc][ac]`
  4. `scale` to output size, `format=yuv420p`, encode (`h264_videotoolbox`/`hevc_videotoolbox`, or libx264/libx265)
- Progress protocol: long commands print `PROGRESS <0-100>` lines on stderr (`run_progress` parses
  ffmpeg `-progress pipe:1`). Anything else on stdout/stderr is log text.
- Conventions: camera x/y/width are fractions of the screen size (same as `cameraLayout` in
  `project.json`); radius is a fraction of camera width; cut times are seconds on the original timeline;
  trim start/end always come from `project.json`.

## Server (`app/server/index.js`)

Single file, no database. Binds to 127.0.0.1. Env: `REFRAMED_DIR` (folder holding the `*.frm` projects and `extracted/`; defaults to the repo root, tools are always loaded from the repo), `PYTHON` (defaults to `tools/.venv/bin/python` when present), `PORT`.

| Route | Purpose |
|---|---|
| `GET /api/projects` | Lists `*.frm` dirs with size, fps, sizes, Reframed camera layout, files present in `extracted/` |
| `GET/PUT /api/editor/:project` | Editor settings, stored in `extracted/<project>/editor.json`; PUT validates/clamps every field |
| `GET /api/preview-audio/:project` | AAC copy of the ALAC mic track for browser playback (cached in `.preview/`) |
| `GET /api/waveform/:project` | ~8000 peak values of the mic track (ffmpeg -> 8 kHz mono PCM -> max per bucket; cached in `.preview/waveform.json`) |
| `POST /api/jobs` | `{command, project, options}` -> spawns the CLI. `buildArgs()` is the only place that turns UI options into CLI arguments (whitelist + clamping) |
| `GET /api/jobs`, `GET /api/jobs/:id` | Status, `progress` (0-100), log |
| `DELETE /api/jobs/:id` | Cancel: kills the whole process group (python + ffmpeg), deletes a partial `composed.mp4` |
| `/media/<project>/<file>` | Static files from `extracted/` (range requests for video) |

Jobs live in memory (lost on restart; `node --watch` restarts on every server edit). Children are
spawned `detached` so the group can be killed. `compose` with `options.fromEditor` reads `editor.json`
and `options.export` (`height`, `fps`, `codec`, `quality`, `encoder`).

## Client

- `App.jsx`: polls `/api/jobs` every second, reloads projects when jobs finish, switches Editor / Tools.
  Tools view = one section per CLI command plus preview tabs and job log.
- `Editor.jsx`: state object `cfg` = exactly what is saved in `editor.json`:
  `camera` (`none|webcam.mp4|webcam_blurred.mp4`), `audio` (`original|normalized`), `x, y, w`, `shape` (`rect|circle`),
  `radius`, `zoom, fx, fy` (camera crop), `mirror`, `cuts: [{start, end}]`. Autosaved (400 ms debounce).
  - Playback: three media elements. The `<audio>` is the master clock; the muted screen and camera
    `<video>`s are slaved in a requestAnimationFrame loop (drift < 0.4 s -> playbackRate nudge, else seek).
    Cut ranges are skipped by jumping the audio clock.
  - The camera crop/zoom is done with CSS (oversized absolutely positioned video inside an
    `overflow:hidden` box) using the same maths as `compose`, so preview and export match.
  - Export dialog options are per-browser (`localStorage` key `reframed.export`), not per project.
- `Timeline.jsx`: canvas draws the waveform once per size change; playhead, selection and cut ranges
  are absolutely positioned divs. Zoom 1 fits the whole clip; zooming re-centres on the playhead.
  Drag = select, click = seek, `x`/Delete = cut selection, Esc = clear.

## Performance notes (measured on this M5)

- Export speed is limited by the VideoToolbox hardware encoder: about 250 frames/s at 1920x1112,
  with or without filters, H.264 or HEVC, hardware or software decode. Decode alone is 12-20x realtime.
- Decode/encode run on the media engine, not the GPU, so Activity Monitor's GPU graph stays low.
  This ffmpeg build has no GPU overlay filter (only `scale_vt`, `transpose_vt`), so compositing is on CPU;
  it is not the bottleneck.
- The screen track averages ~69 fps, so exporting at 30 fps halves the frames to encode
  (about 7.5x realtime simple, about 5x with circle mask + cuts, vs about 4x at source frame rate).

## Known gaps / ideas

- No undo; no trim handles (trim comes from `project.json`); cuts are only on the mic/screen/camera together.
- No automatic silence detection yet (waveform is visual only). `ffmpeg silencedetect` would fit as a CLI subcommand.
- Jobs are not persisted; one job at a time is assumed by the UI (`busy`).
- Preview needs a browser with HEVC 10-bit support (Edge/Safari/Chrome on macOS; not Firefox).
- No automated tests. UI checks were done with `playwright-core` driving installed Edge (`channel: "msedge"`).
