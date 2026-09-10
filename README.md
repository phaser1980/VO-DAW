# VO-DAW

A toolkit for voice-over and parody production: record vocal-only takes, then
layer in whatever the scene needs afterward.

**[▶ Open StateVO in your browser](https://phaser1980.github.io/VO-DAW/)** ·
[what it is](https://phaser1980.github.io/VO-DAW/about.html)

## What's in here

| Folder | What it is |
|---|---|
| [`docs/`](./docs) | **StateVO Web** — the voice-first DAW, running entirely in a browser tab. This folder is what GitHub Pages serves, so what's committed here is what's live. |
| [`vercel-proxy/`](./vercel-proxy) | The Freesound proxy, as Vercel functions. **This is the one that's deployed** — see below. |
| [`cloudflare-worker/`](./cloudflare-worker) | The same proxy as a Cloudflare Worker. Equivalent; use whichever platform you already have an account on. |
| [`statevo/`](./statevo) | **StateVO Desktop** — the original PySide6 build. Better latency and real device control; needs installing. |
| [`sfx-studio/`](./sfx-studio) | The standalone Flask SFX search tool that the web app's SFX panel grew out of. Kept because it still works and needs no Cloudflare account. |

## StateVO Web

Open the link, hit **Arm**, hit **Record**. No install, no account, nothing
uploaded — projects and audio live in that browser's IndexedDB.

- Multi-take recording with take stacks, punch-in over a selection, input gain
  and peak metering
- Non-destructive multi-track timeline: split, trim, drag fades, move clips
  between lanes, ripple-delete across all tracks, markers, snap
- **Built-in Foley search** — search Freesound, preview inline, drag the result
  card straight onto a lane. Dropping on a lane joins that track; dropping past
  the last lane creates a new one. Desktop files drop the same way.
- Fixed voice chain (cleanup → de-ess → compress → EQ → limit) with Social /
  Podcast / Raw presets, running as one Web Audio graph for both monitoring and
  the export render
- Script import with section markers and a teleprompter that follows playback
- Export presets: Reels/TikTok −14 LUFS, Podcast −16, YouTube, clean WAV — plus
  a loudness report

### Loudness accuracy

The LUFS meter is a full ITU-R BS.1770-4 implementation (K-weighting derived at
the actual sample rate, 400 ms blocks at 75 % overlap, absolute and relative
gating). It's checked against **pyloudnorm** — the library the desktop build
uses — across sine, speech-like and gated material at 44.1 and 48 kHz:

```
worst |delta| = 0.0001 dB
```

An end-to-end Reels export measured back with pyloudnorm lands at −14.06 LUFS
against a −14 target, −1.28 dBTP.

### Browser support

Chrome / Edge / Brave, and Firefox. Safari's AudioWorklet and IndexedDB support
means it mostly works but hasn't been tested. Recording needs HTTPS or
localhost, which the Pages URL satisfies.

## SFX search setup

Freesound sends no CORS headers, so a static page can't call the API directly.
A proxy sits in between, and it also keeps the API key server-side rather than
shipping it to every visitor of a public site.

**Deployed at:** `https://statevo-sfx-proxy-phase-security.vercel.app`

Two steps to finish it:

1. **Set the key.** Vercel dashboard → `statevo-sfx-proxy` → Settings →
   Environment Variables → `FREESOUND_API_KEY` (Production) → redeploy.
   Free key: https://freesound.org/apiv2/apply/
2. **Point the app at it.** ⚙ in the SFX panel, paste — note the `/api`:
   ```
   https://statevo-sfx-proxy-phase-security.vercel.app/api
   ```
   **Test connection** should say *Connected — API key is set.*

`/api/health` reports `hasKey` so you can tell step 1 from step 2 at a glance.

Details, and the Cloudflare equivalent, in
[`vercel-proxy/README.md`](./vercel-proxy/README.md) and
[`cloudflare-worker/README.md`](./cloudflare-worker/README.md).

You get Freesound's 128 kbps preview mp3 — fine for background Foley under a
vocal. For full-resolution files, download from Freesound directly and drag the
file onto the timeline; that path needs no setup at all.

## StateVO Desktop

Still here, still works — see [`statevo/README.md`](./statevo/README.md) and
[`statevo/ARCHITECTURE.md`](./statevo/ARCHITECTURE.md). Python 3.12+, PySide6,
pedalboard, sounddevice. Tests:

```bash
cd statevo && python -m pytest tests -q     # 8 passed, 1 skipped
```

The web build reuses its data model deliberately — Project → Track → Clip →
Take, with clips as non-destructive references into immutable takes — so the
two behave the same way even though they don't share code.

## Licence

Not yet chosen — treat this as "all rights reserved" until a `LICENSE` file
lands. Vendored [lamejs](./docs/vendor/lamejs-LICENSE) is LGPL; sounds pulled
from Freesound carry their own licence, which is stored on each take's metadata
in the project file.
