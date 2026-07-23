/**
 * useDrawSound — optional, fully synthesized audio for the draw (no asset files).
 *
 * Web Audio API only:
 *   • pen scratch      = looped pink-ish noise → bandpass → gain, where the gain
 *     tracks pen speed each frame (fast strokes hiss louder, like nib on paper).
 *   • completion chime = a soft C-major triad of sine oscillators with a gentle
 *     decay envelope.
 *
 * Off by default. The AudioContext is created/resumed inside the toggle's user
 * gesture (setSoundEnabled) to satisfy autoplay policies. enabledRef/speedRef
 * are refs so the per-frame gain loop always reads current values.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useDrawSound(enabledRef, speedRef) {
  const ctxRef = useRef(null);
  const nodesRef = useRef(null);
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
      const target = enabledRef.current ? Math.min(0.11, spd * 0.16) : 0;
      try { gain.gain.setTargetAtTime(target, ctx.currentTime, 0.06); } catch { /* noop */ }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, [ensureCtx, buildScratch, enabledRef, speedRef]);

  const stopScratch = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const n = nodesRef.current;
    const ctx = ctxRef.current;
    if (n && ctx) {
      try { n.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08); } catch { /* noop */ }
    }
  }, []);

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

  return { startScratch, stopScratch, chime, setSoundEnabled };
}
