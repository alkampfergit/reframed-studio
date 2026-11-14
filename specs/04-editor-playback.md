# 04 – Editor playback

## US-4.1 Play the composed result live — Done
As a creator, I want to play the screen recording with my camera on top and my audio, so that I see the final video before exporting.
- One player shows the screen, the camera as picture-in-picture, and plays the selected audio.
- Play/pause by button, by clicking the video, or with Space; left/right arrows skip 5 s; seek bar; volume.

## US-4.2 Choose the camera source — Done
As a creator, I want to choose between no camera, the original camera and the blurred camera.
- Sources that are not generated yet are disabled and labelled.
- Switching during playback keeps position and keeps playing.

## US-4.3 Choose the audio source — Done
As a creator, I want to choose between original and normalized audio.
- Switching during playback keeps position and keeps playing.

## US-4.4 Everything stays in sync — Done
As a creator, I want picture and sound to stay together, so that the preview is trustworthy.
- Screen and camera stay within about 40 ms of the audio, including after seeking and after switching sources.

## US-4.5 My settings are remembered — Done
As a creator, I want the editor to remember my choices per project, so that I can continue later.
- Settings autosave to `extracted/<project>/editor.json` and are restored when the project is opened.
- Defaults come from the layout saved by Reframed and from which files exist.

## US-4.6 Undo and redo — Planned
As a creator, I want to undo my last editor changes.
