/**
 * gifWorker — incremental GIF encoding off the main thread (Feature 2.2).
 *
 * The main thread taps ~10fps 480px RGBA frames from the SAME compositing
 * canvas the video recording uses (so the GIF shows exactly what the video
 * shows, watermark included) and posts each frame's buffer here as a
 * transferable. We palettize and append immediately — no frame ring buffer,
 * so memory stays flat no matter how long the draw runs.
 *
 * Palette strategy: quantize ONCE from the first frame (128 colours) and
 * reuse it for every frame. The scene is paper + pastel splashes + dark ink —
 * chromatically stable from the first composite (paper + splashes are laid
 * down before the pen moves), so a global palette holds up and keeps both
 * encoding cost and file size down. (If banding ever shows up, re-quantize
 * from a mid-draw frame instead — noted in docs/PLAN.md.)
 *
 * Protocol (all messages {type, ...}):
 *   in : {type:'init', width, height, delayMs}
 *   in : {type:'frame', buffer}            // ArrayBuffer of RGBA bytes
 *   in : {type:'finish'}
 *   out: {type:'done', buffer}             // ArrayBuffer of the .gif bytes
 *   out: {type:'error', message}
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

let gif = null;
let palette = null;
let width = 0;
let height = 0;
let delayMs = 100;
let frames = 0;

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      gif = GIFEncoder();
      palette = null;
      width = msg.width;
      height = msg.height;
      delayMs = msg.delayMs ?? 100;
      frames = 0;
    } else if (msg.type === 'frame' && gif) {
      const rgba = new Uint8ClampedArray(msg.buffer);
      if (!palette) palette = quantize(rgba, 128);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, width, height, {
        palette,
        delay: delayMs,
        repeat: frames === 0 ? 0 : undefined, // loop forever (set on first frame)
      });
      frames += 1;
    } else if (msg.type === 'finish' && gif) {
      if (frames === 0) {
        self.postMessage({ type: 'error', message: 'no frames captured' });
      } else {
        gif.finish();
        const bytes = gif.bytes(); // Uint8Array view over the encoder buffer
        const copy = bytes.slice().buffer; // detachable copy for transfer
        self.postMessage({ type: 'done', buffer: copy, frames }, [copy]);
      }
      gif = null;
      palette = null;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
    gif = null;
    palette = null;
  }
};
