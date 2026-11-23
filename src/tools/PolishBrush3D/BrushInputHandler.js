/**
 * BrushInputHandler.js (brush plan B1)
 * Every pointer sample, one finger, never drop the stroke.
 *
 * - Capture and identity: `pointerdown` captures that pointer; only it drives
 *   the brush until its `pointerup` / `pointercancel` / `lostpointercapture`.
 *   Other pointers (second finger, palm) are ignored. Leaving the canvas or
 *   the nail does not end the stroke.
 * - Every sample: raw samples (`pointerrawupdate` where the browser has it,
 *   else `pointermove`, both with `getCoalescedEvents()`) go into a
 *   preallocated queue. `beginFrame(nailMesh)` drains it once per frame and
 *   raycasts the kept samples to the nail (newest always; at most
 *   `maxSamples`, the rest evenly subsampled). No smoothing, no prediction.
 * - Edges: where the pointer crosses the nail outline, the crossing is found by
 *   bisection on screen and emitted as a sample with `edge = 1`. The stroke
 *   stays alive off the nail; a press that starts off the nail paints from its
 *   entry point.
 * - Touch: the paint point is a constant 12 CSS px above the contact point
 *   (`TOUCH_NUDGE_PX`); if that misses the nail but the raw point hits, the raw
 *   point is used.
 *
 * Output (plan 4.2), refreshed by `beginFrame()`:
 *   sampleCount   new on-nail samples this frame, oldest first (0..maxSamples,
 *                 plus one per nail-edge crossing; at most SAMPLE_ROWS)
 *   samples       Float32Array, stride SAMPLE_STRIDE (8):
 *                 u, v, wx, wy, wz, tMs, edge (0/1), dir
 *                 tMs = ms since this stroke's press (event clock);
 *                 dir = +1 entry, -1 exit on an edge sample, else 0;
 *                 u = v = -1 when the mesh has no uv.
 *   down          the tracked pointer is pressed (after this frame's samples)
 *   strokeStart / strokeEnd   a press / release was seen this frame
 *   onNail        the newest pressed sample is on the nail
 *   tip           reused object for the newest sample (same object as
 *                 `result`): surfacePoint, surfaceNormal, uv, hasUV, isValid
 *                 (on the nail), isTouch, pressure (0..1), hover (mouse or pen
 *                 over the nail, not pressed); `position` / `normal` are for
 *                 the old rig and only filled by getBrushTransform()
 *   maxSamples    cap per frame (quality key strokeSamplesMax), setMaxSamples()
 *
 * Compatibility until B5: `getBrushTransform(nailMesh)` runs `beginFrame()` if
 * nobody did this frame and returns `tip` with `position` / `normal`;
 * `updatePressure()`, `consumeMoved()`, `isPainting()`, `getPressure()`,
 * `nailScreenSpan()`, `touchLiftPx()` / `TOUCH_LIFT` keep working.
 *
 * No allocations of ours in the handlers or in `beginFrame()`; the browser's
 * coalesced-events array is the one allowed allocation.
 */
import * as THREE from 'three';

const BRUSH_CONFIG = Object.freeze({
  defaultDistance: 0.6,   // distance from camera when not over the nail
  hoverHeight: 0.02,      // height above the surface when hovering
  pressHeight: 0.005,     // height above the surface when pressed
});
// Offset to put the brush tip at the cursor (diagonal brush), camera space.
const TIP_OFFSET = Object.freeze(new THREE.Vector3(0.005, -0.005, 0));
const UP = Object.freeze(new THREE.Vector3(0, 1, 0));

/** Touch: paint lands this many CSS px above the contact point, everywhere. */
export const TOUCH_NUDGE_PX = 12;
/** Old name, kept so `game.feature.js` compiles until B5: `min(maxPx, fraction * h)` is the nudge. */
export const TOUCH_LIFT = Object.freeze({ maxPx: TOUCH_NUDGE_PX, fraction: 1 });

/**
 * Touch lift in CSS px for a finger at `touchY`: the constant nudge, clamped to
 * 0 above the nail's on-screen top. Pure; the ghost finger uses it.
 * @param {number} touchY
 * @param {number} nailTop
 * @param {number} nailBottom
 * @returns {number}
 */
export function touchLiftPx(touchY, nailTop, nailBottom) {
  if (!(nailBottom - nailTop > 0)) return 0;
  return touchY > nailTop ? TOUCH_NUDGE_PX : 0;
}

export const SAMPLE_STRIDE = 8;
export const MAX_SAMPLES = 8;         // largest `maxSamples` (quality key strokeSamplesMax)
export const SAMPLE_ROWS = 24;        // samples buffer rows: cap + edge crossings
const QUEUE = 64;                     // raw samples between two frames
const Q_STRIDE = 4;                   // clientX, clientY, timeStamp, kind
const K_MOVE = 0, K_DOWN = 1, K_UP = 2;
const EXTRA_CASTS = 4;                // per frame: touch fallbacks and edge bisection
const BISECT_STEPS = 4;
const PRESS_START = 0.35;             // pressure on down, ramps to 1 in ~65 ms
const PRESS_RATE = 10;                // per second
const RELEASE_RATE = 8;               // per second (old rig height only)

const _corner = new THREE.Vector3();

export class BrushInputHandler {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement
   * @param {{ maxSamples?: number }} [opts]
   */
  constructor(camera, domElement, opts = {}) {
    this.camera = camera;
    this.domElement = domElement;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Event-time pointer state.
    this.isPointerDown = false;
    this.pointerId = -1;
    this.pointerType = '';
    this.pointerPosition = new THREE.Vector2();
    this.hasPointer = false;
    this.moved = false;            // set by pointer events, cleared by consumeMoved()
    this.isTouch = false;          // tracked pointer is a finger
    this._clientX = 0;
    this._clientY = 0;
    this._downTime = 0;            // event clock of the press
    this._penPressure = 0;
    this.touchLift = 0;            // CSS px applied to the newest touch sample
    this.simulatedPressure = 0;
    this.pressureVelocity = 0;
    this.eventSource = 'pointermove';

    // Raw sample queue, drained by beginFrame().
    this._queue = new Float64Array(QUEUE * Q_STRIDE);
    this._queueN = 0;
    this._keep = new Uint8Array(QUEUE);
    this._inStroke = new Uint8Array(QUEUE);
    this._turn = new Float32Array(QUEUE);
    this._rawPrevX = 0;              // last raw entry of the previous frame (turn scores)
    this._rawPrevY = 0;
    this._rawPrevOk = false;

    // Frame output (plan 4.2).
    this.maxSamples = MAX_SAMPLES;
    if (opts && opts.maxSamples) this.setMaxSamples(opts.maxSamples);
    this.samples = new Float32Array(SAMPLE_ROWS * SAMPLE_STRIDE);
    this.sampleCount = 0;
    this.down = false;
    this.strokeStart = false;
    this.strokeEnd = false;
    this.onNail = false;
    this.strokeStartMs = 0;
    // Cheap counters (feel harness).
    this.stats = { frames: 0, events: 0, samples: 0, raycasts: 0, lastRaycasts: 0, maxRaycasts: 0, strokes: 0 };

    // Walk state carried between frames.
    this._walkDown = false;
    this._frameBegun = false;
    this._prevValid = false;       // a previous pressed sample exists in this stroke
    this._prevOn = false;
    this._prevX = 0;               // its effective (nudged) screen point
    this._prevY = 0;
    this._prevCY = 0;              // its client y (prevY + offset used)
    this._prevT = 0;
    this._prevRow = new Float32Array(SAMPLE_STRIDE);
    this._extraLeft = 0;
    this._bisectS = 0;
    this._rawMode = false;         // touch: raw contact point in use (nail's top edge)
    this._ex = 0;
    this._ey = 0;

    // Reused scratch.
    this._hits = [];
    this._row = new Float32Array(SAMPLE_STRIDE);
    this._rowB = new Float32Array(SAMPLE_STRIDE);
    this._rowC = new Float32Array(SAMPLE_STRIDE);
    this._rayDir = new THREE.Vector3(0, 0, -1);
    this._toCamera = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._span = { top: 0, bottom: 0 };
    this._box = { left: 0, right: 0, top: 0, bottom: 0, valid: false };
    this._lastCam = new THREE.Matrix4();
    this._lastNailMatrix = new THREE.Matrix4();
    this._lastNail = null;

    this.result = {
      position: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),        // brush axis (towards camera)
      surfacePoint: new THREE.Vector3(),
      surfaceNormal: new THREE.Vector3(0, 1, 0), // world-space face normal
      uv: new THREE.Vector2(),
      hasUV: false,
      pressure: 0,
      isValid: false,
      isTouch: false,
      hover: false,
    };
    this.tip = this.result;
    this.lastValidHit = null;

    // Canvas rect, cached: getBoundingClientRect allocates, so it is only
    // re-read on attach, pointerdown and window resize.
    this._rectLeft = 0;
    this._rectTop = 0;
    this._rectWidth = 1;
    this._rectHeight = 1;
    this._refreshRect = this._refreshRect.bind(this);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  /** Samples kept per frame (quality key `strokeSamplesMax`), 1..MAX_SAMPLES. */
  setMaxSamples(n) {
    this.maxSamples = Math.max(1, Math.min(MAX_SAMPLES, n | 0));
  }

  _refreshRect() {
    const rect = this.domElement.getBoundingClientRect();
    this._rectLeft = rect.left;
    this._rectTop = rect.top;
    this._rectWidth = rect.width || 1;
    this._rectHeight = rect.height || 1;
  }

  attach() {
    this._refreshRect();
    this.eventSource = typeof window !== 'undefined' && 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
    const el = this.domElement;
    window.addEventListener('resize', this._refreshRect);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener(this.eventSource, this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('lostpointercapture', this.onPointerUp);
    // Safety net if capture was refused: a release anywhere still ends the stroke.
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  detach() {
    const el = this.domElement;
    window.removeEventListener('resize', this._refreshRect);
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener(this.eventSource, this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('lostpointercapture', this.onPointerUp);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    if (this.isPointerDown && el.hasPointerCapture && el.hasPointerCapture(this.pointerId)) {
      try { el.releasePointerCapture(this.pointerId); } catch (e) { /* already released */ }
    }
    this.isPointerDown = false;
    this.pointerId = -1;
    this.simulatedPressure = 0;
    this._queueN = 0;
    this._walkDown = false;
    this._prevValid = false;
    this.down = false;
    this.sampleCount = 0;
  }

  // ------------------------------------------------------------- events --

  _push(x, y, t, kind) {
    if (this._queueN >= QUEUE) this._decimate();
    const q = this._queue;
    const o = this._queueN * Q_STRIDE;
    q[o] = x;
    q[o + 1] = y;
    q[o + 2] = t;
    q[o + 3] = kind;
    this._queueN++;
    this.stats.events++;
  }

  // Queue full (a long stall): drop every other move, keep presses, releases
  // and the newest entry. Keeps the path's shape, in place.
  _decimate() {
    const q = this._queue;
    const n = this._queueN;
    let w = 0;
    let drop = false;
    for (let i = 0; i < n; i++) {
      const o = i * Q_STRIDE;
      let keep = q[o + 3] !== K_MOVE || i === n - 1;
      if (!keep) { keep = !drop; drop = !drop; }
      if (!keep) continue;
      if (w !== i) {
        const d = w * Q_STRIDE;
        q[d] = q[o]; q[d + 1] = q[o + 1]; q[d + 2] = q[o + 2]; q[d + 3] = q[o + 3];
      }
      w++;
    }
    this._queueN = w;
  }

  _setPointer(x, y) {
    this._clientX = x;
    this._clientY = y;
    this.pointerPosition.set(x, y);
    this.hasPointer = true;
    this.moved = true;
  }

  onPointerDown(event) {
    // Another pointer is already pressed: second finger or palm, ignored.
    if (this.isPointerDown) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    this._refreshRect();
    this.pointerId = event.pointerId;
    this.pointerType = event.pointerType;
    this.isTouch = event.pointerType === 'touch';
    this.isPointerDown = true;
    try { this.domElement.setPointerCapture(event.pointerId); } catch (e) { /* pointer already gone */ }
    this._downTime = event.timeStamp;
    const pen = event.pointerType === 'pen';
    this._penPressure = pen && event.pressure > 0 ? event.pressure : 0;
    this.simulatedPressure = this._penPressure > 0 ? this._penPressure : PRESS_START;
    this._push(event.clientX, event.clientY, event.timeStamp, K_DOWN);
    this._setPointer(event.clientX, event.clientY);
  }

  onPointerMove(event) {
    if (this.isPointerDown) {
      if (event.pointerId !== this.pointerId) return;
    } else {
      // Hover: mouse or pen only (a finger cannot hover).
      if (event.pointerType === 'touch') return;
      this.pointerId = event.pointerId;
      this.pointerType = event.pointerType;
      this.isTouch = false;
    }
    const pen = this.pointerType === 'pen';
    const list = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
    const n = list ? list.length : 0;
    let x = event.clientX, y = event.clientY;
    if (n > 0) {
      for (let i = 0; i < n; i++) {
        const c = list[i];
        this._push(c.clientX, c.clientY, c.timeStamp, K_MOVE);
        if (pen && c.pressure > 0) this._penPressure = c.pressure;
      }
      x = list[n - 1].clientX;
      y = list[n - 1].clientY;
    } else {
      this._push(x, y, event.timeStamp, K_MOVE);
      if (pen && event.pressure > 0) this._penPressure = event.pressure;
    }
    this._setPointer(x, y);
  }

  onPointerUp(event) {
    if (!this.isPointerDown || event.pointerId !== this.pointerId) return;
    this.isPointerDown = false;
    // pointercancel / lostpointercapture may carry no position: end where we are.
    const real = event.type === 'pointerup';
    const x = real ? event.clientX : this._clientX;
    const y = real ? event.clientY : this._clientY;
    this._push(x, y, event.timeStamp, K_UP);
    this._setPointer(x, y);
    this.simulatedPressure = 0;
  }

  _setMouse(x, y) {
    this.mouse.x = ((x - this._rectLeft) / this._rectWidth) * 2 - 1;
    this.mouse.y = -((y - this._rectTop) / this._rectHeight) * 2 + 1;
  }

  // --------------------------------------------------------- per frame --

  /**
   * Resolve this frame's queued samples (plan 4.2). Call once per frame,
   * before reading `samples`, `tip`, `down`, `strokeStart`, `strokeEnd`.
   * @param {THREE.Mesh} nailMesh
   * @returns {this}
   */
  beginFrame(nailMesh) {
    this._frameBegun = true;
    const st = this.stats;
    st.frames++;
    const rc0 = st.raycasts;
    this.sampleCount = 0;
    this.strokeStart = false;
    this.strokeEnd = false;
    this._extraLeft = EXTRA_CASTS;
    const n = this._queueN;

    if (n === 0) {
      // Nothing new: refresh the tip only when the view or the nail moved.
      if (this.hasPointer && this._viewChanged(nailMesh)) this._castTip(nailMesh, this._clientX, this._clientY, this._walkDown);
      this.down = this._walkDown;
      this.tip.pressure = this.down ? this._pressureAt(performance.now()) : 0;
      this._endFrame(nailMesh, rc0);
      return this;
    }

    if (this.isTouch) this._nailScreenBox(nailMesh, this._box);
    else this._box.valid = false;

    // Pass 1: which entries belong to a pressed stroke, and which to cast.
    const q = this._queue;
    const keep = this._keep;
    const inStroke = this._inStroke;
    let down = this._walkDown;
    let marked = 0, moves = 0;
    for (let i = 0; i < n; i++) {
      const k = q[i * Q_STRIDE + 3];
      if (k === K_DOWN) down = true;
      const d = down;
      if (k === K_UP) down = false;
      inStroke[i] = d ? 1 : 0;
      keep[i] = 0;
      if (i === n - 1 || (d && k !== K_MOVE)) {
        keep[i] = 1;
        if (d) marked++;
      } else if (d) {
        moves++;
      }
    }
    // Subsample the other pressed moves: when there are more than the cap,
    // the sharpest turns are kept first (a fast zig-zag keeps its corners;
    // at least one slot stays for an even spread), the rest are spread evenly.
    let slots = Math.max(0, this.maxSamples - marked);
    if (moves > slots && slots >= 2) {
      const turn = this._turn;
      for (let i = 0; i < n; i++) {
        turn[i] = -1;
        if (keep[i] || !inStroke[i] || i === n - 1 || (i === 0 && !this._rawPrevOk)) continue;
        const o = i * Q_STRIDE;
        // the entry before the first one is the previous frame's last
        const px = i > 0 ? q[o - Q_STRIDE] : this._rawPrevX, py = i > 0 ? q[o - Q_STRIDE + 1] : this._rawPrevY;
        const ax = q[o] - px, ay = q[o + 1] - py;
        const bx = q[o + Q_STRIDE] - q[o], by = q[o + Q_STRIDE + 1] - q[o + 1];
        const la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
        if (la > 0.5 && lb > 0.5) turn[i] = 1 - (ax * bx + ay * by) / (la * lb);
      }
      for (let c = slots - 1; c > 0; c--) {
        let best = -1, bs = 0.15; // only real turns (> ~32 deg)
        for (let i = 0; i < n; i++) if (turn[i] > bs) { bs = turn[i]; best = i; }
        if (best < 0) break;
        keep[best] = 1;
        turn[best] = -1;
        slots--;
        moves--;
      }
    }
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (keep[i] || !inStroke[i]) continue;
      if (moves <= slots || Math.floor((j + 1) * slots / moves) > Math.floor(j * slots / moves)) keep[i] = 1;
      j++;
    }

    // Pass 2: cast the kept samples in order.
    for (let i = 0; i < n; i++) {
      const o = i * Q_STRIDE;
      const k = q[o + 3];
      const t = q[o + 2];
      if (k === K_DOWN) {
        this.strokeStart = true;
        this.strokeStartMs = t;
        this._prevValid = false;
        this._rawMode = false;
        st.strokes++;
      }
      if (keep[i]) {
        const newest = i === n - 1;
        if (inStroke[i]) this._castPressed(nailMesh, q[o], q[o + 1], newest, t);
        else if (newest) this._castTip(nailMesh, q[o], q[o + 1], false);
      }
      if (k === K_UP && inStroke[i]) {
        this.strokeEnd = true;
        this._prevValid = false;
      }
    }
    this._walkDown = down;
    this.down = down;
    this._rawPrevX = q[(n - 1) * Q_STRIDE];
    this._rawPrevY = q[(n - 1) * Q_STRIDE + 1];
    this._rawPrevOk = down;
    this._queueN = 0;
    this.tip.pressure = down ? this._pressureAt(q[(n - 1) * Q_STRIDE + 2]) : 0;
    this._endFrame(nailMesh, rc0);
    return this;
  }

  _endFrame(nailMesh, rc0) {
    const st = this.stats;
    st.lastRaycasts = st.raycasts - rc0;
    if (st.lastRaycasts > st.maxRaycasts) st.maxRaycasts = st.lastRaycasts;
    st.samples += this.sampleCount;
    this._lastCam.copy(this.camera.matrixWorld);
    this._lastNail = nailMesh || null;
    if (nailMesh) this._lastNailMatrix.copy(nailMesh.matrixWorld);
  }

  _viewChanged(nailMesh) {
    if (!this._lastCam.equals(this.camera.matrixWorld)) return true;
    if ((nailMesh || null) !== this._lastNail) return true;
    return !!nailMesh && !this._lastNailMatrix.equals(nailMesh.matrixWorld);
  }

  _pressureAt(t) {
    if (this.pointerType === 'pen' && this._penPressure > 0) return this._penPressure;
    return Math.min(1, PRESS_START + Math.max(0, t - this._downTime) * (PRESS_RATE / 1000));
  }

  /**
   * Raycast screen point (sx, sy) to the nail; on a hit write u, v, wx, wy, wz
   * into `row`, and the world face normal into `normal` when given.
   */
  _cast(nailMesh, sx, sy, row, normal) {
    this._setMouse(sx, sy);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (normal) this._rayDir.copy(this.raycaster.ray.direction);
    if (!nailMesh) return false;
    const hits = this._hits;
    hits.length = 0;
    this.raycaster.intersectObject(nailMesh, false, hits);
    this.stats.raycasts++;
    if (hits.length === 0) return false;
    const hit = hits[0];
    if (hit.uv) { row[0] = hit.uv.x; row[1] = hit.uv.y; } else { row[0] = -1; row[1] = -1; }
    row[2] = hit.point.x;
    row[3] = hit.point.y;
    row[4] = hit.point.z;
    if (normal) {
      if (hit.face) normal.copy(hit.face.normal).transformDirection(nailMesh.matrixWorld);
      else normal.set(0, 0, 0);
    }
    hits.length = 0;
    return true;
  }

  _emit(row, t, edge, dir) {
    if (this.sampleCount >= SAMPLE_ROWS) return;
    const s = this.samples;
    const o = this.sampleCount * SAMPLE_STRIDE;
    s[o] = row[0];
    s[o + 1] = row[1];
    s[o + 2] = row[2];
    s[o + 3] = row[3];
    s[o + 4] = row[4];
    s[o + 5] = t - this.strokeStartMs;
    s[o + 6] = edge;
    s[o + 7] = dir;
    this.sampleCount++;
  }

  /**
   * Bisect between the effective screen points P(sOn) (on the nail, hit in
   * `onRow`) and P(sOff) (off it), P(s) = (ax, ay) + ((bx, by) - (ax, ay)) s.
   * Writes the last on-nail hit into `out` and its s into `_bisectS`.
   */
  _bisect(nailMesh, ax, ay, bx, by, sOn, sOff, onRow, out, steps) {
    out.set(onRow);
    const scratch = this._rowC;
    for (let k = 0; k < steps; k++) {
      const s = (sOn + sOff) * 0.5;
      if (this._cast(nailMesh, ax + (bx - ax) * s, ay + (by - ay) * s, scratch, null)) {
        out.set(scratch);
        sOn = s;
      } else {
        sOff = s;
      }
    }
    this._bisectS = sOn;
  }

  /**
   * Touch: the nudged point, or the raw contact point when the nudged one
   * misses and the raw one hits (the finger is in the nail's top 12 px).
   * Once the raw point is in use, later samples of the stroke cast it first,
   * so a frame never flips between the two; the newest sample checks whether
   * the nudged point is back on the nail. Extra casts come from `_extraLeft`;
   * the newest sample may use the last one. Leaves the point in `_ex/_ey`.
   */
  _castTouch(nailMesh, x, y, row, normal, newest) {
    const ny = y - TOUCH_NUDGE_PX;
    this._ex = x;
    if (this._rawMode) {
      if (this._cast(nailMesh, x, y, row, normal)) {
        if (newest && this._spare(nailMesh, newest, x, ny) && this._cast(nailMesh, x, ny, this._rowC, normal)) {
          row.set(this._rowC);
          this._rawMode = false;
          this._ey = ny;
        } else {
          this._ey = y;
        }
        return true;
      }
      this._rawMode = false;
      this._ey = ny;
      return this._spare(nailMesh, newest, x, ny) && this._cast(nailMesh, x, ny, row, normal);
    }
    this._ey = ny;
    if (this._cast(nailMesh, x, ny, row, normal)) return true;
    if (this._spare(nailMesh, newest, x, y) && this._cast(nailMesh, x, y, row, normal)) {
      this._rawMode = true;
      this._ey = y;
      return true;
    }
    return false;
  }

  /**
   * Take one extra cast for the raw contact point (x, y) if it can be on the
   * nail (inside the nail's projected screen box: no raycast) and the budget
   * allows it (the newest sample may take the last one).
   */
  _spare(nailMesh, newest, x, y) {
    if (!nailMesh || this._extraLeft <= (newest ? 0 : 1)) return false;
    const b = this._box;
    if (b.valid && (x < b.left - 2 || x > b.right + 2 || y < b.top - 2 || y > b.bottom + 2)) return false;
    this._extraLeft--;
    return true;
  }

  /** One pressed sample at client (x, y), event time t. */
  _castPressed(nailMesh, x, y, newest, t) {
    const row = this._row;
    const normal = newest ? this.result.surfaceNormal : null;
    let hit, ex = x, ey = y;
    if (this.isTouch) {
      hit = this._castTouch(nailMesh, x, y, row, normal, newest);
      ex = this._ex;
      ey = this._ey;
    } else {
      hit = this._cast(nailMesh, x, y, row, normal);
    }
    if (newest) this.touchLift = y - ey;

    // Both ends of a crossing take the touch offset of the on-nail side, so
    // the bisection runs along the finger's own path.
    if (this._prevValid && this._prevOn !== hit) {
      // Crossed the nail outline since the previous sample: find the crossing.
      const reserve = newest || !this.isTouch ? 0 : 1;
      const steps = Math.max(0, Math.min(BISECT_STEPS, this._extraLeft - reserve));
      this._extraLeft -= steps;
      const edge = this._rowB;
      const pt = this._prevT;
      if (hit) {
        // entry: this sample is the on-nail side (s = 1)
        if (steps > 0) {
          this._bisect(nailMesh, this._prevX, this._prevCY - (y - ey), ex, ey, 1, 0, row, edge, steps);
          this._emit(edge, pt + (t - pt) * this._bisectS, 1, 1);
          this._emit(row, t, 0, 0);
        } else {
          this._emit(row, t, 1, 1);
        }
      } else {
        // exit: the previous sample is the on-nail side (s = 0)
        this._bisect(nailMesh, this._prevX, this._prevY, ex, y - (this._prevCY - this._prevY), 0, 1, this._prevRow, edge, steps);
        this._emit(edge, pt + (t - pt) * this._bisectS, 1, -1);
      }
    } else if (hit) {
      this._emit(row, t, 0, 0);
    }
    if (hit) this._prevRow.set(row);
    this._prevValid = true;
    this._prevOn = hit;
    this._prevX = ex;
    this._prevY = ey;
    this._prevCY = y;
    this._prevT = t;

    if (newest) {
      this.onNail = hit;
      this._fillTip(hit, row, false);
    }
  }

  /**
   * Tip only (no sample): the newest hover position, or the pointer again
   * after the camera or nail moved.
   */
  _castTip(nailMesh, x, y, pressed) {
    const row = this._row;
    const normal = this.result.surfaceNormal;
    const touch = pressed && this.isTouch;
    let ey = touch ? y - TOUCH_NUDGE_PX : y;
    let hit = this._cast(nailMesh, x, ey, row, normal);
    if (!hit && touch && nailMesh && this._cast(nailMesh, x, y, row, normal)) { hit = true; ey = y; }
    this.touchLift = y - ey;
    this.onNail = pressed && hit;
    this._fillTip(hit, row, hit && !pressed && !this.isTouch);
  }

  _fillTip(hit, row, hover) {
    const out = this.result;
    const cam = this.camera;
    out.isTouch = this.isTouch;
    out.hover = hover;
    if (hit) {
      out.surfacePoint.set(row[2], row[3], row[4]);
      const toCamera = this._toCamera.copy(cam.position).sub(out.surfacePoint).normalize();
      if (out.surfaceNormal.lengthSq() < 1e-8) out.surfaceNormal.copy(toCamera);
      else if (out.surfaceNormal.dot(toCamera) < 0) out.surfaceNormal.negate();
      if (row[0] >= 0) { out.uv.set(row[0], row[1]); out.hasUV = true; } else out.hasUV = false;
      out.isValid = true;
      this.lastValidHit = out;
    } else {
      out.surfacePoint.copy(cam.position).addScaledVector(this._rayDir, BRUSH_CONFIG.defaultDistance);
      out.surfaceNormal.copy(UP);
      out.hasUV = false;
      out.isValid = false;
    }
  }

  // ------------------------------------------------------- compatibility --

  /**
   * The nail's on-screen vertical extent in CSS px (projected bounding box),
   * written into `out` as { top, bottom }. Returns false without a nail.
   */
  nailScreenSpan(nailMesh, out) {
    if (!nailMesh || !nailMesh.geometry) return false;
    const geo = nailMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(nailMesh.matrixWorld).project(this.camera);
      const y = this._rectTop + (1 - _corner.y) * 0.5 * this._rectHeight;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    out.top = top;
    out.bottom = bottom;
    return bottom > top;
  }

  /** The nail's projected bounding box on screen (CSS px), into `out`. */
  _nailScreenBox(nailMesh, out) {
    out.valid = false;
    if (!nailMesh || !nailMesh.geometry) return;
    const geo = nailMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(nailMesh.matrixWorld).project(this.camera);
      if (_corner.z > 1) return; // behind the camera: no box, no pretest
      const x = this._rectLeft + (_corner.x + 1) * 0.5 * this._rectWidth;
      const y = this._rectTop + (1 - _corner.y) * 0.5 * this._rectHeight;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
    out.left = l; out.right = r; out.top = t; out.bottom = b;
    out.valid = true;
  }

  /** True once per pointer change. */
  consumeMoved() {
    const m = this.moved;
    this.moved = false;
    return m;
  }

  /**
   * Pressure for the old rig: the press ramp while down, a short decay after.
   * Returns true while it is still changing.
   */
  updatePressure(deltaTime) {
    const before = this.simulatedPressure;
    if (this.isPointerDown) {
      this.simulatedPressure = this._pressureAt(performance.now());
    } else {
      this.simulatedPressure = Math.max(0, this.simulatedPressure - deltaTime * RELEASE_RATE);
    }
    return this.simulatedPressure !== before;
  }

  /**
   * Old single-point API: resolves the frame (unless beginFrame() already ran
   * this frame) and returns `tip` with the old rig's `position` / `normal`.
   * @param {THREE.Mesh} nailMesh
   * @returns {object} the reused result object
   */
  getBrushTransform(nailMesh) {
    if (!this._frameBegun) this.beginFrame(nailMesh);
    this._frameBegun = false;
    const out = this.result;
    const cam = this.camera;
    if (out.isValid) {
      out.pressure = this.isPointerDown ? this.simulatedPressure : 0;
      const height = this.isPointerDown
        ? BRUSH_CONFIG.pressHeight + (BRUSH_CONFIG.hoverHeight - BRUSH_CONFIG.pressHeight) * (1 - this.simulatedPressure)
        : BRUSH_CONFIG.hoverHeight;
      const toCamera = this._toCamera.copy(cam.position).sub(out.surfacePoint).normalize();
      out.position.copy(out.surfacePoint).addScaledVector(toCamera, height);
      out.normal.copy(toCamera);
    } else {
      out.pressure = 0;
      out.position.copy(out.surfacePoint);
      out.normal.copy(UP);
    }
    out.position.add(this._tip.copy(TIP_OFFSET).applyQuaternion(cam.quaternion));
    return out;
  }

  isPainting() {
    return this.isPointerDown;
  }

  getPressure() {
    return this.simulatedPressure;
  }
}
