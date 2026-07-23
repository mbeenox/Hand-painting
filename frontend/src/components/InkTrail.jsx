/**
 * InkTrail — the growing ink stroke left behind by the pen tip, as a
 * VARIABLE-WIDTH ribbon (Feature #3).
 *
 * The pen path lives in the z=0 plane, so the stroke is a flat 2D ribbon: for
 * each new centerline point we extrude two edge vertices ±(halfWidth · normal),
 * where the normal is perpendicular to the local tangent. The half-width tracks
 * pen speed — slow, deliberate passes read as a heavier nib; fast sweeps thin
 * out — and ramps up over the first few points for a tapered start.
 *
 * Performance discipline (kept from the original hairline version): ONE
 * preallocated position buffer (2 vertices per centerline point), a STATIC
 * prefilled triangle index buffer, and incremental per-frame uploads via
 * drawRange growth + addUpdateRange — no geometry rebuilds at 60fps. (Drei's
 * Line2 gives fat strokes but only a UNIFORM width; meshline rebuilds the whole
 * strip each update. A hand-rolled ribbon is the right tool for append-only,
 * per-vertex width.)
 */
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const INK_COLOR = '#141428'; // near-black blue, micron-pen style
const MIN_STEP = 0.0025;     // min centerline spacing (world units)
const MIN_HALF = 0.009;      // thinnest half-width (fastest sweeps)
const MAX_HALF = 0.034;      // widest half-width (slow pen / curves / stroke ends)
const WIDTH_LERP = 0.22;     // low-pass on width → smooth taper, no jitter
const TAPER_N = 10;          // centerline points over which the start nib ramps
const SPEED_DECAY = 0.999;   // adaptation rate of the running max-speed reference
const INK_Z = 0.011;         // sit just in front of the paper plane

export default function InkTrail({ penTip, speedRef, maxPoints = 16000, active }) {
  const state = useRef({
    cnt: 0,
    prev: new THREE.Vector3(Infinity, 0, 0),
    w: MIN_HALF,
    maxSpeed: 1e-6,
  });

  const geometry = useMemo(() => {
    const maxCenter = maxPoints;
    const g = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(maxCenter * 2 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    // Static triangle indices for every possible segment (2 tris per quad).
    const idx = new Uint32Array(Math.max(0, maxCenter - 1) * 6);
    for (let k = 0; k < maxCenter - 1; k++) {
      const a = 2 * k, b = 2 * k + 1, c = 2 * k + 2, d = 2 * k + 3;
      const o = k * 6;
      idx[o] = a; idx[o + 1] = b; idx[o + 2] = c;
      idx[o + 3] = b; idx[o + 4] = d; idx[o + 5] = c;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    return g;
  }, [maxPoints]);

  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: INK_COLOR, side: THREE.DoubleSide }),
    []
  );

  useFrame(() => {
    if (!active) return;
    const s = state.current;
    if (s.cnt >= maxPoints) return;
    const tip = penTip.current;

    // First qualifying frame: remember the start, defer vertices until we have
    // a direction to orient the ribbon.
    if (s.cnt === 0) {
      s.prev.copy(tip);
      s.cnt = 1;
      return;
    }

    const dx = tip.x - s.prev.x;
    const dy = tip.y - s.prev.y;
    const len = Math.hypot(dx, dy);
    if (len < MIN_STEP) return; // pen barely moved → skip (no dupes when easing)

    // Unit tangent → unit normal (perpendicular, in the z=0 plane).
    const tx = dx / len;
    const ty = dy / len;
    const nx = -ty;
    const ny = tx;

    // Half-width from pen speed, normalized adaptively against the fastest
    // stroke so far so the full thin→bold range is always used (a near-stopped
    // pen → thickest; the fastest sweep → thinnest). Low-passed for a smooth
    // taper so the width never jitters.
    const speed = (speedRef && speedRef.current) || 0;
    s.maxSpeed = Math.max(s.maxSpeed * SPEED_DECAY, speed);
    const norm = s.maxSpeed > 1e-6 ? Math.min(1, speed / s.maxSpeed) : 0;
    const target = MAX_HALF - (MAX_HALF - MIN_HALF) * norm;
    s.w += (target - s.w) * WIDTH_LERP;

    const pos = geometry.getAttribute('position');
    const newIdx = s.cnt; // this point's centerline index
    const taper = (i) => Math.min(1, i / TAPER_N);
    const writeVertex = (i, px, py, half) => {
      pos.setXYZ(2 * i, px + nx * half, py + ny * half, INK_Z);
      pos.setXYZ(2 * i + 1, px - nx * half, py - ny * half, INK_Z);
    };

    let updStart = 2 * newIdx * 3;
    let updLen = 6;
    if (newIdx === 1) {
      // Center 0 was deferred; write it now with this segment's normal.
      writeVertex(0, s.prev.x, s.prev.y, s.w * taper(0));
      updStart = 0;
      updLen = 12;
    }
    writeVertex(newIdx, tip.x, tip.y, s.w * taper(newIdx));

    geometry.setDrawRange(0, newIdx * 6); // centers 0..newIdx → newIdx segments
    pos.clearUpdateRanges();
    pos.addUpdateRange(updStart, updLen);
    pos.needsUpdate = true;

    s.prev.copy(tip);
    s.cnt += 1;
  });

  // Always on-screen; skip frustum culling so we never compute a bounding
  // sphere over the growing buffer every frame.
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
