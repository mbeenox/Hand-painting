/**
 * useDrawSound — optional, fully synthesized audio for the draw (no asset files).
 *
 * Web Audio API only, three layers:
 *
 *   • pen scratch   = looped pink-ish noise → bandpass → gain, where the gain
 *     tracks pen speed each frame (fast strokes hiss louder, like nib on paper).
 *
 *   • STROKE VIOLIN = the drawing plays itself (Feature #6). Every stroke is a
 *     bowed note: pen lands → note-on, pen lifts → release. The mapping is what
 *     keeps random strokes MUSICAL:
 *       – pitch    = stroke's height on the canvas, QUANTIZED to the current
 *         MOOD's scale over two octaves (scales are chosen so random degrees
 *         cannot clash with the mood's drone — see MOODS below);
 *       – duration = how long the stroke takes to draw (long contour → sustained
 *         tone, tiny detail flick → staccato — sub-90ms strokes fold into the
 *         ringing note instead of spamming new ones);
 *       – vibrato  = line CURVATURE at the pen (curved strokes sing, straight
 *         lines stay pure) — depth/rate driven per frame from curveRef;
 *       – bow pressure = pen speed → lowpass brightness + a touch of gain;
 *       – legato: a new note sends the previous voice into a gentle release, so
 *         phrases overlap like bow changes rather than chopping.
 *     A quiet tonic drone (C2+G2+C3, heavily lowpassed) sits underneath so the
 *     stroke melody always lands on a consonant bed. Voice = 2 detuned saws →
 *     lowpass → envelope (soft ~60ms bow attack), vibrato LFO on both oscs.
 *     Since stroke ORDER is randomized per run, every drawing of the same photo
 *     performs a different melody.
 *
 *   • PIANO (Feature #7): a second voice — decaying partial-stack notes with a
 *     hammer attack, self-terminating (no note-off). In the default DUET mode
 *     each stroke picks its own instrument by estimated draw time: long lines
 *     are bowed by the violin, short detail flicks are struck on the piano.
 *     The Style panel's Instrument setting can force violin-only / piano-only.
 *
 *   • completion chime = a soft C-major triad (consonant with the drone).
 *
 * Off by default. The AudioContext is created/resumed inside the toggle's user
 * gesture (setSoundEnabled) to satisfy autoplay policies. enabledRef/speedRef/
 * curveRef are refs so per-frame loops always read current values.
 */
import { useCallback, useEffect, useRef } from 'react';

/**
 * MOODS (Feature 3.1) — each mood is a complete musical identity: melody
 * scale (semitone offsets from `base`, 11 degrees ≈ two octaves so the
 * height→pitch mapping keeps its resolution), drone chord, drone colour,
 * bow-brightness range (filterBase + filterSpan·speed), vibrato character,
 * duet split bias, and a completion chime built from the mood's own scale.
 *
 * THE INVARIANT (non-negotiable): every scale degree must sit consonantly
 * over its mood's drone — stroke pitches are effectively random, so no
 * random combination may clash. Verified programmatically by
 * `verify_moods.py` (Plomp–Levelt roughness of every scale tone against the
 * drone chord, thresholds calibrated against known-dissonant controls),
 * which PARSES this table from the source — keep the field layout
 * machine-readable: one `base:`, one `scale: [...]`, one `drone: [...]`
 * per mood block.
 */
const MOODS = {
  dawn: { // the original: C major pentatonic, bright
    base: 261.63, // C4
    scale: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24], // C D E G A ×2 octaves
    drone: [65.41, 98.00, 130.81], // C2 G2 C3
    droneLevel: 0.042, droneLP: 320,
    filterBase: 900, filterSpan: 2600,
    vibDepth: 1.0, vibRate: 1.0,
    duetSplit: 0.5,
    chime: [523.25, 659.25, 783.99], // C5 E5 G5
  },
  dusk: { // A minor pentatonic, darker lowpass, deeper vibrato — moody portraits
    base: 220.00, // A3
    scale: [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24], // A C D E G ×2
    drone: [55.00, 82.41, 110.00], // A1 E2 A2
    droneLevel: 0.048, droneLP: 260,
    filterBase: 700, filterSpan: 1400, // cap ~2100 (vs Dawn's ~3500)
    vibDepth: 1.45, vibRate: 0.9,
    duetSplit: 0.5,
    chime: [440.00, 523.25, 659.25], // A4 C5 E5
  },
  sakura: { // D hirajoshi — spare, koto-like; piano-biased duet
    base: 293.66, // D4
    scale: [0, 1, 5, 7, 10, 12, 13, 17, 19, 22, 24], // D E♭ G A B♭ ×2
    drone: [73.42, 110.00], // D2 A2 (open fifth — leaves the ♭2/♭6 as colour)
    droneLevel: 0.040, droneLP: 300,
    filterBase: 850, filterSpan: 2200,
    vibDepth: 0.8, vibRate: 1.1,
    duetSplit: 0.8, // most strokes struck
    chime: [587.33, 880.00, 1174.66], // D5 A5 D6 — open fifths, no ♭2
  },
  hymn: { // F Lydian pentatonic subset — solemn, violin-biased, slow vibrato
    base: 174.61, // F3
    scale: [0, 2, 4, 7, 11, 12, 14, 16, 19, 23, 24], // F G A C E ×2
    drone: [43.65, 65.41, 87.31], // F1 C2 F2
    droneLevel: 0.050, droneLP: 240,
    filterBase: 800, filterSpan: 1800,
    vibDepth: 1.1, vibRate: 0.7,
    duetSplit: 0.35, // most strokes bowed
    chime: [349.23, 440.00, 523.25], // F4 A4 C5
  },
};
const DEFAULT_MOOD = 'dawn';

const MAX_VOICES = 5;     // safety cap on overlapping violin releases
const RETRIGGER_S = 0.09; // min seconds between note-ons (folds micro-strokes)
const MIN_NOTE_S = 0.13;  // shortest audible note even for instant lifts
const SPEED_NORM = 25;    // world-units/sec that counts as "fast bowing"
const MAX_PIANOS = 24;    // safety cap on simultaneously ringing piano notes

export function useDrawSound(enabledRef, speedRef, curveRef, settingsRef) {
  // Mood applies per run (like detail): startMusic pins it on the music
  // state; noteOn/chime fall back to the live setting when no run is active.
  const currentMood = () =>
    MOODS[settingsRef?.current?.mood] || MOODS[DEFAULT_MOOD];
  const ctxRef = useRef(null);
  const masterRef = useRef(null);    // one bus everything plays through
  const mediaDestRef = useRef(null); // tap of that bus for video recording
  const nodesRef = useRef(null);     // scratch nodes
  const musicRef = useRef(null);     // { drone, voices, current, lastOn }
  const rafRef = useRef(0);

  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current;
    const AC =
      typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      ctxRef.current = new AC();
      // Master bus: every source connects HERE (not to ctx.destination), so
      // the same mix can be tapped by getAudioStream() for the recording.
      masterRef.current = ctxRef.current.createGain();
      masterRef.current.gain.value = 1;
      masterRef.current.connect(ctxRef.current.destination);
    } catch { return null; }
    return ctxRef.current;
  }, []);

  /**
   * Audio track for the video recording (useDrawCapture). Safe to call at
   * record start even before any sound gesture: a context created here
   * starts 'suspended' and yields a SILENT track; the moment the user taps
   * 🔊 (a gesture) the context resumes and the same track carries the mix.
   */
  const getAudioStream = useCallback(() => {
    const ctx = ensureCtx();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
    if (!mediaDestRef.current) {
      try {
        mediaDestRef.current = ctx.createMediaStreamDestination();
        masterRef.current.connect(mediaDestRef.current);
      } catch { return null; }
    }
    return mediaDestRef.current.stream;
  }, [ensureCtx]);

  // ------------------------------------------------------------------
  // Pen scratch (unchanged behavior)
  // ------------------------------------------------------------------
  const buildScratch = useCallback((ctx) => {
    if (nodesRef.current) return nodesRef.current;
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // cheap low-pass → "pinker" noise
      data[i] = white * 0.4 + last * 0.6;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1800;
    bandpass.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    noise.connect(bandpass).connect(gain).connect(masterRef.current);
    try { noise.start(); } catch { /* already started */ }
    nodesRef.current = { noise, bandpass, gain };
    return nodesRef.current;
  }, []);

  const startScratch = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const { gain } = buildScratch(ctx);
    cancelAnimationFrame(rafRef.current);
    const tick = () => {
      const spd = speedRef.current || 0;
      // The pen-scratch layer has its own Style-panel toggle (settings.scratch,
      // OFF by default since the v2 settings migration), read live each frame
      // so flipping it mid-draw responds instantly.
      const scratchOn = settingsRef?.current?.scratch === true;
      const target =
        enabledRef.current && scratchOn ? Math.min(0.09, spd * 0.13) : 0;
      try { gain.gain.setTargetAtTime(target, ctx.currentTime, 0.06); } catch { /* noop */ }

      // Per-frame violin expression on the sounding note: bow pressure
      // (speed → brightness) and vibrato (curvature → depth & rate).
      const m = musicRef.current;
      const v = m && m.current;
      if (v && enabledRef.current) {
        const spd01 = Math.min(1, spd / SPEED_NORM);
        const curve = (curveRef && curveRef.current) || 0;
        const md = v.mood || MOODS[DEFAULT_MOOD];
        try {
          v.filter.frequency.setTargetAtTime(
            md.filterBase + md.filterSpan * spd01, ctx.currentTime, 0.08
          );
          v.vibGain.gain.setTargetAtTime(
            v.freq * 0.009 * md.vibDepth * (0.25 + 0.75 * curve), ctx.currentTime, 0.1
          );
          v.vib.frequency.setTargetAtTime(
            (5.0 + 1.6 * curve) * md.vibRate, ctx.currentTime, 0.15
          );
        } catch { /* noop */ }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [ensureCtx, buildScratch, enabledRef, speedRef, curveRef, settingsRef]);

  const stopScratch = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const n = nodesRef.current;
    const ctx = ctxRef.current;
    if (n && ctx) {
      try { n.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08); } catch { /* noop */ }
    }
  }, []);

  // ------------------------------------------------------------------
  // Stroke violin
  // ------------------------------------------------------------------
  const ensureMusic = useCallback(() => {
    if (!musicRef.current) {
      musicRef.current = {
        drone: null, voices: [], pianos: [], current: null, lastOn: -1,
      };
    }
    return musicRef.current;
  }, []);

  /**
   * Piano note: a small stack of decaying partials (fundamental + slightly
   * stretched 2nd/3rd, like real string inharmonicity) with a near-instant
   * hammer attack. Self-terminating — oscillators stop themselves after the
   * decay, so pianos need no note-off; lower notes ring longer, like a real
   * instrument.
   */
  const pianoNote = useCallback((ctx, m, freq) => {
    const now = ctx.currentTime;
    const decay = Math.min(3.0, Math.max(1.1, 2.6 * Math.pow(220 / freq, 0.4)));
    const peak = Math.min(0.16, 0.09 + 18 / freq); // lower notes a touch fuller
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.004); // hammer strike
    gain.gain.exponentialRampToValueAtTime(0.0004, now + decay);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(7500, freq * 7), now);
    lp.frequency.exponentialRampToValueAtTime(Math.max(500, freq * 1.6), now + decay);
    lp.connect(gain).connect(masterRef.current);
    const partials = [[1.0, 1.0, 'triangle'], [2.003, 0.32, 'sine'], [3.007, 0.10, 'sine']];
    const oscs = partials.map(([mult, amp, type]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(lp);
      o.start(now);
      o.stop(now + decay + 0.25);
      return o;
    });
    const v = { gain, oscs };
    m.pianos.push(v);
    oscs[0].onended = () => {
      const i = m.pianos.indexOf(v);
      if (i >= 0) m.pianos.splice(i, 1);
    };
    if (m.pianos.length > MAX_PIANOS) {
      const old = m.pianos.shift();
      try { old.gain.gain.setTargetAtTime(0.0001, now, 0.05); } catch { /* noop */ }
    }
  }, []);

  const releaseVoice = useCallback((ctx, v, when, tail) => {
    if (v.released) return;
    v.released = true;
    const holdUntil = Math.max(when, v.onAt + MIN_NOTE_S);
    try {
      v.gain.gain.cancelScheduledValues(holdUntil);
      v.gain.gain.setTargetAtTime(0.0001, holdUntil, tail / 3);
      const end = holdUntil + tail + 0.25;
      v.osc1.stop(end);
      v.osc2.stop(end);
      v.vib.stop(end);
    } catch { /* noop */ }
  }, []);

  const startMusic = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const m = ensureMusic();
    if (m.drone) return;
    // Tonic drone from the mood's table (e.g. Dawn: C2+G2+C3), triangle,
    // heavy lowpass, very quiet. A consonant bed that makes the quantized
    // stroke notes read as a piece. The mood is PINNED here for the run.
    const mood = currentMood();
    m.mood = mood;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mood.droneLP;
    const oscs = mood.drone.map((f) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(filter);
      o.start();
      return o;
    });
    filter.connect(gain).connect(masterRef.current);
    try {
      gain.gain.setTargetAtTime(mood.droneLevel, ctx.currentTime, 0.9); // slow swell in
    } catch { /* noop */ }
    m.drone = { oscs, gain, filter };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureCtx, ensureMusic, enabledRef]);

  const stopMusic = useCallback(() => {
    const ctx = ctxRef.current;
    const m = musicRef.current;
    if (!ctx || !m) return;
    const now = ctx.currentTime;
    for (const v of m.voices) releaseVoice(ctx, v, now, 0.4);
    m.voices = [];
    m.current = null;
    for (const pv of m.pianos) {
      try { pv.gain.gain.setTargetAtTime(0.0001, now, 0.15); } catch { /* noop */ }
    }
    m.pianos = [];
    if (m.drone) {
      const { oscs, gain } = m.drone;
      try {
        gain.gain.setTargetAtTime(0.0001, now, 0.4);
        oscs.forEach((o) => o.stop(now + 1.8));
      } catch { /* noop */ }
      m.drone = null;
    }
  }, [releaseVoice]);

  /** Pen landed: play a new note. pitch01 = stroke height on the canvas
   *  (0..1 bottom→top), curve01 = line curvature there (initial vibrato),
   *  estDur = estimated seconds this stroke will take to draw, instrument =
   *  'duet' | 'violin' | 'piano'. In duet mode the stroke chooses its own
   *  instrument: long lines are bowed, short flicks are struck. */
  const noteOn = useCallback((pitch01, curve01 = 0, estDur = Infinity, instrument = 'duet') => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const m = ensureMusic();
    const now = ctx.currentTime;
    if (now - m.lastOn < RETRIGGER_S) return; // fold micro-strokes into the ringing note
    m.lastOn = now;

    const mood = m.mood || currentMood();
    const p = Math.min(1, Math.max(0, pitch01));
    const deg = Math.round(p * (mood.scale.length - 1));
    const freq = mood.base * Math.pow(2, mood.scale[deg] / 12);

    const wantPiano =
      instrument === 'piano' ||
      (instrument !== 'violin' && estDur < mood.duetSplit);
    if (wantPiano) {
      pianoNote(ctx, m, freq);
      return; // self-terminating: no note-off, no expression tracking
    }

    if (m.current) releaseVoice(ctx, m.current, now, 0.35); // legato bow change

    // Voice: two detuned saws → lowpass → envelope; vibrato LFO on both.
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq;
    osc2.detune.value = 7; // gentle chorus → "section" warmth
    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = (5.0 + 1.6 * curve01) * mood.vibRate;
    const vibGain = ctx.createGain();
    vibGain.gain.value = freq * 0.009 * mood.vibDepth * (0.25 + 0.75 * curve01);
    vib.connect(vibGain);
    vibGain.connect(osc1.frequency);
    vibGain.connect(osc2.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = mood.filterBase + 700; // rest-bow brightness
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(masterRef.current);
    try {
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.setTargetAtTime(0.075, now, 0.06); // soft bow attack
      osc1.start(now);
      osc2.start(now);
      vib.start(now);
    } catch { /* noop */ }

    const v = {
      osc1, osc2, vib, vibGain, filter, gain, freq, mood,
      onAt: now, released: false,
    };
    m.voices.push(v);
    m.current = v;
    if (m.voices.length > MAX_VOICES) {
      const old = m.voices.shift();
      try { old.osc1.stop(); old.osc2.stop(); old.vib.stop(); } catch { /* noop */ }
    }
  }, [ensureCtx, ensureMusic, releaseVoice, pianoNote, enabledRef]);

  /** Pen lifted: let the bow come off the string. */
  const noteOff = useCallback(() => {
    const ctx = ctxRef.current;
    const m = musicRef.current;
    if (!ctx || !m || !m.current) return;
    releaseVoice(ctx, m.current, ctx.currentTime, 0.3);
    m.current = null;
  }, [releaseVoice]);

  // ------------------------------------------------------------------
  // Completion chime — the mood's own triad, so it lands consonant with
  // whatever drone just faded (arpeggiated, soft sines).
  // ------------------------------------------------------------------
  const chime = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const mood = (musicRef.current && musicRef.current.mood) || currentMood();
    mood.chime.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = now + i * 0.08;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.14, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0006, t0 + 1.3);
      o.connect(g).connect(masterRef.current);
      o.start(t0);
      o.stop(t0 + 1.4);
    });
  }, [ensureCtx, enabledRef]);

  // Called inside the toggle's user gesture so the context is allowed to run.
  const setSoundEnabled = useCallback((on) => {
    if (!on) return;
    const ctx = ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }, [ensureCtx]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      try { nodesRef.current?.noise.stop(); } catch { /* noop */ }
      try { ctxRef.current?.close(); } catch { /* noop */ }
    },
    []
  );

  return {
    startScratch, stopScratch, startMusic, stopMusic,
    noteOn, noteOff, chime, setSoundEnabled, getAudioStream,
  };
}
