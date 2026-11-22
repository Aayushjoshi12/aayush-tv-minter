"""Debug the 1xBet login form structure in headless Chromium (VM).

Prints every input field (name/type/placeholder) and button on the
registration page and on the login modal, then tries the login with the
creds from /opt/cinema/.env and reports what happens (session token?
captcha? error text?). Usage: /opt/cinema/.venv/bin/python /tmp/debug-login.py
"""
import json
import os
import sys
import time

sys.path.insert(0, "/opt/cinema")
from playwright.sync_api import sync_playwright

MIRROR = "https://1xlite-6229051.com"
PROFILE = "/opt/cinema/.profile"

def read_creds():
    user = pw = None
    try:
        for line in open("/opt/cinema/.env"):
            line = line.strip()
            if line.startswith("ONEX_USER="):
                user = line.split("=", 1)[1].strip().strip('"').strip("'")
            elif line.startswith("ONEX_PASS="):
                pw = line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return user, pw

def dump_form(page, label):
    print(f"--- {label} ---")
    print("url:", page.url)
    print("title:", page.title()[:80])
    inputs = page.evaluate(
        "() => Array.from(document.querySelectorAll('input')).map(i => "
        "({name: i.name, type: i.type, placeholder: i.placeholder, "
        "id: i.id, cls: (i.className||'').toString().slice(0,60)}))")
    for inp in inputs:
        print("input:", json.dumps(inp))
    btns = page.evaluate(
        "() => Array.from(document.querySelectorAll('button')).map(b => "
        "({type: b.type, text: (b.textContent||'').trim().slice(0,40)}))")
    for b in btns[:20]:
        print("button:", json.dumps(b))
    # Captcha indicators
    html = page.content()
    for marker in ("captcha", "recaptcha", "hcaptcha", "cf-turnstile", "turnstile"):
        if marker.lower() in html.lower():
            print("CAPTCHA MARKER FOUND:", marker)

def main():
    user, pw = read_creds()
    print("creds present:", bool(user), bool(pw), "user:", user)
    with sync_playwright() as pw_ctx:
        browser = pw_ctx.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled"],
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"),
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', "
            "{get: () => undefined});")
        page.goto(MIRROR + "/en/registration",
                  wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        dump_form(page, "registration page")
        # Try the Log in link/button
        try:
            page.click("text=Log in", timeout=5000)
            page.wait_for_timeout(3000)
            dump_form(page, "after clicking Log in")
        except Exception as e:
            print("click 'Log in' failed:", str(e)[:150])
        # Try filling the login form if present
        if user and pw:
            filled = False
            for sel in ("input[name='login']", "input[type='text']",
                        "input[placeholder*='ID' i]",
                        "input[placeholder*='login' i]",
                        "input[name='username']", "input[name='email']"):
                try:
                    page.fill(sel, user, timeout=2000)
                    print("filled username via:", sel)
                    filled = True
                    break
                except Exception:
                    continue
            if not filled:
                print("NO username field matched any selector")
            else:
                for sel in ("input[name='password']", "input[type='password']"):
                    try:
                        page.fill(sel, pw, timeout=2000)
                        print("filled password via:", sel)
                        break
                    except Exception:
                        continue
                try:
                    page.click("button[type='submit']", timeout=5000)
                    print("clicked submit")
                except Exception:
                    page.keyboard.press("Enter")
                    print("pressed Enter")
                page.wait_for_timeout(6000)
                tok = page.evaluate(
                    "() => { try { return localStorage.getItem('access_token') || ''; } catch(e) { return ''; } }")
                print("access_token present after login:", bool(tok), "len:", len(tok))
                print("url after login:", page.url)
                # Any visible error text?
                err = page.evaluate(
                    "() => { const els = Array.from(document.querySelectorAll('*')).filter(e => e.children.length===0 && /wrong|incorrect|invalid|error|blocked|captcha/i.test(e.textContent||'')); return els.slice(0,5).map(e => e.textContent.trim().slice(0,120)); }")
                print("error-ish texts:", json.dumps(err))
        browser.close()

if __name__ == "__main__":
    main()
