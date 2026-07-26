/**
 * verify_duet.mjs — unit checks for the two-photo duet (4.3).
 *
 *   node frontend/scripts/verify_duet.mjs
 *
 * A duet composes into the SAME contract the backend emits, because every
 * downstream stage — usePathAnimation, InkTrail, truncatePath, appendCaption,
 * the capture — trusts that contract and none of them know a duet exists.
 * These checks are what keeps that true, plus the two properties the feature
 * actually rests on: the panels stay apart, and the interleave keeps both
 * portraits at the same stage of completion.
 */
import { composeDuet, interleave } from '../src/lib/composeDuet.js';
import { truncatePath } from '../src/lib/truncatePath.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A synthetic traced portrait: `strokes` diagonal strokes filling its box. */
function fake(aspect, strokes, ptsPer = 20) {
  const w = aspect >= 1 ? 1 : aspect;
  const h = aspect >= 1 ? 1 / aspect : 1;
  const points = [];
  const breaks = [];
  for (let s = 0; s < strokes; s++) {
    breaks.push(points.length);
    const f = s / Math.max(1, strokes - 1);
    for (let i = 0; i < ptsPer; i++) {
      points.push([f * w, (i / (ptsPer - 1)) * h]);
    }
  }
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return { points, breaks, numStrokes: strokes, aspect, pathLength: len,
           baseFrac: 0.7, mode: 'trace' };
}

// ---------------------------------------------------------------------------
console.log('\ninterleave');
{
  const a = Array.from({ length: 8 }, (_, i) => [i, i + 1]);
  const b = Array.from({ length: 2 }, (_, i) => [i, i + 1]);
  const order = interleave(a, b);
  check('emits every stroke exactly once', order.length === 10
    && order.filter(([p]) => p === 0).length === 8
    && order.filter(([p]) => p === 1).length === 2);
  // Both panels should be ~the same fraction done at any point — that is what
  // makes a truncated duet two equal sketches instead of one abandoned one.
  let worst = 0;
  let ia = 0;
  let ib = 0;
  for (const [p] of order) {
    if (p === 0) ia++; else ib++;
    worst = Math.max(worst, Math.abs(ia / 8 - ib / 2));
  }
  check('panels stay in step throughout', worst <= 0.5, `worst skew ${worst.toFixed(2)}`);
  // The smaller panel must not be exhausted early and leave the hand working
  // one side alone: its last stroke should land near the end of the run.
  const lastB = order.map(([p]) => p).lastIndexOf(1);
  check('the shorter portrait lasts to the end', lastB >= order.length - 2,
    `last right-panel stroke at ${lastB + 1}/${order.length}`);
  check('empty side degrades gracefully',
    interleave(a, []).length === 8 && interleave([], b).length === 2);
}

// ---------------------------------------------------------------------------
console.log('\ncomposition contract');
const A = fake(0.75, 40);   // tall portrait
const B = fake(1.30, 15);   // wide portrait, far fewer strokes
const duet = composeDuet(A, B);

check('missing side returns the other untouched',
  composeDuet(A, null) === A && composeDuet(null, B) === B
  && composeDuet(null, null) === null);

const xs = duet.points.map((p) => p[0]);
const ys = duet.points.map((p) => p[1]);
const bw = duet.aspect >= 1 ? 1 : duet.aspect;
const bh = duet.aspect >= 1 ? 1 / duet.aspect : 1;
check('declared box has a unit long side', near(Math.max(bw, bh), 1, 1e-9),
  `aspect ${duet.aspect.toFixed(4)}`);
check('every point inside the declared box',
  Math.min(...xs) >= -1e-9 && Math.max(...xs) <= bw + 1e-9
  && Math.min(...ys) >= -1e-9 && Math.max(...ys) <= bh + 1e-9,
  `x ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)}`);
check('a duet is landscape', duet.aspect > 1, `${duet.aspect.toFixed(2)}`);
check('breaks ascend, start at 0, stay in range',
  duet.breaks[0] === 0
  && duet.breaks.every((b, i) => Number.isInteger(b) && b < duet.points.length
    && (i === 0 || b > duet.breaks[i - 1])));
check('every stroke survives', duet.numStrokes === 40 + 15, `${duet.numStrokes}`);
check('all points finite', duet.points.every(([x, y]) =>
  Number.isFinite(x) && Number.isFinite(y)));
check('pathLength recomputed for the composition', duet.pathLength > 0);
check('baseFrac carried through', duet.baseFrac > 0 && duet.baseFrac <= 1,
  duet.baseFrac.toFixed(3));

// ---------------------------------------------------------------------------
console.log('\npanels and the gutter');
const [pA, pB] = duet.panels;
check('panels do not overlap', pA.x1 < pB.x0, `gap ${(pB.x0 - pA.x1).toFixed(4)}`);
check('split sits inside the gutter',
  duet.duet.splitX > pA.x1 && duet.duet.splitX < pB.x0,
  `splitX ${duet.duet.splitX.toFixed(4)}`);
check('panels share a baseline and a height',
  near(pA.y0, pB.y0) && near(pA.y1, pB.y1, 1e-9),
  `A ${pA.y1.toFixed(3)} vs B ${pB.y1.toFixed(3)}`);
check('panel widths follow their aspect ratios',
  near((pA.x1 - pA.x0) / (pA.y1 - pA.y0), 0.75, 1e-6)
  && near((pB.x1 - pB.x0) / (pB.y1 - pB.y0), 1.30, 1e-6));

// The split must actually separate the two portraits' ink, because that is
// what the music uses to decide which instrument is playing.
{
  const ranges = [];
  for (let i = 0; i < duet.breaks.length; i++) {
    const s = duet.breaks[i];
    const e = i + 1 < duet.breaks.length ? duet.breaks[i + 1] : duet.points.length;
    const mid = duet.points[Math.floor((s + e) / 2)][0];
    ranges.push(mid < duet.duet.splitX ? 0 : 1);
  }
  check('splitX classifies every stroke to exactly one panel',
    ranges.filter((r) => r === 0).length === 40
    && ranges.filter((r) => r === 1).length === 15,
    `${ranges.filter((r) => r === 0).length}/40 left, ${ranges.filter((r) => r === 1).length}/15 right`);
  // No stroke may straddle the gutter.
  let straddles = 0;
  for (let i = 0; i < duet.breaks.length; i++) {
    const s = duet.breaks[i];
    const e = i + 1 < duet.breaks.length ? duet.breaks[i + 1] : duet.points.length;
    const side = duet.points[s][0] < duet.duet.splitX;
    for (let k = s; k < e; k++) {
      if ((duet.points[k][0] < duet.duet.splitX) !== side) { straddles++; break; }
    }
  }
  check('no stroke crosses the gutter', straddles === 0, `${straddles} straddling`);
}

// ---------------------------------------------------------------------------
console.log('\ntruncation cuts both portraits, not one');
for (const label of [0.4, 0.7]) {
  const cut = truncatePath(duet, label);
  let left = 0;
  let right = 0;
  for (let i = 0; i < cut.breaks.length; i++) {
    const s = cut.breaks[i];
    const e = i + 1 < cut.breaks.length ? cut.breaks[i + 1] : cut.points.length;
    if (cut.points[Math.floor((s + e) / 2)][0] < duet.duet.splitX) left++; else right++;
  }
  const shareL = left / 40;
  const shareR = right / 15;
  check(`at ${label * 100}%: both portraits are equally far along`,
    Math.abs(shareL - shareR) < 0.2 && shareL > 0 && shareR > 0,
    `left ${(shareL * 100).toFixed(0)}% · right ${(shareR * 100).toFixed(0)}%`);
}

// ---------------------------------------------------------------------------
console.log('\nsingle-photo path is untouched');
{
  const solo = fake(0.8, 30);
  const before = JSON.stringify(solo);
  composeDuet(solo, null);
  check('composing with a missing side mutates nothing', JSON.stringify(solo) === before);
  check('a solo path carries no duet marker', !solo.duet && !solo.panels);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall duet checks passed\n');
process.exit(failures ? 1 : 0);
