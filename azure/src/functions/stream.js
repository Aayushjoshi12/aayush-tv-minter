// stream.js — techjail minter as an Azure Function (Node.js v4
// programming model). This is a faithful conversion of the
// Vercel-style api/stream.js in this repo: same validation, same
// upstream call (tv.techjail.net getlink.php), same responses.
// The live Azure app's stream function was verified to behave
// identically (400 {"error":"Invalid id"} for a bare call,
// 502 {"error":"Upstream failed"} for id=1) before this file
// was packaged. Do not change the upstream URL, headers or
// validation — the techjail channels on Aayush TV depend on it.
//
// ENDPOINT: GET /api/stream?id=<techjail id>
//   -> 200 {"url": "http://.../playlist.m3u8"} on success
//   -> 400 on invalid id, 502 if getlink.php fails or is blocked

const { app } = require("@azure/functions");

app.http("stream", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      return { status: 204, headers };
    }
    const id = request.query.get("id");
    if (!id || !/^\d+$/.test(id)) {
      return { status: 400, headers, jsonBody: { error: "Invalid id" } };
    }
    const target = `http://tv.techjail.net/huritv9/getlink.php?vv=1&CHID=${id}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const r = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          Referer: "http://tv.techjail.net/v9x9/",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = (await r.text()).trim();
      if (!r.ok || !text.startsWith("http")) {
        return { status: 502, headers, jsonBody: { error: "Upstream failed" } };
      }
      return { status: 200, headers, jsonBody: { url: text } };
    } catch {
      return { status: 502, headers, jsonBody: { error: "Upstream error" } };
    }
  },
});
