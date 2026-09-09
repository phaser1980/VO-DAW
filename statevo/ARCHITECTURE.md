# StateVO — Architecture

## 1. Philosophy → technical consequences

| Product principle                          | What it means architecturally                                                   |
|---------------------------------------------|-----------------------------------------------------------------------------------|
| Voice first, everything else hidden         | One primary voice track by default; a second bed/SFX track exists but starts collapsed. No generic N-track mixer UI. |
| Extremely low cognitive load                | Flat menus (3 top-level, no submenus). A fixed 5-stage voice chain instead of a plugin chain. Three export presets instead of a format matrix. |
| Opinionated defaults                        | `core/presets.py` is the single place "what does StateVO do by default" lives — presets are data, not scattered magic numbers. |
| Fast record → export loop                   | Recording auto-creates a clip on the primary track; every take autosaves; export is a 2-click dialog with auto-naming. |
| No MIDI / instruments / notation            | Reflected by omission — there is no `midi/`, no plugin-hosting layer beyond the fixed voice chain, no notation renderer. |

## 2. Technology choices

- **Python 3.12+** — as specified.
- **UI: PySide6 (Qt6)**, chosen over Dear PyGui. Reasoning: this app
  needs dockable panels (script/teleprompter), rich text widgets
  (`QTextBrowser` for the teleprompter, auto-scroll to text), native
  file dialogs, and a straightforward path to a signed desktop
  installer via PyInstaller. Dear PyGui is excellent for fast
  immediate-mode tool UIs but is a worse fit for a text-heavy,
  dockable, "normal desktop app" experience. If a lighter-weight /
  more GPU-driven look becomes a priority later, the `ui/` package is
  isolated enough from `core/` that a UI framework swap would not
  touch business logic.
- **Audio I/O: `sounddevice`** (PortAudio) for low-latency record and
  playback.
- **Audio file I/O: `soundfile`** for streaming WAV reads/writes
  (critical for not loading a 45-minute take entirely into RAM).
- **DSP: `pedalboard`** (Spotify) for the compressor, EQ filters, and
  limiter — mature, fast (JUCE-backed), simple Python API. The
  de-esser is hand-rolled on top of pedalboard's filters (see
  `core/voice_chain.py`) since pedalboard has no native sidechain
  de-esser.
- **Noise reduction: `noisereduce`** (optional dependency) for
  spectral-gating noise cleanup, with a pedalboard `NoiseGate` fallback
  if it isn't installed — the app should never hard-fail because an
  optional DSP package is missing.
- **Loudness: `pyloudnorm`** — ITU-R BS.1770 integrated loudness,
  matching how streaming platforms measure LUFS.
- **Lossy encoding: `ffmpeg` via subprocess** for MP3/AAC. WAV export
  needs no external binary. This is the one hard external dependency;
  the app detects its absence and fails export with a clear message
  rather than a stack trace.
- **Project format: JSON + a folder of WAV files.** Chosen for
  transparency (a user or a script can inspect/repair a project) and
  because it makes "non-destructive" a structural guarantee, not just
  a UI promise — there is no code path that overwrites take audio.

## 3. Folder structure

```
statevo/
├── pyproject.toml
├── requirements.txt
├── README.md
├── ARCHITECTURE.md
├── statevo/
│   ├── app.py                     # entry point / QApplication bootstrap
│   ├── config.py                  # global constants, defaults, enums
│   ├── core/                      # domain logic — NO Qt imports allowed
│   │   ├── project.py             # Project, Track, Clip, Take, Marker, VoiceChainSettings
│   │   ├── audio_engine.py        # AudioEngine: record/playback via sounddevice
│   │   ├── waveform.py            # Peak-cache generation for fast waveform drawing
│   │   ├── edit_ops.py            # split / trim / fade / crossfade / ripple / comp
│   │   ├── dsp_utils.py           # shared fade-curve + dB<->gain helpers
│   │   ├── voice_chain.py         # NoiseReduction, De-esser, Compressor, EQ, Limiter
│   │   ├── loudness.py            # LUFS measurement + normalization (pyloudnorm)
│   │   ├── presets.py             # Voice-chain presets + export presets (all named, opinionated)
│   │   ├── exporter.py            # Render → process → normalize → encode pipeline
│   │   ├── script_import.py       # Parse .txt/.md into ScriptSections
│   │   └── project_io.py          # save/load project to/from disk, template instantiation
│   ├── ui/                        # all Qt-specific code
│   │   ├── main_window.py         # Assembles every panel; the only "knows everything" module
│   │   ├── transport_bar.py       # Record / Play / Stop / take nav / gain / peak meter
│   │   ├── waveform_view.py       # Custom-painted waveform, markers, playhead, selection
│   │   ├── voice_chain_strip.py   # 5 toggles + preset dropdown + LUFS readout
│   │   ├── script_panel.py        # Collapsible script/teleprompter + markers list
│   │   ├── meters.py              # PeakMeter, LufsReadout widgets
│   │   ├── export_dialog.py       # Preset picker + background export + progress
│   │   ├── project_dialog.py      # New/open project, templates
│   │   ├── theme.py               # Dark QSS stylesheet, single source of visual truth
│   │   └── widgets/
│   │       └── record_button.py   # The big, always-visible Record button
│   └── assets/
│       └── templates/
│           └── absolute_state_episode.json
├── tests/                         # headless — exercise core/ only, no Qt, no audio hardware
└── packaging/
    └── statevo.spec               # PyInstaller spec
```

The `core/` vs `ui/` boundary is the most important structural decision
in this codebase: `core/` has zero Qt imports, so it's unit-testable
without a display server and reusable from something that isn't the
desktop app (a CLI batch exporter, or a future AI post-processing
service).

## 4. Core classes

| Class | File | Responsibility |
|---|---|---|
| `Project` | `core/project.py` | Root aggregate: tracks, takes, markers, voice chain settings, script. `to_dict`/`from_dict` for JSON. |
| `Track` | `core/project.py` | Ordered list of `Clip`s + volume/mute/solo/collapsed. Kind is `voice` or `bed_sfx`. |
| `Clip` | `core/project.py` | A non-destructive reference into a `Take`: timeline position, in/out points, gain, fades. |
| `Take` | `core/project.py` | One recorded pass — a WAV file reference. Never mutated after recording. |
| `Marker` | `core/project.py` | Named timeline position, used for both manual markers and script-derived section markers. |
| `VoiceChainSettings` | `core/project.py` | The 5-stage chain's enabled flags + parameters + active preset name. |
| `AudioEngine` | `core/audio_engine.py` | Owns the `sounddevice` streams; records to disk incrementally via a writer thread; exposes `last_peak_level` for safe cross-thread metering. |
| `PeakData` | `core/waveform.py` | Cached min/max waveform peaks for a take, downsampled on demand for any zoom level. |
| `VoiceChain` | `core/voice_chain.py` | Runs the fixed 5-stage DSP chain over a buffer, honouring enabled flags. |
| `ExportPreset` | `core/presets.py` | Format + target LUFS + sample rate + bitrate for one export button. |
| `WaveformView` | `ui/waveform_view.py` | Paints the active track's clips, playhead, markers, selection; handles click/drag/zoom. |
| `MainWindow` | `ui/main_window.py` | Wires every panel together via Qt signals; the single place that knows the whole app. |

## 5. Data flow

### 5.1 Recording loop
1. User hits **Record** → `MainWindow._start_recording` builds a take
   path and calls `AudioEngine.start_recording`.
2. `sounddevice.InputStream`'s callback (a background thread) applies
   input gain and pushes raw blocks into a `queue.SimpleQueue` — it never
   blocks and never touches Qt.
3. A writer thread drains the queue, writes to a `soundfile.SoundFile`
   incrementally, and updates `AudioEngine.last_peak_level` (a plain
   float — safe to poll from the GUI thread under the GIL).
4. A `QTimer` on the main thread polls `elapsed_recording_sec` and
   `last_peak_level` to update the transport clock and peak meter —
   this is the thread-safety boundary: **background threads write
   plain data, only the main-thread timer touches Qt widgets.**
5. User hits **Stop** → the engine closes the stream, finalizes the
   `Take`, and `MainWindow` creates a `Clip` on the primary voice
   track, computes a waveform peak cache, and autosaves the project.

### 5.2 Editing
All edits (`core/edit_ops.py`) are pure functions over `Clip`/`Track`
objects — they never read or write audio files. A split just adjusts
two clips' `source_in/out` and `start_sec`; a fade just sets a
duration + curve. The actual audio is only ever read when something
needs to *hear* or *render* it (playback or export).

### 5.3 Export pipeline (`core/exporter.py`)
```
render_master(project)            # mixdown of all tracks/clips → one buffer
        │
        ▼
VoiceChain.process(...)           # noise reduction → de-esser → compressor → EQ → limiter
        │
        ▼
normalize_to_lufs(..., target)    # per export-preset target (skipped for Clean WAV)
        │
        ▼
resample if preset.sample_rate != project.sample_rate
        │
        ▼
encode (soundfile for WAV, ffmpeg subprocess for MP3/AAC)
        │
        ▼
write <name>_<date>_<preset>.<ext>  +  optional .loudness.json report
```

## 6. Threading model

- **Qt main thread** — UI only, plus a single `QTimer` that polls
  engine state for the transport clock, peak meter, and playhead.
- **`sounddevice` callback thread** — tight loop, never blocks; only
  pushes into a queue.
- **Writer thread** — drains the queue, writes to disk, updates a
  plain-float peak level.
- **`QThread` export worker** — runs the render/process/encode
  pipeline off the main thread so the export dialog stays responsive.

## 7. Extension points for future AI features

The spec asks for an architecture that lets transcription, smarter
cleanup, and filler-word removal be added later without a rewrite.
Concretely:

- **Transcription** would live in a new `core/transcription.py` with a
  function `transcribe(take: Take) -> list[TranscriptWord]`. It's a
  pure `core/` module — no UI changes required beyond a new panel that
  displays the result and optionally uses it to auto-place markers
  (which `script_import.py` already has a `ScriptSection`-based
  precedent for).
- **Filler-word removal** would be a new `edit_ops` function,
  `remove_fillers(track, transcript) -> list[Clip]`, built on the same
  `ripple_delete` primitive that already exists — it would just call
  it repeatedly at transcript-derived timestamps instead of a manual
  selection.
- **Smarter noise reduction** already has a seam: `VoiceChain._reduce_noise`
  currently branches on whether `noisereduce` is installed. Swapping in
  a learned model later is a one-function change.
- All of the above stay inside `core/`, so none of it requires touching
  `ui/` except to add a menu action or a result panel.

## 8. Playback engine upgrade path

The MVP's `AudioEngine.play_buffer` renders the whole mix up front and
plays it via `sounddevice.play()`. This is simple and reliable but has
two consequences: (a) playback start has a small render delay on large
projects, and (b) an edit made while paused requires pressing Play
again rather than being instantly audible.

The natural upgrade is a streaming mixer: an `sd.OutputStream` callback
that pulls small blocks from the current `Project` state in real time
(mixing overlapping clips, applying live gain/fades) instead of a
pre-rendered buffer. Because `render_master`/`_render_track` already
express the mixing logic in a block-oriented way, this is a matter of
chunking that same logic into a callback rather than a redesign.

## 9. Phased roadmap

- **Phase 0 — Scaffold (done).** Folder structure, data model, DSP
  modules, dark theme, all UI panels wired together.
- **Phase 1 — Priority loop (done).** Record → waveform → split/fade
  via `edit_ops` → voice chain → export with LUFS normalization and a
  loudness report.
- **Phase 2 — Editing polish (mostly done).** Draggable trim/fade
  handles, exact-range ripple deletion, undo/redo snapshots, audio-device
  selection, and punch-in/out with two-second audible pre-roll are built.
  A dedicated multi-take comping UI on top of `edit_ops.build_comp`
  remains.
- **Phase 3 — Streaming playback engine.** Replace render-then-play
  with the live mixing callback described in §8.
- **Phase 4 — AI features.** Transcription, filler-word removal,
  smarter/learned noise reduction — all additive under `core/`, per §7.
- **Phase 5 — Packaging & polish (in progress).** Windows setup/launch
  scripts, in-app input/output device preferences, and a tested
  PyInstaller build path are present. Signed installers, configurable
  project sample rates, and additional templates remain.
