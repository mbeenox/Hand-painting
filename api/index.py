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

# Per-request detail presets, chosen via ?detail=… on the endpoint →
# (max_points, output_points). "std" mirrors the module defaults above.
DETAIL_LEVELS = {
    "fine":  (900, 2200),    # sparser, more minimal single line
    "std":   (MAX_POINTS, OUTPUT_POINTS),
    "dense": (1900, 3600),   # more coverage → fuller, more detailed
}

# Faithful "trace" mode presets, chosen via ?detail=… when mode=trace →
# (approx_epsilon_px, min_chain_px, output_points, max_strokes).
# Smaller epsilon / min_chain keeps more of the fine features.
TRACE_LEVELS = {
    "fine":  (1.6, 14, 2600, 140),
    "std":   (1.1, 10, 3400, 220),
    "dense": (0.8,  7, 4600, 320),
}
TRACE_JITTER_PX = 1.1      # per-run uniqueness for trace mode
TRACE_CHAIKIN_ROUNDS = 2   # per-chain corner softening (lighter than TSP's 3)


# ==========================================================================
# Step A — Edge detection (identical to backend/main.py)
# ==========================================================================
# ---------------------------------------------------------------------------
# Face focus (camera feature, 2026-07-24). Busy backgrounds steal the stroke
# budget from the subject: every strong background edge becomes chains that
# compete with the face for max_strokes and output_points. When the client
# asks for focus=face (the in-app camera does), we detect frontal faces and
# BLUR everything outside a feathered face mask BEFORE edge detection — the
# optical equivalent of shooting portrait-mode: background edges melt away,
# the trace budget flows to the face. No face found → complete no-op.
#
# The cascade ships IN THIS DIRECTORY: Vercel's excludeFiles strips
# **/cv2/data/** to stay under the function size cap, so cv2.data.haarcascades
# is EMPTY in production. Never load from cv2.data here.
# ---------------------------------------------------------------------------
_CASCADE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "haarcascade_frontalface_default.xml")
_FACE_CASCADE = None


def _get_face_cascade():
    global _FACE_CASCADE
    if _FACE_CASCADE is None:
        c = cv2.CascadeClassifier(_CASCADE_PATH)
        _FACE_CASCADE = c if not c.empty() else False
    return _FACE_CASCADE or None


def face_focus(img_bgr: np.ndarray):
    """Blur the background behind detected faces.
    Returns (image, n_faces, keep_mask | None). The mask is ALSO used to
    hard-gate edges after Canny: gradient-percentile thresholds adapt to the
    (now mostly-blurred) image and re-sensitize, so blur remnants alone still
    leak ghost blobs into the trace."""
    cascade = _get_face_cascade()
    if cascade is None:
        return img_bgr, 0, None
    h, w = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    min_side = max(48, int(min(h, w) * 0.10))  # ignore speck-sized detections
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side)
    )
    if len(faces) == 0:
        return img_bgr, 0, None

    # Feathered keep-mask: an ellipse per face, expanded well past the Haar
    # box (which crops at the hairline and chin — hair and jaw ARE the
    # portrait), then a wide Gaussian feather so the blur ramps in gently
    # instead of cutting a halo.
    mask = np.zeros((h, w), dtype=np.float32)
    for (x, y, fw, fh) in faces:
        cx, cy = x + fw / 2.0, y + fh / 2.0
        # Head ellipse: 1.6x box width, 2.1x box height (hair above, chin below)
        cv2.ellipse(mask, (int(cx), int(cy - fh * 0.05)),
                    (int(fw * 0.80), int(fh * 1.05)), 0, 0, 360, 1.0, -1)
        # Bust ellipse: a portrait is head AND shoulders, not a floating
        # head — keep a classic bust-shaped region below the face.
        cv2.ellipse(mask, (int(cx), int(cy + fh * 1.9)),
                    (int(fw * 1.9), int(fh * 1.3)), 0, 0, 360, 1.0, -1)
    feather = int(max(h, w) * 0.06) | 1
    mask = cv2.GaussianBlur(mask, (feather, feather), 0)

    # Portrait-mode background: strong blur + slight contrast fade so even
    # high-contrast background edges drop below the Canny thresholds.
    sigma = max(h, w) * 0.008
    blurred = cv2.GaussianBlur(img_bgr, (0, 0), sigma)
    blurred = cv2.addWeighted(blurred, 0.82, np.full_like(blurred, 127), 0.18, 0)

    m3 = mask[:, :, None]
    out = (img_bgr.astype(np.float32) * m3 +
           blurred.astype(np.float32) * (1.0 - m3))
    return out.astype(np.uint8), int(len(faces)), mask


def detect_edges(img_bgr: np.ndarray, hi_pct: float = 92.0) -> np.ndarray:
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    # CLAHE FIRST so faint structure is amplified before smoothing can kill
    # it; gentler bilateral (sigmaColor 50→35) keeps soft edges alive.
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    gray = cv2.bilateralFilter(gray, d=7, sigmaColor=35, sigmaSpace=50)
    # Auto-Canny from the GRADIENT-MAGNITUDE distribution, not the intensity
    # median. The old 0.66/1.33×median thresholds went blind on bright,
    # washed-out photos (white-on-white subjects): a high median pushed the
    # thresholds above every faint edge and whole regions vanished from the
    # drawing. Percentiles of the actual gradients adapt to any contrast.
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    nz = mag[mag > 1.0]
    hi = float(np.percentile(nz, hi_pct)) if len(nz) else 100.0
    edges = cv2.Canny(gray, 0.45 * hi, hi, L2gradient=True)
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
def sample_points(edges: np.ndarray, rng: np.random.Generator,
                  max_points: int = MAX_POINTS) -> np.ndarray:
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
                if len(accepted) > max_points * 3:
                    break
        return np.array(accepted)

    # Binary-search the radius, aiming for the TOP of the range. (The old
    # acceptance band was [MIN_POINTS, max_points], so the search stopped at
    # the FIRST count anywhere in range — usually near the minimum, which
    # made the detail presets nearly indistinguishable.)
    lo_r, hi_r = 1.0, float(max(edges.shape))
    target_lo = max(MIN_POINTS, int(0.9 * max_points))
    best, best_n = None, -1
    for _ in range(18):
        mid = 0.5 * (lo_r + hi_r)
        pts = thin(mid)
        n = len(pts)
        if n > max_points:
            lo_r = mid                     # too dense → grow radius
            if best_n < max_points:
                best, best_n = pts[:max_points], max_points
        else:
            if n > best_n:                 # densest in-cap result so far
                best, best_n = pts, n
            if n >= target_lo:
                break                      # within 90% of the cap → good
            hi_r = mid                     # too sparse → shrink radius
    if best is None or len(best) < MIN_POINTS:
        best = pix[:min(max_points, len(pix))]
    return best[:max_points]


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
def smooth_path(path: np.ndarray, output_points: int = OUTPUT_POINTS) -> np.ndarray:
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

    # Uniform arc-length resample to output_points vertices.
    chords = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(chords)])
    total = s[-1] if s[-1] > 0 else 1.0
    target = np.linspace(0.0, total, output_points)
    x = np.interp(target, s, path[:, 0])
    y = np.interp(target, s, path[:, 1])
    return np.column_stack([x, y])


def normalize(path: np.ndarray, w: int, h: int):
    pts = path.copy()
    pts[:, 1] = h - pts[:, 1]  # flip y: image-down → world-up
    pts /= float(max(w, h))
    return pts, w / h


# ==========================================================================
# TRACE mode — draw the actual edge chains (faithful line portrait)
# ==========================================================================
# The TSP pipeline above scatters points over the edge map and asks a tour
# to connect them, which destroys which-edge-owns-which-point structure: at
# any feasible density the face dissolves into abstract loops. Trace mode
# instead follows each detected edge chain directly — eyes, mouth, and
# outlines survive — and the frontend LIFTS the pen between chains (the
# `breaks` array in the response marks where each new stroke starts).

def _chaikin(path: np.ndarray, rounds: int) -> np.ndarray:
    """Chaikin corner cutting (same math as smooth_path, endpoint-preserving)."""
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
    """Uniform arc-length resample to n vertices (np.interp over chord length)."""
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
    """
    Extract ordered polyline chains from the (thin) Canny edge map.

    cv2.findContours walks the BOUNDARY of each 1-px edge filament — i.e. out
    along one side and back along the other, so the walk is ~2× the filament
    and retraces itself. We detect that out-and-back symmetry (c[k] ≈ c[-k])
    and keep only the outbound half; genuinely closed rings (no symmetry)
    are kept whole. Each chain is then simplified with approxPolyDP so the
    pen draws intentional strokes instead of pixel staircases.
    """
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
    """
    Order chains for drawing: greedy nearest-endpoint chaining (a tiny "TSP
    over strokes") so pen travel between strokes stays short. The starting
    chain is random → each run draws the same portrait in a different order,
    preserving the every-run-is-unique character of the app.
    """
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


def order_chains_in_passes(chains: List[np.ndarray],
                           rng: np.random.Generator) -> List[np.ndarray]:
    """Artist-pass stroke ordering (Completeness dial, 2026-07-24).

    Real sketch artists work in passes: big defining contours first, then
    structure, then fine detail last. Ordering strokes that way makes ANY
    PREFIX of the drawing a coherent sketch — which is what lets the
    client-side Completeness dial simply stop the pen partway and still
    look like an artist chose to stop, not like the photo got amputated.

    Tiers by CUMULATIVE length share (longest chains first): pass 1 = the
    chains that make up the first ~50% of total ink, pass 2 = up to ~85%,
    pass 3 = the remaining short detail flicks. Within each pass the
    existing greedy nearest-endpoint travel (RANDOM start) is kept, so
    per-run uniqueness and the pleasing local hops both survive.
    """
    if len(chains) <= 2:
        return order_chains(chains, rng)
    lens = [_chain_len(c) for c in chains]
    order = sorted(range(len(chains)), key=lambda i: -lens[i])
    total = float(sum(lens)) or 1.0
    tiers = ([], [], [])
    acc = 0.0
    for i in order:
        t = 0 if acc < total * 0.5 else (1 if acc < total * 0.85 else 2)
        tiers[t].append(chains[i])
        acc += lens[i]
    out: List[np.ndarray] = []
    for tier in tiers:
        if tier:
            out.extend(order_chains(tier, rng))
    return out


def smooth_chains(chains: List[np.ndarray], total_points: int,
                  rng: np.random.Generator):
    """
    Jitter (per-run uniqueness) + Chaikin-soften + arc-length-resample every
    chain, allocating the output budget proportionally to chain length.
    Returns (flat_path, breaks) where breaks[i] is the index into flat_path
    at which stroke i starts (breaks[0] == 0).
    """
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
# Endpoint — registered at both the Vercel path and the bare path
# ==========================================================================
async def _process(file: UploadFile, detail: str = "std", mode: str = "trace",
                   focus: str = "none", span: int = 1):
    t_start = time.perf_counter()
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=415, detail="Could not decode image.")
    if mode not in ("trace", "scribble"):
        mode = "trace"

    # Normalize scale in BOTH directions: downscale large uploads AND upscale
    # small ones (e.g. low-res memes) to MAX_IMAGE_DIM, so edge/chain tunables
    # in pixel units mean the same thing for every input and small photos
    # yield just as complete a drawing.
    h, w = img.shape[:2]
    if max(h, w) != MAX_IMAGE_DIM:
        f = MAX_IMAGE_DIM / max(h, w)
        interp = cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC
        img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=interp)
        h, w = img.shape[:2]

    rng = np.random.default_rng(int.from_bytes(os.urandom(8), "little"))

    # Optional face focus (the in-app camera sends focus=face): blur the
    # background behind detected faces so the stroke budget goes to the
    # subject. Silently a no-op when no face is found.
    n_faces = 0
    face_mask = None
    if focus == "face":
        img, n_faces, face_mask = face_focus(img)

    # span=2 (the 200%-completeness tier) also SEES fainter edges (P88 vs
    # P92 Canny) — on clean photos the chain filter alone finds almost
    # nothing new; the edge map itself is the detail ceiling. The BASE edge
    # map is still computed to anchor "100%" (see base-eligibility below).
    edges = detect_edges(img, 85.0 if span == 2 else 92.0)     # A
    base_edges = detect_edges(img) if span == 2 else None
    if face_mask is not None:
        edges[face_mask < 0.22] = 0  # kill ghost edges from blur remnants
        if base_edges is not None:
            base_edges[face_mask < 0.22] = 0
    breaks = [0]

    span = 2 if int(span) == 2 else 1
    base_frac = 1.0
    if mode == "trace":
        eps, min_chain, output_points, max_strokes = \
            TRACE_LEVELS.get(detail, TRACE_LEVELS["std"])
        base_min_chain, base_strokes = min_chain, max_strokes
        if span == 2:
            # 200%-completeness tier: admit the chains the base budget culls
            # (shorter filaments) and double the stroke/point budgets. The
            # base look stays reachable — see base_frac below.
            min_chain = max(4, int(round(min_chain * 0.6)))
            output_points *= 2
            max_strokes *= 2
        chains = trace_chains(edges, eps, min_chain)           # B′ follow edges
        if not chains:
            raise HTTPException(
                status_code=422,
                detail="Not enough edge detail found in the image — try a "
                       "higher-contrast photo (a clear portrait works best).",
            )
        if len(chains) > max_strokes:                          # keep the longest
            chains.sort(key=_chain_len, reverse=True)
            chains = chains[:max_strokes]
        if span == 2 and chains:
            # baseFrac anchors the dial's "100%" to the CLASSIC drawing: a
            # chain is base-eligible iff it (a) actually lies on the BASE
            # (P92) edge map — vertices checked against a 1px-dilated map,
            # ≥50% hits — and (b) passes the base length filter (raw
            # boundary count ≥ min_chain ≈ arc ≥ min_chain/2); then the base
            # stroke cap keeps the longest. baseFrac = their share of ink.
            dil = cv2.dilate(base_edges, np.ones((3, 3), np.uint8))
            h_e, w_e = dil.shape
            elig_lens = []
            all_lens = []
            for c in chains:
                l = _chain_len(c)
                all_lens.append(l)
                # Sample ALONG the polyline (~3px spacing), not just the
                # sparse polyDP vertices — long smooth chains have few
                # vertices and a vertex-only test is noisy.
                n_s = max(4, int(l / 3))
                seg = np.linalg.norm(np.diff(c, axis=0), axis=1)
                cs = np.concatenate([[0.0], np.cumsum(seg)])
                t = np.linspace(0, cs[-1], n_s)
                xi = np.interp(t, cs, c[:, 0])
                yi = np.interp(t, cs, c[:, 1])
                xs = np.clip(xi.astype(int), 0, w_e - 1)
                ys = np.clip(yi.astype(int), 0, h_e - 1)
                on_base = float(np.mean(dil[ys, xs] > 0))
                if on_base >= 0.55 and l >= base_min_chain * 0.5:
                    elig_lens.append(l)
            elig_lens = sorted(elig_lens, reverse=True)[:base_strokes]
            total_l = float(sum(all_lens))
            base_frac = float(sum(elig_lens)) / total_l if total_l > 0 else 1.0
        chains = order_chains_in_passes(chains, rng)                     # C′ stroke order
        path, breaks = smooth_chains(chains, output_points, rng)  # D′+E′
        num_sampled = int(sum(len(c) for c in chains))
    else:  # "scribble" — the original abstract one-line TSP look
        max_points, output_points = DETAIL_LEVELS.get(detail, DETAIL_LEVELS["std"])
        pts = sample_points(edges, rng, max_points)            # B
        pts = jitter_points(pts, rng)                          # D
        order = nearest_neighbor_path(pts, rng)                # C
        path = two_opt(pts, order, TWO_OPT_TIME_BUDGET)        # C
        path = smooth_path(path, output_points)                # E
        num_sampled = int(len(pts))

    norm, aspect = normalize(path, w, h)

    elapsed = time.perf_counter() - t_start
    length = float(np.sum(np.linalg.norm(np.diff(norm, axis=0), axis=1)))
    log.info("processed %s [%s/%s]: %d pts → %d in %d strokes, len=%.2f, %.2fs",
             file.filename, mode, detail, num_sampled, len(norm), len(breaks),
             length, elapsed)

    return {
        "points": np.round(norm, 5).tolist(),
        # Index into `points` where each stroke starts; the frontend lifts
        # the pen on the segment leading INTO each break. [0] ⇒ one stroke
        # (scribble mode) — older clients that ignore this field simply draw
        # the strokes connected, which still renders sensibly.
        "breaks": breaks,
        "mode": mode,
        "numStrokes": len(breaks),
        "aspect": aspect,
        "numSampled": num_sampled,
        "pathLength": round(length, 4),
        "processingSeconds": round(elapsed, 3),
        "facesFocused": n_faces,
        # Anchor for the Completeness dial: fraction of this path's ink that
        # corresponds to the base (span-1) budget. 1.0 for scribble/span-1.
        "baseFrac": round(base_frac, 4),
    }


@app.post("/api/process-image")   # path seen when deployed on Vercel
async def process_image_vercel(file: UploadFile = File(...),
                               detail: str = "std", mode: str = "trace",
                               focus: str = "none", span: int = 1):
    return await _process(file, detail, mode, focus, span)


@app.post("/process-image")       # path seen under bare local uvicorn
async def process_image_local(file: UploadFile = File(...),
                              detail: str = "std", mode: str = "trace",
                              focus: str = "none", span: int = 1):
    return await _process(file, detail, mode, focus, span)


BUILD_MARKER = "2026-07-23-r4-edges"  # bumped per deploy to verify rollouts


@app.get("/api/health")
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/version")
@app.get("/version")
def version():
    return {"build": BUILD_MARKER}
