"""Test: can a real (stealth) browser login from the VM get a FULL session?

This answers the key question: is the VM's partial login caused by the
datacentre IP, or by the headless browser being detected?

The script launches Playwright Chromium with stealth settings, opens the
1xBet login page, and reports:
  1. Whether the login form renders (input fields present).
  2. Whether logging in with the spare account sets the FULL session
     cookies (uhash, access_token, authenticated) or only the partial
     ones (SESSION, auid).

Credentials are read from /opt/cinema/.env (ONEX_USER / ONEX_PASS) on the
VM — never in this script, never in chat. Run on the VM as:
    /opt/cinema/.venv/bin/python test-browser-login.py
"""
import asyncio
import json
import os
import sys


def _read_creds():
    user = os.environ.get("ONEX_USER")
    password = os.environ.get("ONEX_PASS")
    try:
        with open("/opt/cinema/.env") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "ONEX_USER":
                    user = user or v.strip().strip('"').strip("'")
                elif k.strip() == "ONEX_PASS":
                    password = password or v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return user, password


async def main():
    user, password = _read_creds()
    if not user or not password:
        print("NO_CREDS")
        return 1
    from playwright.async_api import async_playwright

    result = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
            ],
        )
        ctx = await browser.new_context(
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
            viewport={"width": 1366, "height": 768},
            locale="en-US",
        )
        page = await ctx.new_page()
        await page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', "
            "{get: () => undefined});")
        # Go to the login/registration page and wait for the SPA to mount.
        await page.goto("https://1xlite-6229051.com/en/registration",
                        wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(8000)
        result["title"] = await page.title()
        # Count input fields (the degraded page has ZERO).
        inputs = await page.evaluate(
            "() => Array.from(document.querySelectorAll('input')).map("
            "i => (i.name || i.type || i.placeholder || '').slice(0, 30))")
        result["input_count"] = len(inputs)
        result["inputs"] = inputs[:10]
        # Look for a Log in button / link.
        login_btn = await page.evaluate(
            "() => { const els = Array.from(document.querySelectorAll("
            "'button, a')); const m = els.find(e => /log in/i.test("
            "e.textContent || '')); return m ? m.textContent.trim() : ''; }")
        result["login_button"] = login_btn
        if not inputs:
            result["verdict"] = ("DEGRADED_PAGE: no input fields — the "
                                 "server serves a stripped page to this "
                                 "browser/IP; a form login is impossible")
            print(json.dumps(result, indent=2))
            await browser.close()
            return 0
        # The form rendered — try to log in.
        try:
            await page.click("text=Log in", timeout=5000)
            await page.wait_for_timeout(2000)
        except Exception:
            pass
        filled = False
        for sel in ("input[name='login']", "input[type='text']",
                    "input[placeholder*='ID' i]"):
            try:
                await page.fill(sel, user, timeout=3000)
                filled = True
                break
            except Exception:
                continue
        result["username_filled"] = filled
        if filled:
            for sel in ("input[name='password']", "input[type='password']"):
                try:
                    await page.fill(sel, password, timeout=3000)
                    break
                except Exception:
                    continue
            try:
                await page.click("button[type='submit']", timeout=5000)
            except Exception:
                await page.keyboard.press("Enter")
            await page.wait_for_timeout(6000)
        # Read the cookies (names + lengths only, never values).
        cookies = await ctx.cookies()
        result["cookies"] = {c["name"]: len(c["value"]) for c in cookies}
        names = {c["name"] for c in cookies}
        full = {"uhash", "access_token", "authenticated"} <= names
        result["full_session"] = full
        result["verdict"] = (
            "FULL_SESSION: browser login set uhash + access_token + "
            "authenticated — the VM browser CAN log in; use the browser "
            "for the minter" if full else
            "PARTIAL_SESSION: browser login did NOT set the full session "
            "— the server distrusts this VM/IP even from a real browser")
        print(json.dumps(result, indent=2))
        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
