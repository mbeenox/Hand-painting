/**
 * verify_masterpiece.mjs — unit checks for "Today's masterpiece" (5.3).
 *
 *   node frontend/scripts/verify_masterpiece.mjs
 *
 * The daily pick is the one part of this feature with no visible failure
 * mode: a bad hash still returns *a* painting, so nothing looks broken while
 * the calendar quietly repeats itself or ignores half the collection. These
 * checks are how that stays honest. Also validates the committed list itself,
 * because a malformed record ships silently.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  dayKey, dayNumber, pickIndex, pickForDay, creditLine,
} from '../src/lib/masterpiece.js';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------
console.log('\ndate key');
check('formats local date, zero-padded',
  dayKey(new Date(2026, 0, 5)) === '2026-01-05', dayKey(new Date(2026, 0, 5)));
check('is local, not UTC (late-evening dates do not roll forward)',
  dayKey(new Date(2026, 6, 25, 23, 30)) === '2026-07-25');
check('day numbers advance by one', dayNumber('2026-07-26') - dayNumber('2026-07-25') === 1);
check('day numbers cross months and years',
  dayNumber('2026-03-01') - dayNumber('2026-02-28') === 1
  && dayNumber('2027-01-01') - dayNumber('2026-12-31') === 1);

// ---------------------------------------------------------------------------
console.log('\ndaily pick');
check('deterministic', pickIndex('2026-07-25', 200) === pickIndex('2026-07-25', 200));
check('in range for many sizes',
  [1, 2, 7, 43, 100, 199, 200, 501].every((n) => {
    const i = pickIndex('2026-07-25', n);
    return Number.isInteger(i) && i >= 0 && i < n;
  }));
check('degenerate sizes do not throw',
  pickIndex('2026-07-25', 0) === 0 && pickIndex('', 10) >= 0);

// The property that matters: over any n consecutive days every work comes up
// exactly once. This is what a plain hash could not promise.
for (const n of [43, 137, 200]) {
  const start = dayNumber('2026-07-25');
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(1970, 0, 1 + start + i));
    seen.add(pickIndex(dayKey(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), n));
  }
  check(`n=${n}: a full cycle covers every work exactly once`, seen.size === n,
    `${seen.size}/${n} distinct`);
}

// …and consecutive days must not sit next to each other in the list either,
// or a run of days would march through one artist's works in a block.
{
  const n = 200;
  let minGap = n;
  const start = dayNumber('2026-07-25');
  for (let i = 0; i < 365; i++) {
    const day = (k) => {
      const d = new Date(Date.UTC(1970, 0, 1 + start + k));
      return dayKey(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    const a = pickIndex(day(i), n);
    const b = pickIndex(day(i + 1), n);
    minGap = Math.min(minGap, Math.abs(a - b), n - Math.abs(a - b));
  }
  check('consecutive days land far apart in the list', minGap > n * 0.2,
    `smallest gap ${minGap} of ${n}`);
}

check('pickForDay tolerates junk',
  pickForDay(null, '2026-07-25') === null
  && pickForDay([], '2026-07-25') === null
  && pickForDay([{ t: 'no image' }], '2026-07-25') === null);
check('creditLine composes and tolerates gaps',
  creditLine({ t: 'A Portrait', a: 'Someone', d: '1850' }) === 'A Portrait — Someone, 1850'
  && creditLine({ t: 'Untitled' }) === 'Untitled'
  && creditLine(null) === '');

// ---------------------------------------------------------------------------
console.log('\ncommitted list');
const listPath = join(here, '../public/masterpieces.json');
if (!existsSync(listPath)) {
  failures++;
  console.error('  FAIL masterpieces.json is missing — run scripts/curate_masterpieces.py');
} else {
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  const kb = readFileSync(listPath).length / 1024;
  check('is a non-trivial array', Array.isArray(list) && list.length >= 120,
    `${list.length} works, ${kb.toFixed(0)} KB`);
  check('stays small enough to fetch on the idle screen', kb < 120, `${kb.toFixed(0)} KB`);
  check('every record has what the chip renders',
    list.every((x) => x && typeof x.img === 'string' && x.img.startsWith('https://')
      && typeof x.t === 'string' && x.t.length > 0));
  check('every image is CORS-capable (Wikimedia, not the Met host)',
    list.every((x) => x.img.startsWith('https://upload.wikimedia.org/')),
    'a Met-hosted URL would taint the canvas and break every export');
  check('no duplicate artworks',
    new Set(list.map((x) => x.img)).size === list.length);
  // "Anonymous" is the absence of an artist, not an artist — counting it
  // here would flag a perfectly good calendar as dominated by one painter.
  const named = list.filter((x) => x.a && x.a.toLowerCase() !== 'anonymous');
  const artists = new Map();
  for (const x of named) artists.set(x.a, (artists.get(x.a) || 0) + 1);
  const top = [...artists.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['—', 0];
  check('no single named artist dominates the calendar', top[1] <= 6,
    `${artists.size} named artists, most frequent "${String(top[0]).slice(0, 26)}" ×${top[1]}`);
  check('most works are attributed', named.length > list.length * 0.8,
    `${named.length}/${list.length} attributed to a named artist`);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall masterpiece checks passed\n');
process.exit(failures ? 1 : 0);
