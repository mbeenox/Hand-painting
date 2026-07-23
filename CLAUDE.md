# CLAUDE.md — Hypnotic Hand

> **Read this first.** It is the single source of truth for what this app is, how
> it is built, how to run and deploy it, and every change made so far. If you are
> an AI assistant (or a human) picking this project up in a new session, start here.

## What it is

Hypnotic Hand is a web app: upload a photo (or snap one with the camera) → a
FastAPI backend turns it into **one continuous vector line** → a 3D, IK-driven
hand (React Three Fiber) draws that line over ~30 seconds on top of randomized
watercolor splashes. Every run of the same photo produces a different drawing
(per-request entropy seeds the jitter).

- **Live:** https://hand-painting-one.vercel.app
- **Repo:** https://github.com/mbeenox/Hand-painting
- One Vercel project serves **both** the static frontend and the Python API.

## Architecture (data flow)

```
Browser (React + R3F)         multipart POST /api/process-image      FastAPI (api/index.py)
  UploadPanel (file/camera) ───────────────────────────────────────▶  A. Canny edge detection
  WatercolorSplash (SVG)                                               B. Poisson-disk sampling
  Scene: usePathAnimation → penTip  ◀──── JSON {points, aspect} ─────  C. jitter → NN → 2-opt TSP
         ├─ HandRig  (2-bone IK arm)                                   D. Chaikin smoothing
         └─ InkTrail (growing polyline)                                → normalized [0,1] polyline
```

The backend returns one ordered list of `[x,y]` points (a single continuous
stroke). The frontend animates a pen along it; the arm is solved by analytic IK
to keep the pen tip on the line; the ink trail grows behind the tip.

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

1. **Edge detection** — bilateral filter + CLAHE, auto-thresholded Canny
   (0.66/1.33 × median), speckle removal via connected components.
2. **Sampling** — grid-hash Poisson-disk thinning; binary-search the radius to
   land `MIN_POINTS..MAX_POINTS` points.
3. **Jitter (before TSP)** — Gaussian σ, RNG from `os.urandom` → unique per run.
4. **TSP** — Nearest-Neighbor seed + time-boxed vectorized 2-opt. Uncrossing is
   the aesthetic workhorse (removing crossings always shortens the tour).
5. **Smoothing** — Chaikin ×3 (≈ quadratic B-spline) + arc-length resample to
   `OUTPUT_POINTS`. Output normalized to [0,1], y-up, longest side = 1.

Tunables live at the top of `api/index.py`. Current: `MAX_IMAGE_DIM=720`,
`MIN_POINTS=500`, `MAX_POINTS=1300`, `TWO_OPT_TIME_BUDGET=2.0`, `OUTPUT_POINTS=2800`.
Pipeline runs in ~2–3 s; the function `maxDuration` is 30 s.

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

## Roadmap — remaining ideas (not yet done)

- ✅ **Save/share the result — DONE (Feature #1).** PNG + video export + Web
  Share on the done screen. Follow-ups if wanted: GIF output; a subtle
  watermark; higher-fps capture on capable devices; include the hand in an
  optional "making of" clip variant.
- ✅ **Variable-width strokes — DONE (Feature #3).** Speed-driven ribbon with
  adaptive normalization + tapered nib. Follow-up: a soft-edge/ink-bleed shader.
- **Face-priority sampling** — weight sampled points toward a detected face so
  portraits keep eyes/nose/mouth, not just an outline.
- **Rigged hand `.glb`** in HandRig's marked GLTF slot, driven by the same IK solve.
- ✅ **Polish — DONE (Feature #2):** processing spinner, splash fade-in reveal,
  synth pen-scratch audio + completion chime (off by default), reduced-motion.
  Remaining here: **adaptive duration** scaled to path length; a camera ease-in.
- **Style presets** (ink weight, palette, splash intensity); optional colored line.
- **Custom domain + analytics**; rate-limit `/api` if it goes public.

## Gotchas / don't-regress

- IK pole vector must not be (anti)parallel to the shoulder→grip direction or the
  elbow flips behind the paper (exact vectors are in `HandRig.jsx`). Arm length =
  maxReach × 1.06.
- Bones are unit **cylinders** scaled to joint distance (capsules overshoot joints).
- `PEN_AXIS` z must stay ~0.55 or the pen foreshortens into invisibility at the camera angle.
- The frontend must keep downscaling uploads to ≤1280 px (Vercel's 4.5 MB request-body cap).
