"""Screenshot the armdev harness at each audit pose. Needs vite on 5173."""
import sys
from playwright.sync_api import sync_playwright

positions = sys.argv[1:] or ["0", "1", "2", "3", "4"]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1100, "height": 800})
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    for i in positions:
        page.goto(f"http://localhost:5173/armdev.html?pos={i}")
        page.wait_for_function("window.__armReady === true", timeout=15000)
        page.screenshot(path=f"/tmp/arm_pos{i}.png")
        print(f"shot /tmp/arm_pos{i}.png")
    if errs:
        print("CONSOLE ERRORS:", errs)
        sys.exit(1)
    browser.close()
