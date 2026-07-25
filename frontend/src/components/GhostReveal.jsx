/**
 * GhostReveal — "look what it caught" (Feature 5.2).
 *
 * When the drawing finishes, the SOURCE PHOTO breathes in underneath the ink
 * at a whisper of opacity, holds for a beat, and fades away. It is the moment
 * the abstraction pays off: for one second you see the eyes the line found.
 *
 * It lives INSIDE the R3F scene rather than as a DOM layer, and that choice
 * does two jobs at once:
 *
 *  1. **Registration is free.** The plane is placed at the drawing's exact
 *     world rectangle using the same normalized→world mapping
 *     `usePathAnimation` uses, so the photo lands under its own line art for
 *     every aspect ratio — including the shrunken, pushed-up rectangle a
 *     written caption leaves behind. A DOM overlay would have to re-derive
 *     the camera projection and would drift the moment either changed.
 *
 *  2. **Every export gets it for free.** `useDrawCapture` composites the
 *     WebGL canvas as one layer, so the reveal is in the video and the GIF
 *     with no compositing changes. It sits behind the ink (z < INK_Z) and in
 *     front of nothing — paper and splash are DOM, behind the transparent
 *     canvas.
 *
 * The whole cycle is deliberately shorter than the 2.6 s the capture keeps
 * running after `done`: the reveal must be INSIDE the recording, and gone
 * again before `snapshotPNG()` grabs the clean still.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Opacity is the one number that matters here, and 12% (the number this
// feature was specced with) turned out to be inaudible: a photo laid over
// pale paper only registers where it is DARK, so a light or low-contrast
// source shows essentially nothing. Measured on the low-contrast test
// portrait, 0.26 is where the form becomes readable; on a dark-background
// portrait it is present without washing the paper out.
const PEAK = 0.26;
const FADE_IN = 0.4;
const HOLD = 1.0;
const FADE_OUT = 0.7; // 2.1 s total, inside the 2.6 s capture tail
const GHOST_Z = 0.004; // behind INK_Z (0.011); the hand still occludes it

export default function GhostReveal({ url, rect, active }) {
  const [texture, setTexture] = useState(null);
  const meshRef = useRef(null);
  const matRef = useRef(null);
  const elapsed = useRef(0);

  // Loaded by hand rather than with useLoader: the Canvas has no Suspense
  // boundary, and a photo that fails to decode must simply mean "no reveal",
  // never a broken drawing.
  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    let loaded = null;
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (!alive) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        loaded = tex;
        setTexture(tex);
      },
      undefined,
      () => { /* undecodable source → the drawing stands on its own */ }
    );
    return () => { alive = false; loaded?.dispose(); setTexture(null); };
  }, [url]);

  useFrame((_, delta) => {
    const mat = matRef.current;
    const mesh = meshRef.current;
    if (!mat || !mesh) return;
    if (!active) {
      elapsed.current = 0;
      mesh.visible = false;
      return;
    }
    elapsed.current += delta;
    const t = elapsed.current;
    let a;
    if (t < FADE_IN) a = t / FADE_IN;
    else if (t < FADE_IN + HOLD) a = 1;
    else a = Math.max(0, 1 - (t - FADE_IN - HOLD) / FADE_OUT);
    mat.opacity = a * PEAK;
    mesh.visible = a > 0.002;
  });

  if (!texture || !rect || !(rect.w > 0) || !(rect.h > 0)) return null;

  return (
    <mesh ref={meshRef} position={[rect.cx, rect.cy, GHOST_Z]} visible={false}>
      <planeGeometry args={[rect.w, rect.h]} />
      <meshBasicMaterial
        ref={matRef}
        map={texture}
        transparent
        opacity={0}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
