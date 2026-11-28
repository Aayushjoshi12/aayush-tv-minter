# onexbet-search — deploy / update steps (run on the aayushbot VM via Cloud Shell / az ssh vm)
# Same pattern as the tvapp minter (8807) and footybite minter (8808).
# The service runs on 127.0.0.1:8809 and is exposed via Caddy
# /onexbet-api/ on mret.aayushlife.live and mret.balenshah.tech.
#
# WHAT IT DOES
# - GET /health -> {"ok":true,"service":"onexbet-search"}
# - GET /search?q=<text|id> -> the Vercel proxy's ?mode=search shape:
#   {source, league:"Search", mirror, fetchedAt, games:[...],
#   detail:{...}|null, q} — live games + upcoming fixtures of the
#   known big leagues (KNOWN_CHAMPS + KNOWN_LEAGUES), with the same
#   nickname aliases and word-based matching as api/onexbet.js.
#   Numeric q = a 1xBet game id (live hit, gameInfo alias, or line
#   fixture). The site's Live Sports search (hero dropdown, Find box,
#   detail-by-id) calls this FIRST and falls back to Vercel on error.
#
# WHY THE VM: Vercel's egress IPs are intermittently blocked by the
# 1xBet mirror's gateway (search hung past 60s, board 502'd, 28 Nov
# 2026 ~23:25 NPT). The VM's static IP reaches the mirror in 0.79s
# (verified from the VM via Cloud Shell, 28 Nov 23:38 NPT).
#
# SCOPE (phase 1): search only. The board/featured/NPL modes still run
# on Vercel. NOT ported: the NPL + UEFA fixtures legs (NPL season over;
# UCL is in KNOWN_CHAMPS), the NPL cricket scorecard, addCricketTarget.
#
# 1. Create the service user + directory (first install only)
# sudo useradd -r -s /usr/sbin/nologin onexbet 2>/dev/null || true
# sudo mkdir -p /opt/onexbet-search
# sudo chown onexbet:onexbet /opt/onexbet-search
#
# 2. Copy the code (pull from the repo — this file lives in
#    tools/onexbet-search/ of Aayushjoshi12/aayush-tv-minter)
# sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/onexbet-search/onexbet_search.py -o /opt/onexbet-search/onexbet_search.py
# sudo curl -sL https://raw.githubusercontent.com/Aayushjoshi12/aayush-tv-minter/main/tools/onexbet-search/onexbet-search.service -o /etc/systemd/system/onexbet-search.service
# sudo chown onexbet:onexbet /opt/onexbet-search/onexbet_search.py
# sudo python3 -c "import ast; ast.parse(open('/opt/onexbet-search/onexbet_search.py').read()); print('syntax OK')"
#
# 3. Python venv + deps (FastAPI, uvicorn, httpx)
# sudo python3 -m venv /opt/onexbet-search/.venv
# sudo /opt/onexbet-search/.venv/bin/pip install -q fastapi uvicorn httpx
# sudo chown -R onexbet:onexbet /opt/onexbet-search/.venv
#
# 4. Caddy route (in the mret block, next to /footybite-api/):
#    handle /onexbet-api/* { reverse_proxy 127.0.0.1:8809 }
#    Back up the Caddyfile first, validate with `caddy validate`,
#    then `systemctl reload caddy`. Never reload to test an edit.
#
# 5. Enable + start, prove healthy
# sudo systemctl daemon-reload
# sudo systemctl enable --now onexbet-search
# sudo systemctl status onexbet-search --no-pager
# curl -s http://127.0.0.1:8809/health
# curl -s "http://127.0.0.1:8809/search?q=barca" | head -c 400
# curl -s "https://mret.balenshah.tech/onexbet-api/search?q=barca" | head -c 400
# Expect: Deportivo de A Coruña vs Barcelona first, 4 games total.
