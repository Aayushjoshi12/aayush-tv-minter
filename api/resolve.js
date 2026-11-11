// resolve.js — server-side resolver for the Premium section of Aayush TV.
//
// Deploy as api/resolve.js next to api/stream.js (same Vercel-style
// serverless handler, same CORS-open pattern).
//
// WHY A SERVER IS NEEDED: the premium player's page only answers when
// the request carries Referer: https://bintv-sources.pages.dev/ —
// browsers forbid a page from setting that header itself, so the
// site cannot fetch the player page directly. This function runs on
// the server, sets the header freely, and returns just the signed
// stream URL as JSON, so the site can play it natively.
//
// CHAIN (proven 2026-11-11): the player page hides its player code
// as an encoded byte array; decoding it gives a script that fetches
// a ticket blob and XOR-decrypts it into a signed .m3u8 URL. The
// signed URL expires after ~2 hours, so the site calls this on every
// tap (and caches the answer for 30 minutes) instead of hard-coding
// a link.
//
// FAILOVER (added 2026-11-11, per the user's "if 1 fail it should
// redirect to other"): BINTV's backend is down more often than not,
// so the resolver no longer returns a single link. It returns an
// ordered list of sources, and the site tries them in order until
// one plays:
//   1. BINTV native — the signed .m3u8, but only if its manifest
//      actually loads (a dead signed link is skipped, not returned).
//   1b. Direct native streams (beIN USA, ESPN LatAm — DIRECT
//      below): real .m3u8 feeds that play natively in the site's
//      own player and start fastest. Checked the same way.
//   2. Backup embeds — player pages from other hosts, found by
//      reverse-engineering DaddyLive's public player JSONs
//      (daddylive.mov/player/playerN.json, 11 Nov 2026). Sites with
//      a public API (DaddyLive /api/events, DamiTV /api/streams) are
//      used through that API; sites without one were reverse-
//      engineered the same way BINTV was, and their per-channel
//      player URLs are listed in BACKUPS below.
//   FASTEST FIRST (added 2026-11-11, per the user's "the source
//   which loads faster should load first"): every check runs at the
//   same time instead of one after another, each backup's answer
//   time is measured, and the working embeds are ordered fastest
//   first — so the site tries the quickest source first and the
//   total wait is the slowest single check, not the sum of them.
//   A backup whose page does not answer is still returned last,
//   marked ok:false, so the site can offer it through its
//   "Try next source" button instead of hiding it.
//   3. The BINTV watch page, appended by the site itself as the
//      last resort (same as before).
// None of the backup hosts sends X-Frame-Options, and matchora
// sends `frame-ancestors *`, so their player pages can be embedded
// in the site's iframe (verified 11 Nov 2026).
//
// ENDPOINT: GET /api/resolve?ch=<key>
//   -> 200 {"url", "expires", "kind", "source", "sources": [
//        {"kind": "hls"|"embed", "source": "...", "url": "...",
//         "expires": <epoch|null>, "ok": true|false}, ... ]}
//      "url"/"kind"/"source" describe sources[0] (kept so older
//      site versions keep working). "sources" is ordered best-first.
//   -> 400 on unknown key. It (almost) never 502s now: even when
//      every upstream fails, the watch-page fallback is appended
//      by the site, and the embed list here is empty rather than
//      an error.
//
// SAFETY: only fetches public, unauthenticated pages (player page,
// ticket blob, manifests, backup player pages). No secrets, no
// shell, no storage. Returned URLs are time-limited and only ever
// sent to the user's own browser, which plays them directly.

const PLAYER_BASE = "https://ehgembxe.cfd/bintv/";
const PLAYER_REFERER = "https://bintv-sources.pages.dev/";
const BACKUP_REFERER = "https://daddylive.mov/";

// key -> player path, from the public channel feed (2026-11-11).
const CHANNELS = {
  "arena-sport-1-bih": "pmk4006b-7099",
  "bein-max-4-francais": "g8f0wpqc-2696",
  "bein-max-5-francais": "kckkoedv-2594",
  "bein-max-6-francais": "wqjlbwll-2258",
  "bein-max-7-francais": "np4biwf3-3097",
  "bein-sports": "u36ftfcy-7101",
  "bein-sports-francais-1": "gbw09ann-983",
  "bein-sports-francais-2": "ahl77cgo-3597",
  "bein-sports-francais-3": "fcxpeb2i-9275",
  "bein-mena-1": "gh9m7u89-8471",
  "bein-sports-mena-2": "klk0j7p2-3347",
  "bein-sports-mena-3": "ketbclv0-4795",
  "bein-sports-mena-4": "pxx4l615-6526",
  "bein-sports-mena-5": "59b89cub-6825",
  "bein-sports-mena-6": "5u81h0on-8286",
  "bein-sports-mena-7": "mmww1kss-3568",
  "bein-sports-mena-8": "80ynbnuv-5382",
  "bein-sports-mena-9": "ltcqnszh-6218",
  "canal-sport-2-pl": "vz0b8dai-3533",
  "canal-sport-3-pl": "f9q2whgc-7787",
  "canal-sport-4-pl": "rcbsp9o1-5913",
  "canal-sport-5-pl": "ayehdrp1-4306",
  "canal-sport-6-pl": "qrmke5x4-2028",
  "canal-sport-pl": "jr4cynbo-9272",
  "cbs-sports-network": "9c2jwr40-3407",
  "dazn-1-germany": "3dk8rxui-6212",
  "dazn-1-italia": "gmoqoz7b-4945",
  "dazn-1-portugal": "3zhczzbl-9086",
  "dazn-1-es": "sq26inyf-2660",
  "dazn-1-usa": "jyqzet0b-2901",
  "dazn-2-germany": "tnifspj6-852",
  "dazn-2-spain": "0o3vlabk-4088",
  "dazn-f1": "5rvazszz-6983",
  "dazn-laliga": "fw2jrum9-448",
  "eleven-sports-1": "gg28wwh4-6849",
  "eleven-sports-2": "pw0y0gzx-7614",
  "eleven-sports-3": "ytjrtde4-6087",
  "eleven-sports-4": "boc7cv4y-6161",
  "espn": "o9bl8cai-7223",
  "espn-deportes": "6trsant7-1421",
  "espn2": "33jhpzfr-936",
  "espnews": "mftslez4-3364",
  "espnu": "wqbwjjhf-9771",
  "fox-deportes": "8p0wjr6t-3317",
  "fox-sports-1": "f4ijr4sl-187",
  "fox-sports-2": "p5562bwm-3285",
  "fox-sports-501": "imifneoj-1417",
  "fox-sports-502": "caxq9d5g-1854",
  "fox-sports-503": "t1ilns5i-746",
  "fox-sports-504": "m5ys2t2z-7410",
  "fox-sports-505": "p0jkpm12-1140",
  "fox-sports-506": "9hg9rzzh-2937",
  "fox-sports-507": "s1npqmod-9335",
  "go3-sport-1": "2tsl2cbn-6969",
  "go3-sport-2": "gu0zawp0-8172",
  "go3-sport-3": "gu0zawp0-5456",
  "golf-channel": "p8wos5q1-1333",
  "hub-sports-1-singapore": "2670rnlp-2693",
  "hub-sports-2-singapore": "uxjju28j-2977",
  "hub-sports-3-singapore": "91ieccpw-3489",
  "hub-sports-4-singapore": "pgb1kdmf-8296",
  "hub-sports-5-singapore": "tfrrx715-8124",
  "mlb-network": "kbrqp0d5-1689",
  "motogp-channel": "sv7a4sfc-9210",
  "movistar-deportes": "gzli3jta-570",
  "movistar-deportes-2": "1gv2rhxc-4292",
  "movistar-deportes-3": "wtnngz3p-4867",
  "movistar-laliga": "vowrwhdn-2491",
  "movistar-plus": "b6a3cjbx-9022",
  "nba-tv": "8tl2ksef-2775",
  "nbc-sports-bay-area": "soipf80d-8441",
  "nbc-sports-philadelphia": "03uxmg2p-8674",
  "nfl-network": "a40czx8e-4022",
  "nhl-network": "kelcwql2-1938",
  "polsat-sport-1": "pi5dqsjd-8964",
  "polsat-sport-2": "njs5pc6k-5347",
  "polsat-sport-3": "r1ehwgde-9139",
  "polsat-sport-fight": "mkr6nvqt-4662",
  "premier-sports-1-ie": "nf1skh2l-1926",
  "premier-sports-2-ie": "c8prf9yh-2498",
  "sky-sport-1-nz": "8num3afh-8204",
  "sky-sport-2-nz": "sl9un97j-4474",
  "sky-sport-24": "1k3ckb2m-8796",
  "sky-sport-3-nz": "ldfbs8gf-7885",
  "sky-sport-4-nz": "h0ryosf9-1736",
  "sky-sport-5-nz": "32f9u4no-5828",
  "sky-sport-6-nz": "wghuk9nx-1967",
  "sky-sport-7-nz": "dohvga1l-2284",
  "sky-sport-8-nz": "asxdfczr-9050",
  "sky-sport-9-nz": "kb1ngcei-9972",
  "sky-sport-arena-it": "akfl7ls6-2231",
  "sky-sport-bundesliga": "bsudwrf4-653",
  "sky-sport-calcio-it": "gib0w25z-357",
  "sky-sport-f1-italia": "t5mpn192-927",
  "sky-sport-max-it": "jfgks9vt-7958",
  "sky-sport-motogp-it": "z1b9nwhr-4813",
  "sky-sport-select-nz": "b6ca3188-8449",
  "sky-sport-tennis-it": "mssnlmj6-4172",
  "sky-sport-uno": "pqd6qx47-4522",
  "sky-sports": "jwrj2d6p-8874",
  "sky-sports-action": "3ym6q5iy-878",
  "sky-sports-cricket": "qfx4038p-95",
  "sky-sports-f1": "f596f98r-6977",
  "sky-sports-football": "a80q8j3i-2187",
  "sky-sports-golf": "0bydvmgs-4755",
  "sky-main-event": "n58ajgfx-472",
  "sky-sports-mix": "kt8jus5e-7693",
  "sky-sports-news": "sawtuw4t-1803",
  "sky-pl": "kzd3hrqz-4314",
  "sky-sports-racing": "2jlx4p7r-552",
  "sky-sports-tennis": "kkbb5x8i-1991",
  "sony-sports-network": "toarnao3-525",
  "sony-sports-network-2": "umicawgj-6598",
  "sony-sports-network-3": "iit0e7qs-6560",
  "sony-sports-network-4": "dxclfs9n-2151",
  "sony-sports-network-5": "oay9sxar-3985",
  "sport-tv1": "oqq5c86g-7521",
  "sport-tv2": "6dw9r22a-7192",
  "sport-tv3": "dbo09jwh-5404",
  "sport-tv4": "t218wwwk-3361",
  "sport-tv5": "twg31g84-6394",
  "sportdigital-fussball": "9bn5lr9r-5959",
  "tennis-channel": "80nrh660-13",
  "tnt-1": "e0lyrkhr-1002",
  "tnt-sports-2": "it7aytqh-1540",
  "tnt-sports-3": "bjarzxf9-1713",
  "tnt-sports-4": "3u2rfhmp-8468",
  "tsn1": "ieodbgj5-4982",
  "tudn": "q2u5urq3-3910",
  "tyc-sports-internacional": "gq4ysifk-1154",
  "ufc-fight-pass-24-7": "c2g6ggzm-2981",
  "unite8-sports-1-zee-caf": "tnxwmkhb-3003",
  "willow-cricket": "spd8gpoh-6586",
  "willow-cricket-2": "14quawd5-8819",
};

// Backup player pages, in the order the site should try them.
// Sources (all verified live 11 Nov 2026):
//  - 104game / cdnlivetv / matchora / tvnow247 / streamtp: per-channel
//    player URLs taken from DaddyLive's public player JSONs
//    (player6.json = 104game, player5.json = cdnlivetv,
//    player19.json = matchora, player10.json = tvnow247,
//    player2.json = streamtp). player14.json is BINTV itself.
//  - DaddyLive watch pages: /live/stream=<Channel-Name>&source=...
//  - CricHD: per-channel watch pages.
// Most backups are embeds: the site shows them in its iframe
// player. DAZN LaLiga and DAZN 1 Spain have no backup anywhere
// else — their only fallbacks are the embeds below.
const BACKUPS = {
  "dazn-laliga": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/51" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139024" },
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/52" },
  ],
  "movistar-laliga": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/49" },
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/50" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=LaLiga%20TV%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20Premier%20League%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "DaddyLive", url: "https://daddylive.mov/live/stream=Sky-Sports-Premier-League&source=list19-8r" },
    { kind: "embed", source: "CricHD", url: "https://crichd.cm/sky-sports-premier-league-live-stream-play3" },
  ],
  "sky-main-event": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sports%20Main%20Event%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "tnt-1": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=TNT%20Sports%201%20FHD%20UK&code=&user=cdnlivetv&plan=free" },
  ],
  "bein-mena-1": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/1" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/49226" },
  ],
  "espn": [
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=espn" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/44/" },
  ],
  "dazn-1-es": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/56" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139027" },
  ],
  "bein-sports": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1836244" },
  ],
  "bein-sports-mena-2": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/92/" },
  ],
  "bein-sports-mena-7": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/97/" },
  ],
  "bein-sports-mena-8": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/98/" },
  ],
  "bein-sports-mena-9": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/99/" },
  ],
  "canal-sport-2-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Canal%2B%20Sport%202%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "canal-sport-3-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Canal%2B%20Sport%203%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "canal-sport-4-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Canal%2B%20Sport%204%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "canal-sport-5-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Canal%2B%20Sport%205%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "canal-sport-pl": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Canal%2B%20Sport%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "dazn-f1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139025" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%20F1%20FHD&code=&user=cdnlivetv&plan=free" },
  ],
  "espn-deportes": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/71" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1921358" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/375/" },
  ],
  "espn2": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/88" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1356493" },
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=espn2" },
  ],
  "espnews": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/45578" },
  ],
  "espnu": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/90958" },
  ],
  "fox-deportes": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/70" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/90292" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/643/" },
  ],
  "fox-sports-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1520176" },
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=fox1ar" },
  ],
  "fox-sports-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1520171" },
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=fox2ar" },
  ],
  "fox-sports-507": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/646965" },
  ],
  "go3-sport-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917657" },
  ],
  "go3-sport-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917656" },
  ],
  "go3-sport-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917655" },
  ],
  "golf-channel": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2151721" },
  ],
  "mlb-network": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2138998" },
  ],
  "movistar-deportes": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/25355" },
  ],
  "movistar-deportes-2": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Movistar%20Deportes%202%20FHD&code=&user=cdnlivetv&plan=free" },
  ],
  "nba-tv": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1920053" },
  ],
  "nfl-network": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2139001" },
  ],
  "nhl-network": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2151620" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/663/" },
  ],
  "sky-sport-1-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%201%20NZ&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/588/" },
  ],
  "sky-sport-2-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%202%20NZ&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/589/" },
  ],
  "sky-sport-24": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692437" },
  ],
  "sky-sport-3-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%203%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-4-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%204%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-5-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%205%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-6-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%206%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-7-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%207%20NZ&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/594/" },
  ],
  "sky-sport-8-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%208%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-9-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%209%20NZ&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/596/" },
  ],
  "sky-sport-bundesliga": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917532" },
  ],
  "sky-sport-select-nz": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sky%20Sport%20Select%20NZ&code=&user=cdnlivetv&plan=free" },
  ],
  "sky-sport-uno": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692391" },
  ],
  "sky-sports": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/79481" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/36/" },
  ],
  "sky-sports-action": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917635" },
  ],
  "sky-sports-cricket": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917637" },
  ],
  "sky-sports-f1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917634" },
  ],
  "sky-sports-football": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917622" },
  ],
  "sky-sports-golf": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917633" },
  ],
  "sky-sports-mix": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917632" },
  ],
  "sky-sports-news": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917638" },
  ],
  "sky-sports-racing": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917629" },
  ],
  "sky-sports-tennis": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917628" },
  ],
  "sportdigital-fussball": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1697000" },
  ],
  "tennis-channel": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/811667" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/40/" },
  ],
  "tnt-sports-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1047261" },
  ],
  "tnt-sports-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1047262" },
  ],
  "tnt-sports-4": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1047263" },
  ],
  "tsn1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/904216" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/111/" },
  ],
  "tyc-sports-internacional": [
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=tycinternacional" },
  ],
  "willow-cricket": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/45463" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/346/" },
  ],
  "eurosport-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1913128" },
  ],
  "eurosport-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1913126" },
  ],
  "espn-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/890657" },
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=espn3" },
  ],
  "dazn-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317037" },
  ],
  "dazn-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317038" },
  ],
  "dazn-4": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317039" },
  ],
  "dazn-5": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317040" },
  ],
  "dazn-combat": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917694" },
  ],
  "bein-sports-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1660411" },
  ],
  "bein-sports-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1660409" },
  ],
  "cbs-sports-golazo-network": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/308/" },
  ],
  "premier-sports-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1032487" },
  ],
  "premier-sports-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1032486" },
  ],
  "star-sports-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/282677" },
  ],
  "star-sports-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/282673" },
  ],
  "star-sports-select-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/282675" },
  ],
  "star-sports-select-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/282676" },
  ],
  "supersport-premier-league": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/833281" },
  ],
  "supersport-football": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/144417" },
  ],
  "tsn-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/177345" },
  ],
  "sportsnet-one": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1920740" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/411/" },
  ],
  "sportsnet-360": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1920742" },
  ],
  "tnt-sports-5": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1004550" },
  ],

  "arena-sport-1-bih": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2011095" },
  ],
  "bein-max-4-francais": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%20Max%204%20HD%20FR&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/494/" },
  ],
  "bein-max-5-francais": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%20Max%205%20HD%20FR&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/495/" },
  ],
  "bein-max-6-francais": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%20Max%206%20HD%20FR&code=&user=cdnlivetv&plan=free" },
  ],
  "bein-max-7-francais": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%20Max%207%20HD%20FR&code=&user=cdnlivetv&plan=free" },
  ],
  "bein-sports-francais-1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1660413" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20SPORTS%201%20FR%20HD&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/116/" },
  ],
  "bein-sports-francais-2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1660411" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20SPORTS%202%20FR%20HD&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/117/" },
  ],
  "bein-sports-francais-3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1660409" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%203%20HD%20FR&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/118/" },
  ],
  "bein-sports-mena-3": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/93/" },
  ],
  "bein-sports-mena-4": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/94/" },
  ],
  "bein-sports-mena-5": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/95/" },
  ],
  "bein-sports-mena-6": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/96/" },
  ],
  "bein-sports-xtra": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20Sports%20Xtra%20FHD%20US&code=&user=cdnlivetv&plan=free" },
  ],
  "canal-sport-6-pl": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2011083" },
  ],
  "dazn-1-germany": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/123" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317036" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%201%20FHD%20DE&code=&user=cdnlivetv&plan=free" },
  ],
  "dazn-1-italia": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317036" },
  ],
  "dazn-1-portugal": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317036" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%201%20FHD%20PT&code=&user=cdnlivetv&plan=free" },
  ],
  "dazn-1-usa": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317036" },
  ],
  "dazn-2-germany": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/124" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317037" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=DAZN%202%20FHD%20DE&code=&user=cdnlivetv&plan=free" },
  ],
  "dazn-2-spain": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/57" },
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/317037" },
  ],
  "eleven-sports-1": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Eleven%20Sports%201%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "eleven-sports-2": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Eleven%20Sports%202%20HD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "eleven-sports-3": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Eleven%20Sports%203%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "eleven-sports-4": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Eleven%20Sports%204%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "fox-sports-501": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Fox%20Sports%20501%20AU&code=&user=cdnlivetv&plan=free" },
  ],
  "fox-sports-502": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Fox%20Sports%20502%20AU&code=&user=cdnlivetv&plan=free" },
  ],
  "fox-sports-503": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=FOX%20Sports%20503%20HD%20AU&code=&user=cdnlivetv&plan=free" },
  ],
  "fox-sports-505": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=FOX%20Sports%20505%20HD%20AU&code=&user=cdnlivetv&plan=free" },
  ],
  "fox-sports-506": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=FOX%20Sports%20506%20HD%20AU&code=&user=cdnlivetv&plan=free" },
  ],
  "hub-sports-1-singapore": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2065811" },
  ],
  "hub-sports-2-singapore": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2065810" },
  ],
  "hub-sports-3-singapore": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2065809" },
  ],
  "hub-sports-4-singapore": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2065808" },
  ],
  "hub-sports-5-singapore": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/2065807" },
  ],
  "polsat-sport-1": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/47/" },
  ],
  "polsat-sport-2": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Polsat%20Sport%202%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
  ],
  "polsat-sport-3": [
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Polsat%20Sport%203%20FHD%20PL&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/129/" },
  ],
  "premier-sports-1-ie": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1032487" },
  ],
  "premier-sports-2-ie": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1032486" },
  ],
  "sky-sport-arena-it": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692434" },
  ],
  "sky-sport-calcio-it": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692415" },
  ],
  "sky-sport-f1-italia": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692427" },
  ],
  "sky-sport-max-it": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/1917708" },
  ],
  "sky-sport-motogp-it": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692421" },
  ],
  "sky-sport-tennis-it": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/692432" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/576/" },
  ],
  "sport-tv1": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/148671" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sport%20TV%201%20FHD%20PT&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/49/" },
  ],
  "sport-tv2": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/148670" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sport%20TV%202%20FHD%20PT&code=&user=cdnlivetv&plan=free" },
  ],
  "sport-tv3": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/148669" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sport%20TV%203%20HD%20PT&code=&user=cdnlivetv&plan=free" },
  ],
  "sport-tv4": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/148668" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sport%20TV%204%20HD%20PT&code=&user=cdnlivetv&plan=free" },
  ],
  "sport-tv5": [
    { kind: "embed", source: "Matchora", url: "https://matchora.to/embed/channel/148667" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=Sport%20TV%205%20HD%20PT&code=&user=cdnlivetv&plan=free" },
  ],
  "tudn": [
    { kind: "embed", source: "104game", url: "https://104game.click/player/1/68" },
    { kind: "embed", source: "CDNLiveTV", url: "https://cdnlivetv.tv/api/v1/channels/player/?name=TUDN%20UHD%20US&code=&user=cdnlivetv&plan=free" },
    { kind: "embed", source: "StreamTP", url: "https://streamtp-golden1.click/global1.php?stream=tudn_usa" },
  ],
  "willow-cricket-2": [
    { kind: "embed", source: "TVNow247", url: "https://tvnow247.top/embed/598/" },
  ],};

// Direct native streams (added 2026-11-11): DaddyLive's
// player9.json DOES list direct https .m3u8 feeds for two of the
// brands — beIN Sports USA and ESPN Latin America. They are not
// the exact regional variants the tiles name (USA, not MENA 1;
// Latin America, not US), but they are real direct feeds of the
// same brands, their manifests and segments load with CORS *,
// and they play natively in the site's own <video> player —
// starting far faster than any heavy embed page. They are checked
// with manifestLoads like BINTV and slotted in after BINTV and
// before the embeds. No direct feed exists in player9.json for
// DAZN LaLiga, Movistar LaLiga, Sky PL/Main Event or TNT 1.
// (TulaWatch needs a login for every channel, so it cannot be
// used; DamiTV's API answered 403 on 11 Nov 2026.)
const DIRECT = {
  "bein-mena-1": [
    { source: "beIN USA (direct)", url: "https://tvsen6.aynaott.com/beinsports/index.m3u8" },
  ],
  "espn": [
    { source: "ESPN LatAm (direct)", url: "https://barinaslive1.boldmss.com/ESPN/ESPN.isml/ESPN.m3u8" },
  ],
  "golf-channel": [
    { source: "GOLF Channel (direct)", url: "https://dash4.antik.sk/live/test_golf_channel/playlist.m3u8" },
  ],
  "espn-2-latin-america": [
    { source: "ESPN 2 Latin America (direct)", url: "https://barinaslive1.boldmss.com/ESPN_2/ESPN_2.isml/ESPN_2.m3u8" },
  ],
  "espn-3-latin-america": [
    { source: "ESPN 3 Latin America (direct)", url: "https://barinaslive1.boldmss.com/ESPN_3/ESPN_3.isml/ESPN_3.m3u8" },
  ],
  "premier-sports-2": [
    { source: "Premier Sports 2 (direct)", url: "https://amg19223-amg19223c4-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c4-amgplt0351/playlist.m3u8" },
  ],

  "premier-sports-2-ie": [
    { source: "Premier Sports 2 IE (direct)", url: "https://amg19223-amg19223c4-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c4-amgplt0351/playlist.m3u8" },
  ],};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodePlayerScript(html) {
  // The player code is hidden as a byte array in one inline script:
  //   var _xb5=[240,206,...]; var _uf5=235,_rh1=29;
  //   ...String.fromCharCode(((_xb5[i]^_uf5)-_rh1+256)%256)...
  // Variable names change on every load, so match by shape, not name.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1]
  );
  for (const sc of scripts) {
    const arr = sc.match(/var (_\w+)=\[\s*([0-9,\s]+)\]/);
    if (!arr || arr[2].split(",").length < 500) continue;
    const nums = arr[2].split(",").map((x) => parseInt(x, 10));
    const tail = sc.slice(arr.index + arr[0].length);
    const keys = tail.match(/=(\d+),\s*_\w+=(\d+)/);
    if (!keys) continue;
    const xor = parseInt(keys[1], 10);
    const sub = parseInt(keys[2], 10);
    const bytes = nums.map((n) => (((n ^ xor) - sub + 256) % 256));
    return String.fromCharCode(...bytes);
  }
  throw new Error("Player script not found");
}

function decryptTicket(ticketUrl, buf) {
  // Ticket blob: first byte is a seed, the rest is the URL XORed
  // with the ticket id (last path segment) and the seed.
  const bytes = new Uint8Array(buf);
  if (bytes.length < 3) throw new Error("Ticket too short");
  const tk = ticketUrl.substring(ticketUrl.lastIndexOf("/") + 1);
  const s = bytes[0];
  let out = "";
  for (let i = 1; i < bytes.length; i++) {
    out += String.fromCharCode(
      bytes[i] ^ tk.charCodeAt((i - 1) % tk.length) ^ ((s + i - 1) & 255)
    );
  }
  return out;
}

function fetchWithTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function resolveBintv(path) {
  // The original chain, unchanged: player page -> decode -> ticket
  // -> signed .m3u8. Returns {url, expires} or throws.
  const page = await fetchWithTimeout(
    PLAYER_BASE + path,
    { "User-Agent": UA, Referer: PLAYER_REFERER },
    15000
  );
  if (!page.ok) throw new Error(`Player page ${page.status}`);
  const html = await page.text();

  const decoded = decodePlayerScript(html);
  const ticket = decoded.match(/loadStreamUrl\("(https?:\/\/[^"]+)"/);
  if (!ticket) throw new Error("Ticket URL not found");

  const ticketRes = await fetchWithTimeout(
    ticket[1],
    { "User-Agent": UA, Referer: page.url },
    15000
  );
  if (!ticketRes.ok) throw new Error(`Ticket ${ticketRes.status}`);
  const buf = await ticketRes.arrayBuffer();

  const url = decryptTicket(ticket[1], buf);
  if (!url.startsWith("https://") || !url.includes(".m3u8")) {
    throw new Error("Bad stream URL");
  }
  // The signed URL carries its expiry as a path segment:
  // .../secure/<token>/<epoch>/name.m3u8
  const expires = parseInt(url.split("/").slice(-2, -1)[0], 10) || null;
  return { url, expires };
}

async function manifestLoads(url) {
  // A signed link is only useful if its manifest actually loads —
  // BINTV's backend has been returning 404 for these all day, so a
  // link that fails here is skipped instead of handed to the site.
  // The check mirrors what the browser needs: the request carries
  // the site's Origin, and the manifest must answer with
  // Access-Control-Allow-Origin: * — without it, hls.js in the
  // browser cannot fetch it cross-origin, however well the server
  // itself can load it. (Several player9 direct feeds fail on
  // exactly this: their segments load, but no CORS header.)
  try {
    const res = await fetchWithTimeout(
      url,
      { "User-Agent": UA, Origin: "https://aayushlife.live" },
      8000
    );
    if (!res.ok) return false;
    const cors = res.headers.get("access-control-allow-origin");
    // The browser accepts "*" or its own origin; a feed that
    // answers our Origin with our origin plays fine in the site.
    if (cors !== "*" && cors !== "https://aayushlife.live") return false;
    const text = await res.text();
    return text.startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

async function pageLoads(url) {
  // Check a backup embed's player page and measure how fast it
  // answers. Returns the answer time in ms when the page loads,
  // null when it does not — the handler orders working embeds
  // fastest first, so the quickest source is tried first.
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { "User-Agent": UA, Referer: BACKUP_REFERER },
      6000
    );
    return res.ok ? Date.now() - start : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  const key = req.query.ch;
  const path = CHANNELS[key];
  // A channel is known if it has a BINTV path, backup embeds, or a
  // direct stream. Channels from the other sources have no BINTV
  // path, so they skip the BINTV step below and go straight to
  // their backups.
  if (!path && !(BACKUPS[key] || []).length && !(DIRECT[key] || []).length) {
    return res.status(400).json({ error: "Unknown channel" });
  }

  // Every check runs at the same time, and whichever side is ready
  // first decides the answer — so the total wait is the fastest
  // side, not the sum of them, and a slow or hanging BINTV chain
  // can never hold up the backups:
  //   - BINTV resolves with a working manifest first: return the
  //     native link at once (native always beats an embed).
  //   - The backup checks finish first: return the embeds at once,
  //     fastest first, without waiting for BINTV.
  //   - BINTV finishes first but failed: wait for the backups,
  //     then return the ordered list.
  const bintvP = path
    ? (async () => {
        try {
          const { url, expires } = await resolveBintv(path);
          if (await manifestLoads(url)) {
            return { kind: "hls", source: "BINTV", url, expires, ok: true };
          }
        } catch {
          // BINTV down: fall through to the backups.
        }
        return null;
      })()
    : Promise.resolve(null);
  const directP = Promise.all(
    (DIRECT[key] || []).map(async (d) => {
      const start = Date.now();
      const ok = await manifestLoads(d.url);
      return { kind: "hls", source: d.source, url: d.url, expires: null, ok, ms: ok ? Date.now() - start : null };
    })
  );
  const backups = BACKUPS[key] || [];
  const checkedP = Promise.all(
    backups.map(async (b) => {
      const ms = await pageLoads(b.url);
      return { kind: "embed", source: b.source, url: b.url, expires: null, ok: ms !== null, ms };
    })
  );
  const restP = Promise.all([directP, checkedP]).then(
    ([direct, checked]) => ({ kind: "rest", direct, checked })
  );
  const sendSources = (sources) => {
    if (!sources.length) {
      return res.status(200).json({ url: null, expires: null, kind: null, source: null, sources: [] });
    }
    const first = sources[0];
    return res.status(200).json({
      url: first.url,
      expires: first.expires || null,
      kind: first.kind,
      source: first.source,
      sources,
    });
  };
  // Order: BINTV native first when it works, then working direct
  // native streams fastest first, then working embeds fastest
  // first, then the ones whose pages did not answer, in their
  // original order.
  const orderSources = (bintv, direct, checked) => {
    const directOk = direct.filter((s) => s.ok).sort((a, b) => a.ms - b.ms);
    // Verified embeds, fastest first — except 104game, which goes
    // last among them: its pages load fast but its streams are dead
    // (its upstream, trendplace.top, shows "STREAM IS OFFLINE" —
    // seen on DAZN LaLiga 5x and ESPN2, 2026-11-11). The fastest
    // source that actually plays should run first, not the fastest
    // page that opens on a dead screen.
    const verified = checked.filter((s) => s.ok).sort((a, b) => a.ms - b.ms);
    const verifiedPlayable = verified.filter((s) => s.source !== "104game");
    const verified104 = verified.filter((s) => s.source === "104game");
    const unverified = checked.filter((s) => !s.ok);
    const rest = [
      ...(bintv ? [bintv] : []),
      ...directOk.map(({ ms, ...s }) => s),
      ...verifiedPlayable.map(({ ms, ...s }) => s),
      ...verified104.map(({ ms, ...s }) => s),
      ...unverified.map(({ ms, ...s }) => s),
    ];
    // A direct stream whose manifest failed the server check is
    // still worth one native try when it is the ONLY thing a
    // channel has — the browser's network may reach it even when
    // the server's cannot. Otherwise it stays hidden, so it never
    // delays the working sources.
    if (!rest.length) {
      rest.push(...direct.filter((s) => !s.ok).map(({ ms, ...s }) => s));
    }
    return rest;
  };
  const first = await Promise.race([
    bintvP.then((b) => ({ kind: "bintv", bintv: b })),
    restP,
  ]);
  if (first.kind === "bintv" && first.bintv) {
    return sendSources([first.bintv]);
  }
  if (first.kind === "rest") {
    return sendSources(orderSources(null, first.direct, first.checked));
  }
  // BINTV finished first but failed: wait for the rest.
  const { direct, checked } = await restP;
  return sendSources(orderSources(null, direct, checked));
}
