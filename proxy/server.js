// aayush-bb-proxy — Bigg Boss 24/7 HLS proxy.
// Runs on a small VM in Central India (Pune). The video pieces
// (.ts segments) are locked to the address that asks for them and
// the broadcaster (Hotstar) only allows India, so a browser in
// Nepal cannot fetch them directly. This server sits in India:
// it fetches the live playlist + the video pieces from its own
// Indian address (where the session holds) and serves them back
// with CORS *, so the site's own player (hls.js) can play them.
//
// Only this server touches zoloj/Hotstar. The site fetches the
// playlist from here, and the video pieces from here too.
// Node 20+, no external dependencies (uses the built-in fetch).

const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT ? +process.env.PORT : 8080;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PLAYER_REFERER =
  "https://kollypress.com/respectful-celebrity-coverage/";
const ZOLOJ = "https://stream2.zoloj.com";

const LANGS = new Set(["tamil", "telugu", "malayalam", "kannada", "hindi"]);

// sid cache per language: { sid, at }
const sidCache = new Map();
const SID_TTL_MS = 60 * 1000;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 15000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Fetch a fresh sid for a language from the player page.
async function freshSid(lang) {
  const r = await fetchWithTimeout(`${ZOLOJ}/player?lang=${lang}`, {
    headers: { "User-Agent": UA, Referer: PLAYER_REFERER },
  }, 15000);
  if (!r.ok) throw new Error("player page " + r.status);
  const html = await r.text();
  const m =
    html.match(/\/stream\/[a-z]+\.m3u8\?sid=([0-9a-f]{64})/) ||
    html.match(/var SID\s*=\s*"([0-9a-f]{64})"/);
  if (!m) throw new Error("no sid in player page");
  return m[1];
}

async function getSid(lang) {
  const c = sidCache.get(lang);
  if (c && Date.now() - c.at < SID_TTL_MS) return c.sid;
  const sid = await freshSid(lang);
  sidCache.set(lang, { sid, at: Date.now() });
  return sid;
}

// Fetch the live playlist for a language.
async function fetchManifest(lang) {
  const sid = await getSid(lang);
  const url = `${ZOLOJ}/stream/${lang}.m3u8?sid=${sid}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      Referer: `${ZOLOJ}/player?lang=${lang}`,
      Cookie: `hs_session=${sid}`,
    },
  }, 15000);
  if (!r.ok) {
    // Session went stale — drop it so the next try fetches fresh.
    sidCache.delete(lang);
    throw new Error("m3u8 " + r.status);
  }
  return { text: await r.text(), sid };
}

// Rewrite a playlist so every video piece points at this proxy:
//   /seg?u=<encoded zoloj /seg URL>
// (The proxy fetches that piece from its own Indian address and
// serves it back with CORS *.)
function rewriteManifest(text, req) {
  const host = req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const base = `${proto}://${host}`;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#EXT-X-KEY")) {
        return line.replace(/URI="([^"]+)"/, (m, u) => {
          if (/^https?:\/\//i.test(u)) {
            return 'URI="' + base + "/seg?u=" + encodeURIComponent(u) + '"';
          }
          return m;
        });
      }
      if (t.startsWith("#")) return line;
      let url = t;
      if (!/^https?:\/\//i.test(url)) {
        url = new URL(url, `${ZOLOJ}/stream/`).toString();
      }
      return base + "/seg?u=" + encodeURIComponent(url);
    })
    .join("\n");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/" || u.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "aayush-bb-proxy" });
      return;
    }

    // GET /bb?lang=tamil — the rewritten live playlist.
    if (u.pathname === "/bb") {
      const lang = (u.searchParams.get("lang") || "tamil").toLowerCase();
      if (!LANGS.has(lang)) {
        sendJson(res, 400, { error: "unknown lang" });
        return;
      }
      try {
        const { text } = await fetchManifest(lang);
        cors(res);
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(rewriteManifest(text, req));
      } catch (e) {
        sendJson(res, 502, { error: "feed unavailable", detail: String(e.message || e) });
      }
      return;
    }

    // GET /seg?u=<encoded zoloj /seg url> — one video piece (.ts).
    if (u.pathname === "/seg") {
      const target = u.searchParams.get("u");
      if (!target) {
        sendJson(res, 400, { error: "missing u" });
        return;
      }
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch {
        sendJson(res, 400, { error: "bad u" });
        return;
      }
      if (targetUrl.hostname !== "stream2.zoloj.com") {
        sendJson(res, 400, { error: "host not allowed" });
        return;
      }
      const sid = targetUrl.searchParams.get("sid") || "";
      const lang = targetUrl.searchParams.get("lang") || "tamil";
      const headers = {
        "User-Agent": UA,
        Referer: `${ZOLOJ}/player?lang=${lang}`,
      };
      if (sid) headers.Cookie = `hs_session=${sid}`;
      const r = await fetchWithTimeout(target, { headers }, 30000);
      if (!r.ok) {
        // Stale session — drop the cached sid so the next
        // playlist fetch gets a fresh one.
        sidCache.delete(lang);
        sendJson(res, r.status, { error: "segment " + r.status });
        return;
      }
      cors(res);
      res.writeHead(200, {
        "Content-Type": r.headers.get("content-type") || "video/MP2T",
        "Cache-Control": "no-store",
      });
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("aayush-bb-proxy listening on :" + PORT);
});
