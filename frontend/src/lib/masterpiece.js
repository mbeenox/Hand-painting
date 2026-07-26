/**
 * masterpiece.js — "Today's masterpiece" (Feature 5.3).
 *
 * One public-domain artwork per day, the same one for everyone on that date,
 * chosen with no server involved: the date string IS the seed. A pure hash of
 * `YYYY-MM-DD` indexes the curated list, so two people who open the app on
 * the same day are handed the same painting and can compare drawings, and the
 * pick is reproducible forever without storing a schedule anywhere.
 *
 * The list itself (`/masterpieces.json`) is built offline by
 * `scripts/curate_masterpieces.py`, which vets every candidate through this
 * app's OWN trace pipeline — see that file for why the images come from
 * Wikimedia Commons rather than the Met's own host (short version: the Met
 * sends no CORS header, which would both block the fetch and taint the WebGL
 * canvas, silently breaking every export).
 *
 * EVERY failure path here returns null. The chip simply does not appear —
 * a nice-to-have on the idle screen must never stand between a visitor and
 * the thing they came for.
 */

const STORE = 'hh-masterpiece-v1';
const LIST_URL = '/masterpieces.json';

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * Local, not UTC, on purpose: "today's masterpiece" should mean *your*
 * today, not a date that flips at 3am. The cost is that someone in Tokyo
 * moves on a few hours before someone in Los Angeles — a shared daily
 * artwork, not a synchronised global drop.
 */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Whole days since the epoch for a YYYY-MM-DD key — a stable integer. */
export function dayNumber(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function gcd(a, b) {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

/**
 * Day → index, by walking the list in strides COPRIME with its length.
 *
 * The obvious approach is to hash the date string, and that was the first
 * cut. But a hash is only uniform in the limit: with 200 works there is a
 * 1-in-200 chance any given day repeats the one before it, and a ~1-in-3
 * chance of at least one such repeat in a year. "Today's masterpiece" being
 * yesterday's is a small, avoidable disappointment.
 *
 * A stride coprime with `n` is a bijection over any `n` consecutive days:
 * every work comes up exactly once before any of them comes up twice, and
 * the sequence is still a pure function of the date, so everyone still sees
 * the same painting. The stride is ~0.618·n (the golden-ratio, low-discrepancy
 * choice) so consecutive days land far apart in the list rather than marching
 * through it in order.
 */
export function pickIndex(key, n) {
  if (!(n > 0)) return 0;
  if (n === 1) return 0;
  let stride = Math.max(1, Math.round(n * 0.6180339887));
  while (gcd(stride, n) !== 1) stride += 1;
  return (((dayNumber(key) % n) * stride) % n + n) % n;
}

/** The work for a given day, or null if the list is unusable. */
export function pickForDay(list, key) {
  if (!Array.isArray(list) || !list.length) return null;
  const item = list[pickIndex(key, list.length)];
  return item && item.img ? item : null;
}

/** "Title — Artist, date", skipping whatever the record is missing. */
export function creditLine(item) {
  if (!item) return '';
  return [item.t, [item.a, item.d].filter(Boolean).join(', ')]
    .filter(Boolean).join(' — ');
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && saved.day === key && saved.item ? saved.item : null;
  } catch {
    return null;
  }
}

function writeCache(key, item) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ day: key, item }));
  } catch { /* private mode / quota — the feature just re-fetches tomorrow */ }
}

/**
 * Today's pick. Served from localStorage when it was already resolved today
 * (so a returning visitor costs zero network for this), otherwise the list is
 * fetched once. Returns null on ANY problem.
 */
export async function todaysMasterpiece(date = new Date()) {
  const key = dayKey(date);
  const cached = readCache(key);
  if (cached) return cached;
  try {
    const res = await fetch(LIST_URL, { cache: 'force-cache' });
    if (!res.ok) return null;
    const item = pickForDay(await res.json(), key);
    if (item) writeCache(key, item);
    return item;
  } catch {
    return null;
  }
}

/**
 * The artwork as a Blob, ready for the ordinary upload path.
 * Wikimedia serves `Access-Control-Allow-Origin: *`, so this is a plain
 * cross-origin fetch — and because it becomes a same-origin blob URL, the
 * ghost reveal can use it as a WebGL texture without tainting the canvas.
 */
export async function fetchArtwork(item) {
  const res = await fetch(item.img, { mode: 'cors' });
  if (!res.ok) throw new Error(`artwork HTTP ${res.status}`);
  return res.blob();
}
