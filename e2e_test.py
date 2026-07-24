"""Headless E2E: upload test image through the real UI, screenshot the drawing."""
import time
from playwright.sync_api import sync_playwright

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800},
                            accept_downloads=True)
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
    page.click("text=⚙ Style")  # close the panel again

    page.set_input_files("input[type=file]", "backend/test_input.png")
    # wait for processing → drawing (overlay disappears)
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(3)
    page.screenshot(path="e2e_2_drawing_3s.png")
    time.sleep(8)
    page.screenshot(path="e2e_3_drawing_11s.png")
    # Adaptive duration (Feature 1.3): the synthetic test image's std-trace
    # pathLength ≈ 52u → auto ≈ 33s (was a fixed 30s).
    time.sleep(24)
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
    page.click("text=⚙ Style")

    # Feature 2.1: the finished drawing landed on the gallery wall.
    stored = page.evaluate(
        "() => JSON.parse(localStorage.getItem('hh-gallery-v1') || '[]')"
    )
    assert len(stored) == 1, f"expected 1 gallery entry, found {len(stored)}"
    assert stored[0]["thumb"].startswith("data:image/jpeg"), "thumbnail malformed"
    assert stored[0]["meta"]["strokes"] > 0, "gallery meta missing strokes"
    page.click("button[aria-label='Open gallery']")
    page.wait_for_selector("h2:has-text('Gallery')", timeout=5000)
    page.screenshot(path="e2e_6_gallery.png")
    page.click("button[aria-label='Close gallery']")
    page.wait_for_selector("h2", state="detached", timeout=5000)
    page.click("button[aria-label^='Draw sample']")
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(3)
    page.screenshot(path="e2e_5_sample_drawing.png")

    browser.close()

print("console/page errors:", errors if errors else "none")
