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
import GalleryWall from './components/GalleryWall.jsx';
import { useDrawCapture } from './hooks/useDrawCapture.js';
import { useDrawSound } from './hooks/useDrawSound.js';
import { useGallery } from './hooks/useGallery.js';
import { processImage } from './api.js';
import { getPaper, DEFAULT_PAPER } from './lib/papers.js';

const DEFAULT_SETTINGS = {
  paper: DEFAULT_PAPER, // paper stock: 'ivory' | 'noir' | 'kraft' | 'slate'
  inkColor: '#141428',
  weight: 1.0,   // stroke boldness multiplier
  seconds: 30,   // draw duration (manual, when autoTime is off)
  autoTime: true, // adapt duration to the drawing's path length (Feature 1.3)
  splash: 1.0,   // watercolor splash intensity
  detail: 'std', // 'fine' | 'std' | 'dense' → backend point density
  mode: 'trace', // 'trace' (faithful strokes + pen lifts) | 'scribble' (one abstract line)
  instrument: 'duet', // 'duet' | 'violin' | 'piano' → stroke-music voice
  mood: 'dawn',  // 'dawn' | 'dusk' | 'sakura' | 'hymn' → key/drone/character
  scratch: false, // pen-scratch (nib-on-paper) sound when 🔊 is on — OFF by default
  sound: true,   // master 🔊 toggle — the show performs its music by default
  _v: 2,         // settings schema version (migration in loadSettings)
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
    if (raw) {
      const saved = JSON.parse(raw);
      // v2 migration (2026-07-24): pen scratch flipped to OFF-by-default and
      // sound became on-by-default. Pre-v2 stores carry scratch:true only
      // because the OLD default was persisted wholesale — flip those two to
      // the new defaults ONCE; everything else the user chose is kept.
      if ((saved._v ?? 1) < 2) {
        saved.scratch = false;
        saved.sound = true;
        saved._v = 2;
      }
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

// Gallery thumbnail (Feature 2.1): the finished still, shrunk to ≤256px long
// side as a JPEG dataURL (~30–50 KB) — small enough that 24 of them live
// comfortably in localStorage.
const THUMB_MAX = 256;
async function makeThumb(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(bmp.width * scale));
    c.height = Math.max(2, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
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
  const [settings, setSettings] = useState(loadSettings);
  // Sound is ON by default (and remembered): the context itself still only
  // starts inside a user gesture — the upload / sample / snap click that
  // begins every draw provides it (sticky activation), so autoplay policy
  // is satisfied without requiring a trip to the 🔊 button.
  const [soundOn, setSoundOn] = useState(settings.sound ?? true);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const glElRef = useRef(null);
  const splashRef = useRef(null);
  const speedRef = useRef(0);
  const curveRef = useRef(0);
  const soundOnRef = useRef(settings.sound ?? true);
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
  // Paper stock: ground colour + harmonized inks/splashes/UI tints.
  const paper = getPaper(settings.paper);

  // Sound hook first: the capture takes its audio stream so the saved video
  // carries the stroke-violin performance. Exports composite on the CURRENT
  // paper and caption in its watermark colour.
  const { start, stop, snapshotPNG, video, gif, recSupported } =
    useDrawCapture(glElRef, splashRef, getAudioStream, paper.bg, paper.watermark);
  const { entries: galleryEntries, addEntry, removeEntry, clear: clearGallery } =
    useGallery();

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
    // This runs inside the upload/sample/camera CLICK — the user gesture that
    // lets the (on-by-default) AudioContext start before the draw begins.
    if (soundOnRef.current) setSoundEnabled(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSoundEnabled]);

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
    setSettings((s) => ({ ...s, sound: next })); // remembered across visits
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

  // Gallery (Feature 2.1): once the clean still exists, save a thumbnail +
  // the settings that produced it. Guarded per run so re-renders can't
  // double-save.
  const savedRunRef = useRef(0);
  useEffect(() => {
    if (!stillBlob || phase !== 'done' || savedRunRef.current === runId) return;
    savedRunRef.current = runId;
    const s = settingsRef.current;
    const seconds = (s.autoTime ?? true)
      ? autoDrawSeconds(pathData?.pathLength)
      : s.seconds;
    makeThumb(stillBlob).then((thumb) => {
      if (!thumb) return;
      addEntry(thumb, {
        mode: s.mode ?? 'trace',
        detail: s.detail,
        instrument: s.instrument ?? 'duet',
        paper: s.paper ?? DEFAULT_PAPER,
        seconds,
        strokes: pathData?.breaks?.length || undefined,
      });
    });
  }, [stillBlob, phase, runId, pathData, addEntry]);

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
    <div style={{ position: 'fixed', inset: 0, background: paper.bg }}>
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
            <WatercolorSplash
              count={3}
              intensity={settings.splash}
              palettes={paper.splashes}
            />
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
        paper={paper}
        error={error}
        onImage={handleImage}
        onReset={reset}
        onDownloadImage={downloadImage}
        onShare={share}
        shareSupported={shareSupported}
        videoUrl={video?.url ?? null}
        videoExt={video?.ext ?? 'webm'}
        gifUrl={gif?.url ?? null}
        recSupported={recSupported}
        galleryCount={galleryEntries.length}
        onOpenGallery={() => setGalleryOpen(true)}
      />
      {galleryOpen && (
        <GalleryWall
          paper={paper}
          entries={galleryEntries}
          onRemove={removeEntry}
          onClear={clearGallery}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </div>
  );
}
