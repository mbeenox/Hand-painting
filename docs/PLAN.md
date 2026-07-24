# Hypnotic Hand — Growth & Depth Implementation Plan

_Drafted 2026-07-23. Companion to `CLAUDE.md` (read that first for architecture).
Nine features in four phases, ordered so each phase completes a user-visible
loop before the next begins. Estimates assume the current codebase and the
verification workflow already in place (unit checks → npm build → headless
E2E → deploy → prod poll)._

**The strategic frame:** the product loop is
*discover → be amazed → share → return → go deeper*.
Phase 1 completes "discover" and strengthens "share". Phase 2 builds "return".
Phase 3 deepens "go deeper". Phase 4 is spectacle — it multiplies every other
phase but depends on none of them.

Effort scale: **S** = under half a day · **M** = 1–2 days · **L** = 3+ days.

---

## Phase 1 — Complete the loop (all S; one working session)

### 1.1 "Try a sample" button — S
**Buys:** removes the leap of faith for first-time visitors; one click → the show.
**Design:** bundle 2 license-safe portraits in `frontend/public/samples/`
(candidates: the NASA astronaut portrait — public domain, already our test
image — and one CC0 pet or classic-painting portrait). In `UploadPanel`'s
idle state, under the upload button: "…or watch a sample" with 2 thumbnail
chips. Click → `fetch('/samples/x.jpg')` → blob → the existing `onImage`
path. No backend changes.
**Files:** `UploadPanel.jsx`, `public/samples/*`.
**Risks:** none. Verify image licenses before bundling.
**Accept:** cold visitor reaches a live drawing in exactly one click; samples
work offline-ish (same-origin, no third-party fetch).

### 1.2 Export watermark — S
**Buys:** every shared clip/still becomes an acquisition channel.
**Design:** in `useDrawCapture.composite()` — the one function both PNG and
video pass through — draw a small caption after the WebGL layer:
`"drawn & composed at hand-painting.app"` (or the vercel URL until a custom
domain exists), Georgia italic, ~2.2% of canvas height, bottom-right, ~45%
opacity ink-blue. On-screen canvas untouched (watermark exists only in the
composited exports). Skip it in `snapshotPNG` when… no — keep it on both, one
code path, consistent.
**Files:** `useDrawCapture.js`.
**Risks:** none. Keep it subtle; test legibility at 480px GIF scale.
**Accept:** PNG, video, and (later) GIF all carry the caption; drawing screen
does not.

### 1.3 Adaptive draw duration — S
**Buys:** sparse drawings stop dragging, dense ones stop feeling rushed; the
music paces itself naturally (structural — improves everything downstream).
**Design:** backend already returns `pathLength` (normalized units; recent
values ~45–50 for std trace). In `App.handleImage`:
`autoSeconds = clamp(round(pathLength / 1.6), 20, 42)` — 1.6 u/s matches
today's comfortable pace at 30s/47u. Style panel: the Draw-time slider gains
an "Auto" toggle (default ON, new `settings.autoTime`); slider disabled while
auto. Duration passed to `<Scene>` comes from `pathData` when auto.
**Files:** `App.jsx`, `ControlsPanel.jsx`.
**Risks:** interacts with recording length (already duration-agnostic) and
DUET_SPLIT_S (0.5s stroke split — unaffected; stroke durations scale with
total time, so re-tune split to `0.5 * (autoSeconds/30)` if duets skew).
**Accept:** fine-detail sparse image finishes noticeably sooner; dense image
gets more time; manual override still works; E2E timings updated.

---

## Phase 2 — Return visits (M + M)

### 2.1 Gallery wall (localStorage) — M
**Buys:** a collection that accumulates → a reason to come back; social proof
inside the app.
**Design:** on `done`, capture a 256px composite thumbnail (dataURL, ~40KB)
plus `{date, mode, detail, instrument, mood, seconds, strokes}` into
`localStorage["hh-gallery-v1"]` (FIFO cap 24 entries ≈ ~1.5MB, well under
quota; drop oldest on overflow, `try/catch` quota errors). Idle screen gains
a "Gallery" button (top-right) → full-screen overlay: masonry grid of
thumbnails on the paper texture, hover shows date/settings, click → large
view + "Save image" (re-export of stored thumbnail at stored size) + delete.
Full-res stills/videos stay out of scope (quota); if demanded later, move to
IndexedDB (`idb-keyval`, blobs).
**Files:** new `components/GalleryWall.jssx` + `hooks/useGallery.js`;
`App.jsx` (capture on done, overlay state); `UploadPanel.jsx` (button).
**Risks:** localStorage quota (mitigated above); privacy expectation — add a
"clear gallery" button; thumbnails only, nothing leaves the device.
**Accept:** draw → thumbnail appears in gallery; survives reload; cap
enforced; delete + clear work; no quota crashes in E2E (draw 3× and check).

### 2.2 GIF export — M
**Buys:** plays inline in chats/socials where video attachments feel heavy.
**Design:** capture GIF frames from the SAME compositing canvas the video
uses: during recording, every 4th video frame push a 480px-wide
`ctx.getImageData` copy into a ring buffer (~10fps × ≤42s ≈ 420 frames ×
~600KB raw — too much RAM; instead quantize-and-encode incrementally).
Use `gifenc` (tiny, tree-shakeable): a Web Worker owns the encoder; main
thread posts frames (transferable `ImageData.data.buffer`) as they're
captured; worker palettizes (128 colors, one global palette from frame 1)
and appends. On `done` → worker finalizes → blob → "Save GIF ↓" button
beside Save video. Cap: 480px, 10fps, expect 4–10MB for 30s.
**Files:** `useDrawCapture.js` (frame tap), new `workers/gifWorker.js`,
`UploadPanel.jsx` (button), `package.json` (+`gifenc`).
**Risks:** encoder jank (isolated in worker); memory (incremental encode);
color banding on watercolor (test palette from a mid-draw frame instead of
frame 1 if bad). Fallback: hide button if `Worker`/`OffscreenCanvas` absent.
**Accept:** GIF downloads, loops, carries watermark, ≤15MB typical, main
thread stays 60fps during draw (measure with the E2E draw timings).

---

## Phase 3 — Musical depth (M)

### 3.1 Keys & moods — M
**Buys:** re-running the same photo becomes exploration; moody portraits get
moody music.
**Design:** `MOODS` table in `useDrawSound.js`; each mood = melody scale
(semitone offsets), base freq, drone chord, drone/filter color, vibrato
character, piano/violin mix bias:
- **Dawn** (current): C major pentatonic · C2+G2+C3 drone · bright.
- **Dusk**: A minor pentatonic (A C D E G) · A1+E2+A2 drone · lowpass
  darker (2000→1400 cap), deeper vibrato — moody portraits.
- **Sakura**: D hirajoshi (D E♭ G A B♭) · D2+A2 drone · piano-biased duet
  split (0.8s) — spare, koto-like.
- **Hymn**: F Lydian pentatonic subset (F G A C E) · F1+C2+F2 drone · violin-
  biased (0.35s split), slower vibrato — solemn. (Right one for the Jesus meme.)
All scales chosen so ANY degree is consonant over the mood's drone — the
"random strokes can't clash" invariant is non-negotiable; verify each mood by
sounding all scale tones over its drone in an OfflineAudioContext test page.
Style panel: "Mood" row (4 chips). `noteOn`/`startMusic` read
`settingsRef.current.mood`. Tempo note: draw time IS tempo (note density);
adaptive duration (1.3) already ties it to the drawing — no separate control.
**Files:** `useDrawSound.js`, `ControlsPanel.jsx`, `App.jsx` (setting).
**Risks:** a mood whose scale/drone pair isn't fully consonant (the check
above); mid-draw mood switches (apply next run, like detail — simplest).
**Accept:** 4 moods audibly distinct; no dissonant combination possible;
persists like other settings; recorded video carries the chosen mood.

---

## Phase 4 — Spectacle (M · M–L · L, independent of each other)

### 4.1 Ink-bleed shader — M
**Buys:** strokes stop looking vector-crisp; ink feathers into the paper.
**Design:** `InkTrail` already owns a custom ribbon. Add a per-vertex `aCross`
attribute (−1 edge / +1 edge, written exactly where positions are written —
same append-only discipline) and swap `MeshBasicMaterial` for a
`ShaderMaterial`: alpha = smoothstep edge falloff × fbm noise sampled in
world-space (so bleed pattern sticks to the paper, not the stroke), slight
darkening near |cross|≈0.6 (ink pools at the stroke's shoulder), tiny
noise-driven edge displacement in the fragment (no geometry change).
Keep DoubleSide, no depth issues (single mesh at INK_Z). Boldness `weight`
maps to bleed radius too.
**Files:** `InkTrail.jsx` (attribute + material), shader inline.
**Risks:** exports — preserveDrawingBuffer path unchanged, but VERIFY the
composited video shows the bleed identically (E2E screenshot diff); mobile
GPU cost (fbm ≤3 octaves; fall back to basic material via a quality flag if
frame time regresses).
**Accept:** side-by-side screenshot vs current shows organic edges; 60fps
maintained (frame-time log in E2E); exports match screen.

### 4.2 Rigged realistic hand (.glb) — M–L (mostly asset work)
**Buys:** the single biggest "whoa" upgrade; the hand is the performer.
**Design:** the slot already exists (`HandRig.jsx` `USE_GLTF`, documented:
drive skeleton bones from the same S/E/G world positions the IK solve
outputs). Work is: (a) source a CC0/CC-BY rigged arm+hand glb (Quaternius /
Poly Haven / Sketchfab-CC0; verify license allows web bundling, credit in
README), (b) align its rest pose so the pen tip sits at the origin along
−PEN_AXIS (one-time Blender session or transform wrapper group), (c) map
upperarm/forearm/hand bones to S→E, E→G, grip orientation; keep the
procedural arm as instant fallback (`useGLTF` suspense + error boundary).
Budget the asset: ≤2MB draco-compressed, lazy-loaded after first paint.
**Files:** `HandRig.jsx`, `public/models/arm.glb`, README credit.
**Risks:** asset licensing (gate on verification); skin weights looking wrong
at extreme reaches (arm length ×1.06 already keeps bends gentle); +2MB load
(lazy-load, procedural fallback until ready). Don't-regress list applies
(pole vector, PEN_AXIS).
**Accept:** pen tip still EXACTLY on the line (the contract everything else
depends on); no elbow flips across a full std portrait; fallback renders if
the glb 404s; bundle main chunk unchanged (model lazy).

### 4.3 Two-photo duet — L (the flagship; do last, everything feeds it)
**Buys:** a novel shareable format (couples, pet+owner); the musical concept
(two portraits in conversation) is the app's thesis stated twice.
**Design:**
- **Upload:** UploadPanel gains "Duet" tab → two drop slots; both images
  processed by two parallel calls to the EXISTING endpoint (no backend
  change) with detail one notch finer (each panel is half-canvas).
- **Composition:** client transforms each result into its half (left/right,
  aspect-fit with a center gutter), then interleaves strokes round-robin
  (A₁ B₁ A₂ B₂ …, weighted by remaining counts so both finish together),
  concatenating into ONE path + breaks + a per-stroke `panel` array.
  `usePathAnimation` needs zero changes (it's one path with breaks); pen-up
  travel between panels is just a longer hop the lift system already handles.
- **Music:** panel IS the instrument — portrait A bowed, portrait B struck
  (override duet-split). Two melodies interleaving = actual duet. Mood
  applies to both (same key = they harmonize).
- **Hand:** one hand alternating panels reads as "the artist drawing two
  portraits at once" — keep one hand (two mirrored rigs = IK/lighting/
  capture complexity for little gain; revisit only if the single hand tests
  poorly).
- **Export:** nothing changes — capture composites the whole canvas.
**Files:** `UploadPanel.jsx` (duet upload UI), `App.jsx` (dual process +
compose util `lib/composeDuet.js`), `Scene.jsx` (pass per-stroke panel →
noteOn instrument override), `useDrawSound.js` (instrument override arg —
already exists as the `instrument` param).
**Risks:** wall-clock (two ~0.1s trace calls in parallel — negligible);
crowded canvas (half-width panels at 720px source each — acceptable; use
`fine` trace level per panel); duet draws deserve adaptive duration (Phase
1.3 lands first) with a higher cap (~50s); UX complexity (keep single-photo
flow untouched, duet is opt-in).
**Accept:** two photos → side-by-side portraits drawn in alternation,
violin/piano conversation, one video with both + music; single-photo flow
byte-identical to today.

---

## Sequencing summary

| Order | Feature | Effort | Phase gate |
|---|---|---|---|
| 1 | Try-a-sample | S | ship together as "Complete the loop" |
| 2 | Watermark | S | 〃 |
| 3 | Adaptive duration | S | 〃 |
| 4 | Gallery wall | M | ship, then observe return usage |
| 5 | GIF export | M | 〃 |
| 6 | Keys & moods | M | ship as "the music update" |
| 7 | Ink-bleed shader | M | independent; any time after 6 |
| 8 | Rigged hand | M–L | asset sourcing can start anytime (parallel track) |
| 9 | Two-photo duet | L | last — leans on 3 (duration), 6 (moods), 8 (hand) |

Rough calendar at current pace: Phase 1 in one session; Phases 2–3 a session
each; Phase 4 two to three sessions. Every item ships behind the existing
verification pipeline (unit → build → headless E2E with sound → deploy →
prod poll) and gets a CLAUDE.md revision entry + don't-regress notes.

## Cross-cutting guardrails
- Never break the two contracts: **pen tip exactly on the line** and
  **exact-append ink** (no frame-sampled inking).
- Every audio source connects to the **master bus** or the video loses it.
- Keep the single-photo, sound-off, first-visit path as fast as today: new
  assets lazy-load (glb, gifenc worker), nothing new on the critical path.
- localStorage writes always inside try/catch (private-mode quota = 0).
- Each phase updates `CLAUDE.md` history + the project doc mirror.
