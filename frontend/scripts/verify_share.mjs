/**
 * verify_share.mjs — Phase 5.4 invariants, pure Node (~0.1 s, no network).
 *
 * Exercises the exported helpers of api/share.mjs: id shape, retention
 * math, media-URL and upload-pathname gates, meta sanitization (the privacy
 * clamps), HTML escaping, rate limiting, and the rendered share/missing
 * pages (OG tags present, user text escaped, report + expiry lines there).
 *
 * Run from the repo root or frontend/:  node frontend/scripts/verify_share.mjs
 * Needs `npm install` at the REPO ROOT first (api/share.mjs imports
 * @vercel/blob, which must resolve even though these helpers never call it).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, '../../api/share.mjs')).href);
const {
  RETENTION_DAYS, MAX_MEDIA_BYTES, ID_RE, UPLOAD_PATH_RE,
  makeId, expiresAtMs, isExpired, validMediaUrl, sanitizeMeta,
  escapeHtml, renderSharePage, renderMissingPage, rateLimited,
} = mod;

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.error(`  ✗ ${name}`); }
}

console.log('verify_share: constants');
check('retention is the owner-approved 30 days', RETENTION_DAYS === 30);
check('media cap is the planned 15 MB', MAX_MEDIA_BYTES === 15 * 1024 * 1024);

console.log('verify_share: ids');
{
  const ids = new Set(Array.from({ length: 200 }, () => makeId()));
  check('every id matches ID_RE', [...ids].every((i) => ID_RE.test(i)));
  check('200 ids are 200 distinct ids', ids.size === 200);
  // Deterministic path: injected bytes → predictable id (documents the API).
  const fixed = makeId((n) => new Uint8Array(n).fill(0));
  check('injected zero bytes → all-"a" id', fixed === 'a'.repeat(10));
}

console.log('verify_share: retention math');
{
  const born = '2026-08-01T12:00:00.000Z';
  const t0 = Date.parse(born);
  check('fresh share is not expired', !isExpired(born, t0 + 1000));
  check('day 29 is not expired', !isExpired(born, t0 + 29 * 86400_000));
  check('day 30 IS expired (inclusive)', isExpired(born, t0 + 30 * 86400_000));
  check('expiresAt is createdAt + 30 d', expiresAtMs(born) === t0 + 30 * 86400_000);
  check('garbage createdAt counts as expired', isExpired('not-a-date', t0));
  check('missing createdAt counts as expired', isExpired(undefined, t0));
}

console.log('verify_share: media URL gate');
{
  const good = 'https://abc123xyz.public.blob.vercel-storage.com/shares/media/k1-still-r4nd.png';
  check('accepts our blob-store shares/media path', validMediaUrl(good));
  check('rejects http', !validMediaUrl(good.replace('https', 'http')));
  check('rejects foreign hosts', !validMediaUrl('https://evil.example.com/shares/media/x.png'));
  check('rejects host-suffix spoof', !validMediaUrl('https://public.blob.vercel-storage.com.evil.example/shares/media/x.png'));
  check('rejects other prefixes in our store', !validMediaUrl('https://abc.public.blob.vercel-storage.com/private/x.png'));
  check('rejects garbage', !validMediaUrl('not a url'));
}

console.log('verify_share: upload pathname gate');
{
  check('still path accepted', UPLOAD_PATH_RE.test('shares/media/abcd1234efgh-still.png'));
  check('mp4 path accepted', UPLOAD_PATH_RE.test('shares/media/abcd1234-video.mp4'));
  check('webm path accepted', UPLOAD_PATH_RE.test('shares/media/abcd1234-video.webm'));
  check('traversal rejected', !UPLOAD_PATH_RE.test('shares/media/../../etc-still.png'));
  check('foreign prefix rejected', !UPLOAD_PATH_RE.test('avatars/abcd1234-still.png'));
  check('exe rejected', !UPLOAD_PATH_RE.test('shares/media/abcd1234-video.exe'));
}

console.log('verify_share: meta sanitization (the privacy clamps)');
{
  const still = 'https://s.public.blob.vercel-storage.com/shares/media/k-still-x.png';
  const video = 'https://s.public.blob.vercel-storage.com/shares/media/k-video-x.mp4';
  const m = sanitizeMeta({
    still, video, videoType: 'mp4', w: 1600, h: 1000,
    dedication: '  Happy birthday, Mom!  ', paper: 'noir', paperBg: '#131316',
    duet: true, seconds: 42, strokes: 300,
    // fields that must NOT survive:
    sourcePhoto: 'data:image/png;base64,...', email: 'a@b.c', ip: '1.2.3.4',
  });
  check('valid meta accepted', m !== null);
  check('unknown fields are dropped', !('sourcePhoto' in m) && !('email' in m) && !('ip' in m));
  check('dedication trimmed', m.dedication === 'Happy birthday, Mom!');
  check('paper allowlisted', m.paper === 'noir' && m.paperBg === '#131316');
  check('bad paper falls back', sanitizeMeta({ still, paper: 'plutonium', paperBg: 'url(x)' }).paper === 'ivory');
  check('bad paperBg falls back (no CSS injection)', sanitizeMeta({ still, paperBg: 'red;}</style>' }).paperBg === '#f6f1e7');
  check('64-char dedication cap', sanitizeMeta({ still, dedication: 'x'.repeat(500) }).dedication.length === 64);
  check('non-blob still URL rejected outright', sanitizeMeta({ still: 'https://evil.example/x.png' }) === null);
  check('non-blob video URL rejected outright', sanitizeMeta({ still, video: 'https://evil.example/x.mp4' }) === null);
  check('weird videoType dropped', sanitizeMeta({ still, video, videoType: 'exe' }).videoType === null);
  check('numbers clamped', sanitizeMeta({ still, seconds: 1e9, strokes: -5, w: 1e9 }).seconds === 600);
}

console.log('verify_share: escaping & pages');
{
  check('escapeHtml covers the five', escapeHtml(`<a b="c">&'`) === '&lt;a b=&quot;c&quot;&gt;&amp;&#39;');
  const still = 'https://s.public.blob.vercel-storage.com/shares/media/k-still-x.png';
  const video = 'https://s.public.blob.vercel-storage.com/shares/media/k-video-x.mp4';
  const meta = sanitizeMeta({
    still, video, videoType: 'mp4', w: 1600, h: 1000,
    dedication: `<script>alert('xss')</script>`, paper: 'ivory', paperBg: '#f6f1e7',
    seconds: 33, strokes: 210,
  });
  meta.createdAt = '2026-08-01T00:00:00.000Z';
  const html = renderSharePage('abcdefghij', meta, 'https://hand-painting-one.vercel.app');
  check('og:image present', html.includes(`property="og:image" content="${still}"`));
  check('og:video present for mp4', html.includes(`property="og:video" content="${video}"`));
  check('og:image dims present', html.includes('og:image:width" content="1600"'));
  check('twitter card present', html.includes('summary_large_image'));
  check('noindex present', html.includes('name="robots" content="noindex"'));
  check('dedication is ESCAPED', !html.includes('<script>alert') && html.includes('&lt;script&gt;'));
  check('video tag with poster', html.includes('poster="') && html.includes('<video'));
  check('expiry date on page', html.includes('2026-08-31'));
  check('report mailto present', html.includes('mailto:') && html.includes('report'));
  check('make-your-own link', html.includes('make your own'));

  const noVid = renderSharePage('abcdefghij', { ...meta, video: null, videoType: null }, 'https://x.test');
  check('still-only page has <img>, no <video>', noVid.includes('<img') && !noVid.includes('<video'));
  const webm = renderSharePage('abcdefghij', { ...meta, videoType: 'webm' }, 'https://x.test');
  check('webm gets NO og:video (crawlers want mp4) but still plays in-page',
    !webm.includes('property="og:video"') && webm.includes('<video'));

  const gone = renderMissingPage('https://x.test', true);
  check('expired page mentions the 30 days', gone.includes('30 days'));
  check('missing page links home', renderMissingPage('https://x.test').includes('https://x.test/'));
}

console.log('verify_share: rate limiting');
{
  const t = 1_000_000_000;
  let limited = 0;
  for (let i = 0; i < 20; i += 1) {
    if (rateLimited('create', 'ip-test-a', t + i)) limited += 1;
  }
  check('create limited after 12/h', limited === 8);
  check('another ip unaffected', !rateLimited('create', 'ip-test-b', t));
  check('window slides (an hour later is fine)', !rateLimited('create', 'ip-test-a', t + 3601_000));
}

if (failures) {
  console.error(`\nverify_share: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nverify_share: all checks passed');
