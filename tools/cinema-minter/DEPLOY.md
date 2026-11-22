# Cinema minter — deploy / update steps (run in the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the Nexus resolver (8801) and browser-driver (8802).
# The minter runs on 127.0.0.1:8803 and is exposed via Caddy /cinema-api/ on
# mret.aayushlife.live.
#
# STATE 22 Nov 2026 — CHROME MINTING is the live route.
# - The VM CANNOT log in to 1xBet (proven): the API login returns only a
#   partial session (SESSION + auid, no access_token), even with a device
#   UUID; a real browser on the VM gets a degraded page with no login form.
#   The server distrusts the VM's datacentre IP. The direct /stream path
#   (VM login) is dead; do not try to fix it from the VM.
# - The WORKING route is /stream-chrome: the minter mints THROUGH the
#   user's Chrome via the browser-driver backend (127.0.0.1:8802). His
#   Chrome is logged in; the JS reads the access_token from
#   document.cookie and POSTs /cinema from the 1xBet tab. The token never
#   leaves his Chrome — only the minted URL comes back. Proven 22 Nov
#   (cricket DR_4_21072111 -> direct edge14.xmediaget m3u8).
# - Limitation: works ONLY while his Chrome is open (a 1xBet tab is
#   opened in the background if none exists) and logged in. Not 24/7.
#
# The minter needs the browser-driver API key (DRIVER_API_KEY) in
# /opt/cinema/.env so it can call the driver backend on localhost. Copy it
# from /opt/browser-driver/.env (DRIVER_CLAUDE_API_KEY). The key stays in a
# mode-600 file owned by cinema; never print it, never put it in the repo.

# 1. Create the service user + directory (first install only)
sudo useradd -r -s /usr/sbin/nologin cinema 2>/dev/null || true
sudo mkdir -p /opt/cinema
sudo chown cinema:cinema /opt/cinema

# 2. Copy the code (from the repo) into /opt/cinema/cinema-minter.py
#    (assumes cinema-minter.py is in the current directory)
sudo cp cinema-minter.py /opt/cinema/cinema-minter.py
sudo chown cinema:cinema /opt/cinema/cinema-minter.py

# 3. Python venv + deps (FastAPI, uvicorn). Playwright is NOT needed any
#    more (no headless browser login); httpx is used by the test scripts.
sudo python3 -m venv /opt/cinema/.venv
sudo /opt/cinema/.venv/bin/pip install -q fastapi uvicorn httpx
sudo chown -R cinema:cinema /opt/cinema/.venv

# 4. Credentials (do this ONCE, on the VM only).
#    a. Service-account credentials (kept for the direct path + health;
#       the direct login is dead from the VM but the creds stay configured):
#       sudo sh -c 'printf "ONEX_USER=<service account id>\nONEX_PASS=<password>\n" > /opt/cinema/.env'
#    b. Browser-driver key (REQUIRED for /stream-chrome). Read the Muse
#       key from /opt/browser-driver/.env (DRIVER_CLAUDE_API_KEY) and
#       append it to /opt/cinema/.env as DRIVER_API_KEY. Do it without
#       printing the key:
#       sudo sh -c 'K=$(grep ^DRIVER_CLAUDE_API_KEY= /opt/browser-driver/.env | cut -d= -f2-); printf "DRIVER_API_KEY=%s\n" "$K" >> /opt/cinema/.env'
#       Then: sudo chmod 600 /opt/cinema/.env; sudo chown cinema:cinema /opt/cinema/.env
#    Never print, paste, or log the key value.

# 5. Install + start the service (first install) or restart (update)
sudo cp cinema-minter.service /etc/systemd/system/cinema-minter.service
sudo systemctl daemon-reload
sudo systemctl enable cinema-minter
sudo systemctl restart cinema-minter
sudo systemctl status cinema-minter --no-pager | head -15

# 6. Caddy route on mret.aayushlife.live (already present; add only if missing,
#    inside the site block, next to the /nexus-api/ and /driver-api/ routes):
#    handle /cinema-api/* {
#        uri strip_prefix /cinema-api
#        reverse_proxy 127.0.0.1:8803
#    }
#    Then: sudo systemctl reload caddy (or: caddy validate + reload per the
#    existing Caddy setup). Back up the Caddyfile first.

# 7. Test (use a currently-live game id from the 1xBet live feed)
#    curl -s http://127.0.0.1:8803/health
#    curl -s "http://127.0.0.1:8803/stream-chrome?videoId=DR_4_21072111"
#    curl -s https://mret.aayushlife.live/cinema-api/health
#    /stream-chrome returns {"kind":"direct","url":...,"via":"chrome"} for a
#    native-playable stream, {"kind":"external",...} when the match goes
#    through an external provider (Perform/Opta), or a 502 with a clear
#    error (Chrome closed / extension not connected / not logged in /
#    geo-blocked / low deposit).
#    /stream (direct VM login) 502s with "no live 1xBet session" — expected.
