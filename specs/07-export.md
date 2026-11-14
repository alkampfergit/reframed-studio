# 07 – Export

## US-7.1 Export what I see — Done
As a creator, I want one MP4 that matches the editor preview.
- Writes `extracted/<project>/composed.mp4` with the selected camera and audio, position, size, shape,
  corner radius, zoom, mirror and cuts.
- A link to open the result appears when the export finishes.

## US-7.2 Choose basic export parameters — Done
As a creator, I want to choose the essentials before exporting.
- Resolution (same as recording, 2160p, 1440p, 1080p, 720p), frame rate (30, 60, same as recording),
  format (H.264, HEVC), quality (high, medium, low), encoder (Apple hardware, software).
- The choices are remembered in the browser.

## US-7.3 See progress — Done
As a creator, I want a progress bar with a percentage while exporting.

## US-7.4 Cancel an export — Done
As a creator, I want to cancel a running export.
- Cancelling stops the encoder and removes the partial file.

## US-7.5 Use my Mac's acceleration — Done
As a creator, I want exports to use hardware acceleration.
- Hardware decode and encode (VideoToolbox). About 5× to 7.5× real time at 30 fps on the M5.
- Known limit: the hardware encoder tops out near 250 frames/s at this resolution; compositing runs on CPU.

## US-7.6 Name and place the output — Planned
As a creator, I want to choose the file name and folder, and keep several exports of one project.

## US-7.7 YouTube preset — Planned
As a creator, I want a one-click preset with YouTube's recommended settings.

## US-7.8 Estimated time and size — Planned
As a creator, I want to see the remaining time and expected file size during export.
