import {
  FREESOUND_SEARCH, FIELDS, SAFE_LICENSES,
  applyCors, handledPreflight, clampInt,
} from "./_lib.js";

/** GET /api/search?q=&page=&safe=&max_duration=&sort= */
export default async function handler(req, res) {
  applyCors(req, res);
  if (handledPreflight(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.FREESOUND_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "FREESOUND_API_KEY is not set on this deployment.",
    });
  }

  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing ?q" });

  const page = clampInt(req.query.page, 1, 1, 100);
  const pageSize = clampInt(req.query.page_size, 30, 1, 60);
  const sortWhitelist = ["score", "downloads_desc", "rating_desc", "duration_asc", "created_desc"];
  const sort = sortWhitelist.includes(req.query.sort) ? req.query.sort : "score";

  const filters = [];
  if (req.query.safe !== "0") filters.push(`license:${SAFE_LICENSES}`);
  const maxDuration = req.query.max_duration;
  if (maxDuration && /^\d+(\.\d+)?$/.test(maxDuration)) {
    filters.push(`duration:[0 TO ${maxDuration}]`);
  }

  const target = new URL(FREESOUND_SEARCH);
  target.searchParams.set("query", q);
  target.searchParams.set("page", String(page));
  target.searchParams.set("page_size", String(pageSize));
  target.searchParams.set("sort", sort);
  target.searchParams.set("fields", FIELDS);
  if (filters.length) target.searchParams.set("filter", filters.join(" "));

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { Authorization: `Token ${key}` },
    });
  } catch (err) {
    return res.status(502).json({ error: `Freesound unreachable: ${err.message}` });
  }

  const body = await upstream.text();
  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error: `Freesound returned ${upstream.status}`,
      detail: body.slice(0, 400),
    });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  res.status(200).send(body);
}
