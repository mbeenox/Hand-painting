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

const VIDEO_MIMES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4', // Safari records mp4/H.264 rather than webm
];
function pickMime() {
  if (typeof window === 'undefined' || !('MediaRecorder' in window)) return '';
  return (
    VIDEO_MIMES.find((t) => {
      try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
    }) || ''
  );
}

export function useDrawCapture(canvasElRef, splashRef, paper = PAPER) {
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

    let recorder;
    try {
      recorder = new MediaRecorder(comp.captureStream(VIDEO_FPS), { mimeType: mime });
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
      const type = mime || 'video/webm';
      const blob = new Blob(chunksRef.current, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      setVideo({ url: URL.createObjectURL(blob), ext });
    };
    recorderRef.current = recorder;
    recorder.start();
  }, [recSupported, canvasElRef, rasterizeSplash, composite, mime]);

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
