# CineSrc minter — resolves a TMDB id to a direct, native-playable HLS URL.
#
# Why this exists: Server 3 on Aayush TV is the CineSrc embed
# (cinesrc.st/embed). It is slow (45-60s to first picture) because the
# embed checks providers one by one behind two proof-of-work challenges.
# But the video itself is a plain static HLS file on bright67.online:
#   https://nebula.bright67.online/hls/<uuid>/master.m3u8
# (1080p + 720p, CORS *, no auth, Cloudflare-cached). The <uuid> is STABLE
# per title+provider — a full page reload returns the identical URL — so
# mint once, cache forever.
#
# How it mints: the challenge code only runs in a real browser, so the
# minter drives the user's Chrome through the browser-driver backend
# (127.0.0.1:8802), opens the CineSrc embed in a background tab, waits
# for the player to start, and reads the manifest URL out of the page
# (performance resource entries, falling back to window.__cinesrcHls.url).
# Only the URL comes back; nothing else leaves his Chrome.
#
# Limitation: minting needs his Chrome open with the browser-driver
# extension connected. Cached titles play instantly with no Chrome.
#
# Port 8805 (Nexus 8801, driver 8802, cinema 8803, hub 8804).
# Caddy route: /cinesrc-api/ on mret.aayushlife.live.
# Cache: SQLite /opt/cinesrc/cache.db (key -> url, permanent).
# Seeded titles (verified live 25 Nov 2026 via MRET in his Chrome):
#   movie 27205 Inception -> nebula master.m3u8 below.

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE = os.path.join(BASE_DIR, ".env")
CACHE_DB = os.path.join(BASE_DIR, "cache.db")
PENDING_FILE = os.path.join(BASE_DIR, "pending.json")

# Verified 25 Nov 2026 (MRET capture + reload test: identical URL twice).
SEED = {
    "movie:27205": (
        "https://nebula.bright67.online/hls/"
        "1daa855b-5c23-436b-92a3-d9d273dd13d6/master.m3u8"
    ),
}

DRIVER_BASE = os.environ.get("DRIVER_BASE", "http://127.0.0.1:8802")
DRIVER_TIMEOUT_S = 30
MINT_WAIT_S = 40
MINT_POLL_S = 2

app = FastAPI(title="cinesrc-minter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Cache (SQLite) + pending queue (JSON)
# ---------------------------------------------------------------------------

def _db():
    conn = sqlite3.connect(CACHE_DB)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS links ("
        "  key TEXT PRIMARY KEY, url TEXT, provider TEXT, minted_at INTEGER)")
    return conn


def _cache_get(key):
    conn = _db()
    try:
        row = conn.execute(
            "SELECT url FROM links WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def _cache_put(key, url, provider="nebula"):
    conn = _db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO links VALUES (?, ?, ?, ?)",
            (key, url, provider, int(time.time())))
        conn.commit()
    finally:
        conn.close()


def _cache_count():
    conn = _db()
    try:
        return conn.execute("SELECT COUNT(*) FROM links").fetchone()[0]
    finally:
        conn.close()


def _seed_cache():
    for key, url in SEED.items():
        if not _cache_get(key):
            _cache_put(key, url, "nebula")


def _pending_add(item):
    try:
        pending = json.load(open(PENDING_FILE)) if os.path.exists(PENDING_FILE) else []
    except Exception:
        pending = []
    if all(p.get("key") != item["key"] for p in pending):
        pending.append(item)
        with open(PENDING_FILE, "w") as f:
            json.dump(pending, f)


def _pending_list():
    try:
        return json.load(open(PENDING_FILE)) if os.path.exists(PENDING_FILE) else []
    except Exception:
        return []


def _pending_remove(key):
    pending = [p for p in _pending_list() if p.get("key") != key]
    with open(PENDING_FILE, "w") as f:
        json.dump(pending, f)


# ---------------------------------------------------------------------------
# Browser-driver calls (same protocol as the cinema minter)
# ---------------------------------------------------------------------------

def _read_env(name):
    val = os.environ.get(name)
    if val:
        return val
    try:
        with open(CREDS_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == name:
                    return v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return ""


def _driver_call(action, args):
    key = _read_env("DRIVER_API_KEY")
    if not key:
        raise RuntimeError(
            "no browser-driver key: set DRIVER_API_KEY in "
            f"{CREDS_FILE} (copied from /opt/browser-driver/.env)")
    body = json.dumps({"action": action, "args": args}).encode()
    req = urllib.request.Request(
        DRIVER_BASE + "/command", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=DRIVER_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode(errors="replace") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return json.loads(raw or "{}")
        except Exception:
            return {"ok": False, "error": f"driver_http_{e.code}",
                    "body": raw[:200]}
    except Exception as e:
        raise RuntimeError(f"browser-driver call failed: {e}")


def _driver_eval(tab_id, js):
    res = _driver_call("evaluate_js",
                       {"tabId": tab_id, "js": js, "confirm": True})
    if isinstance(res, dict) and res.get("detail") == "extension_not_connected":
        raise RuntimeError("browser-driver extension not connected "
                           "(Chrome closed or extension not loaded)")
    if isinstance(res, dict) and res.get("detail") == "invalid_api_key":
        raise RuntimeError("browser-driver key rejected (invalid_api_key)")
    result = (res or {}).get("result") or {}
    if isinstance(result, dict) and result.get("error"):
        raise RuntimeError(f"page JS error: {result['error']}")
    value = result.get("value") if isinstance(result, dict) else result
    return value if isinstance(value, str) else json.dumps(value)


_MINT_READ_JS = """(() => {
  try {
    var es = performance.getEntriesByType('resource');
    for (var i = 0; i < es.length; i++) {
      if (es[i].name && es[i].name.indexOf('master.m3u8') !== -1) return es[i].name;
    }
    var h = window.__cinesrcHls;
    if (h && h.url) return h.url;
    var v = window.__cinesrcVideo;
    if (v && v.currentSrc && v.currentSrc.indexOf('m3u8') !== -1) return v.currentSrc;
    return '';
  } catch (e) { return 'ERR:' + e.message; }
})()"""


def _embed_url(tmdb, media_type, season=None, episode=None):
    if media_type == "tv":
        s = season or 1
        e = episode or 1
        return f"https://cinesrc.st/embed/tv/{tmdb}?s={s}&e={e}"
    return f"https://cinesrc.st/embed/movie/{tmdb}"


def _mint(tmdb, media_type, season=None, episode=None):
    """Open the CineSrc embed in his Chrome and read the direct HLS URL
    out of the page. Raises on driver/Chrome failure; returns the URL."""
    url = _embed_url(tmdb, media_type, season, episode)
    res = _driver_call("open_tab",
                       {"url": url, "active": False, "confirm": True})
    tab = (res or {}).get("result") or {}
    tab_id = tab.get("tab_id")
    if not tab_id:
        raise RuntimeError(f"could not open a CineSrc tab: {str(res)[:200]}")
    try:
        deadline = time.time() + MINT_WAIT_S
        found = ""
        while time.time() < deadline:
            found = _driver_eval(tab_id, _MINT_READ_JS)
            if found and not found.startswith("ERR:") and "master.m3u8" in found:
                return found
            time.sleep(MINT_POLL_S)
        raise RuntimeError(
            "Chrome mint timed out (no master.m3u8 in the CineSrc tab "
            f"after {MINT_WAIT_S}s; last read: {found[:120]})")
    finally:
        try:
            _driver_call("close_tab", {"tabId": tab_id, "confirm": True})
        except Exception:
            pass


def _cache_key(tmdb, media_type, season=None, episode=None):
    if media_type == "tv":
        return f"tv:{tmdb}:s{season or 1}e{episode or 1}"
    return f"movie:{tmdb}"


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

@app.on_event("startup")
def _startup():
    _seed_cache()


@app.get("/health")
async def health():
    try:
        res = _driver_call("list_tabs", {})
        driver_ok = not (isinstance(res, dict)
                         and res.get("detail") == "extension_not_connected")
    except Exception:
        driver_ok = False
    return {"ok": True, "driver_connected": driver_ok,
            "cached": _cache_count(), "pending": len(_pending_list()),
            "driver_key_configured": bool(_read_env("DRIVER_API_KEY"))}


@app.get("/cinesrc")
async def cinesrc(tmdb: str, type: str = "movie",
                  season: int = None, episode: int = None):
    """Resolve a title to its direct HLS URL. Cached titles return
    instantly; a new title mints through his Chrome (~20-40s)."""
    media_type = "tv" if type == "tv" else "movie"
    key = _cache_key(tmdb, media_type, season, episode)
    url = _cache_get(key)
    if url:
        return {"url": url, "cached": True, "provider": "nebula", "key": key}
    try:
        url = _mint(tmdb, media_type, season, episode)
    except RuntimeError as e:
        msg = str(e)
        _pending_add({"key": key, "tmdb": tmdb, "type": media_type,
                      "season": season, "episode": episode,
                      "requested_at": int(time.time()), "error": msg[:120]})
        return JSONResponse(
            status_code=502,
            content={"error": msg, "key": key, "pending": True})
    _cache_put(key, url, "nebula")
    _pending_remove(key)
    return {"url": url, "cached": False, "provider": "nebula", "key": key}


@app.get("/pending")
async def pending():
    return {"pending": _pending_list()}


@app.post("/seed")
async def seed(request: Request):
    """Manually add a verified direct URL to the cache. Needs the seed
    key from /opt/cinesrc/.env (SEED_KEY) as X-Seed-Key."""
    body = await request.json()
    want = _read_env("SEED_KEY")
    if not want or request.headers.get("X-Seed-Key") != want:
        return JSONResponse(status_code=403, content={"error": "bad seed key"})
    tmdb = str(body.get("tmdb", ""))
    media_type = "tv" if body.get("type") == "tv" else "movie"
    url = (body.get("url") or "").strip()
    if not tmdb or "master.m3u8" not in url:
        return JSONResponse(status_code=400,
                            content={"error": "need tmdb + master.m3u8 url"})
    key = _cache_key(tmdb, media_type, body.get("season"), body.get("episode"))
    _cache_put(key, url, body.get("provider") or "nebula")
    _pending_remove(key)
    return {"ok": True, "key": key, "url": url}
