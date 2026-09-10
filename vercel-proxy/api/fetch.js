import { ALLOWED_FETCH_HOSTS, applyCors, handledPreflight } from "./_lib.js";

/**
 * GET /api/fetch?url=<freesound preview url>
 *
 * Streams a preview back with CORS headers so the app can decode it into an
 * AudioBuffer and drop it on the timeline. Host-allowlisted — otherwise this
 * would be an open relay.
 */
export default async function handler(req, res) {
  applyCors(req, res);
  if (handledPreflight(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const raw = String(req.query.url || "");
  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }
  if (target.protocol !== "https:" || !ALLOWED_FETCH_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: "Only Freesound preview URLs may be fetched." });
  }

  let upstream;
  try {
    upstream = await fetch(target.toString());
  } catch (err) {
    return res.status(502).json({ error: `Preview fetch failed: ${err.message}` });
  }
  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: `Preview fetch returned ${upstream.status}` });
  }

  res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg");
  res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=86400");

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.status(200).send(buf);
}
