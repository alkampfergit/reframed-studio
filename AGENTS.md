# Reframed workspace

Read `ARCHITECTURE.md` first for how the CLI, server and web UI fit together. This file holds format notes, measurements and test status.

Goal: quickly manipulate recordings made by the Reframed macOS app (e.g. blur the webcam background, recompose the final video).

## Layout
- `*.frm/` - Reframed project packages (directories). Treat as read-only originals.
- `extracted/<project>/` - raw tracks copied out of each package.
- `tools/reframed.py` - CLI (info, extract, blur-bg, compose). Deps: ffmpeg; blur-bg needs `pip install -r tools/requirements.txt`.
- `.claude/skills/reframed/SKILL.md` - skill wrapping the CLI.

## .frm package contents
| File | Notes |
|---|---|
| `screen.mp4` | Screen/window capture (1920x1112 in samples), 60 fps |
| `webcam.mp4` | Webcam, 1920x1080 |
| `mic-audio.m4a` | Microphone audio |
| `cursor-metadata.json` | Cursor samples at 120 Hz: `t,x,y,p` (x/y normalized 0-1, p = pressed). Can start slightly before 0 |
| `project.json` | Capture info + `editorState` (trim, camera layout, audio, cursor, zoom, background) |
| `history.json` | Editor undo history (snapshots of editorState) |

Durations of tracks differ by ~0.1-0.2 s; use `-shortest`/trim when muxing.

## project.json keys that matter
- `editorState.trimStartSeconds` / `trimEndSeconds` - edit trim, applied by `compose`.
- `editorState.cameraLayout` - `relativeX`, `relativeY`, `relativeWidth` of webcam overlay (fractions of screen size). `cameraCornerRadius`, `cameraMirrored` are not applied by `compose` yet.
- `fps`, `screenSize`, `webcamSize`, `hasWebcam`, `hasMicrophoneAudio`, `hasSystemAudio`.

## Workflow
1. `python3 tools/reframed.py extract X.frm`
2. `python3 tools/reframed.py blur-bg extracted/X/webcam.mp4` -> `webcam_blurred.mp4`
3. `python3 tools/reframed.py normalize-audio extracted/X/mic-audio.m4a` -> `mic-audio_normalized.m4a` (two-pass loudnorm, default -14 LUFS / -1.5 dBTP / LRA 11, YouTube target; `--measure-only` prints loudness JSON)
4. `python3 tools/reframed.py compose X.frm --webcam extracted/X/webcam_blurred.mp4 --audio extracted/X/mic-audio_normalized.m4a`

## Status / notes
- Scripts were written but NOT yet run or tested. Try the short project (`...-120233`, ~10 s) first.
- Background blur uses MediaPipe selfie segmentation (CPU); long clip (~4 min, 60 fps) will be slow - lower `--seg-scale` to speed up.
- Reframed's own editor does not offer background blur; this is a pre-processing step. Pointing the webcam track in the package at the blurred file (rename) may let the app use it - untested, back up first.
- Environment: macOS, Python 3.9.6, ffmpeg at /opt/homebrew/bin.

## Web app (`app/`)
Node (Express) API + React (Vite) UI that drives `tools/reframed.py`. Written but NOT yet run/tested.
- Setup: `cd app && npm run install:all`, then `npm run dev` (UI http://localhost:5173, API http://127.0.0.1:3001).
- Production-ish: `npm run build && npm start` (serves UI from the API on :3001).
- Env: `REFRAMED_DIR` (workspace, default parent of `app/`), `PYTHON` (default `python3`, use the venv python that has opencv/mediapipe), `PORT`.
- API: `GET /api/projects`, `POST /api/jobs {command: info|extract|blur-bg|compose, project, options}`, `GET /api/jobs[/:id]`, `DELETE /api/jobs/:id`, media at `/media/<project>/<file>`.
- Server only accepts whitelisted commands and known project names, binds to 127.0.0.1; jobs are in memory (lost on restart).
- Spawns Python with `-I` (isolated mode), so it ignores PYTHONPATH/user site-packages; if mediapipe is installed in user site, remove `-I` in `server/index.js`.
- Compose output: `extracted/<project>/composed.mp4`; blur output: `extracted/<project>/webcam_blurred.mp4`, audio: `extracted/<project>/mic-audio_normalized.m4a`.

## Audio normalization notes
- Uses ffmpeg `loudnorm` two-pass with `linear=true`; if the source's loudness range exceeds the LRA target ffmpeg silently falls back to dynamic mode.
- Output is AAC 192k, 48 kHz. YouTube normalizes to ~-14 LUFS integrated; it only turns louder content down, so -14 is a safe ceiling.
- Untested. Not yet applied to the mic noise reduction setting in project.json (`micNoiseReductionEnabled`), and system audio is not handled (samples have none).

## Blur performance (measured on Apple M5, 1920x1080 webcam)
- First version: ~24 fps. Current: ~160 fps on the short clip.
- What made it fast: segmentation and background blur run on a 1/4-size frame (`--seg-scale`, `--blur-scale`, default 0.25; the MediaPipe model is 256x144 internally anyway), `cv2.blendLinear` for compositing, decode/encode-feed in threads, and the `h264_videotoolbox` hardware encoder (`--encoder videotoolbox`, `--bitrate 8M`; `--encoder x264` for software).
- MediaPipe inference itself is still CPU (XNNPACK); the legacy Python `solutions` API has no Metal/GPU delegate on macOS.
- Webcam tracks are HEVC 10-bit, variable frame rate (~29.9 fps). Output is written at the source's *average* frame rate so duration matches the original and stays in sync with the mic; using `r_frame_rate` made the output ~2% short.
- Audio A/B in the UI: `GET /api/preview-audio/<project>` serves an AAC copy of the original mic (source is ALAC, not playable in Chrome/Firefox), cached in `extracted/<project>/.preview/`. Same loudness as the original, only the codec changes.
- UI layout: projects (left), tool steps (middle), large preview with one tab per available video + jobs/log (right). Original/normalized audio players live in the Normalize step.
- UI checks: no Chrome installed; drive the UI with `playwright-core` and `chromium.launch({ channel: "msedge" })` (Edge is installed), no browser download needed.

## Editor (web app, `app/client/src/Editor.jsx`)
- Default view. Plays `screen.mp4` with a chosen camera (none / `webcam.mp4` / `webcam_blurred.mp4`) as picture-in-picture and a chosen audio (original / normalized). Camera can be dragged, resized (corner handle or slider), snapped to corners, mirrored, given a corner radius.
- Sync model: the `<audio>` element is the master clock; both `<video>`s are muted and slaved to it in a requestAnimationFrame loop (small drift -> playbackRate nudge 0.94/1.06, >0.4 s -> seek). Measured drift in Edge: ~10-40 ms, including after seeks and after switching camera/audio mid-playback.
- Settings autosave to `extracted/<project>/editor.json` (`camera, audio, x, y, w, radius, mirror`; x/y/w are fractions of the screen size, same convention as `cameraLayout` in project.json, which provides the defaults). API: `GET/PUT /api/editor/<project>`.
- Export button = `compose` job with `options.fromEditor`, which maps editor.json to `reframed.py compose --webcam/--audio/--cam-x/--cam-y/--cam-width/--mirror/--no-webcam` -> `extracted/<project>/composed.mp4`. Tested on the short project.
- Not exported yet: corner radius (preview-only). No timeline/trim/cut editing yet; export uses the trim stored in project.json.
- Screen and webcam tracks are HEVC 10-bit: they play in Edge/Safari/Chrome on macOS (hardware decode) but may not in Firefox.

## Editor additions (cuts, waveform, camera crop, export options)
- Timeline with waveform under the player: drag to select, "Cut selection" (or `x`/Delete) adds a cut; cuts are skipped in playback and removed in export. Tested: 2 cuts on the long project, export duration 244.9 s vs 245.2 s expected, frames around the join verified.
- Camera shape rect/circle, zoom 1-4 and focus point (fx, fy) for both shapes; corner radius and circle are exported via an alpha mask.
- Export dialog: resolution, frame rate (default 30), H.264/HEVC, quality, hardware/software encoder; progress bar and cancel (kills ffmpeg, removes partial file).
- Screen track has duplicate timestamps / ~69 fps average although project.json says 60.
