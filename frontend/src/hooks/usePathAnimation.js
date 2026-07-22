/**
 * usePathAnimation — turns the backend's [[x,y],...] array into a
 * time-parameterized pen trajectory with HUMAN-LIKE variable speed.
 *
 * Biomechanics model
 * ------------------
 * Real hands obey (approximately) the "two-thirds power law" of human
 * motor control: angular velocity scales with curvature, i.e. we slow
 * down through tight curves and sweep quickly along straights. We fake
 * this cheaply:
 *
 *   1. curvature κ_i at each vertex ≈ turn angle between the incoming and
 *      outgoing segments divided by mean segment length,
 *   2. per-segment speed weight  v_i = 1 / (1 + K·κ̂_i)  where κ̂ is
 *      curvature normalized to [0,1] — straight lines get v≈1, hairpins
 *      get v≈1/(1+K),
 *   3. per-segment duration     dt_i = dist_i / v_i,
 *   4. prefix-sum the dt_i and rescale so Σdt = total duration (~20 s),
 *      giving a lookup table  time → arc position,
 *   5. at runtime, binary-search the elapsed time into that table and
 *      lerp inside the segment. A global ease-in/out envelope on top
 *      gives the pen a gentle start and a settling finish.
 *
 * The hook returns { getPoint(elapsed, out), duration, worldPoints } —
 * getPoint writes into a caller-provided Vector3 (zero allocation per
 * frame).
 */
import { useMemo } from 'react';
import * as THREE from 'three';

const CURVE_SLOWDOWN = 3.0; // K: how hard curves brake the pen

// Global pacing envelope. A gentle ease-IN so the pen starts smoothly, a long
// constant-speed cruise, then a SHORT ease-OUT so the line finishes with clear
// intent. The previous symmetric smootherstep spent the last ~15% of the time
// drawing the last ~1% of the path — the pen crept to a near-stop and the
// drawing appeared to stall before it was done. This asymmetric trapezoid
// (velocity ramps up, cruises, ramps briefly down) keeps the pen visibly
// moving until it lands on the final point.
const EASE_IN = 0.16;
const EASE_OUT = 0.06;
function paceEnvelope(u) {
  const area = 1 - EASE_IN / 2 - EASE_OUT / 2; // ∫ of the trapezoidal speed
  if (u < EASE_IN) return (u * u) / (2 * EASE_IN) / area;
  if (u <= 1 - EASE_OUT) return (EASE_IN / 2 + (u - EASE_IN)) / area;
  const d = 1 - u;
  return (area - (d * d) / (2 * EASE_OUT)) / area;
}

export function usePathAnimation(points, aspect, duration, boardSize = 8) {
  return useMemo(() => {
    if (!points || points.length < 2) return null;

    // ------------------------------------------------------------------
    // 1. Map normalized path space → world space, centered on the origin.
    //    Backend guarantees x,y ∈ [0,1] with the LONGEST side spanning 1,
    //    y already up. We center and scale so the drawing fits boardSize.
    // ------------------------------------------------------------------
    const w = aspect >= 1 ? 1 : aspect;       // normalized width
    const h = aspect >= 1 ? 1 / aspect : 1;   // normalized height
    const worldPoints = points.map(([x, y]) =>
      new THREE.Vector3((x - w / 2) * boardSize, (y - h / 2) * boardSize, 0)
    );

    const n = worldPoints.length;

    // ------------------------------------------------------------------
    // 2. Segment lengths + vertex curvature (turn angle per unit length).
    // ------------------------------------------------------------------
    const segLen = new Float32Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      segLen[i] = worldPoints[i].distanceTo(worldPoints[i + 1]);
    }

    const curvature = new Float32Array(n).fill(0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 1; i < n - 1; i++) {
      a.subVectors(worldPoints[i], worldPoints[i - 1]).normalize();
      b.subVectors(worldPoints[i + 1], worldPoints[i]).normalize();
      // angle between segment directions ∈ [0, π]; κ ≈ θ / mean chord
      const theta = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
      const meanChord = 0.5 * (segLen[i - 1] + segLen[i]) + 1e-6;
      curvature[i] = theta / meanChord;
    }
    // Normalize curvature to [0,1] by its 90th percentile (robust to spikes).
    const sorted = Float32Array.from(curvature).sort();
    const p90 = sorted[Math.floor(0.9 * (n - 1))] || 1;

    // ------------------------------------------------------------------
    // 3–4. Per-segment durations → cumulative timetable, rescaled.
    // ------------------------------------------------------------------
    const cumTime = new Float32Array(n);
    for (let i = 0; i < n - 1; i++) {
      const kHat = Math.min(1, ((curvature[i] + curvature[i + 1]) * 0.5) / p90);
      const speed = 1 / (1 + CURVE_SLOWDOWN * kHat); // v_i
      cumTime[i + 1] = cumTime[i] + segLen[i] / Math.max(speed, 1e-4);
    }
    const total = cumTime[n - 1];
    for (let i = 0; i < n; i++) cumTime[i] = (cumTime[i] / total) * duration;

    // ------------------------------------------------------------------
    // 5. Runtime sampler: elapsed seconds → world position (binary search).
    // ------------------------------------------------------------------
    function getPoint(elapsed, out) {
      // Global pacing envelope: warp raw time so the pen cruises and lands.
      const t = paceEnvelope(THREE.MathUtils.clamp(elapsed / duration, 0, 1)) * duration;

      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cumTime[mid] <= t) lo = mid; else hi = mid;
      }
      const span = cumTime[hi] - cumTime[lo] || 1e-6;
      const f = (t - cumTime[lo]) / span;
      return out.lerpVectors(worldPoints[lo], worldPoints[hi], f);
    }

    return { getPoint, duration, worldPoints };
  }, [points, aspect, duration, boardSize]);
}
