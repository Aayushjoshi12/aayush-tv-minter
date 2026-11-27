# TVApp minter — deploy / update steps (run on the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the cinema minter (8803) and the Nexus resolver (8801).
# The minter runs on 127.0.0.1:8807 and is exposed via Caddy /tvapp-api/ on
# mret.aayushlife.live and mret.balenshah.tech.
#
# WHAT IT DOES
# - GET /health -> {"ok":true,"service":"tvapp-minter","sessions":n}
# - GET /matches -> public match list (tvapp1.pk/api/matches.json, PPV fallback)
# - GET /find?home=X&away=Y -> the TVApp match id for a fixture (team names)
# - GET /stream?id=<numeric> -> plain live HLS playlist for that match
#   (mints a session on thetvapp.pk, mode "native" first; "enc" + AES-GCM
#   decrypt is the fallback). No token or key is ever logged or stored.
# - GET /fallback?id=... -> emergency direct URL, only when the session
#   enables it (usually 404 — the main path is the route).
#
# IMPORTANT — IP BINDING
# The session is bound to the IP that mints it: feed.bin (enc mode) returns
# 403 "session in use elsewhere" from any other IP. The aayushbot VM has one
# static IP (20.196.196.203), so mint + fetch there share it and it works.
# Do NOT test /stream from a machine whose egress IP rotates per request
# (this dev VM does) — it 403s there even though the code is correct.
# The plain (native) playlist and the TikTok CDN segments are NOT IP-bound;
# only the encrypted feed.bin is.

# 1. Create the service user + directory (first install only)
sudo useradd -r -s /usr/sbin/nologin tvapp 2>/dev/null || true
sudo mkdir -p /opt/tvapp
sudo chown tvapp:tvapp /opt/tvapp

# 2. Copy the code (pull from the repo — this file lives in
#    tools/tvapp-minter/ of Aayushjoshi12/aayush-tv-minter)
sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/tvapp-minter/tvapp-minter.py -o /opt/tvapp/tvapp-minter.py
sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/tvapp-minter/tvapp-minter.service -o /etc/systemd/system/tvapp-minter.service
sudo chown tvapp:tvapp /opt/tvapp/tvapp-minter.py
sudo python3 -c "import ast; ast.parse(open('/opt/tvapp/tvapp-minter.py').read()); print('syntax OK')"

# 3. Python venv + deps (FastAPI, uvicorn, httpx, cryptography for the enc fallback)
sudo python3 -m venv /opt/tvapp/.venv
sudo /opt/tvapp/.venv/bin/pip install -q fastapi uvicorn httpx cryptography
sudo chown -R tvapp:tvapp /opt/tvapp/.venv

# 4. Install + start the service (first install) or restart (update)
sudo systemctl daemon-reload
sudo systemctl enable tvapp-minter
sudo systemctl restart tvapp-minter
sudo systemctl status tvapp-minter --no-pager | head -15

# 5. Caddy route (add inside the mret site block on BOTH hostnames —
#    mret.aayushlife.live and mret.balenshah.tech share one block — next to
#    the /imdb-api/ route, which is currently the last handle block):
#    handle /tvapp-api/* {
#        uri strip_prefix /tvapp-api
#        reverse_proxy 127.0.0.1:8807
#    }
#    Back up /etc/caddy/Caddyfile first, validate, then reload:
#    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-tvapp
#    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
#    sudo systemctl reload caddy

# 6. Test (use a currently-live match id from /matches)
#    curl -s http://127.0.0.1:8807/health
#    curl -s http://127.0.0.1:8807/matches | head -c 300
#    curl -s "http://127.0.0.1:8807/stream?id=<live id>" | head -5
#       -> must start with #EXTM3U and list https://p19-common-sign.tiktokcdn-eu.com/... URLs
#    curl -s https://mret.balenshah.tech/tvapp-api/health
#    curl -s "https://mret.balenshah.tech/tvapp-api/stream?id=<live id>" | head -5
