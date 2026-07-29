/**
 * HandRig — a stylized procedural arm driven by an ANALYTIC TWO-BONE IK
 * solver, holding a pen whose tip tracks `penTip` exactly.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  TWO-BONE IK: THE MATH                                           │
 * │                                                                  │
 * │  Chain:  Shoulder S ──(L1 upper arm)── Elbow E ──(L2 forearm)──  │
 * │          Grip G, where the pen is held. The pen tip T is what    │
 * │          touches the paper, so each frame we first derive        │
 * │              G = T + penAxis · PEN_LENGTH                        │
 * │          (the hand floats "up the pen" from the tip), then       │
 * │          solve the 2-bone chain S→E→G analytically:              │
 * │                                                                  │
 * │  Let d = |G − S|, clamped to (|L1−L2|, L1+L2) so a solution      │
 * │  always exists (fully-stretched or fully-folded arms are         │
 * │  singular). By the LAW OF COSINES on triangle (S, E, G):         │
 * │                                                                  │
 * │      cos α = (L1² + d² − L2²) / (2·L1·d)     α = shoulder angle  │
 * │                between the S→G line and the upper-arm bone.      │
 * │                                                                  │
 * │  That gives the elbow's distance geometry, but the elbow can     │
 * │  still swivel anywhere on a CIRCLE around the S→G axis — the     │
 * │  classic underdetermined DOF. We pin it with a POLE VECTOR       │
 * │  (an "elbow hint"): project the hint perpendicular to the S→G    │
 * │  direction and place the elbow on that side:                     │
 * │                                                                  │
 * │      dir  = (G − S) / d                                          │
 * │      perp = normalize(pole − (pole·dir)·dir)   (Gram–Schmidt)    │
 * │      E    = S + dir·(L1·cos α) + perp·(L1·sin α)                 │
 * │                                                                  │
 * │  Two segment meshes are then oriented along S→E and E→G with     │
 * │  quaternions. No iteration, no libraries, exact every frame.     │
 * │  (For a >2-bone chain you'd switch to FABRIK/CCD or three-ik.)   │
 * └──────────────────────────────────────────────────────────────────┘
 */
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------
// Swap-in slot for a real rigged model:
// set USE_GLTF = true and drop your file at frontend/public/models/arm.glb.
// The loader clones the scene and expects it modeled with the pen tip at
// the origin pointing down −penAxis; the same IK solve below can instead
// drive its skeleton bones if it has them (see comment in useFrame).
// ---------------------------------------------------------------------
const USE_GLTF = false;
const GLTF_URL = '/models/arm.glb';

const PEN_LENGTH = 1.1;
// Pen leans back toward the artist and off the page (unit vector).
// Keep the z component moderate: a pen pointing straight at the camera
// foreshortens into invisibility.
const PEN_AXIS = new THREE.Vector3(0.45, 0.62, 0.55).normalize();
// Elbow hint: out to the right and toward the camera. IMPORTANT: this must
// stay far from (anti)parallel with the typical shoulder→grip direction
// (which points up-left from our bottom-right shoulder), otherwise the
// Gram–Schmidt projection below degenerates and the elbow flips randomly.
const POLE_HINT = new THREE.Vector3(0.9, 0.05, 0.3).normalize();

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A bone segment: UNIT-height cylinder along +Y with its base at the
 * origin, so scaling the group's Y by the joint distance spans exactly
 * from joint A to joint B (a capsule would overshoot by 2·radius since
 * its caps extend past the stated height). Joints get their own spheres.
 */
function Bone({ radius, color, refObj }) {
  return (
    <group ref={refObj}>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[radius * 0.85, radius, 1, 14]} />
        <meshStandardMaterial color={color} roughness={0.75} />
      </mesh>
    </group>
  );
}

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

  const upperRef = useRef();
  const foreRef = useRef();
  const handRef = useRef();
  const elbowBallRef = useRef();

  // Scratch vectors reused every frame (never allocate in useFrame).
  const scratch = useMemo(() => ({
    G: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    perp: new THREE.Vector3(),
    E: new THREE.Vector3(),
    seg: new THREE.Vector3(),
    q: new THREE.Quaternion(),
  }), []);

  useFrame(() => {
    const T = penTip.current;
    const { G, dir, perp, E, seg, q } = scratch;

    // --- derive the grip target from the pen tip ---------------------
    G.copy(T).addScaledVector(PEN_AXIS, PEN_LENGTH);

    // --- two-bone IK solve (see math box above) ----------------------
    dir.subVectors(G, shoulder);
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

    // --- pose the meshes ---------------------------------------------
    // Upper arm: position at S, rotate +Y onto (E−S), scale Y to length.
    seg.subVectors(E, shoulder);
    upperRef.current.position.copy(shoulder);
    upperRef.current.quaternion.copy(q.setFromUnitVectors(UP, seg.clone().normalize()));
    upperRef.current.scale.set(1, seg.length(), 1);

    // Forearm: from E to G.
    seg.subVectors(G, E);
    foreRef.current.position.copy(E);
    foreRef.current.quaternion.copy(q.setFromUnitVectors(UP, seg.clone().normalize()));
    foreRef.current.scale.set(1, seg.length(), 1);

    elbowBallRef.current.position.copy(E);

    // Hand + pen: sit at the grip, oriented so the pen shaft (+Y of the
    // group) runs from tip T up through G — i.e. along PEN_AXIS.
    handRef.current.position.copy(G);
    handRef.current.quaternion.copy(q.setFromUnitVectors(UP, PEN_AXIS));

    // If USE_GLTF and your .glb has a skeleton, you would instead write:
    //   skeleton.bones['upperarm'].quaternion / ['forearm'] / ['hand']
    // from the same S, E, G world positions computed above.
  });

  return (
    <group>
      {/* -------- upper arm (sleeve) and forearm -------- */}
      <Bone refObj={upperRef} radius={0.26} color="#2d3142" />
      <Bone refObj={foreRef} radius={0.19} color="#e8b98f" />
      {/* shoulder + elbow joint balls hide the cylinder seams */}
      <mesh position={shoulder}>
        <sphereGeometry args={[0.34, 16, 16]} />
        <meshStandardMaterial color="#2d3142" roughness={0.75} />
      </mesh>
      <mesh ref={elbowBallRef}>
        <sphereGeometry args={[0.26, 16, 16]} />
        <meshStandardMaterial color="#2d3142" roughness={0.75} />
      </mesh>

      {/* -------- hand + pen assembly (posed as one group) -------- */}
      <group ref={handRef}>
        {/* palm / fist */}
        <mesh position={[0, 0.05, 0]} scale={[1, 1.25, 0.8]}>
          <sphereGeometry args={[0.26, 18, 18]} />
          <meshStandardMaterial color="#e8b98f" roughness={0.7} />
        </mesh>
        {/* two hinting fingers wrapped down the pen */}
        <mesh position={[0.08, -0.22, 0.16]} rotation={[0.5, 0, -0.2]}>
          <capsuleGeometry args={[0.07, 0.3, 4, 8]} />
          <meshStandardMaterial color="#e8b98f" roughness={0.7} />
        </mesh>
        <mesh position={[-0.1, -0.24, 0.14]} rotation={[0.45, 0, 0.25]}>
          <capsuleGeometry args={[0.07, 0.28, 4, 8]} />
          <meshStandardMaterial color="#e8b98f" roughness={0.7} />
        </mesh>
        {/* pen shaft: from grip down to the tip (tip = −PEN_LENGTH on Y) */}
        <mesh position={[0, -PEN_LENGTH / 2 + 0.15, 0]}>
          <cylinderGeometry args={[0.045, 0.045, PEN_LENGTH + 0.3, 12]} />
          <meshStandardMaterial color="#1a1a2e" roughness={0.35} metalness={0.3} />
        </mesh>
        {/* nib */}
        <mesh position={[0, -PEN_LENGTH + 0.06, 0]} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.045, 0.14, 12]} />
          <meshStandardMaterial color="#c9a227" roughness={0.3} metalness={0.6} />
        </mesh>
      </group>

      {/*
        GLTF SLOT — replace the procedural meshes above with a real model:

          import { useGLTF } from '@react-three/drei';
          function GltfArm() {
            const { scene } = useGLTF(GLTF_URL);
            return <primitive object={scene} />;
          }
          ...
          {USE_GLTF ? <Suspense fallback={null}><GltfArm/></Suspense> : <ProceduralArm/>}

        Keep the useFrame solver — it outputs world-space S/E/G positions
        that can drive either meshes (as here) or skeleton bones.
      */}
    </group>
  );
}
