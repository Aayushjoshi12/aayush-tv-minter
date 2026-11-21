#!/usr/bin/env python3
"""Nexus direct resolver — standalone server (stdlib only).

Same contract as the Vercel ?nexus= endpoint, but built to run on a
host whose IP Nexus does NOT block. Vercel is blocked: nxsha.space
returns HTTP 403 to Vercel for all 10 providers (proven 21 Nov 2026
via ?nexus=&debug=1), and the browser cannot call the API directly
either (/api/sources sends no Access-Control-Allow-Origin header).

So this runs on the aayushbot VM (or any unblocked host) as a small
service behind Caddy, e.g.:
  python3 nexus-server.py --port 8801
  Caddy: /api/nexus* -> 127.0.0.1:8801
The Movies page then points its Server 2 fetch at that URL instead
of the Vercel resolver. Responses carry Access-Control-Allow-Origin: *
so aayushlife.live can fetch them.

Contract:
  GET /nexus?tmdb=27205&type=movie            -> rewritten master manifest (m3u8)
  GET /nexus?tmdb=275204&type=tv&se=2&ep=1    -> same, for a series episode
  (mp4 winner)                                 -> {"url": ..., "kind": "mp4", "provider": ..., "label": ...}
  (no provider has a copy)                     -> {"noSource": true}
  GET /introdb?imdb=tt14650074&type=tv&se=2&ep=1 -> {"intro": {"start_sec": 497, "end_sec": 506}, "recap": null, "outro": null}
  (Skip Intro / Next Episode timestamps from Nexus's introdb API.
  Vercel cannot proxy this — nxsha.space 403s Vercel (proven 21 Nov
  2026) — and the browser cannot call it directly (no CORS header),
  so it lives here on the unblocked VM.)
  GET /health                                  -> {"ok": true}

Scheme: CryptoJS AES, OpenSSL salted format, one hardcoded passphrase
— Nexus's OWN public key, published in their public JS bundle. The
key lives server-side only and is never sent to the browser. If Nexus
rotates it, re-extract from their JS (64-char hex constant next to
the AES.decrypt call). Links are signed and expire (~2h) — resolve
fresh per play, never cache the result.

Usage: nexus-server.py [--port 8801] [--host 127.0.0.1]
       nexus-server.py --once --tmdb 27205 --type movie   (CLI test, prints result)
"""
import argparse
import json
import os
import random
import re
import string
import subprocess
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urljoin

KEY = os.environ.get("NEXUS_KEY") or "38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120"
BASE = "https://nxsha.space"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
PROVIDERS = ["nitro", "rive-citadel", "castle", "vixolity", "streamflix",
             "purstream", "awsind", "watchout", "ophim", "mahalala"]


def _openssl(args, data):
    p = subprocess.run(["openssl"] + args, input=data, capture_output=True, timeout=10)
    return p.stdout


def enc_q(payload):
    payload = dict(payload)
    payload["_req_ts"] = int(time.time() * 1000)
    payload["_req_salt"] = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10))
    raw = json.dumps(payload, separators=(",", ":")).encode()
    b64 = _openssl(["enc", "-aes-256-cbc", "-md", "md5", "-pass", f"pass:{KEY}", "-base64", "-A"], raw).decode().strip()
    return b64.replace("+", "-").replace("/", "_").rstrip("=")


def dec_hash(h):
    s = h.replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    out = _openssl(["enc", "-d", "-aes-256-cbc", "-md", "md5", "-pass", f"pass:{KEY}", "-base64", "-A"], s.encode())
    return json.loads(out.decode())


def _fetch(url, timeout=8, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception:
        return 0, {}, b""


def nx_sources(provider, tmdb, type_, season, episode):
    try:
        q = enc_q({"ex_lang": True, "provider": provider, "tmdbId": tmdb,
                   "imdb_id": "", "type": type_, "season": season, "episode": episode})
        status, _, body = _fetch(f"{BASE}/api/sources?q={q}", timeout=8)
        if status != 200:
            return []
        d = dec_hash(json.loads(body.decode())["_hash"])
        srcs = (d or {}).get("sources") or []
        return srcs if isinstance(srcs, list) else []
    except Exception:
        return []


def _quality(s):
    t = str(s.get("quality") or s.get("label") or "")
    m = re.search(r"(\d{3,4})\s*p", t, re.I)
    if m:
        return int(m.group(1))
    if re.search(r"4k|2160", t, re.I):
        return 2160
    return 720  # "Auto" / unlabeled (e.g. streamflix mp4): assume HD


def _lang(s):
    t = str(s.get("quality") or s.get("label") or "")
    if re.search(r"english", t, re.I):
        return 0
    if re.search(r"hindi|tamil|telugu|bengali|malayalam|kannada|punjabi|marathi", t, re.I):
        return 2
    return 1


def candidates(results):
    out = []
    for pi, lst in enumerate(results):
        for s in lst or []:
            if not s or s.get("isEmbed"):
                continue
            url = s.get("org_uri") or s.get("url")
            if not url or not url.startswith("https://"):
                continue
            if re.search(r"\.m3u8(\?|$)", url, re.I):
                kind = "m3u8"
            elif re.search(r"\.(mp4|mkv)(\?|$)", url, re.I):
                kind = "mp4"
            else:
                continue
            out.append({"url": url, "kind": kind, "provider": s.get("provider") or PROVIDERS[pi],
                        "label": s.get("label") or s.get("quality") or "", "pi": pi})
    out.sort(key=lambda c: (c["pi"], -_quality(c), _lang(c)))
    return out


def probe(c):
    headers = {"Range": "bytes=0-2047"} if c["kind"] == "mp4" else None
    status, resp_headers, body = _fetch(c["url"], timeout=6, headers=headers)
    if status not in (200, 206):
        return None
    if c["kind"] == "m3u8":
        text = body.decode("utf-8", "ignore")
        return text if text.startswith("#EXTM3U") else None
    ct = str(resp_headers.get("Content-Type") or "").lower()
    return True if (status == 206 or "video" in ct or "octet-stream" in ct) else None


def rewrite_manifest(text, target):
    # Same as the Vercel resolver's rewriteManifestText with no
    # embedRef: nested .m3u8 links and segment names are made
    # absolute against the manifest's own URL, so hls.js can play
    # the manifest from a blob URL. Segments still load straight
    # from the CDN; only the tiny manifests pass through here.
    lines = []
    for line in text.split("\n"):
        t = line.strip()
        if not t:
            lines.append(line)
            continue
        if t.startswith("#") and 'URI="' in t:
            def _uri(m):
                u = m.group(1)
                return 'URI="' + (u if u.startswith("http") else urljoin(target, u)) + '"'
            lines.append(re.sub(r'URI="([^"]+\.m3u8[^"]*)"', _uri, line))
            continue
        if t.startswith("#"):
            lines.append(line)
            continue
        if re.search(r"\.m3u8(\?|$)", t):
            lines.append(urljoin(target, t))
            continue
        if not t.startswith("http"):
            lines.append(urljoin(target, t))
            continue
        lines.append(line)
    return "\n".join(lines)


def resolve(tmdb, type_, season, episode):
    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(lambda p: nx_sources(p, tmdb, type_, season, episode), PROVIDERS))
    cands = candidates(results)
    if not cands:
        return {"noSource": True}
    for kind in ("m3u8", "mp4"):
        pool = [c for c in cands if c["kind"] == kind][:4]
        if not pool:
            continue
        with ThreadPoolExecutor(max_workers=4) as ex:
            probed = list(ex.map(lambda c: (c, probe(c)), pool))
        winner = next(((c, r) for c, r in probed if r), None)
        if not winner:
            continue
        c, r = winner
        if kind == "mp4":
            return {"url": c["url"], "kind": "mp4", "provider": c["provider"], "label": c["label"]}
        return {"manifest": rewrite_manifest(r, c["url"]), "provider": c["provider"], "label": c["label"]}
    return {"noSource": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, body, ctype):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, json.dumps({"ok": True}), "application/json")
        if u.path == "/nexus":
            qs = parse_qs(u.query)
            tmdb = (qs.get("tmdb") or [""])[0].strip()
            type_ = "tv" if (qs.get("type") or ["movie"])[0] == "tv" else "movie"
            try:
                season = max(1, int((qs.get("se") or ["1"])[0]))
                episode = max(1, int((qs.get("ep") or ["1"])[0]))
            except ValueError:
                season, episode = 1, 1
            if not tmdb.isdigit():
                return self._send(400, json.dumps({"error": "Bad TMDB id"}), "application/json")
            try:
                res = resolve(int(tmdb), type_, season, episode)
            except Exception:
                res = {"noSource": True}
            if "manifest" in res:
                return self._send(200, res["manifest"], "application/vnd.apple.mpegurl")
            return self._send(200, json.dumps(res), "application/json")
        if u.path == "/introdb":
            qs = parse_qs(u.query)
            imdb = (qs.get("imdb") or [""])[0].strip()
            type_ = "tv" if (qs.get("type") or ["movie"])[0] == "tv" else "movie"
            try:
                season = max(1, int((qs.get("se") or ["1"])[0]))
                episode = max(1, int((qs.get("ep") or ["1"])[0]))
            except ValueError:
                season, episode = 1, 1
            if not re.fullmatch(r"tt\d+", imdb):
                return self._send(400, json.dumps({"error": "Bad IMDb id"}), "application/json")
            url = (f"{BASE}/api/introdb?imdb_id={imdb}&is_movie={'true' if type_ == 'movie' else 'false'}"
                   + (f"&season={season}&episode={episode}" if type_ == "tv" else ""))
            status, _, body = _fetch(url, timeout=8)
            if status != 200:
                return self._send(502, json.dumps({"error": "Introdb fetch failed", "upstream": status}), "application/json")
            try:
                d = json.loads(body.decode())
            except Exception:
                return self._send(502, json.dumps({"error": "Introdb fetch failed"}), "application/json")
            def seg(x):
                if isinstance(x, dict):
                    try:
                        return {"start_sec": float(x["start_sec"]), "end_sec": float(x["end_sec"])}
                    except Exception:
                        return None
                return None
            return self._send(200, json.dumps({"intro": seg(d.get("intro")), "recap": seg(d.get("recap")), "outro": seg(d.get("outro"))}), "application/json")
        return self._send(404, json.dumps({"error": "not found"}), "application/json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8801)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--once", action="store_true", help="resolve once and print, no server")
    ap.add_argument("--tmdb", default="27205")
    ap.add_argument("--type", default="movie")
    ap.add_argument("--se", type=int, default=1)
    ap.add_argument("--ep", type=int, default=1)
    args = ap.parse_args()
    if args.once:
        res = resolve(int(args.tmdb), args.type, args.se, args.ep)
        if "manifest" in res:
            print(res["manifest"][:600])
            print(f"... [manifest, provider={res['provider']} label={res['label']}]")
        else:
            print(json.dumps(res))
        return
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"nexus-resolver listening on {args.host}:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
