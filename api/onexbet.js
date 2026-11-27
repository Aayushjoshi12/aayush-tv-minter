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
// GET /api/onexbet?mode=search&q=<text>
//   -> { games: [...], detail: {...} | null, q }
//   Numeric q = a 1xBet game ID: the live list is searched by id
//   and the hit is enriched with live gameInfo (venue, weather,
//   format, constId). Text q = team/league name: live games
//   (games1x2) plus the NPL and UEFA fixtures the scoreboard
//   already knows. The line feed has no general search, so
//   upcoming coverage is NPL + UEFA only — the reply never
//   pretends otherwise. A tap on a search row calls the same
//   mode with that game's id to get its full detail.
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
  // Innings break (isBreak / "Half-time"): the overs read 0.0
  // for the innings that hasn't started — say so plainly
  // instead of showing "0.0 ov".
  let clock = inns.overStr ? String(inns.overStr) + " ov" : null;
  if (scores && scores.isBreak) clock = "Innings break";
  else {
    const pn = String(scores.currentPeriodName || "");
    if (pn === "1st innings" || pn === "2nd innings")
      clock = pn + " · " + clock;
  }
  return {
    home: String(wk.opponent1),
    away: String(wk.opponent2),
    clock,
  };
}

// Current-innings run rate, from the scorecard JSON string in
// scores.statistic.main.InningsStatistic ("13,62" -> "13.62").
// Individual batsman/bowler names are NOT in this payload
// (names are null, only player ids), so no scorecard names.
function cricketRunRate(scores) {
  try {
    const main = scores && scores.statistic && scores.statistic.main;
    const raw = main && main.InningsStatistic;
    if (!raw) return null;
    const data = JSON.parse(raw);
    const st = data && Array.isArray(data.St) ? data.St[0] : null;
    const rr = st && st.RR ? String(st.RR).replace(",", ".") : "";
    return rr ? rr : null;
  } catch (e) {
    return null;
  }
}

// Raw cricket detail carried through normalization; the target
// is computed in gameDetail, where the format is known.
function cricketRaw(scores) {
  const ext = scores && scores.extendedScore;
  const inns = (ext && ext.innsStats) || {};
  return {
    isBreak: scores ? scores.isBreak === true : false,
    team: typeof inns.team === "number" ? inns.team : null,
    overStr: inns.overStr ? String(inns.overStr) : null,
    runRate: cricketRunRate(scores),
  };
}

// --- NPL scorecard (Cricinfo-style detail, Advanced) -----------------
// 1xBet's own feed carries NO batsman or bowler names (its
// InningsStatistic payload has player ids only, names null), so
// the scorecard comes from the NPL official API instead — the
// same source the scoreboard already uses as its fallback.
// Its `live` block names the striker / non-striker, the current
// bowler, partnership, last wicket, run rate and last over, and
// the scorecard carries the full batting + bowling card of the
// innings in progress. Non-NPL cricket has no such source, so
// it keeps the 1xBet-only rows and shows no scorecard.
let nplRawCache = { ts: 0, data: null };
async function fetchNplRaw() {
  const now = Date.now();
  if (nplRawCache.data && now - nplRawCache.ts < 10000)
    return nplRawCache.data;
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
    nplRawCache = { ts: now, data };
    return data;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function nplScorecard(data, home, away) {
  if (!data || typeof data !== "object") return null;
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  const matches = (data && data.matches) || [];
  for (const m of matches) {
    if (!m || m.status !== "live") continue;
    const teams = new Set([norm(m.team1), norm(m.team2)]);
    if (teams.has("") || !teams.has(norm(home)) || !teams.has(norm(away)))
      continue;
    const live = m.live || {};
    const batters = live.batters || [];
    if (!Array.isArray(batters) || !batters.length) return null;
    const bat = (b) => ({
      name: String(b.name || ""),
      runs: String(b.runs ?? ""),
      balls: String(b.balls ?? ""),
      fours: String(b.fours ?? ""),
      sixes: String(b.sixes ?? ""),
      sr: String(b.sr ?? ""),
      dismissal: String(b.dismissal || ""),
    });
    const bowl = (b) => ({
      name: String(b.name || ""),
      overs: String(b.overs ?? ""),
      maidens: String(b.maidens ?? ""),
      runs: String(b.runs ?? ""),
      wickets: String(b.wickets ?? ""),
      econ: String(b.econ ?? ""),
    });
    let striker = null;
    let nonStriker = null;
    for (const b of batters) {
      if (!b || typeof b !== "object") continue;
      if (b.striker === true) striker = bat(b);
      else if (b.striker === false) nonStriker = bat(b);
    }
    let bowler = null;
    for (const b of live.bowlers || []) {
      if (b && typeof b === "object" && b.current === true) {
        bowler = bowl(b);
        break;
      }
    }
    const lw = live.lastWicket || {};
    const inns = ((m.scorecard || {}).innings) || [];
    const cur = inns.length ? inns[inns.length - 1] : {};
    const batting = ((cur.batting || []).filter(
      (b) => b && b.name
    )).map(bat);
    for (const b of batting) {
      if (striker && b.name === striker.name) b.onStrike = true;
      else if (nonStriker && b.name === nonStriker.name)
        b.onStrike = false;
    }
    return {
      statusText: String(m.statusText || ""),
      striker,
      nonStriker,
      bowler,
      partnership: String(live.partnership || ""),
      lastWicket: lw.name
        ? {
            name: String(lw.name || ""),
            runs: String(lw.runs ?? ""),
            balls: String(lw.balls ?? ""),
            dismissal: String(lw.dismissal || ""),
            fow: String(lw.fow ?? ""),
            over: String(lw.over ?? ""),
          }
        : null,
      crr: String(live.crr || ""),
      lastOver: String(live.lastOver || ""),
      batting,
      bowling: ((cur.bowling || []).filter(
        (b) => b && b.name
      )).map(bowl),
    };
  }
  return null;
}

function parseRuns(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v.split("/")[0], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Chasing target for a limited-overs cricket game: the team
// batting second needs first-innings + 1. Only when the format
// is limited-overs (Tests have no fixed target this way) and
// team 2 is batting. Balls left from the format's total.
function addCricketTarget(out) {
  const c = out.cricket;
  if (!c) return;
  const fmt = String(out.format || "");
  const limited =
    fmt.includes("T20") ||
    fmt.includes("T10") ||
    fmt.includes("ODI") ||
    fmt.includes("One Day") ||
    fmt.includes("Hundred");
  if (!limited || c.team !== 2) return;
  const first = parseRuns(out.homeScore);
  const second = parseRuns(out.awayScore);
  if (first == null || second == null) return;
  c.target = first + 1;
  c.need = Math.max(0, c.target - second);
  const totalBalls = fmt.includes("T20")
    ? 120
    : fmt.includes("T10")
      ? 60
      : fmt.includes("ODI") || fmt.includes("One Day")
        ? 300
        : fmt.includes("Hundred")
          ? 100
          : null;
  if (totalBalls != null && c.overStr) {
    const parts = String(c.overStr).split(".");
    const bowled =
      (parseInt(parts[0], 10) || 0) * 6 + (parseInt(parts[1], 10) || 0);
    c.ballsLeft = Math.max(0, totalBalls - bowled);
  }
}

// Live match stats (1xBet's own table): cards, corners,
// attacks, possession, shots, xG, saves, subs... The list
// varies by game — some games carry 15 stats, others 4, and
// fouls are not in it. Rendered in the detail card, in this
// order first (the ones people ask for), then the rest as 1xBet
// sends them.
function tabloStats(scores) {
  const t = scores && scores.tabloStats;
  const arr =
    t && Array.isArray(t["0"]) ? t["0"] : Array.isArray(t) ? t : null;
  if (!arr) return null;
  const order = [
    "Yellow cards", "Red card", "Corner", "Fouls",
    "Attacks", "Dangerous attacks", "Possession %",
    "Shots on target", "Shots off target", "xG", "Saves",
    "Penalty", "Substitutions", "Key Passes",
    "Passing Accuracy %", "Crosses",
  ];
  const list = arr
    .filter((x) => x && x.name != null)
    .map((x) => ({
      name: String(x.name),
      home: String(x.s1 === undefined || x.s1 === null ? "" : x.s1),
      away: String(x.s2 === undefined || x.s2 === null ? "" : x.s2),
    }));
  list.sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  return list.length ? list : null;
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
  // statusOf reports the period ("1H"/"2H"/"ET"/"PEN") — but the
  // site only renders the ticking clock for status "live", so a
  // live game reported as "2H" showed a frozen minute instead of
  // a ticking timer (found 17 Nov 2026). In-play periods are all
  // "live" here; the period is kept separately for the label.
  const period = status;
  const hasScore =
    typeof hs === "number" || typeof as === "number" || Boolean(ck);
  const liveStatus =
    status === "FT" || status === "HT"
      ? status
      : hasScore
        ? "live"
        : status;
  return {
    id: String(id),
    league: (g.liga && g.liga.name) || "Unknown",
    home,
    away,
    homeScore: ck ? ck.home : (typeof hs === "number" ? hs : null),
    awayScore: ck ? ck.away : (typeof as === "number" ? as : null),
    status: liveStatus,
    period,
    minute,
    clock: (ck && ck.clock) || scores.statusLineStr || "",
    startTs: typeof g.startTs === "number" ? g.startTs : null,
    format: "",
    timerSec: (scores.timer && typeof scores.timer.timeSec === "number") ? scores.timer.timeSec : null,
    stats: tabloStats(scores),
    cricket: ck ? cricketRaw(scores) : null,
    // Stream: the raw live entry carries video {enabled, id} —
    // the id is the DR_ id the minter mints from (same as the
    // Discord bot's Watch link). Added 27 Nov 2026 for the
    // site Scoreboard page; null when no stream exists.
    videoId: (g.video && g.video.id) ? String(g.video.id) : null,
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
  // Stream id: the raw entry's video {enabled, id}, else the
  // live-feed copy's (same DR_ id the bot's Watch link uses).
  const vid = (g.video && g.video.id) || (liveCopy && liveCopy.video && liveCopy.video.id) || null;
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
    stats: tabloStats(scores),
    videoId: vid ? String(vid) : null,
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

// --- UEFA (Scoreboard section) --------------------------------------
// Live UEFA games come from the live feed's games1x2 list (all live
// games, count=50 is the max the endpoint accepts — 60+ returns
// 400). Tonight's live UEFA games are the U19 Euro qualifiers.
// Upcoming fixtures come from the line feed for the same champ
// ids, discovered from the live games themselves.
const UEFA_MAX_CHAMPS = 3;
const UEFA_MAX_GAMES = 12;

function isUefaLiga(name) {
  return String(name || "").toLowerCase().includes("uefa");
}

function findLigaGames(menu, champId) {
  if (!Array.isArray(menu)) return null;
  for (const section of menu) {
    const sports = (section && section.sports) || [];
    for (const sport of sports) {
      const ligas = (sport && sport.ligas) || [];
      for (const liga of ligas) {
        if (liga && liga.id === champId) {
          return { name: liga.name || "UEFA", games: Array.isArray(liga.games) ? liga.games : [] };
        }
      }
    }
  }
  return null;
}

// Line-feed game (fixtures + any live game still listed): same
// shape as the NPL normalizer, but with the caller's league name.
function normalizeUefaLine(g, league) {
  const o1 = g.opponent1 || {};
  const o2 = g.opponent2 || {};
  const home = o1.fullName || "";
  const away = o2.fullName || "";
  const id = g.id || g.mainGameId;
  if (!home || !away || !id) return null;
  const scores = g.scores || null;
  const startTs = typeof g.startTs === "number" ? g.startTs : null;
  const nowSec = Math.floor(Date.now() / 1000);
  let status = "upcoming";
  let clock = "";
  let minute = null;
  if (scores) {
    const st = statusOf(scores);
    minute = st.minute;
    clock = scores.statusLineStr || "";
    if (st.status === "FT") status = "FT";
    else status = "live";
  } else if (startTs && startTs <= nowSec) {
    status = "live";
    clock = "Live";
  }
  const ck = scores ? cricketLive(scores) : null;
  if (ck && ck.clock) clock = ck.clock;
  return {
    id: String(id),
    league,
    home,
    away,
    homeScore: ck ? ck.home : (scores && typeof scores.scoreOpp1 === "number" ? scores.scoreOpp1 : null),
    awayScore: ck ? ck.away : (scores && typeof scores.scoreOpp2 === "number" ? scores.scoreOpp2 : null),
    status,
    minute,
    clock,
    startTs,
    format: "",
    timerSec: (scores && scores.timer && typeof scores.timer.timeSec === "number") ? scores.timer.timeSec : null,
    stats: tabloStats(scores),
    videoId: (g.video && g.video.id) ? String(g.video.id) : null,
  };
}

async function uefaGames(base) {
  const out = [];
  let champIds = [];
  try {
    const data = await fetchJson(
      base,
      "/service-api/main-live-feed/v3/games1x2?cfView=3&count=50&country=130&fcountry=130&gr=909&grMode=4&lng=en&ref=1",
      "/en/live/football"
    );
    if (Array.isArray(data)) {
      for (const g of data) {
        const lname = (g.liga && g.liga.name) || "";
        if (!isUefaLiga(lname)) continue;
        const fg = normalizeFeatured(g);
        if (fg) {
          out.push(fg);
          if (g.liga.id && !champIds.includes(g.liga.id)) champIds.push(g.liga.id);
        }
      }
    }
  } catch (e) {
    // Live list failed — upcoming fixtures below still work.
  }
  // Upcoming fixtures for the same UEFA champs (line feed).
  for (const cid of champIds.slice(0, UEFA_MAX_CHAMPS)) {
    try {
      const menu = await fetchJson(
        base,
        "/service-api/main-line-feed/v3/leftMenuSports?country=130&fcountry=130&gr=909&lng=en&ref=1" +
          "&selectedMs=1.1." + cid + ",2.1." + cid + ",10.1." + cid,
        "/en/line/football"
      );
      const found = findLigaGames(menu, cid);
      if (!found) continue;
      for (const g of found.games) {
        const ng = normalizeUefaLine(g, found.name);
        if (ng && !out.some((x) => sameTeams(x, ng))) out.push(ng);
      }
    } catch (e) {
      // One champ failing must not break the section.
    }
  }
  out.sort((a, b) => {
    const rank = (g) => (g.status === "live" ? 0 : g.status === "FT" ? 2 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.startTs || 0) - (b.startTs || 0);
  });
  return out.slice(0, UEFA_MAX_GAMES);
}

// --- search mode ---------------------------------------------------
// Find a game by team/league name or by 1xBet game ID, with the
// full detail 1xBet shows for it. gameInfo (live feed) carries
// venue, weather, format, constId and line-up flags — but NO
// scores and NO odds, so those come from the live list entry
// (games1x2) instead. Betting odds are NOT available from any
// endpoint used here, so the detail card never shows them.
const SEARCH_MAX = 10;

function detailFromInfo(info) {
  if (!info || typeof info !== "object") return {};
  const mi = info.matchInfoObj || {};
  const weather = mi.weatherDescription
    ? mi.weatherDescription + (mi.temperature ? " · " + mi.temperature : "")
    : null;
  const out = {
    constId:
      info.constId != null
        ? String(info.constId)
        : info.mainConstId != null
          ? String(info.mainConstId)
          : null,
    sport: (info.sport && info.sport.name) || null,
    venue: mi.location || null,
    format: mi.matchFormat || null,
    weather,
    hasLineups: Boolean(info.statisticInfo && info.statisticInfo.hasLineUps),
    hasStadium: Boolean(
      info.statisticInfo && info.statisticInfo.hasStadiumInfo
    ),
    video: Boolean(info.video && info.video.enabled),
  };
  // Only include videoId when gameInfo actually carries one —
  // the merge in gameDetail must never overwrite the raw live
  // entry's id with null (the raw entry is the authority).
  if (info.video && info.video.id) out.videoId = String(info.video.id);
  return out;
}

async function gameDetail(base, g) {
  // Enrich a normalized live game with live gameInfo. A failed
  // detail call never fails the search — the game still shows.
  let extra = {};
  try {
    const info = await fetchJson(
      base,
      "/service-api/main-live-feed/v3/gameInfo?fcountry=130&gameId=" +
        encodeURIComponent(g.id) +
        "&gr=909&lng=en&ref=1",
      "/en/live/football"
    );
    extra = detailFromInfo(info);
  } catch (e) {
    extra = {};
  }
  const merged = Object.assign({}, g, extra);
  // The raw live entry is the authority for the stream id —
  // never let gameInfo's copy replace it.
  if (g.videoId) merged.videoId = g.videoId;
  addCricketTarget(merged);
  // NPL cricket only: the full scorecard (striker, bowler,
  // partnership...) comes from the NPL official API — the
  // 1xBet feed carries no player names at all. A failed or
  // absent scorecard never fails the detail.
  if (merged.cricket && String(g.league || "").toLowerCase().includes("nepal")) {
    try {
      const raw = await fetchNplRaw();
      const card = raw ? nplScorecard(raw, g.home, g.away) : null;
      if (card) merged.cricket.scorecard = card;
    } catch (e) {}
  }
  return merged;
}

async function searchGames(base, q) {
  const query = String(q || "").trim();
  if (!query) return { games: [], detail: null };
  const isId = /^\d{5,}$/.test(query);
  // Live list (all sports, up to 50) — the score/timer source.
  // Plus the featured list: a game can be featured
  // (topGamesByStat) without being in the first 50 of the live
  // list — Sierra Leone vs DR Congo (id 771747795) was exactly
  // that on 17 Nov 2026, so an ID search found only the
  // score-less gameInfo and the card showed "Live" with no score
  // and no stats. Merge featured in so both paths see it.
  let live = [];
  try {
    const data = await fetchJson(
      base,
      "/service-api/main-live-feed/v3/games1x2?cfView=3&count=50&country=130&fcountry=130&gr=909&grMode=4&lng=en&ref=1",
      "/en/live/football"
    );
    if (Array.isArray(data))
      live = data.map(normalizeFeatured).filter(Boolean);
  } catch (e) {
    live = [];
  }
  try {
    const feat = await fetchJson(
      base,
      "/service-api/main-live-feed/v3/topGamesByStat?" + TOP_PARAMS,
      "/en/live/football"
    );
    if (Array.isArray(feat)) {
      for (const g of feat.map(normalizeFeatured).filter(Boolean)) {
        if (!live.some((x) => x.id === g.id)) live.push(g);
      }
    }
  } catch (e) {}
  if (isId) {
    const hit = live.find((g) => g.id === query);
    if (hit) return { games: [], detail: await gameDetail(base, hit) };
    // The searched id may be an ALIAS of the live game, not the
    // live id itself — e.g. 771747795 is a sub-game id for Sierra
    // Leone vs DR Congo, whose live id is 771747706. gameInfo
    // carries mainGameId (the live id), so resolve through it
    // and retry the live list before giving up on the score.
    // Not live right now — the live gameInfo may still answer
    // (a finished game, or one between lists). No score there,
    // so the detail stands on its own.
    try {
      const info = await fetchJson(
        base,
        "/service-api/main-live-feed/v3/gameInfo?fcountry=130&gameId=" +
          encodeURIComponent(query) +
          "&gr=909&lng=en&ref=1",
        "/en/live/football"
      );
      if (info && info.id) {
        const mainId =
          info.mainGameId != null ? String(info.mainGameId) : null;
        if (mainId && mainId !== query) {
          const mainHit = live.find((g) => g.id === mainId);
          if (mainHit)
            return { games: [], detail: await gameDetail(base, mainHit) };
        }
        const d = {
          id: String(info.id),
          league: (info.liga && info.liga.name) || "Unknown",
          home: (info.opponent1 && info.opponent1.fullName) || "",
          away: (info.opponent2 && info.opponent2.fullName) || "",
          homeScore: null,
          awayScore: null,
          status: "?",
          period: "",
          minute: null,
          clock: "Score not available right now",
          startTs: typeof info.startTs === "number" ? info.startTs : null,
          format: "",
          timerSec: null,
        };
        return { games: [], detail: Object.assign(d, detailFromInfo(info)) };
      }
    } catch (e) {}
    return { games: [], detail: null };
  }
  // Text search: live games by team/league name, then the NPL
  // and UEFA fixtures the scoreboard already fetches.
  const needle = query.toLowerCase();
  const match = (g) =>
    String(g.home || "").toLowerCase().includes(needle) ||
    String(g.away || "").toLowerCase().includes(needle) ||
    String(g.league || "").toLowerCase().includes(needle);
  const out = [];
  const push = (g) => {
    if (!g || !match(g)) return;
    if (out.some((x) => x.id === g.id || sameTeams(x, g))) return;
    out.push(g);
  };
  live.forEach(push);
  if (out.length < SEARCH_MAX) {
    try {
      const res = await nplGames(base);
      res.games.forEach(push);
    } catch (e) {}
  }
  if (out.length < SEARCH_MAX) {
    try {
      const uefa = await uefaGames(base);
      uefa.forEach(push);
    } catch (e) {}
  }
  return { games: out.slice(0, SEARCH_MAX), detail: null };
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
  const mode = (req.query && req.query.mode) || "";
  const featured = mode === "featured";
  const scoreboard = mode === "scoreboard";
  const search = mode === "search";
  const tried = [];
  let lastError = "";
  for (const base of MIRRORS) {
    tried.push(base);
    try {
      if (search) {
        const r = await searchGames(base, (req.query && req.query.q) || "");
        const out = {
          source: "1xbet",
          league: "Search",
          mirror: base,
          fetchedAt: new Date().toISOString(),
          games: r.games,
          detail: r.detail,
          q: (req.query && req.query.q) || "",
        };
        if (debug) out.tried = tried;
        json(res, 200, out);
        return;
      }
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
      if (scoreboard) {
        // Scoreboard section: NPL + UEFA side by side. UEFA must
        // never break the NPL half, so it is fetched separately.
        let uefa = [];
        try {
          uefa = await uefaGames(base);
        } catch (e) {
          uefa = [];
        }
        out.npl = out.games;
        out.uefa = uefa;
        out.league = "Scoreboard";
      }
      if (debug) out.tried = tried;
      json(res, 200, out);
      return;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  const out = {
    source: "1xbet",
    league: featured ? "featured" : search ? "Search" : "Nepal Premier League",
    mirror: null,
    fetchedAt: new Date().toISOString(),
    games: [],
    error: "1xbet unreachable from this server",
    detail: lastError,
  };
  if (debug) out.tried = tried;
  json(res, 502, out);
}
