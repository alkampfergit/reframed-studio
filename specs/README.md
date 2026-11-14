# Specifications

User stories for Reframed Studio, one file per macro area. Each story has a status:

- **Done** – implemented and exercised at least once (see `AGENTS.md` for what was tested)
- **Partial** – works with the limits stated in the story
- **Planned** – not implemented yet

| File | Area |
|---|---|
| [01-projects.md](01-projects.md) | Finding, inspecting and extracting Reframed projects |
| [02-camera-blur.md](02-camera-blur.md) | Webcam background blur |
| [03-audio.md](03-audio.md) | Loudness normalization and audio comparison |
| [04-editor-playback.md](04-editor-playback.md) | Editor player, source selection, sync |
| [05-picture-in-picture.md](05-picture-in-picture.md) | Camera position, shape, zoom |
| [06-timeline-cuts.md](06-timeline-cuts.md) | Waveform timeline and cutting |
| [07-export.md](07-export.md) | Export options, progress, cancel, performance |
| [08-jobs-and-cli.md](08-jobs-and-cli.md) | Job runner, CLI, agent/skill usage |

Persona: a single creator recording screen + webcam + microphone tutorials with Reframed on one
Apple Silicon Mac, publishing to YouTube. How the pieces are built is in `../ARCHITECTURE.md`.
