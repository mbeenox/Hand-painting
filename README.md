# Hypnotic Hand 🖊️

Upload a photo (or take a camera snapshot) and watch a 3D hand draw it as a
**single continuous ink line** over ~20 seconds, on top of randomized
watercolor splashes. Every run of the same photo produces a unique drawing.

## Architecture

```
┌─────────────────────────────┐        multipart/form-data        ┌──────────────────────────────┐
│  React + React Three Fiber  │  ──────────────────────────────▶  │  FastAPI  POST /process-image │
│                             │                                   │                              │
│  UploadPanel (file/camera)  │  ◀──────────────────────────────  │  A. Canny edge detection     │
│  WatercolorSplash (SVG)     │      JSON [[x,y], ...] (norm.)    │  B. Poisson-disk sampling    │
│  Scene                      │                                   │  D. Gaussian jitter (entropy)│
│   ├─ usePathAnimation       │                                   │  C. TSP: NN + 2-opt          │
│   ├─ HandRig (2-bone IK)    │                                   │  E. B-spline smoothing       │
│   └─ InkTrail (drawRange)   │                                   └──────────────────────────────┘
└─────────────────────────────┘
```

## Deploy to Vercel (one project: frontend + serverless API)

The repo is Vercel-ready as-is: `vercel.json` builds the Vite frontend into
`frontend/dist` and deploys `api/index.py` as a Python serverless function,
with `/api/*` rewritten to it. Same origin → no CORS in production.

Either connect the repo on vercel.com (Add New → Project → import → Deploy,
no settings needed), or use the CLI:

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production
```

Why `api/index.py` differs from `backend/main.py`:

- **250 MB function limit** — numpy (~45 MB) + opencv-headless (~75 MB) fit;
  SciPy (+113 MB) doesn't leave headroom. So the serverless port replaces
  cKDTree with brute-force vectorized numpy NN (n ≤ 1000 → still ms) and
  splprep with Chaikin corner-cutting (which converges to a quadratic
  B-spline — same fluid look). The root `requirements.txt` is the minimal
  Vercel set; `backend/requirements.txt` is the full local set.
- **4.5 MB request-body limit** — the frontend now downscales photos to
  ≤1280 px JPEG in the browser before uploading (`src/api.js`), so phone
  photos survive the cap (and upload faster everywhere).
- Function config (`vercel.json`): 1024 MB memory, 30 s maxDuration —
  the pipeline itself runs in ~0.6 s; the margin covers cold starts.

Note: the first request after idle is a cold start (imports numpy+cv2,
typically a few seconds). Subsequent requests are warm and fast.

## Run it locally

Backend (port 8000):
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Frontend (port 5173, proxies /api → :8000):
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Key implementation notes

- **TSP pathing** — Nearest-Neighbor seed tour (k-d tree accelerated), then a
  time-boxed vectorized 2-opt pass. 2-opt matters aesthetically: every
  segment crossing can be removed by a 2-opt move (uncrossing always shortens
  the path), which is what makes the line art clean. Math comments in
  `backend/main.py`. A `?solver=christofides` option (networkx) exists for
  experiments.
- **Non-determinism** — the RNG is seeded from `os.urandom` per request and
  jitter is applied *before* the TSP solve, so the heuristic re-routes
  globally: same photo, different drawing, every time.
- **Two-bone IK** — analytic law-of-cosines solver with a pole vector for the
  elbow swivel DOF; full derivation in `frontend/src/components/HandRig.jsx`.
  The procedural arm can be swapped for a rigged `.glb` (see the GLTF slot
  comment in the same file).
- **Human-like easing** — per-segment speed ∝ 1/(1+K·curvature) (a cheap
  two-thirds-power-law imitation) plus a smootherstep envelope; see
  `frontend/src/hooks/usePathAnimation.js`.
- **Ink trail** — one preallocated buffer + `drawRange` growth: zero
  allocation per frame; see `frontend/src/components/InkTrail.jsx`.

## Testing

- `backend/test_pipeline.py` — runs the pipeline twice on a test portrait,
  renders previews, and asserts run-to-run uniqueness.
- `e2e_test.py` — headless-Chromium end-to-end test (needs Playwright and
  both servers running): uploads an image through the real UI and
  screenshots the drawing at several timestamps.
