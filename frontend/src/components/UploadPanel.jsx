/**
 * UploadPanel — DOM overlay for image input (file upload OR camera
 * snapshot via getUserMedia) and run-state feedback.
 */
import React, { useCallback, useRef, useState } from 'react';

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
};

export default function UploadPanel({
  phase, error, onImage, onReset,
  onDownloadImage, onShare, shareSupported, videoUrl, videoExt = 'webm',
}) {
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);

  const pickFile = () => fileRef.current?.click();
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
        {shareSupported && (
          <button style={styles.compact} onClick={onShare}>Share ↗</button>
        )}
        <button style={styles.compact} onClick={onReset}>Draw another ↺</button>
      </div>
    );
  }

  return (
    <div style={styles.overlay}>
      <h1 style={styles.title}>Hypnotic Hand</h1>
      <p style={styles.sub}>
        Upload a photo — a hand will draw it as one continuous line.
      </p>
      {error && <p style={styles.err}>⚠ {error}</p>}

      {phase === 'processing' ? (
        <p style={styles.sub}>Tracing your portrait…</p>
      ) : cameraOn ? (
        <>
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={styles.button} onClick={snap}>Snap 📸</button>
            <button style={styles.button} onClick={stopCamera}>Cancel</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={styles.button} onClick={pickFile}>Upload photo</button>
          <button style={styles.button} onClick={startCamera}>Use camera</button>
        </div>
      )}

      <input
        ref={fileRef} type="file" accept="image/*"
        style={{ display: 'none' }} onChange={onFile}
      />
    </div>
  );
}
