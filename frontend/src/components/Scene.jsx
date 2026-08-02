/**
 * Scene — owns the drawing clock and wires the three moving parts together:
 *
 *   usePathAnimation  →  penTip (Vector3, mutated every frame)
 *                          ├─▶ HandRig   (IK solves the arm to reach it)
 *                          └─▶ InkTrail  (appends it to the ink line)
 *
 * The pen tip is shared by REFERENCE (one Vector3 both children read),
 * so there is exactly one source of truth and zero per-frame allocation.
 */
import React, { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import HandRig from './HandRig.jsx';
import InkTrail from './InkTrail.jsx';
import GhostReveal from './GhostReveal.jsx';
import { usePathAnimation } from '../hooks/usePathAnimation.js';
import { drawingBox } from '../lib/caption.js';

export const BOARD_SIZE = 8; // world units spanned by the drawing's longest side
const PEN_LIFT = 0.42;   // how high (world z) the pen rises on pen-up hops
const LIFT_RATE = 16;    // exp smoothing rate of the lift (higher = snappier)

// --- Fit-to-viewport (the narrow-phone crop fix) ------------------------
// The camera is fixed (z=11, fov 40): it always shows ~8.007 world units of
// HEIGHT, and 8.007 × the viewport aspect of WIDTH. BOARD_SIZE=8 fills the
// height edge-to-edge, which is fine for width on any landscape screen —
// but a WIDE composition on a PORTRAIT phone (a duet is ~2:1; even a single
// portrait is ~0.75 wide) used to overflow the ~3.7 visible units and get
// silently cropped at both sides. The fix: shrink the drawing's board just
// enough that its width also fits, with a small breathing margin.
const CAM_VISIBLE_H = 8.007; // 2·11·tan(40°/2) — keep in sync with the Canvas camera
const FIT_MARGIN = 0.96;     // don't kiss the screen edges

export function fitBoardSize(viewportAspect, drawingAspect) {
  const a = Number(drawingAspect) > 0 ? Number(drawingAspect) : 1;
  const w = a >= 1 ? 1 : a; // normalized drawing width (long side = 1)
  const va = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 1;
  const visW = CAM_VISIBLE_H * va * FIT_MARGIN;
  return Math.min(BOARD_SIZE, visW / w);
}

export default function Scene({
  pathData, duration, active, onComplete, speedRef, curveRef,
  onNoteOn, onNoteOff, inkColor, weight, ghostUrls = [], ghostActive = false,
}) {
  // The board size for THIS run, FROZEN at mount on purpose: the Canvas
  // remounts every run/replay (runId/replayId in its key), so each drawing
  // fits the screen it starts on — while a mid-draw window resize does NOT
  // re-map worldPoints, which would corrupt the world-space centers
  // InkTrail has already committed to its append-only buffer.
  const { size } = useThree();
  const boardRef = useRef(0);
  if (!boardRef.current) {
    boardRef.current = fitBoardSize(
      size.width / Math.max(1, size.height), pathData.aspect
    );
  }
  const board = boardRef.current;

  const anim = usePathAnimation(
    pathData.points, pathData.aspect, duration, board, pathData.breaks
  );

  // The gutter's world x, or null when this is an ordinary single drawing.
  const splitWorldX = useMemo(() => {
    const sx = pathData?.duet?.splitX;
    if (!Number.isFinite(sx)) return null;
    const aspect = Number(pathData.aspect) > 0 ? Number(pathData.aspect) : 1;
    const w = aspect >= 1 ? 1 : aspect;
    return (sx - w / 2) * board;
  }, [pathData, board]);

  // Where the portrait lives in world space — the same normalized→world map
  // usePathAnimation applies, so the ghost reveal lands exactly under its own
  // line art (and above the caption band, which it must not cover).
  const ghosts = useMemo(() => {
    const aspect = Number(pathData.aspect) > 0 ? Number(pathData.aspect) : 1;
    const w = aspect >= 1 ? 1 : aspect;
    const h = aspect >= 1 ? 1 / aspect : 1;
    const toWorld = (b) => {
      const x0 = (b.x0 - w / 2) * board;
      const x1 = (b.x1 - w / 2) * board;
      const y0 = (b.y0 - h / 2) * board;
      const y1 = (b.y1 - h / 2) * board;
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    };
    // A duet reveals each photo under ITS OWN portrait; anything else gets
    // one reveal over the whole drawing region.
    const boxes = Array.isArray(pathData.panels) && pathData.panels.length
      ? pathData.panels
      : [drawingBox(pathData)];
    return boxes
      .map((b, i) => ({ url: ghostUrls[i] ?? null, rect: toWorld(b) }))
      .filter((g) => g.url);
  }, [pathData, ghostUrls, board]);

  // The single shared pen-tip position (world space, z=0 drawing plane).
  const penTip = useRef(new THREE.Vector3());
  const prevTip = useRef(new THREE.Vector3()); // last frame's tip → pen speed
  const clock = useRef({ elapsed: 0, done: false });
  const liftRef = useRef(0); // smoothed pen-lift height (trace-mode hops)
  const prevDown = useRef(false); // pen-down state last frame → stroke events

  // Initialize the pen at the path start so the arm doesn't lurch on frame 1.
  useMemo(() => {
    if (anim) {
      anim.getPoint(0, penTip.current);
      prevTip.current.copy(penTip.current);
    }
  }, [anim]);

  // Where the hand retreats to after signing off (off-canvas bottom-right).
  const restPoint = useMemo(
    () => new THREE.Vector3(BOARD_SIZE * 0.62, -BOARD_SIZE * 0.55, 0.6),
    []
  );

  useFrame((_, delta) => {
    if (!anim) return;
    if (clock.current.done) {
      // Drawing finished: exponentially ease the hand off the artwork so
      // the viewer gets an unobstructed look at the finished line portrait.
      if (prevDown.current) {
        prevDown.current = false;
        onNoteOff?.(); // let the final bowed note release
      }
      penTip.current.lerp(restPoint, 1 - Math.exp(-2.2 * delta));
      if (speedRef) speedRef.current = 0;
      return;
    }
    if (active) clock.current.elapsed += delta;
    // getPoint returns the current vertex index while inking, -1 in flight.
    const idx = anim.getPoint(clock.current.elapsed, penTip.current);
    const down = idx >= 0;

    // Publish local line curvature (drives the violin vibrato) and emit
    // stroke events: pen lands → note-on pitched by the stroke's height on
    // the canvas; pen lifts → note release.
    const curve = down ? anim.curveNorm[idx] : 0;
    if (curveRef) curveRef.current = curve;
    if (active && down && !prevDown.current) {
      // Estimated seconds this stroke will take (its end time on the warped
      // clock minus now) → duet mode picks violin (long) vs piano (short).
      const estDur =
        anim.strokeEnd[idx] - anim.warp(clock.current.elapsed);
      // Two-photo duet (4.3): which PORTRAIT the pen is on picks the voice,
      // so the two sitters answer each other — one bowed, one struck —
      // instead of both being sorted by stroke length. Derived from the pen's
      // position rather than carried per-stroke, so it survives truncation
      // and the caption band without anything to keep in sync.
      const panelVoice = splitWorldX === null
        ? undefined
        : (penTip.current.x < splitWorldX ? 'violin' : 'piano');
      // Pitch by the stroke's height on the (possibly fit-scaled) board, so
      // a phone drawing plays the same melody as the desktop one.
      onNoteOn?.(penTip.current.y / board + 0.5, curve, estDur, panelVoice);
    } else if (active && !down && prevDown.current) {
      onNoteOff?.();
    }
    prevDown.current = down;

    // Lift the pen off the paper during pen-up hops (the IK arm follows the
    // tip, so the whole hand rises and repositions like a real artist's).
    // The ink itself is laid exactly along the path by InkTrail, so this is
    // purely the hand's visual behavior.
    const targetLift = down ? 0 : PEN_LIFT;
    liftRef.current += (targetLift - liftRef.current) * (1 - Math.exp(-LIFT_RATE * delta));
    penTip.current.z = liftRef.current;

    // Publish pen speed (world units/sec) for the optional pen-scratch audio.
    // Zero while the pen is up so travel hops stay silent.
    if (speedRef) {
      speedRef.current = active && down
        ? penTip.current.distanceTo(prevTip.current) / Math.max(delta, 1e-4)
        : 0;
    }
    prevTip.current.copy(penTip.current);
    if (active && clock.current.elapsed >= duration) {
      clock.current.done = true;
      onComplete?.();
    }
  });

  return (
    <>
      {/* Soft studio-ish lighting; the paper is the DOM behind the canvas */}
      <ambientLight intensity={0.9} />
      <directionalLight position={[4, 6, 8]} intensity={1.2} />
      <directionalLight position={[-6, -2, 4]} intensity={0.3} />

      {/* Exact-append renderer: commits the animation's actual path vertices
          (plus a floating live-tip center), so the ink is complete and
          frame-rate independent. maxPoints must clear the worst case, which
          is now a two-photo DUET: two traced panels at span=2 plus a
          full-length written caption, plus 2 bridge centers per stroke and
          the floating tip. A duet drops each panel one detail notch (see
          DUET_DETAIL in App.jsx) precisely so this stays bounded — at the
          worst reachable combination that is ≈20.2k centers, where two
          `dense` panels would need ≈25.8k. The notch-down is a correctness
          rule, not a taste call. 26 000 keeps a real margin. */}
      {/* Behind the ink, inside the same canvas every export composites.
          A duet gets one reveal per panel, each under its own portrait. */}
      {ghosts.map((g, i) => (
        <GhostReveal key={i} url={g.url} rect={g.rect} active={ghostActive} />
      ))}
      <InkTrail anim={anim} penTip={penTip} clockRef={clock}
                inkColor={inkColor} weight={weight}
                maxPoints={26000} active={active} />
      {/* The ARM stays sized to the constant BOARD_SIZE on purpose: its
          shoulder sits just off the bottom screen edge (-0.68·8 ≈ -5.4 vs
          the ±4.0 the camera shows), and scaling it with a fit-shrunk board
          would drag the shoulder ON screen. A full-size hand drawing a
          smaller sheet also simply reads right — its reach covers the
          shrunken board because that board is a subset of the ±4 square. */}
      <HandRig penTip={penTip} boardSize={BOARD_SIZE} />
    </>
  );
}
