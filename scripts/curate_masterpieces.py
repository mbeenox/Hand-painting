"""
curate_masterpieces.py — build `frontend/public/masterpieces.json` (Feature 5.3).

    python3 scripts/curate_masterpieces.py            # full run (~15 min)
    python3 scripts/curate_masterpieces.py --limit 60 # quick smoke run

WHY THIS EXISTS, AND WHY IT IS COMMITTED
----------------------------------------
"Today's masterpiece" offers everyone the same public-domain artwork each
day. The list has to be vetted ONCE, offline, because the app must never
depend on a live search: a slow or down API would sit in front of the core
flow, and an unvetted pick could be a blurry ceramic fragment. This script is
that vetting, kept in the repo so the list can be regenerated and audited.

WHERE THE IMAGES COME FROM (the non-obvious decision)
-----------------------------------------------------
The plan said "Met Open Access API". The Met's own image host
(images.metmuseum.org) sends NO `Access-Control-Allow-Origin` header —
measured, not assumed — which breaks this feature twice over:

  1. `fetch(url).blob()` from the browser is refused outright, so there is no
     way to feed the image into the existing upload path; and
  2. worse, drawing such an image into the WebGL canvas (the 5.2 ghost
     reveal does exactly that) TAINTS the canvas, and a tainted canvas makes
     `toDataURL`/`captureStream` throw — which would silently break PNG,
     video and GIF export for everyone.

Wikimedia Commons serves `Access-Control-Allow-Origin: *`, and the Met
donated its Open Access collection to Commons — so the very same artworks are
available from a host the browser will actually talk to. We therefore keep
the Met provenance the plan wanted and drop the CORS problem, with no backend
proxy and no new SSRF surface.

WHAT "VETTED" MEANS HERE
------------------------
Not "is a painting" — that is a metadata question and a weak proxy. Each
candidate is run through THIS APP'S OWN pipeline (`api/index.py`:
detect_edges → trace_chains, plus the same Haar cascade the camera uses) and
scored on what actually determines whether a picture draws beautifully: does
it have a face, is its edge density in the band the tracer likes, does it
yield a sane number of strokes. The accept band is calibrated against the two
bundled samples, which are known to draw well:

    astronaut.jpg  density 0.042  chains 212  ink 37.2  faces 1
    pearl.jpg      density 0.059  chains 464  ink 52.3  faces 1
"""
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import random
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))
import index as pipeline  # noqa: E402  (the app's real backend)

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "frontend", "public", "masterpieces.json")
CACHE = os.path.join(ROOT, ".masterpiece-cache.json")
VETTED = os.path.join(ROOT, ".masterpiece-vetted.json")
CASCADE = os.path.join(ROOT, "api", "haarcascade_frontalface_default.xml")

API = "https://commons.wikimedia.org/w/api.php"
UA = {"User-Agent": "HypnoticHand/1.0 (https://hand-painting-one.vercel.app) curation"}

# Commons categories to crawl. Portrait-first: this app draws faces best.
ROOTS = [
    "Portrait paintings in the Metropolitan Museum of Art",
    "Paintings in the Metropolitan Museum of Art",
]
MAX_DEPTH = 2
MAX_CATEGORIES = 350     # the Met tree is vast; bound the crawl
MAX_FILES = 2500
THUMB_W = 1024          # stored + drawn; the client downscales to ≤1280 anyway
TARGET = 200
PER_ARTIST = 3          # nobody gets to own the calendar

# Accept band, bracketing the two known-good samples generously.
MIN_DENSITY, MAX_DENSITY = 0.022, 0.110
MIN_CHAINS, MAX_CHAINS = 70, 950
MIN_INK, MAX_INK = 18.0, 95.0
MIN_ASPECT, MAX_ASPECT = 0.55, 1.45
# Frame rejection. Many Commons photographs of museum works include the
# PICTURE FRAME or a hard painted border, and the tracer draws it faithfully:
# the result is a beautiful rectangle with a small portrait inside. Metadata
# cannot see this and neither can edge density — it was only caught by
# rendering the first few daily picks and looking at them.
#   · frame_lines — long axis-aligned runs near the margins (Hough).
#     astronaut 0 · pearl 0 · framed miniature 1 · bordered panel 3
#   · ring_ratio — ink density in the outer 9% ring over the middle.
#     astronaut 0.62 · pearl 0.43 · speckle-bordered pick 1.44
MAX_FRAME_LINES = 0
MAX_RING_RATIO = 1.05
# A face that fills the frame is usually the detector latching onto a
# rectangle, not a portrait; a tiny one means the subject is lost in surround.
MIN_FACE_W, MAX_FACE_W = 0.12, 0.55

# The Met's Commons tree is thick with portrait MINIATURES — locket-sized
# watercolours on ivory, photographed inside their decorative oval mounts.
# They pass every numeric test (a real face, clean margins, sane edge
# density) because the mount is not a straight-sided frame, but the traced
# result is a big ornamented oval with a small sitter inside it. Commons
# labels them in the description/category text, which is far cheaper and more
# reliable than trying to detect an ellipse.
# Matched as WHOLE WORDS against description + category + filename. Word
# boundaries matter: a substring test for "fan" also hits "infant", and "box"
# hits "boxwood". Some of these objects carry no description at all (the
# "Nun's Badge with the Virgin" that reached a daily slot had an empty one) —
# the filename is what names them.
EXCLUDE_DESC = ("miniature", "locket", "snuffbox", "snuff", "medallion", "cameo",
                "badge", "plaque", "medal", "watch", "fan", "box", "case",
                "pendant", "brooch", "enamel", "porcelain", "ceramic",
                "jewelry", "metalwork", "furniture", "ivory", "tankard")
EXCLUDE_RE = re.compile(r"\b(?:" + "|".join(EXCLUDE_DESC) + r")\b", re.I)


def api(**params):
    params.update(action="query", format="json")
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=40
            ) as r:
                return json.loads(r.read())
        except Exception as exc:                      # transient → back off
            if attempt == 3:
                raise
            print(f"    retry {attempt + 1} ({exc})", flush=True)
            time.sleep(1.5 * (attempt + 1))
    return {}


def category_members(cat, kind):
    out, cont = [], None
    while True:
        kw = dict(list="categorymembers", cmtitle="Category:" + cat,
                  cmtype=kind, cmlimit=500)
        if cont:
            kw["cmcontinue"] = cont
        d = api(**kw)
        out += [m["title"] for m in d.get("query", {}).get("categorymembers", [])]
        cont = d.get("continue", {}).get("cmcontinue")
        if not cont:
            return out
        time.sleep(0.12)


def harvest():
    """BFS the category tree for file titles."""
    seen_cats, files, queue = set(), [], [(c, 0) for c in ROOTS]
    while queue and len(seen_cats) < MAX_CATEGORIES and len(files) < MAX_FILES:
        cat, depth = queue.pop(0)
        if cat in seen_cats:
            continue
        seen_cats.add(cat)
        try:
            files += category_members(cat, "file")
            if depth < MAX_DEPTH:
                for sub in category_members(cat, "subcat"):
                    queue.append((sub[len("Category:"):], depth + 1))
        except Exception as exc:
            print(f"  ! {cat[:60]}: {exc}")
        if len(seen_cats) % 25 == 0:
            print(f"  …{len(seen_cats)} categories, {len(files)} files", flush=True)
    return sorted(set(files))


def clean(html):
    """Tags become a SPACE, not nothing. Commons packs several elements into
    one field, and stripping tags to the empty string welds them together:
    the Artist field for an unattributed work came out as
    "AnonymousUnknown author "Chinese Painter"" and went straight into a
    user-facing credit line."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def clean_artist(html):
    """Normalise the many ways Commons says "we do not know"."""
    a = strip_markup(html)
    a = re.sub(r'^[\s"\u2018\u2019\u201c\u201d]+|[\s"\u2018\u2019\u201c\u201d]+$', "", a)
    if re.search(r"(anonymous|unknown|unidentified)", a, re.I):
        return "Anonymous"
    return a


def strip_markup(text):
    """Commons free-text fields carry Wikidata QS statements glued on:
    'Portrait of a Man label QS:Lit,"Ritratto..."', 'circa 1840date QS:P571,+…'.
    Also drops the Met image ID that trails a filename-derived title
    ('Portrait of a Young Man MET DP1612')."""
    t = clean(text)
    t = re.split(r"(?:label|title|date|description)?\s*QS:", t)[0]
    t = re.sub(r"\s+MET\s+[A-Z]{2,4}[\d_-]+$", "", t)
    return re.sub(r"[\s,;/\"'(]+$", "", t).strip()


def enrich(titles):
    """imageinfo in batches of 50 → the metadata we keep."""
    out = []
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        d = api(prop="imageinfo", iiprop="url|size|extmetadata",
                iiurlwidth=THUMB_W, titles="|".join(batch))
        for page in d.get("query", {}).get("pages", {}).values():
            info = (page.get("imageinfo") or [None])[0]
            if not info:
                continue
            em = info.get("extmetadata", {})
            lic = (em.get("License", {}).get("value") or "").lower()
            if not (lic.startswith("cc0") or "pd" in lic or "public" in lic):
                continue
            w, h = info.get("thumbwidth"), info.get("thumbheight")
            if not w or not h:
                continue
            out.append({
                "file": page["title"],
                "img": info["thumburl"],
                "w": w, "h": h,
                "title": strip_markup(em.get("ObjectName", {}).get("value"))
                         or strip_markup(page["title"][5:-4].replace("_", " ")),
                "artist": clean_artist(em.get("Artist", {}).get("value")),
                "date": strip_markup(em.get("DateTimeOriginal", {}).get("value"))[:44],
                "license": em.get("LicenseShortName", {}).get("value", ""),
                # Kept so the miniature filter below can run off the cache.
                "desc": (clean(em.get("ImageDescription", {}).get("value"))[:160]
                         + " | " + clean(em.get("Categories", {}).get("value"))[:400]),
            })
        print(f"  enriched {min(i + 50, len(titles))}/{len(titles)}", flush=True)
        time.sleep(0.15)
    return out


def score(jpeg_bytes):
    """Run the app's OWN pipeline and report what determines a good draw."""
    arr = np.frombuffer(jpeg_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    s = pipeline.MAX_IMAGE_DIM / max(w, h)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))),
                     interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    H, W = img.shape[:2]
    edges = pipeline.detect_edges(img)
    density = float((edges > 0).mean())
    eps, min_chain, _out_pts, _max_strokes = pipeline.TRACE_LEVELS["std"]
    chains = pipeline.trace_chains(edges, eps, min_chain)
    ink = sum(float(np.sum(np.linalg.norm(np.diff(c, axis=0), axis=1)))
              for c in chains) / max(W, H)
    grey = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    side = int(min(H, W) * 0.10)
    faces = cv2.CascadeClassifier(CASCADE).detectMultiScale(
        grey, 1.1, 6, minSize=(side, side))
    face_w = max((f[2] for f in faces), default=0) / W

    # Border ink vs middle ink: a frame or mount lights up the outer ring.
    r = 0.09
    ring = edges.copy()
    ring[int(H * r):int(H * (1 - r)), int(W * r):int(W * (1 - r))] = 0
    core = edges[int(H * r):int(H * (1 - r)), int(W * r):int(W * (1 - r))]
    ring_d = (ring > 0).sum() / max(1, edges.size - core.size)
    core_d = (core > 0).sum() / max(1, core.size)

    # Long axis-aligned runs hugging the margins = a traced picture frame.
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                            minLineLength=int(min(H, W) * 0.55), maxLineGap=6)
    frame_lines = 0
    for x1, y1, x2, y2 in (lines[:, 0] if lines is not None else []):
        axis_aligned = abs(y2 - y1) < 4 or abs(x2 - x1) < 4
        near_edge = (min(y1, y2) < H * 0.14 or max(y1, y2) > H * 0.86
                     or min(x1, x2) < W * 0.14 or max(x1, x2) > W * 0.86)
        if axis_aligned and near_edge:
            frame_lines += 1

    return {"density": round(density, 4), "chains": len(chains),
            "ink": round(ink, 1), "faces": len(faces),
            "aspect": round(W / H, 3), "face_w": round(float(face_w), 3),
            "ring_ratio": round(float(ring_d / max(core_d, 1e-6)), 2),
            "frame_lines": int(frame_lines)}


def accept(s):
    return (MIN_DENSITY <= s["density"] <= MAX_DENSITY
            and MIN_CHAINS <= s["chains"] <= MAX_CHAINS
            and MIN_INK <= s["ink"] <= MAX_INK
            and MIN_ASPECT <= s["aspect"] <= MAX_ASPECT
            and s["frame_lines"] <= MAX_FRAME_LINES
            and s["ring_ratio"] <= MAX_RING_RATIO
            and MIN_FACE_W <= s["face_w"] <= MAX_FACE_W)


def quality(s):
    """Distance from the ideal the two bundled samples describe."""
    q = 0.0
    q += 2.2 if s["faces"] >= 1 else 0.0          # a face is the whole point
    q += 1.0 - min(1.0, abs(s["density"] - 0.050) / 0.050)
    q += 1.0 - min(1.0, abs(s["ink"] - 45.0) / 45.0)
    q += 0.8 * (1.0 - min(1.0, abs(s["aspect"] - 0.82) / 0.6))
    q += 0.9 * (1.0 - min(1.0, abs(s["face_w"] - 0.28) / 0.28))   # portrait scale
    q += 0.7 * (1.0 - min(1.0, s["ring_ratio"] / MAX_RING_RATIO))  # clean margins
    return round(q, 4)


def fetch(url, timeout=45):
    """Polite GET. Wikimedia answers 429 to impatient clients — back off and
    retry rather than silently dropping the candidate, which is how an
    earlier run "vetted" 950 images in 44 seconds and kept almost none."""
    for attempt in range(5):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=timeout
            ) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == 4:
                raise
            time.sleep(2.0 * (attempt + 1))
        except Exception:
            if attempt == 4:
                raise
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError("unreachable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="cap candidates (smoke run)")
    ap.add_argument("--refresh", action="store_true", help="ignore the harvest cache")
    args = ap.parse_args()

    if os.path.exists(CACHE) and not args.refresh:
        cands = json.load(open(CACHE))
        print(f"cache: {len(cands)} candidates")

    else:
        print("harvesting Commons categories…")
        titles = harvest()
        print(f"  {len(titles)} files")
        cands = enrich(titles)
        json.dump(cands, open(CACHE, "w"))
        print(f"  {len(cands)} freely-licensed candidates cached")

    before = len(cands)
    cands = [c for c in cands
             if not EXCLUDE_RE.search(c.get("desc", "") + " " + c["file"])]
    print(f"  dropped {before - len(cands)} miniatures/mounted objects "
          f"→ {len(cands)}")

    # Deterministic shuffle BEFORE any limit: the cache is alphabetical by
    # file name, so slicing it raw would sample one corner of the collection.
    random.Random(20260725).shuffle(cands)
    if args.limit:
        cands = cands[:args.limit]

    print(f"vetting {len(cands)} through the app's pipeline…")
    tally = defaultdict(int)
    t0 = time.time()

    def vet(c):
        try:
            s = score(fetch(c["img"]))
        except Exception as exc:
            tally["fetch-failed"] += 1
            tally[f"err:{type(exc).__name__}"] += 1
            return None
        if s is None:
            tally["undecodable"] += 1
            return None
        ok = accept(s)
        tally["kept" if ok else "off-band"] += 1
        n = sum(tally[k] for k in ("kept", "off-band", "fetch-failed", "undecodable"))
        if n % 50 == 0:
            print(f"  {n}/{len(cands)} · kept {tally['kept']} · off-band "
                  f"{tally['off-band']} · failed {tally['fetch-failed']} · "
                  f"{n / max(1e-6, time.time() - t0):.1f}/s", flush=True)
        return {**c, **s, "q": quality(s)} if ok else None

    # 3 workers, not 6: Wikimedia 429s a greedy client and asks for courtesy.
    with ThreadPoolExecutor(max_workers=3) as pool:
        kept = [r for r in pool.map(vet, cands) if r]
    # Scores are expensive (one download + a full trace each). Keep them so
    # re-selecting with different thresholds costs nothing.
    json.dump(kept, open(VETTED, "w"))
    print("  tally:", dict(tally))
    if tally["fetch-failed"] > len(cands) * 0.15:
        print("  !! >15% of fetches failed — the list is not trustworthy; "
              "re-run before committing it.")

    kept.sort(key=lambda x: -x["q"])
    picked, per_artist = [], defaultdict(int)
    for k in kept:                                   # variety pass
        key = (k["artist"] or k["file"]).lower()[:40]
        if per_artist[key] >= PER_ARTIST:
            continue
        per_artist[key] += 1
        picked.append(k)
        if len(picked) >= TARGET:
            break

    picked.sort(key=lambda x: (x["artist"].lower(), x["title"].lower()))
    # Clean at the EMIT boundary as well as at ingest: the harvest cache may
    # predate a fix to the cleaner, and a stale cache must not be able to ship
    # "Esther Boardman title QS:P1476,en..." into the UI.
    payload = [{"t": strip_markup(p["title"])[:90] or "Untitled",
                "a": clean_artist(p["artist"])[:70],
                "d": strip_markup(p["date"])[:44],
                "img": p["img"], "w": p["w"], "h": p["h"]} for p in picked]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    faces = sum(1 for p in picked if p["faces"] >= 1)
    print(f"\nwrote {len(payload)} works → {OUT} "
          f"({os.path.getsize(OUT) / 1024:.0f} KB)")
    print(f"  {faces} with a detected face · {len(set(p['artist'] for p in picked))} artists")
    if picked:
        print(f"  density {min(p['density'] for p in picked):.3f}–"
              f"{max(p['density'] for p in picked):.3f} · "
              f"chains {min(p['chains'] for p in picked)}–"
              f"{max(p['chains'] for p in picked)}")


if __name__ == "__main__":
    main()
