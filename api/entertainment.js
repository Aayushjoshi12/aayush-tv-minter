// api/entertainment.js — TV Serials episode resolver (Freezod chain).
//
// Desi Tashan episode pages embed a Freezod player. The playable video is
// reached through a short server-side chain (verified end-to-end 24 Nov 2026):
//   1. Episode page (desitashan.su) -> getlink.php URL, carrying tokens
//      v (Part 1), part2, part3, ... partN. Most episodes have 3 parts,
//      but long ones have more (Bigg Boss 20: 7 parts, KBC 17: 5 —
//      verified 25 Nov 2026). The resolver reads every partN param
//      instead of assuming 3, and returns the full parts list.
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
// GET /api/entertainment?url=<episode URL>&part=<n> (n = any part the source offers)
//   -> { "title": "...", "video": "https://mds.storage.yandex.net/...mp4...",
//        "playUrl": "https://freezod.com/hls/play.php?...",
//        "subtitles": [{ "label": "English", "url": "https://freezod.com/hls/subtitle.php?..." }],
//        "parts": [1,2,3], "part": 1 }   // parts = full list the source offers
// GET /api/entertainment?sub=<encoded subtitle.php URL>
//   -> the VTT body (text/vtt), proxied because subtitle.php sends no
//      CORS header and a cross-origin <track> would be blocked.
// GET /api/entertainment?show=<category slug, e.g. star-plus/anupama>&page=<n>
//   -> { "show": "<slug>", "page": 1, "episodes": [{ "title", "url", "guid",
//        "date", "poster", "episode" }], "hasMore": true }
//      (tries the site's own ajax_posts.php API first, falls back to
//      parsing the category page server-side; the page cannot fetch
//      either directly — no CORS header. 30 episodes per page.)
// On failure: { "error": "..." } with 502.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 8000; // per-fetch timeout (raised 25 Nov 2026 from 5000:
// desitashan/freezod occasionally take >5s from Vercel, aborting the
// whole resolve with "This operation was aborted" — intermittent
// playback failures. 8s leaves room for one slow step while the
// 5-step chain normally stays under Vercel Hobby's 10s limit.)
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

  // --- Video Range proxy: ?video=<encoded Yandex MP4 URL> ---
  // The Yandex host returns `Content-Disposition: attachment` (and 403s
  // on ANY Referer), which makes a browser <video> fail with
  // "Unable to play media" even though the bytes are a valid MP4.
  // This proxy re-serves the same bytes with clean headers so the
  // <video> element can play them: Content-Type video/mp4, no
  // Content-Disposition, proper Range support. The browser's own Range
  // header is forwarded (capped to 2 MB per response so no single
  // serverless invocation streams a whole ~80 MB file). Only Yandex
  // Disk URLs are accepted, so this cannot be used as an open proxy.
  if (req.query.video) {
    let videoUrl = req.query.video;
    try {
      videoUrl = decodeURIComponent(videoUrl);
    } catch (_) {}
    let host = "";
    try {
      host = new URL(videoUrl).hostname;
    } catch (_) {}
    if (host !== "mds.storage.yandex.net") {
      return json(res, 400, { error: "video url must be a Yandex Disk URL" });
    }
    const CHUNK = 2 * 1024 * 1024; // 2 MB max per response
    // Parse the incoming Range (e.g. "bytes=12345-" or "bytes=12345-99999").
    const inRange = req.headers.range || "";
    const rm = inRange.match(/bytes=(\d+)-(\d*)/);
    const start = rm ? Number(rm[1]) : 0;
    const end = rm && rm[2] !== "" ? Number(rm[2]) : start + CHUNK - 1;
    const cappedEnd = Math.min(end, start + CHUNK - 1);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      let up;
      try {
        up = await fetch(videoUrl, {
          headers: { "User-Agent": UA, Range: "bytes=" + start + "-" + cappedEnd },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (!up.ok && up.status !== 206) {
        return json(res, 502, { error: "upstream HTTP " + up.status });
      }
      // Work out the total size from Content-Range ("bytes a-b/total").
      const upRange = up.headers.get("content-range") || "";
      const tm = upRange.match(/\/(\d+)\s*$/);
      const total = tm ? Number(tm[1]) : null;
      const buf = Buffer.from(await up.arrayBuffer());
      const realEnd = start + buf.length - 1;
      cors(res);
      res.statusCode = 206;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(buf.length));
      if (total !== null) {
        res.setHeader("Content-Range", "bytes " + start + "-" + realEnd + "/" + total);
      }
      res.setHeader("Cache-Control", "no-store");
      return res.end(buf);
    } catch (e) {
      return json(res, 502, { error: "video proxy failed: " + e.message });
    }
  }

  // --- Latest episodes: ?latest=1 ---
  // Returns the freshest 50 episodes straight from the live RSS feed,
  // so the page always shows new episodes without any scheduled job or
  // file update. The feed has no episode numbers, so they are taken
  // from the homepage's episode cards (guid -> number); the episode
  // page itself is NOT used for numbers (its first episode-number
  // belongs to a "latest episodes" sidebar, so every show would
  // inherit the newest show's number). If a number cannot be found
  // it stays null (the page handles null).
  if (req.query.latest) {
    try {
      const feedXml = await fetchText("https://www.desitashan.su/feed.xml", {});
      const items = [...feedXml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
      if (!items.length) return json(res, 502, { error: "feed empty" });
      // Homepage guid -> episode number map (cards only).
      let numbers = {};
      try {
        const home = await fetchText("https://www.desitashan.su/", {});
        const blocks = home.match(/<article class="(?:spotlight-item|card has-date)"[^>]*>[\s\S]*?<\/article>/g) || [];
        for (const b of blocks) {
          const href = b.match(/<a href="\/[^"]+\/([a-f0-9]{16})\/"/);
          const num = b.match(/episode-number-card"[^>]*>Episode (\d+)</);
          if (href && num) numbers[href[1]] = Number(num[1]);
        }
      } catch (_) { /* numbers stay empty; episodes get null */ }
      const episodes = [];
      for (const it of items) {
        const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
        const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
        const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
        const thumb = (it.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || "";
        const tm = title.match(/^(.*?) (\d{1,2})(?:st|nd|rd|th) (\w+) (\d{4}) Full Episode \| (.+)$/);
        const gm = link.match(/\/([a-f0-9]{16})\/?$/);
        if (!tm || !gm) continue;
        episodes.push({
          channel: tm[5].trim(),
          date: tm[2] + " " + tm[3] + " " + tm[4],
          episode: numbers[gm[1]] != null ? numbers[gm[1]] : null,
          guid: gm[1],
          link: link.trim(),
          poster: thumb,
          pubDate: pub.trim(),
          show: tm[1].trim(),
        });
      }
      if (!episodes.length) return json(res, 502, { error: "feed parsed to zero episodes" });
      return json(res, 200, {
        episodes: episodes.slice(0, 50),
        generated_at: new Date().toISOString(),
        source: "https://www.desitashan.su/feed.xml",
      });
    } catch (e) {
      return json(res, 502, { error: "latest fetch failed: " + e.message });
    }
  }

  // --- Show episodes: ?show=<category slug>&page=<n> ---
  // e.g. ?show=star-plus/anupama  or  ?show=bigg-boss-19  (page 1 default)
  // Automatic (26 Nov 2026): the site's own API (ajax_posts.php) is tried
  // first — it returns a show's episode cards as JSON, no page scrape
  // needed. It only answers for channels and brand-new shows, though
  // (tested live 26 Nov: star-plus, dil-ki-bewafaiyaan and
  // kyunki-rishton-ke-bhi-roop-badalte-hai answer; anupama, kumkum-bhagya,
  // yeh-rishta-kya-kehlata-hai, jhanak come back empty), so the category
  // page is the fallback and keeps every show working.
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
      let episodes = [];
      let hasMore = false;
      // 1) Site's own API (last slug segment — the API's categories are
      //    flat: "star-plus", "dil-ki-bewafaiyaan", not "star-plus/anupama").
      //    Short timeout so a slow API still leaves room for the fallback
      //    inside Vercel Hobby's 10s limit.
      try {
        const apiSlug = slug.split("/").pop();
        const api = await fetchJson(
          "https://www.desitashan.su/ajax_posts.php?category=" +
            encodeURIComponent(apiSlug) +
            "&page=" +
            pageNum,
          {},
          4000
        );
        if (api && typeof api.posts === "string" && !api.posts.includes("empty-state")) {
          episodes = parseCategoryPage(api.posts);
          const pag = typeof api.pagination === "string" ? api.pagination : "";
          hasMore = /\/page\/\d+\//.test(pag) && /rel="next"|>Next</.test(pag);
        }
      } catch (_) { /* API missed — fall through to the page scrape */ }
      // 2) Fallback: scrape the category page (works for every show).
      if (!episodes.length) {
        const html = await fetchText(catUrl, {});
        episodes = parseCategoryPage(html);
        hasMore = /\/page\/\d+\//.test(html) && /rel="next"|>Next</.test(html);
      }
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
  const part = Math.max(1, Number(req.query.part) || 1);

  try {
    // 1. Episode page -> getlink.php URL with v/part2/.../partN tokens.
    const page = await fetchText(epUrl, {});
    const glMatch = page.match(
      /freezod\.searchping\.com\/desitashan\/getlink\.php\?[^"'<>\s]+/
    );
    if (!glMatch) throw new Error("no getlink.php on episode page");
    const glUrl = "https://" + glMatch[0].replace(/&amp;/g, "&");
    const glParams = new URL(glUrl).searchParams;
    // v = Part 1; part2..partN = the rest. Read every partN param the
    // source offers (most episodes: 3; Bigg Boss 20: 7; KBC 17: 5).
    const tokens = { 1: glParams.get("v") };
    for (let n = 2; n <= 20; n++) {
      const t = glParams.get("part" + n);
      if (t) tokens[n] = t;
    }
    const parts = Object.keys(tokens).map(Number).sort((a, b) => a - b);
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
