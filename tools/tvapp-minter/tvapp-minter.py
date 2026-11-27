"""TVApp minter — turns a TheTVApp match id into a playable HLS playlist.

Chain (reverse-engineered 28 Nov 2026, see ~/workspace/tvapp-re/REPORT.md):
  matches.json (public) -> POST /api/session/start (mode "native") ->
  PLAIN playlist at /live/<token>/index.m3u8 -> segments on TikTok CDN
  (CORS *, signed ~5h, WebP header to strip client-side).

"enc" mode is the fallback: its manifest (feed.bin) is AES-GCM-encrypted AND
bound to the minting IP ("session in use elsewhere" from any other IP), so it
only works when mint + fetch share one IP (true on the aayushbot VM, false on
machines behind a rotating egress proxy). "native"/plain mode has neither
problem: the playlist URL fetches fine from any IP, and the segments are not
IP-bound either (verified live).

The browser cannot mint directly (session/start sends no CORS headers), so
this service mints and serves the plain playlist with CORS *. The player still
needs hls.js with a segment loader that strips the 33-byte WebP header
(see stream.html on the site).

/ai-find (plain-words game lookup for the site's "Ask in plain words" box):
  tier 1 is local — nickname aliases + filler-word stripping + fuzzy title
  matching against the catalog, no key needed. Tier 2 is Groq
  (openai/gpt-oss-120b, the same model as FootballBot) which parses the
  teams out of free text; it runs only when tier 1 finds nothing, and only
  when GROQ_API_KEY is set in the service environment (systemd
  EnvironmentFile). A missing/failed Groq call degrades to tier 1 only —
  the endpoint never fails just because the AI is unavailable.

No session token or key is ever logged or stored on disk. Sessions live only
in memory and expire after ~5h.
"""
import asyncio
import base64
import gzip
import json
import os
import re
import time
import unicodedata

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

UPSTREAM = "https://thetvapp.pk"
MATCHES_URL = "https://tvapp1.pk/api/matches.json"
PPV_URLS = [
    "https://api.ppv.st/api/streams",
    "https://api.ppv.cx/api/streams",
    "https://api.ppv.is/api/streams",
    "https://api.ppv.lc/api/streams",
]
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

def _client():
    # trust_env=False: this VM's proxy env vars break httpx's URL parsing
    # (bracketed IPv6 entries in no_proxy) and direct egress works fine.
    return httpx.AsyncClient(follow_redirects=True, trust_env=False)


app = FastAPI(title="tvapp-minter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_sessions = {}          # stream id -> session dict
_sessions_lock = asyncio.Lock()
_matches_cache = {"at": 0.0, "data": None}
_matches_lock = asyncio.Lock()


def _norm(s):
    s = (s or "").lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


@app.get("/health")
async def health():
    return {"ok": True, "service": "tvapp-minter", "sessions": len(_sessions)}


async def _fetch_matches(client):
    """Primary catalog (tvapp1.pk), falling back to the PPV upstream API."""
    try:
        r = await client.get(MATCHES_URL, headers=UA, timeout=12)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                return data
    except Exception:
        pass
    for url in PPV_URLS:
        try:
            r = await client.get(url, headers=UA, timeout=12)
            if r.status_code != 200:
                continue
            data = r.json()
            streams = (data or {}).get("streams") or []
            out = []
            for group in streams:
                for o in group.get("streams") or []:
                    if o.get("always_live"):
                        continue
                    try:
                        sid = str(int(o["id"]))
                        starts = int(o["starts_at"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if not o.get("name") or starts <= 0:
                        continue
                    urls = []
                    for src in [o.get("iframe"), o.get("origin_embed_url")]:
                        if isinstance(src, str) and src.startswith("https://"):
                            urls.append(src)
                    for sub in o.get("substreams") or []:
                        u = sub.get("iframe")
                        if isinstance(u, str) and u.startswith("https://"):
                            urls.append(u)
                    if not urls:
                        continue
                    m = {
                        "id": sid,
                        "title": o["name"],
                        "category": "football",
                        "date": starts * 1000,
                        "sources": [{"source": "nova", "id": sid, "urls": urls}],
                    }
                    if o.get("ends_at"):
                        m["endsAt"] = int(o["ends_at"]) * 1000
                    out.append(m)
            if out:
                return out
        except Exception:
            continue
    return []


async def get_matches():
    async with _matches_lock:
        if _matches_cache["data"] is not None and time.time() - _matches_cache["at"] < 60:
            return _matches_cache["data"]
        async with _client() as client:
            data = await _fetch_matches(client)
        _matches_cache["data"] = data
        _matches_cache["at"] = time.time()
        return data


@app.get("/matches")
async def matches():
    data = await get_matches()
    return JSONResponse(data)


def _find_match(data, home, away):
    hn, an = _norm(home), _norm(away)
    if not hn or not an:
        return None
    best = None
    for m in data:
        title = _norm(m.get("title") or "")
        if hn in title and an in title:
            return m
        # score partial: both team names present as words
        score = 0
        for w in hn.split():
            if len(w) > 2 and w in title:
                score += 1
        for w in an.split():
            if len(w) > 2 and w in title:
                score += 1
        if score >= 3 and (best is None or score > best[0]):
            best = (score, m)
    return best[1] if best else None


@app.get("/find")
async def find(home: str = Query(""), away: str = Query("")):
    data = await get_matches()
    m = _find_match(data, home, away)
    if not m:
        raise HTTPException(status_code=404, detail="no matching live/upcoming match")
    return {
        "id": m["id"],
        "title": m.get("title"),
        "category": m.get("category"),
        "date": m.get("date"),
        "endsAt": m.get("endsAt"),
        "stream": "/stream?id=" + str(m["id"]),
    }


# --- plain-words game lookup (/ai-find) -------------------------------------
# Tier 1: local fuzzy matching (aliases + filler stripping). Tier 2: Groq
# parses the teams out of free text; only when tier 1 finds nothing.

_ALIASES = {
    "barca": "barcelona", "blaugrana": "barcelona",
    "madrid": "real madrid", "real": "real madrid",
    "atleti": "atletico madrid", "atletico": "atletico madrid",
    "man utd": "manchester united", "man united": "manchester united",
    "man city": "manchester city", "city": "manchester city",
    "spurs": "tottenham", "tottenham hotspur": "tottenham",
    "juve": "juventus", "inter": "inter milan",
    "internazionale": "inter milan", "milan": "ac milan",
    "rossoneri": "ac milan", "bayern": "bayern munich",
    "dortmund": "borussia dortmund", "bvb": "borussia dortmund",
    "psg": "paris saint-germain", "paris": "paris saint-germain",
    "psv": "psv eindhoven", "sporting": "sporting cp",
}

_FILLER = {
    "who", "is", "are", "playing", "play", "plays", "tonight", "today",
    "tomorrow", "live", "match", "game", "watch", "the", "a", "an", "show",
    "me", "find", "please", "for", "of", "on", "at", "vs", "v", "versus",
    "against", "stream", "streaming", "where", "when", "can", "i", "get",
    "this", "weekend", "now",
}


def _expand_aliases(text):
    """Replace known nicknames with full team names, one pass over words.
    A word already inside a full team name ("real madrid") is left alone,
    and an inserted expansion is never re-expanded ("real" inside the
    just-inserted "real madrid" must not become "real madrid madrid")."""
    words = text.split()
    multi_alias = sorted(
        [(k.split(), v) for k, v in _ALIASES.items() if " " in k],
        key=lambda kv: -len(kv[0]))
    full = sorted(
        [v.split() for v in set(_ALIASES.values()) if " " in v],
        key=len, reverse=True)
    single = {k: v for k, v in _ALIASES.items() if " " not in k}
    out = []
    i = 0
    while i < len(words):
        done = False
        for phrase, repl in [(f, None) for f in full] + [(a, r) for a, r in multi_alias]:
            n = len(phrase)
            if words[i:i + n] == phrase:
                out.extend(repl.split() if repl else phrase)
                i += n
                done = True
                break
        if done:
            continue
        w = words[i]
        if w in single:
            out.extend(single[w].split())
        else:
            out.append(w)
        i += 1
    return " ".join(out)


def _strip_filler(text):
    words = [w for w in text.split() if w not in _FILLER]
    return " ".join(words)


def _find_single(data, team):
    """Best match for one team name: live first, then soonest upcoming."""
    tn = _norm(team)
    if not tn:
        return None
    now = time.time() * 1000
    best = None
    for m in data:
        title = _norm(m.get("title") or "")
        if tn not in title:
            continue
        date = m.get("date") or 0
        live = date <= now < (m.get("endsAt") or date + 3 * 3600 * 1000)
        # live beats upcoming; among equals, the soonest kickoff wins
        key = (0 if live else 1, abs(date - now))
        if best is None or key < best[0]:
            best = (key, m)
    return best[1] if best else None


def _tier1(data, q):
    """Local parse: returns a match or None. No network, no key."""
    text = _expand_aliases(_norm(q))
    if not text:
        return None, None
    # "A vs B" / "A - B" / "A against B"
    for sep in (" vs ", " v ", " - ", " against "):
        if sep in text:
            a, b = text.split(sep, 1)
            m = _find_match(data, _strip_filler(a), _strip_filler(b))
            if m:
                return m, (a.strip(), b.strip())
            break
    cleaned = _strip_filler(text)
    # two-team guess: try the first two content words as separate teams
    words = cleaned.split()
    if len(words) >= 2:
        m = _find_match(data, words[0], " ".join(words[1:]))
        if m:
            return m, (words[0], " ".join(words[1:]))
        m = _find_match(data, " ".join(words[:-1]), words[-1])
        if m:
            return m, (" ".join(words[:-1]), words[-1])
    # single team
    m = _find_single(data, cleaned)
    if m:
        return m, (cleaned, None)
    return None, None


GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-120b"


async def _groq_parse(client, q):
    """Ask Groq for the teams in free text. Returns (home, away) or None."""
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        return None
    try:
        r = await client.post(
            GROQ_URL,
            json={
                "model": GROQ_MODEL,
                "temperature": 0,
                "max_tokens": 120,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You parse football match requests. Reply with JSON only: "
                            '{"home": "<full team name>", "away": "<full team name>"} '
                            "when two teams are named, or "
                            '{"team": "<full team name>"} when only one team is named. '
                            "Use full official team names (e.g. Barcelona, Real Madrid, "
                            "Manchester United). If no team is named, reply {}."
                        ),
                    },
                    {"role": "user", "content": q},
                ],
            },
            headers={"Authorization": "Bearer " + key,
                     "Content-Type": "application/json"},
            timeout=12,
        )
        if not r.is_success:
            return None
        content = r.json()["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        home, away = parsed.get("home"), parsed.get("away")
        if home and away:
            return home, away
        if parsed.get("team"):
            return parsed["team"], None
        return None
    except Exception:
        return None


def _suggestions(data, limit=5):
    """A few live matches to offer when nothing matches (football first)."""
    now = time.time() * 1000
    live = [m for m in data
            if (m.get("date") or 0) <= now < (m.get("endsAt") or (m.get("date") or 0) + 3 * 3600 * 1000)]
    live.sort(key=lambda m: (0 if (m.get("category") or "") == "football" else 1,
                             m.get("date") or 0))
    return [{"id": m["id"], "title": m.get("title"), "date": m.get("date"),
             "category": m.get("category")}
            for m in live[:limit]]


def _title_teams(title):
    """Clean 'Home vs Away' display names from a catalog title."""
    for sep in (" vs ", " - "):
        if sep in (title or ""):
            a, b = title.split(sep, 1)
            return a.strip(), b.strip()
    return None, None


def _parse_teams(q):
    """Parse plain words into (home, away) or (team, None). No catalog —
    used by /ai-parse so the site can search the 1xBet feed with the teams."""
    text = _expand_aliases(_norm(q))
    if not text:
        return None
    for sep in (" vs ", " v ", " - ", " against "):
        if sep in text:
            a, b = text.split(sep, 1)
            return (_strip_filler(a).strip(), _strip_filler(b).strip())
    cleaned = _strip_filler(text)
    words = cleaned.split()
    if len(words) >= 2:
        return (words[0], " ".join(words[1:]))
    if cleaned:
        return (cleaned, None)
    return None


@app.get("/ai-parse")
async def ai_parse(q: str = Query("")):
    """Parse plain words into team names only — no catalog lookup.
    The site's AI box uses this, then searches the 1xBet feed itself,
    so the Scoreboard shows 1xBet matches only."""
    q = (q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="ask about a match in plain words")
    parsed = _parse_teams(q)
    if parsed and parsed[1]:
        return {"home": parsed[0], "away": parsed[1], "ai": False}
    # One team or no parse: let Groq try (it may find two teams).
    async with _client() as client:
        g = await _groq_parse(client, q)
    if g:
        return {"home": g[0], "away": g[1], "ai": True}
    if parsed:
        return {"home": parsed[0], "away": parsed[1], "ai": False}
    raise HTTPException(status_code=404, detail="no team found in those words")


@app.get("/stream-check")
async def stream_check(id: str = Query(...)):
    """Is there a playable stream for this TVApp id right now?
    Lightweight: mints a session (cached 4h30m) but does not fetch the
    playlist. The site shows the Watch button only when this says
    available — a 1xBet video id alone does not count."""
    if not re.fullmatch(r"\d{1,12}", id or ""):
        raise HTTPException(status_code=400, detail="bad stream id")
    for mode in ("native", "enc"):
        try:
            session = await _get_session(id, mode)
            return {"available": True, "name": session.get("name")}
        except _Soon as e:
            d = e.data
            return {"available": False, "soon": True,
                    "startsAt": d.get("startsAt"), "openAt": d.get("openAt")}
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        except Exception:
            continue
    return JSONResponse({"available": False}, status_code=404)


@app.get("/ai-find")
async def ai_find(q: str = Query("")):
    q = (q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="ask about a match in plain words")
    data = await get_matches()
    m, teams = _tier1(data, q)
    used_ai = False
    if not m:
        async with _client() as client:
            parsed = await _groq_parse(client, q)
        if parsed:
            used_ai = True
            home, away = parsed
            if away:
                m = _find_match(data, home, away)
            else:
                m = _find_single(data, home)
            teams = parsed
    if not m:
        return JSONResponse(
            {"detail": "no match found", "suggestions": _suggestions(data)},
            status_code=404,
        )
    # Display names come from the match's own title when possible — the
    # raw parsed parts can be messy ("real" vs "madrid madrid derby").
    th, ta = _title_teams(m.get("title") or "")
    home, away = (teams or (None, None)) if teams else (None, None)
    return {
        "id": m["id"],
        "title": m.get("title"),
        "category": m.get("category"),
        "date": m.get("date"),
        "endsAt": m.get("endsAt"),
        "stream": "/stream?id=" + str(m["id"]),
        "home": th or home,
        "away": ta or away,
        "ai": used_ai,
    }


async def _mint_session(client, stream_id, mode="native"):
    r = await client.post(
        UPSTREAM + "/api/session/start",
        json={"stream": str(stream_id), "mode": mode, "gz": True},
        headers={**UA, "Content-Type": "application/json",
                 "Referer": UPSTREAM + "/embed/" + str(stream_id)},
        timeout=15,
    )
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="stream not available")
    if not r.is_success:
        raise HTTPException(
            status_code=502, detail="session failed (HTTP %s)" % r.status_code)
    data = r.json()
    if data.get("state") == "soon":
        raise _Soon(data)
    if not data.get("token") or not data.get("url"):
        raise HTTPException(status_code=502, detail="bad session response")
    return data


class _Soon(Exception):
    def __init__(self, data):
        self.data = data


async def _get_session(stream_id, mode="native"):
    cache_key = str(stream_id) + ":" + mode
    async with _sessions_lock:
        s = _sessions.get(cache_key)
        # Token lives ~5h; reuse until 4h30m old, then re-mint.
        if s and time.time() - s["minted_at"] < 4.5 * 3600:
            return s
    async with _client() as client:
        data = await _mint_session(client, stream_id, mode)
    session = {
        "token": data["token"],
        "key": data.get("key"),
        "url": data["url"],
        "mode": data.get("mode", mode),
        "gz": bool(data.get("gz")),
        "name": data.get("name"),
        "directFallbackEnabled": bool(data.get("directFallbackEnabled")),
        "minted_at": time.time(),
    }
    async with _sessions_lock:
        _sessions[cache_key] = session
    return session


def _decrypt_manifest(session, blob):
    if len(blob) < 12 + 16 + 1:
        raise ValueError("manifest too short")
    key = base64.b64decode(session["key"])
    aes = AESGCM(key)
    plain = aes.decrypt(blob[:12], blob[12:], session["token"].encode())
    if session["gz"]:
        plain = gzip.decompress(plain)
    text = plain.decode("utf-8", "replace")
    if not text.startswith("#EXTM3U"):
        raise ValueError("decrypted manifest is not a playlist")
    return text


async def _fetch_playlist(stream_id, mode):
    """Return the plain playlist for a session of the given mode.

    native -> the session url IS a plain .m3u8 (no decrypt).
    enc    -> the session url is feed.bin (AES-GCM + gunzip).
    """
    session = await _get_session(stream_id, mode)
    async with _client() as client:
        r = await client.get(
            session["url"],
            headers={"User-Agent": UA["User-Agent"],
                     "Referer": UPSTREAM + "/embed/" + str(stream_id)},
            timeout=20,
        )
    if not r.is_success:
        raise HTTPException(
            status_code=502,
            detail="manifest fetch failed (HTTP %s)" % r.status_code)
    if mode == "enc":
        return _decrypt_manifest(session, r.content)
    text = r.content.decode("utf-8", "replace")
    if not text.startswith("#EXTM3U"):
        raise ValueError("manifest is not a playlist")
    return text


@app.get("/stream")
async def stream(id: str = Query(...)):
    if not re.fullmatch(r"\d{1,12}", id or ""):
        raise HTTPException(status_code=400, detail="bad stream id")
    try:
        # Plain mode first: no decrypt, and neither the playlist nor the
        # segments are IP-bound (verified live). Encrypted mode is the
        # fallback; its feed.bin is bound to the minting IP.
        playlist = await _fetch_playlist(id, "native")
    except _Soon as e:
        d = e.data
        return JSONResponse(
            {
                "state": "soon",
                "name": d.get("name"),
                "startsAt": d.get("startsAt"),
                "openAt": d.get("openAt"),
            },
            status_code=503,
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            raise
        try:
            playlist = await _fetch_playlist(id, "enc")
        except _Soon as e:
            d = e.data
            return JSONResponse(
                {
                    "state": "soon",
                    "name": d.get("name"),
                    "startsAt": d.get("startsAt"),
                    "openAt": d.get("openAt"),
                },
                status_code=503,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail="manifest failed: %s" % exc)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="manifest failed: %s" % exc)
    return PlainTextResponse(
        playlist, media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/fallback")
async def fallback(id: str = Query(...)):
    if not re.fullmatch(r"\d{1,12}", id or ""):
        raise HTTPException(status_code=400, detail="bad stream id")
    session = _sessions.get(str(id) + ":native") or _sessions.get(str(id) + ":enc")
    if not session:
        raise HTTPException(status_code=404, detail="no session for this stream")
    try:
        async with _client() as client:
            r = await client.post(
                UPSTREAM + "/api/fallback",
                json={"token": session["token"]},
                headers={**UA, "Content-Type": "application/json"},
                timeout=15,
            )
        if not r.is_success:
            raise HTTPException(
                status_code=502, detail="fallback failed (HTTP %s)" % r.status_code)
        data = r.json()
        if not data.get("url"):
            raise HTTPException(status_code=502, detail="no fallback url")
        return {"url": data["url"]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="fallback failed: %s" % exc)


async def _heartbeat_loop():
    while True:
        await asyncio.sleep(45)
        async with _sessions_lock:
            sessions = list(_sessions.values())
        if not sessions:
            continue
        try:
            async with _client() as client:
                for s in sessions:
                    try:
                        await client.post(
                            UPSTREAM + "/api/heartbeat",
                            json={"token": s["token"]},
                            headers={**UA, "Content-Type": "application/json"},
                            timeout=10,
                        )
                    except Exception:
                        pass
        except Exception:
            pass


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_heartbeat_loop())
