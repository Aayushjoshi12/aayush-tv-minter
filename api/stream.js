// vercel-stream.js — Vercel serverless minter for Aayush TV (free Hobby tier).
//
// Deploy as api/stream.js in a Vercel project (imported from a Git repo).
// WHY: GitHub Pages has no server, so it cannot call techjail's
// getlink.php itself (no CORS headers on getlink.php). This function
// runs on Vercel's free tier, calls getlink.php from Vercel's network,
// and returns the stream URL as JSON with CORS open, so the Pages
// site can call it from the browser.
//
// ENDPOINT: GET https://<project>.vercel.app/api/stream?id=<techjail id>
//   -> 200 {"url": "http://202.166.192.x/.../playlist.m3u8"} on success
//   -> 400 on invalid id, 502 if getlink.php fails or is blocked
//
// SAFETY: only calls getlink.php (a public, unauthenticated endpoint
// the Android app itself calls). No secrets, no shell, no storage.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const id = req.query.id;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  // FIX 2026-11-12: huritv9/getlink.php is gone (http 301 -> https 404
  // "File not found"), so the minter returned "Upstream failed" for
  // every channel. huritv8/getlink.php still returns a live signed
  // .m3u8, so use that. (Techjail's own homepage is empty; the
  // service appears to have moved/renamed the endpoint.)
  const target = `https://tv.techjail.net/huritv8/getlink.php?vv=1&CHID=${id}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Referer: "http://tv.techjail.net/v9x9/",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = (await r.text()).trim();
    if (!r.ok || !text.startsWith("http")) {
      return res.status(502).json({ error: "Upstream failed" });
    }
    return res.status(200).json({ url: text });
  } catch {
    return res.status(502).json({ error: "Upstream error" });
  }
}
