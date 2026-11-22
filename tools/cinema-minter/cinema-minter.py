"""
Cinema minter — mints 1xBet stream URLs using a dedicated service account.

REVISED 22 Nov 2026 — the guest-token path is DEAD. Findings:
- The /hd-api/external/verify guest token does NOT authorize /cinema.
  Tested as AccessToken, as Token (Auth), and as both: always
  {"Error":"Log in to view","ErrorCode":3}. The verify token is only an
  anti-bot proof, not stream auth. /cinema REQUIRES a logged-in account
  token.
- tvbetstream (all edges, all ports) is unreachable from Nepal, so there
  is no token-free stream source for Nepal viewers.

How it works now
----------------
1. The minter logs in DIRECTLY via the login API (no page UI — the VM's
   headless browser gets a degraded 1xBet page with no login form).
   POST /web-api/api/internal/office/account/login with the service
   account credentials (ONEX_USER / ONEX_PASS from /opt/cinema/.env).
   That returns 204 + a session cookie (uhash, 32 chars) — NOT the token
   /cinema wants. A second call, POST
   /web-api/api/internal/user/token/refresh, returns 204 + the
   access_token cookie (a ~557-char JWT). That JWT is what /cinema takes.
   (Both endpoints found 22 Nov 2026 in the site's shared base-app JS
   chunk; the browser's TokenService does exactly this two-step flow.)
   Cookies persist in a shared jar across login -> refresh -> cinema.
2. When a stream is requested, the minter uses the current access_token
   and POSTs /cinema with it + the full DR_ video id.
3. /cinema answers in one of three shapes:
   - Direct URL (xmediaget m3u8) -> returned as-is; plays natively.
   - ExternalAuthURL + provider AccessToken (Perform/Opta, ProviderID 1/3)
     -> returned as an external-auth result; the caller must follow the
     provider auth (a separate API).
   - Error (geo-blocked code 5, "Log in to view" code 3, low deposit) ->
     returned as a clear error.
4. The access_token lives ~20 min. If /cinema says the token is invalid,
   the minter re-logs in via the API to get a fresh token.

The login endpoint was found 22 Nov 2026 by reading the 1xBet welcome-app
JS bundle in the user's Chrome (sys-welcome-app entry-3c2d09ee14.js):
  x({url:"/web-api/api/internal/office/account/login",method:"POST",
     isUseXAuth:!0,expectedParams:{...RR(),...vR()}})
The token/refresh endpoint was found the same day in the shared base-app
chunk (__shared_base-app_92d18dd216.js), which also holds the TokenService
(useTokenService/fetchToken). The browser is no longer used for login.

Ports: 8803 (Nexus 8801, browser-driver 8802). Caddy route: /cinema-api/
"""

import asyncio
import http.cookiejar
import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
import urllib.error

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cinema-minter")

MIRRORS = [
    "https://1xlite-6229051.com",
    "https://1xlite-61831.com",
]
CINEMA_PATH = "/cinema"

# The credentials file. Lives under /opt/cinema on the VM, never in the repo.
CREDS_FILE = os.environ.get("CINEMA_CREDS_FILE", "/opt/cinema/.env")

# How long a minted stream URL is treated as fresh (the signed URL itself
# is time-limited server-side; this is only a cache guard).
TOKEN_REFRESH_MARGIN_S = 60

app = FastAPI(title="cinema-minter")

_mirror_idx = 0
_session_lock = asyncio.Lock()


def _mirror():
    return MIRRORS[_mirror_idx % len(MIRRORS)]


def _read_creds():
    """Read ONEX_USER / ONEX_PASS from the creds file (key=value lines)."""
    user = os.environ.get("ONEX_USER")
    password = os.environ.get("ONEX_PASS")
    if user and password:
        return user, password
    try:
        with open(CREDS_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "ONEX_USER":
                    user = v.strip().strip('"').strip("'")
                elif k.strip() == "ONEX_PASS":
                    password = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return user, password


LOGIN_PATH = "/web-api/api/internal/office/account/login"
TOKEN_REFRESH_PATH = "/web-api/api/internal/user/token/refresh"

# Cached access token + expiry (token lives ~20 min).
_cached_token = ""
_cached_token_at = 0.0
TOKEN_TTL_S = 15 * 60

# Shared cookie jar: the login sets a session cookie (uhash) and the
# token/refresh call sets the access_token JWT cookie. Cookies must persist
# across the login -> refresh -> cinema calls.
_cookie_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(_cookie_jar))


def _cookie_value(name):
    """Read one cookie's value from the shared jar ('' if absent)."""
    for c in _cookie_jar:
        if c.name == name:
            return c.value
    return ""


def _http_json(method, url, body=None, timeout=30, extra_headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent",
                   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36")
    req.add_header("Accept", "application/json, text/plain, */*")
    req.add_header("Origin", _mirror())
    req.add_header("Referer", _mirror() + "/")
    if extra_headers:
        for k, v in extra_headers.items():
            req.add_header(k, v)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode(errors="replace")
            try:
                payload = json.loads(raw) if raw.strip() else {}
            except Exception:
                payload = {"raw": raw[:500]}
            return resp.status, payload, resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except Exception:
            payload = {"raw": raw[:500]}
        return e.code, payload, e.headers


def _extract_token(status, payload, headers):
    """Pull an access token out of a login response (body or cookies)."""
    # JSON body candidates.
    if isinstance(payload, dict):
        for key in ("access_token", "accessToken", "token", "user_token",
                    "auth_token", "session_token"):
            v = payload.get(key)
            if isinstance(v, str) and len(v) > 20:
                return v
        # Nested data object.
        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("access_token", "accessToken", "token"):
                v = data.get(key)
                if isinstance(v, str) and len(v) > 20:
                    return v
    # Set-Cookie candidates.
    if headers is not None:
        cookies = headers.get_all("Set-Cookie") or []
        for c in cookies:
            m = re.search(r"(?:^|;\s*)(access_token|user_token|session)[=]([^;]+)",
                          c, re.I)
            if m and len(m.group(2)) > 20:
                return urllib.parse.unquote(m.group(2))
    return ""


def _api_login():
    """Log in via the login API, then refresh the access token.

    Returns the access_token JWT, or raises.
    Flow (found 22 Nov 2026 in the site's shared base-app JS chunk):
    1. POST /web-api/api/internal/office/account/login {login, password}
       -> 204, sets a session cookie (uhash, 32 chars). This is NOT the
       access_token /cinema wants.
    2. POST /web-api/api/internal/user/token/refresh {}
       -> 204, sets the access_token cookie (a ~557-char JWT).
    The browser's TokenService (useTokenService/fetchToken) does step 2
    after login; the access_token lives in a cookie, in-memory in the app,
    never in localStorage/IndexedDB.
    """
    user, password = _read_creds()
    if not user or not password:
        raise RuntimeError(
            "no service-account credentials: set ONEX_USER / ONEX_PASS in "
            f"{CREDS_FILE} (or env). The account must be a dedicated 1xBet "
            "account for this minter, not the user's personal account.")
    mirror = _mirror()
    # Step 1: login. Clears any stale cookies first.
    _cookie_jar.clear()
    body = {"login": user, "password": password}
    status, payload, headers = _http_json(
        "POST", mirror + LOGIN_PATH, body, timeout=30)
    log.info("login POST -> %s, payload keys: %s",
             status, list(payload.keys()) if isinstance(payload, dict) else type(payload))
    session = _cookie_value("uhash") or _cookie_value("sh.session.id")
    log.info("login session cookie present: %s", bool(session))
    # Step 2: refresh the access token (needs the session cookie).
    status2, payload2, headers2 = _http_json(
        "POST", mirror + TOKEN_REFRESH_PATH, {}, timeout=30)
    log.info("token/refresh POST -> %s", status2)
    token = _cookie_value("access_token")
    if token and len(token) > 100:
        log.info("token/refresh OK (access_token len %d)", len(token))
        return token
    # Fall back to anything the responses carried (body or Set-Cookie).
    token = _extract_token(status2, payload2, headers2)
    if token and len(token) > 100:
        return token
    token = _extract_token(status, payload, headers)
    if token and len(token) > 100:
        return token
    raise RuntimeError(
        f"login OK (session={bool(session)}) but no access_token JWT after "
        f"token/refresh (refresh HTTP {status2}); access_token cookie "
        f"len={len(_cookie_value('access_token'))}")


async def _ensure_token():
    """Return a live access_token, logging in via the API if needed."""
    global _cached_token, _cached_token_at
    async with _session_lock:
        if (_cached_token and
                time.time() - _cached_token_at < TOKEN_TTL_S):
            return _cached_token
        token = await asyncio.to_thread(_api_login)
        _cached_token = token
        _cached_token_at = time.time()
        return token


async def _mint_cinema(video_id, access_token):
    """POST /cinema and classify the response."""
    body = {
        "AppId": 101, "AppVer": "1025",
        "VpcVer": "v3.0.2", "CoreVer": "v3.0.2",
        "Language": "en", "AccessToken": access_token,
        "VideoId": video_id, "Record": False, "ApiVer": "v1.1.0",
    }
    status, payload, _headers = await asyncio.to_thread(
        _http_json, "POST", _mirror() + CINEMA_PATH, body)
    if status != 200:
        return {"kind": "error", "status": status,
                "error": str(payload)[:200]}
    if payload.get("URL"):
        return {"kind": "direct", "url": payload["URL"],
                "fullscreenAllowed": payload.get("FullscreenAllowed")}
    if payload.get("ExternalAuthURL"):
        return {"kind": "external", "providerId": payload.get("ProviderID"),
                "externalAuthUrl": payload.get("ExternalAuthURL"),
                "providerAccessToken": payload.get("AccessToken"),
                "fullscreenAllowed": payload.get("FullscreenAllowed")}
    if payload.get("Error"):
        return {"kind": "error", "status": status,
                "error": payload.get("Error"),
                "errorCode": payload.get("ErrorCode")}
    return {"kind": "error", "status": status,
            "error": f"unexpected cinema response: {str(payload)[:200]}"}


@app.get("/health")
async def health():
    user, _ = _read_creds()
    return {
        "ok": True,
        "mode": "account",
        "creds_configured": bool(user),
        "mirror": _mirror(),
    }


@app.get("/stream")
async def stream(videoId: str):
    """Mint a stream URL for a full DR_ video id.

    Example: /stream?videoId=DR_4_21067736  (or a bare numeric id, which
    the feed also uses for some games, e.g. 21069237).
    Returns {"kind":"direct","url":...} for a native-playable stream,
    {"kind":"external",...} when the match goes through an external
    provider (Perform/Opta), or a 502 with a clear error.
    """
    if not videoId:
        raise HTTPException(400, "videoId is required, e.g. DR_4_21067736")
    video_id = videoId if videoId.startswith("DR_") else videoId
    try:
        token = await _ensure_token()
    except Exception as e:
        raise HTTPException(502, f"no live 1xBet session: {e}")
    result = await _mint_cinema(video_id, token)
    if result["kind"] == "error" and result.get("errorCode") == 3:
        # Token rejected ("Log in to view") — drop the cached token and
        # retry once with a fresh login.
        global _cached_token
        _cached_token = ""
        try:
            token = await _ensure_token()
        except Exception as e:
            raise HTTPException(502, f"re-login failed: {e}")
        result = await _mint_cinema(video_id, token)
    if result["kind"] == "direct":
        return {"videoId": video_id, "kind": "direct",
                "url": result["url"],
                "fullscreenAllowed": result.get("fullscreenAllowed")}
    if result["kind"] == "external":
        # The provider token is a credential: do not return it. The caller
        # (player/bot) gets the auth URL + provider id; the minter follows
        # the provider auth in a later step.
        return {"videoId": video_id, "kind": "external",
                "providerId": result.get("providerId"),
                "externalAuthUrl": result.get("externalAuthUrl"),
                "fullscreenAllowed": result.get("fullscreenAllowed"),
                "note": "external provider (Perform/Opta): follow the "
                        "externalAuthUrl with the provider token held "
                        "server-side"}
    raise HTTPException(502, f"cinema mint failed: {result.get('error')} "
                             f"(code {result.get('errorCode')})")


@app.get("/token")
async def token():
    """Debug: report whether a live session token is available (no value)."""
    try:
        tok = await _ensure_token()
        return {"token_present": bool(tok),
                "token_len": len(tok) if tok else 0}
    except Exception as e:
        raise HTTPException(502, f"no live session: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8803)
