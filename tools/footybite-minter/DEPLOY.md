# Footybite minter — deploy / update steps (run on the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the tvapp minter (8807). The minter runs on 127.0.0.1:8808
# and is exposed via Caddy /footybite-api/ on mret.aayushlife.live and
# mret.balenshah.tech.
#
# WHAT IT DOES
# - GET /health -> {"ok":true,"service":"footybite-minter"}
# - GET /matches -> live/upcoming matches from the Footybite homepage
#   (ids + team names; 60 s cache)
# - GET /find?home=X&away=Y -> the Footybite match id for a fixture
# - GET /stream?id=<numeric> -> live HLS media playlist for that match:
#   mints fresh via GET /_serverFn/<hash>?payload=... (x-tsr-serverfn,
#   the browser's exact headers), takes Server 1's signed seg URL,
#   fetches the master playlist immediately, then the variant, then
#   serves the media playlist with CORS *. Retries with a fresh mint
#   (up to 3 attempts, all 4 servers per mint) on a 403. No signed URL
#   is ever logged or stored.
# - GET /stream-check?id=<numeric> -> {available: true} when a master
#   playlist mints, 404 when no stream exists. The site shows a Watch
#   button only when this says available.
#
# IMPORTANT — SIGNED URLS GO STALE WITHIN MINUTES + THE 403 IS FLAKY
# A seg URL minted ~5 min earlier returns 403 while a seconds-old one
# returns 200 (verified 28 Nov ~03:03 NPT), and a controlled ABA test
# (~03:08 NPT) gave 200 / 403 / 200 for curl WITH / WITHOUT / WITH the
# cookie-jar flags — even though the jars were EMPTY. No mechanism is
# known (the planner's exact commands were not visible). The minter
# therefore never caches a mint: every /stream call mints fresh and
# fetches immediately, and retries with a fresh mint on 403. The player
# (hls.js) re-polls /stream for playlist updates, so a failed poll is
# self-healing.
# If httpx consistently 403s where curl succeeds, the fallback is to
# shell out to curl from the minter (curl -s --http2 -c <jar> ... -b
# <jar> with the same headers) — the curl shape is PROVEN to return 200
# from this VM. Do not "fix" this by caching mints; the tokens die fast.
#
# IMPORTANT — GEO
# footybite.live returns "Unavailable in your region" from datacentre
# egress IPs that look like UK/France (this dev VM). The aayushbot VM
# (20.196.196.203) is NOT blocked. Do NOT test /stream from a machine
# whose egress is geo-blocked — a 403/region page there says nothing
# about the code.

# 1. Create the service user + directory (first install only)
sudo useradd -r -s /usr/sbin/nologin footybite 2>/dev/null || true
sudo mkdir -p /opt/footybite
sudo chown footybite:footybite /opt/footybite

# 2. Copy the code (pull from the repo — this file lives in
#    tools/footybite-minter/ of Aayushjoshi12/aayush-tv-minter)
sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/footybite-minter/footybite-minter.py -o /opt/footybite/footybite-minter.py
sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/footybite-minter/footybite-minter.service -o /etc/systemd/system/footybite-minter.service
sudo chown footybite:footybite /opt/footybite/footybite-minter.py
sudo python3 -c "import ast; ast.parse(open('/opt/footybite/footybite-minter.py').read()); print('syntax OK')"

# 3. Python venv + deps (FastAPI, uvicorn, httpx with HTTP/2 support)
sudo python3 -m venv /opt/footybite/.venv
sudo /opt/footybite/.venv/bin/pip install -q fastapi uvicorn 'httpx[http2]'
sudo chown -R footybite:footybite /opt/footybite/.venv

# 4. Install + start the service (first install) or restart (update)
sudo systemctl daemon-reload
sudo systemctl enable footybite-minter
sudo systemctl restart footybite-minter
sudo systemctl status footybite-minter --no-pager | head -15

# 5. Caddy route (add inside the mret site block on BOTH hostnames —
#    mret.aayushlife.live and mret.balenshah.tech share one block — next to
#    the /tvapp-api/ route, which is currently the last handle block):
#    handle /footybite-api/* {
#        uri strip_prefix /footybite-api
#        reverse_proxy 127.0.0.1:8808
#    }
#    Back up /etc/caddy/Caddyfile first, validate, then reload:
#    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-footybite
#    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
#    sudo systemctl reload caddy

# 6. Test (use a currently-live match id from /matches)
#    curl -s http://127.0.0.1:8808/health
#    curl -s http://127.0.0.1:8808/matches | head -c 500
#       -> must list live matches with ids + team names. If it returns []
#          or titles are null, dump a homepage snippet and fix the parser:
#          curl -s https://footybite.live/ -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36' | grep -o '.\{0,200\}live-football/[0-9]*.\{0,200\}' | head -5
#    curl -s "http://127.0.0.1:8808/stream?id=<live id>" | head -20
#       -> must start with #EXTM3U and list segment URLs (seg?u=... lines
#          or .ts lines). If it 502s, check the service log:
#          sudo journalctl -u footybite-minter --no-pager | tail -30
#    curl -s "http://127.0.0.1:8808/stream-check?id=<live id>"
#       -> {"available": true}
#    curl -s https://mret.balenshah.tech/footybite-api/health
#    curl -s "https://mret.balenshah.tech/footybite-api/stream?id=<live id>" | head -5
