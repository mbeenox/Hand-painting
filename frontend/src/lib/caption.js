/**
 * caption.js — "the hand writes" (Feature 5.1).
 *
 * Turns a dedication (and/or a signature) into more of the same thing the
 * backend already sends — ordered polylines with pen lifts between them —
 * and COMPOSES it below the drawing into a single path. Nothing downstream
 * changes: `usePathAnimation` sees one longer path with more breaks,
 * `InkTrail` inks it, `Scene` fires note-on/note-off per letter stroke, and
 * every export composites it for free.
 *
 * Two design rules worth keeping:
 *
 *  1. **The caption is appended AFTER truncation.** A dedication is a
 *     promise, not a level of detail — at 40% Completeness the portrait is a
 *     gestural sketch but "Happy birthday, Mom" is still written in full.
 *
 *  2. **The composition is re-normalized, not extended.** The band is added
 *     to the drawing's box and the whole thing is rescaled so the longest
 *     side is 1 again — exactly the convention the backend emits and
 *     `usePathAnimation` expects. So the portrait makes ROOM for the words
 *     (shrinking ~8–12%) instead of the words hanging off the bottom of the
 *     camera's view, which is what a fixed BOARD_SIZE of 8 would do.
 *
 * All layout constants below are fractions of the drawing box's LONGEST side
 * (which is 1 by the backend's normalization), so they mean the same thing
 * for a square selfie and a wide landscape.
 */
import { layoutBlock, handwrite, asciiFold } from './hershey.js';

const DED_CAP = 0.045;     // dedication cap height ("~4.5% of board height")
const SIG_CAP = 0.030;     // signature cap height — quieter than the dedication,
                           // but the nib width is ABSOLUTE, so shrinking the
                           // letters further just clogs their counters shut
const GAP_TOP = 0.042;     // drawing's bottom edge → first caption ink
const BLOCK_GAP = 0.032;   // dedication's last ink → signature's first ink
const BOTTOM_PAD = 0.065;  // last caption ink → the board's bottom edge.
                           // Bigger than it looks like it needs to be, on
                           // purpose: the board's bottom edge IS the canvas
                           // bottom edge (BOARD_SIZE 8 ≈ the camera's 8.007
                           // visible units), and `useDrawCapture.composite`
                           // stamps the export watermark there — bottom-
                           // right, ~2.2% of canvas height plus its own pad,
                           // i.e. the lowest ~4.2%. A right-aligned
                           // signature at a 3% margin lands ON it in the
                           // saved PNG/video/GIF. Keep this above ~0.055.
const MAX_W = 0.90;        // caption width as a fraction of the drawing width
const SIDE_PAD = 0.05;     // signature's right margin, same fraction
const LINE_GAP = 0.60;     // extra leading, as a fraction of cap height
// Vertex budget for the whole caption. InkTrail preallocates 22 000 ribbon
// centers (Scene.jsx) and the worst backend path — dense trace at span=2 —
// spends ~9.6k of them plus 2 bridge centers per stroke, so the caption has
// a few thousand to work with. This is a target, not a hard cap: a stroke
// can never have fewer vertices than the glyph gave it (measured worst case
// across shapes and texts: ~4.5k, verified in verify_caption.mjs).
const INK_BUDGET = 2600;

// Fit ladder: (maxLines, size multiplier) tried in order of preference. The
// first combination that swallows the text whole wins; a narrow portrait
// simply lands further down the ladder than a landscape does.
const FIT_LADDER = [
  [1, 1.00], [2, 1.00], [2, 0.86], [2, 0.74], [3, 0.74], [3, 0.62],
];

/** The signature the "Sign & date" option writes. ISO date = culture-neutral. */
export function signatureText(date = new Date()) {
  const iso = Number.isNaN(date?.getTime?.()) ? '' : date.toISOString().slice(0, 10);
  return `hypnotic hand - ${iso}`;
}

/**
 * Lay a block out at the largest size on the ladder that fits `text` without
 * dropping any of it. Returns the laid-out block plus the cap height used.
 */
function fitBlock(glyphs, text, { capHeight, maxWidth, align }) {
  const clean = asciiFold(text);
  let block = null;
  let used = capHeight;
  for (const [maxLines, mult] of FIT_LADDER) {
    used = capHeight * mult;
    block = layoutBlock(glyphs, clean, {
      capHeight: used, maxWidth, maxLines, lineGap: LINE_GAP, align,
    });
    if (block.lines.join(' ') === clean) break; // nothing dropped or hard-broken
  }
  return { block, capHeight: used };
}

/** Translate a block's polylines and hand them to the pen as handwriting. */
function place(strokes, dx, dy, capHeight, budget) {
  return handwrite(
    strokes.map((poly) => poly.map(([x, y]) => [x + dx, y + dy])),
    capHeight,
    { budget }
  );
}

/**
 * Build the caption band for a drawing whose box is [0,boxW] × [0,boxH].
 *
 * Returned strokes live in that SAME coordinate space with NEGATIVE y (below
 * the drawing); `bandH` is how far down the band reaches, including the
 * bottom margin. Empty text in → `{ strokes: [], bandH: 0 }`.
 */
export function buildCaption(glyphs, {
  dedication = '', signature = '', boxW = 1, boxH = 1,
} = {}) {
  const unit = Math.max(boxW, boxH); // 1 for backend output; explicit anyway
  const maxWidth = boxW * MAX_W;
  const strokes = [];
  let y = 0; // lowest ink so far, measured down from the drawing's bottom edge

  const addBlock = (text, capFrac, align, gap, budget) => {
    if (!asciiFold(text)) return;
    const { block, capHeight } = fitBlock(glyphs, text, {
      capHeight: unit * capFrac, maxWidth, align,
    });
    if (!block.strokes.length) return;
    const dx = align === 'right' ? boxW * (1 - SIDE_PAD) : boxW / 2;
    const dy = y - unit * gap - block.top; // put the block's TOP ink at the gap
    strokes.push(...place(block.strokes, dx, dy, capHeight, budget));
    y = dy + block.bottom;
  };

  // The dedication is the message and gets most of the vertices; the
  // signature is short enough that its share is never the binding limit.
  addBlock(dedication, DED_CAP, 'center', GAP_TOP, INK_BUDGET * 0.78);
  addBlock(signature, SIG_CAP, 'right', strokes.length ? BLOCK_GAP : GAP_TOP,
           INK_BUDGET * 0.22);

  if (!strokes.length) return { strokes: [], bandH: 0 };
  return { strokes, bandH: -y + unit * BOTTOM_PAD };
}

/**
 * Append a caption to a backend path (already truncated by the Completeness
 * dial). Returns a NEW pathData in the backend's own contract — normalized
 * points, stroke `breaks`, `aspect`, `pathLength` — so callers can treat it
 * as if it had come off the wire.
 *
 * No caption text (or no glyphs) → the input object is returned UNCHANGED,
 * which is what keeps the no-dedication path byte-identical to before.
 */
export function appendCaption(data, glyphs, {
  dedication = '', signDate = false, date = undefined,
} = {}) {
  if (!data || !Array.isArray(data.points) || data.points.length < 2) return data;
  if (!glyphs || !glyphs.size) return data;

  const ded = asciiFold(dedication);
  const sig = signDate ? signatureText(date ?? new Date()) : '';
  if (!ded && !sig) return data;

  const aspect = Number(data.aspect) > 0 ? Number(data.aspect) : 1;
  const boxW = aspect >= 1 ? 1 : aspect;
  const boxH = aspect >= 1 ? 1 / aspect : 1;

  const { strokes, bandH } = buildCaption(glyphs, {
    dedication: ded, signature: sig, boxW, boxH,
  });
  if (!strokes.length) return data;

  // Re-normalize the drawing + band so the longest side spans 1 again. Both
  // the drawing (y ≥ 0) and the band (y < 0) take the SAME transform, because
  // the band was built in the drawing's own coordinates.
  const totalH = boxH + bandH;
  const s = 1 / Math.max(boxW, totalH);
  const map = ([x, y]) => [x * s, (y + bandH) * s];

  const points = data.points.map(map);
  const breaks = (Array.isArray(data.breaks) && data.breaks.length
    ? data.breaks.slice()
    : [0]).filter((b) => b < points.length);

  for (const poly of strokes) {
    if (poly.length < 2) continue;
    breaks.push(points.length); // the pen lifts to reach each letter stroke
    for (const p of poly) points.push(map(p));
  }

  let pathLength = 0;
  for (let i = 1; i < points.length; i++) {
    pathLength += Math.hypot(points[i][0] - points[i - 1][0],
                             points[i][1] - points[i - 1][1]);
  }

  return {
    ...data,
    points,
    breaks,
    numStrokes: breaks.length,
    aspect: boxW / totalH,
    pathLength: Math.round(pathLength * 10000) / 10000,
    caption: { dedication: ded, signature: sig, strokes: strokes.length },
  };
}
