// Test the featured-feed fix in api/onexbet.js:
//  1 real mirror: ?mode=featured returns live games.
//  2 one leg hangs: the other leg's games still return FAST (parallel,
//    not the old sequential 10s + 10s).
//  3 both legs fail on mirror 1: the handler falls through to mirror 2
//    (the old code swallowed the failure and returned [] on mirror 1).
import handler from "/home/hatch/workspace/aayush-tv-minter/api/onexbet.js";

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("PASS:", msg);
  else { console.log("FAIL:", msg); failures++; }
}
function call(mode) {
  return new Promise((resolve, reject) => {
    const req = { method: "GET", query: { mode } };
    const res = {
      statusCode: 200,
      setHeader() {},
      end(body) {
        try { resolve({ status: this.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(new Error("bad json: " + String(body).slice(0, 200))); }
      },
    };
    handler(req, res).catch(reject);
  });
}
const game = (id, home, away) => ({
  id, opponent1: { fullName: home }, opponent2: { fullName: away },
  scores: { timer: { timeSec: 2700 }, statusLineStr: "2nd half", currentPeriod: 2, currentPeriodName: "2nd half", periodScoresStr: "" },
  sport: { id: 1, name: "Football" }, startTs: Math.floor(Date.now() / 1000) - 2700,
});
const realFetch = globalThis.fetch;

// --- 1: real mirror ---
{
  const t0 = Date.now();
  const r = await call("featured");
  const ms = Date.now() - t0;
  check(r.status === 200 && (r.body.games || []).length > 0,
    `1 real mirror: featured returns ${(r.body.games || []).length} games in ${ms}ms (status ${r.status})`);
  if ((r.body.games || []).length) console.log("   e.g.", r.body.games[0].home, "vs", r.body.games[0].away, "|", r.body.games[0].status);
}

// --- 2: games1x2 hangs, topGamesByStat answers fast ---
{
  globalThis.fetch = (url, opts) => {
    if (String(url).includes("games1x2")) {
      return new Promise((_, rej) => { opts.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
    }
    return Promise.resolve({ ok: true, json: async () => [game(101, "Hang Test Home", "Hang Test Away")] });
  };
  const t0 = Date.now();
  const r = await call("featured");
  const ms = Date.now() - t0;
  check(r.status === 200 && (r.body.games || []).length === 1 && r.body.games[0].home === "Hang Test Home",
    `2 hung games1x2 leg: featured leg still returns in ${ms}ms (5s leg cap; old sequential code took ~10000ms)`);
  check(ms < 6000, `2 elapsed ${ms}ms < 6000ms`);
  globalThis.fetch = realFetch;
}

// --- 3: both legs fail on mirror 1, succeed on mirror 2 ---
{
  globalThis.fetch = (url) => {
    if (String(url).includes("1xlite-6229051.com")) return Promise.reject(new Error("mirror 1 down"));
    return Promise.resolve({ ok: true, json: async () => [game(202, "Mirror Two Home", "Mirror Two Away")] });
  };
  const r = await call("featured");
  check(r.status === 200 && (r.body.games || []).length === 1 && r.body.games[0].home === "Mirror Two Home",
    "3 mirror 1 down: falls through to mirror 2 and returns its games");
  check(r.body.mirror === "https://1xlite-6428119.com", "3 mirror field is the second mirror, got: " + r.body.mirror);
  globalThis.fetch = realFetch;
}

console.log(failures === 0 ? "SIMULATION PASS" : "SIMULATION FAIL");
process.exit(failures === 0 ? 0 : 1);
