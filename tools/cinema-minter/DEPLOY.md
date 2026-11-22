# Cinema minter — deploy steps (run in the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the Nexus resolver (8801) and browser-driver (8802).
# The minter runs on 127.0.0.1:8803 and is exposed via Caddy /cinema-api/ on
# mret.aayushlife.live.
#
# REVISED 22 Nov 2026 — account-token minting (guest-token path is DEAD).
# The /hd-api verify guest token does NOT authorize /cinema ("Log in to
# view"); /cinema needs a logged-in account token. So the minter keeps a
# headless Chromium with a PERSISTENT profile logged into 1xBet as a
# DEDICATED service account (created for this minter — NOT the user's
# personal account). Credentials live in /opt/cinema/.env (ONEX_USER /
# ONEX_PASS), written by the operator, never in code, chat, or the repo.
# The service account may need a small deposit to mint (the player code
# has a "low deposit" error).

# 1. Create the service user + directory
sudo useradd -r -s /usr/sbin/nologin cinema 2>/dev/null || true
sudo mkdir -p /opt/cinema
sudo chown cinema:cinema /opt/cinema

# 2. Copy the code (from the repo or scp) into /opt/cinema/cinema-minter.py
#    (assumes cinema-minter.py is in the current directory)
sudo cp cinema-minter.py /opt/cinema/cinema-minter.py
sudo chown cinema:cinema /opt/cinema/cinema-minter.py

# 3. Python venv + deps (FastAPI, uvicorn, playwright)
sudo python3 -m venv /opt/cinema/.venv
sudo /opt/cinema/.venv/bin/pip install -q fastapi uvicorn playwright
sudo chown -R cinema:cinema /opt/cinema/.venv

# 4. Chromium for Playwright + system deps (headless only)
sudo /opt/cinema/.venv/bin/playwright install chromium --with-deps
# If --with-deps is not supported, install deps manually:
# sudo apt-get update && sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
# NOTE: Playwright browsers live in /root/.cache/ms-playwright by default;
# the service unit sets PLAYWRIGHT_BROWSERS_PATH=/opt/cinema/.playwright
# (copy the browsers there, or reinstall as the cinema user).

# 4b. Service-account credentials (do this ONCE, on the VM only).
#     Create a dedicated 1xBet account for this minter first, then:
#     sudo sh -c 'printf "ONEX_USER=<service account id>\nONEX_PASS=<password>\n" > /opt/cinema/.env'
#     sudo chmod 600 /opt/cinema/.env
#     sudo chown cinema:cinema /opt/cinema/.env
#     The persistent browser profile (/opt/cinema/.profile) keeps the
#     session; the minter logs in once and reuses it. If the session dies,
#     it re-logs in with these credentials.

# 5. Install + start the service
sudo cp cinema-minter.service /etc/systemd/system/cinema-minter.service
sudo systemctl daemon-reload
sudo systemctl enable cinema-minter
sudo systemctl start cinema-minter
sudo systemctl status cinema-minter --no-pager | head -15

# 6. Caddy route on mret.aayushlife.live (add inside the site block, next to
#    the /nexus-api/ and /driver-api/ routes):
#    handle /cinema-api/* {
#        uri strip_prefix /cinema-api
#        reverse_proxy 127.0.0.1:8803
#    }
#    Then: sudo systemctl reload caddy (or: caddy validate + reload per the
#    existing Caddy setup). Back up the Caddyfile first.

# 7. Test
#    curl -s http://127.0.0.1:8803/health
#    curl -s "http://127.0.0.1:8803/stream?videoId=DR_4_21067736"
#    (use a currently-live game id; the Pune match may have finished)
#    curl -s https://mret.aayushlife.live/cinema-api/health
#    /stream returns {"kind":"direct","url":...} for a native-playable
#    stream, {"kind":"external",...} when the match goes through an
#    external provider (Perform/Opta), or a 502 with a clear error
#    (geo-blocked, low deposit, no session). Without credentials in
#    /opt/cinema/.env it 502s with "no service-account credentials".
