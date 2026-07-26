/**
 * composeDuet.js — two photographs, one drawing (Feature 4.3).
 *
 * Two portraits are traced by two parallel calls to the SAME backend
 * endpoint, then welded here into a single path: side by side with a gutter,
 * strokes interleaved so the hand alternates between them. Downstream,
 * nothing knows it is a duet — `usePathAnimation` sees one path with more
 * breaks, `InkTrail` inks it, the capture composites it, and the pen-up hop
 * across the gutter is just a longer version of the hops it already flies.
 *
 * Three decisions carry this file:
 *
 *  1. **Interleave by PROPORTIONAL index, not alternation.** The backend
 *     orders strokes in artist passes (contours → structure → details), and
 *     the Completeness dial depends on any prefix being a coherent sketch.
 *     Alternating 1:1 would finish a 120-stroke portrait long before a
 *     440-stroke one and leave the hand grinding away at one side; stepping
 *     each panel by its own normalized progress keeps BOTH in the same pass
 *     at the same moment, so they finish together and a truncated duet is two
 *     equally-unfinished sketches rather than one finished and one abandoned.
 *
 *  2. **The panel is derived from the pen's x, not carried as data.** The
 *     obvious design is a per-stroke `panel` array, but that array would then
 *     have to be sliced by `truncatePath`, extended by `appendCaption`, and
 *     kept in sync by every future transform — a standing invariant with no
 *     enforcement. A single `duet.splitX` costs one comparison at note-on and
 *     cannot fall out of sync, because the pen's position IS the truth.
 *
 *  3. **Panels share a HEIGHT, not a width.** Two portraits of different
 *     aspect ratios read as a pair when their eye-lines can align; matching
 *     widths instead would make a square photo tower over a tall one.
 */

const GUTTER = 0.08;   // gap between panels, as a fraction of panel height

/** The box a source path occupies in its own normalized frame. */
function sourceBox(aspect) {
  const a = Number(aspect) > 0 ? Number(aspect) : 1;
  return { w: a >= 1 ? 1 : a, h: a >= 1 ? 1 / a : 1 };
}

/** Stroke index ranges [start, end) for one path. */
function strokeRanges(data) {
  const n = data.points.length;
  const breaks = (Array.isArray(data.breaks) && data.breaks.length ? data.breaks : [0])
    .filter((b) => Number.isInteger(b) && b >= 0 && b < n)
    .sort((x, y) => x - y);
  if (!breaks.length || breaks[0] !== 0) breaks.unshift(0);
  return breaks.map((b, i) => [b, i + 1 < breaks.length ? breaks[i + 1] : n])
    .filter(([s, e]) => e - s >= 2);
}

// Target number of times the hand crosses the gutter over a whole duet.
// Measured: alternating every single stroke (560 strokes) sent the composed
// path length from ~55 to 388 — the pen spent most of the performance flying
// across the gap, which both wrecked the pacing and skewed the Completeness
// dial toward travel rather than ink. Working in RUNS fixes it, and is what a
// person would do anyway: a few strokes on one portrait, then a few on the
// other. It also makes the music trade phrases instead of alternating notes.
const TARGET_CROSSINGS = 44;
const MAX_RUN = 24;
// Floor on the number of alternations. Without it, a sparse pair (few
// strokes each) collapses to "draw all of A, then all of B" — which is the
// very failure runs were meant to avoid: truncating that at 40% finishes one
// portrait and never starts the other.
const MIN_ROUNDS = 6;

/**
 * Order two stroke lists so both panels advance together, in RUNS rather than
 * one stroke at a time. Run lengths are proportional, so a 400-stroke
 * portrait and a 100-stroke one still finish at the same moment.
 * Emits [panelIndex, range] pairs.
 */
export function interleave(a, b) {
  if (!a.length || !b.length) {
    return [...a.map((r) => [0, r]), ...b.map((r) => [1, r])];
  }
  const total = a.length + b.length;
  const rounds = Math.min(
    a.length, b.length,
    Math.max(MIN_ROUNDS, Math.round(total / (TARGET_CROSSINGS / 2)))
  );
  const clampRun = (n) => Math.max(1, Math.min(MAX_RUN, n));
  const out = [];
  let i = 0;
  let j = 0;
  for (let r = 0; r < rounds; r++) {
    const left = rounds - r;
    const runA = clampRun(Math.ceil((a.length - i) / left));
    const runB = clampRun(Math.ceil((b.length - j) / left));
    for (let k = 0; k < runA && i < a.length; k++) out.push([0, a[i++]]);
    for (let k = 0; k < runB && j < b.length; k++) out.push([1, b[j++]]);
  }
  while (i < a.length) out.push([0, a[i++]]);   // remainders from clamping
  while (j < b.length) out.push([1, b[j++]]);
  return out;
}

/**
 * Weld two traced paths into one duet path.
 *
 * Returns the backend's own contract — normalized points with the longest
 * side spanning 1, ascending `breaks`, an `aspect` describing the box — plus
 * `duet.splitX` (where one portrait ends and the other begins) and `panels`
 * (each portrait's rectangle, so the ghost reveal can put the right photo
 * under the right drawing).
 *
 * Either side missing → the other is returned untouched, so a half-failed
 * duet degrades to an ordinary single drawing instead of an error.
 */
export function composeDuet(dataA, dataB, { gutter = GUTTER } = {}) {
  const okA = dataA && Array.isArray(dataA.points) && dataA.points.length >= 2;
  const okB = dataB && Array.isArray(dataB.points) && dataB.points.length >= 2;
  if (!okA || !okB) return okA ? dataA : (okB ? dataB : null);

  const boxA = sourceBox(dataA.aspect);
  const boxB = sourceBox(dataB.aspect);
  // Normalize each panel to height 1; its width becomes its aspect ratio.
  const kA = 1 / boxA.h;
  const kB = 1 / boxB.h;
  const wA = boxA.w * kA;
  const wB = boxB.w * kB;
  const offB = wA + gutter;

  const totalW = wA + gutter + wB;
  const totalH = 1;
  const s = 1 / Math.max(totalW, totalH);

  const mapA = ([x, y]) => [x * kA * s, y * kA * s];
  const mapB = ([x, y]) => [(x * kB + offB) * s, y * kB * s];

  const order = interleave(strokeRanges(dataA), strokeRanges(dataB));
  const points = [];
  const breaks = [];
  for (const [panel, [start, end]] of order) {
    const src = panel === 0 ? dataA : dataB;
    const map = panel === 0 ? mapA : mapB;
    breaks.push(points.length);
    for (let i = start; i < end; i++) points.push(map(src.points[i]));
  }
  if (points.length < 2) return okA ? dataA : dataB;

  let pathLength = 0;
  for (let i = 1; i < points.length; i++) {
    pathLength += Math.hypot(points[i][0] - points[i - 1][0],
                             points[i][1] - points[i - 1][1]);
  }

  // Ink-weighted so the composed dial still means what it meant per photo.
  const inkA = Number(dataA.pathLength) || 1;
  const inkB = Number(dataB.pathLength) || 1;
  const bf = (bA, bB) => ((Number(bA) || 1) * inkA + (Number(bB) || 1) * inkB)
    / (inkA + inkB);

  return {
    mode: dataA.mode ?? 'trace',
    points,
    breaks,
    numStrokes: breaks.length,
    aspect: totalW / totalH,
    pathLength: Math.round(pathLength * 10000) / 10000,
    baseFrac: Math.min(1, Math.max(0.05, bf(dataA.baseFrac, dataB.baseFrac))),
    // Everything a duet needs downstream, and nothing that has to be kept in
    // sync by hand: one split coordinate and the two panel rectangles.
    duet: { splitX: (wA + gutter / 2) * s },
    panels: [
      { x0: 0, y0: 0, x1: wA * s, y1: kA * boxA.h * s },
      { x0: offB * s, y0: 0, x1: (offB + wB) * s, y1: kB * boxB.h * s },
    ],
  };
}
