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
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './components/Scene.jsx';
import UploadPanel from './components/UploadPanel.jsx';
import WatercolorSplash from './components/WatercolorSplash.jsx';
import { processImage } from './api.js';

const DRAW_SECONDS = 30; // total drawing duration; longer feels less rushed
                         // and, with the new pacing envelope, lands cleanly.

export default function App() {
  const [phase, setPhase] = useState('idle'); // idle | processing | drawing | done
  const [pathData, setPathData] = useState(null); // { points, aspect, ... }
  const [error, setError] = useState(null);
  // Bumping this key remounts splashes + scene → fresh randomness per drawing.
  const [runId, setRunId] = useState(0);

  const handleImage = useCallback(async (fileOrBlob) => {
    setError(null);
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
    setPathData(null);
    setPhase('idle');
  }, []);

  // Splashes only appear once we're about to draw (they're the base layer
  // the ink is drawn over), and re-randomize per run via the key.
  const showSplash = phase === 'drawing' || phase === 'done';
  const canvas = useMemo(() => (
    <Canvas
      key={runId}
      // alpha:true → the paper/splash DOM layers show through the 3D scene
      gl={{ antialias: true, alpha: true }}
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
  ), [runId, pathData, phase, handleDrawingDone]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#f6f1e7' }}>
      {showSplash && <WatercolorSplash key={`splash-${runId}`} count={3} />}
      {canvas}
      <UploadPanel
        phase={phase}
        error={error}
        onImage={handleImage}
        onReset={reset}
      />
    </div>
  );
}
