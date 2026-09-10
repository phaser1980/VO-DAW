# StateVO — Freesound proxy Worker

Freesound's API sends no CORS headers, so the browser build of StateVO can't
call it directly from `github.io`. This Worker sits in between. It also means
your Freesound API key stays server-side instead of being visible in the page
source of a public site.

Free tier is plenty — this is a couple of hundred requests a day at most.

## Deploy (about five minutes)

**1. Get a Freesound API key** (instant, free): https://freesound.org/apiv2/apply/
Describe it as a personal sound-search tool.

**2. Install wrangler and log in**

```bash
npm install -g wrangler
wrangler login
```

**3. Deploy from this folder**

```bash
cd cloudflare-worker
wrangler deploy
```

Wrangler prints the URL it deployed to, e.g.
`https://statevo-sfx-proxy.<your-subdomain>.workers.dev`

**4. Set the API key as a secret**

```bash
wrangler secret put FREESOUND_API_KEY
# paste the key when prompted
```

**5. Point StateVO at it**

Open the app, click ⚙ in the SFX panel, paste the Worker URL, hit
**Test connection**. It should say *Connected — API key is set.* The URL is
remembered in that browser.

## Optional: lock it to your own site

By default the Worker answers any origin. To restrict it, uncomment the
`ALLOWED_ORIGINS` var in `wrangler.toml`, set it to your Pages origin, and
redeploy:

```toml
[vars]
ALLOWED_ORIGINS = "https://phaser1980.github.io"
```

## Endpoints

| Route | What it does |
|---|---|
| `GET /health` | `{ ok, hasKey }` — used by the Test connection button |
| `GET /search?q=&page=&safe=&max_duration=&sort=` | Freesound text search. `safe=1` (default) restricts to CC0 + Attribution |
| `GET /fetch?url=` | Streams a Freesound preview back with CORS headers, so the app can decode it and drop it on the timeline |

`/fetch` only accepts `freesound.org` and `cdn.freesound.org` URLs — without
that allowlist the Worker would be an open relay.

## Notes

- What you get is Freesound's **preview mp3** (128 kbps), not the original
  upload. Plenty clean for background Foley sitting under a vocal; not a
  studio master. Full-resolution downloads need OAuth2, which a static site
  can't do sensibly — download those from Freesound directly and drag the
  file onto the timeline, which works identically.
- Search results are cached at the edge for 5 minutes, previews for a day.
- Licence filtering happens server-side. With `safe=1` you only ever see CC0
  and Attribution, so nothing you pull creates a problem later. Attribution
  still means attribution — the licence and uploader are stored on the clip's
  take metadata in the project file.
