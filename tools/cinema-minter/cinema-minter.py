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
1. A headless Chromium (Playwright) with a PERSISTENT profile
   (/opt/cinema/.profile) stays logged into 1xBet as the SERVICE account
   (a dedicated account created for this minter — NOT the user's personal
   account). Credentials come from /opt/cinema/.env (ONEX_USER / ONEX_PASS),
   written by the operator, never in code or in chat.
2. When a stream is requested, the minter reads the current access_token
   from the logged-in browser (localStorage/cookies) and POSTs /cinema
   with it + the full DR_ video id.
3. /cinema answers in one of three shapes:
   - Direct URL (xmediaget m3u8) -> returned as-is; plays natively.
   - ExternalAuthURL + provider AccessToken (Perform/Opta, ProviderID 1/3)
     -> returned as an external-auth result; the caller must follow the
     provider auth (a separate API).
   - Error (geo-blocked code 5, "Log in to view" code 3, low deposit) ->
     returned as a clear error.
4. The access_token lives ~20 min; the browser session keeps it fresh
   (1xBet refreshes it while the session is alive). If /cinema says the
   token is invalid, the minter re-reads it from the browser; if the
   session itself died, it re-logs in with the stored credentials.

Ports: 8803 (Nexus 8801, browser-driver 8802). Caddy route: /cinema-api/
"""

import asyncio
import json
import logging
import os
import time
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

# Persistent browser profile (cookies/session survive restarts) and the
# credentials file. Both live under /opt/cinema on the VM, never in the repo.
PROFILE_DIR = os.environ.get("CINEMA_PROFILE_DIR", "/opt/cinema/.profile")
CREDS_FILE = os.environ.get("CINEMA_CREDS_FILE", "/opt/cinema/.env")

# How long a minted stream URL is treated as fresh (the signed URL itself
# is time-limited server-side; this is only a cache guard).
TOKEN_REFRESH_MARGIN_S = 60

app = FastAPI(title="cinema-minter")

_mirror_idx = 0
_session_lock = asyncio.Lock()
_browser = None
_context = None
_page = None


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


def _http_json(method, url, body=None, timeout=30):
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
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"raw": ""}
        return e.code, payload


async def _ensure_browser():
    """Launch (or reuse) the persistent logged-in browser."""
    global _browser, _context, _page
    if _page is not None:
        try:
            await _page.evaluate("1")
            return _page
        except Exception:
            _page = None
    from playwright.async_api import async_playwright

    pw = await async_playwright().start()
    _browser = await pw.chromium.launch_persistent_context(
        user_data_dir=PROFILE_DIR,
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage",
              "--disable-blink-features=AutomationControlled"],
        user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"),
        viewport={"width": 1280, "height": 800},
        locale="en-US",
    )
    _context = _browser
    pages = _context.pages
    _page = pages[0] if pages else await _context.new_page()
    await _page.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', "
        "{get: () => undefined});")
    return _page


async def _is_logged_in(page):
    """True if the browser has a live 1xBet session."""
    try:
        val = await page.evaluate(
            "() => {"
            "  try { if (localStorage.getItem('access_token')) return 'ls'; } catch(e) {}"
            "  const m = document.cookie.match(/(?:^|; )access_token=([^;]*)/);"
            "  return m ? 'cookie' : '';"
            "}")
        return bool(val)
    except Exception:
        return False


async def _login(page):
    """Log in as the service account. Raises if credentials are missing."""
    user, password = _read_creds()
    if not user or not password:
        raise RuntimeError(
            "no service-account credentials: set ONEX_USER / ONEX_PASS in "
            f"{CREDS_FILE} (or env). The account must be a dedicated 1xBet "
            "account for this minter, not the user's personal account.")
    mirror = _mirror()
    await page.goto(mirror + "/en/registration", wait_until="domcontentloaded",
                    timeout=60000)
    await page.wait_for_timeout(3000)
    # The login form lives on the auth page; try the login link first.
    try:
        await page.click("text=Log in", timeout=5000)
        await page.wait_for_timeout(2000)
    except Exception:
        pass
    # Fill the username / password fields (try common selectors).
    filled = False
    for sel in ("input[name='login']", "input[type='text']",
                "input[placeholder*='ID' i]", "input[placeholder*='login' i]"):
        try:
            await page.fill(sel, user, timeout=3000)
            filled = True
            break
        except Exception:
            continue
    if not filled:
        raise RuntimeError("login form not found (username field)")
    for sel in ("input[name='password']", "input[type='password']"):
        try:
            await page.fill(sel, password, timeout=3000)
            break
        except Exception:
            continue
    # Submit.
    try:
        await page.click("button[type='submit']", timeout=5000)
    except Exception:
        await page.keyboard.press("Enter")
    await page.wait_for_timeout(5000)
    if not await _is_logged_in(page):
        raise RuntimeError("login failed: no session token after sign-in "
                           "(wrong credentials, or a captcha/2FA is in the way)")
    log.info("logged in as service account")


async def _get_access_token(page):
    """Read the current access_token from the logged-in browser."""
    try:
        tok = await page.evaluate(
            "() => {"
            "  try { const t = localStorage.getItem('access_token');"
            "        if (t) return t; } catch(e) {}"
            "  try { const t = sessionStorage.getItem('access_token');"
            "        if (t) return t; } catch(e) {}"
            "  const m = document.cookie.match(/(?:^|; )access_token=([^;]*)/);"
            "  return m ? decodeURIComponent(m[1]) : '';"
            "}")
        return tok or ""
    except Exception:
        return ""


async def _ensure_logged_in():
    """Return a page with a live session, logging in if needed."""
    async with _session_lock:
        page = await _ensure_browser()
        # Land on a 1xBet page so storage/cookies are readable.
        try:
            await page.goto(_mirror() + "/en/live/football",
                            wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(2000)
        except Exception as e:
            log.warning("goto live page failed: %s", e)
        if await _is_logged_in(page):
            return page
        await _login(page)
        return page


async def _mint_cinema(video_id, access_token):
    """POST /cinema and classify the response."""
    body = {
        "AppId": 101, "AppVer": "1025",
        "VpcVer": "v3.0.2", "CoreVer": "v3.0.2",
        "Language": "en", "AccessToken": access_token,
        "VideoId": video_id, "Record": False, "ApiVer": "v1.1.0",
    }
    status, payload = await asyncio.to_thread(
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
        page = await _ensure_logged_in()
        token = await _get_access_token(page)
        if not token:
            raise RuntimeError("logged in but no access_token readable")
    except Exception as e:
        raise HTTPException(502, f"no live 1xBet session: {e}")
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
        page = await _ensure_logged_in()
        tok = await _get_access_token(page)
        return {"token_present": bool(tok),
                "token_len": len(tok) if tok else 0}
    except Exception as e:
        raise HTTPException(502, f"no live session: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8803)
