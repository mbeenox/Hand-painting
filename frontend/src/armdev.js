/**
 * armdev.js — dev-only harness for the mannequin arm (see armdev.html).
 * Replicates Scene.jsx's camera/lights and HandRig's exact IK solve so a
 * screenshot here is what the app will show. ?pos=N picks a pen position.
 */
import * as THREE from 'three';
import { buildMannequinArm, HAND_ROLL } from './lib/mannequinArm.js';

const BOARD = 8;
const PEN_LENGTH = 1.1;
const PEN_AXIS = new THREE.Vector3(0.45, 0.62, 0.55).normalize();
const POLE_HINT = new THREE.Vector3(0.9, 0.05, 0.3).normalize();
const UP = new THREE.Vector3(0, 1, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf6f1e7);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 11);

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const d1 = new THREE.DirectionalLight(0xffffff, 1.2);
d1.position.set(4, 6, 8);
scene.add(d1);
const d2 = new THREE.DirectionalLight(0xffffff, 0.3);
d2.position.set(-6, -2, 4);
scene.add(d2);

// board outline + a fake ink squiggle for scale
const boardGeo = new THREE.PlaneGeometry(BOARD, BOARD);
const board = new THREE.Mesh(
  boardGeo,
  new THREE.MeshBasicMaterial({ color: 0xefe7d7 })
);
board.position.z = -0.01;
scene.add(board);

// pen positions to audit: center, 4 corners-ish
const POSITIONS = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(-3.4, 3.4, 0),
  new THREE.Vector3(3.4, 3.4, 0),
  new THREE.Vector3(-3.4, -3.4, 0),
  new THREE.Vector3(3.4, -3.4, 0),
];
const pos = Number(new URLSearchParams(location.search).get('pos') || 0);
const T = POSITIONS[Math.min(pos, POSITIONS.length - 1)];

// crosshair at the pen target so tip contact is checkable in screenshots
const chGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.25, 0, 0.002).add(T), new THREE.Vector3(0.25, 0, 0.002).add(T),
  new THREE.Vector3(0, -0.25, 0.002).add(T), new THREE.Vector3(0, 0.25, 0.002).add(T),
]);
const cross = new THREE.LineSegments(chGeo, new THREE.LineBasicMaterial({ color: 0xcc2222 }));
scene.add(cross);

// ---- identical solve to HandRig -------------------------------------------
const shoulder = new THREE.Vector3(BOARD * 0.5, -BOARD * 0.68, 1.4);
let maxReach = 0;
for (const sx of [-1, 1])
  for (const sy of [-1, 1])
    maxReach = Math.max(
      maxReach,
      new THREE.Vector3((sx * BOARD) / 2, (sy * BOARD) / 2, 0).distanceTo(shoulder)
    );
const total = maxReach * 1.06;
const L1 = total * 0.52;
const L2 = total * 0.48;

const arm = buildMannequinArm({ penLength: PEN_LENGTH });
scene.add(arm.root);

const ROLL = Number(new URLSearchParams(location.search).get('roll') || HAND_ROLL);
const handQuat = new THREE.Quaternion()
  .setFromUnitVectors(UP, PEN_AXIS)
  .multiply(new THREE.Quaternion().setFromAxisAngle(UP, ROLL));
const wristOffset = arm.wrist.clone().applyQuaternion(handQuat);

function pose(tip) {
  const G = tip.clone().addScaledVector(PEN_AXIS, PEN_LENGTH);
  const W = G.clone().add(wristOffset); // IK target = the wrist
  const dir = new THREE.Vector3().subVectors(W, shoulder);
  let d = dir.length();
  d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
  dir.normalize();
  const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const alpha = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
  const perp = POLE_HINT.clone().addScaledVector(dir, -POLE_HINT.dot(dir)).normalize();
  const E = shoulder
    .clone()
    .addScaledVector(dir, L1 * Math.cos(alpha))
    .addScaledVector(perp, L1 * Math.sin(alpha));

  const seg = new THREE.Vector3().subVectors(E, shoulder);
  arm.upper.position.copy(shoulder);
  arm.upper.quaternion.setFromUnitVectors(UP, seg.clone().normalize());
  arm.upper.scale.set(1, seg.length(), 1);

  seg.subVectors(W, E);
  arm.fore.position.copy(E);
  arm.fore.quaternion.setFromUnitVectors(UP, seg.clone().normalize());
  arm.fore.scale.set(1, seg.length(), 1);

  arm.shoulderBall.position.copy(shoulder);
  arm.elbowBall.position.copy(E);
  arm.hand.position.copy(G);
  arm.hand.quaternion.copy(handQuat);
}

pose(T);
if (new URLSearchParams(location.search).get('zoom')) {
  const G = T.clone().addScaledVector(PEN_AXIS, PEN_LENGTH);
  camera.position.copy(G).add(new THREE.Vector3(0.9, -0.3, 3.4));
  camera.lookAt(G);
}
renderer.render(scene, camera);
window.__armReady = true;
