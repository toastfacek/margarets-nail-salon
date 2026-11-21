/**
 * FrameLoop.js
 * The only requestAnimationFrame in the app.
 *
 * - Ordered callbacks: `add(fn, order, { render })`. Lower order runs first.
 *   Convention: scene/camera (5), input + brush (10), features (50),
 *   main render (90).
 * - dt is computed once per frame (seconds, clamped) and passed to every
 *   callback as `fn(dt, time, loop)`.
 * - Render-on-demand: when `quality.settings.renderOnDemand` is on and the
 *   page was not opened with `?perf=1`, callbacks marked `render` are skipped
 *   unless something called `invalidate()` this frame. A forced render runs
 *   at least every 250 ms as a safety net, so a missed invalidate never shows
 *   a stale frame for long.
 * - Feeds every rendered frame's delta to `quality.sample(ms)`.
 * - `pause()` / `resume()` stop and restart everything (future ad breaks).
 */

const MAX_DT = 0.1;          // seconds; clamp so physics never explodes after a hitch
const SAFETY_RENDER_MS = 250;

export class FrameLoop {
  constructor({ quality = null, perf = false } = {}) {
    this.quality = quality;
    this.perf = perf;

    this._entries = [];      // copy-on-write array of { fn, order, render, seq }
    this._seq = 0;

    this.dt = 0;             // seconds, clamped
    this.time = 0;           // ms, rAF timestamp
    this.frame = 0;
    this.paused = false;
    this.renderedThisFrame = false;

    this._dirty = true;
    this._lastTime = -1;
    this._lastRenderTime = -Infinity;
    this._prevFrameRendered = false;
    this._prevPrevFrameRendered = false;
    this._rafId = 0;
    this._running = false;

    this._tick = this._tick.bind(this);
  }

  /**
   * Register a per-frame callback. Returns `fn` so it can be removed later.
   * @param {(dt:number, time:number, loop:FrameLoop) => void} fn
   * @param {number} order
   * @param {{render?: boolean}} [opts]
   */
  add(fn, order = 50, opts = null) {
    if (typeof fn !== 'function') return fn;
    this.remove(fn);
    const entry = { fn, order, render: !!(opts && opts.render), seq: this._seq++ };
    const next = this._entries.slice();
    next.push(entry);
    next.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    this._entries = next;
    return fn;
  }

  remove(fn) {
    const list = this._entries;
    for (let i = 0; i < list.length; i++) {
      if (list[i].fn === fn) {
        const next = list.slice();
        next.splice(i, 1);
        this._entries = next;
        return;
      }
    }
  }

  /** Ask for the render callbacks to run on the next frame. */
  invalidate() {
    this._dirty = true;
  }

  /** True when render callbacks are skipped while nothing is dirty. */
  get onDemand() {
    return !this.perf && !!(this.quality && this.quality.settings && this.quality.settings.renderOnDemand);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = -1;
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._lastTime = -1; // do not feed the paused gap into dt
    this._dirty = true;
  }

  _tick(time) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._tick);

    if (this.paused) {
      this._lastTime = -1;
      return;
    }

    const rawMs = this._lastTime < 0 ? 16.7 : time - this._lastTime;
    this._lastTime = time;
    this.time = time;
    this.frame++;
    let dt = rawMs / 1000;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;
    this.dt = dt;

    // The interval that ends now measures the frame before it. Only sample
    // when the two previous frames both rendered: an isolated render between
    // skipped frames (render-on-demand safety net) reports one vsync while its
    // real cost is hidden, which would read as "fast" (and on 120 Hz screens
    // could falsely promote medium to high).
    if (this._prevFrameRendered && this._prevPrevFrameRendered && this.quality) this.quality.sample(rawMs);

    const doRender = !this.onDemand || this._dirty || (time - this._lastRenderTime) >= SAFETY_RENDER_MS;
    // Clear before running callbacks so anything they invalidate lands on the next frame
    // (updates run before render in the same frame, so their changes are drawn now).
    const entries = this._entries;
    let decided = false;
    let renderNow = false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.render) {
        if (!decided) {
          decided = true;
          renderNow = doRender || this._dirty;
          if (renderNow) {
            this._dirty = false;
            this._lastRenderTime = time;
            this.renderedThisFrame = true;
          }
        }
        if (!renderNow) continue;
      }
      try {
        e.fn(dt, time, this);
      } catch (err) {
        console.error('[loop] frame callback failed', err);
      }
    }
    this._prevPrevFrameRendered = this._prevFrameRendered;
    this._prevFrameRendered = this.renderedThisFrame;
    this.renderedThisFrame = false;
  }
}
