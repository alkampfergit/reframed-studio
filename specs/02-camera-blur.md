# 02 – Camera background blur

## US-2.1 Blur what is behind me — Done
As a creator, I want the webcam background blurred while I stay sharp, so that my room is not a distraction.
- Produces `webcam_blurred.mp4` next to the extracted webcam; the original is kept.
- Same duration and frame count as the source, so it stays in sync with the microphone.

## US-2.2 Tune the look — Done
As a creator, I want to adjust the blur, so that the edge around me looks right.
- Controls: blur strength, mask threshold, temporal smoothing, segmentation scale.

## US-2.3 Fast processing on my Mac — Done
As a creator, I want blurring to be much faster than real time, so that I do not wait on long recordings.
- Hardware H.264 encoding and reduced-size segmentation/blur; about 155 fps measured (4 min 23 s in 51 s).

## US-2.4 Preview a short sample before the full run — Planned
As a creator, I want to preview the blur on a few seconds, so that I can tune settings without processing the whole file.

## US-2.5 Replace the background — Planned
As a creator, I want to replace the background with a color or an image instead of blurring it.
