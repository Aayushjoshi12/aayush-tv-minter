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


SMALL_WORDS = {
    "of", "the", "a", "an", "and", "in", "on", "at", "to", "for", "with",
}

MOVIESMOD_STOP = {
    "hindi", "english", "dual", "audio", "multi", "korean", "chinese",
    "japanese", "tamil", "telugu", "malayalam", "kannada", "bengali",
    "punjabi", "marathi", "urdu", "thai", "french", "german", "italian",
    "spanish", "portuguese", "russian", "turkish", "arabic", "persian",
    "indonesian", "malay", "vietnamese", "filipino", "season",
    "480p", "720p", "1080p", "2160p", "4k", "hevc", "10bit", "x264",
    "x265", "web", "bluray", "hdrip", "hdcam", "esub", "uncut",
}

SITE_NAMES = {"mm": "MoviesMod", "ml": "MoviesLeech", "uhd": "UHDMovies", "af": "AnimeFlix"}
SITE_BASES = {
    "mm": "https://moviesmod.tw",
    "ml": "https://moviesleech.media",
    "uhd": "https://uhdmovies.beauty",
    "af": "https://animeflix.my",
}


def slug_to_movie(slug):
    """Port of the resolver's slugToMovie: title, year, season.
    First year wins (a range like 2017-2020 is the 2017 series);
    season markers (s01, s03, season) stay out of the title."""
    parts = [p for p in slug.split("-") if p]
    year_idx = -1
    year = ""
    for i, p in enumerate(parts):
        if re.fullmatch(r"(19|20)\d{2}", p):
            y = int(p)
            if 1900 <= y <= 2030:
                year_idx = i
                year = p
                break
    end = year_idx if year_idx >= 0 else len(parts)
    if year_idx < 0:
        for i, p in enumerate(parts):
            if p in MOVIESMOD_STOP:
                end = i
                break
    words = [
        w for w in parts[:end]
        if not re.fullmatch(r"s\d{1,2}", w, flags=re.I) and w.lower() != "season"
    ]
    if not words:
        return {"title": "", "year": year, "season": ""}
    titled = []
    for i, w in enumerate(words):
        if i > 0 and w in SMALL_WORDS:
            titled.append(w)
        else:
            titled.append(w[:1].upper() + w[1:])
    title = " ".join(titled)
    s = slug.lower()
    m = re.search(r"season-(\d{1,2})(?:-(\d{1,2}))?", s)
    if m:
        first = int(m.group(1))
        second = int(m.group(2)) if m.group(2) else None
        rng = f"{first}-{second}" if (second is not None and second > first and second <= 12) else f"{first}"
        return {"title": f"{title} — Season {rng}", "year": year, "season": rng}
    m = re.search(r"\bs(\d{1,2})-s(\d{1,2})\b", s)
    if m:
        first, second = int(m.group(1)), int(m.group(2))
        rng = f"{first}-{second}" if (second > first and second <= 12) else f"{first}"
        return {"title": f"{title} — Season {rng}", "year": year, "season": rng}
    m = re.search(r"\bs(\d{1,2})\b", s)
    if m:
        return {"title": f"{title} — Season {m.group(1)}", "year": year, "season": m.group(1)}
    return {"title": title, "year": year, "season": ""}


def slug_looks_series(slug):
    s = slug.lower()
    if "season" in s or re.search(r"\bs\d{1,2}\b", s):
        return True
    if re.search(r"\b(19|20)\d{2}\b", s):
        return False
    return True


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")


def main():
    entries = {}  # (site, slug) -> (poster, lastmod)
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
            # Each <url> block has <loc>...</loc>, <lastmod>...</lastmod>
            # and optionally <image:image><image:loc>...</image:loc>.
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
                lm_m = re.search(r"<lastmod>([^<]+)</lastmod>", block)
                lastmod = lm_m.group(1) if lm_m else ""
                key = (code, slug)
                # Keep the first poster seen for a (site, slug),
                # but keep the NEWEST lastmod if the page re-appears.
                if key not in entries:
                    entries[key] = (poster, lastmod)
                    n += 1
                    if poster:
                        n_poster += 1
                elif lastmod and lastmod > entries[key][1]:
                    entries[key] = (entries[key][0] or poster, lastmod)
        print(f"  {code}: {n} entries ({n_poster} with poster)")
    out = [
        {"s": slug, "site": code, "p": poster}
        for (code, slug), (poster, _lm) in sorted(entries.items())
    ]
    print(f"TOTAL unique entries: {len(out)}")

    (ROOT / "data-modlist-index.json").write_text(
        json.dumps(out, separators=(",", ":"))
    )
    # ---- "New" feed: the newest titles across all four sites,
    # by sitemap <lastmod>. A tiny static file the Movies home page
    # fetches directly (public/modlist-new.json) so new movies and
    # series appear on the home page without a search.
    # Dedupe by title+year+site (one card per site per title).
    newest = sorted(
        ((lm, code, slug, poster) for (code, slug), (poster, lm) in entries.items() if lm),
        key=lambda t: t[0],
        reverse=True,
    )
    seen_new = set()
    new_items = []
    for lm, code, slug, poster in newest:
        info = slug_to_movie(slug)
        if not info["title"]:
            continue
        key = (info["title"].lower(), info["year"], code)
        if key in seen_new:
            continue
        seen_new.add(key)
        new_items.append({
            "title": info["title"],
            "year": info["year"],
            "season": info["season"],
            "series": slug_looks_series(slug),
            "slug": slug,
            "site": code,
            "siteName": SITE_NAMES.get(code, code),
            "poster": poster,
            "pageUrl": f"{SITE_BASES[code]}/download-{slug}/",
            "lastmod": lm[:10],
        })
        if len(new_items) >= 24:
            break
    (ROOT / "public" / "modlist-new.json").write_text(
        json.dumps(new_items, separators=(",", ":"))
    )
    print(f"  modlist-new.json: {len(new_items)} newest entries"
          + (f" (newest {new_items[0]['lastmod']})" if new_items else ""))
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
