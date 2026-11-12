// resolve-movie.js — server-side resolver for the Movies page of Aayush TV.
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
//   MOVIESMOD DOWNLOAD (one-click download link):
//   ?dq=<query>                -> 200 {"ok": true, "source": "moviesmod",
//                               "items": [{title, year, slug, pageUrl}]}
//                               (the Movies page search box searches
//                               MoviesMod only — see below)
//   ?dlall=<title>&year=<year>  -> 200 {"ok": true, "source":
//                               "moviesmod", "qualities": [{quality,
//                               downloadUrl, filename, size,
//                               pageUrl}]} — one live file per
//                               quality MoviesMod has (480p/720p/
//                               1080p/2160p, highest first). The
//                               page shows these as a quality
//                               picker. (12 Nov 2026)
//   ?dl=<title>&year=<year>&quality=<480p|720p|1080p|2160p>
//                            -> 200 {"ok": true, "source": "moviesmod",
//                               "downloadUrl": "<DriveSeed file page>",
//                               "quality": "720p", "filename": "...mkv",
//                               "pageUrl": "<moviesmod page>"}
//                               or {"ok": true, "noSource": true}.
//   -> 400 on a missing/unknown mode. 502 when every upstream fails.
//
// SAFETY: only fetches public, unauthenticated catalogue, detail,
// playlist and manifest endpoints. No secrets, no shell, no storage.
// Returned URLs are time-limited and only ever sent to the user's own
// browser.

// The catalogue is NOT bundled into the function: a 5MB static
// import crashed the Vercel function (FUNCTION_INVOCATION_FAILED
// on every endpoint — the bundler could not handle it). Instead
// the index lives as a static file (public/modlist-index.json,
// ~3.9MB) and is fetched once at runtime and cached in memory.
// The chunks (api/modlist-index-N.js) are the build artifacts;
// the loader (api/modlist-index.js) is unused by the resolver.
let MODLIST_INDEX_CACHE = null;
let MODLIST_INDEX_PROMISE = null;
const MODLIST_INDEX_URL =
  "https://aayush-tv-minter.vercel.app/modlist-index.json";
async function loadMoviesModIndex() {
  if (MODLIST_INDEX_CACHE) return MODLIST_INDEX_CACHE;
  if (!MODLIST_INDEX_PROMISE) {
    MODLIST_INDEX_PROMISE = (async () => {
      const r = await fetchWithTimeout(
        MODLIST_INDEX_URL,
        { "User-Agent": UA },
        30000
      );
      if (!r.ok) throw new Error("index HTTP " + r.status);
      const data = await r.json();
      MODLIST_INDEX_CACHE = Array.isArray(data) ? data : [];
      return MODLIST_INDEX_CACHE;
    })().catch((e) => {
      MODLIST_INDEX_PROMISE = null;
      throw e;
    });
  }
  return MODLIST_INDEX_PROMISE;
}

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

const selfUrl = () =>
  "https://aayush-tv-minter.vercel.app/api/resolve-movie";

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

// ---------- MoviesMod download (one-click download link) ----------
//
// Reverse-engineered 2026-11-12. MoviesMod (moviesmod.tw) is a
// WordPress download site (Hollywood/Bollywood, 480p/720p/1080p).
// The download chain, traced hop by hop:
//   1. Movie page https://moviesmod.tw/download-<slug>/ has one
//      links.modpro.blog/archives/<id> button per quality.
//   2. The modpro page ("wait 5 seconds") lists the download servers
//      as https://en.thenaukriadda.in/?sid=<base64> links.
//   3. The sid page is a tiny auto-submitting POST form (_lp_http)
//      to https://en.thenaukriadda.in/.
//   4. That returns an "I'm Not a Robot" timer page (10s countdown,
//      NOT a real CAPTCHA) whose hidden form (lp-s1-form) POSTs
//      _lp_http2/_lp_token/_lp_chain/_lp_hop_index to a blog article.
//   5. The article page has a "Generate link" button (6s timer) and
//      a "Click here to continue" button; the page JS holds a cookie
//      (lp-<hash> = the _lp_http2 token) and a Go link /?lp_go=lp-<hash>.
//   6. GET the Go link with that cookie -> a "Please wait" page whose
//      JS window.location.replace() is the final file page
//      (driveseed.org/file/<id>) or moviesmod.wiki/report-broken-links
//      when the file is dead.
//   7. The file page is DriveSeed (title = filename, size shown);
//      the actual file download there is behind a Cloudflare
//      Turnstile check in the visitor's browser, so the resolver
//      returns the file PAGE URL — one tap from the site, one click
//      on the page, instead of the ~6-step chain with waits.
// The timers are client-side only: the server skips them by reading
// the form fields straight out of the HTML/JS. The whole chain is
// ~5 HTTP requests and takes a few seconds. Verified end-to-end
// 2026-11-12: Avengers: Age of Ultron (2015) 720p -> DriveSeed file
// "Avengers.Age.of.Ultron.2015.720p.Hindi.English.Moviesmod.in.mkv",
// 1.1GB. (The first server for that title was dead —
// report-broken-links — so the resolver tries each server in turn.)
//
// Finding the movie page: the site's own search is Cloudflare-
// challenged for data-centre IPs and the WP REST API needs a login,
// so the resolver looks the title up in a pre-built index of the
// site's sitemap (data-moviesmod-index.json, 21,704 slugs, built
// 2026-11-12 from the 22 post sitemaps). Slug-guessing is the
// fallback when the index misses. The index goes stale as new
// movies are added; rebuild it from the sitemaps when lookups
// start missing.
//
// The index now covers the WHOLE modlist network (12 Nov 2026 —
// the user asked for all sites, not just MoviesMod):
//   mm  = moviesmod.tw (Hollywood)     — ~21,705 entries
//   ml  = moviesleech.media (Bollywood)— ~3,235 entries
//   uhd = uhdmovies.beauty (4K/UHD)    — ~5,461 entries
//   af  = animeflix.my (anime)         — ~759 entries
// (gamesleech / softwareleech are games + software, not movies.)
// Built by tools/build-modlist-index.py from each site's Yoast
// sitemaps, which also carry the poster URL (<image:loc>).
// Entry: {s: slug, site: mm|ml|uhd|af, p: poster URL}.
const MODLIST_SITES = {
  mm: { base: "https://moviesmod.tw", name: "MoviesMod" },
  ml: { base: "https://moviesleech.media", name: "MoviesLeech" },
  uhd: { base: "https://uhdmovies.beauty", name: "UHDMovies" },
  af: { base: "https://animeflix.my", name: "AnimeFlix" },
};
const MOVIESMOD_BASE = "https://moviesmod.tw";
const MODPRO_BASE = "https://links.modpro.blog";
const NAUKRI_BASE = "https://en.thenaukriadda.in";

const normWords = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

async function findModlistEntry(title, year, siteCode) {
  // Best-matching index entry for a title (+ optional year and
  // site). Returns {s, site, p} or null.
  const entries = await loadMoviesModIndex();
  const words = normWords(title);
  if (!words.length || !entries.length) return null;
  let best = null;
  for (const e of entries) {
    if (siteCode && e.site !== siteCode) continue;
    const s = String(e.s).toLowerCase();
    if (year && !s.includes(String(year))) continue;
    if (!words.every((w) => s.includes(w))) continue;
    // Score: words in order first, then a tighter (shorter) slug.
    let idx = -1;
    let inOrder = 0;
    for (const w of words) {
      const i = s.indexOf(w, idx + 1);
      if (i > idx) {
        inOrder++;
        idx = i;
      }
    }
    const score = inOrder * 100 - s.split("-").length;
    if (!best || score > best.score) best = { entry: e, score };
  }
  return best ? best.entry : null;
}

async function findMoviesModSlug(title, year) {
  // Backwards-compat wrapper: the slug of the best match (any site).
  const e = await findModlistEntry(title, year, "");
  return e ? e.s : null;
}

function guessMoviesModSlug(title, year) {
  // Fallback when the index misses: try the most common slug shapes.
  // e.g. "Avengers Age of Ultron" (2015) ->
  // download-avengers-age-of-ultron-2015-hindi-480p-720p-1080p
  const base = normWords(title).join("-");
  const y = year ? `-${year}` : "";
  const langs = ["hindi", "english", "dual-audio", "hindi-english"];
  const quals = ["480p-720p-1080p", "480p-720p", "720p-1080p", "480p-720p-1080p-2160p"];
  const tries = [];
  for (const lang of langs) {
    for (const q of quals) {
      tries.push(`${base}${y}-${lang}-${q}`);
    }
  }
  return tries;
}

// ---------- MoviesMod catalogue search (?dq=) ----------
//
// The Movies page search now searches MoviesMod only (the user's
// request, 12 Nov 2026 — the old ?q= searched the streaming site).
// Titles come from the sitemap index slugs: the slug is
// "<title-words>-<year>-<lang>-<quality>..." (TV adds season info),
// so the title is the words before the year token and the year is
// the last 4-digit year-like token.
const MOVIESMOD_STOP = new Set([
  "hindi", "english", "dual", "audio", "multi", "korean", "chinese",
  "japanese", "tamil", "telugu", "malayalam", "kannada", "bengali",
  "punjabi", "marathi", "urdu", "thai", "french", "german", "italian",
  "spanish", "portuguese", "russian", "turkish", "arabic", "persian",
  "indonesian", "malay", "vietnamese", "filipino", "season",
  "480p", "720p", "1080p", "2160p", "4k", "hevc", "10bit", "x264",
  "x265", "web", "bluray", "hdrip", "hdcam", "esub", "uncut",
  "extended", "directors", "cut",
]);
const SMALL_WORDS = new Set([
  "of", "the", "a", "an", "and", "in", "on", "at", "to", "for", "with",
]);

function slugToMovie(slug) {
  const parts = String(slug).split("-").filter(Boolean);
  let yearIdx = -1;
  let year = "";
  for (let i = 0; i < parts.length; i++) {
    if (/^(19|20)\d{2}$/.test(parts[i])) {
      const y = parseInt(parts[i], 10);
      if (y >= 1900 && y <= 2030) {
        yearIdx = i;
        year = parts[i];
      }
    }
  }
  let end = yearIdx >= 0 ? yearIdx : parts.length;
  if (yearIdx < 0) {
    for (let i = 0; i < parts.length; i++) {
      if (MOVIESMOD_STOP.has(parts[i])) {
        end = i;
        break;
      }
    }
  }
  const words = parts.slice(0, end);
  if (!words.length) return { title: "", year };
  const title = words
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w)
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(" ");
  return { title, year };
}

async function moviesModSearch(query) {
  // Searches the WHOLE modlist network index (moviesmod +
  // moviesleech + uhdmovies + animeflix), not just MoviesMod.
  const words = normWords(query);
  if (!words.length) return [];
  const qNorm = words.join(" ");
  const results = [];
  const seen = new Set();
  const index = await loadMoviesModIndex();
  for (const e of index) {
    const s = String(e.s).toLowerCase();
    if (!words.every((w) => s.includes(w))) continue;
    const { title, year } = slugToMovie(e.s);
    if (!title) continue;
    // Same title+year can appear on several network sites (e.g. a
    // Bollywood film on both MoviesMod and MoviesLeech) — keep one
    // entry per site so the user sees which site carries it.
    const key = title.toLowerCase() + "|" + year + "|" + e.site;
    if (seen.has(key)) continue;
    seen.add(key);
    const site = MODLIST_SITES[e.site] || MODLIST_SITES.mm;
    // Poster paths in the index are relative to
    // <site>/wp-content/uploads/ (compressed to keep the 5MB index
    // splittable for pushes); rebuild the full URL here.
    const poster = e.p
      ? `${site.base}/wp-content/uploads/${e.p}`
      : "";
    results.push({
      title,
      year,
      slug: e.s,
      site: e.site,
      siteName: site.name,
      poster,
      pageUrl: `${site.base}/download-${e.s}/`,
    });
    if (results.length >= 80) break;
  }
  // Relevance: exact title first, then title starts with the query,
  // then newest year first.
  results.sort((a, b) => {
    const aExact = a.title.toLowerCase() === qNorm ? 0 : 1;
    const bExact = b.title.toLowerCase() === qNorm ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aStart = a.title.toLowerCase().startsWith(qNorm) ? 0 : 1;
    const bStart = b.title.toLowerCase().startsWith(qNorm) ? 0 : 1;
    if (aStart !== bStart) return aStart - bStart;
    return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
  });
  return results.slice(0, 40);
}

async function postForm(url, fields, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams(fields).toString();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function followNaukriSid(sid) {
  // Follow one thenaukriadda sid to its final URL.
  // Returns the final URL string, or null when the chain breaks
  // or the file is dead (report-broken-links).
  try {
    // B: GET the sid page -> lp-land form (_lp_http).
    const b = await fetchWithTimeout(
      `${NAUKRI_BASE}/?sid=${encodeURIComponent(sid)}`,
      { "User-Agent": UA },
      12000
    );
    if (!b.ok) return null;
    const bHtml = await b.text();
    const lpHttp = (bHtml.match(/name="_lp_http" value="([^"]+)"/) || [])[1];
    if (!lpHttp) return null;
    // C: POST _lp_http -> timer page with the lp-s1-form.
    const c = await postForm(NAUKRI_BASE + "/", { _lp_http: lpHttp });
    if (!c.ok) return null;
    const cHtml = await c.text();
    const s1 = cHtml.match(
      /<form id="lp-s1-form"[^>]*action="([^"]+)"/
    );
    if (!s1) return null;
    const fields = {};
    for (const m of cHtml.matchAll(
      /name="(_lp_[a-z0-9_]+)"\s+value="([^"]*)"/g
    )) {
      fields[m[1]] = m[2];
    }
    if (!Object.keys(fields).length) return null;
    // D: POST the s1 form -> generate page (cookie + Go link in JS).
    const d = await postForm(s1[1], fields);
    if (!d.ok) return null;
    const dHtml = await d.text();
    const go = dHtml.match(/lp_go=(lp-[a-z0-9]+)/);
    const ck = dHtml.match(/sc\("(lp-[a-z0-9]+)","([^"]+)"/);
    if (!go || !ck) return null;
    // E: GET the Go link with the cookie -> window.location.replace().
    const e = await fetchWithTimeout(
      `${NAUKRI_BASE}/?lp_go=${go[1]}`,
      {
        "User-Agent": UA,
        Cookie: `${ck[1]}=${encodeURIComponent(ck[2])}`,
      },
      12000
    );
    if (!e.ok) return null;
    const eHtml = await e.text();
    const redir = eHtml.match(
      /window\.location\.replace\("([^"]+)"\)/
    );
    if (!redir) return null;
    const final = redir[1].replace(/\\\//g, "/");
    if (/report-broken-links/.test(final)) return null;
    return final;
  } catch {
    return null;
  }
}

// Shared step for the download chain: find the movie page and read
// its download links. Each network site links its files a little
// differently, but they all end at the same thenaukriadda sid chain:
//   moviesmod.tw     -> links.modpro.blog/archives/<id> per quality
//   moviesleech.media-> leechpro.blog/archives/<id> per quality
//   uhdmovies.beauty -> direct en.thenaukriadda.in/?sid= links
//                        (no blog step; quality is in the page title)
//   animeflix.my     -> episodes.animeflix.my/archives/<id>, whose
//                        chain is a different shortener (ronracepub)
//                        — NOT yet supported; those titles show in
//                        search but return noSource for download.
// Returns {pageUrl, archives: [{archiveId, blogBase, quality, sids}]}
// or null. For direct sids, archiveId/blogBase are "" and the
// quality comes from the movie page title.
async function moviesModArchives(title, year, siteCode, slug) {
  // 1. Find the movie page.
  let pageUrl = null;
  const site = MODLIST_SITES[siteCode] || null;
  if (siteCode && slug && site) {
    pageUrl = `${site.base}/download-${slug}/`;
  } else {
    const entry = await findModlistEntry(title, year, siteCode || "");
    if (entry) {
      const s = MODLIST_SITES[entry.site] || MODLIST_SITES.mm;
      pageUrl = `${s.base}/download-${entry.s}/`;
    }
  }
  if (!pageUrl) {
    // Slug-guessing fallback: try likely URLs until one answers 200.
    for (const guess of guessMoviesModSlug(title, year)) {
      try {
        const r = await fetchWithTimeout(
          `${MOVIESMOD_BASE}/download-${guess}/`,
          { "User-Agent": UA },
          10000
        );
        if (r.ok) {
          pageUrl = `${MOVIESMOD_BASE}/download-${guess}/`;
          break;
        }
      } catch {
        // Try the next guess.
      }
    }
  }
  if (!pageUrl) return null;
  // 2. Movie page -> download links.
  let pageHtml = "";
  try {
    const r = await fetchWithTimeout(pageUrl, { "User-Agent": UA }, 12000);
    if (!r.ok) return null;
    pageHtml = await r.text();
  } catch {
    return null;
  }
  // Quality hint from the movie page title (uhdmovies names its
  // qualities there, e.g. "1080p 10Bit || 2160p 4k").
  const pageTitle = (pageHtml.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  const archives = [];
  // (a) Blog archive links: any *.blog/archives/<id> (modpro,
  // leechpro, ...). Each is one quality; fetch it for its sids.
  const blogLinks = [
    ...new Set(
      [...pageHtml.matchAll(
        /https?:\/\/([a-z0-9.-]+\.blog)\/archives\/(\d+)/g
      )].map((m) => `${m[1]}|${m[2]}`)
    ),
  ];
  for (const link of blogLinks) {
    const [blogBase, archiveId] = link.split("|");
    try {
      const r = await fetchWithTimeout(
        `https://${blogBase}/archives/${archiveId}`,
        { "User-Agent": UA },
        12000
      );
      if (!r.ok) continue;
      const modHtml = await r.text();
      // The page has two <title> tags: the blog name and the post
      // title ("... 720p – ..."). Use the one that names a quality.
      const titles = [...modHtml.matchAll(/<title>([^<]*)<\/title>/g)].map(
        (m) => m[1]
      );
      const modTitle =
        titles.find((t) => /\d{3,4}p/.test(t)) || titles[1] || titles[0] || "";
      const qInTitle = /(\d{3,4})p/.exec(modTitle);
      const sids = [
        ...new Set(
          [...modHtml.matchAll(/en\.thenaukriadda\.in\/\?sid=([A-Za-z0-9+/=]+)/g)].map(
            (m) => m[1]
          )
        ),
      ];
      if (!sids.length) continue;
      archives.push({
        archiveId,
        blogBase,
        quality: qInTitle ? `${qInTitle[1]}p` : "",
        sids,
      });
    } catch {
      continue;
    }
  }
  // (b) Direct thenaukriadda sids on the movie page itself
  // (uhdmovies). These are servers for the page's quality set;
  // the quality is read from the file name after resolving.
  const directSids = [
    ...new Set(
      [...pageHtml.matchAll(/en\.thenaukriadda\.in\/\?sid=([A-Za-z0-9+/=]+)/g)].map(
        (m) => m[1]
      )
    ),
  ];
  if (directSids.length) {
    const qInPage = /(\d{3,4})p/.exec(pageTitle);
    archives.push({
      archiveId: "",
      blogBase: "",
      quality: qInPage ? `${qInPage[1]}p` : "",
      sids: directSids,
    });
  }
  if (!archives.length) return null;
  return { pageUrl, archives };
}

// Resolve ONE archive (one quality) to its live file page:
// try each of its servers' sids until one lands on a live file.
// Returns {downloadUrl, quality, filename, size, pageUrl} or null.
async function resolveMoviesModArchive(arch, pageUrl) {
  for (const sid of arch.sids) {
    const final = await followNaukriSid(sid);
    if (!final) continue;
    // The final URL is the DriveSeed file page (or a short link to
    // it). Follow any JS redirect once to reach the file page,
    // then read its filename/size.
    let filename = "";
    let size = "";
    let fileUrl = final;
    try {
      for (let hop = 0; hop < 2; hop++) {
        const fr = await fetchWithTimeout(fileUrl, { "User-Agent": UA }, 12000);
        if (!fr.ok) break;
        const fHtml = await fr.text();
        const redir = fHtml.match(
          /window\.location\.replace\("([^"]+)"\)/
        );
        if (redir) {
          const next = redir[1].replace(/\\\//g, "/");
          fileUrl = new URL(next, fileUrl).href;
          continue;
        }
        const t = (fHtml.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
        if (t && !/report-broken/i.test(t)) filename = t.trim();
        const sz = fHtml.match(/Size\s*:\s*([0-9.]+ ?[KMG]B)/i);
        if (sz) size = sz[1];
        break;
      }
    } catch {
      // Keep the URL anyway; the page itself is the proof.
    }
    // Validate: a real download is a DriveSeed file page (or a page
    // whose title is a media file name). A sid that lands back on
    // the movie site itself (e.g. uhdmovies.mov/4k-movies/) is a
    // dead server, not a file — skip it and try the next sid.
    const isFilePage = /driveseed\.org\/file\/[A-Za-z0-9]+/i.test(fileUrl);
    const isMediaName = /\.(mkv|mp4|avi|mov|webm)\s*$/i.test(filename);
    if (!isFilePage && !isMediaName) continue;
    return {
      downloadUrl: fileUrl,
      // Prefer the quality named in the actual file name (e.g.
      // "...2160p..." on a uhdmovies file); fall back to the
      // archive's quality label.
      quality: fileQuality(filename) || arch.quality || "",
      filename,
      size,
      pageUrl,
    };
  }
  return null;
}

// Quality named in a file name, e.g. "Movie.2021.2160p.HDR.mkv"
// -> "2160p". Used so direct-sid titles (uhdmovies) get the right
// label from the file itself.
function fileQuality(filename) {
  const m = /(\d{3,4})p/i.exec(String(filename || ""));
  return m ? `${m[1]}p` : "";
}

async function moviesModDownload(title, year, quality, siteCode, slug) {
  // Returns {downloadUrl, quality, filename, pageUrl} or null.
  // Tries the wanted quality first, then the others.
  const wantQ = /^(480p|720p|1080p|2160p)$/.test(quality || "")
    ? quality
    : "720p";
  const found = await moviesModArchives(title, year, siteCode, slug);
  if (!found) return null;
  const { pageUrl, archives } = found;
  archives.sort((a, b) => {
    const aW = a.quality === wantQ ? 0 : 1;
    const bW = b.quality === wantQ ? 0 : 1;
    if (aW !== bW) return aW - bW;
    // Among the rest, prefer higher quality first.
    return (
      (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
    );
  });
  for (const arch of archives) {
    const result = await resolveMoviesModArchive(arch, pageUrl);
    if (result) {
      if (!result.quality) result.quality = wantQ;
      return result;
    }
  }
  return null;
}

async function moviesModAllQualities(title, year, siteCode, slug) {
  // Returns one live file per quality the network has for the title
  // (480p/720p/1080p/2160p, highest first). Blog archives give one
  // file each (first working server); a direct-sid page (uhdmovies)
  // is tried across several servers so both its qualities surface.
  const found = await moviesModArchives(title, year, siteCode, slug);
  if (!found) return [];
  const { pageUrl, archives } = found;
  // Dedupe blog archives by quality (a title can list the same
  // quality twice) and sort highest first.
  const byQuality = new Map();
  for (const arch of archives) {
    if (!arch.archiveId) continue; // direct sids handled below
    const key = arch.quality || "unknown";
    if (!byQuality.has(key)) byQuality.set(key, arch);
  }
  const unique = [...byQuality.values()].sort(
    (a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
  );
  const results = (
    await Promise.all(
      unique.map((arch) => resolveMoviesModArchive(arch, pageUrl))
    )
  ).filter(Boolean);
  // Direct sids (uhdmovies): resolve up to 8 servers in parallel
  // and keep one file per distinct quality named in the file names.
  const direct = archives.find((a) => !a.archiveId);
  if (direct) {
    const seenQ = new Set(results.map((x) => x.quality));
    const settled = await Promise.all(
      direct.sids.slice(0, 8).map((sid) =>
        resolveMoviesModArchive({ ...direct, sids: [sid] }, pageUrl)
      )
    );
    for (const r of settled) {
      if (!r) continue;
      if (r.quality && seenQ.has(r.quality)) continue;
      if (r.quality) seenQ.add(r.quality);
      if (!results.some((x) => x.downloadUrl === r.downloadUrl)) {
        results.push(r);
      }
    }
  }
  results.sort(
    (a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
  );
  return results;
}

// ---------- TV series downloads (?series= / ?ep=) ----------
//
// A series page links its files through blog archives, but unlike
// a movie it has TWO kinds:
//   * [ZIP/PACK] archives — the WHOLE SEASON in one zip, one per
//     quality (e.g. "#1 Happy Family USA S01 480p – [ZIP/PACK]").
//   * single-episode archives — one episode in one quality
//     (e.g. "#1 Happy Family USA S01 480p x264"), where "#1" is
//     the episode number.
// Some series have neither marker: their archives are one season
// pack per quality/host (e.g. "Got S01 Hindi 480p – OneDrive").
// Those are returned as season downloads.
// The ?series= mode resolves the PACKS eagerly (few, fast) and
// returns single episodes as metadata (episode + quality +
// archive id); tapping one calls ?ep= to resolve just that file.

// Episode number from an archive title: "#1", "E01", "S01E01",
// "Episode 1" — the first such marker wins.
function seriesEpisode(title) {
  const t = String(title || "");
  let m = /S\d{1,2}E(\d{1,3})/i.exec(t);
  if (m) return parseInt(m[1], 10);
  m = /(?:^|[#\s])(\d{1,3})\s*(?:$|[\s\-–])/ .exec(t);
  if (m) return parseInt(m[1], 10);
  m = /E(\d{1,3})\b/i.exec(t);
  if (m) return parseInt(m[1], 10);
  m = /Episode\s*(\d{1,3})/i.exec(t);
  if (m) return parseInt(m[1], 10);
  return null;
}

function parseSeriesArchive(title) {
  const t = String(title || "");
  const q = /(\d{3,4})p/.exec(t);
  return {
    ep: seriesEpisode(t),
    quality: q ? `${q[1]}p` : "",
    isPack: /\[?\s*ZIP\s*\/\s*PACK\s*\]?/i.test(t) || /\bPACK\b/i.test(t),
  };
}

// Fetch one blog archive page: its post title + its sids.
async function fetchBlogArchive(blogBase, archiveId) {
  try {
    const r = await fetchWithTimeout(
      `https://${blogBase}/archives/${archiveId}`,
      { "User-Agent": UA },
      12000
    );
    if (!r.ok) return null;
    const html = await r.text();
    const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map(
      (m) => m[1]
    );
    const title =
      titles.find((x) => /\d{3,4}p/.test(x)) || titles[1] || titles[0] || "";
    const sids = [
      ...new Set(
        [...html.matchAll(/en\.thenaukriadda\.in\/\?sid=([A-Za-z0-9+/=]+)/g)].map(
          (m) => m[1]
        )
      ),
    ];
    if (!sids.length) return null;
    return { title, sids };
  } catch {
    return null;
  }
}

// Find a series page URL (same lookup as moviesModArchives).
async function findSeriesPage(title, year, siteCode, slug) {
  const site = MODLIST_SITES[siteCode] || null;
  if (siteCode && slug && site) {
    return `${site.base}/download-${slug}/`;
  }
  const entry = await findModlistEntry(title, year, siteCode || "");
  if (entry) {
    const s = MODLIST_SITES[entry.site] || MODLIST_SITES.mm;
    return `${s.base}/download-${entry.s}/`;
  }
  for (const guess of guessMoviesModSlug(title, year)) {
    try {
      const r = await fetchWithTimeout(
        `${MOVIESMOD_BASE}/download-${guess}/`,
        { "User-Agent": UA },
        10000
      );
      if (r.ok) return `${MOVIESMOD_BASE}/download-${guess}/`;
    } catch {
      // Try the next guess.
    }
  }
  return null;
}

// Series structure: {pageUrl, packs, episodes, seasons}.
// packs: whole-season zips, resolved to files (one per quality).
// episodes: [{ep, qualities: [{quality, archiveId, blogBase}]}]
//   — metadata only; ?ep= resolves one on demand.
// seasons: per-quality season archives when no episode numbers
//   exist (e.g. GOT); resolved to files like packs.
async function seriesInfo(title, year, siteCode, slug) {
  const pageUrl = await findSeriesPage(title, year, siteCode, slug);
  if (!pageUrl) return null;
  let pageHtml = "";
  try {
    const r = await fetchWithTimeout(pageUrl, { "User-Agent": UA }, 12000);
    if (!r.ok) return null;
    pageHtml = await r.text();
  } catch {
    return null;
  }
  const blogLinks = [
    ...new Set(
      [...pageHtml.matchAll(
        /https?:\/\/([a-z0-9.-]+\.blog)\/archives\/(\d+)/g
      )].map((m) => `${m[1]}|${m[2]}`)
    ),
  ];
  if (!blogLinks.length) return null;
  // Read every archive's title + sids in parallel.
  const fetched = (
    await Promise.all(
      blogLinks.map(async (link) => {
        const [blogBase, archiveId] = link.split("|");
        const got = await fetchBlogArchive(blogBase, archiveId);
        if (!got) return null;
        return { blogBase, archiveId, ...got };
      })
    )
  ).filter(Boolean);
  if (!fetched.length) return null;
  const packs = [];
  const epMap = new Map(); // ep -> [{quality, archiveId, blogBase}]
  const seasonArch = []; // no episode number, not a pack
  const packArch = [];
  for (const f of fetched) {
    const info = parseSeriesArchive(f.title);
    const arch = {
      archiveId: f.archiveId,
      blogBase: f.blogBase,
      quality: info.quality,
      sids: f.sids,
    };
    if (info.isPack) {
      packArch.push(arch);
    } else if (info.ep != null) {
      if (!epMap.has(info.ep)) epMap.set(info.ep, []);
      epMap.get(info.ep).push({
        quality: info.quality,
        archiveId: f.archiveId,
        blogBase: f.blogBase,
      });
    } else {
      seasonArch.push(arch);
    }
  }
  // Resolve the whole-season packs in parallel, one per quality
  // (a season can list 720p twice — 10bit and x264 — keep one).
  const packFiles = (
    await Promise.all(
      packArch.map((arch) => resolveMoviesModArchive(arch, pageUrl))
    )
  ).filter(Boolean);
  const seenPackQ = new Set();
  for (const file of packFiles.sort(
    (a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
  )) {
    if (file.quality && seenPackQ.has(file.quality)) continue;
    if (file.quality) seenPackQ.add(file.quality);
    packs.push(file);
  }
  // Season archives (no episode number): resolve one per quality,
  // in parallel.
  const seasons = [];
  const seenQ = new Set();
  const seasonFiles = (
    await Promise.all(
      seasonArch
        .sort(
          (a, b) =>
            (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
        )
        .map((arch) => resolveMoviesModArchive(arch, pageUrl))
    )
  ).filter(Boolean);
  for (const file of seasonFiles) {
    if (file.quality && seenQ.has(file.quality)) continue;
    if (file.quality) seenQ.add(file.quality);
    seasons.push(file);
  }
  const episodes = [...epMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ep, qualities]) => {
      // One entry per quality (720p 10bit and 720p x264 collapse).
      const seen = new Set();
      const uniq = [];
      for (const q of qualities.sort(
        (a, b) =>
          (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
      )) {
        if (q.quality && seen.has(q.quality)) continue;
        if (q.quality) seen.add(q.quality);
        uniq.push(q);
      }
      return { ep, qualities: uniq };
    });
  packs.sort(
    (a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0)
  );
  return { pageUrl, packs, episodes, seasons };
}

// Resolve ONE episode archive to its file (used by ?ep=).
async function resolveEpisodeArchive(blogBase, archiveId, pageUrl) {
  const got = await fetchBlogArchive(blogBase, archiveId);
  if (!got) return null;
  const info = parseSeriesArchive(got.title);
  const file = await resolveMoviesModArchive(
    { archiveId, blogBase, quality: info.quality, sids: got.sids },
    pageUrl || ""
  );
  return file;
}

// ---------- subtitles ----------

function srtToVtt(srt) {
  const body = String(srt)
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return "WEBVTT\n\n" + body + "\n";
}

export default async function handler(req, res) {
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

    // --- MoviesMod catalogue search (the Movies page search box) ---
    if (q.dq) {
      const query = String(q.dq).trim();
      if (query.length < 2) {
        return res.status(400).json({ error: "Query too short" });
      }
      return res.status(200).json({
        ok: true,
        source: "moviesmod",
        items: await moviesModSearch(query),
      });
    }

    // --- TV series: whole season at once, or one episode ---
    // ?series=<title>&year=&site=&slug= returns:
    //   packs: whole-season zips, resolved to files (one/quality)
    //   episodes: [{ep, qualities:[{quality, archiveId, blogBase}]}]
    //   seasons: per-quality season files when no episode numbers
    // Single episodes are resolved on demand via ?ep= (below).
    if (q.series) {
      const title = String(q.series).trim();
      if (!title) {
        return res.status(400).json({ error: "Missing title" });
      }
      const year = String(q.year || "").trim();
      const siteCode = String(q.site || "").trim();
      const slug = String(q.slug || "").trim();
      const info = await seriesInfo(title, year, siteCode, slug).catch(
        () => null
      );
      if (!info || (!info.packs.length && !info.episodes.length && !info.seasons.length)) {
        return res.status(200).json({
          ok: true,
          source: null,
          noSource: true,
          error: "No series download found for this title.",
        });
      }
      return res.status(200).json({
        ok: true,
        source: "moviesmod",
        pageUrl: info.pageUrl,
        packs: info.packs,
        episodes: info.episodes,
        seasons: info.seasons,
      });
    }

    // --- One episode: resolve a single archive to its file ---
    // ?ep=<archiveId>&blog=<host>&page=<series page url>
    if (q.ep) {
      const archiveId = String(q.ep).trim();
      const blogBase = String(q.blog || "").trim();
      const pageUrl = String(q.page || "").trim();
      if (!archiveId || !blogBase) {
        return res.status(400).json({ error: "Missing episode" });
      }
      const file = await resolveEpisodeArchive(blogBase, archiveId, pageUrl).catch(
        () => null
      );
      if (!file) {
        return res.status(200).json({
          ok: true,
          source: null,
          noSource: true,
          error: "That episode is not available right now.",
        });
      }
      return res.status(200).json({ ok: true, source: "moviesmod", ...file });
    }

    // --- MoviesMod one-click download: ALL qualities ---
    // ?dlall=<title>&year=<year> -> 200 {"ok": true,
    // "source": "moviesmod", "qualities": [{quality, downloadUrl,
    // filename, size, pageUrl}]} — one live file per quality
    // MoviesMod has for the title (480p/720p/1080p/2160p,
    // highest first). The page shows these as a quality picker.
    // (The single-quality ?dl= stays for backwards compat.)
    if (q.dlall) {
      const title = String(q.dlall).trim();
      if (!title) {
        return res.status(400).json({ error: "Missing title" });
      }
      const year = String(q.year || "").trim();
      // Exact page when the search result gave it (site + slug);
      // otherwise the title is looked up in the whole network index.
      const siteCode = String(q.site || "").trim();
      const slug = String(q.slug || "").trim();
      const qualities = await moviesModAllQualities(
        title,
        year,
        siteCode,
        slug
      ).catch(() => []);
      if (!qualities.length) {
        return res.status(200).json({
          ok: true,
          source: null,
          noSource: true,
          error: "No download found for this title.",
        });
      }
      return res.status(200).json({
        ok: true,
        source: "moviesmod",
        qualities,
      });
    }

    // --- MoviesMod one-click download ---
    if (q.dl) {
      const title = String(q.dl).trim();
      const year = String(q.year || "").trim();
      const quality = String(q.quality || "").trim();
      const siteCode = String(q.site || "").trim();
      const slug = String(q.slug || "").trim();
      if (title.length < 2) {
        return res.status(400).json({ error: "Title too short" });
      }
      const dl = await moviesModDownload(
        title,
        year,
        quality,
        siteCode,
        slug
      ).catch(() => null);
      if (dl) {
        return res.status(200).json({
          ok: true,
          source: "moviesmod",
          downloadUrl: dl.downloadUrl,
          quality: dl.quality,
          filename: dl.filename,
          size: dl.size,
          pageUrl: dl.pageUrl,
        });
      }
      return res.status(200).json({
        ok: true,
        source: null,
        noSource: true,
        error: "No download found for this title.",
      });
    }

    return res.status(400).json({ error: "Unknown mode" });
  } catch (e) {
    return res.status(502).json({ error: "Upstream failed" });
  }
}
