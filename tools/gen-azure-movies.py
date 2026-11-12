#!/usr/bin/env python3
"""Regenerate the Azure Functions copy of the movie resolver from the
Vercel source (api/resolve-movie.js).

Transformations (Vercel ESM -> Azure Functions v4 CommonJS):
  1. Swap the header comment for the Azure header.
  2. Convert the modlist-index ESM import to require().
  3. Swap the Vercel selfUrl for the Azure SELF_URL (set from the
     request origin at runtime, defaulting to the Function App URL).
  4. Rename `export default async function handler` to
     `async function handleMovie`.
  5. Append the app.http("resolve-movie") wrapper block.
  6. Copy api/modlist-index.js into azure-movies/src/functions/
     (so the relative require() resolves next to the function).

The Azure Function App is aayush-tv-movies (SEPARATE from the techjail
minter aayush-tv-minter-kr — never deploy to that one).

Usage: python3 tools/gen-azure-movies.py
"""
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "api" / "resolve-movie.js"
DST = ROOT / "azure-movies" / "src" / "functions" / "resolve-movie.js"
INDEX_SRC = ROOT / "api" / "modlist-index.js"
INDEX_DST = ROOT / "azure-movies" / "src" / "functions" / "modlist-index.js"
# The index is split into chunks (api/modlist-index-N.js); copy them
# all next to the Azure function, plus the loader above.
INDEX_CHUNKS = sorted((ROOT / "api").glob("modlist-index-[0-9]*.js"))

AZURE_URL = (
    "https://aayush-tv-movies-geesc6d8g6fchvfk.koreacentral-01."
    "azurewebsites.net/api/resolve-movie"
)

AZURE_HEADER = """// resolve-movie.js — Azure Functions (Node.js v4) build of the movie resolver.
// Same logic as api/resolve-movie.js on Vercel; only the HTTP wiring differs.
// Deployed to a SEPARATE Function App (aayush-tv-movies) — never to the
// techjail minter (aayush-tv-minter-kr). Auth level is Anonymous so the
// public site can call it. Endpoint: GET /api/resolve-movie?...
//
"""

APP_HTTP_BLOCK = '''
const { app } = require("@azure/functions");

app.http("resolve-movie", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const q = Object.fromEntries(new URL(request.url).searchParams.entries());
    const req = { method: request.method, query: q };
    let statusCode = 200;
    const headers = {};
    let body = null;
    let isJson = false;
    const res = {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      status: (c) => {
        statusCode = c;
        return {
          json: (o) => {
            body = o;
            isJson = true;
          },
          send: (t) => {
            body = t;
          },
          end: () => {
            body = "";
          },
        };
      },
    };
    SELF_URL = new URL(request.url).origin + "/api/resolve-movie";
    await handleMovie(req, res);
    if (isJson) return { status: statusCode, headers, jsonBody: body };
    return { status: statusCode, headers, body: body ?? "" };
  },
});
'''


def main():
    src = SRC.read_text()

    # 1. Header swap: the Vercel header is the first two lines
    #    ("// resolve-movie.js — server-side resolver..." + "//").
    #    The Azure header is 5 lines + a blank comment line; the doc
    #    comment continues from "// Deploy as api/resolve-movie.js".
    lines = src.split("\n")
    assert lines[0].startswith("// resolve-movie.js — server-side resolver"), lines[0]
    assert lines[1] == "//", lines[1]
    assert lines[2].startswith("// Deploy as api/resolve-movie.js"), lines[2]
    out = AZURE_HEADER + "\n".join(lines[2:])

    # 2. ESM imports of the index chunks -> require(). The resolver
    #    imports the chunks directly (no loader) so Vercel's bundler
    #    traces them from the entry file.
    out = re.sub(
        r'import \{ (MODLIST_INDEX_\d+) \} from "\./(modlist-index-\d+\.js)";',
        r'const { \1 } = require("./\2");',
        out,
    )
    assert re.search(r"^import ", out, re.M) is None, "an import survived"

    # 3. selfUrl swap.
    out = out.replace(
        'const selfUrl = () =>\n  "https://aayush-tv-minter.vercel.app/api/resolve-movie";',
        f'let SELF_URL = "{AZURE_URL}";\nconst selfUrl = () => SELF_URL;',
    )
    assert "aayush-tv-minter.vercel.app" not in out

    # 4. Handler rename.
    out = out.replace(
        "export default async function handler(req, res) {",
        "async function handleMovie(req, res) {",
    )
    assert "export default" not in out

    # 5. Append the app.http block.
    out = out.rstrip("\n") + "\n" + APP_HTTP_BLOCK

    DST.write_text(out)
    print(f"wrote {DST} ({len(out)} bytes)")

    # 6. Copy the modlist index module next to the Azure function
    #    (so the relative require() resolves). The index is split
    #    into chunks; the loader and every chunk are ESM, so each is
    #    converted to CommonJS on the way (import -> require(),
    #    export -> module.exports).
    def to_cjs(text):
        text = re.sub(
            r'import \{ (MODLIST_INDEX_\d+) \} from "\./(modlist-index-\d+\.js)";',
            r'const { \1 } = require("./\2");',
            text,
        )
        text = re.sub(
            r'export const (MODLIST_INDEX(?:_\d+)?) =',
            r'const \1 =',
            text,
        )
        if "module.exports" not in text:
            m = re.search(r"const (MODLIST_INDEX(?:_\d+)?) =", text)
            if m:
                text = text.rstrip("\n") + f"\nmodule.exports = {{ {m.group(1)} }};\n"
        return text

    if INDEX_SRC.exists():
        INDEX_DST.write_text(to_cjs(INDEX_SRC.read_text()))
        print(f"copied {INDEX_SRC.name} -> azure-movies/src/functions/ (as CommonJS)")
    else:
        print("WARNING: api/modlist-index.js not found, skipping")
    for chunk in INDEX_CHUNKS:
        dst = ROOT / "azure-movies" / "src" / "functions" / chunk.name
        dst.write_text(to_cjs(chunk.read_text()))
        print(f"copied {chunk.name} -> azure-movies/src/functions/ ({chunk.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
