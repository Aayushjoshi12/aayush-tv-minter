# CineSrc minter — deploy / update steps (run in the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the cinema minter (8803) and Nexus resolver (8801).
# Runs on 127.0.0.1:8805, exposed via Caddy /cinesrc-api/ on mret.aayushlife.live.
#
# WHAT IT DOES: resolves a TMDB id to the direct HLS URL behind Server 3
# (CineSrc). The URL is a static file (bright67.online .../master.m3u8,
# CORS *, no auth) whose UUID is STABLE per title — verified 25 Nov 2026:
# a full reload returned the identical URL. So mint once, cache forever.
# Minting runs the real CineSrc page in the user's Chrome via the
# browser-driver backend (127.0.0.1:8802) and reads the manifest URL out
# of the page. Needs his Chrome open with the driver extension connected.
# Cached titles need no Chrome at all.
#
# CODE LIVES in the aayush-tv-minter repo under tools/cinesrc-minter/
# (same precedent as tools/browser-driver/). Push there, then pull on VM.
#
# The minter needs the browser-driver API key (DRIVER_API_KEY) in
# /opt/cinesrc/.env, copied from /opt/browser-driver/.env
# (DRIVER_CLAUDE_API_KEY). The key stays in a mode-600 file; never print
# it, never put it in the repo. SEED_KEY is a random secret for the /seed
# endpoint (lets Muse add verified URLs by hand); generate with
# `openssl rand -hex 16` on the VM and keep it in the same .env.

# 1. Create the service user + directory (first install only)
sudo useradd -r -s /usr/sbin/nologin cinesrc 2>/dev/null || true
sudo mkdir -p /opt/cinesrc
sudo chown cinesrc:cinesrc /opt/cinesrc

# 2. Copy the code (pull the repo first, then copy)
#    git -C ~/aayush-tv-minter pull --ff-only   (or clone it first)
sudo cp ~/aayush-tv-minter/tools/cinesrc-minter/cinesrc-minter.py /opt/cinesrc/cinesrc-minter.py
sudo chown cinesrc:cinesrc /opt/cinesrc/cinesrc-minter.py

# 3. Python venv + deps
sudo python3 -m venv /opt/cinesrc/.venv
sudo /opt/cinesrc/.venv/bin/pip install -q fastapi uvicorn
sudo chown -R cinesrc:cinesrc /opt/cinesrc/.venv

# 4. Credentials (do this ONCE, on the VM only).
#    a. Browser-driver key (REQUIRED for minting). Read the Muse key
#       from /opt/browser-driver/.env and append it WITHOUT printing it:
#       sudo sh -c 'K=$(grep ^DRIVER_CLAUDE_API_KEY= /opt/browser-driver/.env | cut -d= -f2-); printf "DRIVER_API_KEY=%s\n" "$K" >> /opt/cinesrc/.env'
#    b. Seed key for the /seed endpoint:
#       sudo sh -c 'printf "SEED_KEY=%s\n" "$(openssl rand -hex 16)" >> /opt/cinesrc/.env'
#       Then: sudo chmod 600 /opt/cinesrc/.env; sudo chown cinesrc:cinesrc /opt/cinesrc/.env
#    Never print, paste, or log either value. (The SEED_KEY value is
#    needed by Muse to call /seed — read it from the file only when a
#    seed call is actually being made, and never put it in chat.)

# 5. Install + start the service (first install) or restart (update)
sudo cp ~/aayush-tv-minter/tools/cinesrc-minter/cinesrc-minter.service /etc/systemd/system/cinesrc-minter.service
sudo systemctl daemon-reload
sudo systemctl enable cinesrc-minter
sudo systemctl restart cinesrc-minter
sudo systemctl status cinesrc-minter --no-pager | head -15

# 6. Caddy route on mret.aayushlife.live (add inside the site block, next
#    to /cinema-api/):
#    handle /cinesrc-api/* {
#        uri strip_prefix /cinesrc-api
#        reverse_proxy 127.0.0.1:8805
#    }
#    Then: sudo systemctl reload caddy (back up the Caddyfile first).

# 7. Test
#    curl -s http://127.0.0.1:8805/health
#    curl -s "http://127.0.0.1:8805/cinesrc?tmdb=27205&type=movie"
#      -> {"url": "https://nebula.bright67.online/hls/1daa855b-.../master.m3u8",
#          "cached": true, ...} (Inception is seeded in code)
#    curl -s https://mret.aayushlife.live/cinesrc-api/health
#    A cache MISS mints through his Chrome (~20-40s); if the driver
#    extension is not connected it 502s with "browser-driver extension
#    not connected" and records the title in /pending.
