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
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import HandRig from './HandRig.jsx';
import InkTrail from './InkTrail.jsx';
import { usePathAnimation } from '../hooks/usePathAnimation.js';

const BOARD_SIZE = 8; // world units spanned by the drawing's longest side
const PEN_LIFT = 0.42;   // how high (world z) the pen rises on pen-up hops
const LIFT_RATE = 16;    // exp smoothing rate of the lift (higher = snappier)

export default function Scene({
  pathData, duration, active, onComplete, speedRef, curveRef,
  onNoteOn, onNoteOff, inkColor, weight,
}) {
  const anim = usePathAnimation(
    pathData.points, pathData.aspect, duration, BOARD_SIZE, pathData.breaks
  );

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
      onNoteOn?.(penTip.current.y / BOARD_SIZE + 0.5, curve, estDur);
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
          frame-rate independent. maxPoints comfortably covers the largest
          backend output (~4.6k vertices + 2 bridge centers per stroke). */}
      <InkTrail anim={anim} penTip={penTip} clockRef={clock}
                inkColor={inkColor} weight={weight}
                maxPoints={16000} active={active} />
      <HandRig penTip={penTip} boardSize={BOARD_SIZE} />
    </>
  );
}
