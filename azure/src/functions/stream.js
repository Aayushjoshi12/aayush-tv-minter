// stream.js — techjail minter as an Azure Function (Node.js v4
// programming model). VERBATIM copy of the live app's
// src/functions/stream.js (Function App "aayush-tv-minter-kr",
// Korea Central), read from the portal's Code + Test editor on
// 11 Nov 2026. Do not "simplify" this file: the live function
// uses libcurl-impersonate (npm package "impers" + the bundled
// native lib/libcurl-impersonate.so) because plain requests to
// getlink.php get blocked. A plain-fetch version was tried and
// discarded — it matches the error responses but its success
// path is unproven against getlink.php.
//
// NOTE (11 Nov 2026): the Azure redeploy was ABANDONED by the
// user's decision ("if it not working then it ok leave for
// vercel only"). This azure/ package is INCOMPLETE — the
// lib/libcurl-impersonate.so binary is not in this repo, so
// deploying this package as-is would break the techjail
// minter. DO NOT deploy it. The Premium resolver runs on
// Vercel only (see api/resolve.js).

const path = require("path");
const fs = require("fs");
if (process.env.LIBCURL_PATH === undefined) {
  const bundled = path.join(__dirname, "..", "..", "lib", "libcurl-impersonate.so");
  if (fs.existsSync(bundled)) { process.env.LIBCURL_PATH = bundled; }
}
const { app } = require("@azure/functions");

app.http("stream", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") {
      return { status: 204, headers };
    }
    const id = request.query.get("id");
    if (id === null || id === undefined || /^\d+$/.test(id) === false) {
      return { status: 400, headers, jsonBody: { error: "Invalid id" } };
    }
    try {
      const res = await (await import("impers")).get(`https://tv.techjail.net/huritv9/getlink.php?vv=1&CHID=${id}`, {
        impersonate: "chrome",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          "Referer": "http://tv.techjail.net/v9x9/",
        },
        timeout: 20000,
      });
      const text = String(typeof res.text === "string" ? res.text : (res.content ? res.content.toString() : "")).trim();
      if (text.startsWith("http") === false) {
        return { status: 502, headers, jsonBody: { error: "Upstream failed" } };
      }
      return { status: 200, headers, jsonBody: { url: text } };
    } catch (error) {
      return { status: 502, headers, jsonBody: { error: "Upstream error" } };
    }
  },
});
