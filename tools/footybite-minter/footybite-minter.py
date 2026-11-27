"""Footybite minter — turns a Footybite match id into a playable HLS playlist.

Chain (reverse-engineered 28 Nov 2026, live from the aayushbot VM):
  homepage HTML (ids + team names) ->
  GET /_serverFn/<HASH>?payload=<TSS JSON {"data":{"id":"<id>"}}>
      with x-tsr-serverfn: true + the browser's exact headers ->
  match record with 4 signed /api/stream/seg?u=...&exp=...&sig=... URLs
  (Server 1..4, each a master-playlist URL) ->
  GET Server 1's seg URL with the browser's 5 headers over HTTP/2 ->
  master playlist (640x360, ~1.1 Mbps) -> variant seg URL ->
  media playlist -> segments (same seg endpoint, CORS *).

The browser cannot mint directly: the seg endpoint answers 403 to a bare
curl without the exact headers, and the signed URLs go stale within minutes
(a URL minted ~5 min earlier 403s while a seconds-old one returns 200), so
the minter mints fresh and fetches immediately, in one run, on every
/stream call. hls.js re-polls /stream for playlist updates, so every poll
is a fresh mint — that is the design, not a bug.

The 403 is partly unexplained: a controlled ABA test on the VM (28 Nov
~03:08 NPT) gave 200 / 403 / 200 for curl WITH / WITHOUT / WITH the
cookie-jar flags (-c on the mint, -b on the fetch), and 3/3 with the flags
vs 0/2 without across five pairs — even though both jar files were EMPTY
(no cookie was ever transmitted). No wire-level mechanism is known; the
planner's exact commands were not visible, so it may be planner variance
rather than a real curl effect. The minter therefore does NOT rely on it:
it retries with a fresh mint (up to 3 attempts, all 4 servers per mint)
and lets the player retry the playlist load. If httpx consistently 403s
where curl succeeds, the fallback is to shell out to curl from the minter
(see DEPLOY.md).

No signed URL, token or key is ever logged or stored on disk.
"""
import json
import re
import time
import unicodedata

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

BASE = "https://footybite.live"
# Match-data server function, recovered from the browser's own traffic
# (MRET capture of the match page, request 223493). Per-function, not
# per-match: the same hash works for any match id.
SERVERFN_HASH = (
    "aa797f0d6493868ab891152bc9f5e50523b51a17c10e3279968cf5c9440e80eb"
)
CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36"
)
SEC_CH_UA = '"Chromium";v="158", "Not.A/Brand";v="24", "Google Chrome";v="158"'

MAX_ATTEMPTS = 3


def _client():
    """httpx client matching the browser's wire shape as closely as
    possible: no proxy env (they break httpx URL parsing on this VM's
    egress), HTTP/2 when the h2 package is present, and NO Accept header
    on seg fetches (the browser sends none — see _seg_headers)."""
    try:
        client = httpx.AsyncClient(
            follow_redirects=True, trust_env=False, http2=True)
    except ImportError:
        client = httpx.AsyncClient(follow_redirects=True, trust_env=False)
    # httpx's default Accept: */* is added from client.headers; deleting
    # it makes seg fetches go out with no Accept header, like the browser.
    # The mint call passes its own Accept header per request.
    if "Accept" in client.headers:
        del client.headers["Accept"]
    return client


def _mint_headers(match_id):
    return {
        "User-Agent": CHROME_UA,
        "Referer": BASE + "/live-football/" + str(match_id),
        "Accept": "application/x-tss-framed, application/x-ndjson, application/json",
        "x-tsr-serverfn": "true",
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }


def _seg_headers(match_id):
    # Exactly what the browser sends on a seg fetch (MRET request 223489):
    # Referer, UA, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform.
    # No Cookie, no Accept, no Origin.
    return {
        "User-Agent": CHROME_UA,
        "Referer": BASE + "/live-football/" + str(match_id),
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }


def _payload(match_id):
    """The exact TSS-framed payload the browser sends for a match id."""
    return json.dumps(
        {"t": {"t": 10, "i": 0,
               "p": {"k": ["data"],
                     "v": [{"t": 10, "i": 1,
                            "p": {"k": ["id"],
                                  "v": [{"t": 1, "s": str(match_id)}]},
                            "o": 0}]},
               "o": 0},
         "f": 127, "m": []},
        separators=(",", ":"))


def _seg_urls(body):
    """All signed seg URLs in a _serverFn response body, in server order
    (Server 1 first). The response is TSS-framed nested JSON, so a plain
    recursive parse is fragile — a regex over the raw text is robust."""
    found = re.findall(
        r'((?:https://footybite\.live)?/api/stream/seg\?[^"\\\s]+)', body)
    out = []
    for u in found:
        if u.startswith("/"):
            u = BASE + u
        if u not in out:
            out.append(u)
    return out


class _SegForbidden(Exception):
    pass


class _NoServers(Exception):
    pass


async def _mint_seg_urls(client, match_id):
    """One fresh _serverFn call -> the match's signed seg URLs."""
    url = BASE + "/_serverFn/" + SERVERFN_HASH
    r = await client.get(
        url,
        params={"payload": _payload(match_id)},
        headers=_mint_headers(match_id),
        timeout=10,
    )
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="match not found")
    if not r.is_success:
        raise HTTPException(
            status_code=502,
            detail="match lookup failed (HTTP %s)" % r.status_code)
    urls = _seg_urls(r.text)
    if not urls:
        # The match record exists but lists no playable servers.
        raise _NoServers()
    return urls


async def _fetch_seg(client, match_id, url):
    """Fetch one seg URL (master, variant or media playlist) with the
    browser's exact headers. A 403 means the signed URL is stale or the
    endpoint refused this mint — the caller re-mints and retries."""
    r = await client.get(url, headers=_seg_headers(match_id), timeout=12)
    if r.status_code == 403:
        raise _SegForbidden()
    if not r.is_success:
        raise HTTPException(
            status_code=502,
            detail="playlist fetch failed (HTTP %s)" % r.status_code)
    text = r.text
    if not text.startswith("#EXTM3U"):
        raise HTTPException(status_code=502, detail="not a playlist")
    return text


def _first_playlist_url(master):
    """The variant URL in a master playlist: the first non-# line."""
    for line in master.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    raise HTTPException(status_code=502, detail="master playlist has no variant")


def _absolutize(playlist):
    """Make relative segment/variant lines absolute against the site."""
    out = []
    for line in playlist.splitlines():
        s = line.strip()
        if s and not s.startswith("#") and not s.startswith("http"):
            s = BASE + (s if s.startswith("/") else "/" + s)
        out.append(s)
    return "\n".join(out) + "\n"


async def _get_media_playlist(match_id):
    """Mint fresh + fetch master -> variant -> media, with retries.
    Every attempt mints a new set of signed URLs; within one attempt all
    servers are tried in order before re-minting."""
    last_err = None
    for _ in range(MAX_ATTEMPTS):
        try:
            async with _client() as client:
                urls = await _mint_seg_urls(client, match_id)
                for seg_url in urls:
                    try:
                        master = await _fetch_seg(client, match_id, seg_url)
                    except _SegForbidden:
                        last_err = "seg 403"
                        continue
                    variant_url = _first_playlist_url(master)
                    if variant_url.startswith("/"):
                        variant_url = BASE + variant_url
                    media = await _fetch_seg(client, match_id, variant_url)
                    return _absolutize(media)
        except _NoServers:
            raise HTTPException(
                status_code=404, detail="no playable servers for this match")
        except _SegForbidden:
            last_err = "seg 403"
            continue
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - network hiccup, retry
            last_err = str(exc)
            continue
    raise HTTPException(
        status_code=502,
        detail="stream unavailable after %d attempts (%s)"
        % (MAX_ATTEMPTS, last_err or "unknown"))


app = FastAPI(title="footybite-minter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_matches_cache = {"at": 0.0, "data": None}


def _norm(s):
    s = (s or "").lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


@app.get("/health")
async def health():
    return {"ok": True, "service": "footybite-minter"}


async def _fetch_matches():
    """The homepage lists the live/upcoming matches (ids + team names).
    The page is a TanStack Start shell, so parse tolerantly: anchor
    links to /live-football/<id> carry the team names in their text."""
    async with _client() as client:
        r = await client.get(
            BASE + "/", headers={"User-Agent": CHROME_UA}, timeout=15)
    if not r.is_success:
        return []
    html = r.text
    out = []
    seen = set()
    for m in re.finditer(
            r'href="/live-football/(\d+)"[^>]*>(.*?)</a>', html, re.S):
        mid = m.group(1)
        if mid in seen:
            continue
        seen.add(mid)
        text = re.sub(r"<[^>]+>", " ", m.group(2))
        text = re.sub(r"\s+", " ", text).strip()
        home = away = None
        for sep in (" vs ", " - ", " v "):
            if sep in text:
                home, away = (p.strip() for p in text.split(sep, 1))
                break
        title = text or None
        if home and away:
            title = home + " vs " + away
        out.append({"id": mid, "title": title, "home": home, "away": away})
    # Fallback: ids with no readable anchor text still count as matches.
    for m in re.finditer(r'/live-football/(\d+)', html):
        mid = m.group(1)
        if mid not in seen:
            seen.add(mid)
            out.append({"id": mid, "title": None, "home": None, "away": None})
    return out


async def get_matches():
    if _matches_cache["data"] is not None and time.time() - _matches_cache["at"] < 60:
        return _matches_cache["data"]
    data = await _fetch_matches()
    _matches_cache["data"] = data
    _matches_cache["at"] = time.time()
    return data


@app.get("/matches")
async def matches():
    return JSONResponse(await get_matches())


def _find_match(data, home, away):
    hn, an = _norm(home), _norm(away)
    if not hn or not an:
        return None
    best = None
    for m in data:
        title = _norm((m.get("title") or "") + " " +
                      (m.get("home") or "") + " " + (m.get("away") or ""))
        if hn in title and an in title:
            return m
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
        raise HTTPException(status_code=404, detail="no matching match")
    return {"id": m["id"], "title": m.get("title"),
            "stream": "/stream?id=" + str(m["id"])}


@app.get("/stream-check")
async def stream_check(id: str = Query(...)):
    """Is there a playable stream for this Footybite id right now?
    Lightweight: mints + fetches the master playlist only. The site
    shows a Watch button only when this says available."""
    if not re.fullmatch(r"\d{1,12}", id or ""):
        raise HTTPException(status_code=400, detail="bad stream id")
    for _ in range(2):
        try:
            async with _client() as client:
                urls = await _mint_seg_urls(client, id)
                for seg_url in urls:
                    try:
                        await _fetch_seg(client, id, seg_url)
                        return {"available": True}
                    except _SegForbidden:
                        continue
        except _NoServers:
            break
        except HTTPException as exc:
            if exc.status_code == 404:
                break
            continue
        except Exception:  # noqa: BLE001 - retry once
            continue
    return JSONResponse({"available": False}, status_code=404)


@app.get("/stream")
async def stream(id: str = Query(...)):
    if not re.fullmatch(r"\d{1,12}", id or ""):
        raise HTTPException(status_code=400, detail="bad stream id")
    playlist = await _get_media_playlist(id)
    return PlainTextResponse(
        playlist, media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )
