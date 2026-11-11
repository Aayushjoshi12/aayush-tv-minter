// resolve-movie.js — Azure Functions (Node.js v4) build of the movie resolver.
// Same logic as api/resolve-movie.js on Vercel; only the HTTP wiring differs.
// Deployed to a SEPARATE Function App (aayush-tv-movies) — never to the
// techjail minter (aayush-tv-minter-kr). Auth level is Anonymous so the
// public site can call it. Endpoint: GET /api/resolve-movie?...
//
// Deploy as api/resolve-movie.js next to api/resolve.js (same Vercel-style
// serverless handler, same CORS-open pattern).
//
// THREE SOURCES, in order (per the user's instruction — primary +
// backups, all found by reverse-engineering):
//   PRIMARY — net52.cc/pv (the user's actual NetMirror link).
//     A Prime Video mirror app. Its catalogue comes from its own PHP
//     backend (homepage.php / search.php / post.php / mini-modal-info),
//     its titles use internal 27-char ids (NOT TMDB ids), and its
//     video is real HLS (.m3u8) with multi-audio and subtitles.
//   SECOND — LokLok mobile API (ga-mobile-api.loklok.tv/cms/app).
//     Found 2026-11-11 by RE'ing the NetMirror Android APK (v3.0.1,
//     com.streamhub.streamhub_app) with REA/JADX: the app's own video
//     backend is the aoneroom H5 API, which needs a per-device token
//     (not cracked), but the same catalogue is served by LokLok's
//     mobile API with NO token — only three static headers. Call shape
//     from the open-source filmhot site (phongna07/filmhot).
//     Akamai 403-blocks data-centre IPs from this VM, so reachability
//     must be verified live from Vercel/Azure (see ?loklok= / ?lokplay=).
//   BACKUP — net79.cc / net27.cc / netmirrors.vip (the Astro NetMirror).
//     Catalogue from TMDB, video via /api/embed-tmdb as direct signed
//     .mp4 streams (360p-2160p, ~9h expiry, no DRM, CORS *).
//
// WHY A SERVER IS NEEDED:
//   - The Astro API sends no Access-Control-Allow-Origin header, so a
//     browser cannot call it directly.
//   - net52's master manifest is hotlink-protected: it only answers
//     when the request carries Referer: https://net52.cc/pv/ and NO
//     Origin header (a browser on aayushlife.live always sends an
//     Origin, and gets 403/404). Everything downstream of the manifest
//     — the variant/audio manifests and segments on freecdn4.top —
//     is openly accessible and loads fine with an Origin (verified
//     2026-11-11). So this resolver fetches the master manifest
//     server-side (with the right Referer, no Origin) and serves it
//     back with CORS *; the browser's hls.js then fetches the
//     variants and segments directly from freecdn4.top. Only the tiny
//     manifest (~4KB) passes through Vercel — no video bandwidth.
//   - The video CDN for the Astro mp4s rate-limits data-centre IPs
//     (429), so mp4 links are NOT validated server-side here; the
//     visitor's browser fetches them from a residential IP.
//
// HOW NET52 WORKS (reverse-engineered 2026-11-11):
//   - GET /pv/homepage.php?p=movie|show -> {slider: [{id, title, img,
//     desc, ua, namelogo}], post: [{cate, ids: "id1,id2,..."}]}.
//   - GET /pv/search.php?s=<query> -> {searchResult: [{id, t, y, r}]}.
//   - GET /pv/mini-modal-info.php?id=<id> -> {title, ua, year, desc,
//     runtime}. (Posters need no call: https://imgcdn.kim/pv/341/<id>.jpg)
//   - GET /pv/post.php?id=<id> -> full details + episodes[] (each
//     episode has its own id) + suggest[] for TV series.
//   - GET /pv/playlist.php?id=<id>&tm=<Date.now() ms> -> [{sources:
//     [{file, label, type}], tracks: [{kind, file, label}]}]. The
//     sources are /pv/hls/<id>.m3u8[?q=1080p|720p|480p]&in=::<token>
//     ::<epoch>::su::F2 — Auto, Full HD, Mid HD (default), Low HD.
//     Subtitles are .srt files on pv.subscdn.top (CORS *).
//   - The app appends &t=<Timestamp> (a localStorage ms timestamp) to
//     most calls; the server accepts a fresh Date.now() (verified).
//
// HOW THE ASTRO BACKUP WORKS (reverse-engineered 2026-11-11):
//   - GET /api/catalog/hero, /api/catalog/trending?window=day|week,
//     /api/catalog/search-hybrid?q= -> items with real TMDB ids.
//   - GET /api/embed-tmdb/<tmdbId>?type=movie|tv&se=&ep= -> signed
//     .mp4 streams + captions (served through the mirror's proxy).
//   - The home rails (/api/catalog/aoneroom-home) carry tmdbId 0 for
//     every item, so they cannot feed the embed endpoint and are NOT
//     used. The mirror domain rotates (net77.cc was Cloudflare-
//     challenged on 11 Nov 2026); the resolver tries each in order.
//
// ENDPOINT: GET /api/resolve-movie
//   NET52 (primary):
//   ?home=movie|show          -> 200 {"ok": true, "source": "net52",
//                               "featured": [{id,title,year,poster,desc,img}],
//                               "rows": [{name, items: [{id, poster}]}]}
//                               (titles for rows come via ?info= below)
//   ?q=<query>                -> 200 {"ok": true, "source": "net52",
//                               "items": [{id,title,year,runtime,poster}]}
//   ?info=<id1>,<id2>,...     -> 200 {"ok": true, "items": [{id,title,
//                               year,runtime,type}]} (max 20 ids)
//   ?detail=<id>              -> 200 {"ok": true, ...post.php fields,
//                               "episodes": [{id,t,s,ep,time,r_date}],
//                               "suggest": [{id}]}
//   ?play=<id>&title=<title>  -> 200 {"ok": true, "source": "net52",
//                               "kind": "hls", "manifestUrl": "<resolver
//                               manifest proxy URL for the Auto stream>",
//                               "qualities": [{label,resolution,manifestUrl}],
//                               "tracks": [{label,lang,url}]}
//                               If net52 has no sources and a title was
//                               given, it falls back to the Astro backup
//                               (below) and returns kind "mp4" instead.
//   ASTRO (backup):
//   ?hero=1 | ?trending=day|week | ?aq=<query>
//                            -> 200 {"ok": true, "source": "netmirror",
//                               "items": [{tmdbId,type,title,year,poster,
//                               backdrop,rating,overview}]}
//   ?embed=<tmdbId>&type=movie|tv&se=<n>&ep=<n>
//                            -> 200 {"ok": true, "source": "netmirror",
//                               "kind": "mp4", "title", "year", "type",
//                               "streams": [{url,resolution,size}],
//                               "captions": [{lang,name,url}], "noSource",
//                               "error"}
//   SHARED:
//   ?manifest=<urlencoded net52 .m3u8 URL>
//                            -> 200 the master manifest (CORS *, m3u8
//                              content-type). Only net52 /pv/hls/ URLs.
//   ?sub=<urlencoded absolute .srt URL>
//                            -> 200 the subtitle converted SRT -> VTT
//                              (text/vtt, CORS *), so <track> can load it.
//   -> 400 on a missing/unknown mode. 502 when every upstream fails.
//
// SAFETY: only fetches public, unauthenticated catalogue, detail,
// playlist and manifest endpoints. No secrets, no shell, no storage.
// Returned URLs are time-limited and only ever sent to the user's own
// browser.

const NET52_BASES = [
  "https://net52.cc/pv",
  "https://pcmirror.cc/pv",
];
const NET52_REFERER = "https://net52.cc/pv/";
const NET52_IMG = "https://imgcdn.kim/pv/341/";

const ASTRO_MIRRORS = [
  "https://net79.cc",
  "https://net27.cc",
  "https://netmirrors.vip",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function fetchWithTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

let SELF_URL = "https://aayush-tv-movies-geesc6d8g6fchvfk.koreacentral-01.azurewebsites.net/api/resolve-movie";
const selfUrl = () => SELF_URL;

// ---------- net52 (primary) ----------

async function net52Get(path) {
  // Try each net52 base in order until one answers with 200 JSON.
  // One retry per base: net52 occasionally drops a request when
  // several arrive at once (transient 502s seen 2026-11-11).
  // Returns {base, data} so callers can resolve relative URLs
  // against the base that actually answered.
  let lastError = null;
  for (const base of NET52_BASES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(
          base + path,
          { "User-Agent": UA, Referer: NET52_REFERER },
          12000
        );
        if (!res.ok) {
          lastError = new Error(`${base} ${res.status}`);
          break;
        }
        return { base, data: await res.json() };
      } catch (e) {
        lastError = e;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }
  throw lastError || new Error("net52 failed");
}

const net52Poster = (id) => `${NET52_IMG}${id}.jpg`;

async function net52Home(kind) {
  const { data } = await net52Get(
    `/homepage.php?p=${kind === "show" ? "show" : "movie"}&t=${Date.now()}`
  );
  const featured = await Promise.all(
    (data.slider || []).map(async (s) => {
      // The slider carries no text title (it shows a logo image),
      // so resolve the title the same way the app does for a card.
      let title = "";
      try {
        const { data: info } = await net52Get(
          `/mini-modal-info.php?id=${s.id}&t=${Date.now()}`
        );
        title = info.title || "";
      } catch {
        // Title stays blank; the poster still shows.
      }
      return {
        id: s.id,
        title,
        year: "",
        poster: net52Poster(s.id),
        desc: s.desc || "",
        img: s.img || "",
      };
    })
  );
  const rows = (data.post || []).map((r) => ({
    name: r.cate || "",
    items: (r.ids || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((id) => ({ id, poster: net52Poster(id) })),
  }));
  return { ok: true, source: "net52", featured, rows };
}

async function net52Search(query) {
  const { data } = await net52Get(
    `/search.php?s=${encodeURIComponent(query)}&t=${Date.now()}`
  );
  const items = (data.searchResult || []).map((r) => ({
    id: r.id,
    title: r.t || "",
    year: r.y || "",
    runtime: r.r || "",
    poster: net52Poster(r.id),
  }));
  return { ok: true, source: "net52", items };
}

async function net52Info(ids) {
  const list = ids.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  const items = await Promise.all(
    list.map(async (id) => {
      try {
        const { data: d } = await net52Get(
          `/mini-modal-info.php?id=${id}&t=${Date.now()}`
        );
        return {
          id,
          title: d.title || "",
          year: d.year || "",
          runtime: d.runtime || "",
          type: "",
        };
      } catch {
        return { id, title: "", year: "", runtime: "", type: "" };
      }
    })
  );
  return { ok: true, items };
}

async function net52Detail(id) {
  const { data: d } = await net52Get(`/post.php?id=${id}&t=${Date.now()}`);
  return {
    ok: true,
    source: "net52",
    id,
    title: d.title || "",
    year: d.year || "",
    type: d.type || "",
    ua: d.ua || "",
    match: d.match || "",
    runtime: d.runtime || "",
    hdsd: d.hdsd || "",
    d_lang: d.d_lang || "",
    desc: d.desc || d.m_desc || "",
    genre: d.genre || "",
    cast: d.cast || d.short_cast || "",
    director: d.director || "",
    poster: net52Poster(id),
    episodes: (d.episodes || []).filter(Boolean).map((e) => ({
      id: e.id,
      title: e.t || "",
      season: e.s || "",
      episode: e.ep || "",
      desc: e.ep_desc || "",
      time: e.time || "",
      date: e.r_date || "",
    })),
    suggest: (d.suggest || []).filter(Boolean).map((s) => ({
      id: s.id,
      poster: net52Poster(s.id),
    })),
  };
}

async function net52Play(id) {
  // Returns null when net52 has no sources for this id.
  // playlist.php builds a .m3u8 URL for ANY id, even a bogus one
  // (verified 2026-11-11: a garbage id still got a signed URL), so
  // the answer is only trusted when the master manifest itself
  // loads — the manifest is fetched from net52.cc, which answers
  // data-centre IPs fine (unlike the Astro video CDN), so this
  // check is reliable here.
  //
  // Try each base in turn and keep the first one whose manifest is
  // actually playable. The two bases serve different CDNs:
  // net52.cc serves freecdn4.top (reachable), pcmirror.cc serves
  // nm-cdn2.top, whose hosts refuse connections (verified
  // 2026-11-11: s15.nm-cdn2.top resolves but TCP/TLS fails, HTTP
  // 000, while freecdn4.top answers 200). A pcmirror manifest is
  // therefore unusable, so it is skipped and the other base tried.
  const tm = Date.now();
  for (const base of NET52_BASES) {
    let data;
    try {
      const res = await fetchWithTimeout(
        `${base}/playlist.php?id=${id}&tm=${tm}`,
        { "User-Agent": UA, Referer: NET52_REFERER },
        12000
      );
      if (!res.ok) continue;
      data = await res.json();
    } catch {
      continue;
    }
    const first = Array.isArray(data) ? data[0] : null;
    const sources = (first && first.sources) || [];
    if (!sources.length) continue;
    // The playlist's file paths are root-relative ("/pv/hls/…"), so
    // they resolve against the base's origin, not the full base —
    // the base itself already ends in "/pv", and joining it directly
    // would double it to "/pv/pv/hls/…" (a 404).
    const origin = new URL(base).origin;
    const abs = (file) =>
      file.startsWith("http") ? file : `${origin}${file}`;
    const qualities = sources
      .map((s) => {
        const url = abs(s.file);
        const m = /[?&]q=(\d+)p/.exec(url);
        return {
          label: s.label || "",
          resolution: m ? parseInt(m[1], 10) : 0,
          manifestUrl: `${selfUrl()}?manifest=${encodeURIComponent(url)}`,
        };
      })
      .sort((a, b) => a.resolution - b.resolution);
    const auto =
      qualities.find((q) => q.resolution === 0) || qualities[0];
    // Validate the Auto manifest before trusting the answer.
    // (A garbage id still gets a manifest, but it is a template:
    // its audio URI has an empty host — "https:///files/<id>/a/…" —
    // while a real manifest points at a real CDN host and carries
    // this title's id in the audio path. So the check requires a
    // real host AND this id in the audio URI. It also requires the
    // manifest's media to sit on a reachable CDN — freecdn4.top —
    // and rejects a manifest served only from nm-cdn2.top.)
    let valid = false;
    let masterText = "";
    try {
      const target = decodeURIComponent(
        new URL(auto.manifestUrl).searchParams.get("manifest")
      );
      const host = /^https:\/\/(net52\.cc|pcmirror\.cc)\//.exec(target);
      const referer = host ? `https://${host[1]}/pv/` : NET52_REFERER;
      const r = await fetchWithTimeout(
        target,
        { "User-Agent": UA, Referer: referer },
        10000
      );
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.startsWith("#EXTM3U")) continue;
      const hasRealAudio =
        text.includes("/" + id + "/a/") && !text.includes("https:///");
      if (!hasRealAudio) continue;
      const usesReachableCdn = text.includes("freecdn4.top");
      const onlyUnreachableCdn =
        text.includes("nm-cdn2.top") && !usesReachableCdn;
      if (onlyUnreachableCdn) continue;
      valid = true;
      masterText = text;
    } catch {
      continue;
    }
    if (!valid) continue;
    // Slate check (2026-11-11): when the video site is throttling, it
    // serves the SAME 10-minute "STOP — Too Many Requests" clip for
    // every title — Dune and Project Hail Mary both point at file
    // 220884, whose 720p variant is 60 segments totalling 599.7s.
    // A real film is 90+ minutes, so a default variant shorter than
    // 20 minutes is a slate, not the film: reject it so the caller
    // falls back to the Astro backup instead of playing the warning.
    // NOTE: the playlist's quality entries all point at the SAME
    // master manifest (with a ?q= hint), so the variant URL must be
    // read out of the master manifest text itself, not from the
    // qualities list.
    try {
      const lines = masterText.split("\n");
      let vTarget = "";
      for (let i = 0; i < lines.length; i++) {
        if (
          lines[i].includes("#EXT-X-STREAM-INF") &&
          lines[i].includes("1280x720")
        ) {
          vTarget = (lines[i + 1] || "").trim();
          break;
        }
      }
      if (!vTarget) {
        // Fall back to the first variant URL in the master.
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("http")) {
            vTarget = lines[i].trim();
            break;
          }
        }
      }
      if (!vTarget) continue;
      const vr = await fetchWithTimeout(
        vTarget,
        { "User-Agent": UA, Referer: NET52_REFERER },
        10000
      );
      if (!vr.ok) continue;
      const vText = await vr.text();
      if (!vText.startsWith("#EXTM3U")) continue;
      let total = 0;
      for (const m of vText.matchAll(/#EXTINF:([\d.]+)/g)) {
        total += parseFloat(m[1]);
      }
      if (total > 0 && total < 1200) continue;
    } catch {
      continue;
    }
    const tracks = ((first && first.tracks) || [])
      .filter((t) => t && t.file)
      .map((t) => {
        const file = t.file.startsWith("http")
          ? t.file
          : `https:${t.file}`;
        return {
          label: t.label || "",
          lang: "",
          url: `${selfUrl()}?sub=${encodeURIComponent(file)}`,
        };
      });
    return {
      ok: true,
      source: "net52",
      kind: "hls",
      manifestUrl: auto.manifestUrl,
      qualities,
      tracks,
    };
  }
  return null;
}

// ---------- Astro backup (net79 / net27 / netmirrors.vip) ----------

async function astroFetch(path) {
  let lastError = null;
  for (const mirror of ASTRO_MIRRORS) {
    try {
      const res = await fetchWithTimeout(
        mirror + path,
        { "User-Agent": UA, Referer: mirror + "/" },
        12000
      );
      if (!res.ok) {
        lastError = new Error(`${mirror} ${res.status}`);
        continue;
      }
      return { mirror, data: await res.json() };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Astro failed");
}

function cleanItems(data) {
  const items = data.items || data.results || [];
  return items
    .filter((it) => it && it.tmdbId)
    .map((it) => ({
      tmdbId: it.tmdbId,
      type: it.type || "movie",
      title: it.title || "",
      year: it.year || "",
      poster: it.poster || "",
      backdrop: it.backdrop || "",
      rating: typeof it.rating === "number" ? it.rating : null,
      overview: it.overview || "",
    }));
}

async function astroEmbed(tmdbId, type, se, ep) {
  const { mirror, data } = await astroFetch(
    `/api/embed-tmdb/${tmdbId}?type=${type}&se=${se}&ep=${ep}`
  );
  const captions = (data.captions || [])
    .filter((c) => c && c.url)
    .map((c) => {
      const abs = c.url.startsWith("http") ? c.url : mirror + c.url;
      return {
        lang: c.lang || "",
        name: c.name || c.lang || "",
        url: `${selfUrl()}?sub=${encodeURIComponent(abs)}`,
      };
    });
  return {
    ok: true,
    source: "netmirror",
    kind: "mp4",
    title: data.title || "",
    year: data.year || "",
    type: data.type || type,
    poster: data.poster || "",
    expires: data.exp || null,
    noSource: !!data.noSource,
    error: data.error || null,
    streams: (data.streams || [])
      .filter((s) => s && s.url)
      .map((s) => ({
        url: s.url,
        resolution: s.resolution || 0,
        size: s.size || 0,
      }))
      .sort((a, b) => a.resolution - b.resolution),
    captions,
  };
}

// ---------- LokLok mobile API (no-token movie source) ----------
//
// Found 2026-11-11 by reverse-engineering the NetMirror Android APK
// (v3.0.1, package com.streamhub.streamhub_app, Flutter) with REA /
// JADX. The app's own video backend is the aoneroom H5 API
// (h5-api.aoneroom.com/wefeed-h5api-bff/subject/play), which needs a
// per-device token built inside the app's compiled Dart code — not
// cracked. BUT the same catalogue is served by LokLok's mobile API
// (ga-mobile-api.loklok.tv/cms/app), which needs NO token at all: only
// three static headers (lang, versioncode, clienttype). The call shape
// is taken from the open-source filmhot site (phongna07/filmhot),
// "a rapid movie website from the LokLok API":
//   POST search/v1/searchWithKeyWord {searchKeyWord, size:50, sort:"", searchType:""}
//     -> data.data.searchResults [{id, name, domainType (0=movie, 1=TV),
//        dramaType, releaseTime, ...}]
//   GET movieDrama/get?id=&category= (0=movie, 1=TV)
//     -> data.data {episodeVo: [{id, definitionList: [{code, description}],
//        subtitlingList: [{language, languageAbbr, subtitlingUrl}]}]}
//   GET media/previewInfo?category=&contentId=&episodeId=&definition=
//     -> data.data.mediaUrl (direct .mp4 / .m3u8)
// Akamai (edgesuite) 403-blocks data-centre IPs from this VM, so the
// API could NOT be verified from here — it must be verified live from
// Vercel/Azure. If the resolver host is blocked too, these functions
// return null and the Astro fallback still runs.
const LOKLOK_BASE = "https://ga-mobile-api.loklok.tv/cms/app";
const LOKLOK_HEADERS = {
  lang: "en",
  versioncode: "11",
  clienttype: "ios_jike_default",
};

async function loklokFetch(path, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${LOKLOK_BASE}${path}`, {
      headers: { ...LOKLOK_HEADERS, ...(opts.headers || {}) },
      signal: controller.signal,
      ...(opts.body ? { method: "POST", body: opts.body } : {}),
    });
    if (!res.ok) {
      // Surface the upstream status so the ?loklok= debug mode can
      // tell an Akamai 403 apart from a wrong response shape.
      return { __status: res.status, __body: (await res.text()).slice(0, 200) };
    }
    return await res.json();
  } catch (e) {
    return { __status: 0, __body: String((e && e.message) || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function loklokSearch(keyword) {
  const j = await loklokFetch("/search/v1/searchWithKeyWord", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      searchKeyWord: keyword,
      size: 50,
      sort: "",
      searchType: "",
    }),
  });
  const list =
    j && j.data && Array.isArray(j.data.searchResults)
      ? j.data.searchResults
      : [];
  return list;
}

// Raw search result (with upstream status) for the ?loklok= debug mode.
async function loklokSearchDebug(keyword) {
  const j = await loklokFetch("/search/v1/searchWithKeyWord", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      searchKeyWord: keyword,
      size: 50,
      sort: "",
      searchType: "",
    }),
  });
  return j;
}

async function loklokPlay(title, year) {
  // Returns a ?play=-shaped answer, or null when LokLok has nothing.
  const results = await loklokSearch(title);
  if (!results.length) return null;
  const norm = (s) => String(s || "").toLowerCase().trim();
  const yr = (r) =>
    r.releaseTime ? String(r.releaseTime).slice(0, 4) : "";
  let pick =
    results.find(
      (r) => norm(r.name) === norm(title) && (!year || yr(r) === year)
    ) ||
    results.find((r) => norm(r.name) === norm(title)) ||
    results[0];
  // If a year was given and the pick is a different year, do NOT play
  // the wrong film (same rule as the Astro fallback).
  if (year && yr(pick) && yr(pick) !== year) {
    const byYear = results.find(
      (r) => norm(r.name) === norm(title) && yr(r) === year
    );
    if (!byYear) return null;
    pick = byYear;
  }
  const category = pick.domainType === 0 ? 0 : 1;
  const detail = await loklokFetch(
    `/movieDrama/get?id=${encodeURIComponent(pick.id)}&category=${category}`
  );
  const d = detail && detail.data;
  const eps = d && Array.isArray(d.episodeVo) ? d.episodeVo : [];
  if (!eps.length) return null;
  const ep = eps[0];
  const defs = Array.isArray(ep.definitionList) ? ep.definitionList : [];
  if (!defs.length) return null;
  const sorted = [...defs].sort(
    (a, b) => (Number(b.code) || 0) - (Number(a.code) || 0)
  );
  const subs = (Array.isArray(ep.subtitlingList) ? ep.subtitlingList : [])
    .filter((s) => s && s.subtitlingUrl)
    .map((s) => ({
      language: s.language || s.languageAbbr || "",
      url: s.subtitlingUrl,
      lang: s.languageAbbr || "",
    }));
  for (const def of sorted) {
    const pv = await loklokFetch(
      `/media/previewInfo?category=${category}&contentId=${encodeURIComponent(
        pick.id
      )}&episodeId=${encodeURIComponent(ep.id)}&definition=${encodeURIComponent(
        def.code
      )}`
    );
    const url = pv && pv.data && pv.data.mediaUrl;
    if (url && /^https?:\/\//.test(url)) {
      const q = Number(String(def.description || "").replace(/[^0-9]/g, "")) || Number(def.code) || 0;
      if (/\.m3u8(\?|$)/i.test(url)) {
        return {
          ok: true,
          source: "loklok",
          kind: "hls",
          title: pick.name,
          year: yr(pick),
          manifestUrl: url,
          qualities: [{ label: def.description || String(def.code), resolution: q, manifestUrl: url }],
          captions: subs,
        };
      }
      return {
        ok: true,
        source: "loklok",
        kind: "mp4",
        title: pick.name,
        year: yr(pick),
        streams: [{ url, resolution: q }],
        captions: subs,
      };
    }
  }
  return null;
}

// ---------- subtitles ----------

function srtToVtt(srt) {
  const body = String(srt)
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return "WEBVTT\n\n" + body + "\n";
}

async function handleMovie(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const q = req.query;

  // --- Manifest proxy: fetch with the Referer the hotlink
  // protection requires and no Origin header, then serve the
  // manifest back with CORS * so hls.js can load it.
  //
  // The whole net52 chain is Referer-locked, not just the master
  // manifest: the variant (level) and audio manifests on
  // freecdn4.top / nm-cdn2.top ALSO require Referer net52.cc/pv/
  // (a browser on aayushlife.live gets 404, and the 404 carries
  // no CORS header, so hls.js sees a bare networkError with no
  // HTTP code — levelLoadError / audioTrackLoadError). The video
  // and audio SEGMENTS, by contrast, load fine (200, CORS *) with
  // the site's own Referer. So this proxy serves the master,
  // variant and audio manifests, and rewrites their URIs: nested
  // .m3u8 links become proxy URLs (so hls.js fetches them here,
  // with the right Referer), while segment names are made absolute
  // against the manifest's own CDN host (so the large segments
  // still load straight from the CDN — only the tiny manifests,
  // a few KB each, pass through Vercel; no video bandwidth).
  if (q.manifest) {
    try {
      const target = decodeURIComponent(q.manifest);
      const net52 = /^https:\/\/(net52\.cc|pcmirror\.cc)\/pv\/hls\/[A-Za-z0-9]+\.m3u8/.exec(target);
      const cdn = /^https:\/\/[a-z0-9.-]+\.(freecdn4\.top|nm-cdn2\.top)\/.+\.m3u8/.exec(target);
      if (!net52 && !cdn) {
        return res.status(400).json({ error: "Bad manifest URL" });
      }
      const referer = net52 ? `https://${net52[1]}/pv/` : "https://net52.cc/pv/";
      const r = await fetchWithTimeout(
        target,
        { "User-Agent": UA, Referer: referer },
        12000
      );
      if (!r.ok) {
        return res
          .status(502)
          .json({ error: "Manifest fetch failed", upstream: r.status });
      }
      const text = await r.text();
      if (!text.startsWith("#EXTM3U")) {
        return res.status(502).json({ error: "Not a manifest" });
      }
      // Sanitize: the CDN injects a non-standard TYPE attribute into
      // STREAM-INF lines (e.g. TYPE=2606:54c1:1:9ba::62:108 — an
      // IPv6-like value). It is not part of HLS and can trip strict
      // playlist parsers, so strip it before serving.
      let clean = text.replace(
        /^(#EXT-X-STREAM-INF:[^\n]*),TYPE=[^,\n]+/gm,
        "$1"
      );
      // Rewrite URIs. Nested .m3u8 links (variant + audio manifests)
      // go through this proxy; segment names are made absolute
      // against the manifest's own host so they load from the CDN.
      const self = selfUrl();
      const base = new URL(target);
      const toProxy = (u) =>
        `${self}?manifest=${encodeURIComponent(u)}`;
      const isCdnM3u8 = (u) =>
        /^https:\/\/[a-z0-9.-]+\.(freecdn4\.top|nm-cdn2\.top)\/.+\.m3u8/.test(u);
      clean = clean
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          // URI="..." attributes (EXT-X-MEDIA audio links, EXT-X-KEY).
          if (t.startsWith("#") && t.includes('URI="')) {
            return line.replace(
              /URI="(https:[^"]+\.m3u8[^"]*)"/g,
              (m, u) => (isCdnM3u8(u) ? `URI="${toProxy(u)}"` : m)
            );
          }
          if (t.startsWith("#")) return line;
          // Bare URI line: a variant manifest or a segment.
          if (/\.m3u8(\?|$)/.test(t)) {
            const abs = new URL(t, base).href;
            return isCdnM3u8(abs) ? toProxy(abs) : abs;
          }
          // A segment: make relative names absolute on the CDN host.
          if (!/^https?:\/\//.test(t)) return new URL(t, base).href;
          return line;
        })
        .join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(200).send(clean);
    } catch {
      return res.status(502).json({ error: "Manifest fetch failed" });
    }
  }

  // --- Subtitle proxy: fetch an SRT and serve VTT (<track> needs VTT).
  if (q.sub) {
    try {
      const target = decodeURIComponent(q.sub);
      if (
        !/^https:\/\/pv\.subscdn\.top\//.test(target) &&
        !/^https:\/\/(cacdn|bcdnxw)\.hakunaymatata\.com\//.test(target) &&
        !/^https:\/\/(net79|net27)\.cc\/api\/proxy\/video\?url=/.test(target) &&
        !/^https:\/\/netmirrors\.vip\/api\/proxy\/video\?url=/.test(target)
      ) {
        return res.status(400).json({ error: "Bad subtitle URL" });
      }
      const r = await fetchWithTimeout(target, { "User-Agent": UA }, 10000);
      if (!r.ok) return res.status(502).json({ error: "Subtitle fetch failed" });
      const srt = await r.text();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.status(200).send(srtToVtt(srt));
    } catch {
      return res.status(502).json({ error: "Subtitle fetch failed" });
    }
  }

  try {
    // --- net52 (primary) catalogue ---
    if (q.home) {
      return res.status(200).json(await net52Home(q.home));
    }
    if (q.q) {
      const query = String(q.q).trim();
      if (query.length < 2) {
        return res.status(400).json({ error: "Query too short" });
      }
      return res.status(200).json(await net52Search(query));
    }
    if (q.info) {
      return res.status(200).json(await net52Info(String(q.info)));
    }
    if (q.detail) {
      return res.status(200).json(await net52Detail(String(q.detail)));
    }

    // --- net52 (primary) playback, with Astro fallback ---
    if (q.play) {
      const id = String(q.play).trim();
      if (!/^[A-Za-z0-9]+$/.test(id)) {
        return res.status(400).json({ error: "Bad id" });
      }
      const primary = await net52Play(id).catch(() => null);
      if (primary) return res.status(200).json(primary);
      // Primary had no source (or failed): try LokLok next — the
      // no-token mobile API found by reverse-engineering the
      // NetMirror APK. Same catalogue as the app, direct video URLs.
      const title = String(q.title || "").trim();
      const year = String(q.year || "").trim();
      if (title.length >= 2) {
        const lok = await loklokPlay(title, year).catch(() => null);
        if (lok) return res.status(200).json(lok);
      }
      // Then fall back to the Astro backup by title. The Astro
      // catalogue is searched by the title the page passes, then
      // the first match is embedded.
      if (title.length >= 2) {
        try {
          const { data } = await astroFetch(
            `/api/catalog/search-hybrid?q=${encodeURIComponent(title)}`
          );
          const items = cleanItems(data);
          if (items.length) {
            // Prefer an exact title match (the search can return
            // a similarly-named show first, e.g. "Dune: Prophecy"
            // for "Dune"); otherwise take the first result. When
            // the page also passes a year, prefer the exact
            // title+year match — otherwise "Dune" can return the
            // 1984 film when the user tapped the 2021 one.
            let first = items.find(
              (it) => it.title.toLowerCase() === title.toLowerCase()
            ) || items[0];
            if (year) {
              const byYear = items.find(
                (it) =>
                  it.title.toLowerCase() === title.toLowerCase() &&
                  String(it.year) === year
              );
              // If the user tapped a specific year and the backup does
              // not carry that exact title+year, do NOT play a
              // different year's film (e.g. Dune 1984 for Dune 2021):
              // report no source instead of silently playing the
              // wrong movie.
              if (!byYear) {
                return res.status(200).json({
                  ok: true,
                  source: null,
                  kind: null,
                  noSource: true,
                  error: "No source found for this title.",
                });
              }
              first = byYear;
            }
            const emb = await astroEmbed(
              first.tmdbId,
              first.type,
              1,
              1
            );
            if (!emb.noSource && emb.streams.length) {
              return res.status(200).json(emb);
            }
          }
        } catch {
          // Fall through to the no-source answer below.
        }
      }
      return res.status(200).json({
        ok: true,
        source: null,
        kind: null,
        noSource: true,
        error: "No source found for this title.",
      });
    }

    // --- Astro (backup) catalogue ---
    if (q.hero) {
      const { data } = await astroFetch("/api/catalog/hero");
      return res.status(200).json({ ok: true, source: "netmirror", items: cleanItems(data) });
    }
    if (q.trending) {
      const window = q.trending === "week" ? "week" : "day";
      const { data } = await astroFetch(`/api/catalog/trending?window=${window}`);
      return res.status(200).json({ ok: true, source: "netmirror", items: cleanItems(data) });
    }
    if (q.aq) {
      const query = String(q.aq).trim();
      if (query.length < 2) {
        return res.status(400).json({ error: "Query too short" });
      }
      const { data } = await astroFetch(
        `/api/catalog/search-hybrid?q=${encodeURIComponent(query)}`
      );
      return res.status(200).json({ ok: true, source: "netmirror", items: cleanItems(data) });
    }
    if (q.embed) {
      const id = String(q.embed).trim();
      if (!/^\d+$/.test(id)) {
        return res.status(400).json({ error: "Bad id" });
      }
      const type = q.type === "tv" ? "tv" : "movie";
      const se = parseInt(q.se, 10) || 1;
      const ep = parseInt(q.ep, 10) || 1;
      return res.status(200).json(await astroEmbed(id, type, se, ep));
    }
    // --- LokLok (no-token) debug: search the LokLok catalogue ---
    if (q.loklok) {
      const query = String(q.loklok).trim();
      if (query.length < 2) {
        return res.status(400).json({ error: "Query too short" });
      }
      const raw = await loklokSearchDebug(query);
      const items =
        raw && raw.data && Array.isArray(raw.data.searchResults)
          ? raw.data.searchResults
          : [];
      return res.status(200).json({
        ok: true,
        source: "loklok",
        items,
        upstream: raw && raw.__status ? { status: raw.__status, body: raw.__body } : null,
        rawKeys: raw && typeof raw === "object" ? Object.keys(raw).slice(0, 8) : null,
      });
    }
    // --- LokLok (no-token) debug: full play chain for a title ---
    if (q.lokplay) {
      const title = String(q.lokplay).trim();
      const year = String(q.year || "").trim();
      if (title.length < 2) {
        return res.status(400).json({ error: "Title too short" });
      }
      const ans = await loklokPlay(title, year);
      if (ans) return res.status(200).json(ans);
      return res.status(200).json({
        ok: true,
        source: null,
        kind: null,
        noSource: true,
        error: "No LokLok source found for this title.",
      });
    }

    return res.status(400).json({ error: "Unknown mode" });
  } catch (e) {
    return res.status(502).json({ error: "Upstream failed" });
  }
}

const { app } = require("@azure/functions");

app.http("resolve-movie", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const q = Object.fromEntries(new URL(request.url).searchParams.entries());
    const req = { method: request.method, query: q };
    let statusCode = 200;
    const headers = {};
    let body = null;
    let isJson = false;
    const res = {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      status: (c) => {
        statusCode = c;
        return {
          json: (o) => {
            body = o;
            isJson = true;
          },
          send: (t) => {
            body = t;
          },
          end: () => {
            body = "";
          },
        };
      },
    };
    SELF_URL = new URL(request.url).origin + "/api/resolve-movie";
    await handleMovie(req, res);
    if (isJson) return { status: statusCode, headers, jsonBody: body };
    return { status: statusCode, headers, body: body ?? "" };
  },
});
