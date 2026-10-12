# Muse — music that colors your editor

Muse plays music inside VS Code and turns the melody into UI color. A
generative synth engine composes endless lofi / ambient / synthwave
melodies (no audio files needed), or play your own MP3/WAV/OGG files.
While music plays, real-time analysis (pitch-class chroma, energy,
brightness) drives the workbench colors — status bar, title bar,
activity bar — so the editor glows with the song.

## Features

- **Generative stations** — three built-in moods, composed live in your
  editor with the Web Audio API:
  - *Neon Rain* — rainy-night lofi, A minor, 92 BPM
  - *Solar Drift* — warm morning pads, C major, 76 BPM
  - *Night Drive* — synthwave pulse, G dorian, 104 BPM
- **Your own files** — `Muse: Play Audio File…` plays MP3, WAV, OGG,
  M4A, FLAC, AAC from your machine, analyzed with a real FFT
  chromagram.
- **Melody-reactive UI** — dominant pitch class → hue (C = red, walking
  the chromatic wheel), energy → saturation, timbre brightness →
  lightness. Updates are smoothed and throttled; colors are written to
  the **workspace** settings scope only (your user settings are never
  touched). Your pre-play colors are saved as a profile and restored
  when you stop — even if the window closed mid-song, the leftover
  profile is restored on next launch.
- **Player in the activity bar** — transport controls, volume, loop toggle,
  and a live 12-note chroma visualizer, docked in the sidebar. Music keeps
  playing when the view is hidden.
- **Status bar** — shows the current track; click to open the player.

## Commands

| Command | What it does |
|---|---|
| `Muse: Open Player` | Reveal the player in the activity bar |
| `Muse: Play` | Start the default generative station |
| `Muse: Play / Pause` | Toggle playback |
| `Muse: Next Station` | Switch to the next generative station |
| `Muse: Play Audio File…` | Pick and play a local audio file |
| `Muse: Stop and Restore Colors` | Stop playback, restore your theme colors |

## Extension Settings

- `muse.reactiveColors` — shift workbench colors with the melody
  (default `true`)
- `muse.colorTargets` — which surfaces follow the music
  (default `["statusBar", "titleBar", "activityBar"]`)
- `muse.intensity` — how strongly the music swings the colors, 0–1
  (default `0.7`)
- `muse.updateIntervalMs` — minimum ms between color updates
  (default `300`)
- `muse.defaultStation` — station the player starts on
- `muse.volume` — player volume

## Roadmap

- Synced lyrics display
- Rave mode (full-intensity party visuals)

## Known Issues

- Browsers block audio until you interact with the page: if you start
  playback from the command palette, click once inside the player view
  to enable sound.

## Release Notes

### 0.0.1

Initial release: generative stations, local file playback,
melody-reactive workbench colors.
