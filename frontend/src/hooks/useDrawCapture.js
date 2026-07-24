/**
 * useDrawCapture — turn the drawing into shareable media (PNG + video).
 *
 * The 3D ink lives in an alpha-transparent WebGL canvas that sits ON TOP of the
 * DOM paper colour + the WatercolorSplash <svg>. A raw WebGL screenshot or
 * canvas.captureStream() would therefore miss that background, so we composite:
 *
 *     [paper fill] → [rasterized splash <svg>] → [WebGL canvas]  → a 2D canvas
 *
 * - snapshotPNG(): composite once at high res → a PNG blob ("Save image").
 * - start()/stop(): run the composite in a rAF loop into a smaller canvas whose
 *   captureStream() feeds a MediaRecorder → a webm/mp4 of the whole draw.
 *
 * The WebGL canvas MUST be created with preserveDrawingBuffer:true so its pixels
 * can be read back (drawImage) at any time, not just mid-render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PAPER = '#f6f1e7';
const PNG_MAX = 1600;   // long-side cap for the still image
const VIDEO_MAX = 960;  // long-side cap for the recording (keeps encoding light)
const VIDEO_FPS = 24;

// MP4 (H.264 + AAC) FIRST: it's the only container iPhones play everywhere
// (Photos, iMessage, AirDrop) — .webm files shared to an iPhone often won't
// open at all. Chrome (126+) and Safari both record mp4; Firefox falls back
// to webm. Audio-capable combos before video-only ones: the recording
// carries the stroke-music mix when sound is on (a mimeType with an audio
// codec but a still-silent track is fine — the track is attached at record
// start and carries silence until the user enables sound).
// Order rationale (verified against isTypeSupported behavior):
// 1. EXPLICIT H.264+AAC mp4 — branded Chrome/Edge (126+) accept these and
//    produce the one container iPhones play everywhere.
// 2. webm+opus — Firefox and codec-less Chromium builds land here; those
//    builds accept a BARE 'video/mp4' but silently mux Opus into it (no AAC
//    encoder), producing an mp4 iPhones still can't play — which is why the
//    bare form is LAST, not first (caught by the E2E audio-box assertion).
// 3. bare 'video/mp4' — Safari's path; its only encoder is H.264+AAC, so
//    the result is iPhone-safe anyway.
const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];
function pickMime() {
  if (typeof window === 'undefined' || !('MediaRecorder' in window)) return '';
  return (
    VIDEO_MIMES.find((t) => {
      try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
    }) || ''
  );
}

export function useDrawCapture(canvasElRef, splashRef, getAudioStream = null, paper = PAPER) {
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(0);
  const [video, setVideo] = useState(null); // { url, ext } | null

  const mime = useMemo(pickMime, []);
  const recSupported = useMemo(
    () =>
      typeof HTMLCanvasElement !== 'undefined' &&
      'captureStream' in HTMLCanvasElement.prototype &&
      !!mime,
    [mime]
  );

  // Rasterize the live splash <svg> at (w×h) into an <img> we can drawImage.
  const rasterizeSplash = useCallback(
    (w, h) =>
      new Promise((resolve) => {
        try {
          const svg = splashRef.current?.querySelector('svg');
          if (!svg) return resolve(null);
          const clone = svg.cloneNode(true);
          clone.setAttribute('width', String(w));
          clone.setAttribute('height', String(h));
          const xml = new XMLSerializer().serializeToString(clone);
          const url =
            'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        } catch {
          resolve(null);
        }
      }),
    [splashRef]
  );

  const composite = useCallback(
    (ctx, w, h, splashImg) => {
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, w, h);
      if (splashImg) { try { ctx.drawImage(splashImg, 0, 0, w, h); } catch { /* noop */ } }
      const el = canvasElRef.current;
      if (el) { try { ctx.drawImage(el, 0, 0, w, h); } catch { /* noop */ } }
    },
    [canvasElRef, paper]
  );

  const start = useCallback(async () => {
    if (!recSupported) return;
    const el = canvasElRef.current;
    if (!el || !el.width || !el.height) return;
    setVideo((v) => { if (v?.url) URL.revokeObjectURL(v.url); return null; });

    const scale = Math.min(1, VIDEO_MAX / Math.max(el.width, el.height));
    const w = Math.max(2, Math.round(el.width * scale));
    const h = Math.max(2, Math.round(el.height * scale));
    const comp = document.createElement('canvas');
    comp.width = w;
    comp.height = h;
    const ctx = comp.getContext('2d');
    const splashImg = await rasterizeSplash(w, h);

    const loop = () => {
      composite(ctx, w, h, splashImg);
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    // Video from the compositing canvas + (when available) the Web Audio mix
    // so the saved clip carries the stroke-violin performance. The audio
    // track exists from record start; it is silent until sound is enabled.
    const stream = comp.captureStream(VIDEO_FPS);
    try {
      const audio = typeof getAudioStream === 'function' ? getAudioStream() : null;
      audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch { /* video-only recording is still fine */ }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      cancelAnimationFrame(rafRef.current);
      // Trust the recorder's ACTUAL mimeType (browsers may normalize the
      // requested one) so the blob type and file extension always match
      // the real container.
      const type = recorder.mimeType || mime || 'video/webm';
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      setVideo({ url: URL.createObjectURL(blob), ext });
    };
    recorderRef.current = recorder;
    recorder.start();
  }, [recSupported, canvasElRef, rasterizeSplash, composite, mime, getAudioStream]);

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') { try { r.stop(); } catch { /* noop */ } }
    recorderRef.current = null;
  }, []);

  const snapshotPNG = useCallback(async () => {
    const el = canvasElRef.current;
    if (!el || !el.width || !el.height) return null;
    const scale = Math.min(1, PNG_MAX / Math.max(el.width, el.height));
    const w = Math.max(2, Math.round(el.width * scale));
    const h = Math.max(2, Math.round(el.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const splashImg = await rasterizeSplash(w, h);
    composite(ctx, w, h, splashImg);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }, [canvasElRef, rasterizeSplash, composite]);

  // Stop everything if the component unmounts mid-record.
  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      const r = recorderRef.current;
      if (r && r.state !== 'inactive') { try { r.stop(); } catch { /* noop */ } }
    },
    []
  );

  return { start, stop, snapshotPNG, video, recSupported };
}
