"""Offline test of the image→path pipeline: runs it twice on a portrait,
renders both paths to PNG, and checks timing + non-determinism."""
import os
import time

import cv2
import numpy as np

import main as m


def get_test_image() -> np.ndarray:
    """Use skimage's 'camera' portrait if available, else synthesize a face."""
    try:
        from skimage import data
        img = data.camera()  # 512x512 grayscale photographer portrait
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    except Exception:
        img = np.full((512, 512, 3), 235, np.uint8)
        cv2.ellipse(img, (256, 260), (140, 180), 0, 0, 360, (90, 90, 90), 3)
        cv2.ellipse(img, (205, 220), (28, 16), 0, 0, 360, (60, 60, 60), 3)
        cv2.ellipse(img, (307, 220), (28, 16), 0, 0, 360, (60, 60, 60), 3)
        cv2.circle(img, (205, 222), 7, (40, 40, 40), -1)
        cv2.circle(img, (307, 222), 7, (40, 40, 40), -1)
        cv2.ellipse(img, (256, 290), (18, 30), 0, 20, 160, (70, 70, 70), 3)
        cv2.ellipse(img, (256, 350), (55, 22), 0, 10, 170, (60, 60, 60), 3)
        cv2.ellipse(img, (256, 150), (150, 80), 0, 180, 360, (50, 50, 50), 4)
        return img


def run_once(img, tag):
    t0 = time.perf_counter()
    rng = np.random.default_rng(int.from_bytes(os.urandom(8), "little"))
    h, w = img.shape[:2]
    edges = m.detect_edges(img)
    pts = m.sample_points(edges, rng)
    pts = m.jitter_points(pts, rng)
    order = m.nearest_neighbor_path(pts, rng)
    path = m.two_opt(pts, order, m.TWO_OPT_TIME_BUDGET)
    path = m.smooth_path(path)
    norm, aspect = m.normalize(path, w, h)
    dt = time.perf_counter() - t0
    length = float(np.sum(np.linalg.norm(np.diff(norm, axis=0), axis=1)))
    print(f"[{tag}] sampled={len(pts)} out={len(norm)} len={length:.2f} "
          f"aspect={aspect:.3f} time={dt:.2f}s")

    # Render the path as the frontend would draw it.
    canvas = np.full((h, w, 3), 250, np.uint8)
    px = (norm * max(w, h)).astype(np.int32)
    px[:, 1] = h - px[:, 1]  # un-flip for image space
    for i in range(len(px) - 1):
        cv2.line(canvas, tuple(px[i]), tuple(px[i + 1]), (40, 30, 20), 1, cv2.LINE_AA)
    out = f"preview_{tag}.png"
    cv2.imwrite(out, canvas)
    return norm


img = get_test_image()
cv2.imwrite("test_input.png", img)
a = run_once(img, "run1")
b = run_once(img, "run2")

# Non-determinism check: same image, two runs → paths must differ.
same_len = min(len(a), len(b))
diff = np.mean(np.linalg.norm(a[:same_len] - b[:same_len], axis=1))
print(f"mean pointwise divergence between runs: {diff:.4f} (must be > 0)")
assert diff > 1e-3, "Runs are identical — non-determinism broken!"
print("OK: pipeline works, runs are unique.")
