# Hypnotic Hand — Improvement Roadmap ("make it impress users")

Step-by-step build plans for every recommended upgrade. Each feature is a
self-contained unit: its own branch/commit, its own Vercel deploy, verified
before moving on. Read `CLAUDE.md` first for architecture/deploy context.

## Recommended sequence (impact ÷ effort)

1. **Shareable export + recording** — highest reach; mostly frontend; low-med risk.
2. **Polish: processing cue, reveal, audio** — cheap, makes the flow feel premium.
3. **Variable-width ink strokes** — biggest single visual jump.
4. **User controls / style presets** — builds on #3 (color/weight/speed).
5. **Face-priority sampling** — backend; fixes "the face is just an outline".
6. **Rigged .glb hand** — highest effort/risk; do last.

Each section below: **Goal · Steps · Files · Effort/Risk · Verify · Decisions.**

---

## 1. Shareable export + recording

**Goal.** Let a user keep and share the result — download the finished portrait
as a PNG, and record the *act of drawing* as a short video/GIF. This is what
turns a one-time "neat" into something people post and send.

**Steps.**
1. Make the WebGL canvas capturable: add `preserveDrawingBuffer: true` to the
   `<Canvas gl={{...}}>` in `App.jsx` (needed to read pixels back for a still).
2. Decide how the background is included (see Decisions). Simplest path that
   captures the *full* look (paper + splashes + ink): composite at export time —
   draw paper color, then the splash SVGs, then `gl.domElement` onto an offscreen
   2D canvas via `drawImage`, and export that.
3. PNG still: in the `done` state add a **Download** button that builds the
   composite canvas and triggers `a.href = canvas.toDataURL('image/png'); a.download`.
4. Video of the draw: when `phase` enters `drawing`, start
   `const stream = gl.domElement.captureStream(60)` + `MediaRecorder(stream,
   {mimeType:'video/webm;codecs=vp9'})`, buffer chunks; on `done`, stop and hand
   back a `.webm` blob for download/share.
5. Web Share API: on capable devices, a **Share** button calls
   `navigator.share({ files:[pngFile] })`; fall back to download elsewhere.
6. Optional GIF: convert via `gif.js` (worker) if broad shareability matters more
   than size/quality; otherwise ship WebM only.
7. UI: add Download / Share / (Record toggle) to `UploadPanel.jsx`'s done state.

**Files.** `App.jsx` (Canvas flag + wiring), new `hooks/useCapture.js`,
`UploadPanel.jsx` (buttons), possibly `WatercolorSplash.jsx`/`Scene.jsx` if
splashes move into WebGL for cleaner video.

**Effort/Risk.** Medium / Medium — Safari's `MediaRecorder` webm support is
spotty (may need mp4/H.264 or a GIF fallback); compositing the DOM splash layer
adds work.

**Verify.** Draw → PNG opens with splashes+ink; record → webm plays start-to-end;
test Chrome + Safari; check no fps drop from `preserveDrawingBuffer`.

**Decisions.** Include splashes in the export (recommended) — keep them DOM and
composite, or move them into the 3D scene? WebM only, or add GIF?

---

## 2. Polish: processing cue, reveal, audio

**Goal.** Make every state feel intentional and premium, not like a demo.

**Steps.**
1. Processing state: show a tasteful loader + microcopy ("Reading your photo…")
   in `UploadPanel.jsx` while `phase === 'processing'` (currently a dead wait).
2. Draw-in: soft fade-in of paper + splashes; a gentle camera ease at start.
3. Pen audio: a looping soft pen-scratch sample whose volume tracks pen speed.
   Start it on the upload click (satisfies browser autoplay policy); default
   **off** with a small mute/unmute toggle. Add `hooks/useDrawSound.js` +
   `public/audio/scratch.mp3` (a short CC0 loop).
4. Completion: a subtle chime as the hand signs off, then reveal the share buttons.
5. Respect `prefers-reduced-motion` (skip camera moves / fades).

**Files.** `UploadPanel.jsx`, `App.jsx`, `Scene.jsx`, new `hooks/useDrawSound.js`,
`public/audio/scratch.mp3`.

**Effort/Risk.** Low–Medium / Low — main gotcha is audio autoplay (handled by
starting on a user gesture).

**Verify.** Each state looks deliberate; audio toggles cleanly; no console errors;
reduced-motion honored.

**Decisions.** Sound default (recommend off + toggle). Source a chime/scratch asset.

---

## 3. Variable-width ink strokes

**Goal.** Replace the uniform hairline with ink that has *weight* — the single
biggest jump from "plotter output" to "hand-drawn".

**Steps.**
1. Swap the three offset `THREE.Line` copies in `InkTrail.jsx` for a ribbon:
   `meshline` (THREE.MeshLine) or drei `<Line>`/Line2 (screen-space `linewidth`).
2. Per-vertex width: drive width from pen **speed** (fast → thinner, like a nib
   lifting) or `1/(1+curvature)`. Expose per-frame speed from `Scene.jsx`
   (`|ΔpenTip|/delta`) and pass it into the trail.
3. Preserve performance: keep an append-only, preallocated ribbon geometry and
   grow `drawRange` (the current design deliberately avoided Line2 rebuilds at
   60fps — keep that discipline; update a per-vertex width attribute in place).
4. Taper stroke ends for a natural start/finish nib.
5. Optional: a soft-edge/ink-bleed fragment shader for texture.

**Files.** `InkTrail.jsx` (significant rewrite), `Scene.jsx` (emit pen speed).

**Effort/Risk.** Medium / Medium — fat lines can cost fps; mitigate with
preallocation. Verify no truncation on long draws (the 16k buffer still applies).

**Verify.** `npm run build`; visually the line shows weight variation; fps steady;
whole path still renders.

**Decisions.** `meshline` vs Line2; width driver (speed vs curvature vs both).

---

## 4. User controls / style presets

**Goal.** Give users authorship — small tweaks that make each result feel theirs.

**Steps.**
1. Add a collapsible `ControlsPanel.jsx`: ink color, ink weight (feeds #3), draw
   speed (`DRAW_SECONDS`), splash intensity/palette, detail level.
2. Thread params: client-side ones (color/weight/speed/splash) stay in React
   state; **detail** is sent to the API — `api.js` adds `?detail=high|std` and
   `api/index.py` maps it to `MAX_POINTS`/`OUTPUT_POINTS`.
3. Presets: 2–3 named looks ("Fine liner", "Bold ink", "Sketch") that set a
   bundle of the above.
4. Persist last-used settings in `localStorage` (fine on the real site).

**Files.** new `components/ControlsPanel.jsx`, `App.jsx`, `api.js`,
`api/index.py` (accept `detail`), `InkTrail.jsx` (color/weight props),
`WatercolorSplash.jsx` (intensity/palette props).

**Effort/Risk.** Medium / Low–Medium.

**Verify.** Each control visibly changes the output; backend honors `detail`;
presets switch the whole look.

**Decisions.** Which controls to expose; preset definitions.

---

## 5. Face-priority sampling (backend)

**Goal.** Portraits keep eyes/nose/mouth instead of a bare outline — the fix for
"it doesn't complete the face". Most uploads are people.

**Steps.**
1. Detect faces on the downscaled image. Recommended: ship a single Haar cascade
   file in the repo (`api/assets/haarcascade_frontalface_default.xml`, ~0.9 MB)
   and load it explicitly with `cv2.CascadeClassifier` — cheap, and independent
   of the `cv2/data` we strip from the bundle (make sure `excludeFiles` doesn't
   remove `api/assets`). (Alternative: OpenCV DNN res10 SSD, ~10 MB, better
   accuracy — still fine under the 500 MB Fluid limit.)
2. Build a feathered weight mask: 1.0 everywhere, 3–5× inside face boxes.
3. Bias the Poisson-disk thinning in `sample_points`: use a smaller acceptance
   radius where the mask is high (denser points on the face). Keep total ≤
   `MAX_POINTS`; the face simply gets a bigger share.
4. Fallback: no face detected → behave exactly as today.

**Files.** `api/index.py` (`detect_edges`/`sample_points` + a `load_detector`),
`api/assets/…xml` (committed asset), `vercel.json` (don't exclude the asset),
`backend/main.py` (lockstep).

**Effort/Risk.** Medium / Medium — detection reliability + tuning the bias.

**Verify.** Pipeline on a face photo → points cluster on the face; non-face →
unchanged; timing still ≪ 30 s.

**Decisions.** Haar (small) vs DNN (accurate); face boost factor.

---

## 6. Rigged .glb hand

**Goal.** Replace the procedural cylinder arm with a believable hand that holds
the pen — the biggest realism upgrade.

**Steps.**
1. Source a rigged hand+forearm `.glb` (CC0/permissive), Draco-compressed;
   place at `frontend/public/models/arm.glb` (HandRig already marks the slot).
2. Load with drei `useGLTF` (+ `useGLTF.preload`); identify wrist/hand + a
   grip/fingertip bone.
3. Retarget the existing analytic IK: map the current shoulder→elbow→grip (S/E/G)
   solve onto the model's bones; seat the pen in the grip so the tip stays exactly
   on `penTip`.
4. Fix scale/orientation to the board; keep the anti-elbow-flip pole-vector rule.
5. Add subtle finger flex + a soft contact shadow.

**Files.** `HandRig.jsx` (major), `public/models/arm.glb` (asset), `Scene.jsx`.

**Effort/Risk.** High / High — rig retargeting is fiddly; asset sourcing/licensing.

**Verify.** Hand visibly grips the pen and tracks the line; no elbow flips; fps ok;
bundle stays small (glb ≈ 1–3 MB Draco).

**Decisions.** Which model/license; how much finger animation.

---

## Process notes

- Each feature ships as its own commit + Vercel deploy; verify (`npm run build`
  for frontend, the synthetic-image pipeline run for backend) before the next.
- Update `CLAUDE.md`'s revision history after each.
- Size watch: only #5 (cascade/model) and #6 (glb) add bundle weight — all well
  under the 500 MB Fluid limit, but keep an eye on the function bundle.
