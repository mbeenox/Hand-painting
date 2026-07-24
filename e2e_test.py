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
    # then verify the recorded video BLOB really contains an audio track
    # (webm muxes Opus → the init segment contains "OpusHead").
    video_link = page.wait_for_selector("a[download^='hypnotic-hand.']",
                                        timeout=30000)
    has_audio = page.evaluate(
        """async (a) => {
             const buf = await (await fetch(a.href)).arrayBuffer();
             const bytes = new Uint8Array(buf);
             const needle = [0x4F,0x70,0x75,0x73,0x48,0x65,0x61,0x64]; // "OpusHead"
             outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
               for (let j = 0; j < needle.length; j++) {
                 if (bytes[i + j] !== needle[j]) continue outer;
               }
               return true;
             }
             return false;
           }""",
        video_link,
    )
    print("video has audio track (OpusHead found):", has_audio)
    browser.close()

print("console/page errors:", errors if errors else "none")
