/**
 * InkTrail — the growing ink stroke left behind by the pen, as a
 * VARIABLE-WIDTH ribbon (Feature #3), rendered EXACT-APPEND (trace fix).
 *
 * Exact-append: instead of sampling the pen tip once per frame (which cuts
 * corners at low frame rates and — fatally for trace mode — INKS ACROSS
 * pen-up hops shorter than one frame), we commit the animation's actual
 * path vertices as the clock passes their timestamps. Every frame:
 *
 *   1. append every path vertex whose cumTime ≤ warped elapsed time
 *      (segments marked `isTravel` get a degenerate zero-width bridge
 *      instead of ink — that's the pen lifting between strokes);
 *   2. overwrite ONE floating "live tip" center at the interpolated pen
 *      position so the ink still visibly flows out of the nib between
 *      vertex crossings.
 *
 * The ribbon math is unchanged: for each centerline point two edge vertices
 * at ±(halfWidth · normal); normals are precomputed per vertex by
 * usePathAnimation (one-sided at stroke boundaries). Half-width now tracks
 * the TIMETABLE speed of each segment (slow, curvy passes → heavier nib;
 * fast sweeps → hairline) instead of frame-observed speed, so the width is
 * deterministic and frame-rate independent too.
 *
 * Performance discipline (kept): ONE preallocated position buffer
 * (2 vertices per center), a STATIC prefilled triangle index buffer, and
 * incremental per-frame uploads via drawRange growth + addUpdateRange —
 * no geometry rebuilds at 60fps.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const INK_COLOR = '#141428'; // near-black blue, micron-pen style
const MIN_HALF = 0.009;      // thinnest half-width (fastest sweeps)
const MAX_HALF = 0.034;      // widest half-width (slow pen / curves / stroke ends)
const WIDTH_LERP = 0.22;     // low-pass on width → smooth taper, no jitter
const TAPER_N = 8;           // centers over which each stroke's nib ramps in
const SPEED_DECAY = 0.999;   // adaptation rate of the running max-speed reference
const INK_Z = 0.011;         // sit just in front of the paper plane

export default function InkTrail({
  anim, penTip, clockRef, inkColor = INK_COLOR, weight = 1,
  maxPoints = 16000, active,
}) {
  const state = useRef({
    cnt: 0,        // committed centerline points
    next: 0,       // next path vertex index to commit
    w: MIN_HALF,
    maxSpeed: 1e-6,
    taperBase: 0,  // committed index where the CURRENT stroke began
    lastX: 0,
    lastY: 0,
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
    () => new THREE.MeshBasicMaterial({ color: inkColor, side: THREE.DoubleSide }),
    [] // eslint-disable-line react-hooks/exhaustive-deps -- color synced below
  );
  useEffect(() => { material.color.set(inkColor); }, [inkColor, material]);

  useFrame(() => {
    if (!active || !anim) return;
    const s = state.current;
    const { worldPoints, cumTime, isTravel, normals, warp, duration } = anim;
    const nPts = worldPoints.length;
    const pos = geometry.getAttribute('position');

    const t = warp(Math.min(clockRef.current.elapsed, duration));

    const writeVertex = (slot, px, py, nx, ny, half) => {
      pos.setXYZ(2 * slot, px + nx * half, py + ny * half, INK_Z);
      pos.setXYZ(2 * slot + 1, px - nx * half, py - ny * half, INK_Z);
    };
    // Both edge vertices collapsed onto the centerline → the quads touching
    // this center have zero area → invisible (used to bridge pen-up hops).
    const writeCollapsed = (slot, px, py) => {
      pos.setXYZ(2 * slot, px, py, INK_Z);
      pos.setXYZ(2 * slot + 1, px, py, INK_Z);
    };
    const taper = (slot) =>
      Math.min(1, Math.max(0, slot - s.taperBase) / TAPER_N);

    const startSlot = s.cnt;

    // ---- 1. Commit every path vertex the clock has passed. -------------
    // (-3: room for a bridge pair plus the floating tip center.)
    while (s.next < nPts && cumTime[s.next] <= t && s.cnt < maxPoints - 3) {
      const i = s.next;
      const P = worldPoints[i];

      if (i > 0 && isTravel[i - 1]) {
        // This vertex is a LANDING after a pen-up hop: seal the previous
        // stroke and cross the gap with zero-width (invisible) centers.
        writeCollapsed(s.cnt, s.lastX, s.lastY);
        writeCollapsed(s.cnt + 1, P.x, P.y);
        s.cnt += 2;
        s.taperBase = s.cnt; // the new stroke tapers in from zero
        s.w = MIN_HALF;
      } else if (i > 0) {
        // Width from this segment's DRAWN speed (world units / second on
        // the warped timetable): slow, deliberate passes read as a heavier
        // nib, fast sweeps thin out. Adaptive normalization against the
        // fastest segment so far keeps the full thin→bold range in play.
        const dt = Math.max(cumTime[i] - cumTime[i - 1], 1e-6);
        const segL = P.distanceTo(worldPoints[i - 1]);
        const v = segL / dt;
        s.maxSpeed = Math.max(s.maxSpeed * SPEED_DECAY, v);
        const norm = s.maxSpeed > 1e-6 ? Math.min(1, v / s.maxSpeed) : 0;
        const target = (MAX_HALF - (MAX_HALF - MIN_HALF) * norm) * weight;
        s.w += (target - s.w) * WIDTH_LERP;
      }

      writeVertex(s.cnt, P.x, P.y,
                  normals[2 * i], normals[2 * i + 1], s.w * taper(s.cnt));
      s.lastX = P.x;
      s.lastY = P.y;
      s.cnt += 1;
      s.next += 1;
    }

    if (s.cnt === 0) return; // clock hasn't started yet

    // ---- 2. Floating live-tip center (overwritten every frame). --------
    // While the pen flies between strokes the tip must NOT drag ink, so the
    // floating center collapses onto the last committed point instead.
    const flying = s.next > 0 && s.next <= isTravel.length && isTravel[s.next - 1];
    if (flying) {
      writeCollapsed(s.cnt, s.lastX, s.lastY);
    } else {
      const ni = 2 * Math.min(s.next, nPts - 1);
      writeVertex(s.cnt, penTip.current.x, penTip.current.y,
                  normals[ni], normals[ni + 1], s.w * taper(s.cnt));
    }

    // s.cnt committed + 1 floating center → s.cnt ribbon segments.
    geometry.setDrawRange(0, s.cnt * 6);
    pos.clearUpdateRanges();
    pos.addUpdateRange(2 * startSlot * 3, (2 * (s.cnt + 1) - 2 * startSlot) * 3);
    pos.needsUpdate = true;
  });

  // Always on-screen; skip frustum culling so we never compute a bounding
  // sphere over the growing buffer every frame.
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
