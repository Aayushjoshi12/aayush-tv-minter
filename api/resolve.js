// resolve.js — server-side resolver for the Premium section of Aayush TV.
//
// Deploy as api/resolve.js next to api/stream.js (same Vercel-style
// serverless handler, same CORS-open pattern).
//
// WHY A SERVER IS NEEDED: the premium player's page only answers when
// the request carries Referer: https://bintv-sources.pages.dev/ —
// browsers forbid a page from setting that header itself, so the
// site cannot fetch the player page directly. This function runs on
// the server, sets the header freely, and returns just the signed
// stream URL as JSON, so the site can play it natively.
//
// CHAIN (proven 2026-11-11): the player page hides its player code
// as an encoded byte array; decoding it gives a script that fetches
// a ticket blob and XOR-decrypts it into a signed .m3u8 URL. The
// signed URL expires after ~2 hours, so the site calls this on every
// tap (and caches the answer for 30 minutes) instead of hard-coding
// a link.
//
// FAILOVER (added 2026-11-11, per the user's "if 1 fail it should
// redirect to other"): BINTV's backend is down more often than not,
// so the resolver no longer returns a single link. It returns an
// ordered list of sources, and the site tries them in order until
// one plays:
//   1. BINTV native — the signed .m3u8, but only if its manifest
//      actually loads (a dead signed link is skipped, not returned).
//   2. Backup embeds — player pages from other hosts, found by
//      reverse-engineering DaddyLive's public player JSONs
//      (daddylive.mov/player/playerN.json, 11 Nov 2026). Sites with
//      a public API (DaddyLive /api/events, DamiTV /api/streams) are
//      used through that API; sites without one were reverse-
//      engineered the same way BINTV was, and their per-channel
//      player URLs are listed in BACKUPS below. Each embed is
//      checked live (HTTP 200) before it is offered, so a dead
//      backup never reaches the site.
//   3. The BINTV watch page, appended by the site itself as the
//      last resort (same as before).
// None of the backup hosts sends X-Frame-Options, and matchora
// sends `frame-ancestors *`, so their player pages can be embedded
// in the site's iframe (verified 11 Nov 2026).
//
// ENDPOINT: GET /api/resolve?ch=<key>
//   -> 200 {"url", "expires", "kind", "source", "sources": [
//        {"kind": "hls"|"embed", "source": "...", "url": "...",
//         "expires": <epoch|null>}, ... ]}
//      "url"/"kind"/"source" describe sources[0] (kept so older
//      site versions keep working). "sources" is ordered best-first.
//   -> 400 on unknown key. It (almost) never 502s now: even when
//      every upstream fails, the watch-page fallback is appended
//      by the site, and the embed list here is empty rather than
//      an error.
//
// SAFETY: only fetches public, unauthenticated pages (player page,
// ticket blob, manifests, backup player pages). No secrets, no
// shell, no storage. Returned URLs are time-limited and only ever
// sent to the user's own browser, which plays them directly.

const PLAYER_BASE = "https://ehgembxe.cfd/bintv/";
const PLAYER_REFERER = "https://bintv-sources.pages.dev/";
const BACKUP_REFERER = "https://daddylive.mov/";

// key -> player path, from the public channel feed (2026-11-11).
const CHANNELS = {
  "dazn-laliga": "fw2jrum9-448",
  "movistar-laliga": "vowrwhdn-2491",
  "sky-pl": "kzd3hrqz-4314",
  "sky-main-event": "n58ajgfx-472",
  "tnt-1": "e0lyrkhr-1002",
  "bein-mena-1": "gh9m7u89-8471",
  "espn": "o9bl8cai-7223",
  "dazn-1-es": "sq26inyf-2660",
};

// Backup player pages, in the order the site should try them.
// Sources (all verified live 11 Nov 2026):
//  - 104game / cdnlivetv / matchora / tvnow247 / streamtp: per-channel
//    player URLs taken from DaddyLive's public player JSONs
//    (player6.json = 104game, player5.json = cdnlivetv,
//    player19.json = matchora, player10.json = tvnow247,
//    player2.json = streamtp). player14.json is BINTV itself.
//  - DaddyLive watch pages: /live/stream=<Channel-Name>&source=...
//  - CricHD: per-channel watch pages.
// No backup publishes a direct .m3u8 for these channels (the one
// direct .m3u8 list found, DaddyLive player9.json, only covers ESPN
// US over plain http, which cannot play on the site's https page),
// so backups are embeds: the site shows them in its iframe player.
// DAZN LaLiga and DAZN 1 Spain have no backup anywhere else —
// their only fallbacks are the embeds below.
const BACKUPS = {
  "dazn-laliga": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/51" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139024" },
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/52" },
  ],
  "movistar-laliga": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/49" },
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/50" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=LaLiga%20TV%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20Premier%20League%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "DaddyLive", url: "https://daddylive.mov/live/stream=Sky-Sports-Premier-League&source=list19-8r" },
    { kind: "embed", source: "CricHD", url: "https://crichd.cm/sky-sports-premier-league-live-stream-play3" },
  ],
  "sky-main-event": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20Main%20Event%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "tnt-1": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=TNT%20Sports%201%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "bein-mena-1": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/1" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/49226" },
  ],
  "espn": [
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=espn" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/44/" },
  ],
  "dazn-1-es": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/56" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139027" },
  ],
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodePlayerScript(html) {
  // The player code is hidden as a byte array in one inline script:
  //   var _xb5=[240,206,...]; var _uf5=235,_rh1=29;
  //   ...String.fromCharCode(((_xb5[i]^_uf5)-_rh1+256)%256)...
  // Variable names change on every load, so match by shape, not name.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1]
  );
  for (const sc of scripts) {
    const arr = sc.match(/var (_\w+)=\[\s*([0-9,\s]+)\]/);
    if (!arr || arr[2].split(",").length < 500) continue;
    const nums = arr[2].split(",").map((x) => parseInt(x, 10));
    const tail = sc.slice(arr.index + arr[0].length);
    const keys = tail.match(/=(\d+),\s*_\w+=(\d+)/);
    if (!keys) continue;
    const xor = parseInt(keys[1], 10);
    const sub = parseInt(keys[2], 10);
    const bytes = nums.map((n) => (((n ^ xor) - sub + 256) % 256));
    return String.fromCharCode(...bytes);
  }
  throw new Error("Player script not found");
}

function decryptTicket(ticketUrl, buf) {
  // Ticket blob: first byte is a seed, the rest is the URL XORed
  // with the ticket id (last path segment) and the seed.
  const bytes = new Uint8Array(buf);
  if (bytes.length < 3) throw new Error("Ticket too short");
  const tk = ticketUrl.substring(ticketUrl.lastIndexOf("/") + 1);
  const s = bytes[0];
  let out = "";
  for (let i = 1; i < bytes.length; i++) {
    out += String.fromCharCode(
      bytes[i] ^ tk.charCodeAt((i - 1) % tk.length) ^ ((s + i - 1) & 255)
    );
  }
  return out;
}

function fetchWithTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function resolveBintv(path) {
  // The original chain, unchanged: player page -> decode -> ticket
  // -> signed .m3u8. Returns {url, expires} or throws.
  const page = await fetchWithTimeout(
    PLAYER_BASE + path,
    { "User-Agent": UA, Referer: PLAYER_REFERER },
    15000
  );
  if (!page.ok) throw new Error(`Player page ${page.status}`);
  const html = await page.text();

  const decoded = decodePlayerScript(html);
  const ticket = decoded.match(/loadStreamUrl\("(https?:\/\/[^"]+)"/);
  if (!ticket) throw new Error("Ticket URL not found");

  const ticketRes = await fetchWithTimeout(
    ticket[1],
    { "User-Agent": UA, Referer: page.url },
    15000
  );
  if (!ticketRes.ok) throw new Error(`Ticket ${ticketRes.status}`);
  const buf = await ticketRes.arrayBuffer();

  const url = decryptTicket(ticket[1], buf);
  if (!url.startsWith("https://") || !url.includes(".m3u8")) {
    throw new Error("Bad stream URL");
  }
  // The signed URL carries its expiry as a path segment:
  // .../secure/<token>/<epoch>/name.m3u8
  const expires = parseInt(url.split("/").slice(-2, -1)[0], 10) || null;
  return { url, expires };
}

async function manifestLoads(url) {
  // A signed link is only useful if its manifest actually loads —
  // BINTV's backend has been returning 404 for these all day, so a
  // link that fails here is skipped instead of handed to the site.
  try {
    const res = await fetchWithTimeout(
      url,
      { "User-Agent": UA },
      8000
    );
    if (!res.ok) return false;
    const text = await res.text();
    return text.startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

async function pageLoads(url) {
  // A backup embed is only offered if its player page answers.
  try {
    const res = await fetchWithTimeout(
      url,
      { "User-Agent": UA, Referer: BACKUP_REFERER },
      6000
    );
    return res.ok;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const key = req.query.ch;
  const path = CHANNELS[key];
  if (!path) {
    return res.status(400).json({ error: "Unknown channel" });
  }

  const sources = [];

  // 1. BINTV native — but only when the signed manifest loads.
  // When it works, return at once: no backup checks needed, and the
  // fast path stays fast.
  try {
    const { url, expires } = await resolveBintv(path);
    if (await manifestLoads(url)) {
      sources.push({ kind: "hls", source: "BINTV", url, expires });
      const first = sources[0];
      return res.status(200).json({
        url: first.url,
        expires: first.expires,
        kind: first.kind,
        source: first.source,
        sources,
      });
    }
  } catch (e) {
    // BINTV down: fall through to the backups.
  }

  // 2. Backup embeds, in order, each checked live. Collect up to
  // two working ones — the site tries them in order, so more than
  // two is rarely reached and each check costs a round trip.
  const backups = BACKUPS[key] || [];
  for (const b of backups) {
    if (sources.filter((s) => s.kind === "embed").length >= 2) break;
    if (await pageLoads(b.url)) {
      sources.push({ kind: "embed", source: b.source, url: b.url, expires: null });
    }
  }

  // 3. If even the backups are all down, the list is empty and the
  // site falls back to the watch page it already knows.
  if (!sources.length) {
    return res.status(200).json({
      url: null,
      expires: null,
      kind: null,
      source: null,
      sources: [],
    });
  }
  const first = sources[0];
  return res.status(200).json({
    url: first.url,
    expires: first.expires || null,
    kind: first.kind,
    source: first.source,
    sources,
  });
}
