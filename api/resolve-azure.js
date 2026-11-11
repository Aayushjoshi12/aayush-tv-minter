// resolve-azure.js — the same Premium resolver, written for
// Azure Functions (Node.js v4 programming model) so the Azure
// minter host can serve it as a backup to Vercel.
//
// WHY A SEPARATE FILE: the Azure host is a Function App, not
// Vercel — it does not run the Vercel-style `export default
// handler(req, res)` in api/resolve.js, which is why /api/resolve
// on Azure returns 404 today. This file uses the Azure model
// (`app.http(...)`) and does exactly the same job: fetch the
// player page with the required Referer header, decode the hidden
// player script, fetch the ticket blob, XOR-decrypt it into a
// fresh signed .m3u8 URL.
//
// DEPLOY (Azure Portal): open the Function App
// aayush-tv-minter, go to Functions → Create → HTTP trigger,
// name it `resolve`, choose Node.js, then replace the generated
// code with this file (and make sure @azure/functions is
// available — it is preinstalled in the v4 Node.js worker).
// Auth level must be Anonymous so the public site can call it.
// After deploying, test:
//   https://<app>.azurewebsites.net/api/resolve?ch=dazn-laliga
// should return {"url": "https://...m3u8", "expires": ...}.
//
// ENDPOINT: GET /api/resolve?ch=<key>
//   -> 200 {"url", "expires"} on success
//   -> 400 on unknown key, 502 if the player page / ticket fails

const { app } = require("@azure/functions");

const PLAYER_BASE = "https://ehgembxe.cfd/bintv/";
const PLAYER_REFERER = "https://bintv-sources.pages.dev/";

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

app.http("resolve", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      return { status: 204, headers };
    }
    const key = request.query.get("ch");
    const path = CHANNELS[key];
    if (!path) {
      return { status: 400, headers, jsonBody: { error: "Unknown channel" } };
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
      const expires = parseInt(url.split("/").slice(-2, -1)[0], 10) || null;
      return { status: 200, headers, jsonBody: { url, expires } };
    } catch (e) {
      context.log("resolve failed:", e.message);
      return { status: 502, headers, jsonBody: { error: "Upstream error" } };
    }
  },
});
