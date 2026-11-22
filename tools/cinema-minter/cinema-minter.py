"""
Cinema minter — mints 1xBet guest stream URLs with no login, no account token.

How it works
------------
1. A headless Chromium (Playwright) opens 1xlite, runs the page's own
   hdf.js verify flow (fetch hdf.js -> eval -> HDF.exec()), which fetches a
   fresh per-request challenge script, runs it, and POSTs the payload to
   /hd-api/external/verify. The server returns a guest {token, expiresAt}
   (valid ~4 hours). No login, no account token, no stored credentials.
2. The token is cached until shortly before expiry, then refreshed.
   /verify is flaky under rapid repeat calls (400s seen), so refreshes are
   rare (once per ~4h) and retried with backoff.
3. GET /stream?videoId=DR_4_21067736 calls POST /cinema with the cached
   token + full DR_ id and returns the signed m3u8 URL.

The challenge script is a per-request 378KB obfuscated fingerprinting
script. It does NOT check for headless/automation markers (no webdriver /
headless / playwright strings), so headless Chromium passes. It DOES detect
Node/Deno (typeof process), so the challenge must run inside a real browser,
not plain Node/Python.

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
HDF_JS = "/hd-api/external/assets/hdf.js"

# Refresh the token this many seconds before it expires.
REFRESH_MARGIN_S = 600
# How many times to retry a failed verify, with backoff.
VERIFY_RETRIES = 4
VERIFY_BACKOFF_S = [5, 15, 45, 120]

app = FastAPI(title="cinema-minter")

_token = None          # cached guest token (str)
_token_exp = 0         # unix expiry of the cached token
_token_lock = asyncio.Lock()
_mirror_idx = 0


def _mirror():
    return MIRRORS[_mirror_idx % len(MIRRORS)]


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


async def _run_verify_in_browser():
    """Run the page's own hdf.js verify flow in headless Chromium.

    Returns (token, expiresAt). Raises on failure.
    """
    from playwright.async_api import async_playwright

    mirror = _mirror()
    js = """
    (async () => {
      const out = {stage: 'start'};
      try {
        const r = await fetch('/hd-api/external/assets/hdf.js');
        out.hdfStatus = r.status;
        const txt = await r.text();
        eval(txt);
        out.hasHDF = typeof window.HDF !== 'undefined';
        const res = await window.HDF.exec();
        out.execDone = true;
        out.keys = res ? Object.keys(res) : [];
        out.hasToken = !!(res && res.token);
        out.expiresAt = res ? res.expiresAt : 0;
        if (res && res.token) { window.__minterToken = res.token; }
        if (res && res.error) { out.error = String(res.error).slice(0, 200); }
      } catch (e) { out.error = String(e).slice(0, 200); }
      window.__minterOut = out;
      return 'done';
    })()
    """
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        try:
            ctx = await browser.new_context(
                user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/120.0.0.0 Safari/537.36"),
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )
            page = await ctx.new_page()
            # Remove the automation flag so the page sees a normal browser.
            await page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', "
                "{get: () => undefined});")
            await page.goto(mirror + "/", wait_until="domcontentloaded",
                            timeout=60000)
            await page.evaluate(js)
            # The challenge takes ~2.5s; give it time, then read the result.
            for _ in range(30):
                await asyncio.sleep(1)
                out = await page.evaluate(
                    "window.__minterOut ? JSON.stringify(window.__minterOut) : ''")
                if out:
                    info = json.loads(out)
                    if info.get("execDone"):
                        break
            else:
                raise RuntimeError("verify flow did not finish in time")
            if not info.get("hasToken"):
                raise RuntimeError(
                    "verify returned no token: " +
                    str(info.get("error", info.get("keys"))))
            token = await page.evaluate("window.__minterToken || ''")
            if not token:
                raise RuntimeError("token missing after verify")
            return token, int(info["expiresAt"])
        finally:
            await browser.close()


async def _refresh_token():
    """Get a fresh guest token (cached). Retries with backoff on failure."""
    global _token, _token_exp, _mirror_idx
    async with _token_lock:
        now = time.time()
        if _token and _token_exp - now > REFRESH_MARGIN_S:
            return _token
        last_err = None
        for attempt in range(VERIFY_RETRIES):
            try:
                token, exp = await _run_verify_in_browser()
                _token, _token_exp = token, exp
                log.info("guest token refreshed, expires in %.0f min",
                         (exp - time.time()) / 60)
                return _token
            except Exception as e:
                last_err = e
                log.warning("verify attempt %d failed: %s", attempt + 1, e)
                # Try the other mirror next time.
                _mirror_idx += 1
                if attempt + 1 < VERIFY_RETRIES:
                    await asyncio.sleep(VERIFY_BACKOFF_S[attempt])
        raise RuntimeError(f"verify failed after retries: {last_err}")


@app.get("/health")
async def health():
    now = time.time()
    valid = bool(_token and _token_exp - now > 0)
    return {
        "ok": True,
        "token_valid": valid,
        "token_expires_in_s": max(0, int(_token_exp - now)) if _token else 0,
        "mirror": _mirror(),
    }


@app.get("/stream")
async def stream(videoId: str):
    """Mint a fresh signed stream URL for a full DR_ video id.

    Example: /stream?videoId=DR_4_21067736
    """
    if not videoId or not videoId.startswith("DR_"):
        raise HTTPException(400, "videoId must be a full DR_ id, e.g. DR_4_21067736")
    try:
        token = await _refresh_token()
    except Exception as e:
        raise HTTPException(502, f"could not mint a guest token: {e}")
    body = {
        "AppId": 101, "AppVer": "1025",
        "VpcVer": "v3.0.2", "CoreVer": "v3.0.2",
        "Language": "en", "AccessToken": token,
        "VideoId": videoId, "Record": False, "ApiVer": "v1.1.0",
    }
    status, payload = await asyncio.to_thread(
        _http_json, "POST", _mirror() + CINEMA_PATH, body)
    if status != 200 or not payload.get("URL"):
        # Token may have expired; clear it so the next call refreshes.
        if status in (401, 403):
            async with _token_lock:
                _token, _token_exp = None, 0
        raise HTTPException(502, f"cinema mint failed ({status}): "
                                 f"{str(payload)[:200]}")
    return {
        "videoId": videoId,
        "url": payload["URL"],
        "fullscreenAllowed": payload.get("FullscreenAllowed"),
        "token_expires_in_s": max(0, int(_token_exp - time.time())),
    }


@app.get("/token")
async def token():
    """Return a fresh guest token (for debugging / the bot)."""
    try:
        t = await _refresh_token()
    except Exception as e:
        raise HTTPException(502, f"could not mint a guest token: {e}")
    return {"token": t, "expiresAt": int(_token_exp)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8803)
