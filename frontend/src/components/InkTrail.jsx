/**
 * InkTrail — the growing ink line left behind by the pen tip.
 *
 * Technique: ONE preallocated BufferGeometry position attribute of
 * `maxPoints` vertices. Every frame we copy the pen tip's current
 * position into the next free slot and advance `geometry.drawRange`,
 * so the GPU only renders the vertices written so far. This is the
 * cheapest possible "growing line": zero allocation, zero geometry
 * rebuilds — just a partial buffer upload per frame (we mark only the
 * updated range via `addUpdateRange`).
 *
 * (Drei's <Line> / Line2 would give fat screen-space strokes, but its
 * LineGeometry.setPositions() reallocates instanced buffers on every
 * update — wasteful at 60 fps. A native THREE.Line with drawRange is
 * the right tool for an append-only polyline; to fake a slightly
 * heavier "micron pen" stroke we render 3 copies nudged ~half a pixel.)
 */
import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const INK_COLOR = '#141428'; // near-black blue, micron-pen style
const MIN_STEP = 0.0025;     // world units — skip vertices when pen is idle
                             // (denser than before → smoother, fuller line)

export default function InkTrail({ penTip, maxPoints = 16000, active }) {
  const lineRefs = [useRef(), useRef(), useRef()];
  const state = useRef({ count: 0, last: new THREE.Vector3(Infinity, 0, 0) });

  // One shared, preallocated position buffer for all three line copies.
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr);
    g.setDrawRange(0, 0);
    return g;
  }, [maxPoints]);

  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: INK_COLOR }),
    []
  );

  useFrame(() => {
    if (!active) return;
    const s = state.current;
    const tip = penTip.current;
    if (s.count >= maxPoints) return;
    // Only record a vertex once the pen has actually moved a little —
    // keeps the buffer from filling with duplicates while easing slowly.
    if (tip.distanceTo(s.last) < MIN_STEP && s.count > 0) return;

    const attr = geometry.getAttribute('position');
    attr.setXYZ(s.count, tip.x, tip.y, 0.01); // slightly in front of paper
    s.last.copy(tip);
    s.count += 1;

    // Upload only the vertex we just wrote, then extend the draw range.
    attr.clearUpdateRanges();
    attr.addUpdateRange((s.count - 1) * 3, 3);
    attr.needsUpdate = true;
    geometry.setDrawRange(0, s.count);
  });

  // Three overlapping copies with sub-pixel world offsets → a stroke that
  // reads ~2px wide, like a 0.3mm fineliner, without Line2's overhead.
  const offsets = [0, 0.006, -0.006];
  return (
    <group>
      {offsets.map((o, i) => (
        <line key={i} ref={lineRefs[i]} geometry={geometry} material={material}
              position={[o, o * 0.6, 0]} />
      ))}
    </group>
  );
}
