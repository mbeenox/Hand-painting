/**
 * mannequinArm.js — a wooden artist's-mannequin arm + hand, authored in code.
 *
 * Feature 4.2 ("rigged realistic hand") shipped as an ORIGINAL asset rather
 * than a downloaded .glb: no CC0 rigged arm existed on license-verifiable
 * sources (Poly Haven has none; Sketchfab requires per-asset OAuth; game
 * characters need mesh surgery and read flat next to the ink-bleed shader),
 * and authoring it here gives exact rest-pose alignment by construction,
 * zero license risk, zero network fetch, and no fallback complexity.
 * The look is the classic segmented wooden drawing mannequin — an art-studio
 * object holding a pen, which is exactly what this app is.
 *
 * CONTRACT (the same one HandRig.jsx has always enforced):
 *   · the hand group's local frame has +Y running UP the pen shaft and the
 *     pen tip at (0, -penLength, 0); HandRig places the group at the grip G
 *     and rotates UP onto PEN_AXIS, so the tip lands EXACTLY on penTip.
 *   · upper/fore are unit-height segments (base at origin, +Y), scaled to
 *     the joint distance each frame — the same discipline as the old Bone.
 *   · `wrist` is the hand-local point where the forearm should terminate;
 *     HandRig turns it into a constant world offset from G (the hand's
 *     quaternion is constant) and aims the forearm at THAT, so the arm
 *     meets the hand at an actual wrist instead of plugging into the pen.
 *
 * Everything is tunable from the constants below; the dev harness
 * (`frontend/armdev.html`) renders this file against the real camera and
 * lights for screenshot-driven tuning.
 */
import * as THREE from 'three';

// ---- wood & metal palette -------------------------------------------------
const WOOD_LIGHT = 0xcda173; // boxwood, lit face
const WOOD_MID = 0xbe8f60; // segment bodies
const WOOD_DARK = 0x9c7248; // joint balls (end-grain reads darker)
const BRASS = 0xa8862e;
const PEN_BODY = 0x1a1a2e; // unchanged from the old rig (house pen)

// ---- proportions (hand-local units; board is 8 units wide) ----------------
// Roll of the whole hand about the pen shaft (tip-safe by construction —
// rotating around the pen axis cannot move the tip). Chosen from a rendered
// sweep: at −0.45 the camera sees the fingers articulate around the pen,
// like watching an artist across the table.
export const HAND_ROLL = -0.45;
const WRIST = new THREE.Vector3(-0.05, 0.9, 0.44); // forearm meets hand here
const PALM_CENTER = new THREE.Vector3(0.0, 0.58, 0.36);
const PALM_SIZE = { w: 0.55, l: 0.56, t: 0.16 };
const PALM_TILT_X = 0.3; // back of hand faces camera, dipping toward the nib
const PALM_TILT_Z = -0.08;

function woodMaterial(color, grain) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.0,
    map: grain || null,
  });
}

/**
 * Subtle procedural wood grain — a tiny CanvasTexture so the segments read
 * as turned wood instead of plastic. Guarded: in any environment without a
 * DOM (tests) we silently skip the map.
 */
function makeGrainTexture() {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  // Vertical grain: soft darker streaks of varying width/alpha. Deterministic
  // (no Math.random) so every load looks the same.
  let x = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (x < S) {
    const w = 1 + rand() * 5;
    const a = 0.04 + rand() * 0.09;
    ctx.fillStyle = `rgba(92, 58, 20, ${a.toFixed(3)})`;
    ctx.fillRect(x, 0, w, S);
    x += w + 2 + rand() * 6;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Sphere helper (joint balls, knuckles). */
function ball(r, material, segs = 14) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, segs, segs), material);
}

/**
 * A turned-wood limb segment: unit height along +Y, base at the origin,
 * lathed with a gentle barrel swell so it reads as carved, not extruded.
 * Scale Y to the joint distance at pose time (the rounded arc is subtle
 * enough that non-uniform scaling doesn't visibly distort it, and both
 * ends hide inside joint balls).
 */
function barrel(r0, r1, material) {
  const pts = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = THREE.MathUtils.lerp(r0, r1, t) * (1 + 0.07 * Math.sin(Math.PI * t));
    pts.push(new THREE.Vector2(r, t));
  }
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 20), material);
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

/**
 * One finger: a chain of capsule segments with knuckle balls, built with
 * plain forward kinematics. `base` positions the metacarpal joint in the
 * hand frame; `aim` is that joint's rotation (Euler); each segment then
 * bends by `curl` radians about its local X (positive = toward the palm /
 * the pen shaft, i.e. local −Z after the aim).
 */
function finger(hand, base, aim, segs, matBody, matJoint) {
  let parent = new THREE.Group();
  parent.position.copy(base);
  parent.rotation.set(aim.x, aim.y, aim.z);
  hand.add(parent);
  let tip = parent;
  let i = 0;
  for (const s of segs) {
    // base knuckle hides under the palm edge — light wood so it doesn't pop
    const joint = ball(s.r * 0.98, i === 0 ? matBody : matJoint);
    i += 1;
    tip.add(joint);
    const segGroup = new THREE.Group();
    segGroup.rotation.x = s.curl;
    tip.add(segGroup);
    const cap = new THREE.Mesh(
      new THREE.CapsuleGeometry(s.r, Math.max(0.02, s.len - s.r), 4, 10),
      matBody
    );
    cap.position.y = -s.len / 2;
    segGroup.add(cap);
    const next = new THREE.Group();
    next.position.y = -s.len;
    segGroup.add(next);
    tip = next;
  }
  // rounded fingertip
  tip.add(ball(segs[segs.length - 1].r * 0.95, matBody));
  return tip;
}

/**
 * Build the whole arm. Returns the pieces HandRig poses each frame plus the
 * hand-local wrist point. All groups start unposed; nothing here allocates
 * after construction.
 */
export function buildMannequinArm({ penLength = 1.1 } = {}) {
  const grain = makeGrainTexture();
  // Grain ONLY on the lathed limbs (its streaks run along the turning axis
  // there); on spheres the same texture swirls and reads as a turban.
  const matLimbUpper = woodMaterial(WOOD_MID, grain);
  const matLimbFore = woodMaterial(WOOD_LIGHT, grain);
  const matLight = woodMaterial(WOOD_LIGHT, null);
  const matJoint = woodMaterial(WOOD_DARK, null);
  const matBrass = new THREE.MeshStandardMaterial({
    color: BRASS,
    roughness: 0.35,
    metalness: 0.75,
  });

  const root = new THREE.Group();

  // ---- limbs (posed by HandRig: position/quaternion/scaleY) --------------
  const upper = barrel(0.26, 0.2, matLimbUpper);
  const fore = barrel(0.19, 0.1, matLimbFore);
  const shoulderBall = ball(0.32, matJoint, 18);
  const elbowBall = ball(0.23, matJoint, 18);
  root.add(upper, fore, shoulderBall, elbowBall);

  // ---- hand assembly (rigid; origin = grip G, +Y up the pen) -------------
  const hand = new THREE.Group();
  root.add(hand);

  // wrist ball — the forearm terminates here (see HandRig)
  const wristBall = ball(0.15, matJoint, 16);
  wristBall.position.copy(WRIST);
  hand.add(wristBall);
  // brass wrist pin, the mannequin's signature detail
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.34, 10), matBrass);
  pin.rotation.z = Math.PI / 2;
  pin.position.copy(WRIST);
  hand.add(pin);

  // palm — a carved rounded slab, back of the hand toward the camera
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.5, 22, 18), matLight);
  palm.scale.set(PALM_SIZE.w, PALM_SIZE.l, PALM_SIZE.t);
  palm.position.copy(PALM_CENTER);
  palm.rotation.set(PALM_TILT_X, 0, PALM_TILT_Z);
  hand.add(palm);

  // ---- fingers ------------------------------------------------------------
  // Index + middle reach the shaft; ring + pinky tuck progressively. A right
  // hand: thumb side is +X. Curl is about local X (toward the pen at −Z).
  const E = (x, y, z) => new THREE.Euler(x, y, z);
  // index — runs down the camera side of the shaft, tip wrapping past it
  finger(
    hand,
    new THREE.Vector3(0.12, 0.32, 0.46),
    E(0.35, 0.0, -0.05),
    [
      { len: 0.3, r: 0.066, curl: 0.1 },
      { len: 0.22, r: 0.059, curl: 0.25 },
      { len: 0.17, r: 0.052, curl: 0.35 },
    ],
    matLight,
    matJoint
  );
  finger(
    hand,
    new THREE.Vector3(0.0, 0.3, 0.47),
    E(0.32, 0.0, 0.02),
    [
      { len: 0.32, r: 0.068, curl: 0.12 },
      { len: 0.23, r: 0.06, curl: 0.3 },
      { len: 0.18, r: 0.053, curl: 0.42 },
    ],
    matLight,
    matJoint
  );
  finger(
    hand,
    new THREE.Vector3(-0.15, 0.31, 0.44),
    E(0.3, 0.0, 0.1),
    [
      { len: 0.3, r: 0.064, curl: 0.3 },
      { len: 0.21, r: 0.057, curl: 0.55 },
      { len: 0.15, r: 0.05, curl: 0.6 },
    ],
    matLight,
    matJoint
  );
  finger(
    hand,
    new THREE.Vector3(-0.24, 0.33, 0.38),
    E(0.28, 0.0, 0.26),
    [
      { len: 0.22, r: 0.056, curl: 0.45 },
      { len: 0.16, r: 0.05, curl: 0.75 },
      { len: 0.12, r: 0.044, curl: 0.8 },
    ],
    matLight,
    matJoint
  );
  // thumb — crosses in FRONT of the shaft from +X, pad pressing it
  finger(
    hand,
    new THREE.Vector3(0.29, 0.55, 0.36),
    E(0.32, 0.5, -0.95),
    [
      { len: 0.28, r: 0.075, curl: 0.12 },
      { len: 0.2, r: 0.066, curl: 0.5 },
    ],
    matLight,
    matJoint
  );

  // ---- pen (unchanged from the old rig: shaft to tip at −penLength) ------
  const pen = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, penLength + 0.3, 12),
    new THREE.MeshStandardMaterial({ color: PEN_BODY, roughness: 0.35, metalness: 0.3 })
  );
  pen.position.y = -penLength / 2 + 0.15;
  hand.add(pen);
  const nib = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 12), matBrass);
  nib.rotation.x = Math.PI;
  nib.position.y = -penLength + 0.06;
  hand.add(nib);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.07, 12), matBrass);
  ferrule.position.y = -0.06;
  hand.add(ferrule);

  return { root, upper, fore, shoulderBall, elbowBall, hand, wrist: WRIST.clone() };
}
