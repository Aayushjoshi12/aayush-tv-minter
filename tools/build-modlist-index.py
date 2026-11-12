#!/usr/bin/env python3
"""Build api/modlist-index.js from the whole modlist network's sitemaps.

The modlist network (modlist.in) is several WordPress movie sites:
  moviesmod.tw    (Hollywood)   — 22 post sitemaps, ~21,704 posts
  moviesleech.media (Bollywood) — 4 post sitemaps, ~4,000 posts
  uhdmovies.beauty (4K/UHD)     — 6 post sitemaps, ~6,000 posts
  animeflix.my    (anime)       — 1 post sitemap, ~812 posts
(gamesleech / softwareleech are games + software, not movies — skipped.)

Each site's Yoast sitemap (sitemap_index.xml -> post-sitemap*.xml)
carries the movie page URL (<loc>) AND its poster (<image:loc>),
so the index holds slug + site + poster with no extra fetches.

Writes:
  api/modlist-index.js  — static JS module the resolver imports
                          (export const MODLIST_INDEX = [...])
  data-modlist-index.json — raw entries, for reference

Entry shape: {"s": <slug>, "site": <code>, "p": <poster url>}
  site codes: mm = moviesmod.tw, ml = moviesleech.media,
              uhd = uhdmovies.beauty, af = animeflix.my
  slug: the movie-page path with the "download-" prefix and the
        trailing "/" stripped (the resolver re-adds them).

Usage: python3 tools/build-modlist-index.py
"""
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    )
}

# (site code, sitemap_index URL, post URL prefix to keep)
SITES = [
    ("mm", "https://moviesmod.tw/sitemap_index.xml", "https://moviesmod.tw/download-"),
    ("ml", "https://moviesleech.media/sitemap_index.xml", "https://moviesleech.media/download-"),
    ("uhd", "https://uhdmovies.beauty/sitemap_index.xml", "https://uhdmovies.beauty/download-"),
    ("af", "https://animeflix.my/sitemap_index.xml", "https://animeflix.my/download-"),
]


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")


def main():
    entries = {}  # (site, slug) -> poster
    for code, index_url, prefix in SITES:
        idx = fetch(index_url)
        sitemaps = re.findall(
            r"<loc>(https?://[^<]*?/post-sitemap\d*\.xml)</loc>", idx
        )
        print(f"{code}: {len(sitemaps)} post sitemaps")
        n = 0
        n_poster = 0
        for sm in sitemaps:
            xml = fetch(sm)
            # Each <url> block has <loc>...</loc> and optionally
            # <image:image><image:loc>...</image:loc></image:image>.
            for block in re.findall(r"<url>(.*?)</url>", xml, flags=re.S):
                loc_m = re.search(r"<loc>([^<]+)</loc>", block)
                if not loc_m:
                    continue
                loc = loc_m.group(1)
                if not loc.startswith(prefix):
                    continue
                slug = loc[len(prefix):].rstrip("/")
                if not slug:
                    continue
                poster_m = re.search(r"<image:loc>([^<]+)</image:loc>", block)
                poster = poster_m.group(1) if poster_m else ""
                key = (code, slug)
                # Keep the first poster seen for a (site, slug).
                if key not in entries:
                    entries[key] = poster
                    n += 1
                    if poster:
                        n_poster += 1
        print(f"  {code}: {n} entries ({n_poster} with poster)")
    out = [
        {"s": slug, "site": code, "p": poster}
        for (code, slug), poster in sorted(entries.items())
    ]
    print(f"TOTAL unique entries: {len(out)}")

    (ROOT / "data-modlist-index.json").write_text(
        json.dumps(out, separators=(",", ":"))
    )
    # The index is ~5MB, which exceeds the push tool's request size
    # limit, so it is split into ~550KB chunks that the loader
    # (api/modlist-index.js) concats. Poster URLs are compressed to
    # the path after /wp-content/uploads/ (the resolver rebuilds
    # them as <site>/wp-content/uploads/<p>).
    import re as _re

    def compress(e):
        p = _re.sub(r"^https?://[^/]+/wp-content/uploads/", "", e.get("p", ""))
        return {"s": e["s"], "site": e["site"], "p": p}

    out = [compress(e) for e in out]
    CHUNK = 4500
    chunks = [out[i:i + CHUNK] for i in range(0, len(out), CHUNK)]
    for i, ch in enumerate(chunks, 1):
        name = ROOT / "api" / f"modlist-index-{i}.js"
        header = (
            f"// modlist-index-{i}.js — part {i} of {len(chunks)} of the modlist\n"
            "// network catalogue (see tools/build-modlist-index.py).\n"
            "// Poster paths are relative to <site>/wp-content/uploads/.\n"
            f"export const MODLIST_INDEX_{i} = "
        )
        name.write_text(header + json.dumps(ch, separators=(",", ":")) + ";\n")
        print(f"  {name.name}: {len(ch)} entries, {name.stat().st_size} bytes")
    loader = (
        "// modlist-index.js — loads the chunked modlist catalogue.\n"
        "// Split into parts because a single 5MB file exceeds the push\n"
        "// tool's request size limit. Rebuilt by tools/build-modlist-index.py.\n"
    )
    for i in range(1, len(chunks) + 1):
        loader += f'import {{ MODLIST_INDEX_{i} }} from "./modlist-index-{i}.js";\n'
    loader += "export const MODLIST_INDEX = [\n"
    for i in range(1, len(chunks) + 1):
        loader += f"  ...MODLIST_INDEX_{i},\n"
    loader += "];\n"
    (ROOT / "api" / "modlist-index.js").write_text(loader)
    print(
        f"rewrote api/modlist-index.js "
        f"({(ROOT / 'api' / 'modlist-index.js').stat().st_size} bytes)"
    )


if __name__ == "__main__":
    main()
