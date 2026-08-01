/**
 * /api/share — Phase 5.4 "share pages" (Node function, NOT the Python one).
 *
 * A finished drawing becomes a URL: the client uploads its composited still
 * (PNG) and video (mp4/webm) STRAIGHT to Vercel Blob (client-upload tokens —
 * the media never passes through this function, which matters because
 * Vercel's request-body cap is 4.5 MB and a 58s video can be triple that),
 * then registers the pair here and gets back a short /s/<id> link whose page
 * carries OG tags, so the link unfurls as the drawing wherever it is pasted.
 *
 * PRIVACY CONTRACT (this is the whole point — keep it true): the SOURCE
 * PHOTO never leaves the device. What is uploaded is the abstracted line
 * drawing the app itself produced — still + video — and the few style facts
 * in `sanitizeMeta`. The share flow's consent dialog says exactly this; any
 * field added to the meta must be re-reflected in that dialog's wording.
 *
 * Routes (see vercel.json rewrites):
 *   POST /api/share  {type:'blob.generate-client-token'}  → client-upload token
 *   POST /api/share  {type:'hh.create', still, video,…}   → {id, url, expiresAt}
 *   GET  /s/:sid  (rewritten to ?sid=)                    → the share page HTML
 *   GET  /api/share?health=1                              → {configured}
 *   GET  /api/share-cleanup (rewritten to ?cleanup=1)     → daily cron: delete
 *        expired blobs. Links also die at READ time (isExpired), so retention
 *        holds even if the cron never runs; the cron just reclaims storage.
 *
 * Ops notes:
 * - Requires a Vercel Blob store connected to the project
 *   (BLOB_READ_WRITE_TOKEN). Absent → POST answers 503 {configured:false}
 *   and the frontend falls back to plain file sharing. Nothing breaks.
 * - Rate limiting is per-IP, in-memory, best-effort (fluid compute keeps
 *   instances warm, but a cold start forgets). Good enough for a free app;
 *   revisit with KV if the endpoint is ever abused.
 * - CRON_SECRET (optional): when set, /api/share-cleanup requires
 *   `Authorization: Bearer <secret>` — which is exactly what Vercel's cron
 *   runner sends. Unset, cleanup stays open: it only deletes EXPIRED blobs,
 *   so the worst an abuser gets is doing our chores.
 */
import { handleUpload } from '@vercel/blob/client';
import { put, list, del } from '@vercel/blob';

// ---------------------------------------------------------------------------
// Tunables & pure helpers (imported by frontend/scripts/verify_share.mjs —
// keep them export-ed and side-effect-free).
// ---------------------------------------------------------------------------

export const RETENTION_DAYS = 30; // owner's call, 2026-08-01
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // per file (matches the plan)
export const REPORT_EMAIL = 'mobolaji.ogunbiyi@gmail.com'; // report-and-remove
const APP_NAME = 'Hypnotic Hand';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LEN = 10; // 36^10 ≈ 3.7e15 — collisions are lottery-grade unlikely
export const ID_RE = /^[a-z0-9]{10}$/;

// Media keys are minted CLIENT-side (the upload happens before the share
// record exists); the token handler only hands out tokens for pathnames
// shaped exactly like ours.
export const UPLOAD_PATH_RE =
  /^shares\/media\/[a-z0-9]{8,24}-(still\.png|video\.(mp4|webm))$/;

export function makeId(randomBytes) {
  // randomBytes: injectable for tests; defaults to webcrypto.
  const buf = randomBytes
    ? randomBytes(ID_LEN)
    : globalThis.crypto.getRandomValues(new Uint8Array(ID_LEN));
  let id = '';
  for (let i = 0; i < ID_LEN; i += 1) id += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  return id;
}

export function expiresAtMs(createdAtIso) {
  const t = Date.parse(createdAtIso);
  return Number.isFinite(t) ? t + RETENTION_DAYS * 86400_000 : 0;
}

export function isExpired(createdAtIso, nowMs = Date.now()) {
  // Unparseable/missing createdAt counts as expired: a record we can't date
  // is a record we can't promise to delete on time.
  return nowMs >= expiresAtMs(createdAtIso);
}

// A share record may only point at media that lives in a Vercel Blob store
// under our shares/media/ prefix. (Someone with their OWN store could still
// craft a record pointing at their own uploads — accepted: that is no more
// power than hosting the page themselves, and report-and-remove covers it.)
export function validMediaUrl(u) {
  try {
    const url = new URL(u);
    return (
      url.protocol === 'https:' &&
      url.hostname.endsWith('.public.blob.vercel-storage.com') &&
      url.pathname.startsWith('/shares/media/')
    );
  } catch {
    return false;
  }
}

const PAPER_NAMES = new Set(['ivory', 'noir', 'kraft', 'slate']);
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

// Everything user-influenced gets clamped here, once, at create time.
export function sanitizeMeta(body = {}) {
  const meta = {
    v: 1,
    still: String(body.still || ''),
    video: body.video ? String(body.video) : null,
    videoType: body.videoType === 'mp4' || body.videoType === 'webm' ? body.videoType : null,
    w: clampInt(body.w, 0, 4096),
    h: clampInt(body.h, 0, 4096),
    dedication: String(body.dedication || '').slice(0, 64).trim(),
    paper: PAPER_NAMES.has(body.paper) ? body.paper : 'ivory',
    paperBg: HEX_RE.test(String(body.paperBg || '')) ? body.paperBg : '#f6f1e7',
    duet: body.duet === true,
    seconds: clampInt(body.seconds, 0, 600),
    strokes: clampInt(body.strokes, 0, 10000),
  };
  if (!validMediaUrl(meta.still)) return null;
  if (meta.video && !validMediaUrl(meta.video)) return null;
  return meta;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------------
// The share page. Server-rendered because OG crawlers do not run JS — a
// static shell + fetch would unfurl as nothing.
// ---------------------------------------------------------------------------

export function renderSharePage(id, meta, origin) {
  const title = meta.dedication
    ? `“${meta.dedication}” — drawn by the ${APP_NAME}`
    : meta.duet
      ? `A two-portrait duet, drawn by the ${APP_NAME}`
      : `A drawing by the ${APP_NAME}`;
  const desc = `A photo redrawn stroke by stroke by a 3D hand${
    meta.seconds ? ` over ${meta.seconds} seconds` : ''
  }, performing its own music. The source photo never left its owner's device.`;
  const pageUrl = `${origin}/s/${id}`;
  const expires = new Date(expiresAtMs(meta.createdAt || new Date().toISOString()));
  const e = escapeHtml;
  const light = isLightColor(meta.paperBg);
  const fg = light ? '#2c2c34' : '#e8e4da';
  const sub = light ? 'rgba(44,44,52,0.55)' : 'rgba(232,228,218,0.55)';

  const ogVideo = meta.video && meta.videoType === 'mp4'
    ? [
        `<meta property="og:video" content="${e(meta.video)}" />`,
        `<meta property="og:video:secure_url" content="${e(meta.video)}" />`,
        `<meta property="og:video:type" content="video/mp4" />`,
        meta.w ? `<meta property="og:video:width" content="${meta.w}" />` : '',
        meta.h ? `<meta property="og:video:height" content="${meta.h}" />` : '',
      ].filter(Boolean).join('\n  ')
    : '';

  const media = meta.video
    ? `<video controls autoplay muted loop playsinline poster="${e(meta.still)}" src="${e(meta.video)}">
      <img src="${e(meta.still)}" alt="${e(title)}" />
    </video>`
    : `<img src="${e(meta.still)}" alt="${e(title)}" />`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${e(title)}</title>
  <meta property="og:title" content="${e(title)}" />
  <meta property="og:description" content="${e(desc)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${e(pageUrl)}" />
  <meta property="og:site_name" content="${APP_NAME}" />
  <meta property="og:image" content="${e(meta.still)}" />
  ${meta.w ? `<meta property="og:image:width" content="${meta.w}" />` : ''}
  ${meta.h ? `<meta property="og:image:height" content="${meta.h}" />` : ''}
  ${ogVideo}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${e(title)}" />
  <meta name="twitter:image" content="${e(meta.still)}" />
  <style>
    html, body { margin: 0; min-height: 100%; }
    body {
      background: ${e(meta.paperBg)}; color: ${fg};
      font: 16px/1.5 Georgia, 'Times New Roman', serif;
      display: flex; flex-direction: column; align-items: center;
      padding: 28px 16px 40px; box-sizing: border-box; text-align: center;
    }
    .frame { max-width: 860px; width: 100%; }
    video, img { max-width: 100%; height: auto; border-radius: 6px;
      box-shadow: 0 10px 40px rgba(0,0,0,${light ? '0.14' : '0.5'}); }
    .ded { font-style: italic; font-size: 20px; margin: 18px 0 0; }
    .make { display: inline-block; margin-top: 22px; padding: 10px 22px;
      border-radius: 999px; border: 1.5px solid ${fg}; color: ${fg};
      text-decoration: none; font-style: italic; }
    .fine { color: ${sub}; font-size: 12.5px; margin-top: 26px; }
    .fine a { color: ${sub}; }
  </style>
</head>
<body>
  <div class="frame">
    ${media}
    ${meta.dedication ? `<p class="ded">“${e(meta.dedication)}”</p>` : ''}
    <a class="make" href="${e(origin)}/">drawn &amp; composed at ${APP_NAME} — make your own →</a>
    <p class="fine">
      The drawing was made from a photo that never left its owner's device — only this line drawing was shared.<br />
      This page expires ${expires.toISOString().slice(0, 10)} ·
      <a href="mailto:${REPORT_EMAIL}?subject=Report%20shared%20drawing%20${e(id)}">report this page</a>
    </p>
  </div>
</body>
</html>`;
}

export function renderMissingPage(origin, gone = false) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${gone ? 'This drawing has faded' : 'No drawing here'} — ${APP_NAME}</title>
  <style>
    body { background: #f6f1e7; color: #2c2c34; font: 17px/1.6 Georgia, serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; text-align: center; padding: 24px; }
    a { color: #1e3a5f; }
  </style>
</head>
<body>
  <div>
    <p style="font-size:42px;margin:0">✍️</p>
    <p>${gone
      ? `Shared drawings live for ${RETENTION_DAYS} days, and this one has quietly faded away.`
      : 'There is no drawing at this address.'}</p>
    <p><a href="${escapeHtml(origin)}/">Make a new one at ${APP_NAME} →</a></p>
  </div>
</body>
</html>`;
}

function isLightColor(hex) {
  const m = /^#([0-9a-fA-F]{6})/.exec(hex || '');
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 110;
}

// ---------------------------------------------------------------------------
// Best-effort per-IP rate limiting (in-memory sliding window).
// ---------------------------------------------------------------------------

const RATE = { create: 12, token: 40, windowMs: 3600_000 };
const hits = new Map(); // `${kind}:${ip}` → [timestamps]

export function rateLimited(kind, ip, nowMs = Date.now(), rate = RATE) {
  const key = `${kind}:${ip}`;
  const cutoff = nowMs - rate.windowMs;
  const arr = (hits.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= (rate[kind] ?? 10)) { hits.set(key, arr); return true; }
  arr.push(nowMs);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear(); // crude memory ceiling
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const configured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return host ? `${proto}://${host}` : 'https://hand-painting-one.vercel.app';
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim();
}

export default async function handler(req, res) {
  const origin = requestOrigin(req);

  if (req.method === 'GET') {
    if (req.query.health !== undefined) {
      return res.status(200).json({ configured: configured() });
    }
    if (req.query.cleanup !== undefined) {
      return cleanup(req, res);
    }
    if (req.query.sid !== undefined) {
      return sharePage(req, res, String(req.query.sid), origin);
    }
    return res.status(404).json({ error: 'not found' });
  }

  if (req.method === 'POST') {
    if (!configured()) {
      return res.status(503).json({ configured: false, error: 'sharing is not configured' });
    }
    const body = req.body;
    const ip = clientIp(req);

    // 1) Client-upload token exchange (the @vercel/blob client protocol).
    if (body?.type === 'blob.generate-client-token') {
      if (rateLimited('token', ip)) return res.status(429).json({ error: 'slow down' });
      try {
        const json = await handleUpload({
          body,
          request: req,
          onBeforeGenerateToken: async (pathname) => {
            if (!UPLOAD_PATH_RE.test(pathname)) {
              throw new Error('unexpected upload pathname');
            }
            return {
              allowedContentTypes: ['image/png', 'video/mp4', 'video/webm'],
              maximumSizeInBytes: MAX_MEDIA_BYTES,
              addRandomSuffix: true,
            };
          },
          // No onUploadCompleted: the share record is created by an explicit
          // hh.create from the client, so localhost works and there is no
          // dependency on the callback reaching a public URL.
        });
        return res.status(200).json(json);
      } catch (err) {
        return res.status(400).json({ error: String(err?.message || err) });
      }
    }

    // 2) Register the share → mint the id → write the meta record.
    if (body?.type === 'hh.create') {
      if (rateLimited('create', ip)) return res.status(429).json({ error: 'slow down' });
      const meta = sanitizeMeta(body);
      if (!meta) return res.status(400).json({ error: 'invalid media URLs' });
      meta.createdAt = new Date().toISOString();
      const id = makeId();
      try {
        await put(`shares/meta/${id}.json`, JSON.stringify(meta), {
          access: 'public',
          addRandomSuffix: false,
          contentType: 'application/json',
        });
      } catch (err) {
        return res.status(502).json({ error: `could not save the share: ${String(err?.message || err)}` });
      }
      return res.status(200).json({
        id,
        url: `${origin}/s/${id}`,
        expiresAt: new Date(expiresAtMs(meta.createdAt)).toISOString(),
      });
    }

    return res.status(400).json({ error: 'unknown request type' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}

// ---------------------------------------------------------------------------

async function sharePage(req, res, sid, origin) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!configured() || !ID_RE.test(sid)) {
    return res.status(404).send(renderMissingPage(origin));
  }
  let meta = null;
  let metaUrl = null;
  try {
    const { blobs } = await list({ prefix: `shares/meta/${sid}.json`, limit: 1 });
    const hit = blobs.find((b) => b.pathname === `shares/meta/${sid}.json`);
    if (hit) {
      metaUrl = hit.url;
      const r = await fetch(hit.url, { cache: 'no-store' });
      if (r.ok) meta = await r.json();
    }
  } catch { /* treat as missing */ }
  if (!meta || !validMediaUrl(meta.still)) {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    return res.status(404).send(renderMissingPage(origin));
  }
  if (isExpired(meta.createdAt)) {
    // The link died at read time; reclaim the bytes opportunistically too.
    try {
      await del([metaUrl, meta.still, meta.video].filter(Boolean));
    } catch { /* the cron will get it */ }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60');
    return res.status(410).send(renderMissingPage(origin, true));
  }
  // CDN-cache briefly: pages are immutable until they expire, and a 5-minute
  // horizon keeps even the expiry transition prompt.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  return res.status(200).send(renderSharePage(sid, meta, origin));
}

async function cleanup(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!configured()) return res.status(200).json({ configured: false, deleted: 0 });
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  let deleted = 0;
  let cursor;
  try {
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await list({ prefix: 'shares/', limit: 1000, cursor });
      cursor = page.cursor;
      const old = page.blobs
        .filter((b) => new Date(b.uploadedAt).getTime() < cutoff)
        .map((b) => b.url);
      if (old.length) {
        // eslint-disable-next-line no-await-in-loop
        await del(old);
        deleted += old.length;
      }
    } while (cursor);
  } catch (err) {
    return res.status(502).json({ error: String(err?.message || err), deleted });
  }
  return res.status(200).json({ deleted });
}
