# StateVO — Freesound proxy (Vercel)

Same job as [`../cloudflare-worker`](../cloudflare-worker), deployed to Vercel
instead. Pick whichever platform you already have an account on — the app talks
to both identically.

Freesound sends no CORS headers, so a static page can't call the API directly.
This also keeps the API key server-side rather than shipping it to every
visitor of a public site.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/health` | `{ ok, hasKey }` — the app's **Test connection** button |
| `GET /api/search?q=&page=&safe=&max_duration=&sort=` | Freesound text search. `safe=1` (default) restricts to CC0 + Attribution |
| `GET /api/fetch?url=` | Streams a Freesound preview back with CORS, so the app can decode it and drop it on the timeline |

`/api/fetch` only accepts `freesound.org` and `cdn.freesound.org` URLs —
without that allowlist this would be an open relay.

## Deploy

```bash
cd vercel-proxy
npx vercel --prod
```

Then set the key (Vercel dashboard → the project → Settings → Environment
Variables), or from the CLI:

```bash
npx vercel env add FREESOUND_API_KEY production
npx vercel --prod          # redeploy so the new env var is picked up
```

Free key: https://freesound.org/apiv2/apply/

## Point the app at it

In StateVO, open ⚙ in the SFX panel and paste the deployment URL **with
`/api` on the end**:

```
https://<your-deployment>.vercel.app/api
```

The app appends `/health`, `/search` and `/fetch` itself. Hit **Test
connection** — it should say *Connected — API key is set.*

## Optional: lock it to your own site

Set an `ALLOWED_ORIGINS` env var to your Pages origin and redeploy:

```
ALLOWED_ORIGINS = https://phaser1980.github.io
```

Unset means any origin, which is fine for a read-only proxy.

## Notes

- What you get is Freesound's **preview mp3** (128 kbps), not the original
  upload — plenty for background Foley under a vocal. Full-resolution
  downloads need OAuth2, which a static site can't do sensibly; download those
  from Freesound directly and drag the file onto the timeline instead.
- Search responses are edge-cached 5 minutes, previews a day.
- Attribution licences still mean attribution — the licence and uploader are
  stored on each take's metadata in the project file.
