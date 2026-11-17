// api/onexbet.js — 1xBet featured live-scores proxy.
//
// The 1xBet lite mirror's service-api answers a plain GET with
// browser-like headers (no key, no login) — captured from the user's
// Chrome via the Muse Network Inspector, 17 Nov 2026. The dynamic
// `x-hd` header the browser sends is NOT needed (the endpoint
// answers 200 without it) and is never reproduced here.
//
// A browser on aayushlife.live cannot call the mirror directly
// (no Access-Control-Allow-Origin), so this function fetches it
// server-side and returns a small normalized JSON with CORS *.
//
// GET /api/onexbet
//   -> { source: "1xbet", mirror, fetchedAt, games: [...] }
//   game: { id, league, home, away, homeScore, awayScore,
//           status, minute, clock }
// GET /api/onexbet?debug=1
//   -> + { rawStatus, tried: [mirrors attempted] }
//
// Coverage limit: topGamesByStat returns only the games 1xBet
// features (~5 at a time), NOT every live match and NOT NPL.
// The mirror host rotates; two known mirrors are tried in order.

const MIRRORS = [
  "https://1xlite-6229051.com",
  "https://1xlite-6428119.com",
];

const PARAMS =
  "cfView=3&country=130&fcountry=130&gr=909&lng=en&ref=1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

const TIMEOUT_MS = 10000;
const MAX_GAMES = 12;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function json(res, status, obj) {
  cors(res);
  // Scores change fast, but 30s of edge caching keeps 1xBet
  // from being hammered by every visitor's poll.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=30, stale-while-revalidate=60"
  );
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function statusOf(scores) {
  if (!scores) return { status: "?", minute: null };
  const timer = scores.timer || {};
  let minute = null;
  if (typeof timer.timeSec === "number") {
    minute = Math.min(Math.floor(timer.timeSec / 60), 120);
  }
  if (minute === null) {
    const line = String(scores.statusLineStr || "").split(" ");
    const n = parseInt(line[0], 10);
    minute = Number.isFinite(n) ? n : null;
  }
  const line = String(scores.statusLineStr || "").toLowerCase();
  if (
    line.includes("half time") ||
    line.includes("half-time") ||
    line.includes("break")
  )
    return { status: "HT", minute };
  if (line.includes("full time") || line.includes("finished"))
    return { status: "FT", minute };
  const period = scores.currentPeriod;
  const pname = String(scores.currentPeriodName || "").toLowerCase();
  if (period === 1 || pname.includes("1st half")) return { status: "1H", minute };
  if (period === 2 || pname.includes("2nd half")) return { status: "2H", minute };
  if (period === 3 || period === 4 || pname.includes("extra"))
    return { status: "ET", minute };
  if (pname.includes("penalt")) return { status: "PEN", minute };
  return { status: scores.currentPeriodName || "?", minute };
}

function normalize(g) {
  const o1 = g.opponent1 || {};
  const o2 = g.opponent2 || {};
  const home = o1.fullName || "";
  const away = o2.fullName || "";
  const id = g.id || g.mainGameId;
  if (!home || !away || !id) return null;
  const scores = g.scores || {};
  const { status, minute } = statusOf(scores);
  const hs = scores.scoreOpp1;
  const as = scores.scoreOpp2;
  return {
    id: String(id),
    league: (g.liga && g.liga.name) || "Unknown",
    home,
    away,
    homeScore: typeof hs === "number" ? hs : null,
    awayScore: typeof as === "number" ? as : null,
    status,
    minute,
    clock: scores.statusLineStr || "",
  };
}

async function fetchGames(base) {
  const url =
    base + "/service-api/main-live-feed/v3/topGamesByStat?" + PARAMS;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: base + "/en/live/football",
        "x-app-n": "__BETTING_APP__",
        "x-svc-source": "__BETTING_APP__",
        "x-requested-with": "XMLHttpRequest",
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error("unexpected body");
    return { status: r.status, games: data.map(normalize).filter(Boolean) };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const debug = req.query && req.query.debug === "1";
  const tried = [];
  let lastError = "";
  for (const base of MIRRORS) {
    tried.push(base);
    try {
      const { status, games } = await fetchGames(base);
      const out = {
        source: "1xbet",
        mirror: base,
        fetchedAt: new Date().toISOString(),
        games: games.slice(0, MAX_GAMES),
      };
      if (debug) {
        out.rawStatus = status;
        out.tried = tried;
      }
      json(res, 200, out);
      return;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  const out = {
    source: "1xbet",
    mirror: null,
    fetchedAt: new Date().toISOString(),
    games: [],
    error: "1xbet unreachable from this server",
    detail: lastError,
  };
  if (debug) out.tried = tried;
  json(res, 502, out);
}
