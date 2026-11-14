# 03 – Audio

## US-3.1 Normalize loudness for YouTube — Partial
As a creator, I want my microphone track normalized to a loudness target, so that my videos are as loud as others on YouTube.
- Produces `mic-audio_normalized.m4a` (AAC, 48 kHz); the original is kept.
- Defaults: -14 LUFS integrated, -1.5 dBTP true peak, loudness range 11; all three adjustable.
- Limit: when the source has peaks near 0 dB or a wide loudness range, the result can land below the target (measured -15.9 LUFS on a 10 s clip).

## US-3.2 Measure without changing anything — Done
As a creator, I want to measure the loudness of a track, so that I know whether normalization is needed.
- "Measure only" prints integrated loudness, true peak and loudness range and writes no file.

## US-3.3 Compare original and normalized — Done
As a creator, I want to listen to both versions, so that I can judge the result.
- Two players in the Tools view; the editor can switch audio source during playback.
- The original (ALAC) is served as an AAC copy so every browser can play it; loudness is unchanged.

## US-3.4 Noise reduction — Planned
As a creator, I want background noise reduced on the microphone track.

## US-3.5 Hit the loudness target exactly — Planned
As a creator, I want a limiter stage so the normalized track reaches the target even with loud peaks.
