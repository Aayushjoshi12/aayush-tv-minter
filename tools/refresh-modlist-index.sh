#!/bin/bash
# Daily modlist index refresh — rebuilds the search index from the
# four sites' sitemaps and pushes it when it changed, so new movies
# and series appear in Aayush TV search within a day.
# Runs from the daily cron. Only pushes when the public index
# actually changed (avoids a pointless approval card on quiet days).
set -e
cd ~/workspace/aayush-tv-minter
echo "[$(date -u +%FT%TZ)] rebuilding modlist index..."
python3 tools/build-modlist-index.py > /tmp/index-rebuild.log 2>&1 || {
  echo "build failed:"; tail -20 /tmp/index-rebuild.log; exit 1;
}
python3 -c "
import json
data = json.load(open('data-modlist-index.json'))
bases = {
    'mm': 'https://moviesmod.tw/wp-content/uploads/',
    'ml': 'https://moviesleech.media/wp-content/uploads/',
    'uhd': 'https://uhdmovies.beauty/wp-content/uploads/',
    'af': 'https://animeflix.my/wp-content/uploads/',
}
pub = []
for e in data:
    p = e.get('p', '')
    base = bases.get(e.get('site'), '')
    if p.startswith(base):
        p = p[len(base):]
    pub.append({'s': e['s'], 'site': e['site'], 'p': p})
json.dump(pub, open('public/modlist-index.json', 'w'), separators=(',', ':'))
print('public entries:', len(pub))
"
# Push only if the public index or the new-feed changed.
# Compare against the live files (the local clone may lag remote).
curl -s "https://aayush-tv-minter.vercel.app/modlist-index.json" -o /tmp/live-index-check.json
curl -s "https://aayush-tv-minter.vercel.app/modlist-new.json" -o /tmp/live-new-check.json
CHANGED=""
cmp -s /tmp/live-index-check.json public/modlist-index.json || CHANGED="$CHANGED public/modlist-index.json"
cmp -s /tmp/live-new-check.json public/modlist-new.json || CHANGED="$CHANGED public/modlist-new.json"
if [ -z "$CHANGED" ]; then
  echo "index and new-feed match live — nothing to push."
  exit 0
fi
echo "changed:$CHANGED — pushing..."
printf '%s\0' $CHANGED > /tmp/index-push-paths.txt
/opt/hatch/bin/github push-files --owner Aayushjoshi12 --repo aayush-tv-minter --branch main --message "Daily modlist index refresh ($(date -u +%F))" --source-dir /home/hatch/workspace/aayush-tv-minter --paths-file /tmp/index-push-paths.txt 2>&1 | head -3
echo "done."
