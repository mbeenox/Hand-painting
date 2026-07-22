/**
 * App — top-level state machine.
 *
 *   idle ──upload/snapshot──▶ processing ──path received──▶ drawing ──▶ done
 *     ▲                                                                  │
 *     └──────────────────────── "draw another" ◀──────────────────────────┘
 *
 * Layers (back → front):
 *   1. WatercolorSplash — randomized CSS/SVG blobs (the "splash hook")
 *   2. <Canvas>          — transparent-background R3F scene (hand + ink)
 *   3. UploadPanel       — DOM UI overlay
 *
 * The draw is also captured (paper + splash + ink) as a shareable PNG and video
 * via useDrawCapture — see that hook for the compositing rationale.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './components/Scene.jsx';
import UploadPanel from './components/UploadPanel.jsx';
import WatercolorSplash from './components/WatercolorSplash.jsx';
import { useDrawCapture } from './hooks/useDrawCapture.js';
import { processImage } from './api.js';

const DRAW_SECONDS = 30; // total drawing duration; longer feels less rushed
                         // and, with the pacing envelope, lands cleanly.

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function App() {
  const [phase, setPhase] = useState('idle'); // idle | processing | drawing | done
  const [pathData, setPathData] = useState(null); // { points, aspect, ... }
  const [error, setError] = useState(null);
  // Bumping this key remounts splashes + scene → fresh randomness per drawing.
  const [runId, setRunId] = useState(0);
  const [stillBlob, setStillBlob] = useState(null); // clean, hand-free PNG

  const glElRef = useRef(null);   // the WebGL <canvas> DOM element
  const splashRef = useRef(null); // wrapper around the splash <svg>
  const { start, stop, snapshotPNG, video, recSupported } = useDrawCapture(
    glElRef,
    splashRef
  );

  const handleImage = useCallback(async (fileOrBlob) => {
    setError(null);
    setStillBlob(null);
    setPhase('processing');
    try {
      const data = await processImage(fileOrBlob);
      setPathData(data);
      setRunId((n) => n + 1);
      setPhase('drawing');
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
  }, []);

  const handleDrawingDone = useCallback(() => setPhase('done'), []);
  const reset = useCallback(() => {
    stop();
    setStillBlob(null);
    setPathData(null);
    setPhase('idle');
  }, [stop]);

  // Record the draw: start once the GL canvas exists, stop a beat after
  // completion so the clip ends on the finished art (hand already retreated).
  useEffect(() => {
    if (phase !== 'drawing') return undefined;
    let raf;
    let tries = 0;
    const tryStart = () => {
      if (glElRef.current) start();
      else if (tries++ < 60) raf = requestAnimationFrame(tryStart);
    };
    tryStart();
    return () => raf && cancelAnimationFrame(raf);
  }, [phase, start]);

  useEffect(() => {
    if (phase !== 'done') return undefined;
    const id = setTimeout(stop, 2600);
    return () => clearTimeout(id);
  }, [phase, stop]);

  // Once recording has stopped (hand off-canvas), grab a clean still to reuse
  // for Save/Share so the exported image never contains the retreating hand.
  useEffect(() => {
    if (!video) return undefined;
    let alive = true;
    snapshotPNG().then((b) => {
      if (alive && b) setStillBlob(b);
    });
    return () => {
      alive = false;
    };
  }, [video, snapshotPNG]);

  const downloadImage = useCallback(async () => {
    const blob = stillBlob || (await snapshotPNG());
    if (blob) downloadBlob(blob, 'hypnotic-hand.png');
  }, [stillBlob, snapshotPNG]);

  const share = useCallback(async () => {
    const blob = stillBlob || (await snapshotPNG());
    if (!blob) return;
    const file = new File([blob], 'hypnotic-hand.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: 'Hypnotic Hand',
          text: 'My photo, drawn as one continuous line ✍️',
        });
        return;
      } catch {
        /* user cancelled or share failed → fall through to a download */
      }
    }
    downloadBlob(blob, 'hypnotic-hand.png');
  }, [stillBlob, snapshotPNG]);

  const shareSupported =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // Splashes only appear once we're about to draw (they're the base layer
  // the ink is drawn over), and re-randomize per run via the key.
  const showSplash = phase === 'drawing' || phase === 'done';
  const canvas = useMemo(
    () => (
      <Canvas
        key={runId}
        // alpha:true → the paper/splash DOM layers show through the 3D scene.
        // preserveDrawingBuffer:true → the frame can be read back for export.
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          glElRef.current = gl.domElement;
        }}
        camera={{ position: [0, 0, 11], fov: 40 }}
        style={{ position: 'absolute', inset: 0 }}
      >
        {pathData && (
          <Scene
            pathData={pathData}
            duration={DRAW_SECONDS}
            active={phase === 'drawing'}
            onComplete={handleDrawingDone}
          />
        )}
      </Canvas>
    ),
    [runId, pathData, phase, handleDrawingDone]
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#f6f1e7' }}>
      <div
        ref={splashRef}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      >
        {showSplash && <WatercolorSplash key={`splash-${runId}`} count={3} />}
      </div>
      {canvas}
      <UploadPanel
        phase={phase}
        error={error}
        onImage={handleImage}
        onReset={reset}
        onDownloadImage={downloadImage}
        onShare={share}
        shareSupported={shareSupported}
        videoUrl={video?.url ?? null}
        videoExt={video?.ext ?? 'webm'}
        recSupported={recSupported}
      />
    </div>
  );
}
