/**
 * PolaroidCamera.js (WP7)
 * Takes the photo for the polaroid without stalling the frame.
 *
 * `capture()` runs right after the main render, in the same task (so the
 * drawing buffer is valid without preserveDrawingBuffer): one readPixels of
 * a centred square (80% of the short side) into a pixel-pack buffer, queued behind the render on the
 * GPU, plus a fence. `poll()` checks the fence on later frames and, once the
 * GPU is there, copies the pixels out, box-filters and flips them on the CPU
 * into a 240 px canvas. `encode()` makes a small WebP (JPEG where WebP
 * encoding is missing) data URL.
 *
 * It reads the main frame instead of rendering into a WebGLRenderTarget: a
 * render target turns off tone mapping and the sRGB output, which would
 * compile new variants of every program mid-reveal and give a flat, dark
 * photo. No extra render pass, and the photo matches what the kid saw. A
 * blocking readPixels would wait for every queued frame (over a second on
 * software GL); the fence keeps the capture frame cheap. This is the one
 * readback in the game.
 */
const SIZE = 240;

export class PolaroidCamera {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.img = this.ctx.createImageData(SIZE, SIZE);
    this.buf = null;
    this.pbo = null;
    this.sync = null;
    this.gl = null;
  }

  /** Queue the readback of the frame rendered in this task. Returns false on failure. */
  capture(renderer) {
    try {
      const gl = (this.gl = renderer.getContext());
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const s = (this.s = Math.floor(Math.min(w, h) * 0.8));
      if (!this.buf || this.buf.length < s * s * 4) this.buf = new Uint8Array(s * s * 4);
      if (!this.pbo) this.pbo = gl.createBuffer();
      renderer.setRenderTarget(null);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, s * s * 4, gl.STREAM_READ);
      gl.readPixels((w - s) >> 1, (h - s) >> 1, s, s, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (this.sync) gl.deleteSync(this.sync);
      this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return !!this.sync;
    } catch (err) {
      this.sync = null;
      return false;
    }
  }

  /**
   * 1: the photo is in the canvas; 0: not yet; -1: failed. `force` reads now
   * even if the GPU is still busy (a stall; only for a skipped reveal).
   */
  poll(force = false) {
    const gl = this.gl;
    if (!this.sync || !gl) return -1;
    try {
      const st = gl.clientWaitSync(this.sync, 0, 0);
      if (st === gl.WAIT_FAILED || gl.isContextLost()) throw new Error('lost');
      if (st === gl.TIMEOUT_EXPIRED && !force) return 0;
      gl.deleteSync(this.sync);
      this.sync = null;
      const s = this.s;
      const src = this.buf;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, src, 0, s * s * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const d = this.img.data;
      const k = s / SIZE;
      const row = s * 4;
      for (let y = 0; y < SIZE; y++) {
        const sy = Math.min(s - 2, Math.floor((SIZE - 1 - y + 0.25) * k)); // GL rows run bottom-up
        for (let x = 0; x < SIZE; x++) {
          const i = sy * row + Math.min(s - 2, Math.floor((x + 0.25) * k)) * 4;
          const j = (y * SIZE + x) * 4;
          const r = (src[i] + src[i + 4] + src[i + row] + src[i + row + 4]) * 0.25;
          const g = (src[i + 1] + src[i + 5] + src[i + row + 1] + src[i + row + 5]) * 0.25;
          const b = (src[i + 2] + src[i + 6] + src[i + row + 2] + src[i + row + 6]) * 0.25;
          const l = 0.3 * r + 0.59 * g + 0.11 * b; // a touch of photo punch: +12% saturation
          d[j] = l + (r - l) * 1.12;
          d[j + 1] = l + (g - l) * 1.12;
          d[j + 2] = l + (b - l) * 1.12;
          d[j + 3] = 255;
        }
      }
      this.ctx.putImageData(this.img, 0, 0);
      return 1;
    } catch (err) {
      this.sync = null;
      return -1;
    }
  }

  /** The photo as a small data URL ('' on failure). */
  encode() {
    try {
      let url = this.canvas.toDataURL('image/webp', 0.74);
      if (url.indexOf('data:image/webp') !== 0) url = this.canvas.toDataURL('image/jpeg', 0.78);
      return url;
    } catch (err) {
      return '';
    }
  }
}
