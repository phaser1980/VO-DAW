# Multi-track timeline + drag-and-drop SFX import

## Files — where they go (relative to your `statevo/statevo/` package folder)

| File | Status | Destination |
|---|---|---|
| `statevo/ui/timeline_view.py` | **NEW** | `statevo/ui/timeline_view.py` |
| `statevo/core/media_import.py` | **NEW** | `statevo/core/media_import.py` |
| `statevo/ui/main_window.py` | **REPLACES** existing file | `statevo/ui/main_window.py` |
| `statevo/core/edit_ops.py` | **REPLACES** existing file | `statevo/core/edit_ops.py` |

`statevo/ui/waveform_view.py` is now unused (superseded by `timeline_view.py`) — left in place rather than deleted in case you want to diff against it; safe to delete once you've confirmed the new one works for you.

## What changed and why

**The gap:** the MVP's `WaveformView` only ever showed one track (always the Voice track). The `Beds / SFX` track existed in the data model (`Project.new()` already creates it) and the exporter already mixed every track into the final render — but there was no UI to see it, add to it, or create more tracks. Drag-and-drop had nowhere to land.

**What's built:**

- **`TimelineView`** (replaces `WaveformView` as the central widget) — renders every track as a stacked horizontal lane with a header column (name, mute, solo, collapse-arrow), plus the shared ruler/playhead/selection spanning all lanes. A dashed **"+ New Track"** row sits at the bottom for adding an empty SFX track by hand.
- **Drag-and-drop** — drop one or more local files (from Explorer, or a browser's drag-out) onto the timeline:
  - Land on an **existing clip's waveform** → adds to that same track.
  - Land on **empty space** (a gap in a lane, or below the last track) → creates a brand new track for it.
  - Dropping multiple files at once: only the first honors a hit on an existing clip; every other file gets its own new track (so you don't stack five sounds on top of each other by accident).
- **`core/media_import.py`** — transcodes whatever gets dropped in (mp3, ogg, flac, mismatched sample rate, whatever) to WAV at the project's sample rate/channels via ffmpeg, so every Take stays in one predictable format regardless of source. Mirrors the existing "takes are read-only WAV, never overwritten" rule.
- **Split / Ripple-delete** now target whichever track you last clicked in (`timeline_view.active_track`), instead of being hardcoded to the Voice track.
- Mute/solo/collapse toggles are now live in the UI for the first time — they existed in the data model and the exporter already respected them, but there was previously no way to click them.

## Testing performed (headless, offscreen Qt)

- Full existing test suite: **10/10 passing**, no regressions.
- Syntax + full import check of all new/changed modules.
- End-to-end functional run: built a real `MainWindow`, simulated two drops (one landing on empty space → new track created; one targeting that same new track → appended a second clip), confirmed the project autosaves and **reloads correctly from disk** with both takes and both clips intact.
- Direct hit-test verification: click on a clip's waveform → same track; click on empty timeline space → `None` (new track); click below the last lane → `None`; click anywhere in a collapsed lane → hits that track (no per-clip test needed there); header click on the Mute square → `track.muted` flips.

I couldn't test on real audio hardware or Windows/Explorer drag behavior from this sandbox — worth trying a real drop as your first check once you've got it running.

## Known gaps / good next increments (not done here, to keep this one focused)

- No `QScrollArea` — if you end up with more tracks than fit vertically, it'll get cramped rather than scroll. Straightforward to add if you hit this.
- No hover preview while dragging (e.g. highlighting which lane/track a file would land on before you drop it).
- Selection (for ripple-delete) is still a single time-range spanning all lanes visually, not per-track — matches the old single-track behavior, just now drawn taller.
- Worth testing whether dragging a card straight from the SFX Studio browser tool onto StateVO now actually works — Reaper didn't listen for Chrome's drag-out handoff, but StateVO's new `dragEnterEvent`/`dropEvent` accept standard file URLs, so there's a real chance it resolves differently here. Download-then-drag-from-Explorer will always work regardless.
