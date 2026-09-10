/**
 * StateVO — Freesound proxy Worker.
 *
 * Freesound's API sends no CORS headers, so a static page on GitHub Pages
 * can't call it directly. This Worker is the smallest thing that fixes that,
 * and it earns its keep twice over: the API key lives here as a secret
 * instead of being shipped to every visitor in the page source.
 *
 * Endpoints
 *   GET /health              -> { ok, hasKey }
 *   GET /search?q=…          -> Freesound text search, JSON passthrough
 *   GET /fetch?url=…         -> streams a Freesound preview back with CORS
 *
 * Deploy: see README.md in this folder.
 */

const FREESOUND_SEARCH = "https://freesound.org/apiv2/search/text/";

// Fields we actually use in the SFX panel. Asking for less keeps the payload
// small on a phone tether.
const FIELDS = "id,name,previews,images,duration,license,tags,username,avg_rating,num_downloads";

// CC0 + Attribution only. Everything you pull with the default filter on is
// safe to drop into a monetised video without a licensing headache later.
const SAFE_LICENSES = '("Creative Commons 0" OR "Attribution")';

// Hosts /fetch is allowed to proxy. Without this the Worker is an open relay.
const ALLOWED_FETCH_HOSTS = new Set([
  "freesound.org",
  "www.freesound.org",
  "cdn.freesound.org",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    switch (url.pathname.replace(/\/+$/, "")) {
      case "":
      case "/health":
        return json({ ok: true, hasKey: !!env.FREESOUND_API_KEY, service: "statevo-sfx-proxy" }, 200, cors);
      case "/search":
        return handleSearch(url, env, cors);
      case "/fetch":
        return handleFetch(url, cors);
      default:
        return json({ error: "Not found" }, 404, cors);
    }
  },
};

/* ------------------------------------------------------------------ */

async function handleSearch(url, env, cors) {
  if (!env.FREESOUND_API_KEY) {
    return json({ error: "FREESOUND_API_KEY is not set on this Worker." }, 500, cors);
  }

  const query = (url.searchParams.get("q") || "").trim();
  if (!query) return json({ error: "Missing ?q" }, 400, cors);

  const page = clampInt(url.searchParams.get("page"), 1, 1, 100);
  const pageSize = clampInt(url.searchParams.get("page_size"), 30, 1, 60);
  const sort = ["score", "downloads_desc", "rating_desc", "duration_asc", "created_desc"].includes(
    url.searchParams.get("sort") || "",
  )
    ? url.searchParams.get("sort")
    : "score";

  const filters = [];
  if (url.searchParams.get("safe") !== "0") filters.push(`license:${SAFE_LICENSES}`);
  const maxDuration = url.searchParams.get("max_duration");
  if (maxDuration && /^\d+(\.\d+)?$/.test(maxDuration)) {
    filters.push(`duration:[0 TO ${maxDuration}]`);
  }

  const target = new URL(FREESOUND_SEARCH);
  target.searchParams.set("query", query);
  target.searchParams.set("page", String(page));
  target.searchParams.set("page_size", String(pageSize));
  target.searchParams.set("sort", sort);
  target.searchParams.set("fields", FIELDS);
  if (filters.length) target.searchParams.set("filter", filters.join(" "));

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { Authorization: `Token ${env.FREESOUND_API_KEY}` },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (err) {
    return json({ error: `Freesound unreachable: ${err.message}` }, 502, cors);
  }

  const body = await upstream.text();
  if (!upstream.ok) {
    return json(
      { error: `Freesound returned ${upstream.status}`, detail: body.slice(0, 400) },
      upstream.status,
      cors,
    );
  }

  return new Response(body, {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

async function handleFetch(url, cors) {
  const raw = url.searchParams.get("url") || "";
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: "Invalid url" }, 400, cors);
  }
  if (target.protocol !== "https:" || !ALLOWED_FETCH_HOSTS.has(target.hostname)) {
    return json({ error: "Only Freesound preview URLs may be fetched." }, 403, cors);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
  } catch (err) {
    return json({ error: `Preview fetch failed: ${err.message}` }, 502, cors);
  }
  if (!upstream.ok) {
    return json({ error: `Preview fetch returned ${upstream.status}` }, upstream.status, cors);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") || "audio/mpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

/* ------------------------------------------------------------------ */

function corsHeaders(origin, env) {
  // ALLOWED_ORIGINS is a comma-separated list; unset means allow any origin,
  // which is fine for a read-only proxy but tighten it if you'd rather.
  const allowed = (env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin = !allowed.length ? "*" : allowed.includes(origin) ? origin : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function clampInt(value, fallback, lo, hi) {
  const n = parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
