"""onexbet-search — 1xBet search on the aayushbot VM.

Why this exists (28 Nov 2026): the Live Sports search dropdown calls the
Vercel proxy (api/onexbet.js ?mode=search), but Vercel's egress IPs are
now intermittently blocked by the 1xBet mirror's gateway — the search hung
past 60s and the board 502'd, while the same calls answer in ~1s from
other IPs. The aayushbot VM (static IP 20.196.196.203) reaches the mirror
in 0.79s (verified live from the VM via Cloud Shell, 28 Nov 23:38 NPT),
so the search runs here instead.

This is a faithful port of the TEXT + ID branches of searchGames() from
api/onexbet.js (Aayushjoshi12/aayush-tv-minter), same response shape:
  GET /search?q=<text|id> -> {source, league:"Search", mirror,
    fetchedAt, games:[...], detail:{...}|null, q}

Scope (phase 1, 28 Nov 2026): live games + upcoming fixtures of the
known big leagues (KNOWN_CHAMPS + KNOWN_LEAGUES). NOT ported yet:
  - the NPL + UEFA fixtures legs (NPL season is over; UCL is already
    in KNOWN_CHAMPS, so the dropdown loses nothing for football)
  - the NPL cricket scorecard in gameDetail (needs the NPL official API)
  - addCricketTarget (Target/Need for cricket detail panels)
The board/featured/NPL modes still run on Vercel; only the search
(dropdown + Find + detail-by-id) comes here. If the VM endpoint ever
fails, the site falls back to the Vercel search.
"""
import asyncio
import json
import re
import time
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

MIRRORS = [
    "https://1xlite-6229051.com",
    "https://1xlite-6428119.com",  # down as of 28 Nov 2026; kept as fallback
]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
)
TIMEOUT_S = 10.0
TOP_PARAMS = "cfView=3&country=130&fcountry=130&gr=909&lng=en&ref=1"
SEARCH_MAX = 10

KNOWN_CHAMPS = [
    {"sportId": 1, "id": 127733, "name": "Spain. La Liga"},
    {"sportId": 1, "id": 88637, "name": "England. Premier League"},
    {"sportId": 1, "id": 110163, "name": "Italy. Serie A"},
    {"sportId": 1, "id": 96463, "name": "Germany. Bundesliga"},
    {"sportId": 1, "id": 12821, "name": "France. Ligue 1"},
    {"sportId": 1, "id": 3007689, "name": "Portugal. Primeira Liga"},
    {"sportId": 1, "id": 118587, "name": "UEFA Champions League"},
]
KNOWN_LEAGUES = [
    {"sportId": 66, "id": 1852059, "name": "Big Bash League. Women"},
    {"sportId": 66, "id": 2148332, "name": "Quaid e-Azam Trophy"},
    {"sportId": 3, "id": 24625, "name": "WKBL"},
    {"sportId": 3, "id": 258051, "name": "WNBL"},
    {"sportId": 6, "id": 122261, "name": "South Korea Championship"},
    {"sportId": 6, "id": 2768529, "name": "SV.League"},
]

SPORT_NAMES = {
    1: "Football", 2: "Ice Hockey", 3: "Basketball", 4: "Tennis",
    5: "Baseball", 6: "Volleyball", 40: "Esports", 66: "Cricket",
}

SEARCH_ALIASES = {
    "barca": "barcelona", "blaugrana": "barcelona",
    "madrid": "real madrid", "real": "real madrid",
    "atleti": "atletico madrid", "atletico": "atletico madrid",
    "man utd": "manchester united", "man united": "manchester united",
    "man city": "manchester city", "city": "manchester city",
    "spurs": "tottenham", "tottenham hotspur": "tottenham",
    "juve": "juventus",
    "rossoneri": "milan", "ac milan": "milan",
    "bayern": "bayern munich",
    "dortmund": "borussia dortmund", "bvb": "borussia dortmund",
    "psg": "paris saint-germain", "paris": "paris saint-germain",
    "psv": "psv eindhoven", "sporting": "sporting cp",
}

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _headers(base, referer_path):
    return {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": base + referer_path,
        "x-app-n": "__BETTING_APP__",
        "x-svc-source": "__BETTING_APP__",
        "x-requested-with": "XMLHttpRequest",
    }


async def fetch_json(client, base, path, referer_path, timeout=TIMEOUT_S):
    """GET + parse JSON. Raises on non-2xx and on a non-JSON (block) page,
    exactly like the Vercel fetchJson (r.ok check + r.json())."""
    r = await client.get(
        base + path,
        headers=_headers(base, referer_path),
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


# --- score helpers (ported from onexbet.js) ---------------------------

def status_of(scores):
    if not scores:
        return {"status": "?", "minute": None}
    timer = scores.get("timer") or {}
    minute = None
    if _is_num(timer.get("timeSec")):
        minute = min(int(timer["timeSec"] // 60), 120)
    if minute is None:
        parts = str(scores.get("statusLineStr") or "").split(" ")
        try:
            n = int(parts[0])
        except (ValueError, IndexError):
            n = None
        minute = n
    line = str(scores.get("statusLineStr") or "").lower()
    if "half time" in line or "half-time" in line or "break" in line:
        return {"status": "HT", "minute": minute}
    if "full time" in line or "finished" in line:
        return {"status": "FT", "minute": minute}
    period = scores.get("currentPeriod")
    pname = str(scores.get("currentPeriodName") or "")
    pl = pname.lower()
    if "1st half" in pl:
        return {"status": "1H", "minute": minute}
    if "2nd half" in pl:
        return {"status": "2H", "minute": minute}
    if "extra" in pl:
        return {"status": "ET", "minute": minute}
    if "penalt" in pl:
        return {"status": "PEN", "minute": minute}
    if "half-time" in pl or "half time" in pl or "break" in pl:
        return {"status": "HT", "minute": minute}
    if "full-time" in pl or "full time" in pl or "finished" in pl:
        return {"status": "FT", "minute": minute}
    if pname:
        return {"status": pname, "minute": minute}
    if period == 1:
        return {"status": "1H", "minute": minute}
    if period == 2:
        return {"status": "2H", "minute": minute}
    if period in (3, 4):
        return {"status": "ET", "minute": minute}
    return {"status": "?", "minute": minute}


def sport_of(g):
    sp = (g or {}).get("sport") or {}
    return {
        "sportId": sp.get("id") if _is_num(sp.get("id")) else None,
        "sportName": str(sp["name"]) if sp.get("name") else None,
    }


def period_info(scores):
    if not scores:
        return {"periodScoresStr": None, "currentPeriodName": None}
    return {
        "periodScoresStr": str(scores["periodScoresStr"])
        if scores.get("periodScoresStr") else None,
        "currentPeriodName": str(scores["currentPeriodName"])
        if scores.get("currentPeriodName") else None,
    }


def cricket_live(scores):
    ext = (scores or {}).get("extendedScore") or {}
    wk = ((ext.get("cricketScore") or {}).get("wicketScore")) or {}
    if wk.get("opponent1") is None or wk.get("opponent2") is None:
        return None
    inns = ext.get("innsStats") or {}
    clock = str(inns["overStr"]) + " ov" if inns.get("overStr") else None
    if scores and scores.get("isBreak"):
        clock = "Innings break"
    else:
        pn = str(scores.get("currentPeriodName") or "")
        if pn in ("1st innings", "2nd innings"):
            clock = pn + " · " + clock
    return {"home": str(wk["opponent1"]), "away": str(wk["opponent2"]), "clock": clock}


def cricket_run_rate(scores):
    try:
        main = ((scores or {}).get("statistic") or {}).get("main") or {}
        raw = main.get("InningsStatistic")
        if not raw:
            return None
        data = json.loads(raw)
        st = data.get("St") if isinstance(data, dict) else None
        st = st[0] if isinstance(st, list) and st else None
        rr = str(st["RR"]).replace(",", ".") if st and st.get("RR") else ""
        return rr or None
    except Exception:
        return None


def cricket_raw(scores):
    ext = (scores or {}).get("extendedScore") or {}
    inns = ext.get("innsStats") or {}
    return {
        "isBreak": bool(scores and scores.get("isBreak") is True),
        "team": inns["team"] if _is_num(inns.get("team")) else None,
        "overStr": str(inns["overStr"]) if inns.get("overStr") else None,
        "runRate": cricket_run_rate(scores),
    }


def tablo_stats(scores):
    t = (scores or {}).get("tabloStats")
    arr = None
    if isinstance(t, dict) and isinstance(t.get("0"), list):
        arr = t["0"]
    elif isinstance(t, list):
        arr = t
    if not arr:
        return None
    order = [
        "Yellow cards", "Red card", "Corner", "Fouls",
        "Attacks", "Dangerous attacks", "Possession %",
        "Shots on target", "Shots off target", "xG", "Saves",
        "Penalty", "Substitutions", "Key Passes",
        "Passing Accuracy %", "Crosses",
    ]
    out = []
    for x in arr:
        if not x or x.get("name") is None:
            continue
        out.append({
            "name": str(x["name"]),
            "home": "" if x.get("s1") is None else str(x["s1"]),
            "away": "" if x.get("s2") is None else str(x["s2"]),
        })
    out.sort(key=lambda a: order.index(a["name"]) if a["name"] in order else 99)
    return out or None


def _norm_name(s):
    return re.sub(r"[^a-z]", "", str(s or "").lower())


def same_teams(a, b):
    return _norm_name(a.get("home")) == _norm_name(b.get("home")) and \
        _norm_name(a.get("away")) == _norm_name(b.get("away"))


def normalize_featured(g):
    o1 = g.get("opponent1") or {}
    o2 = g.get("opponent2") or {}
    home = o1.get("fullName") or ""
    away = o2.get("fullName") or ""
    gid = g.get("id") or g.get("mainGameId")
    if not home or not away or not gid:
        return None
    scores = g.get("scores") or {}
    st = status_of(scores)
    status, minute = st["status"], st["minute"]
    hs, as_ = scores.get("scoreOpp1"), scores.get("scoreOpp2")
    ck = cricket_live(scores)
    sp = sport_of(g)
    pi = period_info(scores)
    period = status
    has_score = _is_num(hs) or _is_num(as_) or bool(ck)
    if status in ("FT", "HT"):
        live_status = status
    elif has_score:
        live_status = "live"
    else:
        live_status = status
    liga = g.get("liga") or {}
    video = g.get("video") or {}
    timer = scores.get("timer") or {}
    return {
        "id": str(gid),
        "league": liga.get("name") or "Unknown",
        "home": home,
        "away": away,
        "homeScore": ck["home"] if ck else (hs if _is_num(hs) else None),
        "awayScore": ck["away"] if ck else (as_ if _is_num(as_) else None),
        "status": live_status,
        "period": period,
        "minute": minute,
        "sport": sp["sportName"],
        "sportId": sp["sportId"],
        "periodScoresStr": pi["periodScoresStr"],
        "currentPeriodName": pi["currentPeriodName"],
        "clock": (ck["clock"] if ck and ck.get("clock") else None)
        or scores.get("statusLineStr") or "",
        "startTs": g["startTs"] if _is_num(g.get("startTs")) else None,
        "format": "",
        "timerSec": timer["timeSec"] if _is_num(timer.get("timeSec")) else None,
        "stats": tablo_stats(scores),
        "cricket": cricket_raw(scores) if ck else None,
        "videoId": str(video["id"]) if video.get("id") else None,
    }


def normalize_uefa_line(g, league, sport_id):
    sid = sport_id if _is_num(sport_id) else 1
    sname = SPORT_NAMES.get(sid, "Football")
    o1 = g.get("opponent1") or {}
    o2 = g.get("opponent2") or {}
    home = o1.get("fullName") or ""
    away = o2.get("fullName") or ""
    gid = g.get("id") or g.get("mainGameId")
    if not home or not away or not gid:
        return None
    scores = g.get("scores") or None
    start_ts = g["startTs"] if _is_num(g.get("startTs")) else None
    now_sec = int(time.time())
    status = "upcoming"
    clock = ""
    minute = None
    if scores:
        st = status_of(scores)
        minute = st["minute"]
        clock = scores.get("statusLineStr") or ""
        status = "FT" if st["status"] == "FT" else "live"
    elif start_ts and start_ts <= now_sec:
        status = "live"
        clock = "Live"
    ck = cricket_live(scores) if scores else None
    pi = period_info(scores)
    if ck and ck.get("clock"):
        clock = ck["clock"]
    timer = (scores or {}).get("timer") or {}
    video = g.get("video") or {}
    return {
        "id": str(gid),
        "league": league,
        "home": home,
        "away": away,
        "homeScore": ck["home"] if ck else (
            scores["scoreOpp1"] if scores and _is_num(scores.get("scoreOpp1")) else None),
        "awayScore": ck["away"] if ck else (
            scores["scoreOpp2"] if scores and _is_num(scores.get("scoreOpp2")) else None),
        "status": status,
        "minute": minute,
        "sport": sname,
        "sportId": sid,
        "periodScoresStr": pi["periodScoresStr"],
        "currentPeriodName": pi["currentPeriodName"],
        "clock": clock,
        "startTs": start_ts,
        "format": "",
        "timerSec": timer["timeSec"] if _is_num(timer.get("timeSec")) else None,
        "stats": tablo_stats(scores),
        "videoId": str(video["id"]) if video.get("id") else None,
    }


def find_liga_games(menu, champ_id):
    if not isinstance(menu, list):
        return None
    bare = None

    def check(node):
        nonlocal bare
        if not node or node.get("id") != champ_id:
            return None
        games = node.get("games") if isinstance(node.get("games"), list) else []
        if games:
            return {"name": node.get("name") or "UEFA", "games": games}
        if bare is None:
            bare = {"name": node.get("name") or "UEFA", "games": []}
        return None

    for section in menu:
        for sport in (section or {}).get("sports") or []:
            for liga in (sport or {}).get("ligas") or []:
                hit = check(liga)
                if hit:
                    return hit
                for sub in (liga or {}).get("subLigas") or []:
                    sub_hit = check(sub)
                    if sub_hit:
                        return sub_hit
    return bare


async def line_games_for_champ(client, base, sport_id, champ_id, league_name):
    sid = sport_id if _is_num(sport_id) else 1
    path = "/en/line/" + SPORT_NAMES.get(sid, "Football").lower().replace(" ", "")
    menu = await fetch_json(
        client, base,
        "/service-api/main-line-feed/v3/leftMenuSports?country=130&fcountry=130&gr=909&lng=en&ref=1"
        + "&selectedMs=1.%d.%d,2.%d.%d,10.%d.%d" % (sid, champ_id, sid, champ_id, sid, champ_id),
        path,
    )
    found = find_liga_games(menu, champ_id)
    if not found:
        return []
    return [x for x in (
        normalize_uefa_line(g, found.get("name") or league_name, sid)
        for g in found["games"]
    ) if x]


async def fetch_line_leg(client, base, champs):
    """Batches of 3 (the mirror 529s past ~6 concurrent requests from
    one IP). One retry after 1s on a non-timeout error; a timeout is
    not retried — the mirror is just slow for that champ."""
    all_games = []
    for i in range(0, len(champs), 3):
        batch = champs[i:i + 3]

        async def one(c):
            try:
                return await line_games_for_champ(
                    client, base, c["sportId"], c["id"], c["name"])
            except httpx.TimeoutException:
                return []
            except Exception:
                await asyncio.sleep(1)
                try:
                    return await line_games_for_champ(
                        client, base, c["sportId"], c["id"], c["name"])
                except Exception:
                    return []

        results = await asyncio.gather(*[one(c) for c in batch])
        for games in results:
            all_games.extend(games)
    return all_games


def expand_search_aliases(text):
    """Same map + one-pass expansion as the Vercel search: a word already
    inside a full team name is left alone, and an inserted expansion is
    never re-expanded ("real" inside "real madrid" stays)."""
    words = str(text or "").lower().split()
    entries = list(SEARCH_ALIASES.items())
    multi = sorted(
        [([k.split(" "), v]) for k, v in entries if " " in k],
        key=lambda kv: -len(kv[0]),
    )
    full = sorted(
        list({tuple(v.split(" ")) for _, v in entries if " " in v}),
        key=lambda f: -len(f),
    )
    single = {k: v for k, v in entries if " " not in k}
    out = []
    i = 0
    while i < len(words):
        done = False
        for phrase, repl in [(list(f), None) for f in full] + multi:
            n = len(phrase)
            if words[i:i + n] == phrase:
                out.extend((repl.split(" ") if repl else phrase))
                i += n
                done = True
                break
        if done:
            continue
        w = words[i]
        if w in single:
            out.extend(single[w].split(" "))
        else:
            out.append(w)
        i += 1
    return " ".join(out)


def detail_from_info(info):
    if not isinstance(info, dict):
        return {}
    mi = info.get("matchInfoObj") or {}
    weather = None
    if mi.get("weatherDescription"):
        weather = mi["weatherDescription"] + (
            " · " + str(mi["temperature"]) if mi.get("temperature") else "")
    out = {
        "constId": str(info["constId"]) if info.get("constId") is not None
        else (str(info["mainConstId"]) if info.get("mainConstId") is not None else None),
        "sport": ((info.get("sport") or {}).get("name")),
        "venue": mi.get("location"),
        "format": mi.get("matchFormat"),
        "weather": weather,
        "hasLineups": bool((info.get("statisticInfo") or {}).get("hasLineUps")),
        "hasStadium": bool((info.get("statisticInfo") or {}).get("hasStadiumInfo")),
        "video": bool((info.get("video") or {}).get("enabled")),
    }
    if _is_num((info.get("sport") or {}).get("id")):
        out["sportId"] = info["sport"]["id"]
    if (info.get("video") or {}).get("id"):
        out["videoId"] = str(info["video"]["id"])
    return out


async def game_detail(client, base, g):
    """Enrich a normalized live game with live gameInfo. A failed detail
    call never fails the search — the game still shows. (No NPL
    scorecard in phase 1.)"""
    extra = {}
    try:
        info = await fetch_json(
            client, base,
            "/service-api/main-live-feed/v3/gameInfo?fcountry=130&gameId="
            + str(g["id"]) + "&gr=909&lng=en&ref=1",
            "/en/live/football",
        )
        extra = detail_from_info(info)
    except Exception:
        extra = {}
    merged = dict(g)
    merged.update(extra)
    if g.get("videoId"):
        merged["videoId"] = g["videoId"]
    return merged


async def find_upcoming_by_id(client, base, gid):
    line = await fetch_line_leg(client, base, KNOWN_CHAMPS + KNOWN_LEAGUES)
    for g in line:
        if str(g["id"]) == str(gid):
            return g
    return None


async def search_games(client, base, q):
    query = str(q or "").strip()
    if not query:
        return {"games": [], "detail": None}
    is_id = bool(re.match(r"^\d{5,}$", query))
    # Live list (all sports, up to 50) + featured list, in parallel.
    live_data, feat_data = await asyncio.gather(
        _safe_fetch(client, base,
            "/service-api/main-live-feed/v3/games1x2?cfView=3&count=50&country=130&fcountry=130&gr=909&grMode=4&lng=en&ref=1",
            "/en/live/football"),
        _safe_fetch(client, base,
            "/service-api/main-live-feed/v3/topGamesByStat?" + TOP_PARAMS,
            "/en/live/football"),
    )
    live = []
    if isinstance(live_data, list):
        live = [x for x in (normalize_featured(g) for g in live_data) if x]
    if isinstance(feat_data, list):
        for g in feat_data:
            fg = normalize_featured(g)
            if fg and not any(x["id"] == fg["id"] for x in live):
                live.append(fg)

    if is_id:
        hit = next((g for g in live if g["id"] == query), None)
        if hit:
            return {"games": [], "detail": await game_detail(client, base, hit)}
        # Alias id: gameInfo carries mainGameId (the live id).
        try:
            info = await fetch_json(
                client, base,
                "/service-api/main-live-feed/v3/gameInfo?fcountry=130&gameId="
                + query + "&gr=909&lng=en&ref=1",
                "/en/live/football",
            )
            if info and info.get("id"):
                main_id = str(info["mainGameId"]) if info.get("mainGameId") is not None else None
                if main_id and main_id != query:
                    main_hit = next((g for g in live if g["id"] == main_id), None)
                    if main_hit:
                        return {"games": [], "detail": await game_detail(client, base, main_hit)}
                d = {
                    "id": str(info["id"]),
                    "league": ((info.get("liga") or {}).get("name")) or "Unknown",
                    "home": ((info.get("opponent1") or {}).get("fullName")) or "",
                    "away": ((info.get("opponent2") or {}).get("fullName")) or "",
                    "homeScore": None, "awayScore": None,
                    "status": "?", "period": "", "minute": None,
                    "sport": ((info.get("sport") or {}).get("name")),
                    "sportId": info["sport"]["id"] if _is_num((info.get("sport") or {}).get("id")) else None,
                    "clock": "Score not available right now",
                    "startTs": info["startTs"] if _is_num(info.get("startTs")) else None,
                    "format": "", "timerSec": None,
                }
                d.update(detail_from_info(info))
                return {"games": [], "detail": d}
        except Exception:
            pass
        line_hit = await find_upcoming_by_id(client, base, query)
        if line_hit:
            return {"games": [], "detail": line_hit}
        return {"games": [], "detail": None}

    # Text search: live games by team/league name, then the upcoming
    # fixtures of the known big leagues (line feed). Nicknames are
    # expanded first; matching is word-based (every content word
    # must appear somewhere across teams/league). Filler words
    # never count.
    words = [w for w in expand_search_aliases(query).split()
             if w and w not in ("vs", "v", "against", "the", "a", "an")]

    def match(g):
        hay = (str(g.get("home") or "") + " " + str(g.get("away") or "")
               + " " + str(g.get("league") or "")).lower()
        return len(words) > 0 and all(w in hay for w in words)

    out = []

    def push(g):
        if not g or not match(g):
            return
        if any(x["id"] == g["id"] or same_teams(x, g) for x in out):
            return
        out.append(g)

    for g in live:
        push(g)
    if len(out) < SEARCH_MAX:
        line = await fetch_line_leg(client, base, KNOWN_CHAMPS + KNOWN_LEAGUES)
        for g in line:
            push(g)
    out.sort(key=lambda a: (0 if a.get("status") == "live" else 1, a.get("startTs") or 0))
    return {"games": out[:SEARCH_MAX], "detail": None}


async def _safe_fetch(client, base, path, referer_path):
    try:
        return await fetch_json(client, base, path, referer_path)
    except Exception:
        return None


# --- HTTP -------------------------------------------------------------

@app.get("/health")
async def health():
    return {"ok": True, "service": "onexbet-search"}


@app.get("/search")
async def search(q: str = Query(default="")):
    last_error = ""
    async with httpx.AsyncClient(trust_env=False) as client:
        for base in MIRRORS:
            try:
                r = await search_games(client, base, q)
                return {
                    "source": "1xbet",
                    "league": "Search",
                    "mirror": base,
                    "fetchedAt": datetime.now(timezone.utc).isoformat(),
                    "games": r["games"],
                    "detail": r["detail"],
                    "q": q,
                }
            except Exception as e:
                last_error = str(e)
    return JSONResponse(
        status_code=502,
        content={
            "source": "1xbet", "league": "Search", "mirror": None,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "games": [], "detail": None, "q": q,
            "error": "1xbet unreachable from this server",
            "detail_error": last_error,
        },
    )
