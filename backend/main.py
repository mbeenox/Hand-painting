"""
Hypnotic Hand — Backend
=======================

FastAPI service that converts an uploaded photo into a SINGLE continuous
vector path (a "one-line portrait") suitable for a robotic / IK-driven
drawing animation on the frontend.

Pipeline (POST /process-image):

    image bytes
      └─> A. Canny edge detection      (find the high-contrast feature lines)
      └─> B. Point sampling            (500–1000 well-spread points on edges)
      └─> D. Procedural jitter         (seeded from entropy → unique each run)
      └─> C. TSP approximation         (Nearest Neighbor + time-boxed 2-opt)
      └─> E. B-spline smoothing        (fluid, human-looking pen motion)
      └─> JSON [[x, y], ...]           (normalized, y-up, aspect preserved)

Note the letter ordering: jitter (D) is applied *before* the TSP solve (C),
exactly as specified — perturbing the city locations changes which tour the
heuristic finds, so the same photo yields a genuinely different drawing
every time, not just a wobblier copy of the same one.

Run:
    uvicorn main:app --reload --port 8000
"""

import io
import os
import time
import logging
from typing import List, Tuple

import cv2
import numpy as np
import networkx as nx
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from scipy import interpolate
from scipy.spatial import cKDTree

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("hypnotic-hand")

# --------------------------------------------------------------------------
# App + CORS
# --------------------------------------------------------------------------
app = FastAPI(title="Hypnotic Hand API", version="1.0.0")

# The React dev server (Vite) runs on :5173 by default; CRA uses :3000.
# For a demo we allow both plus any localhost origin. Lock this down in prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# Tunables
# --------------------------------------------------------------------------
MAX_IMAGE_DIM = 720        # downscale large uploads for speed & consistency
MIN_POINTS, MAX_POINTS = 500, 1300   # in lockstep with api/index.py
JITTER_SIGMA_PX = 1.6      # std-dev of Gaussian jitter, in pixels
TWO_OPT_TIME_BUDGET = 2.0  # seconds spent untangling the (denser) tour
SPLINE_OUTPUT_POINTS = 2800  # resolution of the final smoothed polyline
SPLINE_SMOOTHING = 2.0     # scipy splprep smoothing factor multiplier

# Faithful "trace" mode presets (in lockstep with api/index.py) →
# (approx_epsilon_px, min_chain_px, output_points, max_strokes).
TRACE_LEVELS = {
    "fine":  (1.6, 14, 2600, 140),
    "std":   (1.1, 10, 3400, 220),
    "dense": (0.8,  7, 4600, 320),
}
TRACE_JITTER_PX = 1.1
TRACE_CHAIKIN_ROUNDS = 2


# ==========================================================================
# Step A — Edge detection
# ==========================================================================
def detect_edges(img_bgr: np.ndarray) -> np.ndarray:
    """Grayscale → denoise → auto-thresholded Canny edge map (uint8 0/255)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # Bilateral filter smooths skin/background texture while KEEPING edges
    # sharp — much better than Gaussian blur for portrait line art.
    gray = cv2.bilateralFilter(gray, d=7, sigmaColor=50, sigmaSpace=50)

    # Histogram equalization lifts contrast on dim photos so Canny has
    # something to bite into.
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)

    # Auto Canny: derive thresholds from the median intensity (classic
    # trick — ~0.66*median and ~1.33*median bracket the "interesting"
    # gradient magnitudes for most photographs).
    v = float(np.median(gray))
    lo = int(max(0, 0.66 * v))
    hi = int(min(255, 1.33 * v))
    edges = cv2.Canny(gray, lo, hi, L2gradient=True)

    # Drop tiny speckle components (noise) — keep only edge blobs with a
    # meaningful number of pixels so the line doesn't chase dust.
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(edges, connectivity=8)
    min_blob = max(10, int(0.00005 * edges.size))
    keep = np.zeros_like(edges)
    for i in range(1, n_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_blob:
            keep[labels == i] = 255
    return keep


# ==========================================================================
# Step B — Point sampling (blue-noise-ish spatial thinning)
# ==========================================================================
def sample_points(edges: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Pick 500–1000 points spread evenly ALONG the edges.

    Strategy: shuffle all edge pixels (with the non-deterministic RNG, so
    sampling itself varies run-to-run), then greedily accept a pixel only if
    it is at least `r` away from every previously accepted point (grid-hash
    Poisson-disk thinning). Binary-search `r` until the count lands in range.
    """
    ys, xs = np.nonzero(edges)
    if len(xs) < MIN_POINTS:
        raise HTTPException(
            status_code=422,
            detail="Not enough edge detail found in the image — try a "
                   "higher-contrast photo (a clear portrait works best).",
        )
    pix = np.column_stack([xs, ys]).astype(np.float64)
    order = rng.permutation(len(pix))
    pix = pix[order]

    def thin(r: float) -> np.ndarray:
        """Greedy Poisson-disk thinning via a uniform grid hash (O(n))."""
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
                    break  # radius clearly too small; bail early
        return np.array(accepted)

    # Binary-search the radius, aiming for the TOP of the range. (The old
    # acceptance band was [MIN_POINTS, MAX_POINTS], so the search stopped at
    # the FIRST count anywhere in range — usually near the minimum, which
    # made higher point caps nearly indistinguishable.)
    lo_r, hi_r = 1.0, float(max(edges.shape))
    target_lo = max(MIN_POINTS, int(0.9 * MAX_POINTS))
    best, best_n = None, -1
    for _ in range(18):
        mid = 0.5 * (lo_r + hi_r)
        pts = thin(mid)
        n = len(pts)
        if n > MAX_POINTS:
            lo_r = mid          # too dense → grow radius
            if best_n < MAX_POINTS:
                best, best_n = pts[:MAX_POINTS], MAX_POINTS
        else:
            if n > best_n:      # densest in-cap result so far
                best, best_n = pts, n
            if n >= target_lo:
                break           # within 90% of the cap → good
            hi_r = mid          # too sparse → shrink radius
    if best is None or len(best) < MIN_POINTS:
        # Fallback: plain random subsample (still respects count bounds).
        n = min(MAX_POINTS, len(pix))
        best = pix[:n]
    return best[:MAX_POINTS]


# ==========================================================================
# Step D — Non-determinism (applied BEFORE the TSP solve)
# ==========================================================================
def jitter_points(pts: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Gaussian procedural jitter. Because the TSP heuristic below is extremely
    sensitive to city positions (Nearest Neighbor cascades: nudge one early
    choice and the whole remaining tour re-routes), a ~1.6 px perturbation
    is enough to make every run's drawing globally unique while staying
    visually faithful to the source edges.
    """
    return pts + rng.normal(0.0, JITTER_SIGMA_PX, size=pts.shape)


# ==========================================================================
# Step C — Continuous path: TSP approximation
# ==========================================================================
def nearest_neighbor_path(pts: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Greedy Nearest-Neighbor construction of an OPEN Hamiltonian path.

    Math: at each step we stand at city c and move to the closest unvisited
    city. This is O(n log n)-ish with a k-d tree (we query the k nearest and
    skip visited ones, doubling k on miss). NN paths are typically ~25% above
    the optimal tour length — good enough as a seed for 2-opt below.
    """
    n = len(pts)
    tree = cKDTree(pts)
    visited = np.zeros(n, dtype=bool)
    order = np.empty(n, dtype=np.int64)

    cur = int(rng.integers(n))          # random start → more variety per run
    order[0] = cur
    visited[cur] = True

    for i in range(1, n):
        k = 4
        nxt = -1
        while nxt < 0:
            k = min(k * 2, n)
            _, idx = tree.query(pts[cur], k=k)
            idx = np.atleast_1d(idx)
            for j in idx:
                if not visited[j]:
                    nxt = int(j)
                    break
            if k >= n and nxt < 0:      # all remaining found by brute force
                remaining = np.nonzero(~visited)[0]
                d = np.linalg.norm(pts[remaining] - pts[cur], axis=1)
                nxt = int(remaining[np.argmin(d)])
        order[i] = nxt
        visited[nxt] = True
        cur = nxt
    return order


def two_opt(pts: np.ndarray, order: np.ndarray, time_budget: float) -> np.ndarray:
    """
    Time-boxed 2-opt improvement for an OPEN path.

    Math: a "2-opt move" removes two edges (i,i+1) and (j,j+1) and reconnects
    as (i,j) and (i+1,j+1), which is equivalent to REVERSING the sub-path
    i+1..j. The length delta is:

        gain = [d(i,i+1) + d(j,j+1)] - [d(i,j) + d(i+1,j+1)]

    and any move with gain > 0 strictly shortens the path. Crucially for our
    aesthetic goal: every crossing of two path segments can be removed by a
    2-opt move (uncrossing two segments ALWAYS shortens the path, by the
    triangle inequality) — so this pass is what turns the scribbly NN tour
    into a clean, mostly non-overlapping line drawing.

    Implementation: for each pivot i we compute the gain against ALL j > i
    in one vectorized numpy expression (O(n) per pivot instead of a Python
    inner loop), take the best j, apply it if positive, and keep sweeping
    pivots until the time budget runs out or a full sweep finds no gain.
    """
    path = pts[order].copy()
    n = len(path)
    t0 = time.perf_counter()
    improved = True
    while improved and (time.perf_counter() - t0) < time_budget:
        improved = False
        # d1[i] = distance from path[i] to path[i+1]
        seg = np.linalg.norm(np.diff(path, axis=0), axis=1)  # len n-1
        for i in range(n - 3):
            if (time.perf_counter() - t0) > time_budget:
                break
            # Candidate j ranges over i+2 .. n-2 (need two disjoint edges).
            j = np.arange(i + 2, n - 1)
            # New edge lengths if we reconnect (i→j) and (i+1→j+1):
            d_i_j = np.linalg.norm(path[j] - path[i], axis=1)
            d_i1_j1 = np.linalg.norm(path[j + 1] - path[i + 1], axis=1)
            gain = (seg[i] + seg[j]) - (d_i_j + d_i1_j1)
            best = int(np.argmax(gain))
            if gain[best] > 1e-9:
                jj = int(j[best])
                path[i + 1: jj + 1] = path[i + 1: jj + 1][::-1]  # reverse
                # Only two segment lengths changed; update them in place.
                seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
                improved = True
    return path


def christofides_path(pts: np.ndarray) -> np.ndarray:
    """
    Optional exact-spec alternative (?solver=christofides): networkx's
    Christofides 1.5-approximation. O(n^3) matching → only sensible for
    small n; we cap input at 400 points. Kept for completeness/experiments.
    """
    n = min(len(pts), 400)
    p = pts[:n]
    g = nx.Graph()
    for a in range(n):
        d = np.linalg.norm(p[a + 1:] - p[a], axis=1)
        for off, dist in enumerate(d):
            g.add_edge(a, a + 1 + off, weight=float(dist))
    cycle = nx.approximation.christofides(g)
    return p[np.array(cycle[:-1])]  # drop the closing repeat → open-ish path


# ==========================================================================
# Step E — Spline smoothing
# ==========================================================================
def smooth_path(path: np.ndarray) -> np.ndarray:
    """
    Fit a parametric cubic B-spline through the ordered points and resample
    it densely, parameterized by cumulative chord length so output points
    are roughly evenly spaced along the curve (which makes the frontend's
    arc-length-based easing accurate).
    """
    # Remove consecutive duplicates (splprep chokes on zero-length chords).
    keep = np.ones(len(path), dtype=bool)
    keep[1:] = np.linalg.norm(np.diff(path, axis=0), axis=1) > 1e-9
    path = path[keep]

    # Chord-length parameterization.
    chords = np.linalg.norm(np.diff(path, axis=0), axis=1)
    u = np.concatenate([[0.0], np.cumsum(chords)])
    u /= u[-1]

    # s controls the fit/smoothness tradeoff; scale with point count.
    s = SPLINE_SMOOTHING * len(path)
    tck, _ = interpolate.splprep([path[:, 0], path[:, 1]], u=u, s=s, k=3)

    uu = np.linspace(0.0, 1.0, SPLINE_OUTPUT_POINTS)
    x, y = interpolate.splev(uu, tck)
    return np.column_stack([x, y])


# ==========================================================================
# TRACE mode — draw the actual edge chains (faithful line portrait).
# Identical implementation to api/index.py (cv2 + numpy only); see the
# rationale there. The frontend lifts the pen between chains via `breaks`.
# ==========================================================================
def _chaikin(path: np.ndarray, rounds: int) -> np.ndarray:
    for _ in range(rounds):
        if len(path) < 3:
            break
        p0, p1 = path[:-1], path[1:]
        q = 0.75 * p0 + 0.25 * p1
        r = 0.25 * p0 + 0.75 * p1
        mid = np.empty((2 * len(q), 2))
        mid[0::2] = q
        mid[1::2] = r
        path = np.vstack([path[:1], mid, path[-1:]])
    return path


def _resample(path: np.ndarray, n: int) -> np.ndarray:
    keep = np.ones(len(path), dtype=bool)
    keep[1:] = np.linalg.norm(np.diff(path, axis=0), axis=1) > 1e-9
    path = path[keep]
    if len(path) < 2:
        return path
    chords = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(chords)])
    total = s[-1] if s[-1] > 0 else 1.0
    target = np.linspace(0.0, total, max(2, n))
    return np.column_stack([np.interp(target, s, path[:, 0]),
                            np.interp(target, s, path[:, 1])])


def trace_chains(edges: np.ndarray, epsilon: float, min_chain: int) -> List[np.ndarray]:
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    chains: List[np.ndarray] = []
    for c in cnts:
        c = c[:, 0, :].astype(np.float64)
        if len(c) < min_chain:
            continue
        m = len(c) // 2
        if m >= 4:
            k = np.linspace(1, m - 1, num=min(8, m - 1)).astype(int)
            sym = float(np.mean(np.linalg.norm(c[k] - c[len(c) - k], axis=1)))
            if sym < 3.0:               # out-and-back filament → one-way trace
                c = c[: m + 1]
        approx = cv2.approxPolyDP(c.astype(np.float32).reshape(-1, 1, 2),
                                  epsilon, False)
        c = approx[:, 0, :].astype(np.float64)
        if len(c) >= 2:
            chains.append(c)
    return chains


def _chain_len(ch: np.ndarray) -> float:
    return float(np.sum(np.linalg.norm(np.diff(ch, axis=0), axis=1)))


def order_chains(chains: List[np.ndarray],
                 rng: np.random.Generator) -> List[np.ndarray]:
    if not chains:
        return []
    remaining = list(chains)
    first = remaining.pop(int(rng.integers(len(remaining))))
    if bool(rng.integers(2)):
        first = first[::-1]
    ordered = [first]
    cur = first[-1]
    while remaining:
        heads = np.array([ch[0] for ch in remaining])
        tails = np.array([ch[-1] for ch in remaining])
        dh = np.einsum("ij,ij->i", heads - cur, heads - cur)
        dt = np.einsum("ij,ij->i", tails - cur, tails - cur)
        ih, it = int(np.argmin(dh)), int(np.argmin(dt))
        if dh[ih] <= dt[it]:
            ch = remaining.pop(ih)
        else:
            ch = remaining.pop(it)[::-1]
        ordered.append(ch)
        cur = ch[-1]
    return ordered


def smooth_chains(chains: List[np.ndarray], total_points: int,
                  rng: np.random.Generator):
    chains = [ch + rng.normal(0.0, TRACE_JITTER_PX, size=ch.shape)
              for ch in chains]
    chains = [_chaikin(ch, TRACE_CHAIKIN_ROUNDS) for ch in chains]
    lengths = np.array([max(_chain_len(ch), 1e-6) for ch in chains])
    total_len = float(np.sum(lengths))
    parts: List[np.ndarray] = []
    breaks: List[int] = []
    acc = 0
    for ch, ln in zip(chains, lengths):
        n = max(4, int(round(total_points * ln / total_len)))
        res = _resample(ch, n)
        breaks.append(acc)
        parts.append(res)
        acc += len(res)
    return np.vstack(parts), breaks


# ==========================================================================
# Normalization for the frontend
# ==========================================================================
def normalize(path: np.ndarray, w: int, h: int) -> Tuple[np.ndarray, float]:
    """
    Map pixel coords → normalized drawing space:
      x ∈ [0, 1] (left→right), y ∈ [0, 1] (BOTTOM→top, i.e. y flipped to
      match Three.js world space), longest side spans [0,1], aspect returned
      separately so the frontend can size its virtual canvas.
    """
    pts = path.copy()
    pts[:, 1] = h - pts[:, 1]              # flip y: image-down → world-up
    scale = float(max(w, h))
    pts /= scale
    return pts, w / h


# ==========================================================================
# Endpoint
# ==========================================================================
@app.post("/process-image")
async def process_image(
    file: UploadFile = File(...),
    solver: str = Query("2opt", pattern="^(2opt|christofides)$"),
    detail: str = Query("std", pattern="^(fine|std|dense)$"),
    mode: str = Query("trace", pattern="^(trace|scribble)$"),
):
    t_start = time.perf_counter()

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=415, detail="Could not decode image.")

    # Downscale for speed / consistent point density.
    h, w = img.shape[:2]
    if max(h, w) > MAX_IMAGE_DIM:
        f = MAX_IMAGE_DIM / max(h, w)
        img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]

    # Fresh entropy every request → Step D non-determinism is real, not
    # pseudo-repeatable: identical uploads produce different drawings.
    rng = np.random.default_rng(int.from_bytes(os.urandom(8), "little"))

    edges = detect_edges(img)                       # Step A
    breaks = [0]

    if mode == "trace":
        eps, min_chain, output_points, max_strokes = \
            TRACE_LEVELS.get(detail, TRACE_LEVELS["std"])
        chains = trace_chains(edges, eps, min_chain)
        if not chains:
            raise HTTPException(
                status_code=422,
                detail="Not enough edge detail found in the image — try a "
                       "higher-contrast photo (a clear portrait works best).",
            )
        if len(chains) > max_strokes:
            chains.sort(key=_chain_len, reverse=True)
            chains = chains[:max_strokes]
        chains = order_chains(chains, rng)
        path, breaks = smooth_chains(chains, output_points, rng)
        num_sampled = int(sum(len(c) for c in chains))
    else:
        pts = sample_points(edges, rng)             # Step B
        pts = jitter_points(pts, rng)               # Step D (pre-TSP!)

        if solver == "christofides":                # Step C
            path = christofides_path(pts)
        else:
            order = nearest_neighbor_path(pts, rng)
            path = two_opt(pts, order, TWO_OPT_TIME_BUDGET)

        path = smooth_path(path)                    # Step E
        num_sampled = int(len(pts))

    norm, aspect = normalize(path, w, h)

    elapsed = time.perf_counter() - t_start
    length = float(np.sum(np.linalg.norm(np.diff(norm, axis=0), axis=1)))
    log.info("processed %s [%s/%s]: %d pts → %d in %d strokes, len=%.2f, %.2fs",
             file.filename, mode, detail, num_sampled, len(norm), len(breaks),
             length, elapsed)

    return {
        "points": np.round(norm, 5).tolist(),  # [[x, y], ...] normalized, y-up
        "breaks": breaks,                      # stroke start indices (see api/)
        "mode": mode,
        "numStrokes": len(breaks),
        "aspect": aspect,                      # width / height of the source
        "numSampled": num_sampled,
        "pathLength": round(length, 4),        # in normalized units
        "processingSeconds": round(elapsed, 3),
    }


@app.get("/health")
def health():
    return {"status": "ok"}
