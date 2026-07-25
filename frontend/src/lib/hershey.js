/**
 * hershey.js — the single-stroke font the hand WRITES with (Feature 5.1).
 *
 * Dr. A. V. Hershey's occidental Roman Simplex ("futural") is a set of
 * centre-line polylines — exactly the shape the backend emits for a traced
 * photograph. That is the whole trick of this feature: a letter and an
 * eyebrow are the same kind of object, so the pen that drew Mom can write
 * "Happy birthday, Mom" with no new rendering path, no new animation, and no
 * backend call. See `fonts/HERSHEY-LICENSE.txt` for the required credits.
 *
 * JHF record layout (fixed columns, one record per line in this font):
 *   [0..5)  glyph number (ignored — position in the file IS the ASCII order,
 *           starting at 32 = space)
 *   [5..8)  vertex count, INCLUDING the leading left/right-bearing pair
 *   [8..]   that many coordinate pairs, each char biased by 'R' (0x52);
 *           the pair " R" is a PEN-UP marker between sub-strokes.
 *
 * Coordinates are y-DOWN in font space. Everything this module exports is
 * already flipped to the app's y-up convention with the baseline at y = 0.
 *
 * The font file is loaded through a DYNAMIC import so it lands in its own
 * lazy chunk — a first-time visitor who never types a dedication never pays
 * for it (see the "nothing new on the critical path" guardrail).
 */

const BIAS = 82; // 'R'
const PEN_UP = ' R';
const FIRST_CODE = 32; // the first record in a JHF file is ASCII space

/**
 * Parse a JHF font into a Map of char → { lh, rh, adv, strokes }.
 * `strokes` are arrays of [x, y] in RAW font units (y down).
 */
export function parseJHF(text) {
  const glyphs = new Map();
  let code = FIRST_CODE;
  for (const line of String(text).split('\n')) {
    if (line.length < 10) continue; // blank / truncated
    const nv = parseInt(line.slice(5, 8), 10);
    const d = line.slice(8);
    if (!Number.isFinite(nv) || nv < 1 || d.length < 2) continue;
    const lh = d.charCodeAt(0) - BIAS;
    const rh = d.charCodeAt(1) - BIAS;
    const strokes = [];
    let cur = [];
    for (let k = 1; k < nv && 2 * k + 1 < d.length; k++) {
      if (d.slice(2 * k, 2 * k + 2) === PEN_UP) {
        if (cur.length) strokes.push(cur);
        cur = [];
        continue;
      }
      cur.push([d.charCodeAt(2 * k) - BIAS, d.charCodeAt(2 * k + 1) - BIAS]);
    }
    if (cur.length) strokes.push(cur);
    glyphs.set(String.fromCharCode(code), { lh, rh, adv: rh - lh, strokes });
    code++;
  }
  return glyphs;
}

/**
 * Vertical metrics, measured from the font itself rather than hardcoded:
 * 'H' spans exactly the cap height, and its bottom IS the baseline.
 */
export function fontMetrics(glyphs) {
  const H = glyphs.get('H');
  if (!H) return { baseline: 9, capTop: -12, capHeight: 21 };
  let capTop = Infinity;
  let baseline = -Infinity;
  for (const s of H.strokes) {
    for (const [, y] of s) {
      if (y < capTop) capTop = y;
      if (y > baseline) baseline = y;
    }
  }
  return { baseline, capTop, capHeight: Math.max(1, baseline - capTop) };
}

// ---------------------------------------------------------------------------
// Text → glyphs the font actually has
// ---------------------------------------------------------------------------
// The font is ASCII-only, so anything else has to be folded in or dropped.
// NFD + combining-mark strip turns "José" into "Jose" (far better than a
// blank); a small table handles the punctuation phones love to substitute.
const PUNCT = {
  '\u00B7': '-', '\u2013': '-', '\u2014': '-', '\u2012': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': ',', '\u2032': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u2033': '"',
  '\u2026': '...', '\u2022': '.',
  '\u00D7': 'x', '\u00F7': '/', '\u2044': '/',
  '\u00E6': 'ae', '\u00C6': 'AE', '\u0153': 'oe', '\u0152': 'OE',
  '\u00DF': 'ss', '\u00F8': 'o', '\u00D8': 'O', '\u0142': 'l', '\u0141': 'L',
};

/** Fold arbitrary user text down to the printable ASCII the font covers. */
export function asciiFold(text) {
  const flat = String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents: Jos\u00E9 -> Jose
    .replace(/\s+/g, ' ');
  let out = '';
  for (const ch of flat) {
    const sub = PUNCT[ch] ?? ch;
    for (const c of sub) {
      const code = c.charCodeAt(0);
      if (code >= 32 && code <= 126) out += c;
    }
  }
  // Collapse again: dropping an emoji or a CJK run leaves the spaces that
  // surrounded it, and a triple space reads as a layout bug in the writing.
  return out.replace(/ +/g, ' ').trim();
}

/** Advance width of a string in raw font units (no scaling). */
export function measureRaw(glyphs, text) {
  let w = 0;
  for (const ch of text) w += (glyphs.get(ch) ?? glyphs.get(' ')).adv;
  return w;
}

/**
 * Lay a single line out with its baseline at y = 0, x starting at 0.
 * Returns polylines in y-UP space scaled so the cap height equals `capHeight`.
 */
export function lineToStrokes(glyphs, text, capHeight) {
  const m = fontMetrics(glyphs);
  const s = capHeight / m.capHeight;
  const out = [];
  let pen = 0;
  for (const ch of text) {
    const g = glyphs.get(ch) ?? glyphs.get(' ');
    for (const st of g.strokes) {
      const poly = st.map(([x, y]) => [
        (pen + x - g.lh) * s,
        (m.baseline - y) * s, // flip: font y-down → world y-up, baseline at 0
      ]);
      // The ink ribbon needs a direction; a hypothetical 1-vertex glyph
      // (none in this font, but parsers outlive their fonts) gets a hair of
      // length rather than a degenerate segment.
      if (poly.length === 1) poly.push([poly[0][0] + s, poly[0][1]]);
      if (poly.length >= 2) out.push(poly);
    }
    pen += g.adv;
  }
  return { strokes: out, width: pen * s };
}

/**
 * Greedy word wrap into at most `maxLines` lines that each fit `maxWidth`.
 * A single word too long for a line is broken by character; anything past
 * `maxLines` is DROPPED rather than allowed to overflow — the caption band
 * is a fixed budget and the drawing above it is not negotiable. (The input
 * is length-capped at the UI, so this is a backstop, not the normal path.)
 */
export function wrapText(glyphs, text, capHeight, maxWidth, maxLines = 2) {
  const m = fontMetrics(glyphs);
  const unit = capHeight / m.capHeight;
  const limit = maxWidth / unit; // work in raw font units
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  const fits = (s) => measureRaw(glyphs, s) <= limit;

  for (let w of words) {
    // A single word longer than the line gets broken by character.
    while (!fits(w)) {
      if (cur) { lines.push(cur); cur = ''; }
      let take = w.length - 1;
      while (take > 1 && !fits(w.slice(0, take))) take--;
      lines.push(w.slice(0, take));
      w = w.slice(take);
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines && cur === '') break;
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next)) cur = next;
    else { if (cur) lines.push(cur); cur = w; }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines).filter(Boolean);
}

/**
 * Lay out a (possibly wrapping) block of text.
 *
 * Returns polylines in y-UP space, x centred on 0 when `align` is 'center'
 * (right-aligned to x = 0 when 'right'), with the FIRST line's baseline at
 * y = 0 and later lines below it. `top`/`bottom` are the block's real ink
 * extents so the caller can stack blocks without guessing.
 */
export function layoutBlock(glyphs, text, {
  capHeight = 1, maxWidth = Infinity, maxLines = 2, lineGap = 0.85,
  align = 'center',
} = {}) {
  const clean = asciiFold(text);
  if (!clean) return { strokes: [], width: 0, top: 0, bottom: 0, lines: [] };
  const lines = wrapText(glyphs, clean, capHeight, maxWidth, maxLines);
  const lineAdvance = capHeight * (1 + lineGap);
  const strokes = [];
  let width = 0;
  let top = -Infinity;
  let bottom = Infinity;

  lines.forEach((line, i) => {
    const laid = lineToStrokes(glyphs, line, capHeight);
    width = Math.max(width, laid.width);
    let dx = 0;
    if (align === 'center') dx = -laid.width / 2;
    else if (align === 'right') dx = -laid.width;
    const dy = -i * lineAdvance;
    for (const poly of laid.strokes) {
      const moved = poly.map(([x, y]) => {
        const Y = y + dy;
        if (Y > top) top = Y;
        if (Y < bottom) bottom = Y;
        return [x + dx, Y];
      });
      strokes.push(moved);
    }
  });

  if (!strokes.length) return { strokes: [], width: 0, top: 0, bottom: 0, lines };
  return { strokes, width, top, bottom, lines };
}

/**
 * Insert intermediate vertices so no segment is longer than `maxSeg`.
 * Original vertices are ALWAYS kept, so corners stay exact.
 */
export function densify(strokes, maxSeg) {
  if (!(maxSeg > 0)) return strokes;
  return strokes.map((poly) => {
    const out = [poly[0]];
    for (let i = 1; i < poly.length; i++) {
      const [x0, y0] = poly[i - 1];
      const [x1, y1] = poly[i];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxSeg);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      }
      out.push(poly[i]);
    }
    return out;
  });
}

/** Chaikin corner cutting, endpoint-preserving — the backend's `_chaikin`. */
export function chaikin(poly, rounds = 1) {
  let p = poly;
  for (let r = 0; r < rounds && p.length >= 3; r++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
      out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Handwriting: how sparse Hershey outlines become something a pen can draw.
const SEG_PER_CAP = 6;   // pre-smoothing subdivisions per cap-height of ink
const JITTER = 0.035;    // wobble as a fraction of cap height
const SMOOTH_ROUNDS = 2; // Chaikin passes (each roughly doubles the vertices)

/**
 * Turn laid-out glyph outlines into strokes the HAND can draw.
 *
 * A Hershey glyph is a plotter's idea of a letter: two points for the stem of
 * an 'H', perfectly straight, perfectly repeatable. Committed straight to the
 * ribbon it looks nothing like the drawing above it, and worse, it renders
 * badly — `InkTrail` derives nib width from the timetable speed, and a
 * mathematically straight segment carries ZERO curvature, so the pen sweeps it
 * at full cruise and lays the thinnest hairline it owns. Each stroke also
 * tapers in over its first ~8 vertices, which on a 2-vertex stem means the
 * whole stem is a ramp from nothing. Result: letters missing their stems.
 *
 * So letters get exactly what the backend gives a traced edge chain —
 * subdivide, jitter, Chaikin — because a letter and an eyebrow really are the
 * same kind of object. They come out legibly hand-made, every vertex carries
 * real curvature (so the pen slows and presses like it does on the portrait),
 * and each stroke has enough vertices to survive the nib taper.
 *
 * `budget` caps the total vertex count: `InkTrail` preallocates a fixed
 * buffer, and a long dedication must not eat the drawing's headroom.
 */
export function handwrite(strokes, capHeight, { budget = 2600, rng = Math.random } = {}) {
  if (!strokes.length || !(capHeight > 0)) return strokes;
  let ink = 0;
  for (const poly of strokes) {
    for (let i = 1; i < poly.length; i++) {
      ink += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    }
  }
  const growth = 2 ** SMOOTH_ROUNDS; // Chaikin's vertex multiplier
  const maxSeg = Math.max(capHeight / SEG_PER_CAP, (growth * ink) / Math.max(1, budget));
  const sigma = capHeight * JITTER;

  return densify(strokes, maxSeg).map((poly) => {
    // Endpoints stay put: they anchor where a letter's parts meet.
    const wobbled = poly.map(([x, y], i) => (i === 0 || i === poly.length - 1)
      ? [x, y]
      : [x + (rng() - 0.5) * 2 * sigma, y + (rng() - 0.5) * 2 * sigma]);
    return chaikin(wobbled, SMOOTH_ROUNDS);
  });
}

// ---------------------------------------------------------------------------
// Lazy font loading (memoized; the chunk is fetched at most once per session)
// ---------------------------------------------------------------------------
let fontPromise = null;

export function loadHersheyFont() {
  if (!fontPromise) {
    fontPromise = import('./fonts/futural.jhf?raw')
      .then((mod) => parseJHF(mod.default))
      .catch((err) => {
        fontPromise = null; // let a later attempt retry
        throw err;
      });
  }
  return fontPromise;
}
