# 01 – Projects

## US-1.1 See my recordings — Done
As a creator, I want the app to list every Reframed project in my working folder, so that I can pick one without typing paths.
- Every `*.frm` folder in the workspace appears in the left sidebar.
- Each entry shows name, screen resolution, fps and size on disk.
- Selecting a project switches the editor and the tools to it.

## US-1.2 Inspect a project — Done
As a creator, I want to see the basic facts of a project, so that I know what I am working with.
- "Info" shows tracks with sizes, total size, fps, trim range and the camera layout saved by Reframed.
- The Tools view shows project size and how much space the extracted copies use.

## US-1.3 Extract the tracks — Done
As a creator, I want the screen, webcam and microphone tracks copied out of the package, so that I can process them without touching the original.
- "Extract" copies `screen.mp4`, `webcam.mp4`, `mic-audio.m4a` to `extracted/<project>/`.
- Original `.frm` packages are never modified by any feature.
- Features that need extracted tracks are disabled, with a hint, until extraction is done.

## US-1.4 Keep recordings out of version control — Done
As a developer, I want recordings and generated media ignored by git, so that the repository stays small and private.
- `*.frm/`, `extracted/` and media file types are in `.gitignore`.

## US-1.5 Free disk space — Planned
As a creator, I want to delete generated files of a project from the app, so that I can reclaim space after publishing.
