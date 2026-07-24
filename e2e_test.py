"""Headless E2E: upload test image through the real UI, screenshot the drawing."""
import time
from playwright.sync_api import sync_playwright

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto("http://localhost:5173", wait_until="networkidle")
    page.screenshot(path="e2e_1_idle.png")

    # Enable sound (inside a real click gesture) so the stroke-violin path
    # (AudioContext, drone, note on/off per stroke) is exercised too.
    page.click("button[aria-label='Enable sound']")

    page.set_input_files("input[type=file]", "backend/test_input.png")
    # wait for processing → drawing (overlay disappears)
    page.wait_for_selector("h1", state="detached", timeout=30000)
    time.sleep(3)
    page.screenshot(path="e2e_2_drawing_3s.png")
    time.sleep(8)
    page.screenshot(path="e2e_3_drawing_11s.png")
    time.sleep(13)
    page.screenshot(path="e2e_4_done.png")

    # Wait out the rest of the 30s draw + the 2.6s post-done capture stop,
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
    browser.close()

print("console/page errors:", errors if errors else "none")
