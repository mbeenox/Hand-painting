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
 *       – pitch    = stroke's height on the canvas, QUANTIZED to a C-major
 *         pentatonic scale over two octaves (pentatonic notes cannot clash);
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
 *   • completion chime = a soft C-major triad (consonant with the drone).
 *
 * Off by default. The AudioContext is created/resumed inside the toggle's user
 * gesture (setSoundEnabled) to satisfy autoplay policies. enabledRef/speedRef/
 * curveRef are refs so per-frame loops always read current values.
 */
import { useCallback, useEffect, useRef } from 'react';

// C-major pentatonic, two octaves up from C4 — semitone offsets from BASE_FREQ.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const BASE_FREQ = 261.63; // C4
const MAX_VOICES = 5;     // safety cap on overlapping releases
const RETRIGGER_S = 0.09; // min seconds between note-ons (folds micro-strokes)
const MIN_NOTE_S = 0.13;  // shortest audible note even for instant lifts
const SPEED_NORM = 25;    // world-units/sec that counts as "fast bowing"

export function useDrawSound(enabledRef, speedRef, curveRef) {
  const ctxRef = useRef(null);
  const nodesRef = useRef(null);   // scratch nodes
  const musicRef = useRef(null);   // { drone, voices, current, lastOn }
  const rafRef = useRef(0);

  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current;
    const AC =
      typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { ctxRef.current = new AC(); } catch { return null; }
    return ctxRef.current;
  }, []);

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
    noise.connect(bandpass).connect(gain).connect(ctx.destination);
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
      const target = enabledRef.current ? Math.min(0.09, spd * 0.13) : 0;
      try { gain.gain.setTargetAtTime(target, ctx.currentTime, 0.06); } catch { /* noop */ }

      // Per-frame violin expression on the sounding note: bow pressure
      // (speed → brightness) and vibrato (curvature → depth & rate).
      const m = musicRef.current;
      const v = m && m.current;
      if (v && enabledRef.current) {
        const spd01 = Math.min(1, spd / SPEED_NORM);
        const curve = (curveRef && curveRef.current) || 0;
        try {
          v.filter.frequency.setTargetAtTime(900 + 2600 * spd01, ctx.currentTime, 0.08);
          v.vibGain.gain.setTargetAtTime(
            v.freq * 0.009 * (0.25 + 0.75 * curve), ctx.currentTime, 0.1
          );
          v.vib.frequency.setTargetAtTime(5.0 + 1.6 * curve, ctx.currentTime, 0.15);
        } catch { /* noop */ }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [ensureCtx, buildScratch, enabledRef, speedRef, curveRef]);

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
      musicRef.current = { drone: null, voices: [], current: null, lastOn: -1 };
    }
    return musicRef.current;
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
    // Tonic drone: C2 + G2 + C3, triangle, heavy lowpass, very quiet. A
    // consonant bed that makes the quantized stroke notes read as a piece.
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const oscs = [65.41, 98.0, 130.81].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(filter);
      o.start();
      return o;
    });
    filter.connect(gain).connect(ctx.destination);
    try {
      gain.gain.setTargetAtTime(0.042, ctx.currentTime, 0.9); // slow swell in
    } catch { /* noop */ }
    m.drone = { oscs, gain, filter };
  }, [ensureCtx, ensureMusic, enabledRef]);

  const stopMusic = useCallback(() => {
    const ctx = ctxRef.current;
    const m = musicRef.current;
    if (!ctx || !m) return;
    const now = ctx.currentTime;
    for (const v of m.voices) releaseVoice(ctx, v, now, 0.4);
    m.voices = [];
    m.current = null;
    if (m.drone) {
      const { oscs, gain } = m.drone;
      try {
        gain.gain.setTargetAtTime(0.0001, now, 0.4);
        oscs.forEach((o) => o.stop(now + 1.8));
      } catch { /* noop */ }
      m.drone = null;
    }
  }, [releaseVoice]);

  /** Pen landed: bow a new note. pitch01 = stroke height on the canvas (0..1
   *  bottom→top), curve01 = line curvature there (initial vibrato). */
  const noteOn = useCallback((pitch01, curve01 = 0) => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const m = ensureMusic();
    const now = ctx.currentTime;
    if (now - m.lastOn < RETRIGGER_S) return; // fold micro-strokes into the ringing note
    m.lastOn = now;

    if (m.current) releaseVoice(ctx, m.current, now, 0.35); // legato bow change

    const p = Math.min(1, Math.max(0, pitch01));
    const deg = Math.round(p * (SCALE.length - 1));
    const freq = BASE_FREQ * Math.pow(2, SCALE[deg] / 12);

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
    vib.frequency.value = 5.0 + 1.6 * curve01;
    const vibGain = ctx.createGain();
    vibGain.gain.value = freq * 0.009 * (0.25 + 0.75 * curve01);
    vib.connect(vibGain);
    vibGain.connect(osc1.frequency);
    vibGain.connect(osc2.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1600;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(ctx.destination);
    try {
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.setTargetAtTime(0.075, now, 0.06); // soft bow attack
      osc1.start(now);
      osc2.start(now);
      vib.start(now);
    } catch { /* noop */ }

    const v = { osc1, osc2, vib, vibGain, filter, gain, freq, onAt: now, released: false };
    m.voices.push(v);
    m.current = v;
    if (m.voices.length > MAX_VOICES) {
      const old = m.voices.shift();
      try { old.osc1.stop(); old.osc2.stop(); old.vib.stop(); } catch { /* noop */ }
    }
  }, [ensureCtx, ensureMusic, releaseVoice, enabledRef]);

  /** Pen lifted: let the bow come off the string. */
  const noteOff = useCallback(() => {
    const ctx = ctxRef.current;
    const m = musicRef.current;
    if (!ctx || !m || !m.current) return;
    releaseVoice(ctx, m.current, ctx.currentTime, 0.3);
    m.current = null;
  }, [releaseVoice]);

  // ------------------------------------------------------------------
  // Completion chime (unchanged; C-major triad — consonant with the drone)
  // ------------------------------------------------------------------
  const chime = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = now + i * 0.08;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.14, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0006, t0 + 1.3);
      o.connect(g).connect(ctx.destination);
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
    noteOn, noteOff, chime, setSoundEnabled,
  };
}
