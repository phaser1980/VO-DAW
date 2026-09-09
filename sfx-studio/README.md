# SFX On-Call Studio

Local soundboard for pulling Foley/ambience over vocal-only Reaper recordings.
Searches Freesound's Creative Commons library (millions of clips — footsteps,
doors, sirens, choppers, crowds, gunfire, all of it), lets you preview instantly,
and download or drag straight into your session.

## Why local instead of a browser-only tool

Freesound's search API doesn't allow direct browser requests (no CORS), so a
pure client-side page can't call it. This ships a tiny local Flask server that
does the search server-side and serves you a normal webpage — same result,
one extra `python app.py` step.

## Setup

1. **Get a free API key**: https://freesound.org/apiv2/apply/
   (instant approval, just describe it as a personal sound-search tool)

2. **Set the key as an environment variable:**
   ```bash
   export FREESOUND_API_KEY="your_key_here"
   ```
   (add that line to your `.zshrc`/`.bashrc` so you don't retype it every session)

3. **Install dependencies:**
   ```bash
   cd sfx-studio
   pip install -r requirements.txt
   ```

4. **Run it:**
   ```bash
   python app.py
   ```

5. **Open** http://localhost:5055

## Using it

- Type a description ("boots on gravel", "military radio chatter", "helicopter hover")
  or click one of the quick-tag chips seeded with the categories you mentioned
  (footsteps, doors, sirens, mess hall chatter, chopper, gunfire).
- **Play** previews inline before committing to anything.
- **Download** saves the mp3 straight to your Downloads folder — drag it into
  Reaper from there.
- **Drag the card itself** onto Reaper's timeline — Chrome/Edge support
  dragging a URL straight into a native app as a file. This is best-effort
  (it's a browser trick, not a guarantee) — Download is the reliable fallback
  if a drag doesn't take.
- "Safe license only" is checked by default — restricts results to CC0 and
  Attribution, so nothing you pull in creates a licensing headache later.
  Uncheck it if you want the full result set (and are OK crediting sources
  with more restrictive licenses).

## Notes

- Files are Freesound's compressed preview mp3s (128kbps), not the original
  uploads — plenty clean for background Foley under a vocal track, not
  meant for anything needing studio-master quality.
- No API keys or credentials are stored anywhere except your own shell
  environment variable.
- If a search comes back empty, broaden the query — Freesound's text search
  is literal keyword matching, not semantic (e.g. "gun" beats "firearm discharge").
