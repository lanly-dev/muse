# Change Log

All notable changes to the "muse" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Player moved from a webview panel to an activity-bar view
  (`muse-player` container, `muse.playerView`); single audio owner, no
  double playback.
- Colors are now written to the workspace settings scope only — user
  preferences are never touched (a workspace folder must be open).
- Pre-play colors are saved as a persisted profile; stopping restores
  them, including when stopping from the player UI, and a profile left
  behind by a mid-play shutdown is restored on next launch.

## [0.0.1] - 2026-10-11

- Initial release: three generative stations (Neon Rain, Solar Drift,
  Night Drive), local audio file playback, and melody-reactive
  workbench colors (status bar, title bar, activity bar) with
  snapshot/restore.
