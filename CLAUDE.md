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

- **Backend:** in a venv with the pinned deps, feed a synthetic edge-rich image
  (draw lines/circles with cv2) through `detect_edges → sample_points →
  jitter_points → nearest_neighbor_path → two_opt → smooth_path → normalize`;
  assert the output is `(OUTPUT_POINTS, 2)`, finite, `aspect > 0`. Runs in ~2–3 s.
- **Frontend:** `cd frontend && npm run build` must succeed (catches JS/compile errors).
- **Full visual check:** deploy a preview branch on Vercel (or `npm run dev`) and draw.

## Revision history

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
- **Rigged hand `.glb`** in HandRig's marked GLTF slot, driven by the same IK solve.
- ✅ **Polish — DONE (Feature #2):** processing spinner, splash fade-in reveal,
  synth pen-scratch audio + completion chime (off by default), reduced-motion.
  Remaining here: **adaptive duration** scaled to path length; a camera ease-in.
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
  (bridges) + 1 (floating tip) — currently 4600 + 640 + 1 ≪ 16000.
