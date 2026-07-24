/**
 * truncatePath — the client half of the Completeness dial.
 *
 * The backend orders strokes in ARTIST PASSES (big contours → structure →
 * fine details; see order_chains_in_passes), so any prefix of the path is a
 * coherent sketch. This helper cuts that prefix: keep whole strokes until
 * the drawn ink reaches `fraction` of the total path length, then lift the
 * pen for good. Cutting at stroke boundaries only — an artist finishes the
 * stroke they started.
 *
 * Applied ONCE per run (in App.handleImage, like detail/mode), so a
 * mid-draw slider change waits for the next drawing.
 */
export function truncatePath(data, fraction) {
  const frac = Number(fraction);
  if (!data || !Array.isArray(data.points) || !(frac > 0) || frac >= 0.999) {
    return data;
  }
  const pts = data.points;
  const breaks = Array.isArray(data.breaks) && data.breaks.length
    ? data.breaks
    : [0];

  // Cumulative length over the whole path (hop segments included — they're
  // a tiny share and this matches how the backend reports pathLength).
  const cum = new Array(pts.length).fill(0);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  const total = cum[pts.length - 1];
  if (!(total > 0)) return data;
  const target = total * Math.min(1, Math.max(0.05, frac));

  // Keep every stroke that STARTS at or before the target; cut where the
  // first stroke beyond it begins.
  let cut = pts.length;
  for (let s = 1; s < breaks.length; s++) {
    if (cum[breaks[s]] > target) { cut = breaks[s]; break; }
  }
  // Always draw at least the first stroke.
  if (cut < 2) cut = breaks.length > 1 ? breaks[1] : pts.length;
  if (cut >= pts.length) return data;

  const points = pts.slice(0, cut);
  const newBreaks = breaks.filter((b) => b < cut);
  return {
    ...data,
    points,
    breaks: newBreaks,
    numStrokes: newBreaks.length,
    pathLength: Math.round(cum[cut - 1] * 10000) / 10000,
    completeness: frac,
  };
}
