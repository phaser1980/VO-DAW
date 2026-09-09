# StateVO (working title)

A clean, modern, voice-first DAW for spoken-word content: parody news,
narration, podcasts, short-form social voiceover. Not a music DAW — no
MIDI, no instruments, no routing matrices. Record → clean up → export,
fast.

## Status

Usable personal voice-over build. The core loop — **record → waveform →
edit → process → export** — is implemented end to end, including
selection-based ripple deletion, draggable trim/fade handles, undo/redo,
two-second punch-in pre-roll, audio-device selection, and safe project
copying. Raw takes are immutable and exports never overwrite an earlier
same-day render.

The dependency-backed suite currently contains 24 passing tests. The UI
has also been instantiated headlessly with the native audio/DSP packages.
Recording still needs a short real-microphone check on each PC because
PortAudio device/driver behaviour cannot be proven by unit tests.

## Requirements

- Python 3.12+
- [ffmpeg](https://ffmpeg.org/) on your `PATH` (only needed for MP3/AAC
  export — Clean WAV export works without it)
- A working audio input device

## Windows quick start

1. Double-click `Setup-StateVO.ps1` (right-click → **Run with PowerShell**
   if Windows asks how to open it).
2. Double-click `Start-StateVO.cmd` whenever you want to record.
3. In StateVO, open **File → Audio Devices…** and choose the microphone
   interface and headphones you actually use.

The setup script creates an isolated `.venv`, installs the full app, and
runs its tests. Your system Python packages are not changed. FFmpeg is
already detected on the prepared PC; on another PC, install it with
`winget install Gyan.FFmpeg` for AAC exports.

## Manual install

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev,noise]"
```

The `noise` extra pulls in `noisereduce` for higher-quality spectral
noise reduction. Without it, the Noise Cleanup stage falls back to a
simple noise gate (still functional, just less capable on hiss/hum).

## Run

```bash
python -m statevo.app
```

## Test

```bash
pytest
```

Tests that depend on optional/heavy packages (`pyloudnorm`,
`pedalboard`) skip gracefully if those aren't installed, so `pytest`
degrades gracefully in a minimal environment.

## Package as a standalone executable

```powershell
.\Build-StateVO.ps1
```

The standalone Windows app is written to `dist\StateVO.exe`.

## Project files

Projects are plain folders — human-readable and portable:

```
My Episode.svoproj/
    project.json     # everything except audio: tracks, clips, markers, settings
    takes/           # raw recorded WAV files — never overwritten
    exports/         # rendered deliverables land here by default
```

## Keyboard shortcuts

| Key         | Action                        |
|-------------|--------------------------------|
| `R`         | Start / stop recording         |
| `Space`     | Play / stop                    |
| `S`         | Split at playhead               |
| `M`         | Add marker at playhead          |
| `Backspace` | Ripple-delete current selection |
| `Ctrl+S`    | Save project                    |
| `Ctrl+E`    | Open export dialog               |
| `Ctrl+Z`    | Undo last edit                    |
| `Ctrl+Y`    | Redo last edit                    |
| `Ctrl+Scroll` on waveform | Zoom in/out       |

Waveform controls:

- Drag a clip's lower left/right edge to trim it.
- Drag either circular top handle to change its fade.
- Drag across the waveform to select; Backspace removes that exact range
  and closes the gap.
- For punch-in, select the replacement range, enable **Punch In/Out**, put
  on headphones, then press Record. StateVO plays two seconds of lead-in,
  mutes the old voice in the selected range, and stops at the punch-out.

## Known limitations

- **Playback renders then plays.** The Play button mixes the current
  project and voice chain to a buffer before playback. A large project
  can therefore take a moment to start, and processing changes require
  pressing Play again. See `ARCHITECTURE.md` →
  "Playback engine upgrade path" for how this slots in later.
- **Comping** has a solid data-model primitive (`edit_ops.build_comp`)
  but no dedicated multi-take comping UI yet — that's the next feature
  slot after the priority loop.
- **Punch timing is not latency-calibrated.** The two-second pre-roll is
  usable with normal interface buffers, but this build does not measure
  and compensate for a specific driver's round-trip latency.
- **No transcription/filler removal.** Those extension points remain
  intentionally unimplemented; this build does not upload voice audio.
