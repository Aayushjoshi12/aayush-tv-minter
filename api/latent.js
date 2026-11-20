// api/latent.js — India's Got Latent episode resolver (general, not per-episode).
//
// The fan archive's player resolves each episode through a Cloudflare
// Worker that mints signed OK.ru MP4 links (144p-1080p). That worker
// only answers requests that present as the fan site itself (it 403s
// any other Origin/Referer — verified 20 Nov 2026), and the signed
// links it returns expire in ~5 days, so they cannot be pasted into a
// page. This endpoint mints fresh links server-side on every play, the
// same pattern as api/kick.js: the site's player gets a fresh signed
// URL and plays it natively in a <video> tag.
//
// The worker URL has rotated before (moivies -> uppcldirect, per the
// fan site's /config.json), so both are tried in order.
//
// GET /api/latent?id=<episode hex id>
//   -> { "streams": [{ "type": "1080p", "url": "..." }, ...], "best": { "type": "1080p", "url": "..." } }
// On failure: { "error": "..." } with 502.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FAN_ORIGIN = "https://igl-8wky.freeforall.dev";
const FAN_REFERER = "https://igl-8wky.freeforall.dev/";
const WORKERS = [
  "https://okcdn.uppcldirect.workers.dev",
  "https://okcdn.moivies.workers.dev",
];
const TIMEOUT_MS = 4000;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function json(res, status, obj) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Origin: FAN_ORIGIN,
        Referer: FAN_REFERER,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function qualityOf(type) {
  const m = String(type || "").match(/(\d+)p/);
  return m ? parseInt(m[1], 10) : 0;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const id = req.query && req.query.id;
  if (!id || !/^[0-9a-f]{12,64}$/i.test(id)) {
    json(res, 400, { error: "missing or bad id" });
    return;
  }

  let data = null;
  let lastErr = "";
  for (const worker of WORKERS) {
    try {
      data = await fetchJson(worker + "/?id=" + encodeURIComponent(id));
      if (data && data.status === "success" && Array.isArray(data.streams) && data.streams.length) break;
      lastErr = (data && (data.error || data.message)) || "no streams";
      data = null;
    } catch (e) {
      lastErr = String((e && e.message) || e);
      data = null;
    }
  }
  if (!data) {
    json(res, 502, { error: "latent worker failed", detail: lastErr });
    return;
  }

  const streams = data.streams
    .filter((s) => s && s.url)
    .map((s) => ({ type: s.type || "", url: s.url }))
    .sort((a, b) => qualityOf(b.type) - qualityOf(a.type));
  if (!streams.length) {
    json(res, 502, { error: "no streams in worker reply" });
    return;
  }
  json(res, 200, { streams, best: streams[0] });
}
