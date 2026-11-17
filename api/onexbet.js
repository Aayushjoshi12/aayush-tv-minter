// api/onexbet.js — 1xBet scores proxy for the Aayush TV scoreboard.
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
// GET /api/onexbet (default: NPL)
//   -> { source: "1xbet", league: "Nepal Premier League",
//        mirror, fetchedAt, games: [...] }
//   NPL games come from main-line-feed/v3/leftMenuSports with
//   selectedMs for champ 2791573 ("Nepal. Premier league",
//   sport 66 = Cricket). Live scores are merged in from
//   main-live-feed/v3/topGamesByStat when the game is featured
//   there, and from the game's own scores object when present.
//   game: { id, league, home, away, homeScore, awayScore,
//           status, minute, clock, startTs, format }
//   status: "upcoming" | "live" | "FT". Cricket has no minutes;
//   the clock carries 1xBet's status line ("Event in progress").
//
//   LIVE-SCORE GAP (found 17 Nov 2026 ~17:05 NPT): once a game
//   goes live it LEAVES leftMenuSports, and it is not featured
//   in topGamesByStat either — so during play the strip showed
//   no live score at all. Fix: live scores are merged in from
//   the NPL official site's public API,
//   https://nplcricketleague.com/api/live-scores.php
//   (no CORS header, so it is fetched server-side here, same
//   pattern as 1xBet). That API lists only live/recent matches
//   (source: ESPN), so 1xBet stays the fixtures source and the
//   official API supplies the live score, matched by team name.
//   If the official fetch fails, the 1xBet list is returned
//   unchanged — the merge never breaks the fixtures.
// GET /api/onexbet?mode=featured
//   -> the old featured-games list (topGamesByStat only).
// GET /api/onexbet?debug=1
//   -> + { tried: [mirrors attempted] }
//
// The mirror host rotates; two known mirrors are tried in order.

const MIRRORS = [
  "https://1xlite-6229051.com",
  "https://1xlite-6428119.com",
];

// Champ 2791573 = Nepal Premier League (cricket, sport 66).
// selectedMs values are the same ones the 1xBet line page sends
// when the NPL page is open (captured 17 Nov 2026).
const NPL_CHAMP_ID = 2791573;
const NPL_MENU_PARAMS =
  "country=130&fcountry=130&gr=909&lng=en&ref=1" +
  "&selectedMs=1.66.2791573,2.66.2791573,10.66.2791573";

const TOP_PARAMS =
  "cfView=3&country=130&fcountry=130&gr=909&lng=en&ref=1";

// NPL official live-scores API (public JSON, source: ESPN).
// No Access-Control-Allow-Origin, so it is fetched server-side.
const NPL_LIVE_URL = "https://nplcricketleague.com/api/live-scores.php";
const NPL_LIVE_REFERER = "https://nplcricketleague.com/";

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
  // 1s strip polling: keep the edge cache tiny (2s) so a poll
  // almost always sees a fresh upstream fetch. This hammers
  // 1xBet/NPL harder than the old 10s cache — acceptable for
  // one live match, revisit if 1xBet starts throttling.
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=2, stale-while-revalidate=5"
  );
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function headersFor(base, refererPath) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: base + refererPath,
    "x-app-n": "__BETTING_APP__",
    "x-svc-source": "__BETTING_APP__",
    "x-requested-with": "XMLHttpRequest",
  };
}

async function fetchJson(base, path, refererPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(base + path, {
      headers: headersFor(base, refererPath),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// --- featured mode (topGamesByStat) -------------------------------

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

// 1xBet live cricket: the score (with wickets) and the overs live
// in scores.extendedScore — wicketScore "80/0", innsStats.overStr
// "5.1". chronoLine is empty for cricket, so this object is the
// ONLY 1xBet source for a live cricket score. The overs are
// cricket's timer on 1xBet (no ticking seconds clock like football).
function cricketLive(scores) {
  const ext = scores && scores.extendedScore;
  const wk = ext && ext.cricketScore && ext.cricketScore.wicketScore;
  if (!wk || wk.opponent1 === undefined || wk.opponent2 === undefined) return null;
  const inns = ext.innsStats || {};
  return {
    home: String(wk.opponent1),
    away: String(wk.opponent2),
    clock: inns.overStr ? String(inns.overStr) + " ov" : null,
  };
}

function teamKey(home, away) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z]/g, "");
  return norm(home) + "|" + norm(away);
}

function normalizeFeatured(g) {
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
  const ck = cricketLive(scores);
  return {
    id: String(id),
    league: (g.liga && g.liga.name) || "Unknown",
    home,
    away,
    homeScore: ck ? ck.home : (typeof hs === "number" ? hs : null),
    awayScore: ck ? ck.away : (typeof as === "number" ? as : null),
    status,
    minute,
    clock: (ck && ck.clock) || scores.statusLineStr || "",
    startTs: typeof g.startTs === "number" ? g.startTs : null,
    format: "",
    timerSec: (scores.timer && typeof scores.timer.timeSec === "number") ? scores.timer.timeSec : null,
  };
}

async function featuredGames(base) {
  const data = await fetchJson(
    base,
    "/service-api/main-live-feed/v3/topGamesByStat?" + TOP_PARAMS,
    "/en/live/football"
  );
  if (!Array.isArray(data)) throw new Error("unexpected body");
  return data.map(normalizeFeatured).filter(Boolean);
}

// --- NPL mode ------------------------------------------------------

function findNplGames(menu) {
  // menu = [{ menuSectionId, sports: [{ ligas: [{ id, games }] }] }]
  if (!Array.isArray(menu)) return null;
  for (const section of menu) {
    const sports = (section && section.sports) || [];
    for (const sport of sports) {
      const ligas = (sport && sport.ligas) || [];
      for (const liga of ligas) {
        if (liga && liga.id === NPL_CHAMP_ID) {
          return Array.isArray(liga.games) ? liga.games : [];
        }
      }
    }
  }
  return null;
}

function normalizeNpl(g, liveById, liveByName) {
  const o1 = g.opponent1 || {};
  const o2 = g.opponent2 || {};
  const home = o1.fullName || "";
  const away = o2.fullName || "";
  const id = g.id || g.mainGameId;
  if (!home || !away || !id) return null;
  // Live scores: the game's own scores object when present,
  // else the live-feed copy merged by game id — or by team name,
  // because a live game's id differs from its line game's id.
  const liveCopy =
    (liveById && liveById[String(id)]) ||
    (liveByName && liveByName[teamKey(home, away)]);
  const scores = g.scores || (liveCopy && liveCopy.scores) || null;
  const startTs = typeof g.startTs === "number" ? g.startTs : null;
  const nowSec = Math.floor(Date.now() / 1000);
  let status = "upcoming";
  let clock = "";
  let minute = null;
  if (scores) {
    const s = statusOf(scores);
    minute = s.minute;
    clock = scores.statusLineStr || "";
    if (s.status === "FT") status = "FT";
    else status = "live";
  } else if (startTs && startTs <= nowSec) {
    status = "live";
    clock = "Live";
  }
  const hs = scores ? scores.scoreOpp1 : null;
  const as = scores ? scores.scoreOpp2 : null;
  const ck = scores ? cricketLive(scores) : null;
  if (ck && ck.clock) clock = ck.clock;
  const info = g.matchInfoObj || {};
  return {
    id: String(id),
    league: "Nepal Premier League",
    home,
    away,
    homeScore: ck ? ck.home : (typeof hs === "number" ? hs : null),
    awayScore: ck ? ck.away : (typeof as === "number" ? as : null),
    status,
    minute,
    clock,
    startTs,
    format: info.matchFormat || "T20",
    timerSec: (scores && scores.timer && typeof scores.timer.timeSec === "number") ? scores.timer.timeSec : null,
  };
}

async function nplGames(base) {
  const referer = "/en/line/cricket/2791573-nepal-premier-league";
  const [menu, live, official] = await Promise.all([
    fetchJson(
      base,
      "/service-api/main-line-feed/v3/leftMenuSports?" + NPL_MENU_PARAMS,
      referer
    ),
    fetchJson(
      base,
      "/service-api/main-live-feed/v3/topGamesByStat?" + TOP_PARAMS,
      "/en/live/football"
    ).catch(() => null),
    nplLiveGames(),
  ]);
  const raw = findNplGames(menu);
  if (raw === null) throw new Error("NPL champ not in menu");
  const liveById = {};
  const liveByName = {};
  if (Array.isArray(live)) {
    for (const g of live) {
      const id = g.id || g.mainGameId;
      if (id) liveById[String(id)] = g;
      const h = (g.opponent1 || {}).fullName;
      const a = (g.opponent2 || {}).fullName;
      if (h && a) liveByName[teamKey(h, a)] = g;
    }
  }
  const games = raw.map((g) => normalizeNpl(g, liveById, liveByName)).filter(Boolean);
  // A live NPL game that left the line menu still shows up in the
  // featured live feed — add it from 1xBet directly (by league
  // name), so the strip can carry the 1xBet score, not just the
  // official one. Verified live 17 Nov 2026: a T10 cricket game
  // in topGamesByStat carried wicketScore + overStr.
  if (Array.isArray(live)) {
    for (const lg of live) {
      const lname = String((lg.liga && lg.liga.name) || "").toLowerCase();
      if (!lname.includes("nepal")) continue;
      const fg = normalizeFeatured(lg);
      if (!fg || !games.some((g) => sameTeams(g, fg))) games.push(fg);
    }
  }
  // Merge official live scores — but 1xBet wins: only overlay the
  // official score when the game has no 1xBet live score yet.
  // Live games first, then upcoming by kickoff.
  let usedOfficial = false;
  if (Array.isArray(official)) {
    for (const og of official) {
      const twin = games.find((g) => sameTeams(g, og));
      if (twin) {
        if (twin.homeScore == null && twin.awayScore == null) {
          twin.homeScore = og.homeScore;
          twin.awayScore = og.awayScore;
          twin.status = "live";
          twin.clock = og.clock;
          usedOfficial = true;
        }
      } else {
        games.push(og);
        usedOfficial = true;
      }
    }
  }
  games.sort((a, b) => {
    const rank = (g) => (g.status === "live" ? 0 : g.status === "FT" ? 2 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.startTs || 0) - (b.startTs || 0);
  });
  return { games, usedOfficial };
}

// --- NPL official live scores ------------------------------------

function nplScoreStr(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t ? t : null;
}

function normalizeNplLive(m) {
  if (!m || m.status !== "live") return null;
  const home = String(m.team1 || "").trim();
  const away = String(m.team2 || "").trim();
  if (!home || !away) return null;
  // The scorecard lists innings in order; the last one is the innings in
  // progress, so its overs are the current overs. (overs1/overs2 alone
  // can't tell which innings is current — the chasing team isn't always team1.)
  const _inns = (m.scorecard && m.scorecard.innings) || [];
  const _cur = _inns.length ? _inns[_inns.length - 1] : null;
  const overs =
    (_cur && nplScoreStr(_cur.overs)) ||
    nplScoreStr(m.overs1) ||
    nplScoreStr(m.overs2);
  return {
    id: "npl-" + String(m.id),
    league: "Nepal Premier League",
    home,
    away,
    homeScore: nplScoreStr(m.score1),
    awayScore: nplScoreStr(m.score2),
    status: "live",
    minute: null,
    clock: overs ? overs + " ov" : "Live",
    startTs: null,
    format: "T20",
    timerSec: null,
  };
}

async function nplLiveGames() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(NPL_LIVE_URL, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        Referer: NPL_LIVE_REFERER,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const matches = (data && data.matches) || [];
    return matches.map(normalizeNplLive).filter(Boolean);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function sameTeams(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  return norm(a.home) === norm(b.home) && norm(a.away) === norm(b.away);
}

// --- handler -------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  const debug = req.query && req.query.debug === "1";
  const featured = req.query && req.query.mode === "featured";
  const tried = [];
  let lastError = "";
  for (const base of MIRRORS) {
    tried.push(base);
    try {
      const result = featured
        ? { games: await featuredGames(base), usedOfficial: false }
        : await nplGames(base);
      const games = result.games;
      const out = {
        source: result.usedOfficial ? "1xbet+npl" : "1xbet",
        league: featured ? "featured" : "Nepal Premier League",
        mirror: base,
        fetchedAt: new Date().toISOString(),
        games: games.slice(0, MAX_GAMES),
      };
      if (debug) out.tried = tried;
      json(res, 200, out);
      return;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  const out = {
    source: "1xbet",
    league: featured ? "featured" : "Nepal Premier League",
    mirror: null,
    fetchedAt: new Date().toISOString(),
    games: [],
    error: "1xbet unreachable from this server",
    detail: lastError,
  };
  if (debug) out.tried = tried;
  json(res, 502, out);
}
