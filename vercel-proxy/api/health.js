import { applyCors, handledPreflight } from "./_lib.js";

/** GET /api/health -> { ok, hasKey } — powers the app's Test connection button. */
export default function handler(req, res) {
  applyCors(req, res);
  if (handledPreflight(req, res)) return;

  res.status(200).json({
    ok: true,
    hasKey: !!process.env.FREESOUND_API_KEY,
    service: "statevo-sfx-proxy",
    runtime: "vercel",
  });
}
