# Change Log

All notable changes to the "muse" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Colors are now written to the **global** settings scope, so the
  melody-reactive UI works with or without a workspace folder open.
  Your pre-play global colors are snapshotted and restored exactly on
  stop (only the keys Muse manages are touched); the persisted profile
  now uses a versioned wrapper so "no prior value" restores cleanly.
- The whole IDE follows the melody: status bar, title bar, activity
  bar, side bar, panel, and editor background.
- **Rave mode** — 🪩 button in the player or `Muse: Toggle Rave Mode`:
  snappy color tracking, full saturation, and brightness flashes on
  energy onsets. Choice persists across restarts.
- Pre-play colors are saved as a persisted profile; stopping restores
  them, including when stopping from the player UI, and a profile left
  behind by a mid-play shutdown is restored on next launch.

## [0.0.1] - 2026-10-11

- Initial release: three generative stations (Neon Rain, Solar Drift,
  Night Drive), local audio file playback, and melody-reactive
  workbench colors (status bar, title bar, activity bar) with
  snapshot/restore.
