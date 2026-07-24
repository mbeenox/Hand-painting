/**
 * UploadPanel — DOM overlay for image input (file upload OR camera
 * snapshot via getUserMedia) and run-state feedback.
 *
 * Also hosts the "…or watch a sample" chips (Feature 1.1): two bundled
 * license-safe portraits (NASA astronaut portrait — public domain; Vermeer's
 * Girl with a Pearl Earring — public domain) fetched same-origin from
 * /samples/ and fed through the exact same onImage path as an upload, so a
 * cold visitor reaches a live drawing in one click.
 */
import React, { useCallback, useRef, useState } from 'react';

const SAMPLES = [
  { src: '/samples/astronaut.jpg', label: 'Astronaut' },
  { src: '/samples/pearl.jpg', label: 'Pearl Earring' },
];

const styles = {
  overlay: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 16,
    background: 'rgba(246, 241, 231, 0.88)', zIndex: 10,
  },
  corner: {
    position: 'absolute', top: 16, right: 16, zIndex: 10,
    display: 'flex', gap: 8, flexWrap: 'wrap',
    justifyContent: 'flex-end', maxWidth: '92vw',
  },
  button: {
    padding: '12px 26px', fontSize: 17, fontFamily: 'Georgia, serif',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#fff',
    color: '#1a1a2e', cursor: 'pointer',
  },
  compact: {
    padding: '9px 18px', fontSize: 15, fontFamily: 'Georgia, serif',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#fff',
    color: '#1a1a2e', cursor: 'pointer',
  },
  title: { fontSize: 42, margin: 0, color: '#1a1a2e', letterSpacing: 1 },
  sub: { fontSize: 16, color: '#5a5a6e', margin: 0 },
  err: { color: '#b3402a', fontSize: 15 },
  video: { borderRadius: 12, maxWidth: '70vw', maxHeight: '50vh' },
  sampleRow: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
  sampleHint: { fontSize: 14, color: '#5a5a6e' },
  sampleChip: {
    padding: 0, width: 56, height: 56, borderRadius: 12, overflow: 'hidden',
    border: '2px solid #1a1a2e', background: '#fff', cursor: 'pointer',
    display: 'block', lineHeight: 0,
  },
  sampleImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
};

export default function UploadPanel({
  phase, error, onImage, onReset,
  onDownloadImage, onShare, shareSupported, videoUrl, videoExt = 'webm',
  gifUrl = null, galleryCount = 0, onOpenGallery = null, paper = null,
}) {
  // Paper-stock tints: the idle screen should read as the same sheet of
  // paper the drawing will happen on, not a white app floating over it.
  const overlayStyle = paper
    ? { ...styles.overlay, background: paper.overlay }
    : styles.overlay;
  const titleStyle = paper ? { ...styles.title, color: paper.text } : styles.title;
  const subStyle = paper ? { ...styles.sub, color: paper.sub } : styles.sub;
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);

  const pickFile = () => fileRef.current?.click();

  // Same-origin fetch → blob → the normal upload pipeline. No backend change.
  const pickSample = useCallback(async (src) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`sample HTTP ${res.status}`);
      onImage(await res.blob());
    } catch {
      console.warn('Sample image unavailable:', src);
    }
  }, [onImage]);
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (f) onImage(f);
    e.target.value = ''; // allow re-uploading the same file
  };

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 } },
      });
      streamRef.current = stream;
      setCameraOn(true);
      // let React mount the <video> first
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      });
    } catch {
      alert && console.warn('Camera unavailable or permission denied.');
    }
  }, []);

  const snap = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stopCamera();
    // toBlob → binary PNG buffer, same multipart pipeline as file upload
    canvas.toBlob((blob) => blob && onImage(blob), 'image/png', 0.95);
  }, [onImage, stopCamera]);

  if (phase === 'drawing') return null; // stay out of the way while drawing

  if (phase === 'done') {
    return (
      <div style={styles.corner}>
        <button style={styles.compact} onClick={onDownloadImage}>Save image ↓</button>
        {videoUrl && (
          <a href={videoUrl} download={`hypnotic-hand.${videoExt}`}
             style={{ textDecoration: 'none' }}>
            <button style={styles.compact}>Save video ↓</button>
          </a>
        )}
        {gifUrl && (
          <a href={gifUrl} download="hypnotic-hand.gif"
             style={{ textDecoration: 'none' }}>
            <button style={styles.compact}>Save GIF ↓</button>
          </a>
        )}
        {shareSupported && (
          <button style={styles.compact} onClick={onShare}>Share ↗</button>
        )}
        <button style={styles.compact} onClick={onReset}>Draw another ↺</button>
      </div>
    );
  }

  return (
    <div style={overlayStyle}>
      {galleryCount > 0 && onOpenGallery && (
        <div style={styles.corner}>
          <button
            style={styles.compact}
            onClick={onOpenGallery}
            aria-label="Open gallery"
          >
            Gallery · {galleryCount}
          </button>
        </div>
      )}
      <h1 style={titleStyle}>Hypnotic Hand</h1>
      <p style={subStyle}>
        Upload a photo — a hand will draw it as one continuous line.
      </p>
      {error && <p style={styles.err}>⚠ {error}</p>}

      {phase === 'processing' ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <svg width="46" height="46" viewBox="0 0 46 46" className="hh-spin" aria-hidden="true">
            <circle cx="23" cy="23" r="19" fill="none" stroke="#1a1a2e" strokeOpacity="0.15" strokeWidth="3" />
            <path d="M23 4 a19 19 0 0 1 19 19" fill="none" stroke="#1a1a2e" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <p style={subStyle}>Tracing your portrait…</p>
        </div>
      ) : cameraOn ? (
        <>
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={styles.button} onClick={snap}>Snap 📸</button>
            <button style={styles.button} onClick={stopCamera}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={styles.button} onClick={pickFile}>Upload photo</button>
            <button style={styles.button} onClick={startCamera}>Use camera</button>
          </div>
          <div style={styles.sampleRow}>
            <span style={paper ? { ...styles.sampleHint, color: paper.sub } : styles.sampleHint}>…or watch a sample</span>
            {SAMPLES.map((s) => (
              <button
                key={s.src}
                style={styles.sampleChip}
                title={`Draw the ${s.label} sample`}
                aria-label={`Draw sample: ${s.label}`}
                onClick={() => pickSample(s.src)}
              >
                <img src={s.src} alt={s.label} style={styles.sampleImg} loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}

      <input
        ref={fileRef} type="file" accept="image/*"
        style={{ display: 'none' }} onChange={onFile}
      />
    </div>
  );
}
