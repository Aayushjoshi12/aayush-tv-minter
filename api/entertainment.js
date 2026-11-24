// api/entertainment.js — TV Serials episode resolver (Freezod chain).
//
// Desi Tashan episode pages embed a Freezod player. The playable video is
// reached through a short server-side chain (verified end-to-end 24 Nov 2026):
//   1. Episode page (desitashan.su) -> getlink.php URL, carrying tokens
//      v (Part 1), part2 (Part 2), part3 (Part 3).
//   2. GET getlink.php with Referer: <episode URL> -> hidden `ve` token.
//      (getlink.php 403s without a desitashan.su Referer, so a direct
//      iframe embed from aayushlife.live cannot work.)
//   3. POST ve to https://go.freezod.com/published (Accept: application/json)
//      -> { target: <freezod.com article URL>, ve: <ve2> }.
//      (No further POST needed — media_meta works with just v + article URL.)
//   4. GET https://freezod.com/hls/media_meta.php?v=<part token>
//      &embed_url=<article URL>&type=player, Referer: <article URL>
//      -> { source: { file: "play.php?v=...&exp=...&sig=...", mimeType:
//      "video/mp4", title: "Part N <Show> <date>" },
//      tracks: [{ file: "subtitle.php?v=...&exp=...&sig=...", label:
//      "English", kind: "captions", srclang: "en" }] }.
//      The embed_url MUST be the article URL from step 3 — any other
//      embed_url (desitashan episode URL included) returns 403.
//   5. play.php 302-redirects to a Yandex Disk MP4 (mds.storage.yandex.net).
//      That host 403s ("Invalid Referer") on ANY Referer and serves the
//      video (206, ftypisom) only when NO Referer is sent. BUT the browser
//      cannot follow that redirect safely: play.php's 302 response carries
//      `Referrer-Policy: strict-origin-when-cross-origin` (Cloudflare),
//      which OVERRIDES the <video>'s referrerpolicy="no-referrer" for the
//      redirected request, so the browser sends `Referer: freezod.com` to
//      Yandex and gets 403 ("Unable to play media.", verified 24 Nov 2026).
//      FIX (24 Nov 2026): the resolver follows the play.php redirect
//      ITSELF (server-side, redirect:manual) and hands the browser the
//      final Yandex URL directly. The <video> then loads Yandex with
//      referrerpolicy="no-referrer" -> no Referer -> 206 -> plays.
//      (Yandex Disk signed links are shareable, not IP-bound — a URL
//      minted by one IP plays from another; verified by tap-test.)
//      The signed play URL expires in ~1h, the subtitle URL in ~24h, so
//      the page resolves fresh at click time and never caches URLs.
//
// GET /api/entertainment?url=<episode URL>&part=<1|2|3>
//   -> { "title": "...", "video": "https://mds.storage.yandex.net/...mp4...",
//        "playUrl": "https://freezod.com/hls/play.php?...",
//        "subtitles": [{ "label": "English", "url": "https://freezod.com/hls/subtitle.php?..." }],
//        "parts": [1,2,3], "part": 1 }
// GET /api/entertainment?sub=<encoded subtitle.php URL>
//   -> the VTT body (text/vtt), proxied because subtitle.php sends no
//      CORS header and a cross-origin <track> would be blocked.
// GET /api/entertainment?show=<category slug, e.g. star-plus/anupama>&page=<n>
//   -> { "show": "<slug>", "page": 1, "episodes": [{ "title", "url", "guid",
//        "date", "poster", "episode" }], "hasMore": true }
//      (parses the site's category page server-side; the page cannot fetch
//      it directly — no CORS header. 30 episodes per page.)
// On failure: { "error": "..." } with 502.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 5000;
const FREEZOD = "https://freezod.com";
const PUBLISHED = "https://go.freezod.com/published";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function json(res, status, obj) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function fetchText(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status + " from " + url);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, headers, timeoutMs) {
  return JSON.parse(await fetchText(url, headers, timeoutMs));
}

// Follow one redirect manually and return the Location URL (or the
// original URL if there is no redirect). Used for play.php -> Yandex:
// the browser must not follow that redirect itself (see step 5 note).
async function followRedirect(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: ctrl.signal,
    });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) return loc;
    if (r.ok) return url; // no redirect — return as-is
    throw new Error("HTTP " + r.status + " from " + url);
  } finally {
    clearTimeout(t);
  }
}

// Parse a category page into episode objects. The page carries the
// episode list twice: 10 featured "spotlight-item" cards (latest 10)
// and the paginated "card has-date" list (20 per page). We parse both,
// dedupe by guid, and keep page order (newest first).
function parseCategoryPage(html) {
  const eps = [];
  const seen = new Set();
  const blocks = html.match(/<article class="(?:spotlight-item|card has-date)"[^>]*>[\s\S]*?<\/article>/g) || [];
  for (const b of blocks) {
    const href = b.match(/<a href="(\/[^"]+\/([a-f0-9]{16})\/)"/);
    if (!href || seen.has(href[2])) continue;
    const epNum = b.match(/episode-number-card"[^>]*>Episode (\d+)</);
    const img = b.match(/<img src="([^"]+)"/);
    const date =
      b.match(/spotlight-date">([^<]+)</) ||
      b.match(/episode-date-card">[\s\S]*?(\d{1,2} \w+ \d{4})/);
    const title =
      b.match(/<h3>([^<]+)<\/h3>/) ||
      b.match(/<h3[^>]*><a[^>]*>([^<]+)<\/a><\/h3>/);
    if (!title) continue;
    seen.add(href[2]);
    eps.push({
      url: "https://www.desitashan.su" + href[1],
      guid: href[2],
      episode: epNum ? Number(epNum[1]) : null,
      poster: img
        ? img[1].startsWith("http")
          ? img[1]
          : "https://www.desitashan.su" + img[1]
        : "",
      date: date ? date[1].trim() : "",
      title: title[1].trim(),
    });
  }
  return eps;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }

  // --- Subtitle proxy: ?sub=<encoded subtitle.php URL> ---
  if (req.query.sub) {
    let subUrl = req.query.sub;
    try {
      subUrl = decodeURIComponent(subUrl);
    } catch (_) {}
    if (!/^https:\/\/freezod\.com\/hls\/subtitle\.php\?/.test(subUrl)) {
      return json(res, 400, { error: "bad sub url" });
    }
    try {
      const vtt = await fetchText(subUrl, {}, TIMEOUT_MS);
      cors(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(vtt);
    } catch (e) {
      return json(res, 502, { error: "subtitle fetch failed: " + e.message });
    }
  }

  // --- Show episodes: ?show=<category slug>&page=<n> ---
  // e.g. ?show=star-plus/anupama  or  ?show=bigg-boss-19  (page 1 default)
  if (req.query.show) {
    const slug = String(req.query.show).replace(/^\/+|\/+$/g, "");
    if (!/^[a-z0-9][a-z0-9\-\/]*[a-z0-9]$/.test(slug) || slug.includes("..")) {
      return json(res, 400, { error: "bad show slug" });
    }
    const pageNum = Math.max(1, Number(req.query.page) || 1);
    const catUrl =
      "https://www.desitashan.su/category/" +
      slug +
      (pageNum > 1 ? "/page/" + pageNum + "/" : "/");
    try {
      const html = await fetchText(catUrl, {});
      const episodes = parseCategoryPage(html);
      const hasMore = /\/page\/\d+\//.test(html) && /rel="next"|>Next</.test(html);
      return json(res, 200, { show: slug, page: pageNum, episodes, hasMore });
    } catch (e) {
      return json(res, 502, { error: "show fetch failed: " + e.message });
    }
  }

  // --- Episode resolve: ?url=<episode URL>&part=<1|2|3> ---
  const epUrl = req.query.url;
  if (!epUrl || !/^https?:\/\/(www\.)?desitashan\.(su|com\.in|net)\//.test(epUrl)) {
    return json(res, 400, { error: "url must be a Desi Tashan episode page" });
  }
  const part = [1, 2, 3].includes(Number(req.query.part)) ? Number(req.query.part) : 1;

  try {
    // 1. Episode page -> getlink.php URL with v/part2/part3 tokens.
    const page = await fetchText(epUrl, {});
    const glMatch = page.match(
      /freezod\.searchping\.com\/desitashan\/getlink\.php\?[^"'<>\s]+/
    );
    if (!glMatch) throw new Error("no getlink.php on episode page");
    const glUrl = "https://" + glMatch[0].replace(/&amp;/g, "&");
    const glParams = new URL(glUrl).searchParams;
    const tokens = {
      1: glParams.get("v"),
      2: glParams.get("part2"),
      3: glParams.get("part3"),
    };
    const parts = [1, 2, 3].filter((n) => tokens[n]);
    if (!tokens[part]) {
      return json(res, 404, { error: "part " + part + " not available", parts });
    }

    // 2. getlink.php (desitashan Referer) -> ve token.
    const glPage = await fetchText(glUrl, { Referer: epUrl });
    const veMatch = glPage.match(/name="ve" value="([^"]+)"/);
    if (!veMatch) throw new Error("no ve token in getlink.php");
    const ve = veMatch[1];

    // 3. POST ve -> article URL.
    const pubRes = await fetch(PUBLISHED, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Referer: "https://freezod.searchping.com/",
      },
      body: "ve=" + encodeURIComponent(ve),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!pubRes.ok) throw new Error("published HTTP " + pubRes.status);
    const pub = await pubRes.json();
    if (!pub.target) throw new Error("no target in published response");
    const articleUrl = pub.target;

    // 4. media_meta.php -> signed play.php + subtitles.
    const metaUrl =
      FREEZOD +
      "/hls/media_meta.php?v=" +
      encodeURIComponent(tokens[part]) +
      "&embed_url=" +
      encodeURIComponent(articleUrl) +
      "&type=player";
    const meta = await fetchJson(metaUrl, { Referer: articleUrl });
    if (!meta.source || !meta.source.file) throw new Error("no source in media_meta");
    const playUrl = FREEZOD + "/hls/" + meta.source.file;
    const subtitles = (meta.tracks || []).map((t) => ({
      label: t.label || "English",
      lang: t.srclang || "en",
      url: FREEZOD + "/hls/" + t.file,
    }));

    // 5. Follow the play.php -> Yandex redirect server-side (see note
    // above) so the browser loads the final MP4 directly, with no
    // Referer, instead of following a redirect that would attach one.
    let video = playUrl;
    try {
      video = await followRedirect(playUrl);
    } catch (_) {
      // If the redirect read fails, fall back to the play.php URL.
    }

    return json(res, 200, {
      title: meta.source.title || "",
      video,
      playUrl,
      subtitles,
      parts,
      part,
    });
  } catch (e) {
    return json(res, 502, { error: "resolve failed: " + e.message });
  }
};
