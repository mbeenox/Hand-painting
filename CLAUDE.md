# CLAUDE.md — Hypnotic Hand

> **Read this first.** It is the single source of truth for what this app is, how
> it is built, how to run and deploy it, and every change made so far. If you are
> an AI assistant (or a human) picking this project up in a new session, start here.

## What it is

Hypnotic Hand is a web app: upload a photo (or snap one with the camera) → a
FastAPI backend turns it into a vector line drawing → a 3D, IK-driven hand
(React Three Fiber) draws it over ~30 seconds on top of randomized watercolor
splashes. Every run of the same photo produces a different drawing
(per-request entropy seeds the jitter and stroke order).

Two drawing **modes** (Style panel → Mode):
- **`trace` (default, "Portrait")** — traces the actual detected edge chains
  stroke-by-stroke; the hand LIFTS the pen between strokes. Faithful,
  recognizable line portraits.
- **`scribble` ("One-line")** — the original aesthetic: ONE continuous
  unbroken line from a TSP tour over sampled edge points. Abstract.

- **Live:** https://hand-painting-one.vercel.app
- **Repo:** https://github.com/mbeenox/Hand-painting
- One Vercel project serves **both** the static frontend and the Python API.

## Architecture (data flow)

```
Browser (React + R3F)         multipart POST /api/process-image      FastAPI (api/index.py)
  UploadPanel (file/camera) ────────────────────────────────────────▶  A. Canny edge detection
  WatercolorSplash (SVG)                                                B. trace: contour chains →
  Scene: usePathAnimation → penTip ◀── JSON {points,breaks,aspect} ──      order → smooth   (default)
         ├─ HandRig  (2-bone IK arm)                                       scribble: sample → jitter →
         └─ InkTrail (exact-append ribbon)                                 TSP → smooth
```

The backend returns one ordered list of `[x,y]` points plus `breaks` (the
index where each stroke starts; `[0]` = a single continuous line). The
frontend animates a pen along the path — flying it, lifted, over the segment
leading into each break — while the ink ribbon commits the exact path
vertices behind it and bridges pen-up hops invisibly.

## Stack & key files

- **Backend (deployed on Vercel):** `api/index.py` — FastAPI + numpy +
  opencv-python-headless **only** (SciPy/networkx ported out to fit the size cap).
- **Backend (local, full-featured):** `backend/main.py` — adds SciPy/networkx
  (cKDTree NN, splprep B-spline, optional christofides). Keep its tunables in
  lockstep with `api/index.py`.
- **Frontend:** Vite + React 18 + @react-three/fiber 8 + drei + three 0.169.
  - `frontend/src/App.jsx` — state machine `idle→processing→drawing→done`; `DRAW_SECONDS`.
  - `frontend/src/api.js` — downscales the upload to ≤1280 px JPEG, POSTs, returns `{points, aspect}`.
  - `frontend/src/components/Scene.jsx` — owns the per-frame clock; one shared `penTip` Vector3.
  - `frontend/src/hooks/usePathAnimation.js` — time→pen-position sampler + the pacing envelope.
  - `frontend/src/components/HandRig.jsx` — analytic two-bone IK arm + pen.
  - `frontend/src/components/InkTrail.jsx` — growing BufferGeometry polyline (the ink).
  - `frontend/src/components/WatercolorSplash.jsx` — randomized SVG background blobs.
  - `frontend/src/components/UploadPanel.jsx` — DOM UI overlay.

## Backend pipeline (`api/index.py`)

**Shared:** Input scale normalized in BOTH directions to `MAX_IMAGE_DIM`
(downscale large, upscale small — pixel-unit tunables mean the same thing for
every input). Edge detection — CLAHE **then** gentle bilateral
(sigmaColor 35), Canny auto-thresholded from the **gradient-magnitude
distribution** (hi = 92nd percentile of nonzero Sobel magnitudes,
lo = 0.45·hi), speckle removal via connected components. Do NOT go back to
intensity-median thresholds: they go blind on bright, washed-out photos
(white-on-white subjects) and whole regions vanish from the drawing.

**`mode=trace` (default):**
1. `trace_chains` — `cv2.findContours` on the edge map; out-and-back symmetry
   test (c[k] ≈ c[-k]) keeps only the outbound half of thin-filament boundary
   walks (closed rings kept whole); `approxPolyDP` simplification.
2. `order_chains` — greedy nearest-endpoint stroke ordering from a RANDOM
   start chain (per-run uniqueness), reversing chains when the tail is closer.
3. `smooth_chains` — Gaussian jitter (`TRACE_JITTER_PX`) + Chaikin ×2 per
   chain + arc-length resample, output budget ∝ chain length.
4. Response includes **`breaks`** — the index where each stroke starts; the
   frontend flies the pen (no ink) over the segment leading into each break.
   Runs in ~0.1 s. `TRACE_LEVELS` maps detail → (epsilon, min_chain,
   output_points, max_strokes).

**`mode=scribble`:**
1. **Sampling** — grid-hash Poisson-disk thinning; binary-search the radius,
   **aiming for the top of the range** (the old acceptance band stopped at the
   first count ≥ MIN_POINTS, which made the detail presets nearly identical).
2. **Jitter (before TSP)** — Gaussian σ, RNG from `os.urandom` → unique per run.
3. **TSP** — Nearest-Neighbor seed + time-boxed vectorized 2-opt.
4. **Smoothing** — Chaikin ×3 + arc-length resample to `OUTPUT_POINTS`.
   Runs in ~2–3 s.

Output normalized to [0,1], y-up, longest side = 1. Tunables live at the top
of `api/index.py`: `MAX_IMAGE_DIM=720`, `MIN_POINTS=500`, `MAX_POINTS=1300`,
`TWO_OPT_TIME_BUDGET=2.0`, `OUTPUT_POINTS=2800`, `TRACE_LEVELS`,
`TRACE_JITTER_PX=1.1`. Function `maxDuration` is 30 s.

## Local development

- **Backend:** `cd backend && pip install -r requirements.txt && uvicorn main:app --reload`.
  You can also run the Vercel port bare: `uvicorn api.index:app --reload` — routes
  are registered at **both** `/process-image` and `/api/process-image`.
- **Frontend:** `cd frontend && npm install && npm run dev` (Vite dev server).
- **Build:** `cd frontend && npm run build` → outputs to `public/` (what Vercel serves).

## Deploy (Vercel) — READ BEFORE TOUCHING requirements.txt OR vercel.json

One project builds the Vite app (`outputDirectory: public`) and deploys
`api/index.py` as a Python serverless function; `/api/(.*)` is rewritten to it.
Same origin in production, so CORS is moot.

Hard-won deployment facts (do **not** regress):

- **Function SIZE is the whole ballgame.** numpy (~70 MB) + opencv-headless
  (~140 MB) sit right at the edge. Vercel's **legacy** serverless path caps
  Python functions at ~225 MB (AWS's 250 MB minus the runtime layer) — the deps
  alone exceed it. The **modern (Fluid Compute)** path gives Python **500 MB**
  (up to 5 GB via large functions). We rely on two things to fit:
  1. `"fluid": true` in `vercel.json`.
  2. `excludeFiles` in `vercel.json` strips ~27 MB of never-used files from the
     bundle — `cv2/data` (Haar cascades), numpy test suites, and `*.pyi` stubs —
     which took the optimized bundle from 230.65 MB to ~204 MB, under 225 MB.
  - If a build ever fails again with **"exceeds the maximum function size"**, the
    definitive fix is to set the project env var **`VERCEL_SUPPORT_LARGE_FUNCTIONS=1`**
    (Vercel → Settings → Environment Variables), which unlocks the 5 GB
    large-functions limit and makes the size cap irrelevant.
- **Pin the deps.** `requirements.txt` is pinned (`fastapi==0.139.2`,
  `python-multipart==0.0.32`, `numpy==2.2.6`, `opencv-python-headless==4.11.0.86`).
  Open-ended `>=` ranges previously let OpenCV drift to 5.x and numpy to 2.5,
  growing the bundle past the cap. Bump deliberately and re-check bundle size.
- `.python-version` pins **3.12** (the wheels the pins were verified against).
- `backend/` is `.vercelignore`d; only `api/` + root `requirements.txt` ship to Vercel.

## How to verify a change (no full browser required)

- `python3 verify_moods.py` — mood consonance invariant (parses MOODS from
  the JS; every scale tone must sit well below semitone/tritone controls).
- `node frontend/scripts/verify_caption.mjs` — the writing hand: JHF parse
  against the vendored font, ASCII folding, block layout, caption-band
  geometry across box shapes, and the pathData contract `appendCaption`
  owes `usePathAnimation`/`InkTrail`. Pure Node, no bundler, ~0.2 s.
- `node frontend/scripts/verify_share.mjs` — share pages (5.4): id shape,
  30-day retention math, the media-URL and upload-pathname gates, meta
  sanitization (the privacy clamps), HTML escaping, rate limiting, and the
  rendered share/expired pages (OG tags, escaped user text, report+expiry
  lines). Needs `npm install` at the REPO ROOT first (@vercel/blob).

- **Backend:** in a venv with the pinned deps, feed a synthetic edge-rich image
  (draw lines/circles with cv2) through `detect_edges → sample_points →
  jitter_points → nearest_neighbor_path → two_opt → smooth_path → normalize`;
  assert the output is `(OUTPUT_POINTS, 2)`, finite, `aspect > 0`. Runs in ~2–3 s.
- **Frontend:** `cd frontend && npm run build` must succeed (catches JS/compile errors).
- **Full visual check:** deploy a preview branch on Vercel (or `npm run dev`) and draw.

## Revision history

- **Phase 5.4 — share pages (2026-08-01)** — the LAST planned feature:
  finished drawings get URLs. "Share ↗" opens a consent dialog; "Create
  link" uploads the composited still + video to Vercel Blob and mints
  `/s/<id>`, a server-rendered page with OG tags so the link unfurls as the
  drawing wherever it is pasted. Owner decisions (2026-08-01): 30-day
  retention · consent dialog required · ship on the vercel.app domain.
  (a) **A Node function beside the Python one.** `api/share.mjs` (runtime
  deps in the NEW ROOT `package.json`: `@vercel/blob` pinned 2.6.1) lives
  next to `api/index.py` — Vercel matches functions by filesystem path
  BEFORE rewrites, so `/api/share` hits the Node function while the
  `/api/(.*)` catch-all still sends everything else to Python. New rewrites
  put `/s/:sid` and `/api/share-cleanup` (daily cron in vercel.json) onto
  the share function via query params.
  (b) **Client uploads, not proxied uploads.** The media goes STRAIGHT from
  the browser to the Blob store using @vercel/blob's client-token protocol
  (`upload()` in the browser → token POST to `/api/share` → direct PUT).
  Vercel's request-body cap is 4.5 MB and a 58-second video can be triple
  that, so routing media through the function was never an option. The
  token handler only signs pathnames matching `shares/media/<key>-still.png
  |video.(mp4|webm)`, caps size at 15 MB, and allows only png/mp4/webm.
  There is deliberately no `onUploadCompleted` callback: the share record
  is created by an explicit `hh.create` POST from the client, so localhost
  works and nothing depends on a public callback URL.
  (c) **PRIVACY CONTRACT.** The source photo NEVER leaves the device — only
  the app's own composited outputs (still + video) plus sanitized style
  facts (`sanitizeMeta`: dedication ≤64 chars, paper allowlist, hex-checked
  paperBg, clamped numbers; unknown fields dropped; media URLs must be
  blob-store `shares/media/` HTTPS URLs). The consent dialog says exactly
  this; any new meta field must be re-reflected in that dialog's wording.
  (d) **Expiry is enforced at READ time, not just by the cron.** `/s/<id>`
  checks `createdAt` and answers 410 (plus a best-effort delete) after 30
  days, so links die on schedule even if the daily cleanup cron never
  fires; the cron (`0 8 * * *`, optional CRON_SECRET auth) just reclaims
  storage. IDs are 10-char base36 from webcrypto — a coprime-stride-grade
  "don't be clever" choice: unguessable enough for semi-private links.
  (e) **Degrades to exactly the pre-5.4 app.** No BLOB_READ_WRITE_TOKEN (or
  the vite dev server, which has no Node functions) → `/api/share?health=1`
  says not-configured → the dialog offers the old file-share path. Nothing
  new lands on the first paint: the @vercel/blob client is a lazy chunk
  (~96 KB) imported only inside "Create link".
  **Two hard-won findings:** a cleanup-only `aliveRef` in ShareDialog is
  React-18-StrictMode-BROKEN (dev double-mount runs the cleanup once and
  the ref stays false forever — the link arrived and the dialog silently
  never showed it; the effect body must re-arm the ref), and sync-Playwright
  `time.sleep()` blocks the event loop that runs `context.route` handlers,
  which made the stubbed share flow look hung and burned an hour of
  debugging on phantom bugs — pump with `wait_for_selector`, never sleep,
  when stubs must answer.
  **Deploy prerequisite (owner, one-time):** Vercel dashboard → Storage →
  Create Blob store → connect it to the project (injects
  BLOB_READ_WRITE_TOKEN), then redeploy. Until then the app behaves as
  before and the dialog says links aren't set up. Report-and-remove email
  in `api/share.mjs` (`REPORT_EMAIL`).
  Verified: `verify_share.mjs` (50 checks over the exported helpers), the
  other four gates, `npm run build`, and the full E2E with the token POST,
  blob PUT and create stubbed at the network seam — consent wording
  asserted, ZERO uploads before consent asserted, still+video+create
  traffic asserted, and the create payload checked for the dedication and
  the absence of anything photo-like.

- **Feature 4.2 — wooden mannequin hand: BUILT, SHIPPED, then REVERTED at the
  owner's request (2026-07-27 → 2026-07-29).** A code-authored wooden
  artist's-mannequin arm+hand replaced the procedural cylinder arm (commit
  `e16aea4`, reverted in `47b1e29`). It passed every technical gate — tip
  exactly on the line, no elbow flips, clean E2E — but the owner judged the
  LOOK worse than the original and asked for the old hand back. If 4.2 is
  ever attempted again: (a) recover the asset + dev harness (`armdev.html`,
  `shoot_arm.py`, `lib/mannequinArm.js`) from `e16aea4` rather than starting
  over — the IK/wrist/HAND_ROLL engineering was sound; the styling was the
  problem; (b) get the owner's sign-off on a RENDERED look before wiring it
  in — screenshots first, integration second.

- **Feature 4.3 — the two-photo duet (2026-07-26)** — the flagship: two
  portraits drawn side by side in alternation, in conversation, as one piece.
  Two parallel calls to the SAME endpoint (no backend change), welded by
  `lib/composeDuet.js` into a single path the rest of the app cannot tell
  from an ordinary one — `usePathAnimation` sees one path with more breaks,
  the gutter crossing is just a longer pen-up hop, and every export works
  unchanged.
  (a) **The panel is DERIVED, not carried.** The obvious design is a
  per-stroke `panel` array, but that array would then have to be sliced by
  `truncatePath`, extended by `appendCaption`, and kept in sync by every
  future transform — an invariant with no enforcement. Instead the
  composition publishes one number, `duet.splitX`, and `Scene` compares the
  PEN'S OWN X against it at note-on. It costs one comparison and cannot fall
  out of sync. Left portrait is bowed, right is struck — but only when the
  viewer's Instrument setting is the default "duet"; an explicit violin-only
  choice still wins.
  (b) **Interleave in RUNS, not stroke-by-stroke — measured, not guessed.**
  Alternating every stroke (560 of them) sent the composed path length from
  ~55 to **388**: the pen spent most of the performance flying across the
  gutter, which wrecked the pacing and skewed the Completeness dial toward
  travel. Proportional runs (~44 crossings total) bring it to ~101, and read
  better anyway — a person works one portrait for a few strokes, then the
  other, and the music trades phrases instead of alternating notes. A
  `MIN_ROUNDS` floor exists because a sparse pair otherwise collapses to
  "draw all of A, then all of B", which truncation would then cut into one
  finished portrait and one never started.
  (c) **Panels share a HEIGHT, not a width**, so two different aspect ratios
  read as a pair; and each panel is traced one notch COARSER
  (`DUET_DETAIL`). That second point is a correctness rule, not taste: two
  `dense` panels plus a written caption need ~25.8k ribbon centers, and
  `InkTrail` went 22000 → **26000** with the notch-down keeping the worst
  reachable case at ~20.2k.
  (d) The 5.2 ghost reveal now renders ONE PLANE PER PANEL, each photo under
  its own portrait (verified by sampling the canvas alpha in each half
  independently: left 2.8×, right 2.4×).
  **Rejected after measuring:** making `truncatePath` count ink only instead
  of ink+travel. It is more principled — pen-up travel is 28–33% of a single
  photo's path and ~50% of a duet's, so the dial is not measuring what it
  claims — but it moves the cut by 23–43% at the SAME dial label, silently
  redefining every stored Completeness setting and breaking the "100% = the
  classic drawing" anchoring baseFrac was calibrated against. Left alone,
  with the measurements recorded in the file so the next person does not
  rediscover it the hard way.
  Verified: `verify_duet.mjs` (composition contract, gutter separation,
  splitX classifying every stroke, truncation keeping both portraits within
  a few points of each other), the other three gates, `npm run build`, a
  rendered side-by-side, and a full E2E asserting TWO traces per duet at a
  stepped-down detail — zero console errors.

- **Phase 5.3 — Today's masterpiece (2026-07-25)** — the idle screen offers
  one public-domain artwork a day, the same one for everyone on that date,
  one click from a drawing. `lib/masterpiece.js` + a curated
  `frontend/public/masterpieces.json` + a chip in `UploadPanel`.
  (a) **The images do NOT come from the Met's API, and that is not a
  shortcut.** `images.metmuseum.org` sends no `Access-Control-Allow-Origin`
  (measured, not assumed), which breaks the feature twice: `fetch(url).blob()`
  is refused outright, AND — worse — feeding such an image to the WebGL
  canvas (which the 5.2 ghost reveal does) TAINTS it, and a tainted canvas
  makes `toDataURL`/`captureStream` throw, silently killing PNG, video and
  GIF export for everyone. Wikimedia Commons serves
  `Access-Control-Allow-Origin: *` and hosts the Met's own Open Access
  donation, so the same artworks arrive from a host the browser will talk to,
  with no backend proxy and no new SSRF surface. `verify_masterpiece.mjs`
  asserts every URL is a Wikimedia one, precisely so this cannot regress.
  (b) **The daily pick is a coprime stride, not a hash.** Hashing the date is
  the obvious approach and was the first cut, but a hash is only uniform in
  the limit: with 200 works there is a 1-in-200 chance any day repeats the
  one before it (~1-in-3 across a year). Walking the list in a stride
  coprime with its length is a bijection — every work comes up exactly once
  before any repeats — and the stride is ~0.618·n so consecutive days land
  far apart rather than marching through one artist's block. Still a pure
  function of the date, so everyone still shares the day's artwork.
  `dayKey` is LOCAL, not UTC: "today's masterpiece" should mean *your* today.
  (c) **Curation is committed** (`scripts/curate_masterpieces.py`) and vets
  every candidate through THIS APP'S OWN pipeline — `detect_edges`,
  `trace_chains`, and the same Haar cascade the camera uses — against a band
  calibrated on the two bundled samples (astronaut: density 0.042, 212
  chains; pearl: 0.059, 464). Metadata alone is a weak proxy for "draws
  beautifully".
  **What only rendering the output could reveal:** the first list scored well
  on every number and was still wrong. Commons photographs of museum works
  often include the PICTURE FRAME, so one daily pick drew a large ornate
  rectangle with a thumbnail-sized sitter inside. Fixed with two measured
  discriminators — long axis-aligned runs near the margins (Hough:
  known-good 0, framed 1–3) and outer-ring-to-core ink ratio (known-good
  0.43–0.62, bordered 1.44). The second pass then surfaced portrait
  MINIATURES (locket-sized watercolours photographed in decorative oval
  mounts) which pass every numeric test because a mount is not a straight
  frame; excluded by name from the Commons description/category/filename.
  A third pass surfaced decorative objects with no description at all (a
  "Nun's Badge") — caught by whole-word filename matching. Vetted scores are
  cached (`.masterpiece-vetted.json`) so re-selection is free.
  (d) **It can never block the core flow**: the list is fetched lazily after
  first paint, the day's pick is cached in localStorage (a returning visitor
  costs zero network), and EVERY failure path returns null so the chip is
  simply absent. Credit line per the Met's Open Access terms.
  Verified: `verify_masterpiece.mjs` (determinism, full-cycle coverage,
  consecutive-day spread, list shape, CORS host, artist spread) plus the E2E
  clicking the chip through to a drawing with the Wikimedia request stubbed
  — this sandbox's headless Chromium cannot reach external hosts, and that is
  the right seam anyway: what needs testing is our chip → fetch → blob →
  onImage path, not Wikimedia's uptime.

- **Phase 5.2 — reveal, replay & friction (2026-07-25)** — the four small
  items from `docs/PLAN.md`, shipped together.
  (a) **Ghost reveal.** On `done` the SOURCE PHOTO breathes in under the ink,
  holds, and fades — "look what it caught". Built as a textured plane INSIDE
  the R3F scene (`components/GhostReveal.jsx`), not a DOM overlay, and that
  choice does two jobs: registration is free (the plane sits at the drawing's
  exact world rect via the same normalized→world map `usePathAnimation`
  uses, so it lands under its own line art at any aspect ratio — including
  the shrunken, pushed-up rect a written caption leaves), and every export
  gets it free (`useDrawCapture` composites the WebGL canvas as one layer, so
  it is in the video and GIF with zero compositing changes). z = 0.004, just
  behind INK_Z; the hand still occludes it. `caption.js` now emits
  `drawingBox` and exports `drawingBox(data)`, which falls back to the full
  declared box when there is no caption.
  **Two calibrations, both from looking at output:** 12% opacity (the
  specced number) is INVISIBLE — a photo over pale paper only registers where
  it is dark, so a light or low-contrast source shows nothing; 0.26 is where
  the form reads without washing the paper out. And the cycle
  (0.4s in / 1.0s hold / 0.7s out = 2.1s) is deliberately shorter than the
  2.6s the capture keeps running after `done`, so the reveal is INSIDE the
  recording and gone again before `snapshotPNG()` takes the clean still.
  (b) **Instant replay.** "Replay ⏩" re-runs the identical pathData at 4×
  (`REPLAY_SPEED`, floored at 4s). Bumping `replayId` — part of the Canvas
  key — remounts the Canvas, which is what resets InkTrail's append-only
  buffer; pathData is untouched, so strokes, order and melody are identical.
  `phase` stays `'done'` throughout, which is what keeps the recorder from
  re-arming, the gallery from double-saving (also guarded per runId) and the
  video/GIF blobs intact. `active` and the music effect became
  `phase === 'drawing' || replaying`; a replay gets its own closing chime.
  Save-image is unaffected mid-replay because `downloadImage` prefers the
  already-captured `stillBlob`.
  (c) **Redraw.** The source blob + its opts are kept in a ref; "Redraw ↻"
  re-runs the WHOLE pipeline → new stroke order, new melody, new drawing.
  (d) **Drag & drop** on the idle overlay, feeding the existing onImage path.
  The load-bearing part is the WINDOW-level `dragover`/`drop` preventDefault:
  without it a photo dropped outside the dropzone makes the browser NAVIGATE
  to it, discarding a drawing in progress. UploadPanel renders null while
  drawing but stays mounted, so the guard covers every phase.
  Source object URLs are owned explicitly (`sourceUrlRef`), revoked on
  replace and on unmount.
  **Testing lesson worth keeping:** the first ghost assertion used two
  `page.screenshot()` calls around the reveal and kept reporting a diff of
  exactly 0.0 — a CDP round trip plus a 1280×800 PNG encode repeatedly landed
  AFTER the ~2s window, so the test failed a feature that was working (proved
  by reading the canvas directly: mean alpha 42 vs 21). The E2E now samples
  the WebGL canvas IN THE PAGE every ~80ms into an 80×50 scratch canvas and
  tracks mean alpha — cheap, race-free, and it measures the very buffer the
  exports composite, so a pass also means the reveal is in the video/GIF.
  Verified: peak 39.5 vs settled 16.8, faded by 2.4s; replay 12.3s vs a ~42s
  draw with the video href and gallery count unchanged; drag & drop and
  redraw both reaching drawings; zero console errors.

- **Phase 5.1 — "the hand writes": dedications & signature (2026-07-25)** —
  the app becomes a gift-maker: the pen that drew Mom also writes "Happy
  birthday, Mom" underneath, stroke by stroke, playing its notes, and every
  export carries it. Entirely client-side; no backend change.
  (a) **Font.** Hershey occidental Roman Simplex vendored VERBATIM at
  `frontend/src/lib/fonts/futural.jhf` (96 glyphs, ASCII 32–127, 3.4 KB;
  byte-identical to the NBS-named `rowmans.jhf`). `lib/hershey.js` parses
  the fixed-column JHF records (5 = glyph no., 3 = vertex count INCLUDING
  the leading bearing pair, then 'R'-biased coordinate pairs; `" R"` = pen
  up), derives metrics from 'H' rather than hardcoding them, folds arbitrary
  user text to the ASCII the font covers (NFD + combining-mark strip, so
  José → Jose; a small smart-punctuation table; emoji/CJK dropped and the
  resulting double spaces collapsed), lays out and word-wraps blocks, and
  loads the font through a DYNAMIC import so it ships as its own lazy
  ~3.5 KB chunk. Licence acknowledgements ride along in
  `fonts/HERSHEY-LICENSE.txt` + README (required by the distribution).
  (b) **`handwrite()` — the non-obvious half.** Committing Hershey outlines
  straight to the ribbon renders BROKEN letters: a stem is 2 mathematically
  straight points, so `usePathAnimation` measures ZERO curvature, the pen
  sweeps at full cruise and `InkTrail` lays its thinnest hairline — and
  every stroke tapers in over its first `TAPER_N` (8) vertices while `s.w`
  lerps up from `MIN_HALF`, so a 2-vertex stem is nothing but ramp.
  Verified visually: "Happy birthday, Mom" came out missing the stems of
  H, b, t, d. The fix is to give letters exactly what the backend gives a
  traced edge chain — subdivide (~6 per cap height), jitter (3.5% of cap
  height, endpoints pinned so letter parts still meet), Chaikin ×2 — because
  a letter and an eyebrow ARE the same kind of object. Every vertex then
  carries real curvature, the pen slows and presses as it does on the
  portrait, and strokes are long enough to survive the taper. Bonus: the
  writing looks hand-made rather than plotted. Vertex cost is budgeted
  (`INK_BUDGET`), and `Scene`'s `InkTrail maxPoints` went **16000 → 22000**
  to keep the don't-regress inequality true with a caption attached
  (dense@span2 ~9.6k + caption ~4.4k + 2 bridges/stroke + 1 ≈ 15.8k).
  (c) **`lib/caption.js` — composition.** The band is added to the drawing's
  box and the WHOLE composition is re-normalized so the longest side is 1
  again (the backend's own contract), then a new `aspect` is emitted. So the
  portrait makes ROOM for the words (keeping ~73–80% of the frame height)
  instead of the writing hanging off the bottom of the camera's view, which
  is what a fixed `BOARD_SIZE` of 8 would have done — the board is exactly
  the visible height (8 vs the camera's 8.007 units). Dedication centred at
  4.5% cap height (fit ladder: 1 line → 2 lines → 86% → 74% → 3 lines →
  62%, first size that swallows the text whole wins); optional signature
  `hypnotic hand - <ISO date>` right-aligned at 3.0%. `pathLength` is
  recomputed, so adaptive duration and the music follow the composition.
  (d) **Applied AFTER `truncatePath`** — a dedication is a promise, not a
  level of detail: at 40% Completeness the portrait is a gestural sketch and
  the message is still written in full.
  (e) **UI.** Dedication field + "Sign & date it" on the idle screen (48-char
  cap). The dedication lives in component state ON PURPOSE (it belongs to
  the gift, not the person — survives "draw another", never the tab);
  `settings.signDate` persists like any preference. Touching either control
  warms the font chunk. Gallery meta records the dedication and the wall
  leads with it in quotes.
  **Two sizing traps, both found by looking at rendered output:** the
  signature at 2.1% cap height CLOGGED shut ("hand" → "hond") because the
  nib width is ABSOLUTE while the letters shrink — raised to 3.0%; and a
  right-aligned signature at a 3% bottom margin lands ON the export
  watermark (`composite()` stamps the lowest ~4.2% of the canvas bottom-
  right), so `BOTTOM_PAD` is **0.065** and must stay above ~0.055.
  Music: letter strokes are short and sit at the bottom of the board, so
  they read as low tonic piano taps under the portrait's melody — the plan's
  "no special-casing" holds and it lands as a natural coda.
  Verified: `node frontend/scripts/verify_caption.mjs` (font parse, folding,
  layout, band geometry across box shapes, and the appendCaption contract —
  normalized box, ascending breaks, caption strictly below the drawing,
  exact object-identity no-op when there's nothing to write, ink-buffer
  arithmetic); `npm run build` (font emitted as `futural-*.js`, main chunk
  +0.8 KB); full E2E green with zero console errors, asserting the lazy
  single font fetch, `signDate` persistence, the dedication in gallery meta,
  and ~4.6k caption ink pixels in the exported PNG's writing band while the
  watermark assertion still passes; screenshots confirm the pen tip lands
  exactly on the letters mid-signature.

- **v1** — initial single-file prototype (uploaded).
- **v2 (2026-07-21)** — split into `backend/` (full, SciPy) + `api/` (Vercel port
  with SciPy replaced by numpy: brute-force NN, Chaikin smoothing) + a Vite/R3F
  frontend. Verified end-to-end with headless Chromium.
- **Deploy fix (2026-07-22)** — production build failed: bundle 270 MB > 225 MB
  legacy cap. Diagnosed as the legacy size-limit path. Pinned deps (270 → 230 MB),
  added `"fluid": true`, and added `excludeFiles` to strip `cv2/data` + numpy
  tests + `*.pyi` (→ ~204 MB). Added `.python-version=3.12`. Deploy succeeds.
- **Drawing fix (2026-07-22)** — the draw felt too short and "unfinished": the
  symmetric smootherstep pacing put the pen at 99% of the path by 90% of the
  time, so the last stretch crept to a near-stop and looked stalled. Replaced it
  with an asymmetric trapezoid pace (gentle-in → cruise → short decisive-out) in
  `usePathAnimation.js`; raised `DRAW_SECONDS` 20 → 30; densified the ink
  (`MIN_STEP` 0.004 → 0.0025) and uncapped the buffer (`InkTrail maxPoints`
  6000 → 16000) so long / high-refresh draws never truncate. Backend detail bump
  for a fuller line: `MAX_POINTS` 1000 → 1300, `OUTPUT_POINTS` 2200 → 2800,
  `MAX_IMAGE_DIM` 640 → 720, 2-opt budget 1.2 → 2.0 s (pipeline ~2.6 s).

- **Feature #1 — shareable export + recording (2026-07-22)** — the draw is now
  captured and offered on the done screen as **Save image** (PNG), **Save video**
  (webm/mp4 of the whole draw), and **Share** (Web Share API, falls back to
  download). New `hooks/useDrawCapture.js` composites paper + the rasterized
  splash `<svg>` + the WebGL canvas (`preserveDrawingBuffer` now on); recording
  runs on a capped 960px/24fps compositing canvas so it can't jank the
  time-based draw. Graceful fallbacks where `MediaRecorder`/Web Share are absent.

- **Feature #2 — polish (2026-07-22)** — the processing wait now shows a
  self-drawing spinner ("Tracing your portrait…"); the watercolor splashes fade
  in on reveal; and optional, fully synthesized audio (Web Audio, no asset
  files) adds a pen-scratch whose volume tracks pen speed plus a soft completion
  chime — off by default behind a 🔇/🔊 toggle, started inside the gesture to
  respect autoplay. New `hooks/useDrawSound.js`; `Scene.jsx` publishes pen speed
  via a ref; keyframes in `index.html`; honors `prefers-reduced-motion`.

- **Feature #3 — variable-width ink (2026-07-22)** — replaced the uniform GL
  hairline with a hand-rolled triangle-strip **ribbon** the pen extrudes as it
  moves: half-width tracks pen speed, normalized adaptively against the fastest
  sweep so far so the full thin→bold range always shows (near-stopped pen and
  curves → bold; fast straights → hairline), with a tapered nib start. Keeps the
  append-only discipline — one preallocated buffer, static prefilled indices,
  incremental `drawRange` growth, no per-frame rebuilds. `InkTrail.jsx` rewritten;
  `Scene.jsx` feeds it `speedRef`. Tuning constants (MIN_HALF/MAX_HALF/…) sit at
  the top of `InkTrail.jsx`; verified against a rendered preview of the exact math.

- **Completeness ceiling raised to 200% (2026-07-24)** — the dial now runs
  30–200%; 100% still means the classic full drawing, 200% is "everything
  the pen can find". Mechanics:
  (a) **`span=2` tier** (both backends; trace mode always requests it):
  Canny sensitivity P92 → **P85** (the chain-length filter alone finds
  almost nothing new on clean photos — the EDGE MAP is the detail
  ceiling), min_chain ×0.6, output_points ×2, max_strokes ×2.
  (b) **`baseFrac` anchor**: the base (P92) edge map is ALSO computed; a
  chain is base-eligible iff ≥55% of samples ALONG it (every ~3px — polyDP
  vertices alone are too sparse) land on the 1px-dilated base map AND it
  passes the base length filter, capped at the base stroke count.
  baseFrac = eligible ink / total ink, returned in the response.
  (c) **Client mapping** (`truncatePath`): label L ≤ 1 → cut at L·baseFrac;
  L > 1 → baseFrac + (L−1)(1−baseFrac), i.e. 100–200% walks linearly into
  the extra detail and 200% always uses the full dial travel even when a
  photo's real ceiling is lower (sparse astronaut: ×1.19 ink; busy pearl:
  ×1.52, 440 strokes). Scribble/span-1 has baseFrac=1 → labels >100%
  are a no-op, stored settings keep their meaning (no migration).
  (d) AUTO_MAX_S 42 → **58** so maxed-out drawings don't rush.
  Calibration verified: 100%-label ink within 4–14% of the span-1 drawing
  on both samples; monotone node tests; full E2E green (GIF grew to
  ~7 MB with the longer default draw — still under the 15 MB spec).
  Watch-out: the 4-stroke toy test showed boundary snapping can make
  adjacent labels identical — real drawings (200+ strokes) are fine.

- **Completeness dial + artist-pass stroke ordering (2026-07-24)** — the
  app never "decided" when to stop: it always drew 100% of a path fixed at
  processing time (Canny → min_chain/max_strokes culling → point budget).
  Now the user decides.
  (a) **`order_chains_in_passes`** (both backends): chains sorted longest-
  first into cumulative-length tiers (~50% / ~85% / rest), greedy nearest-
  endpoint travel WITH random start kept WITHIN each pass. Result: strokes
  arrive contours → structure → details, so ANY PREFIX is a coherent
  sketch (measured on pearl: first 25% of strokes carry 59% of the ink);
  per-run uniqueness preserved. This changes the choreography at 100% too —
  the hand now blocks in big shapes first, like an artist.
  (b) **`lib/truncatePath.js`** — client-side cut at STROKE BOUNDARIES by
  path-length fraction (an artist finishes the stroke they started; always
  keeps at least stroke 1). Applied once per run in `App.handleImage`
  (like detail/mode); recomputes pathLength so ADAPTIVE DURATION and the
  music shorten with it. `settings.completeness` (0.3–1.0, default 1),
  "Completeness · N%" slider in the Style panel; gallery meta records it.
  Rendered check: 40% = gestural sketch · 70% = confident study · 100% =
  full texture (40% arguably the most elegant — short-stroke speckle noise
  only appears near 100%).
  E2E: slider present w/ default 100%; set to 50% via native-setter +
  input event (React-controlled range) before the noir sample draw.
  Unit: node test of truncatePath (identity at 1.0, boundary cuts,
  min-one-stroke); python check of pass front-loading.

- **Camera upgrades: back-camera flip + face focus (2026-07-24)** —
  (a) **Flip.** `UploadPanel` camera gains facing state ('user'/'environment')
  and a Flip button shown ONLY when `enumerateDevices` reports >1 videoinput
  (checked right after permission grant, when labels are real). facingMode
  is passed as a preference (single-camera laptops keep working). Selfie
  PREVIEW mirrors (scaleX(-1)) like every camera app; the saved snap stays
  un-mirrored.
  (b) **Face focus.** Camera snaps call the backend with `focus=face`:
  `face_focus()` (both backends, lockstep) detects frontal faces (Haar,
  minNeighbors 6, minSize 10% of short side), builds a feathered keep-mask —
  HEAD ellipse (1.6×/2.1× the Haar box: hair + chin ARE the portrait) plus a
  BUST ellipse below (a portrait is head AND shoulders, not a floating
  head) — then composites a portrait-mode background (Gaussian σ≈0.8% of
  long side + 18% contrast fade toward grey) outside the mask BEFORE edge
  detection. CRITICAL SECOND STEP: `edges[mask < 0.22] = 0` after Canny —
  the gradient-percentile thresholds adapt to the mostly-blurred image and
  RE-SENSITIZE, so blur alone leaks ghost blobs into the trace.
  No face → clean no-op. Response gains `facesFocused`.
  **Deploy detail:** the cascade XML (~0.9 MB) is BUNDLED AT `api/
  haarcascade_frontalface_default.xml` because Vercel's excludeFiles strips
  `**/cv2/data/**` — `cv2.data.haarcascades` is EMPTY in production; never
  load from it in `api/index.py`. `backend/main.py` prefers the repo copy,
  falls back to cv2.data locally.
  Measured on the astronaut sample (busy flag background): face-region
  share of output points 17.5% → 61.6% at the same point budget; rendered
  side-by-side confirms rich face + kept shoulders + flag as whispers.
  E2E: getUserMedia mocked with a canvas stream OF THE ASTRONAUT (this
  Chromium registers no fake devices — --use-fake-device-for-media-capture
  is a no-op here), so the test exercises REAL face detection: Flip button
  appears (2 mock cams) and works, snap URL carries focus=face, response
  asserts facesFocused == 1, drawing starts.

- **Paper stocks: canvas colour done the printmaker's way (2026-07-24)** —
  `lib/papers.js` defines four curated PAPER STOCKS instead of a free
  colour picker (mid-value paper + mid-value ink = mud; value contrast is
  what makes line work read). Each stock = ground colour + 5 contrast-safe
  inks (first = house ink) + splash pigment pairs + watermark colour + UI
  text/overlay tints:
  · **Ivory** (default) — the original; classic drawing inks, pastels.
  · **Noir** — warm charcoal-black `#131316` (NEVER pure #000 — dead
    screen, kills pooling nuance); chalk/gold/vermilion/celadon/rose
    body-colour; deep JEWEL splash tones (pastels on black look
    chalk-dusty). White-chalk-on-black-paper tradition.
  · **Kraft** — packing-paper tan; carbon + white gouache + oxide/indigo/
    hooker; gouache earth splashes. Classic sketchbook combo.
  · **Slate** — Prussian cyanotype; blueprint-white + pale cyan/chamois/
    coral/mint; TONAL Prussian washes only (a cyanotype stays monochrome —
    that restraint IS the look).
  Wiring: `settings.paper` ('ivory' default) → App root bg, splash
  `palettes` prop, `useDrawCapture(paper.bg, paper.watermark)` (exports +
  watermark adapt), UploadPanel/GalleryWall overlay+text tints, gallery
  meta gains `paper`. ControlsPanel: Paper chip row + per-paper ink
  swatches; **switching paper keeps the ink ONLY if it belongs to the new
  stock's palette, else the house ink takes over** (contrast invariant).
  PRESETS became complete looks (paper+ink+line+wash): Fine liner ·
  Bold ink · Sketch (now kraft) · **Chalk noir** · **Blueprint**.
  E2E: selects Noir before the sample draw, asserts paper + ink
  auto-switch in localStorage; screenshot verified chalk-on-black with
  jewel splashes. Note: pen barrel (#1a1a2e) is low-contrast on noir but
  reads fine (lit StandardMaterial + gold ferrule + skin hand).

- **Sound defaults flip + Phase 4.1 ink-bleed shader (2026-07-24)** —
  (a) **Sound ON by default, pen scratch OFF by default.** `settings.sound`
  (persisted; the 🔊 toggle writes it) initializes `soundOn`; the
  AudioContext still only starts inside a user gesture — `handleImage`
  calls `setSoundEnabled(true)` inside the upload/sample/camera CLICK that
  begins every draw, so autoplay policy is satisfied on the natural flow.
  `settings.scratch` default false; scratch tick now requires `=== true`.
  ONE-TIME v2 settings migration in `loadSettings` (`_v` field): pre-v2
  stores get scratch:false + sound:true (their old values were just the
  persisted old defaults); everything the user chose is kept. E2E asserts
  the toggle reads "Mute sound" on load and scratch defaults off.
  (b) **Ink-bleed (4.1)** — `InkTrail` ribbon gains TWO extra attributes:
  `aCross` (edge parity ±1 — STATIC, prefilled like the index buffer) and
  `aWidth` (committed half-width — written exactly where positions are
  written, same append-only discipline). `MeshBasicMaterial` → inline
  `ShaderMaterial`: edge threshold displaced by WORLD-SPACE 3-octave value
  fbm (bleed sticks to the paper, not the stroke), faint wick zone gated by
  finer grain, slight darkening at |cross|≈0.6 (nib-shoulder pooling),
  transparent + depthWrite:false (single flat mesh; overlaps blend like wet
  ink). KEY TUNING LESSON: bleed must scale with WETNESS —
  `wet = aWidth/uMaxHalf`, raggedness ∝ mix(0.35, 1, wet) — the first cut
  applied full raggedness to hairlines and fragmented them into dashes.
  Boldness raises both uBleed and uMaxHalf. `USE_BLEED=false` falls back to
  the flat material (mobile escape hatch). Exports match the screen by
  construction (same WebGL canvas). Verified: build + full E2E green
  (video+audio, watermark, GIF, gallery, Dusk mood), zoomed before/after
  screenshot comparison.

- **Phase 3 — "Musical depth": keys & moods (2026-07-24)** — the music
  gains four selectable MOODS (`useDrawSound.js` MOODS table; Style panel
  "Mood" row; `settings.mood`, default dawn). Each mood is a complete
  identity: melody scale + base register, drone chord + drone colour
  (level/lowpass), bow-brightness range (filterBase/filterSpan), vibrato
  depth & rate, duet split bias, and a chime built from its own scale:
  · **Dawn** — C maj pentatonic over C2+G2+C3 (the original, bright).
  · **Dusk** — A min pentatonic (base A3) over A1+E2+A2; darker bow (cap
    ~2100 Hz vs ~3500), deeper vibrato ×1.45.
  · **Sakura** — D hirajoshi (D E♭ G A B♭, base D4) over an OPEN-FIFTH
    D2+A2 drone (leaves ♭2/♭6 as colour, no third to fight); piano-biased
    duet split 0.8s; chime = open fifths D5-A5-D6 (no ♭2).
  · **Hymn** — F Lydian subset (F G A C E, base F3 — solemn low register)
    over F1+C2+F2; violin-biased split 0.35s; vibrato rate ×0.7.
  Mood is PINNED at startMusic (m.mood) so a run stays coherent; voices
  carry their mood for the per-frame expression tick. The consonance
  invariant ("random strokes can't clash") is enforced by **verify_moods.py**:
  it PARSES the MOODS table from the JS source (nothing to drift), models
  the synth's actual spectra (saw partials behind the rest-bow lowpass;
  triangle odd partials behind the drone lowpass, real gain levels), scores
  every scale tone against the drone chord with Plomp–Levelt/Sethares
  roughness, and requires the worst tone < 0.6× the ugliest sane control
  (semitone/tritone against the root in the drone's own register). Result:
  worst tones sit 4–15× below controls in all four moods. E2E now draws in
  Dusk (non-default) so the parameterized drone/scale/chime paths run.
  Keep the MOODS field layout machine-readable (one base:/scale:/drone:/
  droneLP: line per mood) or the verifier's parser breaks.

- **Phase 2 — "Return visits" (2026-07-24)** — both M features from
  `docs/PLAN.md`:
  (a) **Gallery wall (2.1)** — every finished drawing saves a ≤256px JPEG
  thumbnail (dataURL, ~30–50 KB) + `{date, mode, detail, instrument,
  seconds, strokes}` to `localStorage["hh-gallery-v1"]` (newest-first, FIFO
  cap 24 ≈ 1.5 MB; every touch in try/catch). New `hooks/useGallery.js` +
  `components/GalleryWall.jsx` (grid overlay → large view with Save
  image / Delete; Clear-all with confirm). Idle screen shows "Gallery · N"
  top-right once N > 0. Save guarded per runId so re-renders can't
  double-add. Thumbnails only, nothing leaves the device.
  (b) **GIF export (2.2)** — `useDrawCapture.start()` taps the SAME
  compositing canvas as the video every ≥100 ms into a 480px canvas
  (`willReadFrequently`), posts each RGBA buffer (transferable) to
  `workers/gifWorker.js`, which palettizes (gifenc, 128 colours quantized
  from frame 1 — paper+splash are laid down before the pen moves, so the
  palette is stable) and appends incrementally — flat memory, encoder never
  on the main thread. Finalized in `recorder.onstop` → "Save GIF ↓" beside
  Save video. Measured: 33s draw → 4.6 MB looping GIF89a (spec ≤15 MB ✓),
  watermark carried (same composite). No Worker / worker error → button
  simply never appears; video unaffected. +`gifenc` dep; worker is its own
  lazy chunk (nothing new on the first-paint critical path).
  E2E: GIF89a header + NETSCAPE2.0 loop + size assertions; gallery entry
  count/thumb/meta asserted post-draw; gallery overlay opened, shot, closed.
  Gotcha found: Vite dev re-optimizing a NEWLY installed dep mid-run
  reloads the page and kills a draw — first E2E after `npm install <dep>`
  may need one warm-up run.

- **Phase 1 — "Complete the loop" (2026-07-24)** — three S features from
  `docs/PLAN.md`, shipped together:
  (a) **Try-a-sample (1.1)** — two license-safe portraits bundled in
  `frontend/public/samples/` (NASA official portrait of Mae Jemison
  s87-45893, public domain; Vermeer's *Girl with a Pearl Earring*, public
  domain via Wikimedia Commons), 720px JPEG ≈ 136 KB total. Idle screen adds
  "…or watch a sample" chips → same-origin fetch → blob → the existing
  `onImage` path. Cold visitor reaches a live drawing in one click.
  (b) **Export watermark (1.2)** — `useDrawCapture.composite()` (the one
  path every export flows through) draws `drawn & composed at
  hand-painting-one.vercel.app` bottom-right, Georgia italic, 2.2% of canvas
  height, ink-blue @45%. On-screen canvas untouched; PNG + video both carry it.
  (c) **Adaptive draw duration (1.3)** — `autoDrawSeconds(pathLength)` =
  clamp(round(len/1.6 u/s), 20, 42) in `App.jsx`; `settings.autoTime`
  (default ON) + Auto/Manual toggle on the Draw-time row (slider disabled
  while auto). Measured: synthetic test 52u→33s, astronaut 39u→24s,
  pearl 44u→27s. E2E updated: sample-chip presence + one-click sample→drawing,
  watermark pixel assertion on the downloaded PNG, timings for ~33s draws.

- **iPhone-playable video (2026-07-23)** — saved videos now prefer MP4
  (H.264+AAC): .webm shared to an iPhone often won't play (partial Safari
  WebM support; Photos/iMessage reject it). `VIDEO_MIMES` order: explicit
  `avc1+mp4a` strings first (branded Chrome/Edge 126+), webm+opus next
  (Firefox / codec-less Chromium — those builds accept a BARE 'video/mp4'
  but mux Opus into it with no AAC encoder → still iPhone-broken, hence
  bare mp4 LAST; Safari lands there and records H.264+AAC regardless).
  Blob type/ext from `recorder.mimeType`. E2E asserts the
  container-appropriate audio box (mp4a/Opus vs OpusHead) — this assertion
  is what caught the codec-less-mp4 trap. DON'T-REGRESS: never put bare
  'video/mp4' ahead of the webm+opus candidates.

- **Pen-scratch toggle (2026-07-23)** — `settings.scratch` (default on) +
  a "Pen scratch" On/Off row in the Style panel; the scratch gain loop reads
  it live via `settingsRef` each frame (instant mid-draw response). Music
  and chime unaffected.

- **Feature #7 — piano voice + duet (2026-07-23)** — second instrument:
  synthesized piano (partial stack 1/2.003/3.007 with hammer attack and
  pitch-scaled exponential decay, self-terminating — no note-off needed).
  Default **Duet** mode lets each stroke pick its instrument by estimated
  draw time (`usePathAnimation` exposes per-vertex `strokeEnd`; Scene passes
  `estDur` at note-on): strokes ≥ `DUET_SPLIT_S` (0.5s) are bowed, shorter
  flicks are struck. Style panel gains an **Instrument** row
  (Duet/Violin/Piano) stored in settings (`instrument`), threaded via a
  stable `handleNoteOn` wrapper reading `settingsRef`. `stopMusic` also
  silences ringing pianos (MAX_PIANOS 24 cap). E2E re-verified (duet
  default): zero console errors, OpusHead present in recorded video.

- **Feature #6b — audio in the saved video (2026-07-23)** — `useDrawSound`
  now routes every source through a master GainNode and exposes
  `getAudioStream()` (a `MediaStreamDestination` tap of that bus);
  `useDrawCapture.start()` adds its audio track to the canvas stream and the
  mime list prefers `vp9,opus`/`vp8,opus` (Safari mp4 → AAC). The track is
  attached at record start even with sound off — a context created without a
  gesture stays suspended and records silence; the 🔊 tap (a gesture)
  resumes it and the SAME track carries the mix mid-recording. E2E now
  fetches the recorded blob and asserts an "OpusHead" init segment exists.

- **Feature #6 — stroke violin: the drawing plays itself (2026-07-23)** —
  with sound on, every stroke is a bowed note: pen lands → note-on, lifts →
  release. What keeps random strokes musical: pitch = stroke height QUANTIZED
  to C-major pentatonic over 2 octaves (can't clash); duration = stroke draw
  time (sub-90ms strokes fold into the ringing note); **vibrato = line
  curvature** at the pen; bow pressure (lowpass brightness) = pen speed;
  legato bow-change releases; a quiet C2+G2+C3 triangle drone underneath.
  Since stroke order is random per run, every drawing performs a different
  melody. Implementation: `useDrawSound` grew startMusic/stopMusic/noteOn/
  noteOff (2 detuned saws → lowpass → env per voice, vibrato LFO, 5-voice
  cap); `usePathAnimation` exposes per-vertex `curveNorm` and `getPoint` now
  returns the current VERTEX INDEX (≥0 = pen down, −1 = travel — callers
  updated); `Scene` emits note events on pen-down transitions and publishes
  curveRef; layered with the pen scratch behind the existing 🔇/🔊 toggle
  (off by default, gesture-safe). E2E updated to click the sound toggle —
  full draw with audio active, zero console errors.

- **Edge-detection fix (2026-07-23)** — trace mode drew a great face but
  missed bright/low-contrast regions (user's white-robe-on-white-background
  photo: robe and hood absent). Cause: Canny thresholds from the intensity
  MEDIAN — high on bright images → faint edges culled (reproduced: washed-out
  test image dropped from ~15k to ~2.9k edge px). Fix (both backends, in
  lockstep): CLAHE before a gentler bilateral (sigmaColor 50→35), Canny
  thresholds from gradient-magnitude percentiles (hi=P92 of nonzero Sobel
  mags, lo=0.45·hi) → washed test recovers to ~10.5k px, normal images
  unchanged (~16k). Also: input scale normalized in both directions
  (small uploads upscaled to 720, INTER_CUBIC) so low-res photos draw just
  as complete. BUILD_MARKER 2026-07-23-r4-edges.

- **Feature #5 — faithful TRACE mode + pen lifts + exact-append ink
  (2026-07-23)** — drawings finally *complete the image*. Diagnosis: the app
  drew 100% of the backend path, but the TSP pipeline scattered ~800 points
  (sampler bug: the binary search accepted the FIRST count in
  [MIN, MAX] — i.e. near the minimum, so detail presets did ~nothing) and the
  tour destroyed contour structure — faces dissolved into abstract loops at
  any density. Drawing longer could never fix it. Changes:
  (a) new default **`mode=trace`** backend path (`trace_chains` /
  `order_chains` / `smooth_chains` in BOTH `api/index.py` and
  `backend/main.py`) that traces real edge chains and returns **`breaks`**
  (stroke start indices), ~0.1 s vs ~2.6 s;
  (b) sampler binary search now targets the TOP of the point range
  (scribble mode; dense preset actually dense now);
  (c) `usePathAnimation` takes `breaks` → travel segments fly at
  `TRAVEL_SPEED` with κ=0, `getPoint` returns penDown, exposes
  `cumTime/isTravel/normals/warp`;
  (d) `Scene` lifts the pen (z, smoothed) on hops — IK arm rises naturally —
  and silences scratch audio while up;
  (e) **`InkTrail` rewritten to EXACT-APPEND**: commits actual path vertices
  as the clock passes them + one floating live-tip center, pen-up hops
  bridged with zero-width degenerate quads. Fixes hop-inking (most hops are
  shorter than one frame, so frame-sampling inked straight chords across
  them — caught in headless E2E) and makes ink frame-rate independent;
  width now derives from timetable speed. Ribbon/buffer discipline kept.
  (f) Style panel gains a **Mode** toggle (Portrait/One-line); Sketch preset
  → scribble+dense. Verified: unit checks (all levels, uniqueness,
  invariants), HTTP checks both modes, `npm run build`, and headless E2E
  screenshots showing a recognizable portrait.

- **Feature #4 — style controls + presets (2026-07-22)** — a collapsible
  "⚙ Style" panel lets viewers set ink colour, stroke boldness, draw time,
  splash intensity, and a backend **detail** level (fine/std/dense → point
  density), plus 3 presets (Fine liner / Bold ink / Sketch). Settings persist to
  localStorage and apply on the next draw (ink colour also recolours a finished
  piece live). New `components/ControlsPanel.jsx`; `InkTrail` takes
  inkColor/weight, `WatercolorSplash` takes intensity, `Scene` threads them;
  `api.js` sends `?detail=…`; `api/index.py` maps it via `DETAIL_LEVELS` (all
  levels re-verified ≤2.2s). Settings state + localStorage live in `App.jsx`.

## Roadmap — remaining ideas (not yet done)

- ✅ **Save/share the result — DONE (Feature #1).** PNG + video export + Web
  Share on the done screen. Follow-ups if wanted: GIF output; a subtle
  watermark; higher-fps capture on capable devices; include the hand in an
  optional "making of" clip variant.
- ✅ **Variable-width strokes — DONE (Feature #3).** Speed-driven ribbon with
  adaptive normalization + tapered nib. Follow-up: a soft-edge/ink-bleed shader.
- **Face-priority sampling** — largely superseded by trace mode (Feature #5),
  which keeps facial features by construction. Still relevant for scribble
  mode, or as face-weighted `TRACE_LEVELS` (finer epsilon inside a detected
  face box).
- **Rigged hand `.glb`** in HandRig's marked GLTF slot, driven by the same IK
  solve. NOTE: a code-authored wooden-mannequin version was built and shipped
  2026-07-27 but reverted 2026-07-29 — the owner didn't like the look (see
  Revision history / commit `e16aea4`). Any retry needs owner approval of
  rendered screenshots BEFORE integration.
- ✅ **Polish — DONE (Feature #2):** processing spinner, splash fade-in reveal,
  synth pen-scratch audio + completion chime (off by default), reduced-motion.
  Remaining here: a camera ease-in. (✅ adaptive duration shipped 2026-07-24, Phase 1.)
- ✅ **Style controls + presets — DONE (Feature #4).** Ink colour, boldness,
  draw time, splash intensity, detail level; 3 presets; localStorage. Follow-up:
  more palettes; a full colour picker.
- **Custom domain + analytics**; rate-limit `/api` if it goes public.

## Gotchas / don't-regress

- IK pole vector must not be (anti)parallel to the shoulder→grip direction or the
  elbow flips behind the paper (exact vectors are in `HandRig.jsx`). Arm length =
  maxReach × 1.06.
- Bones are unit **cylinders** scaled to joint distance (capsules overshoot joints).
- `PEN_AXIS` z must stay ~0.55 or the pen foreshortens into invisibility at the camera angle.
- The frontend must keep downscaling uploads to ≤1280 px (Vercel's 4.5 MB request-body cap).
- **Never frame-sample the pen to decide where ink goes.** Most pen-up hops
  complete within ONE frame (travel time ≈ 5 ms < 16 ms), so any
  sample-the-tip-per-frame ink renderer will ink straight chords across
  hops and cut corners at low fps. `InkTrail` must stay exact-append
  (committing `anim.worldPoints` by `cumTime`); the floating live-tip center
  is the only frame-sampled vertex, and it collapses to zero width while
  `isTravel` is active.
- `smooth_chains` allocates ≥4 output points per stroke; keep `maxPoints`
  in `Scene`'s `<InkTrail>` above max backend output + 2×max_strokes
  (bridges) + 1 (floating tip) — **and now + the caption**: dense trace at
  span=2 (~9.6k points, ≤640 strokes) plus a full-length written dedication
  (~4.4k points, ~230 letter strokes) ≈ 15.8k centers, hence **22000**.
  `verify_caption.mjs` asserts the caption half of that arithmetic.
- **Never commit raw Hershey outlines to the ribbon.** A glyph stem is two
  mathematically straight points: zero curvature → full cruise speed → the
  thinnest hairline `InkTrail` owns, and `TAPER_N`/`WIDTH_LERP` mean a
  2-vertex stroke is pure ramp-in. Letters must go through
  `hershey.handwrite()` (subdivide → jitter → Chaikin ×2), the same
  treatment `smooth_chains` gives a traced edge chain, or they render with
  their stems missing.
- Caption geometry: `BOTTOM_PAD` stays above ~0.055 or a right-aligned
  signature collides with the export watermark, which `composite()` stamps
  in the lowest ~4.2% of the canvas (the board's bottom edge IS the canvas
  bottom edge). Signature cap height stays ≥ ~0.028 — the nib width is
  absolute, so smaller letters clog their counters shut.
- The caption is appended AFTER `truncatePath`, never before: a dedication
  is written in full at every Completeness setting. Empty dedication +
  signDate off must return the input pathData object UNCHANGED (identity),
  which is what keeps the ordinary path byte-identical.
- The ghost reveal must FINISH inside the 2.6s post-`done` capture tail
  (currently 2.1s). Longer and it bakes into the "clean still" that
  `snapshotPNG()` grabs, and into every gallery thumbnail.
- The ghost lives in the R3F scene, not the DOM. A DOM overlay would have to
  re-derive the camera projection to stay registered with the drawing and
  would need its own compositing pass in `useDrawCapture` to reach exports.
- Replay must keep `phase === 'done'`. That single fact is what stops the
  recorder re-arming, the gallery double-saving and the video/GIF blobs being
  replaced; anything that routes a replay back through `'drawing'` breaks all
  three at once.
- Drag & drop needs the WINDOW-level `dragover`/`drop` preventDefault, or a
  photo dropped outside the dropzone navigates the browser away mid-draw.
- Don't assert on short-lived canvas animations with `page.screenshot()` —
  the round trip plus PNG encode is slow enough to miss a 2s window. Sample
  the canvas in-page instead (see the ghost check in `e2e_test.py`).
- **Every masterpiece image URL must stay on `upload.wikimedia.org`.** The
  Met's own host sends no CORS header: the fetch would fail, and any such
  image reaching the WebGL canvas (the ghost reveal puts it there) taints it,
  which makes `toDataURL`/`captureStream` throw and kills PNG/video/GIF
  export. `verify_masterpiece.mjs` asserts this.
- The daily pick must stay a pure function of the date with a coprime stride
  (not a hash), or the calendar can repeat yesterday's artwork.
- A duet's panel must stay DERIVED from the pen's x (`duet.splitX`), never
  carried as a per-stroke array — the array would have to be maintained by
  truncatePath, appendCaption and everything added later.
- Duet panels stay one detail notch COARSER than the viewer's setting. Two
  `dense` panels plus a caption overflow InkTrail's 26000 ribbon centers and
  the end of the drawing is silently truncated.
- Duet strokes interleave in proportional RUNS. Stroke-by-stroke alternation
  makes gutter travel dominate the path (measured: 55 → 388 length), and a
  missing `MIN_ROUNDS` floor collapses sparse pairs into one portrait drawn
  after the other.
- `truncatePath` counts ink AND travel. That is not what the dial claims to
  measure, but changing it shifts every stored Completeness setting by
  23–43% — see the note in the file before touching it.
- "Today's masterpiece" is lazy and failure-silent by contract: the list is
  fetched after first paint, and every error path returns null so the chip
  vanishes rather than blocking the idle screen.
- Curating by metadata alone does NOT work. Candidates must be scored through
  the real pipeline, and the frame/ring/miniature/object filters exist
  because each one shipped a bad daily pick before it was added — RENDER a
  few days' picks before trusting a regenerated list.
- **Share media must NEVER round-trip through `/api/share`** — Vercel's
  request-body cap is 4.5 MB and videos run bigger. Client uploads only
  (`@vercel/blob/client` `upload()`), with the pathname/size/content-type
  gates in `onBeforeGenerateToken`.
- **The share flow must never see the source photo.** Only `stillBlob` and
  the recorded video go up; `sourceRef`/`sourceUrls` (the user's photo)
  stay out of `createShareLink` and out of the meta. The consent dialog's
  wording is a promise — keep it true.
- `/api/share` must stay a FILESYSTEM route (api/share.mjs). It works only
  because Vercel matches function files before applying the `/api/(.*)`
  catch-all rewrite; renaming the file without updating the rewrites sends
  share traffic to the Python function.
- Share-page expiry stays enforced at read time (410 + delete in the `/s/`
  handler). The cron is reclamation, not the contract — Hobby crons can be
  disabled or lag, and a "deleted after 30 days" promise must not depend on
  one.
- Effect-scoped liveness refs must re-arm in the effect BODY
  (`aliveRef.current = true` inside the effect, false in cleanup). React 18
  StrictMode double-mounts in dev; a cleanup-only ref bricks the component
  the second time and everything downstream silently no-ops.
- In sync Playwright, `time.sleep()` starves `context.route` handlers (they
  run on the same event loop) — any stubbed endpoint "hangs" and the bug
  hunt goes to the wrong layer. Wait with selectors/expect_*, not sleeps,
  whenever routes must answer during the wait.
