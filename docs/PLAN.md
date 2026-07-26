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

### 4.3 Two-photo duet — L — ✅ SHIPPED 2026-07-26
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

**As shipped** (full entry in CLAUDE.md). Deviations worth knowing:
- Strokes interleave in proportional RUNS (~44 gutter crossings), not one at
  a time. Per-stroke alternation was implemented first and measured: the
  composed path length went from ~55 to 388 because the pen was mostly
  flying across the gutter. Runs also read better and make the music trade
  phrases rather than alternate notes.
- Panels are traced one notch COARSER, not finer. The design section said
  finer; the risks section said `fine`. The risks section was right twice
  over — a half-width panel at higher detail reads as mush, and two `dense`
  panels plus a caption overflow the ink buffer.
- The panel is derived from the pen's x via `duet.splitX`, not carried as a
  per-stroke array, so it survives truncation and the caption band with
  nothing to keep in sync.
- The ghost reveal (5.2) gained one plane per panel.

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

---

# Phase 5 — "The gift & the habit" (added 2026-07-24, after Phases 1–3 + 4.1 shipped)

Chosen directions: the writing hand · reveal/replay/friction batch · daily
masterpiece · share pages. Sequenced by magic-per-effort; 4.2 (rigged hand)
and 4.3 (two-photo duet) remain open from Phase 4 and can interleave.

## 5.1 The hand writes — dedications & signature (M) — ✅ SHIPPED 2026-07-25
**Buys:** turns the app into a gift-maker; the pen that drew Mom also writes
"Happy birthday, Mom" — and every letter plays its notes.
**Design:** vendor a public-domain Hershey single-stroke font (futural.jhf,
~20 KB, in repo; JHF parser ~20 lines) → `lib/hershey.js` exposing
`textToStrokes(text, {height, maxWidth})` → normalized polylines + breaks,
same format as backend strokes. Client-side only, no backend change:
`App.handleImage` appends the caption strokes AFTER truncation (a dedication
is always written in full, regardless of Completeness), positioned in a
bottom caption band (y slightly below the drawing region; verify camera
framing tolerates it), scaled ~4.5% board height, capped ~40 chars.
Optional "Sign & date" toggle writes a small `hypnotic hand · <date>`
bottom-right instead/in addition. UI: "Dedication" text field on the idle
screen under the upload buttons (persisted per session, not localStorage —
dedications are per-gift). Music: letters are short strokes → naturally
struck piano; no special-casing.
**Risks:** camera/board framing of the caption band; pathLength grows →
adaptive duration already handles; InkTrail buffer headroom (letters are
few hundred points — fine). Verify JHF licence note in README (public
domain, US Gov).
**Accept:** dedication drawn stroke-by-stroke after the portrait with pen
lifts between letters, plays notes, appears in PNG/video/GIF exports,
respects ink/paper; empty field = today's behaviour byte-identical.

**As shipped** (see CLAUDE.md for the full entry). Deviations worth knowing:
- The caption band is not hung below a fixed board — the drawing's box GROWS
  by the band and the whole composition is re-normalized to a unit long
  side, so the portrait shrinks to ~73–80% of the frame and the camera
  framing takes care of itself. `BOARD_SIZE` (8) is within 0.1% of the
  camera's visible height, so anything hung below it would be off-screen.
- Raw Hershey outlines render with their stems MISSING (straight segments
  carry no curvature → hairline nib; short strokes are all taper). Letters
  go through `handwrite()` — subdivide, jitter, Chaikin ×2, i.e. the same
  treatment `smooth_chains` gives a traced chain. This is the load-bearing
  detail of the feature.
- Character cap is 48 (not 40); the fit ladder shrinks and wraps to 3 lines
  before dropping anything. Signature sits at 3.0% cap height, not smaller —
  the nib width is absolute and small letters clog shut.
- `InkTrail maxPoints` 16000 → 22000 to keep the buffer inequality true.

## 5.2 Reveal, replay & friction batch (S+S+S+S) — ✅ SHIPPED 2026-07-25
- **Ghost reveal:** on done, crossfade the source photo (kept client-side as
  an object URL) at ~12% opacity under the drawing for 2s, then fade out —
  "look what it caught". Captured in the video (it happens inside the
  recording window before the 2.6s stop).
- **Instant replay:** button on done → re-run the SAME pathData/timetable at
  4× speed (no backend call, no new randomness). Recording not re-armed.
- **Redraw:** keep the last uploaded blob in a ref; "Redraw ↻" on done runs
  the FULL pipeline again → new strokes, new melody (the app's thesis in
  one click).
- **Drag & drop:** dropzone on the idle overlay → existing onImage path.
**Accept:** all four work on desktop+mobile; ghost reveal visible in saved
video; replay does not add gallery entries or restart recording.

**As shipped** (full entry in CLAUDE.md). Deviations worth knowing:
- The ghost is a textured plane INSIDE the R3F scene, not a DOM crossfade.
  That is what makes it register with the drawing (it uses the same
  normalized→world mapping, so it also tracks the shrunken rect a 5.1
  caption leaves) and what puts it in the video/GIF for free.
- 12% opacity was invisible in practice — a photo over pale paper only
  registers where it is dark. Shipped at 26%.
- Replay is implemented by remounting the Canvas (`replayId` in its key),
  which is the only way to reset InkTrail's append-only buffer. `phase`
  deliberately stays `'done'` so nothing re-records or re-saves.
- Drag & drop needed window-level preventDefault to stop a stray drop
  navigating the browser away mid-draw — the non-obvious half of the item.

## 5.3 Daily masterpiece (M) — ✅ SHIPPED 2026-07-25
**Buys:** a shared daily prompt and a reason to return; zero content risk.
**Design:** The Met Open Access API (CC0): pick deterministically by date
(seeded from YYYY-MM-DD) from a curated object-ID list (~200 paintings with
`primaryImageSmall`, portrait-ish, pre-vetted once and committed as JSON).
Idle screen: "Today's masterpiece" chip with thumbnail → fetch image →
existing onImage path. Cache the day's pick in localStorage. CORS: Met
images allow cross-origin fetch; if a fetch fails, chip hides (never blocks
the core flow). Credit line shown per Met guidelines.
**Accept:** same artwork offered to everyone on a given date; one click →
drawing; offline/API-down degrades to hiding the chip.

**As shipped** (full entry in CLAUDE.md). Deviations worth knowing:
- **Images come from Wikimedia Commons, not the Met's API.**
  `images.metmuseum.org` sends NO `Access-Control-Allow-Origin` — the plan's
  central assumption was wrong. That blocks `fetch().blob()` outright, and an
  image from there would TAINT the WebGL canvas via the 5.2 ghost reveal,
  making `toDataURL`/`captureStream` throw and breaking every export. The Met
  donated its Open Access collection to Commons, which serves
  `Access-Control-Allow-Origin: *`, so the same artworks arrive from a usable
  host with no backend proxy.
- The pick is a coprime STRIDE over the list, not a date hash: a hash has a
  1-in-200 chance of repeating yesterday's artwork; a stride guarantees a
  full cycle before any repeat.
- Curation scores candidates through the app's own trace pipeline, not on
  metadata. Three separate classes of bad pick (picture frames, oval-mounted
  miniatures, undescribed decorative objects) were only visible by RENDERING
  the picks — each drove a new filter. Regenerating the list without looking
  at a few days' output is how they come back.

## 5.4 Share pages (L) — LAST, the infrastructure step
**Buys:** results get URLs; the watermark finally has somewhere to point.
**Design sketch (decisions needed before build):** Vercel Blob for the
composited mp4/webm + still; `/api/share` POST (size-capped ~15 MB,
rate-limited) returns a short ID; `/s/[id]` page (static shell + fetch)
with OG tags (still as og:image, video as og:video). Retention: 30 days
default. Moderation stance: uploads are user-initiated shares of their own
drawings (line art, not photos — the source photo NEVER leaves the device;
only the abstracted drawing is shared) + report-and-remove email address +
per-IP rate limit. OPEN DECISIONS for the owner: retention window, whether
sharing requires a confirm dialog explaining what's uploaded, custom domain
first? Build only after 5.1–5.3.
**Risks:** hosting user content (mitigated: drawings are abstractions, not
photos); storage cost (Blob free tier, 30-day retention); link rot vs
retention trade-off.

Guardrails: everything client-side stays quota-safe; nothing new on the
first-paint critical path (Hershey font + Met JSON lazy); every feature gets
the standard verify pipeline + CLAUDE.md entry.
