# 06 – Timeline and cuts

## US-6.1 See the audio waveform — Done
As a creator, I want the waveform of my audio under the player, so that I can spot silent pauses quickly.
- The waveform of the microphone track is shown for the whole clip, with a playhead.
- Clicking the waveform seeks to that point.

## US-6.2 Zoom the timeline — Done
As a creator, I want to zoom into the waveform, so that I can select precisely.
- At minimum zoom the entire clip is visible.
- Zooming in keeps the playhead centred; during playback the view follows the playhead.

## US-6.3 Select and cut a section — Done
As a creator, I want to select a section and cut it, so that pauses and mistakes are removed.
- Drag on the waveform to select; the selection shows its start, end and length.
- "Cut selection" (or `x` / Delete) marks it as cut; Esc clears the selection.
- Overlapping cuts are merged. Cut sections are shown hatched in red.

## US-6.4 Remove a cut — Done
As a creator, I want to bring back a section I cut by mistake.
- Each cut has a small ✕ button on the waveform and on its chip in the cut list.
- "Restore all" removes every cut.
- Clicking a chip jumps to 2 s before that cut so I can check the join.

## US-6.5 Preview skips the cuts — Done
As a creator, I want playback to jump over cut sections, so that I hear the result.
- The time display shows the length after cuts.

## US-6.6 Cuts are applied on export — Done
As a creator, I want the exported video to contain only the kept sections, joined together.

## US-6.7 Find silences automatically — Planned
As a creator, I want silent sections detected and proposed as selections, so that I only confirm them.

## US-6.8 Adjust a cut — Planned
As a creator, I want to drag the edges of an existing cut to fine-tune it.

## US-6.9 Trim start and end — Planned
As a creator, I want handles for the start and end of the video (today the trim saved by Reframed is used).
