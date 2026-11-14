// api/zoloj.js — manifest rewriter for the zoloj Bigg Boss live feeds.
//
// GET /api/zoloj?lang=tamil
//   -> 200 the .m3u8 playlist (application/vnd.apple.mpegurl, CORS *)
//      with relative URLs rewritten to absolute (stream2.zoloj.com).
// GET /api/zoloj?lang=tamil&debug=1
//   -> 200 JSON {playerStatus, sid, m3u8Status, manifestSample}
//
// WHY: the Bigg Boss feeds (stream2.zoloj.com/stream/<lang>.m3u8)
// play in a browser tab on their own, but a page on aayushlife.live
// cannot load them: hls.js hangs on buffering (no CORS *) and an
// iframe shows "forbidden" (the source blocks cross-site embeds).
// The .m3u8 also needs a session sid baked into the player page
// (stream2.zoloj.com/player?lang=<lang>), and that sid is IP-bound,
// so a laptop/server whose address keeps changing gets 401/403.
// This function runs on Vercel, fetches the player page with an
// article Referer to get a fresh sid, fetches the .m3u8 with that
// sid (same server, same address), and serves the playlist text back
// with CORS * — the same manifest-rewriter pattern the Movies
// resolver already uses for net52 and VidRift. Only playlist TEXT
// passes through here; the .ts segments are fetched by the browser
// directly from the broadcaster's own CDN (Hotstar), NOT through
// this function and NOT through zoloj's segment proxy. The
// manifest's segment lines are zoloj /seg proxy URLs; this
// function rewrites them to the real CDN address hidden in the
// proxy's `u` parameter, because that CDN sends
// Access-Control-Allow-Origin: * while the proxy sends none
// (and rejects any address but the session's).
//
// If the .m3u8 cannot be fetched from Vercel (403), this returns a
// JSON diagnostic instead of a playlist, so the site can fall back
// to opening the feed on the source site.

const LANGS = ["tamil", "telugu", "malayalam", "kannada", "hindi"];
const PLAYER = "https://stream2.zoloj.com/player?lang=";
const STREAM = "https://stream2.zoloj.com/stream/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// The player page only answers (200) when the Referer is an allowed
// article domain (kollypress.com is one). A plain/foreign Referer 403s.
const ARTICLE_REFERER =
  "https://kollypress.com/respectful-celebrity-coverage/";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function rewriteManifest(text, base) {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // AES key URI (if present): #EXT-X-KEY:...,URI="..."
      if (t.startsWith("#EXT-X-KEY")) {
        return line.replace(/URI="([^"]+)"/, (m, u) => {
          if (/^https?:\/\//i.test(u)) return m;
          return 'URI="' + new URL(u, base).toString() + '"';
        });
      }
      if (t.startsWith("#")) return line;
      // A playlist/segment URI: make relative ones absolute.
      let url = t;
      if (!/^https?:\/\//i.test(url)) url = new URL(url, base).toString();
      // zoloj serves its segments through a /seg proxy that is
      // tied to the session (a different address gets 403), and
      // it sends no CORS header — so a browser on another site
      // cannot fetch them. The proxy's `u` parameter is the real
      // segment on the broadcaster's own CDN (Hotstar), which DOES
      // send Access-Control-Allow-Origin: *. Point the player
      // straight at that address instead of the proxy.
      try {
        const u = new URL(url);
        if (
          u.hostname === "stream2.zoloj.com" &&
          u.pathname === "/seg" &&
          u.searchParams.get("u")
        ) {
          return u.searchParams.get("u");
        }
      } catch {}
      return url;
    })
    .join("\n");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const lang = String(req.query.lang || "").toLowerCase();
  if (!LANGS.includes(lang)) {
    return res.status(400).json({ error: "Invalid lang" });
  }
  const debug = req.query.debug === "1";
  const playerUrl = PLAYER + lang;
  const streamBase = STREAM + lang + ".m3u8";
  try {
    // 1. Player page — gets the fresh session sid (and cookie).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const pr = await fetch(playerUrl, {
      headers: { "User-Agent": UA, Referer: ARTICLE_REFERER },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const playerText = await pr.text();
    const sidMatch = playerText.match(/sid=([0-9a-f]{64})/);
    const sid = sidMatch ? sidMatch[1] : null;
    const cookie = pr.headers.get("set-cookie") || "";
    if (!pr.ok || !sid) {
      const diag = {
        error: "player failed",
        playerStatus: pr.status,
        sid: null,
        m3u8Status: null,
      };
      if (debug) return res.status(200).json(diag);
      return res.status(502).json(diag);
    }
    // 2. The .m3u8, with the sid and the session cookie.
    const m3u8Url = `${streamBase}?sid=${sid}`;
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 20000);
    const headers = {
      "User-Agent": UA,
      Referer: playerUrl,
    };
    if (cookie) headers.Cookie = cookie.split(";")[0];
    const mr = await fetch(m3u8Url, { headers, signal: c2.signal });
    clearTimeout(t2);
    const manifest = await mr.text();
    const diag = {
      playerStatus: pr.status,
      sid: sid.slice(0, 12) + "...",
      m3u8Status: mr.status,
      manifestSample: manifest.slice(0, 300),
      cors: mr.headers.get("access-control-allow-origin") || null,
    };
    if (debug) return res.status(200).json(diag);
    if (!mr.ok || !manifest.includes("#EXTM3U")) {
      return res.status(502).json({
        error: "m3u8 failed",
        ...diag,
        manifestSample: manifest.slice(0, 120),
      });
    }
    const rewritten = rewriteManifest(manifest, m3u8Url);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(rewritten);
  } catch (e) {
    return res.status(502).json({ error: "Upstream error", detail: String(e && e.message ? e.message : e) });
  }
}
