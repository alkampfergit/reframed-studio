---
name: reframed
description: Manipulate Reframed app recordings (.frm packages) - extract tracks, blur the webcam background, compose screen + webcam + mic into one MP4. Use when the user mentions Reframed, .frm projects, webcam blur, or editing screen recordings.
---

Use `tools/reframed.py` (see AGENTS.md for the .frm format and conventions).

- Inspect: `python3 tools/reframed.py info <x>.frm`
- Extract tracks: `python3 tools/reframed.py extract <x>.frm`
- Blur webcam background: `python3 tools/reframed.py blur-bg <x>.frm [--strength 51]`
- Final video: `python3 tools/reframed.py compose <x>.frm --webcam extracted/<x>/webcam_blurred.mp4`

Never modify the original .frm packages. Write outputs next to `extracted/`.
Test on the short (~10 s) project first before the long one.
