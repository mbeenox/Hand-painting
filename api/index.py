"""
Hypnotic Hand — Vercel serverless backend.

Same pipeline as backend/main.py, ported to run inside a Vercel Python
function. Two constraints shaped this file:

  1. SIZE — Vercel functions cap at 250 MB unpacked. numpy (~45 MB) +
     opencv-python-headless (~75 MB) fit; SciPy (+113 MB) does not leave
     enough headroom. So the two SciPy dependencies are replaced with
     dependency-free equivalents:
       • cKDTree nearest-neighbor queries  → brute-force vectorized numpy
         argmin (n ≤ 1000 → ≤ 1e6 flops per tour, still milliseconds);
       • splprep/splev B-spline smoothing  → Chaikin corner-cutting.
         Chaikin's subdivision provably converges to a quadratic B-spline,
         so 3 rounds + arc-length resampling gives the same fluid look.

  2. ROUTING — vercel.json rewrites "/api/(.*)" to this function, and the
     ASGI app receives the ORIGINAL request path ("/api/process-image").
     Routes are registered under BOTH "/api/..." (Vercel) and "/..."
     (bare local `uvicorn api.index:app`), so either environment works.

The FastAPI instance is exposed as `app`, which Vercel's Python runtime
picks up automatically as an ASGI application.
"""

import os
import time
import logging
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("hypnotic-hand")

app = FastAPI(title="Hypnotic Hand API (Vercel)", version="1.0.0")

# On Vercel the frontend and this function share one origin, so CORS never
# triggers in production; the permissive policy is for local dev and
# preview-deployment cross-origin testing. Lock down if you add auth.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# Tunables (kept in lockstep with backend/main.py)
# --------------------------------------------------------------------------
MAX_IMAGE_DIM = 720           # a touch more resolution → finer edge detail
MIN_POINTS, MAX_POINTS = 500, 1300   # denser sampling → the line covers more
JITTER_SIGMA_PX = 1.6         #   of the image, so it reads as more "complete"
TWO_OPT_TIME_BUDGET = 2.0     # more uncrossing for the larger point set; still
                              #   ~seconds, far under the 30s function maxDuration
CHAIKIN_ROUNDS = 3
OUTPUT_POINTS = 2800          # smoother resampled polyline for the denser tour


# ==========================================================================
# Step A — Edge detection (identical to backend/main.py)
# ==========================================================================
def detect_edges(img_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, d=7, sigmaColor=50, sigmaSpace=50)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    v = float(np.median(gray))
    edges = cv2.Canny(gray, int(max(0, 0.66 * v)), int(min(255, 1.33 * v)),
                      L2gradient=True)
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(edges, connectivity=8)
    min_blob = max(10, int(0.00005 * edges.size))
    keep = np.zeros_like(edges)
    for i in range(1, n_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_blob:
            keep[labels == i] = 255
    return keep


# ==========================================================================
# Step B — Point sampling (identical grid-hash Poisson-disk thinning)
# ==========================================================================
def sample_points(edges: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    ys, xs = np.nonzero(edges)
    if len(xs) < MIN_POINTS:
        raise HTTPException(
            status_code=422,
            detail="Not enough edge detail found in the image — try a "
                   "higher-contrast photo (a clear portrait works best).",
        )
    pix = np.column_stack([xs, ys]).astype(np.float64)
    pix = pix[rng.permutation(len(pix))]

    def thin(r: float) -> np.ndarray:
        cell = r / np.sqrt(2.0)
        grid: dict = {}
        accepted: List[np.ndarray] = []
        r2 = r * r
        for p in pix:
            gx, gy = int(p[0] / cell), int(p[1] / cell)
            ok = True
            for dx in (-2, -1, 0, 1, 2):
                for dy in (-2, -1, 0, 1, 2):
                    for q in grid.get((gx + dx, gy + dy), ()):
                        d = p - q
                        if d[0] * d[0] + d[1] * d[1] < r2:
                            ok = False
                            break
                    if not ok:
                        break
                if not ok:
                    break
            if ok:
                accepted.append(p)
                grid.setdefault((gx, gy), []).append(p)
                if len(accepted) > MAX_POINTS * 3:
                    break
        return np.array(accepted)

    lo_r, hi_r = 1.0, float(max(edges.shape))
    best = None
    for _ in range(18):
        mid = 0.5 * (lo_r + hi_r)
        pts = thin(mid)
        n = len(pts)
        if MIN_POINTS <= n <= MAX_POINTS:
            best = pts
            break
        if n > MAX_POINTS:
            lo_r = mid
            best = pts[:MAX_POINTS] if best is None else best
        else:
            hi_r = mid
    if best is None or len(best) < MIN_POINTS:
        best = pix[:min(MAX_POINTS, len(pix))]
    return best[:MAX_POINTS]


# ==========================================================================
# Step D — Jitter (before TSP, RNG from entropy → unique every run)
# ==========================================================================
def jitter_points(pts: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    return pts + rng.normal(0.0, JITTER_SIGMA_PX, size=pts.shape)


# ==========================================================================
# Step C — TSP: Nearest Neighbor (brute-force numpy) + time-boxed 2-opt
# ==========================================================================
def nearest_neighbor_path(pts: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    SciPy-free NN tour. For each step, one vectorized squared-distance
    computation against all points with visited ones masked to +inf:
    O(n) per step → O(n²) total. At n=1000 that is ~1e6 flops per solve —
    numpy does this in a few milliseconds, no k-d tree required.
    """
    n = len(pts)
    visited = np.zeros(n, dtype=bool)
    order = np.empty(n, dtype=np.int64)
    cur = int(rng.integers(n))
    order[0] = cur
    visited[cur] = True
    for i in range(1, n):
        diff = pts - pts[cur]
        d2 = np.einsum("ij,ij->i", diff, diff)  # squared distances, no sqrt
        d2[visited] = np.inf
        cur = int(np.argmin(d2))
        order[i] = cur
        visited[cur] = True
    return order


def two_opt(pts: np.ndarray, order: np.ndarray, time_budget: float) -> np.ndarray:
    """Identical vectorized 2-opt as backend/main.py (see math there):
    gain = [d(i,i+1)+d(j,j+1)] − [d(i,j)+d(i+1,j+1)]; positive gain ⇒
    reversing i+1..j shortens the path and removes a crossing."""
    path = pts[order].copy()
    n = len(path)
    t0 = time.perf_counter()
    improved = True
    while improved and (time.perf_counter() - t0) < time_budget:
        improved = False
        seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
        for i in range(n - 3):
            if (time.perf_counter() - t0) > time_budget:
                break
            j = np.arange(i + 2, n - 1)
            d_i_j = np.linalg.norm(path[j] - path[i], axis=1)
            d_i1_j1 = np.linalg.norm(path[j + 1] - path[i + 1], axis=1)
            gain = (seg[i] + seg[j]) - (d_i_j + d_i1_j1)
            best = int(np.argmax(gain))
            if gain[best] > 1e-9:
                jj = int(j[best])
                path[i + 1: jj + 1] = path[i + 1: jj + 1][::-1]
                seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
                improved = True
    return path


# ==========================================================================
# Step E — Smoothing: Chaikin corner cutting + arc-length resampling
# ==========================================================================
def smooth_path(path: np.ndarray) -> np.ndarray:
    """
    SciPy-free spline smoothing.

    Chaikin's algorithm replaces every corner (P_i, P_{i+1}) with two points
    at the 1/4 and 3/4 positions of each segment:

        Q = 0.75·P_i + 0.25·P_{i+1}
        R = 0.25·P_i + 0.75·P_{i+1}

    Repeated subdivision converges to the uniform QUADRATIC B-SPLINE with
    the original points as control polygon — i.e. after 3 rounds the
    polyline is visually indistinguishable from a fitted spline, with C1
    continuity everywhere. We then resample uniformly BY ARC LENGTH
    (np.interp over cumulative chord length) so the frontend's
    time-parameterization sees evenly spaced vertices.
    """
    # Drop consecutive duplicates.
    keep = np.ones(len(path), dtype=bool)
    keep[1:] = np.linalg.norm(np.diff(path, axis=0), axis=1) > 1e-9
    path = path[keep]

    for _ in range(CHAIKIN_ROUNDS):
        p0 = path[:-1]
        p1 = path[1:]
        q = 0.75 * p0 + 0.25 * p1
        r = 0.25 * p0 + 0.75 * p1
        # Interleave Q and R; keep the original endpoints (open curve).
        mid = np.empty((2 * len(q), 2))
        mid[0::2] = q
        mid[1::2] = r
        path = np.vstack([path[:1], mid, path[-1:]])

    # Uniform arc-length resample to OUTPUT_POINTS vertices.
    chords = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(chords)])
    total = s[-1] if s[-1] > 0 else 1.0
    target = np.linspace(0.0, total, OUTPUT_POINTS)
    x = np.interp(target, s, path[:, 0])
    y = np.interp(target, s, path[:, 1])
    return np.column_stack([x, y])


def normalize(path: np.ndarray, w: int, h: int):
    pts = path.copy()
    pts[:, 1] = h - pts[:, 1]  # flip y: image-down → world-up
    pts /= float(max(w, h))
    return pts, w / h


# ==========================================================================
# Endpoint — registered at both the Vercel path and the bare path
# ==========================================================================
async def _process(file: UploadFile):
    t_start = time.perf_counter()
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=415, detail="Could not decode image.")

    h, w = img.shape[:2]
    if max(h, w) > MAX_IMAGE_DIM:
        f = MAX_IMAGE_DIM / max(h, w)
        img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]

    rng = np.random.default_rng(int.from_bytes(os.urandom(8), "little"))

    edges = detect_edges(img)                        # A
    pts = sample_points(edges, rng)                  # B
    pts = jitter_points(pts, rng)                    # D
    order = nearest_neighbor_path(pts, rng)          # C
    path = two_opt(pts, order, TWO_OPT_TIME_BUDGET)  # C
    path = smooth_path(path)                         # E
    norm, aspect = normalize(path, w, h)

    elapsed = time.perf_counter() - t_start
    length = float(np.sum(np.linalg.norm(np.diff(norm, axis=0), axis=1)))
    log.info("processed %s: %d pts → %d, len=%.2f, %.2fs",
             file.filename, len(pts), len(norm), length, elapsed)

    return {
        "points": np.round(norm, 5).tolist(),
        "aspect": aspect,
        "numSampled": int(len(pts)),
        "pathLength": round(length, 4),
        "processingSeconds": round(elapsed, 3),
    }


@app.post("/api/process-image")   # path seen when deployed on Vercel
async def process_image_vercel(file: UploadFile = File(...)):
    return await _process(file)


@app.post("/process-image")       # path seen under bare local uvicorn
async def process_image_local(file: UploadFile = File(...)):
    return await _process(file)


BUILD_MARKER = "2026-07-21-r2"  # bumped per deploy to verify rollouts


@app.get("/api/health")
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/version")
@app.get("/version")
def version():
    return {"build": BUILD_MARKER}
