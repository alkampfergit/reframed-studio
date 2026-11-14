# Reframed Studio

A small local web editor and command-line tool for recordings made with the
[Reframed](https://reframed.app) macOS screen recorder. It works on the `.frm` project folders
Reframed saves (screen, webcam and microphone as separate tracks) and lets you:

- blur the webcam background while you stay sharp
- normalize the microphone to a loudness target (default -14 LUFS, the YouTube level)
- preview screen + camera + audio together, with the camera as picture-in-picture
  (drag, resize, rectangle or circle, rounded corners, zoom, mirror)
- cut sections out, using an audio waveform to spot the pauses
- export one MP4 with hardware-accelerated encoding, a progress bar and cancel

Everything runs on your machine. Your original `.frm` projects are never modified; all generated
files go to an `extracted/` folder next to them.

> This is a personal tool, built and tested on one Apple Silicon Mac. It is not affiliated with Reframed.

## Requirements

- macOS on Apple Silicon (export and blur use the VideoToolbox hardware encoder)
- [ffmpeg](https://ffmpeg.org) on your `PATH` (`brew install ffmpeg`)
- Node.js 20 or newer
- Python 3.9 to 3.12 (only the background blur needs extra Python packages)
- A browser that plays HEVC video: Safari, Chrome or Edge on macOS (not Firefox)

## Install

```bash
git clone https://github.com/alkampfergit/reframed-studio.git
cd reframed-studio

# web app
cd app && npm run install:all && cd ..

# optional: Python packages for the background blur
python3 -m venv tools/.venv
tools/.venv/bin/pip install -r tools/requirements.txt
```

## Add your recordings

Copy (or move) your Reframed projects, the folders ending in `.frm`, into the repository folder:

```
reframed-studio/
  My-Recording-2026-01-01.frm/
  app/
  tools/
```

They are ignored by git. To keep recordings somewhere else, start the app with
`REFRAMED_DIR=/path/to/folder` pointing at the folder that contains the `.frm` projects.

## Start the app

```bash
cd app
npm run dev
```

Open <http://localhost:5173>. The API listens on `127.0.0.1:3001` only.

## Typical workflow

1. **Tools tab → Extract.** Copies the tracks out of the selected project. Do this first.
2. **Tools tab → Blur background** (optional). Creates a blurred copy of the webcam.
3. **Tools tab → Normalize** (optional). Creates a loudness-normalized copy of the microphone.
   Use the two players to compare original and normalized.
4. **Editor tab.**
   - Choose the camera (none, original, blurred) and the audio (original, normalized).
   - Drag the camera to place it, drag its corner to resize, or use the corner buttons.
   - Switch between rectangle and circle, set corner radius, zoom and move the visible area.
   - On the waveform: click to seek, drag to select, then **Cut selection**.
     Each cut has a small ✕ to bring the section back.
5. **Export…** Pick resolution, frame rate, format and quality, then start. The result is
   `extracted/<project>/composed.mp4`.

Editor settings are saved per project, so you can close the browser and continue later.

### Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Skip 5 seconds |
| x, Delete | Cut the selected section |
| Esc | Clear the selection |

## Command line

Every operation is also a CLI command, which the web app calls under the hood:

```bash
python3 tools/reframed.py info            My-Recording.frm
python3 tools/reframed.py extract         My-Recording.frm
tools/.venv/bin/python tools/reframed.py blur-bg extracted/My-Recording/webcam.mp4
python3 tools/reframed.py normalize-audio extracted/My-Recording/mic-audio.m4a
python3 tools/reframed.py compose My-Recording.frm \
    --webcam extracted/My-Recording/webcam_blurred.mp4 \
    --audio  extracted/My-Recording/mic-audio_normalized.m4a \
    --cam-shape circle --cam-zoom 1.5 --fps 30 --height 1080 \
    --cuts "26.3-39.5,131.7-137.0" \
    -o final.mp4
```

Run any command with `--help` for all options.

## Tips

- Exporting at 30 fps is the fastest option. The hardware encoder is the bottleneck, and screen
  recordings often carry more than 60 frames per second.
- Low GPU usage during export is normal: encoding runs on the Mac's dedicated video engine.
- If the blur edge around you flickers, raise *Smoothing*; if parts of the background stay sharp,
  raise *Mask threshold*.
- Normalization may land a little under the target when the recording has very loud peaks.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No module named 'cv2'` when blurring | Create the virtual environment (see Install). The server uses `tools/.venv` automatically. |
| The video area stays black | Your browser cannot play HEVC. Use Safari, Chrome or Edge. |
| A button is disabled | Extract the project first; blurred / normalized options appear once those files exist. |
| The job list is empty after a restart | Jobs are kept in memory only. Generated files are still there. |

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): how the CLI, server and UI fit together
- [`specs/`](specs/README.md): user stories per area, with what is done and what is planned
- [`AGENTS.md`](AGENTS.md): notes on the `.frm` format, measurements and test status, written for coding agents
