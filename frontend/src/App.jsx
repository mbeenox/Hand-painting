/**
 * App — top-level state machine.
 *
 *   idle ──upload/snapshot──▶ processing ──path received──▶ drawing ──▶ done
 *     ▲                                                                  │
 *     └──────────────────────── "draw another" ◀──────────────────────────┘
 *
 * Layers (back → front): WatercolorSplash (SVG) · <Canvas> (hand + ink) · UI.
 * The draw is captured for sharing (useDrawCapture), optionally scored with
 * synthesized audio (useDrawSound), and styled via the ControlsPanel settings
 * (persisted to localStorage).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './components/Scene.jsx';
import UploadPanel from './components/UploadPanel.jsx';
import WatercolorSplash from './components/WatercolorSplash.jsx';
import ControlsPanel from './components/ControlsPanel.jsx';
import { useDrawCapture } from './hooks/useDrawCapture.js';
import { useDrawSound } from './hooks/useDrawSound.js';
import { processImage } from './api.js';

const DEFAULT_SETTINGS = {
  inkColor: '#141428',
  weight: 1.0,   // stroke boldness multiplier
  seconds: 30,   // draw duration (manual, when autoTime is off)
  autoTime: true, // adapt duration to the drawing's path length (Feature 1.3)
  splash: 1.0,   // watercolor splash intensity
  detail: 'std', // 'fine' | 'std' | 'dense' → backend point density
  mode: 'trace', // 'trace' (faithful strokes + pen lifts) | 'scribble' (one abstract line)
  instrument: 'duet', // 'duet' | 'violin' | 'piano' → stroke-music voice
  scratch: true, // pen-scratch (nib-on-paper) sound when 🔊 is on
};
const SETTINGS_KEY = 'hh-settings-v1';

// Adaptive draw duration (Feature 1.3): sparse drawings shouldn't drag and
// dense ones shouldn't feel rushed. 1.6 normalized-units/second matches the
// comfortable hand pace of the old fixed default (~47u over 30s); clamp keeps
// pathological inputs (near-blank photos, ultra-dense scribbles) watchable.
const AUTO_PACE_UPS = 1.6; // path units per second
const AUTO_MIN_S = 20;
const AUTO_MAX_S = 42;
export function autoDrawSeconds(pathLength) {
  if (!Number.isFinite(pathLength) || pathLength <= 0) return 30;
  return Math.min(AUTO_MAX_S, Math.max(AUTO_MIN_S, Math.round(pathLength / AUTO_PACE_UPS)));
}

function loadSettings() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

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
  const [pathData, setPathData] = useState(null);
  const [error, setError] = useState(null);
  const [runId, setRunId] = useState(0);
  const [stillBlob, setStillBlob] = useState(null);
  const [soundOn, setSoundOn] = useState(false);
  const [settings, setSettings] = useState(loadSettings);

  const glElRef = useRef(null);
  const splashRef = useRef(null);
  const speedRef = useRef(0);
  const curveRef = useRef(0);
  const soundOnRef = useRef(false);
  const settingsRef = useRef(settings);
  useEffect(() => { soundOnRef.current = soundOn; }, [soundOn]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  const {
    startScratch, stopScratch, startMusic, stopMusic,
    noteOn, noteOff, chime, setSoundEnabled, getAudioStream,
  } = useDrawSound(soundOnRef, speedRef, curveRef, settingsRef);
  // Sound hook first: the capture takes its audio stream so the saved video
  // carries the stroke-violin performance.
  const { start, stop, snapshotPNG, video, recSupported } =
    useDrawCapture(glElRef, splashRef, getAudioStream);

  const updateSettings = useCallback((patch) => setSettings((s) => ({ ...s, ...patch })), []);

  // Stroke events from the Scene → the sound engine, with the user's chosen
  // instrument attached (read via ref so the callback identity stays stable).
  const handleNoteOn = useCallback(
    (pitch01, curve01, estDur) =>
      noteOn(pitch01, curve01, estDur, settingsRef.current.instrument ?? 'duet'),
    [noteOn]
  );

  const handleImage = useCallback(async (fileOrBlob) => {
    setError(null);
    setStillBlob(null);
    setPhase('processing');
    try {
      const data = await processImage(
        fileOrBlob, settingsRef.current.detail, settingsRef.current.mode
      );
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
    stopMusic();
    setStillBlob(null);
    setPathData(null);
    setPhase('idle');
  }, [stop, stopScratch, stopMusic]);

  const toggleSound = useCallback(() => {
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    setSoundOn(next);
    setSoundEnabled(next);
    if (!next) { stopScratch(); stopMusic(); }
  }, [setSoundEnabled, stopScratch, stopMusic]);

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
    const id = setTimeout(stop, 2600);
    return () => clearTimeout(id);
  }, [phase, stop]);

  useEffect(() => {
    if (!video) return undefined;
    let alive = true;
    snapshotPNG().then((b) => { if (alive && b) setStillBlob(b); });
    return () => { alive = false; };
  }, [video, snapshotPNG]);

  // --- sound: scratch + stroke violin while drawing (if enabled),
  //     chime on completion ---
  useEffect(() => {
    if (phase === 'drawing' && soundOn) {
      startScratch();
      startMusic();
    } else {
      stopScratch();
      stopMusic();
    }
  }, [phase, soundOn, startScratch, stopScratch, startMusic, stopMusic]);

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
      } catch { /* cancelled → download */ }
    }
    downloadBlob(blob, 'hypnotic-hand.png');
  }, [stillBlob, snapshotPNG]);

  const shareSupported =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // Draw with the currently chosen style. Captured at draw start (runId/phase
  // change); ink colour is also in the deps so a finished piece recolours live.
  const showSplash = phase === 'drawing' || phase === 'done';
  // Auto mode paces the draw to the path the backend actually returned;
  // manual mode honours the slider. Evaluated per run (runId in the deps).
  const drawSeconds = (settings.autoTime ?? true)
    ? autoDrawSeconds(pathData?.pathLength)
    : settings.seconds;
  const canvas = useMemo(
    () => (
      <Canvas
        key={runId}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => { glElRef.current = gl.domElement; }}
        camera={{ position: [0, 0, 11], fov: 40 }}
        style={{ position: 'absolute', inset: 0 }}
      >
        {pathData && (
          <Scene
            pathData={pathData}
            duration={drawSeconds}
            active={phase === 'drawing'}
            onComplete={handleDrawingDone}
            speedRef={speedRef}
            curveRef={curveRef}
            onNoteOn={handleNoteOn}
            onNoteOff={noteOff}
            inkColor={settings.inkColor}
            weight={settings.weight}
          />
        )}
      </Canvas>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, pathData, phase, handleDrawingDone, settings.inkColor, settings.weight]
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
            <WatercolorSplash count={3} intensity={settings.splash} />
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
      {phase !== 'drawing' && (
        <ControlsPanel settings={settings} onChange={updateSettings} />
      )}
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
