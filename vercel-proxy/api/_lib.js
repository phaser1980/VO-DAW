/**
 * Shared bits for the Freesound proxy functions.
 *
 * Same job as the Cloudflare Worker in ../cloudflare-worker: Freesound sends
 * no CORS headers, so a static page on GitHub Pages can't call it. This also
 * keeps the API key server-side instead of shipping it to every visitor.
 */

export const FREESOUND_SEARCH = "https://freesound.org/apiv2/search/text/";

export const FIELDS =
  "id,name,previews,images,duration,license,tags,username,avg_rating,num_downloads";

// CC0 + Attribution only — safe to drop into a monetised video without a
// licensing headache later.
export const SAFE_LICENSES = '("Creative Commons 0" OR "Attribution")';

// Hosts /fetch may proxy. Without this allowlist the function is an open relay.
export const ALLOWED_FETCH_HOSTS = new Set([
  "freesound.org",
  "www.freesound.org",
  "cdn.freesound.org",
]);

/**
 * ALLOWED_ORIGINS is an optional comma-separated env var. Unset means allow
 * any origin, which is fine for a read-only proxy.
 */
export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin = !allowed.length
    ? "*"
    : allowed.includes(origin)
      ? origin
      : allowed[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

/** Returns true when the request was an OPTIONS preflight and is now answered. */
export function handledPreflight(req, res) {
  if (req.method !== "OPTIONS") return false;
  res.status(204).end();
  return true;
}

export function clampInt(value, fallback, lo, hi) {
  const n = parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
