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

VM LOGIN IS DEAD (proven 22 Nov 2026, two tests):
- The VM's API login returns only a PARTIAL session (SESSION + auid);
  token/refresh returns nothing, even with a device UUID (che_g /
  fatman_uuid) sent. No uhash / access_token / authenticated.
- A real (stealth) browser on the VM gets a DEGRADED page with zero
  input fields — no login form at all.
  The server distrusts the VM's datacentre IP. No free VM login works.

CHROME MINTING (live 22 Nov 2026) — the working free route:
- The user's Chrome IS logged in (full session: uhash, access_token
  557-char JWT, authenticated) and the access_token is readable from
  document.cookie in the 1xBet tab (not httpOnly).
- The minter mints THROUGH his Chrome: it calls the browser-driver
  backend (127.0.0.1:8802) to run JS in the 1xBet tab; the JS reads the
  access_token from document.cookie and POSTs /cinema from the page
  (same-origin, cookies sent automatically), storing the result in
  window.__cinemaMint. The minter polls and returns the stream URL.
  The access_token NEVER leaves his Chrome — only the minted URL does.
  Proven 22 Nov: cricket DR_4_21072111 minted a direct edge14.xmediaget
  m3u8 (ui=1887996073, the spare account) from his Chrome.
- Limitation: works ONLY while his Chrome is open with a 1xBet tab
  (the minter opens one in the background if none exists). Not 24/7.
- The minter holds the browser-driver API key (DRIVER_API_KEY in
  /opt/cinema/.env, copied from /opt/browser-driver/.env) so it can call
  the driver backend on localhost. The key stays in a mode-600 file.

How the direct /cinema path works (kept for reference):
1. The minter logs in DIRECTLY via the login API (no page UI).
   POST /web-api/api/internal/office/account/login with the service
   account credentials (ONEX_USER / ONEX_PASS from /opt/cinema/.env).
   That returns 204 + a session cookie — NOT the token /cinema wants.
   A second call, POST /web-api/api/internal/user/token/refresh,
   returns 204 + the access_token cookie (a ~557-char JWT).
   (Both endpoints found 22 Nov 2026 in the site's shared base-app JS
   chunk; the browser's TokenService does exactly this two-step flow.)
   THIS PATH DOES NOT WORK FROM THE VM (partial session only).
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

Ports: 8803 (Nexus 8801, browser-driver 8802). Caddy route: /cinema-api/
"""

import asyncio
import json
import logging
import os
import re
import time
import urllib.parse
import urllib.request
import urllib.error

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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

# stream.html on aayushlife.live calls this from the browser — without
# CORS headers the browser blocks the response ("Failed to fetch") and
# the page hangs on "Getting the stream link…". Allow any origin,
# same as the other public resolvers (onexbet proxy, Bigg Boss proxy).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

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

# Cached access token + expiry (token lives ~20 min). The session cookies
# from login are cached alongside it — /cinema is called with both the
# AccessToken and the session cookies, exactly as the browser does.
_cached_token = ""
_cached_cookies = {}
_cached_token_at = 0.0
TOKEN_TTL_S = 15 * 60


def _parse_set_cookies(headers):
    """Parse Set-Cookie headers into {name: value}. Logs names + lengths
    only (never values) so a failed login is diagnosable."""
    out = {}
    if headers is None:
        return out
    for c in (headers.get_all("Set-Cookie") or []):
        # First name=value pair, before any ';' attributes.
        first = c.split(";", 1)[0]
        if "=" in first:
            name, value = first.split("=", 1)
            out[name.strip()] = urllib.parse.unquote(value.strip())
    if out:
        log.info("Set-Cookie: %s",
                 ", ".join(f"{k}:{len(v)}" for k, v in out.items()))
    else:
        log.info("Set-Cookie: none")
    return out


def _cookie_header(cookies):
    """Build a Cookie request header from a {name: value} dict."""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


def _http_json(method, url, body=None, timeout=30, extra_headers=None,
               cookies=None):
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
    if cookies:
        req.add_header("Cookie", _cookie_header(cookies))
    if extra_headers:
        for k, v in extra_headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    # Step 1: login. Parse the session cookies from the response headers
    # (the CookieJar proved unreliable here — the login sets cookies the
    # jar drops, so cookies are carried explicitly).
    # Body fields (resolved 22 Nov 2026 from the welcome-app JS):
    # the login endpoint's expectedParams are {...RR(), ...vR()} where
    # RR() -> {"login": ...} and vR() -> {"authByEmail": ...}. The spare
    # account logs in by ID (not email), so authByEmail is false.
    # Omitting authByEmail made the server return only a partial session
    # (SESSION + auid, no uhash / access_token / authenticated).
    body = {"login": user, "password": password, "authByEmail": False}
    status, payload, headers = _http_json(
        "POST", mirror + LOGIN_PATH, body, timeout=30)
    log.info("login POST -> %s, payload keys: %s",
             status, list(payload.keys()) if isinstance(payload, dict) else type(payload))
    cookies = _parse_set_cookies(headers)
    session = (cookies.get("uhash") or cookies.get("SESSION") or
               cookies.get("sh.session.id") or cookies.get("session"))
    log.info("login session cookie present: %s", bool(session))
    # Step 2: refresh the access token (needs the session cookie).
    # refreshAccessToken's expectedParams are {initiator, responseStatus},
    # so the body carries an initiator naming what triggered the refresh.
    status2, payload2, headers2 = _http_json(
        "POST", mirror + TOKEN_REFRESH_PATH,
        {"initiator": "login"}, timeout=30, cookies=cookies)
    log.info("token/refresh POST -> %s", status2)
    cookies2 = _parse_set_cookies(headers2)
    cookies.update(cookies2)
    token = cookies.get("access_token")
    if token and len(token) > 100:
        log.info("token/refresh OK (access_token len %d)", len(token))
        return token, cookies
    # Fall back to anything the responses carried in the body.
    token = _extract_token(status2, payload2, headers2)
    if token and len(token) > 100:
        return token, cookies
    token = _extract_token(status, payload, headers)
    if token and len(token) > 100:
        return token, cookies
    raise RuntimeError(
        f"login OK (session={bool(session)}) but no access_token JWT after "
        f"token/refresh (refresh HTTP {status2}); cookies after login: "
        f"{sorted(cookies.keys())}, after refresh: {sorted(cookies2.keys())}")


async def _ensure_token():
    """Return (access_token, session_cookies), logging in if needed."""
    global _cached_token, _cached_cookies, _cached_token_at
    async with _session_lock:
        if (_cached_token and
                time.time() - _cached_token_at < TOKEN_TTL_S):
            return _cached_token, _cached_cookies
        token, cookies = await asyncio.to_thread(_api_login)
        _cached_token = token
        _cached_cookies = cookies
        _cached_token_at = time.time()
        return token, cookies


async def _mint_cinema(video_id, access_token, cookies=None):
    """POST /cinema and classify the response."""
    body = {
        "AppId": 101, "AppVer": "1025",
        "VpcVer": "v3.0.2", "CoreVer": "v3.0.2",
        "Language": "en", "AccessToken": access_token,
        "VideoId": video_id, "Record": False, "ApiVer": "v1.1.0",
    }
    status, payload, _headers = await asyncio.to_thread(
        _http_json, "POST", _mirror() + CINEMA_PATH, body,
        cookies=cookies)
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


# ---------------------------------------------------------------------------
# Chrome minting (the working free route — the VM cannot log in, his Chrome
# can). The minter drives his Chrome through the browser-driver backend on
# localhost (127.0.0.1:8802). The access_token never leaves his Chrome:
# the JS reads it from document.cookie and POSTs /cinema from the page;
# only the minted URL comes back.
# ---------------------------------------------------------------------------

DRIVER_BASE = os.environ.get("DRIVER_BASE", "http://127.0.0.1:8802")
DRIVER_TIMEOUT_S = 30


def _read_driver_key():
    """Read DRIVER_API_KEY (the browser-driver Muse key) from env or the
    creds file. The deploy step copies it from /opt/browser-driver/.env."""
    key = os.environ.get("DRIVER_API_KEY")
    if key:
        return key
    try:
        with open(CREDS_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "DRIVER_API_KEY":
                    return v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return ""


def _driver_call(action, args):
    """POST one command to the browser-driver backend. Returns the parsed
    JSON body (or an error dict). Raises on transport failure."""
    key = _read_driver_key()
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
    """Run JS in a tab via evaluate_js. Returns the result value string
    (or raises on error). evaluate_js does NOT await promises, so async
    work must fire-and-store in a window global and be read back."""
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


def _find_1xbet_tab():
    """Return the tab id of an open 1xBet tab, or None."""
    res = _driver_call("list_tabs", {})
    tabs = (res or {}).get("result") or []
    for t in tabs:
        url = (t or {}).get("url") or ""
        if "1xlite" in url or "1xbet" in url.lower():
            return t.get("tab_id")
    return None


def _open_1xbet_tab():
    """Open a 1xBet tab in the background (does not steal focus)."""
    res = _driver_call("open_tab",
                       {"url": "https://1xlite-6229051.com/en",
                        "active": False, "confirm": True})
    tab = (res or {}).get("result") or {}
    tab_id = tab.get("tab_id")
    if not tab_id:
        raise RuntimeError(f"could not open a 1xBet tab: {str(res)[:200]}")
    return tab_id


_MINT_FIRE_JS = """(() => {
  const m = document.cookie.match(/(?:^|;\\s*)access_token=([^;]*)/);
  const token = m ? m[1] : '';
  if (!token) { window.__cinemaMint = JSON.stringify({error: 'no access_token in cookie — not logged in to 1xBet in this Chrome'}); return 'no-token'; }
  window.__cinemaMint = JSON.stringify({pending: true});
  fetch('/cinema', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      AppId: 101, AppVer: '1025', VpcVer: 'v3.0.2', CoreVer: 'v3.0.2',
      Language: 'en', OS: 'Windows',
      Token: token, AccessToken: token,
      VideoId: '__VIDEO_ID__', Record: false, ApiVer: 'v1.1.0'
    })
  }).then(r => r.text()).then(t => { window.__cinemaMint = t; })
    .catch(e => { window.__cinemaMint = JSON.stringify({error: 'cinema fetch failed: ' + e.message}); });
  return 'started';
})()"""


def _mint_via_chrome(video_id, wait_s=20):
    """Mint a stream URL through the user's Chrome. Returns the same
    classified dict as _mint_cinema. Raises on driver/Chrome failure."""
    tab_id = _find_1xbet_tab()
    if not tab_id:
        tab_id = _open_1xbet_tab()
        # Let the 1xBet SPA mount before running the fetch.
        time.sleep(8)
    js = _MINT_FIRE_JS.replace("__VIDEO_ID__", video_id)
    started = _driver_eval(tab_id, js)
    if started == "no-token":
        raise RuntimeError("Chrome is not logged in to 1xBet "
                           "(no access_token cookie in the 1xBet tab)")
    # Poll until the fetch completes (window.__cinemaMint stops being
    # {"pending": true}) or we time out.
    deadline = time.time() + wait_s
    raw = ""
    while time.time() < deadline:
        raw = _driver_eval(
            tab_id,
            "(() => { return window.__cinemaMint || ''; })()")
        if raw and '"pending":true' not in raw and '"pending": true' not in raw:
            break
        time.sleep(2)
    if not raw:
        raise RuntimeError("Chrome mint timed out (no result from the "
                           "1xBet tab after %ds)" % wait_s)
    if '"pending"' in raw:
        raise RuntimeError("Chrome mint timed out (cinema fetch still "
                           "pending after %ds)" % wait_s)
    try:
        payload = json.loads(raw)
    except Exception:
        return {"kind": "error", "error": f"unparsable cinema reply: {raw[:200]}"}
    if isinstance(payload, dict) and payload.get("error"):
        return {"kind": "error", "error": str(payload["error"])[:200]}
    if payload.get("URL"):
        return {"kind": "direct", "url": payload["URL"],
                "fullscreenAllowed": payload.get("FullscreenAllowed")}
    if payload.get("ExternalAuthURL"):
        return {"kind": "external", "providerId": payload.get("ProviderID"),
                "externalAuthUrl": payload.get("ExternalAuthURL"),
                "providerAccessToken": payload.get("AccessToken"),
                "fullscreenAllowed": payload.get("FullscreenAllowed")}
    if payload.get("Error"):
        return {"kind": "error", "error": payload.get("Error"),
                "errorCode": payload.get("ErrorCode")}
    return {"kind": "error",
            "error": f"unexpected cinema response: {str(payload)[:200]}"}


@app.get("/health")
async def health():
    user, _ = _read_creds()
    return {
        "ok": True,
        "mode": "chrome",
        "creds_configured": bool(user),
        "driver_key_configured": bool(_read_driver_key()),
        "mirror": _mirror(),
    }


@app.get("/stream-chrome")
async def stream_chrome(videoId: str):
    """Mint a stream URL THROUGH the user's Chrome (the working free
    route — the VM cannot log in, his Chrome can).

    The minter drives his Chrome via the browser-driver: the 1xBet tab
    POSTs /cinema from the page using the access_token in its cookie.
    The token never leaves his Chrome; only the minted URL is returned.
    Requires his Chrome to be open (a 1xBet tab is opened in the
    background if none exists) and logged in to 1xBet.

    Example: /stream-chrome?videoId=DR_4_21072111
    Returns {"kind":"direct","url":...} for a native-playable stream,
    {"kind":"external",...} when the match goes through an external
    provider, or a 502 with a clear error.
    """
    if not videoId:
        raise HTTPException(400, "videoId is required, e.g. DR_4_21072111")
    video_id = videoId if videoId.startswith("DR_") else videoId
    try:
        result = await asyncio.to_thread(_mint_via_chrome, video_id)
    except Exception as e:
        raise HTTPException(502, f"Chrome mint failed: {e}")
    if result["kind"] == "direct":
        return {"videoId": video_id, "kind": "direct",
                "url": result["url"],
                "fullscreenAllowed": result.get("fullscreenAllowed"),
                "via": "chrome"}
    if result["kind"] == "external":
        return {"videoId": video_id, "kind": "external",
                "providerId": result.get("providerId"),
                "externalAuthUrl": result.get("externalAuthUrl"),
                "fullscreenAllowed": result.get("fullscreenAllowed"),
                "via": "chrome",
                "note": "external provider (Perform/Opta): follow the "
                        "externalAuthUrl with the provider token held "
                        "server-side"}
    raise HTTPException(502, f"Chrome mint failed: {result.get('error')} "
                             f"(code {result.get('errorCode')})")


@app.get("/stream")
async def stream(videoId: str):
    """Mint a stream URL for a full DR_ video id.

    Example: /stream?videoId=DR_4_21067736  (or a bare numeric id, which
    the feed also uses for some games, e.g. 21069237).
    Returns {"kind":"direct","url":...} for a native-playable stream,
    {"kind":"external",...} when the match goes through an external
    provider (Perform/Opta), or a 502 with a clear error.

    NOTE: this direct path does NOT work from the VM (the server only
    grants the VM a partial session). Use /stream-chrome instead, which
    mints through the user's Chrome.
    """
    if not videoId:
        raise HTTPException(400, "videoId is required, e.g. DR_4_21067736")
    video_id = videoId if videoId.startswith("DR_") else videoId
    try:
        token, cookies = await _ensure_token()
    except Exception as e:
        raise HTTPException(502, f"no live 1xBet session: {e}")
    result = await _mint_cinema(video_id, token, cookies)
    if result["kind"] == "error" and result.get("errorCode") == 3:
        # Token rejected ("Log in to view") — drop the cached token and
        # retry once with a fresh login.
        global _cached_token
        _cached_token = ""
        try:
            token, cookies = await _ensure_token()
        except Exception as e:
            raise HTTPException(502, f"re-login failed: {e}")
        result = await _mint_cinema(video_id, token, cookies)
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
    """Debug: report whether a live session token is available via the
    DIRECT (VM) login (no value). NOTE: the direct login is known-dead
    from the VM (partial session only) — use /stream-chrome instead."""
    try:
        tok, _cookies = await _ensure_token()
        return {"token_present": bool(tok),
                "token_len": len(tok) if tok else 0}
    except Exception as e:
        raise HTTPException(502, f"no live session: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8803)
