/**
 * WatercolorSplash — the abstract base layer ("splash hook").
 *
 * 2–3 randomized organic blobs rendered as SVG paths with radial-gradient
 * fills + a feGaussianBlur bleed, sitting BEHIND the (alpha-transparent)
 * 3D canvas so the black ink line is drawn on top of them.
 *
 * Blob construction: walk 8–11 angles around a circle, give each spoke a
 * random radius, then join the points with Catmull-Rom-ish cubic Béziers
 * (control points perpendicular to each spoke) — cheap, always-closed,
 * organically lumpy shapes.
 */
import React, { useMemo } from 'react';

const PALETTES = [
  ['#f4a9b8', '#e05c6e'], // rose
  ['#9bd0e8', '#3a7ca5'], // cerulean
  ['#f7d08a', '#e88f34'], // ochre
  ['#b8e0c8', '#3d8b64'], // viridian
  ['#cdb4e8', '#7d5ba6'], // violet
];

function makeBlobPath(cx, cy, baseR, rng) {
  const n = 8 + Math.floor(rng() * 4);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const r = baseR * (0.6 + rng() * 0.7);
    pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
  }
  // Smooth closed curve through the points using reflected control points.
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    // control point pushed perpendicular to the chord for lumpiness
    const k = (rng() - 0.5) * 0.9;
    d += ` Q ${mx - dy * k} ${my + dx * k}, ${p1[0]} ${p1[1]}`;
  }
  return d + ' Z';
}

export default function WatercolorSplash({ count = 3 }) {
  const blobs = useMemo(() => {
    const rng = Math.random; // fresh randomness on every mount (per run)
    const chosen = [...PALETTES].sort(() => rng() - 0.5).slice(0, count);
    return chosen.map(([light, dark], i) => ({
      id: i,
      light,
      dark,
      d: makeBlobPath(18 + rng() * 64, 18 + rng() * 64, 12 + rng() * 14, rng),
      opacity: 0.28 + rng() * 0.2,
    }));
  }, [count]);

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      <defs>
        {blobs.map((b) => (
          <radialGradient key={b.id} id={`wc-${b.id}`} cx="42%" cy="40%" r="65%">
            <stop offset="0%" stopColor={b.light} stopOpacity="0.95" />
            <stop offset="72%" stopColor={b.dark} stopOpacity="0.55" />
            {/* watercolor "edge darkening": pigment pools at the rim */}
            <stop offset="93%" stopColor={b.dark} stopOpacity="0.75" />
            <stop offset="100%" stopColor={b.dark} stopOpacity="0.15" />
          </radialGradient>
        ))}
        <filter id="wc-bleed" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
      </defs>
      {blobs.map((b) => (
        <path
          key={b.id}
          d={b.d}
          fill={`url(#wc-${b.id})`}
          opacity={b.opacity}
          filter="url(#wc-bleed)"
        />
      ))}
    </svg>
  );
}
