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
// ENDPOINT: GET /api/resolve?ch=<key>
//   -> 200 {"url": "https://.../xxx.m3u8", "expires": 1794396644} on success
//   -> 400 on unknown key, 502 if the player page / ticket / upstream fails
//
// SAFETY: only fetches the player page and its ticket blob (public,
// unauthenticated endpoints). No secrets, no shell, no storage. The
// returned URL is time-limited and only ever sent to the user's own
// browser, which plays it directly.

const PLAYER_BASE = "https://ehgembxe.cfd/bintv/";
const PLAYER_REFERER = "https://bintv-sources.pages.dev/";

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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const signal = controller.signal;

    const page = await fetch(PLAYER_BASE + path, {
      headers: { "User-Agent": UA, Referer: PLAYER_REFERER },
      signal,
    });
    if (!page.ok) throw new Error(`Player page ${page.status}`);
    const html = await page.text();

    const decoded = decodePlayerScript(html);
    const ticket = decoded.match(/loadStreamUrl\("(https?:\/\/[^"]+)"/);
    if (!ticket) throw new Error("Ticket URL not found");

    const ticketRes = await fetch(ticket[1], {
      headers: { "User-Agent": UA, Referer: page.url },
      signal,
    });
    if (!ticketRes.ok) throw new Error(`Ticket ${ticketRes.status}`);
    const buf = await ticketRes.arrayBuffer();
    clearTimeout(timer);

    const url = decryptTicket(ticket[1], buf);
    if (!url.startsWith("https://") || !url.includes(".m3u8")) {
      throw new Error("Bad stream URL");
    }
    // The signed URL carries its expiry as a path segment:
    // .../secure/<token>/<epoch>/name.m3u8
    const expires = parseInt(url.split("/").slice(-2, -1)[0], 10) || null;
    return res.status(200).json({ url, expires });
  } catch (e) {
    return res.status(502).json({ error: "Upstream error" });
  }
}
