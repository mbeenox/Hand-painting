/**
 * shareLink — Phase 5.4 client half.
 *
 * Turns the finished drawing's media (the composited still + video that
 * useDrawCapture already made) into a public /s/<id> link:
 *
 *   1. health check          — GET /api/share?health=1. Dev servers and
 *      deployments without a Blob store answer "not configured", and the
 *      dialog falls back to plain file sharing instead of half-working.
 *   2. direct client uploads — @vercel/blob's `upload()` (a lazy chunk; the
 *      SDK never touches the first paint). The media goes STRAIGHT to the
 *      Blob store with a short-lived token from /api/share — it must not
 *      round-trip through our function (4.5 MB request cap vs ~15 MB video).
 *   3. register              — POST /api/share {type:'hh.create'} → {url}.
 *
 * PRIVACY: only ever upload what the app itself drew — the still and the
 * video. The source photo blobs (sourceRef) must never be passed here.
 */

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // keep in lockstep with api/share.mjs

function mediaKey() {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

async function imageDims(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return d;
  } catch {
    return { w: 0, h: 0 };
  }
}

export class ShareUnconfiguredError extends Error {
  constructor() {
    super('link sharing is not configured on this deployment');
    this.code = 'unconfigured';
  }
}

/**
 * @param {Blob}   stillBlob  the clean composited PNG (required)
 * @param {string|null} videoUrl  object URL of the recorded video, if any
 * @param {string} videoExt   'mp4' | 'webm'
 * @param {object} meta       {dedication, paper, paperBg, duet, seconds, strokes}
 * @returns {Promise<{id: string, url: string, expiresAt: string}>}
 */
export async function createShareLink({ stillBlob, videoUrl, videoExt, meta = {} }) {
  if (!stillBlob) throw new Error('nothing to share yet');

  // 1) Is this deployment set up for links at all?
  let health;
  try {
    health = await fetch('/api/share?health=1');
  } catch {
    throw new ShareUnconfiguredError();
  }
  if (!health.ok) throw new ShareUnconfiguredError();
  const { configured } = await health.json().catch(() => ({ configured: false }));
  if (!configured) throw new ShareUnconfiguredError();

  const { upload } = await import('@vercel/blob/client');
  const key = mediaKey();
  const dims = await imageDims(stillBlob);

  // 2) Media straight to the store. The still is mandatory (it is the OG
  // image); the video is best-effort — too big or failing simply means the
  // page shows the still.
  const still = await upload(`shares/media/${key}-still.png`, stillBlob, {
    access: 'public',
    handleUploadUrl: '/api/share',
    contentType: 'image/png',
  });

  let video = null;
  let videoType = null;
  if (videoUrl) {
    try {
      const vb = await fetch(videoUrl).then((r) => r.blob());
      if (vb.size > 0 && vb.size <= MAX_MEDIA_BYTES) {
        const ext = videoExt === 'mp4' ? 'mp4' : 'webm';
        const up = await upload(`shares/media/${key}-video.${ext}`, vb, {
          access: 'public',
          handleUploadUrl: '/api/share',
          contentType: ext === 'mp4' ? 'video/mp4' : 'video/webm',
        });
        video = up.url;
        videoType = ext;
      }
    } catch { /* still-only share */ }
  }

  // 3) Register → the link.
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'hh.create',
      still: still.url,
      video,
      videoType,
      w: dims.w,
      h: dims.h,
      ...meta,
    }),
  });
  if (res.status === 503) throw new ShareUnconfiguredError();
  if (!res.ok) throw new Error(`share failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!data?.url) throw new Error('malformed share response');
  return data;
}
