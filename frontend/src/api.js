/**
 * Image → path API bridge.
 *
 * The image travels as multipart/form-data (the raw File/Blob buffer —
 * no base64 inflation), and the backend answers with JSON:
 *   { points: [[x, y], ...], aspect, numSampled, pathLength }
 *
 * In dev, Vite proxies "/api/*" → http://localhost:8000 (see vite.config.js),
 * which sidesteps CORS entirely; the FastAPI CORS middleware additionally
 * allows direct localhost origins if you point API_BASE at :8000 yourself.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

// Vercel serverless functions reject request bodies over ~4.5 MB, and a
// modern phone photo is easily 5–12 MB. The backend downscales to 640 px
// anyway, so shrinking in the browser first loses nothing: draw the image
// into a canvas capped at MAX_UPLOAD_DIM and re-encode as JPEG.
const MAX_UPLOAD_DIM = 1280;
const JPEG_QUALITY = 0.85;

async function downscaleImage(fileOrBlob) {
  try {
    const bitmap = await createImageBitmap(fileOrBlob);
    const scale = MAX_UPLOAD_DIM / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) { bitmap.close?.(); return fileOrBlob; } // already small
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((res) =>
      canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY)
    );
    return blob ?? fileOrBlob;
  } catch {
    return fileOrBlob; // decode failure → let the backend report it properly
  }
}

export async function processImage(fileOrBlob) {
  const upload = await downscaleImage(fileOrBlob);
  const form = new FormData();
  // Field name MUST be "file" to match the FastAPI parameter.
  form.append('file', upload, fileOrBlob.name ?? 'snapshot.jpg');

  const res = await fetch(`${API_BASE}/process-image`, {
    method: 'POST',
    body: form, // browser sets the multipart boundary header itself
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return res.json();
}
