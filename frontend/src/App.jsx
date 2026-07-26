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
import { truncatePath } from './lib/truncatePath.js';
import { appendCaption } from './lib/caption.js';
import { loadHersheyFont } from './lib/hershey.js';
import { todaysMasterpiece, fetchArtwork } from './lib/masterpiece.js';
import { composeDuet } from './lib/composeDuet.js';

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
  completeness: 1.0, // how far the artist goes (0.3–2.0; 1.0 = classic full)
  signDate: false, // "Sign & date": the hand signs the piece when it's done
  scratch: false, // pen-scratch (nib-on-paper) sound when 🔊 is on — OFF by default
  sound: true,   // master 🔊 toggle — the show performs its music by default
  _v: 2,         // settings schema version (migration in loadSettings)
};
const SETTINGS_KEY = 'hh-settings-v1';

// Adaptive draw duration (Feature 1.3): sparse drawings shouldn't drag and
// dense ones shouldn't feel rushed. 1.6 normalized-units/second matches the
// comfortable hand pace of the old fixed default (~47u over 30s); clamp keeps
// pathological inputs (near-blank photos, ultra-dense scribbles) watchable.
// Instant replay (Feature 5.2): the SAME path and timetable, run fast. Not a
// new drawing — no backend call, no new stroke order, no new melody, and
// nothing re-recorded. Just the pleasure of watching it happen again.
const REPLAY_SPEED = 4;
const REPLAY_MIN_S = 4;

// Two-photo duet (4.3): each panel is traced one notch COARSER than the
// viewer's setting. Two reasons, and the second is not optional — a panel is
// drawn at roughly half width, so the same stroke budget reads as mush; and
// two panels at `dense` would need ~25.8k ribbon centers against InkTrail's
// 26k ceiling once a written caption is added, which would silently truncate
// the end of the drawing.
const DUET_DETAIL = { dense: 'std', std: 'fine', fine: 'fine' };

const AUTO_PACE_UPS = 1.6; // path units per second
const AUTO_MIN_S = 20;
const AUTO_MAX_S = 58; // raised from 42 for the 200%-completeness ceiling —
                       // maxed-out drawings need room to breathe (2026-07-24)
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

// The hand writes (Feature 5.1). The Hershey font is a lazy chunk, so this
// is async — and deliberately forgiving: if the chunk fails to load, the
// portrait still draws. A dedication is a bonus, never a gate.
async function withCaption(path, dedication, signDate) {
  if (!(dedication || '').trim() && !signDate) return path;
  try {
    return appendCaption(path, await loadHersheyFont(), {
      dedication, signDate, date: new Date(),
    });
  } catch (e) {
    console.warn('Caption unavailable; drawing without it.', e);
    return path;
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
  // Dedication (Feature 5.1) lives in component state ON PURPOSE — a
  // dedication belongs to the gift being made, not to the person making it,
  // so it survives "draw another" but never the tab. (The "Sign & date"
  // option IS a lasting preference, so that one lives in settings.)
  const [dedication, setDedication] = useState('');
  // Feature 5.2. `replaying` re-runs the finished path fast; `sourceUrl` is
  // the uploaded photo, kept alive for the ghost reveal and revoked the
  // moment it is replaced.
  const [replaying, setReplaying] = useState(false);
  const [replayId, setReplayId] = useState(0);
  // One entry per source photo: a single drawing has one, a duet has two.
  const [sourceUrls, setSourceUrls] = useState([]);
  // Today's masterpiece (5.3) — null until (and unless) it resolves.
  const [masterpiece, setMasterpiece] = useState(null);

  const glElRef = useRef(null);
  const sourceRef = useRef(null);     // { blobs, opts } → Redraw
  const sourceUrlsRef = useRef([]);   // the live object URLs (ownership)
  const replayingRef = useRef(false);
  const splashRef = useRef(null);
  const speedRef = useRef(0);
  const curveRef = useRef(0);
  const soundOnRef = useRef(settings.sound ?? true);
  const settingsRef = useRef(settings);
  const dedicationRef = useRef('');
  useEffect(() => { dedicationRef.current = dedication; }, [dedication]);
  useEffect(() => { replayingRef.current = replaying; }, [replaying]);
  // Object URLs are a manual resource; release the last one on teardown.
  useEffect(() => () => {
    sourceUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
  }, []);
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
  // `panelVoice` arrives only on a two-photo duet (4.3), and only overrides
  // the DEFAULT duet split — a viewer who explicitly asked for violin-only
  // still gets violin on both portraits.
  const handleNoteOn = useCallback(
    (pitch01, curve01, estDur, panelVoice) => {
      const chosen = settingsRef.current.instrument ?? 'duet';
      noteOn(pitch01, curve01, estDur,
        chosen === 'duet' && panelVoice ? panelVoice : chosen);
    },
    [noteOn]
  );

  // Own the object URLs for the source photo(s): revoke the previous set,
  // mint a new one per image. Never throws — no reveal is always better than
  // no drawing.
  const rememberSources = useCallback((blobs, opts = {}) => {
    sourceRef.current = { blobs, opts };
    sourceUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    try {
      sourceUrlsRef.current = blobs.map((b) => URL.createObjectURL(b));
    } catch {
      sourceUrlsRef.current = [];
    }
    setSourceUrls(sourceUrlsRef.current);
  }, []);

  // The tail every run shares: cut to Completeness, then write the
  // dedication, then show it. Order matters — a dedication is a promise, not
  // a level of detail, so it is written in full even when the portrait above
  // it is a 40% gestural sketch.
  const present = useCallback(async (data) => {
    let path = truncatePath(data, settingsRef.current.completeness ?? 1);
    path = await withCaption(path, dedicationRef.current,
                             settingsRef.current.signDate);
    setPathData(path);
    setRunId((n) => n + 1);
    setPhase('drawing');
  }, []);

  const handleImage = useCallback(async (fileOrBlob, opts = {}) => {
    setError(null);
    setStillBlob(null);
    setReplaying(false);
    // Hold on to the source (Feature 5.2): the blob so "Redraw" can run the
    // whole pipeline again, and an object URL so the ghost reveal has a photo
    // to show. Neither ever leaves the device.
    rememberSources([fileOrBlob], opts);
    // This runs inside the upload/sample/camera CLICK — the user gesture that
    // lets the (on-by-default) AudioContext start before the draw begins.
    if (soundOnRef.current) setSoundEnabled(true);
    setPhase('processing');
    try {
      const data = await processImage(
        fileOrBlob, settingsRef.current.detail, settingsRef.current.mode,
        opts.focus ?? 'none'
      );
      // Completeness dial: strokes arrive in artist passes (contours →
      // structure → details), so cutting the tail leaves a coherent,
      // intentionally-unfinished sketch. Applied per run, like detail.
      await present(data);
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSoundEnabled, rememberSources, present]);

  /**
   * Two photographs, one drawing (4.3). Two parallel calls to the SAME
   * endpoint — no backend change — then `composeDuet` welds the results into
   * a single path the rest of the app cannot tell from an ordinary one.
   * If one side fails to trace, the other is drawn alone rather than
   * throwing away a good photograph.
   */
  const handleDuet = useCallback(async (blobA, blobB) => {
    if (!blobA || !blobB) return;
    setError(null);
    setStillBlob(null);
    setReplaying(false);
    rememberSources([blobA, blobB], { duet: true });
    if (soundOnRef.current) setSoundEnabled(true);
    setPhase('processing');
    try {
      const s = settingsRef.current;
      const detail = DUET_DETAIL[s.detail] ?? 'fine';
      const [a, b] = await Promise.all([
        processImage(blobA, detail, s.mode),
        processImage(blobB, detail, s.mode),
      ]);
      const composed = composeDuet(a, b);
      if (!composed) throw new Error('Neither photo could be traced.');
      await present(composed);
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSoundEnabled, rememberSources, present]);

  // A replay ends by clearing `replaying`; a real draw ends by finishing.
  // Read through a ref so this callback's identity stays stable — it is a
  // dependency of the memoized <Canvas>.
  const handleDrawingDone = useCallback(() => {
    if (replayingRef.current) setReplaying(false);
    else setPhase('done');
  }, []);

  // Watch it happen again, fast. Bumping replayId remounts the Canvas, which
  // is what resets InkTrail's append-only buffer; pathData is untouched, so
  // the strokes, their order and the melody are identical.
  const replay = useCallback(() => {
    if (!pathData || replayingRef.current) return;
    replayingRef.current = true;
    setReplaying(true);
    setReplayId((n) => n + 1);
  }, [pathData]);

  // Same photo, whole pipeline again: new stroke order, new melody, new
  // drawing. The app's thesis in one button.
  const redraw = useCallback(() => {
    const src = sourceRef.current;
    if (!src?.blobs?.length) return;
    if (src.blobs.length > 1) handleDuet(src.blobs[0], src.blobs[1]);
    else handleImage(src.blobs[0], src.opts);
  }, [handleImage, handleDuet]);

  // Today's masterpiece (5.3). Resolved once, after first paint, and never
  // awaited by anything on the critical path — if it fails, the chip is
  // simply absent and the app is exactly as it was.
  useEffect(() => {
    let alive = true;
    todaysMasterpiece()
      .then((m) => { if (alive) setMasterpiece(m); })
      .catch(() => { /* no chip */ });
    return () => { alive = false; };
  }, []);

  const drawMasterpiece = useCallback(async () => {
    if (!masterpiece) return;
    try {
      handleImage(await fetchArtwork(masterpiece));
    } catch (e) {
      console.warn('Could not fetch today’s masterpiece.', e);
      setError('Could not reach today’s masterpiece — try a photo instead.');
    }
  }, [masterpiece, handleImage]);

  const reset = useCallback(() => {
    stop();
    stopScratch();
    stopMusic();
    setStillBlob(null);
    setPathData(null);
    setReplaying(false);
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
        completeness: pathData?.completeness ?? 1,
        // What the hand wrote (5.1) — a gift is worth labelling on the wall.
        dedication: pathData?.caption?.dedication || undefined,
        seconds,
        strokes: pathData?.breaks?.length || undefined,
      });
    });
  }, [stillBlob, phase, runId, pathData, addEntry]);

  // --- sound: scratch + stroke violin while drawing (if enabled),
  //     chime on completion ---
  useEffect(() => {
    // A replay is a performance too — it plays the same melody, four times
    // as fast (short strokes → the duet leans on the piano, so it reads as a
    // music box being cranked rather than a violin sprint).
    if ((phase === 'drawing' || replaying) && soundOn) {
      startScratch();
      startMusic();
    } else {
      stopScratch();
      stopMusic();
    }
  }, [phase, replaying, soundOn, startScratch, stopScratch, startMusic, stopMusic]);

  useEffect(() => {
    if (phase === 'done' && soundOn) chime();
  }, [phase, soundOn, chime]);

  // …and a replay deserves the same closing chime, or the music just stops.
  const wasReplaying = useRef(false);
  useEffect(() => {
    if (wasReplaying.current && !replaying && soundOn) chime();
    wasReplaying.current = replaying;
  }, [replaying, soundOn, chime]);

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
  const fullSeconds = (settings.autoTime ?? true)
    ? autoDrawSeconds(pathData?.pathLength)
    : settings.seconds;
  const drawSeconds = replaying
    ? Math.max(REPLAY_MIN_S, fullSeconds / REPLAY_SPEED)
    : fullSeconds;
  const canvas = useMemo(
    () => (
      <Canvas
        key={`${runId}-${replayId}`}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => { glElRef.current = gl.domElement; }}
        camera={{ position: [0, 0, 11], fov: 40 }}
        style={{ position: 'absolute', inset: 0 }}
      >
        {pathData && (
          <Scene
            pathData={pathData}
            duration={drawSeconds}
            active={phase === 'drawing' || replaying}
            onComplete={handleDrawingDone}
            speedRef={speedRef}
            curveRef={curveRef}
            onNoteOn={handleNoteOn}
            onNoteOff={noteOff}
            inkColor={settings.inkColor}
            weight={settings.weight}
            ghostUrls={sourceUrls}
            ghostActive={phase === 'done' && !replaying}
          />
        )}
      </Canvas>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, replayId, replaying, drawSeconds, pathData, phase, handleDrawingDone,
     sourceUrls, settings.inkColor, settings.weight]
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
        dedication={dedication}
        onDedication={setDedication}
        signDate={settings.signDate ?? false}
        onSignDate={(v) => updateSettings({ signDate: v })}
        onCaptionIntent={loadHersheyFont}
        onReplay={replay}
        replaying={replaying}
        onRedraw={redraw}
        masterpiece={masterpiece}
        onMasterpiece={drawMasterpiece}
        onDuet={handleDuet}
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
