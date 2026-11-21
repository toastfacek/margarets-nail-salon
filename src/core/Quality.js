/**
 * Quality.js
 * Quality tiers (build plan section 2): picks a starting tier, exposes the
 * settings table as `quality.settings`, and steps down (rarely up) based on
 * measured frame times fed in by FrameLoop.
 *
 * Modules read `quality.settings` at init and again on `quality:change`.
 */
import * as THREE from 'three';
import { EVENTS } from './GameEvents.js';

export const TIERS = Object.freeze(['low', 'medium', 'high']);

// Rungs, best first. Auto-downgrade walks this list one step at a time.
const RUNGS = Object.freeze([
  Object.freeze({ tier: 'high', scale: 1.0 }),
  Object.freeze({ tier: 'medium', scale: 1.0 }),
  Object.freeze({ tier: 'low', scale: 1.0 }),
  Object.freeze({ tier: 'low', scale: 0.85 }),
  Object.freeze({ tier: 'low', scale: 0.7 }), // lowest: 0.6 without antialias is visibly jagged
]);

const LOW_GPU_PATTERNS = [
  'swiftshader', 'llvmpipe', 'mali-4', 'mali-t6', 'powervr sgx', 'adreno (tm) 3', 'intel(r) hd graphics 400',
];

const SAMPLE_COUNT = 90;
const CHECK_EVERY = 30;
const WARMUP_MS = 2000;
const DOWN_MEDIAN_MS = 28;
const UP_MEDIAN_MS = 11;
const UP_HOLD_MS = 10000;
const RETRY_UP_MEDIAN_MS = 14;
const MAX_CHANGES = 4;
const MIN_GAIN = 0.10; // two downgrades must buy at least 10% median frame time

function rungIndex(tier, scale) {
  for (let i = 0; i < RUNGS.length; i++) {
    if (RUNGS[i].tier === tier && Math.abs(RUNGS[i].scale - scale) < 0.01) return i;
  }
  for (let i = 0; i < RUNGS.length; i++) if (RUNGS[i].tier === tier) return i;
  return 2;
}

/**
 * The settings table. Pure function of tier, scale, device pixel ratio and
 * GPU capabilities.
 */
export function computeSettings(tier, scale, dpr, caps) {
  const high = tier === 'high';
  const medium = tier === 'medium';
  const low = !high && !medium;
  const halfFloatOK = !caps || caps.halfFloat !== false;
  const noFlow = !halfFloatOK;

  return Object.freeze({
    tier,
    scale,
    pixelRatio: high ? Math.min(dpr, 2) : medium ? Math.min(dpr, 1.5) : 1.0 * scale,
    antialias: high ? true : medium ? dpr < 2 : false,
    dynamicScaleLadder: low ? Object.freeze([1.0, 0.85, 0.7]) : null,
    fluidSimRes: high ? 256 : medium ? 128 : 96,
    fluidDyeRes: high ? 512 : medium ? 384 : 256,
    fluidDyeType: (high || medium) && halfFloatOK ? THREE.HalfFloatType : THREE.UnsignedByteType,
    pressureIterations: noFlow ? 0 : high ? 8 : medium ? 4 : 0,
    noFlow,
    simEveryNFrames: 1, // low switches to 2 at runtime when the last frame took > 33 ms
    bakedPaintRes: high ? 512 : medium ? 384 : 256,
    bristles: high ? 128 : medium ? 64 : 32,
    bristleRadiusScale: low ? 1.8 : medium ? 1.3 : 1.0,
    physicsSubstepsMax: high ? 3 : medium ? 2 : 1,
    bristleCollision: high ? 'plane+rays' : 'plane',
    nailShaderDefines: high
      ? Object.freeze({ GLITTER_2: '', WET_NORMAL_TAPS: '', ENV_LOD: '', HOLO: '' })
      : medium
        ? Object.freeze({ GLITTER_1: '', WET_NORMAL_DERIV: '', ENV_LOD: '' })
        : Object.freeze({ GLITTER_CHEAP: '' }),
    envCubeRes: high ? 256 : medium ? 128 : 64,
    envCubeType: high || medium ? THREE.HalfFloatType : THREE.UnsignedByteType,
    skin: high ? 'standard+env+rim' : medium ? 'standard+env' : 'lambert',
    rimLight: high,
    contactShadowRes: high ? 512 : medium ? 256 : 0,
    contactShadowBlurPasses: high ? 2 : medium ? 1 : 0,
    backdrop: high ? 'animated12' : medium ? 'animated8' : 'baked',
    renderOnDemand: !high,
    decoCanvasRes: low ? 512 : 1024,
    brushParticles: high ? 48 : medium ? 24 : 12,
    confetti: high ? 160 : medium ? 90 : 40,
    glints: !low,
  });
}

// The renderer's context attributes. The canvas is opaque (alpha: false):
// the scene always clears to an opaque colour, and an opaque canvas is
// cheaper for the browser to composite. A probe context without antialias
// is created with exactly these and handed to the renderer.
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  depth: true,
  stencil: false,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
});

/**
 * Probe the GPU (only when no tier is forced or saved). The probe context is
 * created without antialias; when the chosen tier wants no antialias it is
 * handed to the renderer instead of being thrown away (context creation is
 * slow on software GPUs). Returns { renderer, halfFloat, canvas, gl }.
 */
function probeGPU() {
  const out = { renderer: '', halfFloat: true, canvas: null, gl: null };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    if (!gl) {
      out.halfFloat = false;
      return out;
    }
    let name = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
    } catch (err) { /* ignore */ }
    if (!name) {
      try { name = gl.getParameter(gl.RENDERER) || ''; } catch (err) { /* ignore */ }
    }
    out.renderer = String(name);
    out.halfFloat = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    out.canvas = canvas;
    out.gl = gl;
  } catch (err) {
    // keep defaults
  }
  return out;
}

export class Quality {
  /**
   * @param {{ storage?: import('./Storage.js').Storage, events?: import('./GameEvents.js').GameEvents, params?: URLSearchParams }} opts
   */
  constructor({ storage = null, events = null, params = null } = {}) {
    this.storage = storage;
    this.events = events;
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.caps = { halfFloat: true, renderer: '' };

    const forced = params ? params.get('tier') : null;
    this.forced = TIERS.includes(forced) ? forced : null;
    this.autoSwitch = !this.forced;
    this._probe = null;

    let rung;
    if (this.forced) {
      rung = rungIndex(this.forced, 1.0);
    } else {
      const saved = storage ? storage.get('q.tier', null) : null;
      const savedScale = storage ? storage.get('q.scale', 1.0) : 1.0;
      if (TIERS.includes(saved)) {
        rung = rungIndex(saved, typeof savedScale === 'number' ? savedScale : 1.0);
      } else {
        const probe = probeGPU();
        this.caps.renderer = probe.renderer;
        this.caps.halfFloat = probe.halfFloat;
        rung = rungIndex(this._heuristicTier(probe), 1.0);
        if (probe.gl) this._probe = probe;
      }
    }
    this._rung = rung;
    this.tier = RUNGS[rung].tier;
    this.scale = RUNGS[rung].scale;
    this.settings = computeSettings(this.tier, this.scale, this.dpr, this.caps);

    // Sampling state (preallocated, no per-frame allocations).
    this._samples = new Float32Array(SAMPLE_COUNT);
    this._sorted = new Float32Array(SAMPLE_COUNT);
    this._sampleCount = 0;
    this._sampleHead = 0;
    this._sinceCheck = 0;
    this._overChecks = 0;
    this._fastSince = -1;
    this._changes = 0;
    this._upUsed = false;
    this._ignoreUntil = performance.now() + WARMUP_MS;
    this.lastMedian = 0;
    this._sessionMaxMedian = 0;
    this._persistedOnce = false;
    this._noPersist = false;        // set by the no-gain guard
    this._holdUntil = 0;            // see hold()
    this._held = false;
    // Consecutive automatic downgrades: rung we left and the median that triggered it.
    this._downFrom = [-1, -1];
    this._downMedian = [0, 0];
    this._downCount = 0;
    this._evalPending = false;

    this._payload = { tier: this.tier, scale: this.scale };

    // Keep the probe context only if the renderer can use it as is.
    if (this._probe && this.settings.antialias) this._releaseProbe();

    this._onVisibility = () => {
      if (document.visibilityState === 'hidden') this.persist();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
  }

  /**
   * Hand over the probe's canvas + context (no antialias) for the renderer,
   * or null. Can be taken once.
   */
  takeProbeContext() {
    const p = this._probe;
    this._probe = null;
    if (!p || !p.gl || p.gl.isContextLost()) return null;
    return { canvas: p.canvas, context: p.gl };
  }

  _releaseProbe() {
    const p = this._probe;
    this._probe = null;
    if (!p || !p.gl) return;
    try {
      const lose = p.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (err) { /* ignore */ }
  }

  _heuristicTier(probe) {
    if (!probe.halfFloat) return 'low';
    const name = (probe.renderer || '').toLowerCase();
    for (let i = 0; i < LOW_GPU_PATTERNS.length; i++) {
      if (name.indexOf(LOW_GPU_PATTERNS[i]) !== -1) return 'low';
    }
    const cores = navigator.hardwareConcurrency || 8;
    const mem = navigator.deviceMemory || 8;
    if (cores <= 4 || mem <= 4) return 'medium';
    return 'high';
  }

  /**
   * Called once the real renderer exists: confirms half-float render-target
   * support. If it is missing the game drops to low with noFlow.
   */
  setRendererCaps(renderer) {
    let half = true;
    try {
      const ext = renderer.extensions;
      half = !!(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
    } catch (err) {
      half = true;
    }
    if (half === this.caps.halfFloat) return;
    this.caps.halfFloat = half;
    if (!half && this.tier !== 'low') {
      this._apply(rungIndex('low', 1.0), true);
    } else {
      this.settings = computeSettings(this.tier, this.scale, this.dpr, this.caps);
      this._emit();
    }
  }

  /** Call once the game is interactive: the 2 s warm-up starts now. */
  markLoaded() {
    this._resetSampling();
  }

  /**
   * Suspend frame-time sampling, so a deliberate heavy moment (the Slay
   * reveal, a polaroid capture, a dynamic import) never causes a permanent
   * downgrade.
   *   quality.hold(4500)   // ignore samples for the next 4.5 s
   *   quality.hold()       // ignore samples until release()
   *   quality.release()    // resume (after the usual 2 s warm-up)
   * Holds do not stack: a timed hold extends to the latest end time, and
   * release() ends any hold.
   */
  hold(ms) {
    if (ms === undefined || ms === null || !isFinite(ms)) {
      this._held = true;
    } else {
      const until = performance.now() + Math.max(0, ms);
      if (until > this._holdUntil) this._holdUntil = until;
    }
    this._resetSampling();
  }

  release() {
    this._held = false;
    this._holdUntil = 0;
    this._resetSampling();
  }

  get isHeld() {
    return this._held || performance.now() < this._holdUntil;
  }

  /** Force a tier (debug / console: `app.quality.setTier('low')`). */
  setTier(tier, scale = 1.0) {
    if (!TIERS.includes(tier)) return;
    this._downCount = 0;
    this._evalPending = false;
    this._apply(rungIndex(tier, scale), true);
  }

  /** Feed one frame interval in ms. Called by FrameLoop. */
  sample(ms) {
    if (!this.autoSwitch) return;
    if (ms > 250 || ms <= 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = performance.now();
    if (now < this._ignoreUntil) return;
    if (this._held || now < this._holdUntil) return;

    this._samples[this._sampleHead] = ms;
    this._sampleHead = (this._sampleHead + 1) % SAMPLE_COUNT;
    if (this._sampleCount < SAMPLE_COUNT) this._sampleCount++;
    this._sinceCheck++;
    if (this._sinceCheck < CHECK_EVERY || this._sampleCount < CHECK_EVERY) return;
    this._sinceCheck = 0;

    const median = this._median();
    this.lastMedian = median;
    if (median > this._sessionMaxMedian) this._sessionMaxMedian = median;

    // No-gain guard: the first median after the second of two consecutive
    // downgrades must be at least 10% better than the median that triggered
    // the first. If not, the frame time is not ours to fix (a 30 fps rAF cap
    // in iOS low-power mode or a cross-origin iframe reads as 33 ms): go back
    // to where we started, stop switching, and never save that tier.
    if (this._evalPending) {
      this._evalPending = false;
      if (this._downCount >= 2 && median > this._downMedian[0] * (1 - MIN_GAIN)) {
        const back = this._downFrom[0];
        this._downCount = 0;
        this.autoSwitch = false;
        this._noPersist = true;
        this._apply(back, true);
        return;
      }
      if (this._downCount >= 2) {
        // The pair paid off; keep only the latest step as the start of the next pair.
        this._downFrom[0] = this._downFrom[1];
        this._downMedian[0] = this._downMedian[1];
        this._downCount = 1;
      }
    }

    if (this._changes >= MAX_CHANGES) return;

    // Down.
    if (median > DOWN_MEDIAN_MS) {
      this._overChecks++;
      this._fastSince = -1;
      if (this._overChecks >= 2 && this._rung < RUNGS.length - 1) {
        const k = this._downCount < 2 ? this._downCount : 1;
        this._downFrom[k] = this._rung;
        this._downMedian[k] = median;
        this._downCount = k + 1;
        this._evalPending = this._downCount >= 2;
        this._apply(this._rung + 1, false);
      }
      return;
    }
    this._overChecks = 0;

    // Up: once per session, medium -> high only.
    if (this.tier === 'medium' && !this._upUsed && median < UP_MEDIAN_MS) {
      if (this._fastSince < 0) this._fastSince = now;
      else if (now - this._fastSince >= UP_HOLD_MS) {
        this._upUsed = true;
        this._downCount = 0;
        this._apply(rungIndex('high', 1.0), false);
      }
    } else {
      this._fastSince = -1;
    }
  }

  _median() {
    const n = this._sampleCount;
    const sorted = this._sorted;
    // Insertion sort into the scratch buffer (n <= 90, runs every 30 frames).
    for (let i = 0; i < n; i++) {
      const v = this._samples[i];
      let j = i - 1;
      while (j >= 0 && sorted[j] > v) {
        sorted[j + 1] = sorted[j];
        j--;
      }
      sorted[j + 1] = v;
    }
    return n & 1 ? sorted[n >> 1] : 0.5 * (sorted[(n >> 1) - 1] + sorted[n >> 1]);
  }

  _apply(rung, manual) {
    if (rung === this._rung && !manual) return;
    const prevTier = this.tier;
    const prevScale = this.scale;
    this._rung = rung;
    this.tier = RUNGS[rung].tier;
    this.scale = RUNGS[rung].scale;
    this.settings = computeSettings(this.tier, this.scale, this.dpr, this.caps);
    if (!manual) this._changes++;
    this._resetSampling();
    if (prevTier !== this.tier || prevScale !== this.scale || manual) this._emit();
  }

  _resetSampling() {
    this._sampleCount = 0;
    this._sampleHead = 0;
    this._sinceCheck = 0;
    this._overChecks = 0;
    this._fastSince = -1;
    this._ignoreUntil = performance.now() + WARMUP_MS;
  }

  _emit() {
    this._payload.tier = this.tier;
    this._payload.scale = this.scale;
    if (this.events) this.events.emit(EVENTS.QUALITY_CHANGE, this._payload);
  }

  /**
   * Save the tier for the next visit. If the session stayed fast, the next
   * visit retries one rung higher.
   */
  persist() {
    if (!this.storage || this.forced || this._noPersist) return;
    let rung = this._rung;
    if (this._sessionMaxMedian > 0 && this._sessionMaxMedian < RETRY_UP_MEDIAN_MS && rung > 0) rung -= 1;
    this.storage.set('q.tier', RUNGS[rung].tier);
    this.storage.set('q.scale', RUNGS[rung].scale);
  }
}
