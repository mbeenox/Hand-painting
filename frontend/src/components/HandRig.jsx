/**
 * HandRig — a wooden artist's-mannequin arm driven by an ANALYTIC TWO-BONE
 * IK solver, holding a pen whose tip tracks `penTip` exactly.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  TWO-BONE IK: THE MATH                                           │
 * │                                                                  │
 * │  Chain:  Shoulder S ──(L1 upper arm)── Elbow E ──(L2 forearm)──  │
 * │          Wrist W. The pen tip T is what touches the paper, so    │
 * │          each frame we first derive the grip                     │
 * │              G = T + penAxis · PEN_LENGTH                        │
 * │          (the hand floats "up the pen" from the tip). The hand   │
 * │          model's wrist sits at a FIXED offset from G (the hand's │
 * │          orientation never changes), so the IK target is         │
 * │              W = G + R·wristLocal        (R = UP→PEN_AXIS roll)  │
 * │          and the 2-bone chain S→E→W is solved analytically:      │
 * │                                                                  │
 * │  Let d = |W − S|, clamped to (|L1−L2|, L1+L2) so a solution      │
 * │  always exists (fully-stretched or fully-folded arms are         │
 * │  singular). By the LAW OF COSINES on triangle (S, E, W):         │
 * │                                                                  │
 * │      cos α = (L1² + d² − L2²) / (2·L1·d)     α = shoulder angle  │
 * │                between the S→W line and the upper-arm bone.      │
 * │                                                                  │
 * │  That gives the elbow's distance geometry, but the elbow can     │
 * │  still swivel anywhere on a CIRCLE around the S→W axis — the     │
 * │  classic underdetermined DOF. We pin it with a POLE VECTOR       │
 * │  (an "elbow hint"): project the hint perpendicular to the S→W    │
 * │  direction and place the elbow on that side:                     │
 * │                                                                  │
 * │      dir  = (W − S) / d                                          │
 * │      perp = normalize(pole − (pole·dir)·dir)   (Gram–Schmidt)    │
 * │      E    = S + dir·(L1·cos α) + perp·(L1·sin α)                 │
 * │                                                                  │
 * │  The two limb segments are then oriented along S→E and E→W with  │
 * │  quaternions. No iteration, no libraries, exact every frame.     │
 * │  (For a >2-bone chain you'd switch to FABRIK/CCD or three-ik.)   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * THE MODEL (feature 4.2): `lib/mannequinArm.js` — an original wooden
 * drawing-mannequin arm authored in code, not a downloaded .glb. See the
 * header there for why (no license-verifiable CC0 rigged arm exists on
 * reachable sources; authoring gives exact rest-pose alignment, zero
 * license risk, zero network fetch, no async fallback path). Because the
 * geometry is built locally and synchronously there is nothing to lazy-load
 * and nothing that can 404 — the "procedural fallback" the plan asked for
 * IS the primary path. The old GLTF slot remains viable: a real .glb could
 * still be dropped in here and driven from the same S/E/W solve.
 *
 * DON'T-REGRESS (same as always):
 *  · PEN_AXIS z stays ~0.55 or the pen foreshortens into invisibility.
 *  · POLE_HINT must stay far from (anti)parallel with shoulder→wrist or
 *    the Gram–Schmidt projection degenerates and the elbow flips.
 *  · Arm length = maxReach × 1.06 (near-extension keeps bends gentle).
 *  · The hand's roll about the pen shaft (HAND_ROLL) is TIP-SAFE by
 *    construction; any other rotation of the hand group is not.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { buildMannequinArm, HAND_ROLL } from '../lib/mannequinArm.js';

const PEN_LENGTH = 1.1;
// Pen leans back toward the artist and off the page (unit vector).
// Keep the z component moderate: a pen pointing straight at the camera
// foreshortens into invisibility.
const PEN_AXIS = new THREE.Vector3(0.45, 0.62, 0.55).normalize();
// Elbow hint: out to the right and toward the camera. IMPORTANT: this must
// stay far from (anti)parallel with the typical shoulder→wrist direction
// (which points up-left from our bottom-right shoulder), otherwise the
// Gram–Schmidt projection below degenerates and the elbow flips randomly.
const POLE_HINT = new THREE.Vector3(0.9, 0.05, 0.3).normalize();

const UP = new THREE.Vector3(0, 1, 0);

export default function HandRig({ penTip, boardSize }) {
  // Shoulder anchored low-right, floating in front of the paper — like a
  // right-handed artist leaning over a desk seen from above the page.
  const shoulder = useMemo(
    () => new THREE.Vector3(boardSize * 0.5, -boardSize * 0.68, 1.4),
    [boardSize]
  );

  // Bone lengths: size the arm so L1+L2 JUST covers the farthest board
  // corner (max reach × 1.06). Keeping the arm near-extension means small
  // IK bend angles → the forearm sweeps in naturally from the side instead
  // of the elbow jack-knifing across the screen. Split 52/48 like a human.
  const { L1, L2 } = useMemo(() => {
    const half = boardSize / 2;
    let maxReach = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const corner = new THREE.Vector3(sx * half, sy * half, 0);
      maxReach = Math.max(maxReach, corner.distanceTo(shoulder));
    }
    const total = maxReach * 1.06;
    return { L1: total * 0.52, L2: total * 0.48 };
  }, [boardSize, shoulder]);

  // The mannequin (built once; ~45 small meshes, all local geometry).
  const arm = useMemo(() => buildMannequinArm({ penLength: PEN_LENGTH }), []);

  // The hand's orientation is CONSTANT (UP rolled onto PEN_AXIS, then a
  // fixed tip-safe roll about the shaft), so the grip→wrist offset is a
  // constant world vector — compute it once.
  const { handQuat, wristOffset } = useMemo(() => {
    const q = new THREE.Quaternion()
      .setFromUnitVectors(UP, PEN_AXIS)
      .multiply(new THREE.Quaternion().setFromAxisAngle(UP, HAND_ROLL));
    return { handQuat: q, wristOffset: arm.wrist.clone().applyQuaternion(q) };
  }, [arm]);

  // Manually-built geometry isn't managed by R3F — dispose on unmount
  // (the Canvas remounts on every replay, so leaking here would compound).
  useEffect(() => {
    arm.shoulderBall.position.copy(shoulder);
    arm.hand.quaternion.copy(handQuat);
    return () => {
      arm.root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
    };
  }, [arm, shoulder, handQuat]);

  // Scratch vectors reused every frame (never allocate in useFrame).
  const scratch = useMemo(() => ({
    G: new THREE.Vector3(),
    W: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    perp: new THREE.Vector3(),
    E: new THREE.Vector3(),
    seg: new THREE.Vector3(),
    n: new THREE.Vector3(),
    q: new THREE.Quaternion(),
  }), []);

  useFrame(() => {
    const T = penTip.current;
    const { G, W, dir, perp, E, seg, n, q } = scratch;

    // --- derive grip and wrist targets from the pen tip ---------------
    G.copy(T).addScaledVector(PEN_AXIS, PEN_LENGTH);
    W.copy(G).add(wristOffset);

    // --- two-bone IK solve (see math box above) ----------------------
    dir.subVectors(W, shoulder);
    let d = dir.length();
    d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
    dir.normalize();

    // Law of cosines → shoulder interior angle α.
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const alpha = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));

    // Pole-vector projection (Gram–Schmidt) picks the elbow's swivel side.
    perp.copy(POLE_HINT).addScaledVector(dir, -POLE_HINT.dot(dir)).normalize();

    // Elbow position from the two polar components along dir and perp.
    E.copy(shoulder)
      .addScaledVector(dir, L1 * Math.cos(alpha))
      .addScaledVector(perp, L1 * Math.sin(alpha));

    // --- pose the mannequin -------------------------------------------
    // Upper arm: position at S, rotate +Y onto (E−S), scale Y to length.
    seg.subVectors(E, shoulder);
    arm.upper.position.copy(shoulder);
    arm.upper.quaternion.copy(q.setFromUnitVectors(UP, n.copy(seg).normalize()));
    arm.upper.scale.set(1, seg.length(), 1);

    // Forearm: from E to the WRIST (not the grip — the hand model owns
    // everything past the wrist ball).
    seg.subVectors(W, E);
    arm.fore.position.copy(E);
    arm.fore.quaternion.copy(q.setFromUnitVectors(UP, n.copy(seg).normalize()));
    arm.fore.scale.set(1, seg.length(), 1);

    arm.elbowBall.position.copy(E);

    // Hand + pen: rigid assembly at the grip; orientation is constant, so
    // the pen tip (hand-local (0, −PEN_LENGTH, 0)) lands EXACTLY on T.
    arm.hand.position.copy(G);
  });

  return <primitive object={arm.root} />;
}
