# vm-headless-test.py — test whether the CineSrc embed flow works in a
# headless Chromium ON THIS VM (datacentre IP). Opens the Inception
# embed page, waits, prints any .m3u8 URLs seen on the wire.
# Run: pip install playwright && playwright install chromium && python3 vm-headless-test.py
import json
from playwright.sync_api import sync_playwright

URLS = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
    pg = b.new_page()
    pg.on("response", lambda r: URLS.append(r.url) if ".m3u8" in r.url else None)
    pg.on("console", lambda m: print("CONSOLE:", m.type, m.text[:200]))
    pg.on("pageerror", lambda e: print("PAGEERROR:", str(e)[:300]))
    try:
        pg.goto("https://cinesrc.st/embed/movie/27205", timeout=60000)
    except Exception as e:
        print("GOTO FAILED:", e)
    pg.wait_for_timeout(45000)
    print("M3U8_URLS:", json.dumps([u for u in URLS if "m3u8" in u][:10]))
    try:
        vs = pg.evaluate("() => { const v = document.querySelector('video'); return v ? {src: v.currentSrc, t: v.currentTime, paused: v.paused} : null; }")
        print("VIDEO:", json.dumps(vs))
    except Exception as e:
        print("VIDEO CHECK FAILED:", e)
    b.close()
