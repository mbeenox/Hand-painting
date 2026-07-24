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

// ---------------------------------------------------------------------------
// Ink-bleed shader (Feature 4.1). The ribbon gains a per-vertex `aCross`
// (−1 at one edge, +1 at the other) — STATIC, prefilled like the index
// buffer, because edge parity never depends on what gets appended. The
// fragment shader turns |cross| into an organic edge:
//   · edge threshold displaced by WORLD-SPACE fbm (3 octaves), so the
//     raggedness sticks to the PAPER, not the stroke — redraws bleed
//     differently, and a moving stroke doesn't "swim";
//   · a faint feather zone past the crisp core (ink wicking into fibre);
//   · slight darkening around |cross|≈0.6 (ink pools at the nib shoulder).
// Boldness (`weight`) also widens the bleed. Flip USE_BLEED to false to
// fall back to the flat MeshBasicMaterial (mobile-GPU escape hatch).
// Exports are untouched by construction: they read the same WebGL canvas.
// ---------------------------------------------------------------------------
const USE_BLEED = true;

const BLEED_VERT = /* glsl */ `
  attribute float aCross;
  attribute float aWidth; // committed half-width — bleed scales with wetness
  varying float vCross;
  varying float vWidth;
  varying vec2 vWorld;
  void main() {
    vCross = aCross;
    vWidth = aWidth;
    vWorld = position.xy; // mesh sits untransformed on the board plane
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BLEED_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uBleed;   // 0.7..1.15 — scaled from stroke boldness
  uniform float uMaxHalf; // current widest half-width (for wetness normalization)
  varying float vCross;
  varying float vWidth;
  varying vec2 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
               u.y);
  }
  float fbm(vec2 p) { // 3 octaves — cheap enough for mobile
    float v = 0.5 * vnoise(p);
    v += 0.25 * vnoise(p * 2.03);
    v += 0.125 * vnoise(p * 4.09);
    return v / 0.875;
  }

  void main() {
    float x = abs(vCross);              // 0 = centerline, 1 = geometric edge
    // Wetness: wide slow strokes carry more ink and bleed hard; hairlines
    // stay near-crisp instead of fragmenting into dashes.
    float wet = clamp(vWidth / max(uMaxHalf, 1e-5), 0.0, 1.0);
    float bl = uBleed * mix(0.35, 1.0, wet);
    float n = fbm(vWorld * 16.0);       // paper-locked grain
    // Ragged edge: where the ink "ends" wobbles with the paper grain.
    float edge = mix(1.0 - 0.38 * bl, 1.0, clamp(n, 0.0, 1.0));
    float core = 1.0 - smoothstep(edge - 0.16, edge, x);
    // Feather: faint wicking beyond the core, gated by finer grain.
    float wick = (1.0 - smoothstep(edge - 0.05, 1.0, x))
               * 0.22 * bl * smoothstep(0.35, 0.75, fbm(vWorld * 37.0));
    float a = max(core, wick);
    if (a < 0.012) discard;
    // Pooling: ink settles a touch darker around the nib shoulder.
    float shoulder = exp(-pow((x - 0.6) / 0.18, 2.0));
    vec3 col = uColor * (1.0 - 0.13 * shoulder * bl);
    gl_FragColor = vec4(col, a);
  }
`;

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
    // aCross: edge parity (−1/+1) per ribbon vertex — STATIC like the index
    // buffer (append order never changes which side a vertex sits on).
    if (USE_BLEED) {
      const cross = new Float32Array(maxCenter * 2);
      for (let k = 0; k < maxCenter; k++) { cross[2 * k] = -1; cross[2 * k + 1] = 1; }
      g.setAttribute('aCross', new THREE.BufferAttribute(cross, 1));
      // Committed half-width per vertex — written EXACTLY where positions
      // are written (same append-only discipline), so bleed wetness is as
      // deterministic as the ribbon itself.
      const wid = new THREE.BufferAttribute(new Float32Array(maxCenter * 2), 1);
      wid.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aWidth', wid);
    }
    g.setDrawRange(0, 0);
    return g;
  }, [maxPoints]);

  const material = useMemo(() => {
    if (!USE_BLEED) {
      return new THREE.MeshBasicMaterial({ color: inkColor, side: THREE.DoubleSide });
    }
    return new THREE.ShaderMaterial({
      vertexShader: BLEED_VERT,
      fragmentShader: BLEED_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(inkColor) },
        uBleed: { value: 0.85 },
        uMaxHalf: { value: MAX_HALF },
      },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false, // single flat mesh at INK_Z; overlaps blend like wet ink
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- color/weight synced below
  useEffect(() => {
    if (material.isShaderMaterial) material.uniforms.uColor.value.set(inkColor);
    else material.color.set(inkColor);
  }, [inkColor, material]);
  useEffect(() => {
    // Boldness widens the bleed too: heavier nib → wetter line.
    if (material.isShaderMaterial) {
      material.uniforms.uBleed.value = Math.min(1.15, Math.max(0.7, 0.62 + 0.27 * weight));
      material.uniforms.uMaxHalf.value = MAX_HALF * weight;
    }
  }, [weight, material]);

  useFrame(() => {
    if (!active || !anim) return;
    const s = state.current;
    const { worldPoints, cumTime, isTravel, normals, warp, duration } = anim;
    const nPts = worldPoints.length;
    const pos = geometry.getAttribute('position');
    const wid = geometry.getAttribute('aWidth'); // null when USE_BLEED off

    const t = warp(Math.min(clockRef.current.elapsed, duration));

    const writeVertex = (slot, px, py, nx, ny, half) => {
      pos.setXYZ(2 * slot, px + nx * half, py + ny * half, INK_Z);
      pos.setXYZ(2 * slot + 1, px - nx * half, py - ny * half, INK_Z);
      if (wid) { wid.setX(2 * slot, half); wid.setX(2 * slot + 1, half); }
    };
    // Both edge vertices collapsed onto the centerline → the quads touching
    // this center have zero area → invisible (used to bridge pen-up hops).
    const writeCollapsed = (slot, px, py) => {
      pos.setXYZ(2 * slot, px, py, INK_Z);
      pos.setXYZ(2 * slot + 1, px, py, INK_Z);
      if (wid) { wid.setX(2 * slot, 0); wid.setX(2 * slot + 1, 0); }
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
    if (wid) {
      wid.clearUpdateRanges();
      wid.addUpdateRange(2 * startSlot, 2 * (s.cnt + 1) - 2 * startSlot);
      wid.needsUpdate = true;
    }
  });

  // Always on-screen; skip frustum culling so we never compute a bounding
  // sphere over the growing buffer every frame.
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
