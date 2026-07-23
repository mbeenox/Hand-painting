/**
 * App — top-level state machine.
 *
 *   idle ──upload/snapshot──▶ processing ──path received──▶ drawing ──▶ done
 *     ▲                                                                  │
 *     └──────────────────────── "draw another" ◀──────────────────────────┘
 *
 * Layers (back → front): WatercolorSplash (SVG) · <Canvas> (hand + ink) · UI.
 * The draw is captured for sharing (useDrawCapture) and optionally scored with
 * synthesized pen-scratch + a completion chime (useDrawSound).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './components/Scene.jsx';
import UploadPanel from './components/UploadPanel.jsx';
import WatercolorSplash from './components/WatercolorSplash.jsx';
import { useDrawCapture } from './hooks/useDrawCapture.js';
import { useDrawSound } from './hooks/useDrawSound.js';
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

const soundBtn = {
  position: 'absolute', top: 16, left: 16, zIndex: 11,
  width: 44, height: 44, borderRadius: 999, border: '2px solid #1a1a2e',
  background: '#fff', color: '#1a1a2e', cursor: 'pointer', fontSize: 18, lineHeight: 1,
};

export default function App() {
  const [phase, setPhase] = useState('idle'); // idle | processing | drawing | done
  const [pathData, setPathData] = useState(null); // { points, aspect, ... }
  const [error, setError] = useState(null);
  // Bumping this key remounts splashes + scene → fresh randomness per drawing.
  const [runId, setRunId] = useState(0);
  const [stillBlob, setStillBlob] = useState(null); // clean, hand-free PNG
  const [soundOn, setSoundOn] = useState(false);

  const glElRef = useRef(null);   // the WebGL <canvas> DOM element
  const splashRef = useRef(null); // wrapper around the splash <svg>
  const speedRef = useRef(0);     // pen speed (world units/sec), written by Scene
  const soundOnRef = useRef(false);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);

  const { start, stop, snapshotPNG, video, recSupported } = useDrawCapture(
    glElRef,
    splashRef
  );
  const { startScratch, stopScratch, chime, setSoundEnabled } = useDrawSound(
    soundOnRef,
    speedRef
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
    stopScratch();
    setStillBlob(null);
    setPathData(null);
    setPhase('idle');
  }, [stop, stopScratch]);

  const toggleSound = useCallback(() => {
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    setSoundOn(next);
    setSoundEnabled(next); // create/resume the AudioContext within this gesture
    if (!next) stopScratch();
  }, [setSoundEnabled, stopScratch]);

  // --- capture: record the draw, then grab a clean (hand-free) still ---
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
    const id = setTimeout(stop, 2600); // end the clip after the hand retreats
    return () => clearTimeout(id);
  }, [phase, stop]);

  useEffect(() => {
    if (!video) return undefined;
    let alive = true;
    snapshotPNG().then((b) => { if (alive && b) setStillBlob(b); });
    return () => { alive = false; };
  }, [video, snapshotPNG]);

  // --- sound: scratch while drawing (if enabled), chime on completion ---
  useEffect(() => {
    if (phase === 'drawing' && soundOn) startScratch();
    else stopScratch();
  }, [phase, soundOn, startScratch, stopScratch]);

  useEffect(() => {
    if (phase === 'done' && soundOn) chime();
  }, [phase, soundOn, chime]);

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

  // Splashes only appear once we're about to draw (they're the base layer the
  // ink is drawn over), fade in softly, and re-randomize per run via the key.
  const showSplash = phase === 'drawing' || phase === 'done';
  const canvas = useMemo(
    () => (
      <Canvas
        key={runId}
        // alpha:true → paper/splash DOM layers show through the 3D scene.
        // preserveDrawingBuffer:true → the frame can be read back for export.
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => { glElRef.current = gl.domElement; }}
        camera={{ position: [0, 0, 11], fov: 40 }}
        style={{ position: 'absolute', inset: 0 }}
      >
        {pathData && (
          <Scene
            pathData={pathData}
            duration={DRAW_SECONDS}
            active={phase === 'drawing'}
            onComplete={handleDrawingDone}
            speedRef={speedRef}
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
        {showSplash && (
          <div
            key={`splash-${runId}`}
            className="hh-fade-in"
            style={{ position: 'absolute', inset: 0 }}
          >
            <WatercolorSplash count={3} />
          </div>
        )}
      </div>
      {canvas}
      <button
        onClick={toggleSound}
        aria-label={soundOn ? 'Mute sound' : 'Enable sound'}
        title={soundOn ? 'Sound on' : 'Sound off'}
        style={soundBtn}
      >
        {soundOn ? '🔊' : '🔇'}
      </button>
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
