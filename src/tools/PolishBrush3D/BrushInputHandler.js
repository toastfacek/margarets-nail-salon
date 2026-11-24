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
const EXTRA_CASTS = 4;                // per frame: touch fallbacks and edge bisection (plus what the samples leave unused)
const BISECT_STEPS = 6;               // when the frame has the casts (_budget): 1/64 of the segment
const TOUCH_EDGE_STEPS = 3;          // touch at the nail's top edge: 12 px / 8 = 1.5 px
// Every cast is taken 1/128 CSS px right of and below the asked-for point.
// three's ray-triangle test can miss a ray that runs exactly through an edge
// shared by two triangles. The B9 nail has an edge along its centreline, and
// the close-up frames that centreline exactly on a pixel column, so a stroke
// on that column (a mouse moves in whole pixels) met holes in the middle of
// the nail: an exit, a re-entry, a seam in the band and a tip jump
// (brush-feel A1 / A2 / A18 on high-mouse, one run in two). 1/128 px moves no
// paint visibly and keeps whole- and half-pixel points off such edges.
const RAY_EPS_PX = 1 / 128;
// Two crossings in one frame (B9.9): a slow frame can hold both ends of a
// short trip off the nail (brush-feel B1.leave: out and back within ~40 px).
// The exit's bisection took the frame's spare casts and the re-entry went
// with none or one or two: its edge sample sat up to a segment (12-60 px)
// short of the edge, about one run in three on high-mouse (and now and then
// on touch). Now a crossing that is not the frame's newest sample leaves
// CROSS_RESERVE steps for a later one, and every crossing starts from the
// nail's outline projected on screen (no raycast): two probes EDGE_PROBE_PX
// either side of it bracket the edge within 2 x EDGE_PROBE_PX; plain
// bisection takes over where the outline is off (each probe keeps the
// bracket honest).
const CROSS_RESERVE = 2;
const EDGE_PROBE_PX = 0.6;
const PRESS_START = 0.35;             // pressure on down, ramps to 1 in ~65 ms
const PRESS_RATE = 10;                // per second
const RELEASE_RATE = 8;               // per second (old rig height only)

const _corner = new THREE.Vector3();
const _ov = new THREE.Vector3();

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
    this._prevRawMode = false;
    this._ex = 0;
    this._ey = 0;

    // Reused scratch.
    this._hits = [];
    this._row = new Float32Array(SAMPLE_STRIDE);
    this._rowB = new Float32Array(SAMPLE_STRIDE);
    this._rowC = new Float32Array(SAMPLE_STRIDE);
    this._outline = null;          // the nail sheet's outline edges (crossings)
    this._outlineDone = null;
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
    // touch gets the raw point and its edge bisection on top of the crossings'
    this._extraLeft = EXTRA_CASTS + (this.isTouch ? TOUCH_EDGE_STEPS : 0);
    // The frame's raycasts stay within what the samples could take at most
    // (one each, two for touch: nudged and raw) plus the extras, as before;
    // but the extras also get whatever the samples leave unused (B9: two
    // crossings in one slow frame shared 7 casts, and the second one went
    // without bisection: B1.leave on touch). See _budget().
    this._castCap = this.maxSamples * (this.isTouch ? 2 : 1) + this._extraLeft;
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
    let keptLeft = 0;
    for (let i = 0; i < n; i++) if (keep[i] && (inStroke[i] || i === n - 1)) keptLeft++;
    for (let i = 0; i < n; i++) {
      const o = i * Q_STRIDE;
      const k = q[o + 3];
      const t = q[o + 2];
      if (keep[i] && (inStroke[i] || i === n - 1)) this._budget(st.raycasts - rc0, keptLeft--);
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

  /**
   * Extra casts open to the next sample: the frame's cap, less what was cast
   * so far and what the `kept` samples still to come (this one included) may
   * take for themselves (one each, two for touch). Never below the fixed
   * extras still unspent.
   */
  _budget(used, kept) {
    const free = this._castCap - used - kept * (this.isTouch ? 2 : 1);
    if (free > this._extraLeft) this._extraLeft = free;
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
    this._setMouse(sx + RAY_EPS_PX, sy + RAY_EPS_PX);
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
  _bisect(nailMesh, ax, ay, bx, by, sOn, sOff, onRow, out, steps, guess = false) {
    out.set(onRow);
    const scratch = this._rowC;
    // first, two probes either side of where the segment meets the projected
    // outline (crossings); each keeps the bracket honest if it is off
    const len = Math.hypot(bx - ax, by - ay);
    const sg = guess && steps >= 2 && len > 4 * EDGE_PROBE_PX ? this._outlineS(nailMesh, ax, ay, bx, by, sOn, sOff) : -1;
    if (sg >= 0) {
      const d = (EDGE_PROBE_PX / len) * (sOff > sOn ? 1 : -1);
      for (let k = 0; k < 2; k++) {
        const s = k ? sg + d : sg - d;
        if ((s - sOn) * (sOff - s) <= 0) continue; // outside the bracket now
        steps--;
        if (this._cast(nailMesh, ax + (bx - ax) * s, ay + (by - ay) * s, scratch, null)) {
          out.set(scratch);
          sOn = s;
        } else {
          sOff = s;
        }
      }
    }
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
   * Touch crossing: bisect along the finger's raw path from (ax, ay)
   * (P(s) = a + (b - a) s) on "the nudged point or the raw contact is on the
   * nail" (touch paints while either is), the deeper of the two tried first
   * and the other only when it misses (from the frame's spare raycasts).
   * When the raw contact alone is on at the end, the paint sits on the
   * outline above it (as in raw contact mode): refined there with what is
   * left. Writes the paint point's hit into `out` and its s into `_bisectS`.
   */
  _bisectTouch(nailMesh, ax, ay, bx, by, sOn, sOff, onRow, out, steps, rawFirst) {
    out.set(onRow);
    const scratch = this._rowC;
    // rawOnly: the paint point's last hit is the raw contact; nudgedUnknown:
    // it was tried first and hit, so the nudged point was never cast
    let rawOnly = false, nudgedUnknown = false;
    // the first two probes either side of the projected outline (as _bisect):
    // "either on" ends where the later of the raw path's and the nudged
    // path's outline meetings is (seen from the on-nail side)
    const len = Math.hypot(bx - ax, by - ay);
    let sg = -1;
    if (steps >= 2 && len > 4 * EDGE_PROBE_PX) {
      const sRaw = this._outlineS(nailMesh, ax, ay, bx, by, sOn, sOff);
      const sNud = this._outlineS(nailMesh, ax, ay - TOUCH_NUDGE_PX, bx, by - TOUCH_NUDGE_PX, sOn, sOff);
      sg = sRaw < 0 ? sNud : sNud < 0 ? sRaw : (Math.abs(sRaw - sOn) > Math.abs(sNud - sOn) ? sRaw : sNud);
    }
    const d = sg >= 0 ? (EDGE_PROBE_PX / len) * (sOff > sOn ? 1 : -1) : 0;
    for (let k = 0; k < steps; k++) {
      let s = (sOn + sOff) * 0.5;
      if (sg >= 0 && k < 2) {
        const g = k ? sg + d : sg - d;
        if ((g - sOn) * (sOff - g) > 0) s = g;
      }
      const px = ax + (bx - ax) * s, py = ay + (by - ay) * s;
      const y1 = rawFirst ? py : py - TOUCH_NUDGE_PX, y2 = rawFirst ? py - TOUCH_NUDGE_PX : py;
      let on = this._cast(nailMesh, px, y1, scratch, null);
      let second = false;
      // raw first: one cast stays back for the nudged point at the end
      if (!on && this._extraLeft > (rawFirst ? 1 : 0)) {
        this._extraLeft--;
        on = this._cast(nailMesh, px, y2, scratch, null);
        second = true;
      }
      if (on) {
        out.set(scratch);
        sOn = s;
        rawOnly = rawFirst !== second;
        nudgedUnknown = rawFirst && !second;
      } else {
        sOff = s;
      }
    }
    this._bisectS = sOn;
    if (rawOnly) {
      const px = ax + (bx - ax) * sOn, py = ay + (by - ay) * sOn;
      // The raw contact hit first: the nudged point (the paint point while it
      // is on) is cast before anything else. Without this, a crossing where
      // both are on painted at the raw contact, or 12 / 2^n px below the
      // nudged point after n refinement steps (B1.leave on touch, B9: the
      // B9 nail's taller screen box sends more side crossings down the
      // raw-first path).
      if (nudgedUnknown && this._extraLeft > 0) {
        this._extraLeft--;
        if (this._cast(nailMesh, px, py - TOUCH_NUDGE_PX, scratch, null)) {
          out.set(scratch);
          rawOnly = false;
        }
      }
      const n = rawOnly ? Math.min(TOUCH_EDGE_STEPS, this._extraLeft) : 0;
      if (n > 0) {
        this._extraLeft -= n;
        this._bisect(nailMesh, px, py, px, py - TOUCH_NUDGE_PX, 0, 1, out, out, n);
      }
      this._bisectS = sOn;
    }
  }

  /**
   * Touch: the nudged point (12 px above the contact point). When it misses
   * the nail but the raw contact point hits (the finger is in the nail's top
   * 12 px), the paint goes to the nail's edge between the two (bisection on
   * screen), so the deposit slides smoothly onto the edge instead of jumping
   * 12 px to the raw point. Extra casts come from `_extraLeft` (the newest
   * sample may use the last one); with none left the raw point is used.
   * Leaves the point in `_ex/_ey`.
   */
  _castTouch(nailMesh, x, y, row, normal, newest) {
    const ny = y - TOUCH_NUDGE_PX;
    this._ex = x;
    this._ey = ny;
    this._rawMode = false;
    if (this._cast(nailMesh, x, ny, row, normal)) return true;
    // The raw point is always tried when it can be on the nail (no budget: a
    // sample that skipped it would read as leaving and re-entering the nail).
    const b = this._box;
    if (b.valid && (x < b.left - 2 || x > b.right + 2 || y < b.top - 2 || y > b.bottom + 2)) return false;
    if (!this._cast(nailMesh, x, y, row, normal)) return false;
    this._rawMode = true;
    // older samples leave enough for a crossing's bisection (the edge sample
    // that sets where the paint stops); the newest one sets the shown deposit
    const steps = Math.max(0, Math.min(TOUCH_EDGE_STEPS, this._extraLeft - (newest ? 0 : 1 + BISECT_STEPS)));
    if (steps > 0) {
      this._extraLeft -= steps;
      // P(s) = raw + (nudged - raw) s: on the nail at s = 0, off at s = 1
      this._bisect(nailMesh, x, y, x, ny, 0, 1, row, row, steps);
      this._ey = y + (ny - y) * this._bisectS;
    } else {
      this._ey = y;
    }
    return true;
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
      let steps = Math.max(0, Math.min(BISECT_STEPS, this._extraLeft - reserve));
      // mouse: leave a later crossing in this frame its share (see CROSS_RESERVE)
      if (!newest) steps = Math.min(steps, Math.max(CROSS_RESERVE, this._extraLeft - reserve - (this.isTouch ? 2 : 1) * CROSS_RESERVE));
      this._extraLeft -= steps;
      const edge = this._rowB;
      const pt = this._prevT;
      // Touch paints while the nudged point or the raw contact (12 px below
      // it) is on the nail, so a crossing is where the first of the two
      // enters / the last of the two leaves: bisect on "either is on" along
      // the finger's raw path (B7: before, the motion picked one path, down =
      // raw, which is right on the nail's top edge only; the pointing-down
      // nail is crossed on its sides as often). The deeper point is tried
      // first (the raw contact on the upper half of the nail on screen,
      // where the outline mostly faces up), so most steps take one raycast.
      if (this.isTouch) {
        const b = this._box;
        const rawFirst = b.valid ? (y + this._prevCY) * 0.5 < (b.top + b.bottom) * 0.5 : true;
        if (hit) {
          // entry: this sample is the on-nail side (s = 1)
          if (steps > 0) {
            this._bisectTouch(nailMesh, this._prevX, this._prevCY, x, y, 1, 0, row, edge, steps, rawFirst);
            this._emit(edge, pt + (t - pt) * this._bisectS, 1, 1);
            this._emit(row, t, 0, 0);
          } else {
            this._emit(row, t, 1, 1);
          }
        } else {
          // exit: the previous sample is the on-nail side (s = 0)
          this._bisectTouch(nailMesh, this._prevX, this._prevCY, x, y, 0, 1, this._prevRow, edge, steps, rawFirst);
          this._emit(edge, pt + (t - pt) * this._bisectS, 1, -1);
        }
      } else if (hit) {
        // entry: this sample is the on-nail side (s = 1)
        if (steps > 0) {
          this._bisect(nailMesh, this._prevX, this._prevY, x, y, 1, 0, row, edge, steps, true);
          this._emit(edge, pt + (t - pt) * this._bisectS, 1, 1);
          this._emit(row, t, 0, 0);
        } else {
          this._emit(row, t, 1, 1);
        }
      } else {
        // exit: the previous sample is the on-nail side (s = 0)
        this._bisect(nailMesh, this._prevX, this._prevY, x, y, 0, 1, this._prevRow, edge, steps, true);
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
    this._prevRawMode = this._rawMode;
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
  /**
   * The nail sheet's open outline (edges used by one triangle), as vertex
   * index pairs; cached per geometry and its position version.
   */
  _outlineEdges(geo) {
    const pos = geo.attributes.position;
    const c = this._outline;
    if (c && c.geo === geo && c.version === pos.version && c.count === pos.count) return c.edges;
    // weld by position (UV seams duplicate vertices)
    const key = new Map();
    const id = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.round(pos.getX(i) * 1e6) + ',' + Math.round(pos.getY(i) * 1e6) + ',' + Math.round(pos.getZ(i) * 1e6);
      let v = key.get(k);
      if (v === undefined) { v = i; key.set(k, i); }
      id[i] = v;
    }
    const uses = new Map();
    const ix = geo.index ? geo.index.array : null;
    const nt = ix ? ix.length / 3 : pos.count / 3;
    for (let t = 0; t < nt; t++) {
      for (let e = 0; e < 3; e++) {
        const a = id[ix ? ix[t * 3 + e] : t * 3 + e], b = id[ix ? ix[t * 3 + (e + 1) % 3] : t * 3 + (e + 1) % 3];
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        uses.set(k, (uses.get(k) || 0) + 1);
      }
    }
    const list = [];
    for (const [k, n] of uses) if (n === 1) list.push(Math.floor(k / 65536), k % 65536);
    const edges = Int32Array.from(list);
    this._outline = { geo, version: pos.version, count: pos.count, edges, scr: new Float32Array(pos.count * 2) };
    return edges;
  }

  /**
   * Where the screen segment P(s) = a + (b - a) s, s between sOn and sOff,
   * meets the nail's outline projected on screen: the meeting nearest sOn, or
   * -1 (no geometry, behind the camera, or no meeting). No raycasts.
   */
  _outlineS(nailMesh, ax, ay, bx, by, sOn, sOff) {
    const geo = nailMesh && nailMesh.geometry;
    if (!geo || !geo.attributes.position || geo.attributes.position.count >= 65536) return -1;
    const edges = this._outlineEdges(geo);
    const scr = this._outline.scr;
    const pos = geo.attributes.position;
    const mw = nailMesh.matrixWorld;
    const lo = Math.min(sOn, sOff), hi = Math.max(sOn, sOff);
    const dx = bx - ax, dy = by - ay;
    let best = -1, bestD = Infinity;
    const done = this._outlineDone || (this._outlineDone = new Uint8Array(0));
    const seen = done.length >= pos.count ? done : (this._outlineDone = new Uint8Array(pos.count));
    seen.fill(0);
    for (let e = 0; e < edges.length; e += 2) {
      for (let k = 0; k < 2; k++) {
        const v = edges[e + k];
        if (seen[v]) continue;
        seen[v] = 1;
        _ov.fromBufferAttribute(pos, v).applyMatrix4(mw).project(this.camera);
        if (_ov.z > 1) return -1;
        scr[v * 2] = this._rectLeft + (_ov.x + 1) * 0.5 * this._rectWidth;
        scr[v * 2 + 1] = this._rectTop + (1 - _ov.y) * 0.5 * this._rectHeight;
      }
      const p = edges[e] * 2, q = edges[e + 1] * 2;
      const ex = scr[q] - scr[p], ey = scr[q + 1] - scr[p + 1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = scr[p] - ax, wy = scr[p + 1] - ay;
      const s = (wx * ey - wy * ex) / den;   // along the segment
      const u = (wx * dy - wy * dx) / den;   // along the outline edge
      if (u < 0 || u > 1 || s < lo || s > hi) continue;
      const d = Math.abs(s - sOn);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

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
