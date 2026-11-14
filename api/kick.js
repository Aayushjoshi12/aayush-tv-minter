// api/kick.js — Kick (Amazon IVS) master -> variant resolver.
//
// The Kick API gives a master playlist URL (an Amazon IVS .m3u8).
// That master does NOT send Access-Control-Allow-Origin, so a
// browser on another site cannot read it (hls.js hangs on
// buffering). But the variant playlists inside it, and the .ts
// segments, DO send Access-Control-Allow-Origin: *.
//
// This endpoint fetches the master server-side, picks the best
// variant playlist, and returns its address. The site's player
// (hls.js) then loads that variant directly — variant + segments
// both allow this site, so it plays natively.
//
// GET /api/kick?url=<encoded IVS master .m3u8 URL>
//   -> { "variant": "https://....playlist.live-video.net/..." }
// GET /api/kick?url=...&debug=1
//   -> { "masterStatus": 200, "variant": "...", "variants": n }

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

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

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Parse a master playlist: return [{ bandwidth, url }, ...].
function parseVariants(text, base) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = parseInt((t.match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
    const next = (lines[i + 1] || "").trim();
    if (!next || next.startsWith("#")) continue;
    const url = /^https?:\/\//i.test(next)
      ? next
      : new URL(next, base).toString();
    out.push({ bandwidth: bw, url });
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const master = req.query && req.query.url;
  const debug = req.query && req.query.debug === "1";
  if (!master || !/^https?:\/\//i.test(master)) {
    json(res, 400, { error: "missing or bad url" });
    return;
  }

  let masterText;
  try {
    masterText = await fetchText(master);
  } catch (e) {
    json(res, 502, { error: "master fetch failed", detail: String((e && e.message) || e) });
    return;
  }

  const variants = parseVariants(masterText, master);
  if (!variants.length) {
    if (debug) {
      json(res, 200, {
        masterStatus: 200,
        variant: null,
        variants: 0,
        sample: masterText.slice(0, 300),
      });
      return;
    }
    json(res, 502, { error: "no variants in master" });
    return;
  }

  // Best (highest-bandwidth) variant.
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  const best = variants[0];
  if (debug) {
    json(res, 200, {
      masterStatus: 200,
      variant: best.url,
      variants: variants.length,
      bandwidth: best.bandwidth,
    });
    return;
  }
  json(res, 200, { variant: best.url });
}
