/**
 * verify_caption.mjs — unit checks for Feature 5.1 ("the hand writes").
 *
 *   node frontend/scripts/verify_caption.mjs
 *
 * Runs in plain Node (no bundler): `hershey.js` keeps its only `?raw` import
 * inside the lazy loader, so the pure functions import cleanly here and the
 * font file is read straight off disk.
 *
 * What it guards:
 *  - the JHF parser against the vendored font (glyph count, ASCII coverage,
 *    coordinate sanity) — a silently mis-parsed font would draw garbage;
 *  - the CONTRACT `appendCaption` has to honour, because everything
 *    downstream (usePathAnimation, InkTrail, the Completeness dial, the
 *    adaptive duration) trusts it: normalized points, longest side exactly 1,
 *    valid ascending stroke breaks, a caption that sits strictly BELOW the
 *    drawing, and an exact no-op when there is nothing to write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseJHF, fontMetrics, asciiFold, layoutBlock, densify, lineToStrokes, handwrite,
} from '../src/lib/hershey.js';
import { buildCaption, appendCaption, signatureText } from '../src/lib/caption.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, '../src/lib/fonts/futural.jhf'), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
console.log('\nfont — futural.jhf');
const glyphs = parseJHF(raw);
check('96 glyph records', glyphs.size === 96, `got ${glyphs.size}`);
check('covers space..~', glyphs.has(' ') && glyphs.has('~') && glyphs.has('A')
  && glyphs.has('z') && glyphs.has('0') && glyphs.has(','));
check('space is blank but advances',
  glyphs.get(' ').strokes.length === 0 && glyphs.get(' ').adv > 0);

let printable = 0;
let bad = 0;
for (let c = 33; c <= 126; c++) {
  const g = glyphs.get(String.fromCharCode(c));
  if (!g) { bad++; continue; }
  if (g.strokes.length) printable++;
  for (const s of g.strokes) {
    if (s.length < 2) bad++;
    for (const [x, y] of s) if (!Number.isFinite(x) || !Number.isFinite(y)) bad++;
  }
}
check('every printable char has ≥1 multi-point stroke', printable === 94 && bad === 0,
  `drawn ${printable}/94, anomalies ${bad}`);

const m = fontMetrics(glyphs);
check('metrics from H', m.capHeight === 21 && m.baseline === 9 && m.capTop === -12,
  `cap ${m.capHeight}, baseline ${m.baseline}`);

// ---------------------------------------------------------------------------
console.log('\ntext folding');
check('accents fold', asciiFold('José & Zoë') === 'Jose & Zoe', asciiFold('José & Zoë'));
check('smart punctuation folds', asciiFold('“don’t”') === '"don\'t"', asciiFold('“don’t”'));
check('emoji/CJK dropped without leaving holes', asciiFold('Hi 🎂 你好 Mom') === 'Hi Mom',
  JSON.stringify(asciiFold('Hi 🎂 你好 Mom')));
check('whitespace collapses', asciiFold('  a \n\t b  ') === 'a b');
check('empty stays empty', asciiFold('') === '' && asciiFold('   ') === '' && asciiFold(null) === '');

// ---------------------------------------------------------------------------
console.log('\nlayout');
const caps = lineToStrokes(glyphs, 'H', 1).strokes.flat();
check('cap height honoured exactly', near(Math.max(...caps.map((p) => p[1])), 1, 1e-9),
  `top ${Math.max(...caps.map((p) => p[1]))}`);
check('baseline at 0', near(Math.min(...caps.map((p) => p[1])), 0, 1e-9));
// The dot on an 'i' legitimately rides ABOVE cap height in this font; the
// caption band budgets from real ink extents, so this only has to stay sane.
const one = lineToStrokes(glyphs, 'Hi', 1);
const oneTop = Math.max(...one.strokes.flat().map((p) => p[1]));
check('ascenders stay within a sane margin', oneTop > 1 && oneTop < 1.15, `top ${oneTop.toFixed(4)}`);
check('descenders stay below the baseline',
  Math.min(...lineToStrokes(glyphs, 'g', 1).strokes.flat().map((p) => p[1])) < 0);
check('x starts at 0 and grows', one.strokes[0][0][0] >= 0 && one.width > 0);

const wide = layoutBlock(glyphs, 'Happy birthday, Mom', { capHeight: 0.045, maxWidth: 10 });
check('short text stays one line', wide.lines.length === 1, wide.lines.join(' | '));
const wrapped = layoutBlock(glyphs, 'Happy birthday, Mom', { capHeight: 0.045, maxWidth: 0.25 });
check('narrow box wraps', wrapped.lines.length === 2, wrapped.lines.join(' | '));
check('wrapped lines descend', wrapped.bottom < 0 && wrapped.top > 0);
check('centered block straddles x=0',
  Math.min(...wrapped.strokes.flat().map((p) => p[0])) < 0
  && Math.max(...wrapped.strokes.flat().map((p) => p[0])) > 0);

const sparse = [[[0, 0], [1, 0]]];
const dense = densify(sparse, 0.1);
check('densify subdivides, keeps ends', dense[0].length === 11
  && near(dense[0][0][0], 0) && near(dense[0][10][0], 1), `${dense[0].length} pts`);
check('densify is a no-op for short segments', densify(sparse, 10)[0].length === 2);

check('signature is ASCII-safe and dated',
  /^hypnotic hand - \d{4}-\d{2}-\d{2}$/.test(signatureText(new Date('2026-07-25T00:00:00Z'))),
  signatureText(new Date('2026-07-25T00:00:00Z')));

// ---------------------------------------------------------------------------
console.log('\ncaption band');
for (const [label, boxW, boxH] of [['portrait 3:4', 0.75, 1], ['square', 1, 1], ['landscape 4:3', 1, 0.75]]) {
  const { strokes, bandH } = buildCaption(glyphs, {
    dedication: 'Happy birthday, Mom', signature: signatureText(new Date(0)), boxW, boxH,
  });
  const xs = strokes.flat().map((p) => p[0]);
  const ys = strokes.flat().map((p) => p[1]);
  check(`${label}: band below the drawing`, Math.max(...ys) < 0, `top ${Math.max(...ys).toFixed(4)}`);
  check(`${label}: band fits its declared height`, Math.min(...ys) > -bandH,
    `low ${Math.min(...ys).toFixed(4)} vs bandH ${bandH.toFixed(4)}`);
  check(`${label}: stays inside the width`, Math.min(...xs) >= 0 && Math.max(...xs) <= boxW,
    `x ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)} of ${boxW}`);
  // Swept across box shapes (0.5×1 … 1×0.5) and dedications up to the UI's
  // 48-character cap, the band tops out at 0.371 — a long message on a tall
  // narrow portrait. Anything past 0.40 means the layout has run away.
  check(`${label}: band is a sane share of the frame`, bandH > 0.08 && bandH < 0.40,
    `bandH ${bandH.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log('\nappendCaption contract');
// A synthetic "drawing": two strokes filling a 3:4 portrait box.
function fakeDrawing(aspect = 0.75, n = 400) {
  const w = aspect >= 1 ? 1 : aspect;
  const h = aspect >= 1 ? 1 / aspect : 1;
  const points = [];
  for (let i = 0; i < n; i++) points.push([(i / (n - 1)) * w, (i / (n - 1)) * h]);
  for (let i = 0; i < n; i++) points.push([(1 - i / (n - 1)) * w, (i / (n - 1)) * h]);
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return { points, breaks: [0, n], numStrokes: 2, aspect, pathLength: len, baseFrac: 0.7, mode: 'trace' };
}

const base = fakeDrawing();
check('no text → identical object', appendCaption(base, glyphs, { dedication: '  ' }) === base);
check('no glyphs → identical object', appendCaption(base, null, { dedication: 'Hi' }) === base);
check('signDate alone still writes',
  appendCaption(base, glyphs, { signDate: true }).points.length > base.points.length);

const out = appendCaption(base, glyphs, {
  dedication: 'Happy birthday, Mom', signDate: true, date: new Date('2026-07-25T00:00:00Z'),
});
const xs = out.points.map((p) => p[0]);
const ys = out.points.map((p) => p[1]);
check('all points finite', out.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
// The contract usePathAnimation actually relies on: `aspect` DECLARES the
// box, the longest side of that box is 1, and every point lives inside it.
// (The band's bottom pad is deliberate empty space inside the box, so the
// point cloud does NOT have to touch all four edges.)
const bw = out.aspect >= 1 ? 1 : out.aspect;
const bh = out.aspect >= 1 ? 1 / out.aspect : 1;
check('declared box has a unit long side', near(Math.max(bw, bh), 1, 1e-9),
  `aspect ${out.aspect.toFixed(4)} → ${bw.toFixed(4)}×${bh.toFixed(4)}`);
check('every point inside the declared box',
  Math.min(...xs) >= -1e-9 && Math.max(...xs) <= bw + 1e-9
  && Math.min(...ys) >= -1e-9 && Math.max(...ys) <= bh + 1e-9,
  `x ${Math.min(...xs).toFixed(4)}..${Math.max(...xs).toFixed(4)} y ${Math.min(...ys).toFixed(4)}..${Math.max(...ys).toFixed(4)}`);

check('breaks strictly ascending and in range',
  out.breaks.every((b, i) => Number.isInteger(b) && b >= 0 && b < out.points.length
    && (i === 0 ? b === 0 : b > out.breaks[i - 1])),
  `${out.breaks.length} strokes`);
check('drawing strokes survive untouched at the front',
  out.breaks[0] === 0 && out.breaks[1] === base.breaks[1]);
check('numStrokes agrees with breaks', out.numStrokes === out.breaks.length);
check('caption metadata recorded', out.caption.strokes === out.breaks.length - base.breaks.length,
  `${out.caption.strokes} letter strokes`);

// The portrait must occupy the TOP of the composition and the writing the
// bottom — this is the assertion that would catch a sign flip in the band.
const drawingYs = ys.slice(0, base.points.length);
const captionYs = ys.slice(base.points.length);
check('caption sits strictly below the drawing',
  Math.max(...captionYs) < Math.min(...drawingYs) + 1e-9,
  `caption top ${Math.max(...captionYs).toFixed(4)} vs drawing bottom ${Math.min(...drawingYs).toFixed(4)}`);
// Before, the portrait filled the frame's full height; now it gives a slice
// of that height to the writing. Too little and the words are cramped; too
// much and the gift is a caption with a doodle above it.
// Worst observed across the shape/text sweep is 72.9% (long dedication on a
// tall narrow portrait); below ~0.65 the gift would be a caption with a
// doodle above it, above ~0.92 the writing is cramped.
const share = (Math.max(...drawingYs) - Math.min(...drawingYs)) / bh;
check('drawing gave up a sensible slice of the frame', share > 0.65 && share < 0.92,
  `portrait now fills ${(share * 100).toFixed(1)}% of the frame height`);

let recomputed = 0;
for (let i = 1; i < out.points.length; i++) {
  recomputed += Math.hypot(out.points[i][0] - out.points[i - 1][0],
                           out.points[i][1] - out.points[i - 1][1]);
}
check('pathLength recomputed for the composition', near(out.pathLength, Math.round(recomputed * 10000) / 10000, 1e-4),
  `${out.pathLength} (was ${base.pathLength.toFixed(4)})`);
check('unrelated fields preserved', out.mode === 'trace' && out.baseFrac === 0.7);

// Landscape + scribble (breaks === [0]) must compose too.
const scribble = { ...fakeDrawing(1.5), breaks: [0], numStrokes: 1, mode: 'scribble' };
const sOut = appendCaption(scribble, glyphs, { dedication: 'For Dad' });
check('scribble gains pen lifts for the writing', sOut.breaks.length > 1 && sOut.breaks[0] === 0);
check('landscape keeps width as the long side', near(Math.max(...sOut.points.map((p) => p[0])), 1, 1e-6));

// Ink budget. InkTrail preallocates 22 000 ribbon centers (Scene.jsx). The
// worst backend path is dense trace at span=2: ~9.6k vertices over ≤640
// strokes. Centers = points + 2 bridges per stroke + 1 floating tip, so the
// caption's share must satisfy
//   9600 + 4400 + 2·(640 + captionStrokes) + 1 ≤ 22000.
// 5000 vertices / 400 strokes leaves ~30% margin; blowing past it would
// silently TRUNCATE the end of a drawing, which is why this is a test and
// not a comment.
const longest = appendCaption(base, glyphs, {
  dedication: 'W'.repeat(48), signDate: true,
});
const added = longest.points.length - base.points.length;
const capStrokes = longest.breaks.length - base.breaks.length;
check('worst-case caption fits the ink buffer with room to spare',
  added < 5000 && capStrokes < 400
  && 9600 + added + 2 * (640 + capStrokes) + 1 < 22000,
  `${added} vertices, ${capStrokes} strokes`);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall caption checks passed\n');
process.exit(failures ? 1 : 0);
