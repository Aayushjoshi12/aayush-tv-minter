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

No session token or key is ever logged or stored on disk. Sessions live only
in memory and expire after ~5h.
"""
import asyncio
import base64
import gzip
import json
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
