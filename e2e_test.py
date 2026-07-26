"""Headless E2E: upload test image through the real UI, screenshot the drawing."""
import time
from playwright.sync_api import sync_playwright

errors = []
DEDICATION = "Happy birthday, Mom"

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={"width": 1280, "height": 800},
                                  accept_downloads=True,
                                  permissions=["camera"])
    # Mock camera: this Chromium build registers no fake devices, so feed
    # getUserMedia a canvas stream of the ASTRONAUT sample — which also
    # exercises REAL face detection on the snap (focus=face end-to-end).
    # Two fake videoinputs → the Flip button must appear.
    context.add_init_script("""
      navigator.mediaDevices.getUserMedia = async () => {
        const img = new Image();
        img.src = '/samples/astronaut.jpg';
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        setInterval(() => ctx.drawImage(img, 0, 0), 100);
        return cv.captureStream(10);
      };
      navigator.mediaDevices.enumerateDevices = async () => [
        {kind: 'videoinput', deviceId: 'front', label: 'Front'},
        {kind: 'videoinput', deviceId: 'back', label: 'Back'},
      ];
    """)
    # Feature 5.3: the artwork host is unreachable from this sandbox, so stub
    # it at the CONTEXT level before any navigation — the chip's <img> loads
    # on the first idle render and again after every goto/reload.
    context.route("**/upload.wikimedia.org/**", lambda route: route.fulfill(
        path="frontend/public/samples/pearl.jpg", content_type="image/jpeg",
        headers={"access-control-allow-origin": "*"}))

    page = context.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto("http://localhost:5173", wait_until="networkidle")
    page.screenshot(path="e2e_1_idle.png")

    # Feature 1.1: the idle screen offers the bundled sample chips.
    chips = page.query_selector_all("button[aria-label^='Draw sample']")
    assert len(chips) == 2, f"expected 2 sample chips, found {len(chips)}"

    # Sound is ON by default now — the toggle must already read "Mute".
    assert page.query_selector("button[aria-label='Mute sound']"), \
        "sound should be ON by default"

    # --- Feature 5.3 "Today's masterpiece". The artwork itself lives on
    # Wikimedia, which this sandbox's headless Chromium cannot reach, so the
    # image request is STUBBED with a bundled sample. That is the right seam
    # anyway: what needs testing is our chip → fetch → blob → onImage path,
    # not Wikimedia's uptime. (Wikimedia's CORS headers were verified
    # separately against the live host — see scripts/curate_masterpieces.py.)
    chip = page.wait_for_selector("button[aria-label^=\"Draw today's masterpiece\"]",
                                  timeout=10000)
    credit = chip.get_attribute("aria-label")
    assert len(credit) > 34, f"masterpiece chip has no credit line: {credit!r}"
    assert chip.query_selector("img[src^='https://upload.wikimedia.org/']"), \
        "chip thumbnail must come from the CORS-capable host"
    # The same date must always yield the same work — that is the whole point.
    pick_a = page.evaluate("() => localStorage.getItem('hh-masterpiece-v1')")
    page.reload(wait_until="networkidle")
    pick_b = page.evaluate("() => localStorage.getItem('hh-masterpiece-v1')")
    assert pick_a and pick_a == pick_b, "today's pick is not stable across loads"
    print("masterpiece:", credit[:78])
    page.click("button[aria-label^=\"Draw today's masterpiece\"]")
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(2)
    page.screenshot(path="e2e_10_masterpiece.png")
    page.goto("http://localhost:5173", wait_until="networkidle")  # reset for the camera flow

    # --- Camera flow (mocked device): open camera → Flip must appear (two
    # cameras enumerated) and work → Snap must send focus=face, the backend
    # must actually FIND the astronaut's face, and a live drawing follows.
    page.click("text=Use camera")
    page.wait_for_selector("video", timeout=10000)
    time.sleep(1)  # let the mock stream produce frames
    flip = page.wait_for_selector("button[aria-label^='Switch to']", timeout=5000)
    flip.click()  # front → back (mock just returns a new stream)
    time.sleep(0.5)
    with page.expect_response(lambda r: "process-image" in r.url,
                              timeout=30000) as resp_info:
        page.click("text=Snap 📸")
    resp = resp_info.value
    assert "focus=face" in resp.url, f"snap did not request face focus: {resp.url}"
    body = resp.json()
    assert body.get("facesFocused") == 1, \
        f"backend should focus exactly 1 face, got {body.get('facesFocused')}"
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(2)
    page.screenshot(path="e2e_0_camera_draw.png")
    # Fresh page for the main flow (the camera draw would otherwise run on).
    page.goto("http://localhost:5173", wait_until="networkidle")

    # Feature 3.1: draw in a NON-default mood so the mood-parameterized
    # drone/scale/chime paths run (Dusk = A minor pentatonic, darker bow).
    # These REAL clicks also provide the user activation that lets the
    # on-by-default AudioContext resume when the draw starts.
    page.click("text=⚙ Style")
    # Pen scratch must default to Off (v2 settings migration).
    scratch_off = page.evaluate(
        """() => JSON.parse(localStorage.getItem('hh-settings-v1') || '{}')"""
    )
    assert scratch_off.get("scratch") is not True, "scratch should default off"
    page.click("button:has-text('Dusk')")
    # Completeness dial present, default 100%.
    comp = page.query_selector("input[aria-label='Completeness']")
    assert comp, "Completeness slider missing"
    assert float(comp.get_attribute("value") or 0) == 1.0, "default must be 100%"
    page.click("text=⚙ Style")  # close the panel again

    # --- Feature 5.1 "the hand writes": type a dedication + ask for the
    # signature, then verify the vendored Hershey font is fetched as its OWN
    # lazy chunk (the "nothing new on the critical path" guardrail) rather
    # than shipped in the main bundle.
    font_reqs = []
    page.on("request", lambda r: font_reqs.append(r.url)
            if "futural" in r.url or "hershey" in r.url.lower() else None)
    ded_input = page.wait_for_selector("input[aria-label^='Dedication']",
                                       timeout=5000)
    assert int(ded_input.get_attribute("maxlength")) == 48, "dedication cap changed"
    ded_input.fill(DEDICATION)
    page.check("input[aria-label='Sign and date the drawing']")
    signed = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-settings-v1') || '{}')"
    )
    assert signed.get("signDate") is True, "Sign & date should persist to settings"

    page.set_input_files("input[type=file]", "backend/test_input.png")
    # wait for processing → drawing (overlay disappears)
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(3)
    page.screenshot(path="e2e_2_drawing_3s.png")
    time.sleep(8)
    page.screenshot(path="e2e_3_drawing_11s.png")

    # Adaptive duration (Feature 1.3) makes the length depend on the path, and
    # the written caption (5.1) lengthens it further — so wait for the done
    # bar rather than sleeping a guessed number of seconds.
    page.wait_for_selector("text=Draw another ↺", timeout=120000)

    # --- Feature 5.2 "Ghost reveal": the source photo breathes in under the
    # finished ink and fades out again, all inside the 2.6s capture tail.
    #
    # Sampled IN THE PAGE rather than with page.screenshot(): a screenshot is
    # a CDP round trip plus a 1280x800 PNG encode, which repeatedly took long
    # enough to land after the ~2s reveal had already finished — the test
    # missed a feature that was working. This reads the WebGL canvas every
    # 80ms into an 80x50 scratch canvas and tracks MEAN ALPHA, which is the
    # right signal twice over: it is cheap, and it measures the very buffer
    # `useDrawCapture` composites, so a pass means the reveal is in the saved
    # video and GIF too.
    alpha = page.evaluate("""async () => {
      const gl = document.querySelector('canvas');
      const s = document.createElement('canvas'); s.width = 80; s.height = 50;
      const ctx = s.getContext('2d', { willReadFrequently: true });
      const sample = () => {
        ctx.clearRect(0, 0, 80, 50);
        ctx.drawImage(gl, 0, 0, 80, 50);
        const d = ctx.getImageData(0, 0, 80, 50).data;
        let a = 0;
        for (let i = 3; i < d.length; i += 4) a += d[i];
        return a / (80 * 50);
      };
      const out = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 3600) {
        out.push([Math.round(performance.now() - t0), Math.round(sample() * 10) / 10]);
        await new Promise((r) => setTimeout(r, 80));
      }
      return out;
    }""")
    vals = [a for _, a in alpha]
    settled = sum(vals[-6:]) / 6           # ink only, reveal finished
    print(f"ghost alpha: peak {max(vals):.1f} → settled {settled:.1f} "
          f"({len(alpha)} samples over 3.6s)")
    assert max(vals) > settled * 1.25, \
        f"no ghost reveal in the captured canvas: peak {max(vals)} vs {settled}"
    # …and gone again before useDrawCapture grabs the clean still at 2.6s.
    # A reveal that outlived its window would be baked into every saved PNG.
    late = [a for t, a in alpha if t >= 2400]
    assert late and max(late) <= settled * 1.05, \
        f"ghost still showing at 2.4s — it would contaminate the still: {late[:4]}"
    page.screenshot(path="e2e_4_done.png")

    # Wait out the rest of the ~33s draw + the 2.6s post-done capture stop,
    # then verify the recorded video BLOB really contains an audio track:
    # mp4 (preferred — iPhone-safe H.264+AAC) muxes an "mp4a" sample entry;
    # webm (fallback) muxes Opus → an "OpusHead" init segment.
    video_link = page.wait_for_selector("a[download^='hypnotic-hand.']",
                                        timeout=30000)
    result = page.evaluate(
        """async (a) => {
             const buf = await (await fetch(a.href)).arrayBuffer();
             const bytes = new Uint8Array(buf);
             const find = (s) => {
               const n = Array.from(s, (c) => c.charCodeAt(0));
               outer: for (let i = 0; i <= bytes.length - n.length; i++) {
                 for (let j = 0; j < n.length; j++) {
                   if (bytes[i + j] !== n[j]) continue outer;
                 }
                 return true;
               }
               return false;
             };
             const ext = a.download.split('.').pop();
             // mp4: AAC sample entry "mp4a" (or "Opus" if a codec-less build
             // ever lands there); webm: "OpusHead" init segment.
             const audio = ext === 'mp4'
               ? (find('mp4a') || find('Opus'))
               : find('OpusHead');
             return { ext, audio, bytes: bytes.length };
           }""",
        video_link,
    )
    print("saved video:", result)
    assert result["audio"], "recorded video is missing its audio track!"

    # Feature 1.2: the exported still carries the watermark caption
    # (bottom-right, ink-blue @45% over paper → a bluish mid-tone that neither
    # the near-black ink strokes nor the pastel splash produce there).
    with page.expect_download() as dl_info:
        page.click("text=Save image ↓")
    dl_info.value.save_as("e2e_export.png")
    from PIL import Image
    im = Image.open("e2e_export.png").convert("RGB")
    w, h = im.size
    box = im.crop((int(w * 0.55), int(h * 0.94), w, h))
    wm_px = sum(
        1 for r, g, b in box.getdata()
        if 110 <= r <= 190 and 120 <= g <= 200 and 140 <= b <= 210 and b > r
    )
    print("watermark-ish pixels in bottom-right box:", wm_px)
    assert wm_px > 40, "export watermark not found in the saved PNG!"

    # Feature 5.1: the writing is IN the export, in its own band under the
    # portrait — dark ink across the middle of the bottom strip, where a
    # caption-less run leaves bare paper. (The band clears the watermark, so
    # the assertion above still passes: they must not fight for that corner.)
    ink = im.crop((int(w * 0.18), int(h * 0.83), int(w * 0.82), int(h * 0.97)))
    ink_px = sum(1 for r, g, b in ink.getdata() if r < 90 and g < 90 and b < 110)
    print("caption ink pixels in the writing band:", ink_px)
    assert ink_px > 300, "the hand did not write the dedication into the export!"
    # …and it arrived as a SEPARATE request made only once the user showed
    # intent, not baked into the entry bundle. (Dev serves the raw .jhf;
    # `npm run build` emits it as its own `futural-*.js` chunk — both are a
    # deferred fetch, which is the guardrail that matters.)
    assert font_reqs, "Hershey font was never fetched — is it still lazy?"
    assert len(set(font_reqs)) == 1, f"font fetched more than once: {font_reqs}"
    print("hershey font chunk:", font_reqs[0].rsplit("/", 1)[-1])

    # Feature 2.2: the GIF finishes encoding right after the recorder stops —
    # its Save button must appear, and the blob must be a real looping GIF.
    gif_link = page.wait_for_selector("a[download='hypnotic-hand.gif']",
                                      timeout=15000)
    gif_info = page.evaluate(
        """async (a) => {
             const buf = await (await fetch(a.href)).arrayBuffer();
             const b = new Uint8Array(buf);
             const head = String.fromCharCode(...b.slice(0, 6));
             // NETSCAPE2.0 app extension = looping GIF
             const s = 'NETSCAPE2.0';
             let loops = false;
             outer: for (let i = 0; i <= b.length - s.length; i++) {
               for (let j = 0; j < s.length; j++) {
                 if (b[i + j] !== s.charCodeAt(j)) continue outer;
               }
               loops = true; break;
             }
             return { head, loops, bytes: b.length };
           }""",
        gif_link,
    )
    print("saved gif:", gif_info)
    assert gif_info["head"] == "GIF89a", f"not a GIF: {gif_info['head']!r}"
    assert gif_info["loops"], "GIF is missing its loop extension"
    assert gif_info["bytes"] > 100_000, "GIF suspiciously small"

    # --- Feature 5.2 "Instant replay": the SAME path at 4x. It must not
    # re-arm the recorder or clobber the video/GIF that were already made,
    # and it must not add a second gallery entry for one drawing.
    gallery_before = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-gallery-v1') || '[]').length"
    )
    video_href_before = page.get_attribute("a[download^='hypnotic-hand.']", "href")
    t_replay = time.time()
    page.click("text=Replay ⏩")
    page.wait_for_selector("text=Replaying…", timeout=5000)
    page.wait_for_selector("text=Replay ⏩", timeout=40000)  # finished
    replay_s = time.time() - t_replay
    print(f"replay took {replay_s:.1f}s (full draw was ~33s)")
    assert replay_s < 20, f"replay should be ~4x faster, took {replay_s:.1f}s"
    assert page.get_attribute("a[download^='hypnotic-hand.']", "href") == video_href_before, \
        "replay re-recorded the video!"
    assert page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-gallery-v1') || '[]').length"
    ) == gallery_before, "replay added a spurious gallery entry"
    page.screenshot(path="e2e_7_after_replay.png")

    # Feature 1.1 end-to-end: draw another → one click on a sample chip must
    # reach a live drawing (no upload dialog involved).
    page.click("text=Draw another ↺")
    page.wait_for_selector("button[aria-label^='Draw sample']", timeout=10000)

    # Paper stocks: switch to Noir — the ink must auto-switch to the paper's
    # house ink (chalk white), because the previous dark ink would sink into
    # the black ground. The sample draw below then runs white-on-black.
    page.click("text=⚙ Style")
    page.click("div[aria-label='Noir paper']")
    st = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-settings-v1') || '{}')"
    )
    assert st.get("paper") == "noir", f"paper not switched: {st.get('paper')}"
    assert st.get("inkColor") == "#f2ede3", \
        f"ink should auto-switch to chalk on noir, got {st.get('inkColor')}"
    # Set Completeness to 50% (React-controlled range → native setter + event);
    # the sample draw below runs as a half-finished chalk sketch.
    page.evaluate("""() => {
      const el = document.querySelector("input[aria-label='Completeness']");
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      set.call(el, '0.5');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }""")
    st = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-settings-v1') || '{}')"
    )
    assert st.get("completeness") == 0.5, \
        f"completeness not persisted: {st.get('completeness')}"
    page.click("text=⚙ Style")

    # Feature 2.1: the finished drawing landed on the gallery wall.
    stored = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-gallery-v1') || '[]')"
    )
    assert len(stored) == 1, f"expected 1 gallery entry, found {len(stored)}"
    assert stored[0]["thumb"].startswith("data:image/jpeg"), "thumbnail malformed"
    assert stored[0]["meta"]["strokes"] > 0, "gallery meta missing strokes"
    # Feature 5.1: the caption really made it into the drawn path — the hand
    # wrote it, so the finished piece is filed on the wall as a gift.
    assert stored[0]["meta"].get("dedication") == DEDICATION, \
        f"gallery meta lost the dedication: {stored[0]['meta'].get('dedication')!r}"
    page.click("button[aria-label='Open gallery']")
    page.wait_for_selector("h2:has-text('Gallery')", timeout=5000)
    page.screenshot(path="e2e_6_gallery.png")
    page.click("button[aria-label='Close gallery']")
    page.wait_for_selector("h2", state="detached", timeout=5000)
    page.click("button[aria-label^='Draw sample']")
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(3)
    page.screenshot(path="e2e_5_sample_drawing.png")

    # --- Feature 5.2 "Drag & drop" + "Redraw", run last so the gallery
    # assertions above still see exactly one entry per drawing.
    page.wait_for_selector("text=Draw another \u21ba", timeout=90000)
    page.click("text=Draw another \u21ba")
    page.wait_for_selector("button[aria-label^='Draw sample']", timeout=10000)

    # A photo dropped on the idle overlay goes through the same onImage path
    # as an upload. Playwright has no real drag source, so build a
    # DataTransfer from the bundled sample and dispatch what a browser would.
    page.evaluate("""async () => {
      const blob = await (await fetch('/samples/astronaut.jpg')).blob();
      const file = new File([blob], 'dropped.jpg', { type: 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = document.querySelector('h1').parentElement;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true }));
      }
    }""")
    page.wait_for_selector("h1", state="detached", timeout=30000)
    print("drag & drop reached a drawing")
    time.sleep(2)
    page.screenshot(path="e2e_8_dropped.png")
    page.wait_for_selector("text=Draw another \u21ba", timeout=120000)

    # Redraw: the SAME photo through the WHOLE pipeline again — it must hit
    # the backend (that is what makes it a new drawing, not a replay).
    with page.expect_response(lambda r: "process-image" in r.url,
                              timeout=30000) as redraw_resp:
        page.click("text=Redraw \u21bb")
    assert redraw_resp.value.ok, "redraw did not re-run the pipeline"
    page.wait_for_selector("h1", state="detached", timeout=30000)
    print("redraw re-ran the backend and started a fresh drawing")
    time.sleep(2)
    page.screenshot(path="e2e_9_redraw.png")

    browser.close()

print("console/page errors:", errors if errors else "none")
