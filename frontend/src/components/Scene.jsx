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

export default function Scene({ pathData, duration, active, onComplete }) {
  const anim = usePathAnimation(pathData.points, pathData.aspect, duration, BOARD_SIZE);

  // The single shared pen-tip position (world space, z=0 drawing plane).
  const penTip = useRef(new THREE.Vector3());
  const clock = useRef({ elapsed: 0, done: false });

  // Initialize the pen at the path start so the arm doesn't lurch on frame 1.
  useMemo(() => {
    if (anim) anim.getPoint(0, penTip.current);
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
      penTip.current.lerp(restPoint, 1 - Math.exp(-2.2 * delta));
      return;
    }
    if (active) clock.current.elapsed += delta;
    anim.getPoint(clock.current.elapsed, penTip.current);
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

      {/* maxPoints sized so even a 30s draw on a 240Hz display never
          truncates the line (≈7.2k samples worst case). */}
      <InkTrail penTip={penTip} maxPoints={16000} active={active} />
      <HandRig penTip={penTip} boardSize={BOARD_SIZE} />
    </>
  );
}
