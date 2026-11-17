// api/npltest.js — ONE-OFF diagnostic for a permanent NPL feed (17 Nov 2026).
//
// QUESTION: can Vercel itself fetch the huritv8 stream (mint + manifest +
// segment), so the site can serve the NPL video over https through a
// Vercel proxy instead of the expiring 1xBet direct link or the plain-
// http minter URL? The 403 seen from this VM may be IP-binding or a
// data-centre block — this test answers it from Vercel's network.
//
// ENDPOINT: GET /api/npltest?id=1412
//   -> 200 {"minted": "...", "master": {...}, "variant": {...}, "segment": {...}}
// DELETE THIS FILE once the answer is known (it is a diagnostic, not a feature).

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

async function fetchText(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://aayushlife.live/" },
      signal: controller.signal,
    });
    const text = await r.text();
    return { status: r.status, bytes: text.length, head: text.slice(0, 300) };
  } catch (e) {
    return { status: 0, bytes: 0, head: "fetch error: " + (e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const id = req.query.id || "1412";
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid id" });

  // 1. Mint, exactly like api/stream.js.
  let minted;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const r = await fetch(`https://tv.techjail.net/huritv8/getlink.php?vv=1&CHID=${id}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Referer: "http://tv.techjail.net/v9x9/",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    minted = (await r.text()).trim();
    if (!r.ok || !minted.startsWith("http")) {
      return res.status(502).json({ error: "Mint failed", mintStatus: r.status });
    }
  } catch (e) {
    return res.status(502).json({ error: "Mint error: " + (e && e.message ? e.message : e) });
  }

  const host = (() => { try { return new URL(minted).host; } catch { return "?"; } })();

  // 2. Fetch the master manifest.
  const master = await fetchText(minted, 15000);

  // 3. Find the first variant .m3u8 line in the master and fetch it.
  let variant = null;
  if (master.status === 200) {
    const line = master.head.split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#") && s.includes(".m3u8"));
    if (line) {
      const vurl = line.startsWith("http") ? line : new URL(line, minted).href;
      variant = await fetchText(vurl, 15000);
      variant.url = vurl.split("?")[0];
      // 4. First .ts segment in the variant.
      if (variant.status === 200) {
        const seg = variant.head.split("\n").map((s) => s.trim()).find((s) => s && !s.startsWith("#") && s.includes(".ts"));
        if (seg) {
          const surl = seg.startsWith("http") ? seg : new URL(seg, vurl).href;
          const s = await fetchText(surl, 15000);
          variant.segment = { status: s.status, bytes: s.bytes, url: surl.split("?")[0] };
        }
      }
    }
  }

  return res.status(200).json({
    mintedHost: host,
    master: { status: master.status, bytes: master.bytes, head: master.head },
    variant,
  });
}
