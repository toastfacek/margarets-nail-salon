/**
 * PolishBrush3D.js (brush plan B5: the stroke engine)
 * The polish brush: input samples -> a band of sheer polish on the nail
 * (PolishFilm) -> the brush rig posed on the same point (BristleSystem).
 *
 * One rule above all: the paint comes out of the bristle tips, and the tips
 * are where the finger (or cursor) is. Every input sample of the frame
 * (BrushInputHandler.beginFrame: coalesced events, edge crossings) becomes
 * one band segment, so curves are followed and nothing is skipped; the rig
 * is posed on the newest sample in the same frame.
 *
 * Per stroke, in nail-plane units (UV scaled by (aspect, 1)):
 *   band width  2*hw = nailWidth * (BAND_MIN + BAND_PRESS * pressure) * (1 - 0.25 * dry)
 *   axis        the brush's width direction: across the nail at the landing,
 *               then a critically damped spring toward across-the-motion
 *   load        1 at a dip, minus travel / (3.2 nail lengths); dry = 1 -
 *               smoothstep(0, 0.35, load): the band gets streaky and narrower
 *               but never stops painting. Lifting re-dips (brush:dip).
 *   coats       one pass lays COAT_ALPHA (sheer); passes build with "over".
 *   caps        landing (bead), resting (a pool that grows), lift (a bead
 *               left behind while the brush is overloaded).
 *
 * The film is bound to the active nail. When the active nail changes
 * (finger, hand, or the brush is put away) the dye is saved into the
 * previous nail's baked target and the next nail's baked paint is loaded.
 *
 * Coverage is counted on the CPU (CoverageMap, per segment): no readback.
 * Off-screen cost while painting: 1 dye draw (+1 film draw and 1 levelling
 * pass on medium/high). Idle: zero passes. No allocations per frame.
 */
import * as THREE from 'three';
import { BristleSystem } from './BristleSystem.js';
import { BrushInputHandler, SAMPLE_STRIDE } from './BrushInputHandler.js';
import { BrushEffects } from './BrushEffects.js';
import { PolishFilm, SEG_FLAGS } from './PolishFilm.js';
import { WetCure } from './WetCure.js';
import { CoverageMap } from '../../utils/CoverageMap.js';
import { EVENTS } from '../../core/GameEvents.js';
import { soundManager } from '../../audio/SoundManager.js';

// ------------------------------------------------------------- constants --

/** Alpha of one brush pass (sheer coat; two passes 0.86, three 0.95). */
export const COAT_ALPHA = 0.62;
const BAND_MIN = 0.182;           // 2*hw / nail width (UV arc) at the lightest touch
const BAND_PRESS = 0.14;         // ... plus this at full pressure (on screen: ~36% of the nail)
const HL_RATIO = 0.35;           // half contact length / half width of a band segment
const END_HL = 1.2;              // stroke ends: a round paddle print (x hw) past the end line
const CAP_HL = 1.0;              // taps, pools, reversals: round prints
const FAN_VISIBLE = 0.95;        // the fan spans the band's visible width (its outer edge is feathered)
const TOUCH_DOT = 0.2;           // x hw: the dot laid the moment the tips touch down
const PRINT_STILL = 0.35;        // s a press must stay still (no pointer event) before it prints the whole brush
const EDGE_ON_MIN = 0.6;         // band across the motion never under 60% of 2*hw
const DRY_NARROW = 0.25;         // dry brush: band this much narrower
const LOAD_LENGTHS = 3.2;        // nail lengths of stroke per load
const DRY_AT = 0.35;             // load under which the brush gets streaky
const DIR_STEP = 0.02;           // x nail width of travel per direction update
const AXIS_OMEGA = 38;           // 1/s, critically damped (90 deg turn -> ~5 deg in 120 ms)
const REVERSAL = -0.3;           // dot of directions: a hard turn gets a cap pair
const POOL_DELAY = 0.25;         // s still before a pool starts (a press before moving is not a rest)
const POOL_EVERY = 0.1;          // s: then resting adds a pool cap this often
const POOL_GROW = 0.06;          // per cap, wider by this ...
const POOL_MAX = 0.25;           // ... up to this
const POOL_LOAD = 0.008;         // load per pool cap
const POOL_STILL = 0.02;         // x nail width: moving more than this resets the pool
const LEAD_TEXELS = 2;           // the band leads the newest sample by this many dye texels
const REDIP_DELAY = 0.12;        // s after a lift ...
const REDIP_TIME = 0.33;         // ... the load eases back to 1 over this
const COVERAGE_CORE = 0.97;      // the band is solid nearly to its edge
const COVERAGE_RES = 32;
const COVERED_AT = 0.9;
const LANDING_BEAD = 0.6;
const DRY_MAX = 0.6;             // a dry brush still lays streaks (about half a band)
const FLICK_SPEED = 2.6;         // nail widths / s: a flick off the free edge or a hard reversal
const FLICKS_PER_STROKE = 3;
const AUTO_PRESSURE = 0.8;

const INITIAL_POSITION = Object.freeze(new THREE.Vector3(0, 0.2, 0));
const INITIAL_NORMAL = Object.freeze(new THREE.Vector3(0, 1, 0));

function smooth01(x) {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function filmOptions(settings) {
  return {
    dyeRes: settings.fluidDyeRes,
    dyeType: settings.fluidDyeType,
    filmRes: settings.filmRes === undefined ? 192 : settings.filmRes,
  };
}

/**
 * Per-nail geometry the engine needs, computed once per nail (allocates):
 * PolishFilm.nailFrame (plane-unit width, length, directions) plus a linear
 * fit world = C + Ju * px + Jv * py over the nail's vertices, used to turn
 * plane-unit directions and sizes into world ones for the rig.
 */
function computeNailGeom(handModel, hand, finger) {
  const f = PolishFilm.nailFrame(handModel, hand, finger);
  if (!f) return null;
  const rec = handModel.getNail(hand, finger);
  const mesh = rec.mesh;
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  const aspect = f.aspect;
  const M = new Float64Array(9);
  const B = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
  const v = new THREE.Vector3();
  const r = [0, 0, 1];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    r[0] = uv.getX(i) * aspect;
    r[1] = uv.getY(i);
    for (let j = 0; j < 3; j++) {
      B[0][j] += r[j] * v.x;
      B[1][j] += r[j] * v.y;
      B[2][j] += r[j] * v.z;
      for (let k = 0; k < 3; k++) M[j * 3 + k] += r[j] * r[k];
    }
  }
  const solve = (b) => {
    const m = Array.from(M), y = Array.from(b);
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(m[j * 3 + i]) > Math.abs(m[p * 3 + i])) p = j;
      for (let k = 0; k < 3; k++) { const t = m[i * 3 + k]; m[i * 3 + k] = m[p * 3 + k]; m[p * 3 + k] = t; }
      const t = y[i]; y[i] = y[p]; y[p] = t;
      for (let j = i + 1; j < 3; j++) {
        const q = m[j * 3 + i] / (m[i * 3 + i] || 1e-12);
        for (let k = i; k < 3; k++) m[j * 3 + k] -= q * m[i * 3 + k];
        y[j] -= q * y[i];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < 3; k++) s -= m[i * 3 + k] * x[k];
      x[i] = s / (m[i * 3 + i] || 1e-12);
    }
    return x;
  };
  const X = solve(B[0]), Y = solve(B[1]), Z = solve(B[2]);
  const ju = new THREE.Vector3(X[0], Y[0], Z[0]);
  const jv = new THREE.Vector3(X[1], Y[1], Z[1]);
  const c = new THREE.Vector3(X[2], Y[2], Z[2]);
  const n = new THREE.Vector3().crossVectors(ju, jv).normalize();
  if (n.y < 0) n.negate();
  const perPlane = Math.sqrt(ju.length() * jv.length()) || 1;
  return Object.assign(f, { ju, jv, c, n, perPlane });
}

export class PolishBrush3D {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {import('../../scene/HandModel.js').HandModel} handModel
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ events?: object, settings?: object, invalidate?: () => void }} [opts]
   */
  constructor(scene, camera, handModel, renderer = null, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.handModel = handModel;
    this.renderer = renderer;
    this.events = opts.events || null;
    this.invalidate = opts.invalidate || (() => {});
    this.settings = opts.settings || null;

    this.isActive = false;
    this.isPainting = false;

    this.color = '#ff2a6d';
    this.finish = 'glossy';
    this._colorSRGB = new THREE.Vector3();
    this._setColorSRGB(this.color);

    const s = this.settings;
    this.bristleSystem = new BristleSystem(s ? s.bristles : 128);
    if (s) {
      this.bristleSystem.configure({
        bristles: s.bristles,
        radiusScale: s.bristleRadiusScale || 1,
        substeps: s.physicsSubstepsMax,
        collision: s.bristleCollision,
      });
    }
    this.bristleSystem.setCamera(camera);
    this.inputHandler = null;
    this.brushEffects = new BrushEffects(scene);
    if (s) this.brushEffects.setQuality(s);
    this.wetCure = new WetCure(handModel, this.events);

    // The paint film (PolishFilm). Also named fluidSim for older readers.
    this.fluidSim = null;
    this.film = null;
    this.useFluidSim = true;
    this._frame = 0;

    // Shared raycaster (perf harness contract: app.polishBrush3D.raycaster)
    this.raycaster = new THREE.Raycaster();

    // UI callbacks (kept for compatibility)
    this.onCoverageChange = null;
    this.onPaintStart = null;
    this.onPaintEnd = null;

    // Which nail the film is bound to, and its geometry.
    this._boundHand = null;
    this._boundFinger = null;
    this._dyeDirty = false;
    this._geoms = new Map();
    this._g = null;

    // ---- stroke state (plane units; no allocation while painting) ----
    this._strokeOpen = false;     // this press has laid paint (stroke events sent)
    this._chain = false;          // a segment chain is running (on the nail)
    this._px = 0; this._py = 0;   // where the band currently ends (plane)
    this._qx = 0; this._qy = 0;   // the last sample it was laid to
    this._hasSeg = false;
    this._sdx = 1; this._sdy = 0; // direction of the last segment
    this._ancX = 0; this._ancY = 0;
    this._hasDir = false;
    this._dirX = 1; this._dirY = 0;
    this._axA = 0;                // axis angle (plane), continuous
    this._axV = 0;
    this._axT = 0;                // stroke clock (ms) of the axis spring
    this._lastQx = 0; this._lastQy = 0; this._lastQt = 0; this._hasLastQ = false;
    this._vx = 0; this._vy = 0;   // plane velocity (units/s), smoothed
    this._pressure = 0;
    this._load = 1;
    this._dry = 0;
    this._segs = 0;               // segments laid in this stroke
    this._holdT = 0;
    this._lastSampleMs = 0;       // stroke time of the newest input sample
    this._poolK = 0;
    this._poolX = 0; this._poolY = 0;
    this._flicks = 0;
    this._strokeSeed = 0;
    this._sinceLift = -1;         // s since the last lift (-1: no re-dip pending)
    this._dipEmitted = false;
    this._hw = 0;                 // half width now (plane units)
    this._printed = false;        // a still press has printed (the stroke's back end)
    this._chainFrame = 0;
    this._backCap = false;
    this._depU = 0; this._depV = 0;

    // Pose for the rig (4.4), reused.
    this._pose = {
      point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), axis: new THREE.Vector3(1, 0, 0),
      velocity: new THREE.Vector3(), halfWidth: 0, pressure: 0, load: 1, contact: false,
      isTouch: false, scale: 0.068, onSurface: false,
    };
    this._lastContactP = new THREE.Vector3();
    this._lastContactN = new THREE.Vector3(0, 1, 0);
    this._hasContactPlane = false;
    this._needsPose = true;
    this._lastCamera = new THREE.Matrix4();
    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._hits = [];

    // Auto strokes (intro demo)
    this._autoActive = false;
    this._autoFrame = -10;
    this._autoT = 0;

    // Juice
    this._speed = 0;            // smoothed stroke speed, plane units / s
    this._lastDt = 1 / 60;

    // Reused event payloads
    this._strokeStartPayload = { hand: 'left', finger: 'index', color: this.color, finish: this.finish };
    this._strokePayload = { speed: 0, pressure: 0, u: 0, v: 0, worldPos: new THREE.Vector3() };
    this._strokeEndPayload = { hand: 'left', finger: 'index' };
    this._coveragePayload = { hand: 'left', finger: 'index', coverage: 0 };
    this._coveredPayload = { hand: 'left', finger: 'index' };
    this._dipPayload = { color: this.color };

    // Harness hook (plan 4.7): only refreshed with ?perf=1 or window.__brushDebug.
    this.debug = null;
    this._debugOn = false;
    try {
      this._debugOn = /[?&]perf=1(&|$)/.test(window.location.search) || !!window.__brushDebug;
    } catch (e) { /* no window */ }
    if (this._debugOn) {
      this.debug = { tipScreen: [0, 0], depositScreen: [0, 0], halfWidthPx: 0, axisAngle: 0, load: 1, dry: 0 };
    }
    this._rect = { left: 0, top: 0, width: 1, height: 1 };
    this._refreshRect = this._refreshRect.bind(this);

    this.bristleSystem.setVisible(false);
    this.bristleSystem.setBrushTransform(INITIAL_POSITION, INITIAL_NORMAL);
    this.scene.add(this.bristleSystem.group);

    if (this.events) {
      this._onNailSelect = () => this._rebind();
      this.events.on(EVENTS.NAIL_SELECT, this._onNailSelect);
    }

    if (this.renderer) this.initFluidSim();
  }

  _setColorSRGB(color) {
    const c = PolishBrush3D._tmpColor.set(color);
    c.getRGB(PolishBrush3D._tmpRGB, THREE.SRGBColorSpace);
    this._colorSRGB.set(PolishBrush3D._tmpRGB.r, PolishBrush3D._tmpRGB.g, PolishBrush3D._tmpRGB.b);
  }

  setRenderer(renderer) {
    this.renderer = renderer;
    if (this.renderer && !this.film) this.initFluidSim();
  }

  /** Create the paint film (the name is kept from the fluid-sim days). */
  initFluidSim() {
    if (!this.renderer || this.film) return;
    const opts = this.settings ? filmOptions(this.settings) : {};
    this.film = new PolishFilm(this.renderer, opts);
    this.fluidSim = this.film;
  }

  /**
   * Compile every film pass and the rig now so the first stroke never
   * compiles. The droplet program is compiled at idle time after load
   * (brushJuice feature, `brushEffects.prewarm()`).
   */
  prewarm() {
    if (this.film) this.film.prewarm();
    if (this.renderer) this.bristleSystem.prewarm(this.renderer, this.camera, this.scene);
  }

  // ------------------------------------------------------------ coverage --

  /** The nail's CoverageMap (lazy, stored on the nail record). */
  getCoverageMap(hand, finger, create = true) {
    const rec = this.handModel ? this.handModel.getNail(hand, finger) : null;
    if (!rec) return null;
    if (!rec.coverageMap && create) {
      rec.coverageMap = new CoverageMap(COVERAGE_RES, this.handModel.getNailMask(hand, finger));
    }
    return rec.coverageMap || null;
  }

  /** 0..1 coverage of a nail (defaults to the active nail). */
  getCoverage(hand = this.handModel.getCurrentHand(), finger = this.handModel.getActiveNail()) {
    const map = this.getCoverageMap(hand, finger, false);
    return map ? map.coverage : 0;
  }

  /** Announce coverage on >= 1% change, and the first 0.9 crossing. */
  _reportCoverage(hand, finger, map, force) {
    const c = map.coverage;
    const rec = this.handModel.getNail(hand, finger);
    if (rec) rec.coverage = c;
    const delta = c - map.lastReported;
    if (force || delta >= 0.01 || delta <= -0.01 || (c === 1 && map.lastReported < 1)) {
      map.lastReported = c;
      if (this.events) {
        const p = this._coveragePayload;
        p.hand = hand;
        p.finger = finger;
        p.coverage = c;
        this.events.emit(EVENTS.NAIL_COVERAGE, p);
      }
      if (this.onCoverageChange && hand === this.handModel.getCurrentHand() && finger === this.handModel.getActiveNail()) {
        this.onCoverageChange(c * 100);
      }
    }
    if (!map.coveredFired && c >= COVERED_AT) {
      map.coveredFired = true;
      if (this.events) {
        const p = this._coveredPayload;
        p.hand = hand;
        p.finger = finger;
        this.events.emit(EVENTS.NAIL_COVERED, p);
      }
    }
  }

  // ------------------------------------------------------------- binding --

  _geom(hand, finger) {
    const key = hand + ':' + finger;
    let g = this._geoms.get(key);
    if (!g) {
      g = computeNailGeom(this.handModel, hand, finger);
      if (g) this._geoms.set(key, g);
    }
    return g || null;
  }

  /** Bind the film to the currently active nail (save previous, load next). */
  _rebind() {
    if (!this.film || !this.handModel) return;
    const hand = this.handModel.getCurrentHand();
    const finger = this.handModel.getActiveNail();
    if (!this.isActive) {
      this._unbind();
      return;
    }
    if (hand === this._boundHand && finger === this._boundFinger) return;
    this._unbind();
    if (!this.handModel.getNail(hand, finger)) return;

    const g = this._geom(hand, finger);
    if (!g) return;
    this._g = g;
    const baked = this.handModel.getPaintTarget(hand, finger, false);
    this.film.loadDye(baked ? baked.texture : null);
    this.film.setAspect(g.aspect);
    this._boundHand = hand;
    this._boundFinger = finger;
    this._dyeDirty = false;
    this.handModel.setPaintTexture(hand, finger, this.film.getTexture());
    if (this.handModel.setFilmTexture) this.handModel.setFilmTexture(hand, finger, this.film.getFilmTexture());
    this._needsPose = true;
    this.invalidate();
  }

  /** Save the dye into the bound nail's baked target and show that instead. */
  _unbind() {
    const hand = this._boundHand;
    const finger = this._boundFinger;
    if (hand === null) return;
    this._endStroke();
    const hm = this.handModel;
    let baked = hm.getPaintTarget(hand, finger, false);
    if (this._dyeDirty || baked) {
      baked = hm.getPaintTarget(hand, finger, true);
      this.film.saveDye(baked);
      hm.setPaintTexture(hand, finger, baked.texture);
    } else {
      hm.setPaintTexture(hand, finger, null);
    }
    if (hm.setFilmTexture) hm.setFilmTexture(hand, finger, null);
    this._boundHand = null;
    this._boundFinger = null;
    this._g = null;
    this._dyeDirty = false;
    this.invalidate();
  }

  _refreshBoundTexture() {
    if (this._boundHand !== null) {
      this.handModel.setPaintTexture(this._boundHand, this._boundFinger, this.film.getTexture());
      if (this.handModel.setFilmTexture) this.handModel.setFilmTexture(this._boundHand, this._boundFinger, this.film.getFilmTexture());
    }
  }

  // ------------------------------------------------------- activation --

  _refreshRect() {
    const el = this.renderer ? this.renderer.domElement : null;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    this._rect.left = r.left;
    this._rect.top = r.top;
    this._rect.width = r.width || 1;
    this._rect.height = r.height || 1;
  }

  activate() {
    if (this.isActive) return;
    this.isActive = true;
    if (this.renderer && !this.film) this.initFluidSim();

    const canvas = document.querySelector('#canvas-container canvas');
    const canvasContainer = document.querySelector('#canvas-container');
    if (canvas) {
      const max = this.settings && this.settings.strokeSamplesMax ? this.settings.strokeSamplesMax : 8;
      this.inputHandler = new BrushInputHandler(this.camera, canvas, { maxSamples: max });
      this.inputHandler.attach();
    }
    if (canvasContainer) canvasContainer.classList.add('polish-brush-active');
    if (this._debugOn) {
      this._refreshRect();
      window.addEventListener('resize', this._refreshRect);
    }

    this.bristleSystem.setVisible(true);
    this.bristleSystem.setColor(this.color);
    this.brushEffects.setVisible(true);
    this._needsPose = true;

    soundManager.init();
    this._rebind();
    this.invalidate();
  }

  deactivate() {
    if (!this.isActive) return;
    this._endStroke();
    this.isActive = false;
    this.isPainting = false;
    this._unbind();

    if (this.inputHandler) {
      this.inputHandler.detach();
      this.inputHandler = null;
    }
    if (this._debugOn) window.removeEventListener('resize', this._refreshRect);
    const canvasContainer = document.querySelector('#canvas-container');
    if (canvasContainer) canvasContainer.classList.remove('polish-brush-active');

    this.bristleSystem.setVisible(false);
    this.brushEffects.setVisible(false);
    this.invalidate();
  }

  // ----------------------------------------------------------- settings --

  setColor(color) {
    this.color = color;
    this._setColorSRGB(color);
    this.bristleSystem.setColor(color);
    this.brushEffects.setColor(color);
    this.dip(); // picking a bottle dips the brush
    this.invalidate();
  }

  setFinish(finish) {
    this.finish = finish;
    if (this.handModel) this.handModel.setFinish(finish);
    this.invalidate();
  }

  /** Dip the brush now: fully loaded (emits brush:dip). */
  dip() {
    this._setLoad(1);
    this._sinceLift = -1;
    this.bristleSystem.setLoad(1);
    this._needsPose = true;
    this._emitDip();
  }

  _emitDip() {
    if (!this.events) return;
    this._dipPayload.color = this.color;
    this.events.emit(EVENTS.BRUSH_DIP, this._dipPayload);
  }

  /**
   * Apply quality settings: film resolution, bristle count, samples per
   * frame and baked-paint resolution. Paint is preserved.
   */
  setQuality(settings) {
    this.settings = settings;
    this.brushEffects.setQuality(settings);
    this.bristleSystem.configure({
      bristles: settings.bristles,
      radiusScale: settings.bristleRadiusScale || 1,
      substeps: settings.physicsSubstepsMax,
      collision: settings.bristleCollision,
    });
    if (this.inputHandler) this.inputHandler.setMaxSamples(settings.strokeSamplesMax || 8);
    if (this.film) {
      if (this.film.setQuality(filmOptions(settings))) this._refreshBoundTexture();
      const film = this.film;
      this.handModel.resizePaintTargets(settings.bakedPaintRes, (src, dst) => film.blit(src, dst));
    }
    this._needsPose = true;
    this.invalidate();
  }

  getNailMesh() {
    return this.handModel ? this.handModel.getNailMesh() : null;
  }

  // ------------------------------------------------------------ strokes --

  _endStroke() {
    if (this._autoActive) this._endAutoStroke();
    if (!this.isPainting) return;
    this._liftStroke();
    this.isPainting = false;
  }

  /** The brush leaves the nail: lift cap, events, re-dip timer. */
  _liftStroke() {
    if (this._chain && this._g && this._boundHand !== null) {
      // A tap (nothing laid yet) prints a full coat; a stroke's lift adds half.
      const overload = smooth01((this._load - 0.7) / 0.3);
      const hw = this._halfWidth(this._pressure);
      if (this._segs === 0) {
        // a tap: the whole pressed brush print, with the landing bead
        if (!this._printed) this._print(hw, Math.max(LANDING_BEAD, overload * 0.9));
      } else if (this._hasSeg) {
        // the band's end: the paddle's print past the last sample, tiled
        // onto the band (one coat, no overlap); a bead left while overloaded
        this._endCap(this._sdx, this._sdy, hw, SEG_FLAGS.CAP_END, overload * 0.9);
      }
      this.film.flush();
    }
    this._chain = false;
    this._hasSeg = false;
    this._hasLastQ = false;
    if (this._strokeOpen) {
      this._strokeOpen = false;
      this._emitStrokeEnd();
      if (this._load < 1) {
        this._sinceLift = 0;
        this._dipEmitted = false;
      }
    }
  }

  _emitStrokeEnd() {
    const hand = this._boundHand || this.handModel.getCurrentHand();
    const finger = this._boundFinger || this.handModel.getActiveNail();
    this.wetCure.release(hand, finger);
    if (this.events) {
      this._strokeEndPayload.hand = hand;
      this._strokeEndPayload.finger = finger;
      this.events.emit(EVENTS.BRUSH_STROKE_END, this._strokeEndPayload);
    }
    if (this.onPaintEnd) this.onPaintEnd();
  }

  _emitStrokeStart() {
    this.wetCure.wet(this._boundHand, this._boundFinger);
    if (this.events) {
      const p = this._strokeStartPayload;
      p.hand = this._boundHand;
      p.finger = this._boundFinger;
      p.color = this.color;
      p.finish = this.finish;
      this.events.emit(EVENTS.BRUSH_STROKE_START, p);
    }
    if (this.onPaintStart) this.onPaintStart();
  }

  _emitStroke(speed, pressure, u, v, worldPos) {
    if (!this.events) return;
    const p = this._strokePayload;
    p.speed = speed;
    p.pressure = pressure;
    p.u = u;
    p.v = v;
    p.worldPos.copy(worldPos);
    this.events.emit(EVENTS.BRUSH_STROKE, p);
  }

  /** A press began (on or off the nail). Paint starts at the first on-nail sample. */
  _pressStart() {
    this.isPainting = true;
    this._lastSampleMs = 0;
    this._printed = false;        // a still press has printed (the stroke's back end)
    this._chainFrame = 0;
    this._backCap = false;
    this._strokeOpen = false;
    this._chain = false;
    this._hasSeg = false;
    this._hasLastQ = false;
    this._hasDir = false;
    this._segs = 0;
    this._holdT = 0;
    this._poolK = 0;
    this._flicks = 0;
    this._speed = 0;
    this._vx = this._vy = 0;
    const g = this._g;
    if (g) {
      this._axA = Math.atan2(g.acrossY, g.acrossX);
      this._axV = 0;
    }
  }

  _openStroke() {
    if (this._strokeOpen) return;
    this._strokeOpen = true;
    this._strokeSeed = Math.random() * 6.2831;
    this.film.beginStroke(this._colorSRGB, this._strokeSeed, this._g.aspect);
    this._emitStrokeStart();
  }

  /** Half band width now, plane units. */
  _halfWidth(pressure) {
    const g = this._g;
    return 0.5 * g.widthV * (BAND_MIN + BAND_PRESS * pressure) * (1 - DRY_NARROW * this._dry);
  }

  _setLoad(load) {
    this._load = load < 0 ? 0 : load > 1 ? 1 : load;
    this._dry = DRY_MAX * (1 - smooth01(this._load / DRY_AT));
  }

  /** Advance the axis spring by dt seconds toward across-the-direction. */
  _stepAxis(dt) {
    if (!(dt > 0) || !this._hasDir) return;
    if (dt > 0.1) dt = 0.1;
    let d = Math.atan2(this._dirY, this._dirX) + Math.PI * 0.5 - this._axA;
    d -= Math.PI * Math.round(d / Math.PI); // modulo 180 degrees, the shortest way
    const target = this._axA + d;
    const w = AXIS_OMEGA;
    const steps = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this._axV += (w * w * (target - this._axA) - 2 * w * this._axV) * h;
      this._axA += this._axV * h;
    }
  }

  /** One unclipped cap (landing / pool / lift / reversal) at a plane point. */
  _cap(px, py, hw, hl, flags, bead, coat) {
    const g = this._g;
    const ax = Math.cos(this._axA), ay = Math.sin(this._axA);
    const u = px / g.aspect, v = py;
    this.film.addSegment(u, v, u, v, ax, ay, hw, hl, 0, 0, flags, this._dry, this._dry, bead, coat);
    this._dyeDirty = true;
    // coverage: a capsule along the axis (the rounded box with r = hl)
    const r = Math.min(hw, hl);
    const e = Math.max(0, hw - r);
    this._cover(u - ax * e / g.aspect, v - ay * e, u + ax * e / g.aspect, v + ay * e, r * (1 - 0.5 * this._dry), coat);
  }

  /**
   * A stroke end at the band's current end (px, py): the rounded paddle print
   * on the side (dx, dy) points to, clipped at the end line so it tiles with
   * the band (one coat, no darker overlap).
   */
  _endCap(dx, dy, hw, flags, bead) {
    const g = this._g;
    const ax = Math.cos(this._axA), ay = Math.sin(this._axA);
    const u = this._px / g.aspect, v = this._py;
    const hl = hw * END_HL;
    this.film.addSegment(u, v, u, v, ax, ay, hw, hl, dx, dy, flags | SEG_FLAGS.CLIP_START, this._dry, this._dry, bead, COAT_ALPHA);
    this._dyeDirty = true;
    // coverage: as far as the paddle reaches across and past the end
    const e = hl * 0.8;
    const across = hw * Math.abs(ax * dy - ay * dx) + hl * Math.abs(ax * dx + ay * dy);
    this._cover(u, v, u + dx * e / g.aspect, v + dy * e, Math.min(across, hw) * (1 - 0.5 * this._dry), COAT_ALPHA);
  }

  /** A cap with its own axis (ax, ay unit, plane units); no coverage (it lies inside the band). */
  _capAt(px, py, ax, ay, hw, hl, flags, bead, coat) {
    const g = this._g;
    const u = px / g.aspect;
    this.film.addSegment(u, py, u, py, ax, ay, hw, hl, 0, 0, flags, this._dry, this._dry, bead, coat);
    this._dyeDirty = true;
  }

  _cover(u0, v0, u1, v1, radius, coat) {
    if (coat < COAT_ALPHA * 0.75) return; // half-coat caps alone are not a coat
    const hand = this._boundHand, finger = this._boundFinger;
    const map = this.getCoverageMap(hand, finger, true);
    if (map && map.addSegment(u0, v0, u1, v1, radius, this._g.aspect, COVERAGE_CORE)) this._reportCoverage(hand, finger, map, false);
  }

  /** First point of a chain at plane (x, y): a landing cap unless it slid in over the edge. */
  _startChain(x, y, landing, pressure) {
    this._openStroke();
    this._chain = true;
    this._hasSeg = false;
    this._px = x;
    this._py = y;
    this._qx = x;
    this._qy = y;
    this._ancX = x;
    this._ancY = y;
    this._poolX = x;
    this._poolY = y;
    // The landing is laid with the first segment, aligned with the first
    // motion and tiled onto the band (one coat). A press that stays still for
    // a frame prints the brush instead (see update()).
    this._backCap = landing;
    this._printed = false;
    this._chainFrame = this._frame;
    if (landing) {
      // the bristle tips touch down: a small soft dot of polish right under
      // them, in this very frame (the band's round back end covers it)
      const hw = this._halfWidth(pressure);
      this._capAt(x, y, Math.cos(this._axA), Math.sin(this._axA), hw * TOUCH_DOT, hw * TOUCH_DOT,
        SEG_FLAGS.CAP_START | SEG_FLAGS.CAP_END, LANDING_BEAD, COAT_ALPHA * 0.85);
    }
  }

  /** The pressed brush's round print at the band's end (a tap, or a press before moving). */
  _print(hw, bead) {
    this._cap(this._px, this._py, hw * 1.04, hw * CAP_HL, SEG_FLAGS.CAP_START | SEG_FLAGS.CAP_END, bead, COAT_ALPHA);
    this._printed = true;
    this._backCap = false;
  }

  /**
   * One input sample at plane (qx, qy), stroke time tMs; edge/dir from the
   * input (dir +1 entry, -1 exit). Lays the band from its current end to
   * here, updating direction, axis, load and coverage.
   */
  _feed(qx, qy, tMs, edge, dir, pressure) {
    const g = this._g;
    this._pressure = pressure;
    // velocity (plane units / s), from consecutive samples
    if (this._hasLastQ) {
      const dts = (tMs - this._lastQt) * 0.001;
      if (dts > 0.0005) {
        const k = 1 - Math.exp(-dts / 0.03);
        this._vx += ((qx - this._lastQx) / dts - this._vx) * k;
        this._vy += ((qy - this._lastQy) / dts - this._vy) * k;
      }
    }
    this._lastQx = qx; this._lastQy = qy; this._lastQt = tMs; this._hasLastQ = true;

    if (!this._chain) {
      this._axT = tMs;
      this._startChain(qx, qy, !(edge && dir > 0) && !this._strokeOpen, pressure);
      return;
    }

    // direction (updated every DIR_STEP of a nail width) and the axis spring
    const ddx = qx - this._ancX, ddy = qy - this._ancY;
    const dd = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dd > DIR_STEP * g.widthV) {
      this._dirX = ddx / dd;
      this._dirY = ddy / dd;
      this._ancX = qx;
      this._ancY = qy;
      this._hasDir = true;
    }
    this._stepAxis((tMs - this._axT) * 0.001);
    if (tMs > this._axT) this._axT = tMs;

    // The band ends a little past the newest sample, along the motion from
    // the previous sample (A3: the newest point is painted in its frame).
    const lead = LEAD_TEXELS / this.film.opts.dyeRes;
    const exit = edge && dir < 0;
    let mx = qx - this._qx, my = qy - this._qy;
    const ml = Math.sqrt(mx * mx + my * my);
    if (ml < 1e-7 && !exit) return;
    if (ml > 1e-7) { mx /= ml; my /= ml; } else { mx = this._sdx; my = this._sdy; }
    const bx = exit ? qx : qx + mx * lead;
    const by = exit ? qy : qy + my * lead;
    let dx = bx - this._px, dy = by - this._py;
    let l = Math.sqrt(dx * dx + dy * dy);
    // not past the band's current end yet (it already covers this sample)
    if (!exit && (dx * mx + dy * my < 0.25 * lead || l < 0.25 * lead)) return;
    if (l < 1e-7) {
      this._chain = false; this._hasSeg = false;
      return;
    }
    const ux = dx / l, uy = dy / l;
    this._qx = qx; this._qy = qy;
    if (!this._hasSeg && !this._hasDir) {
      // The chain's first motion: the paddle lands already across it (the
      // axis spring is for turns; turning from a default axis here would
      // start the band edge-on, pinched, behind a full-width back cap).
      let a = Math.atan2(uy, ux) + Math.PI * 0.5;
      a -= Math.PI * Math.round((a - this._axA) / Math.PI);
      this._axA = a; this._axV = 0;
      this._dirX = ux; this._dirY = uy; this._hasDir = true;
      this._ancX = qx; this._ancY = qy;
    }

    const ax = Math.cos(this._axA), ay = Math.sin(this._axA);
    const hw = this._halfWidth(pressure);
    let hl = hw * HL_RATIO;
    // edge-on: keep the band at least 60% as wide across the motion
    const nx = -uy, ny = ux;
    const cx = Math.abs(ax * nx + ay * ny);
    const cy = Math.abs(-ay * nx + ax * ny);
    let across = hw * cx + hl * cy;
    if (across < EDGE_ON_MIN * hw) {
      hl = (EDGE_ON_MIN * hw - hw * cx) / Math.max(cy, 1e-3);
      across = EDGE_ON_MIN * hw;
    }

    let flags = exit ? 0 : SEG_FLAGS.CLIP_END;
    if (!this._hasSeg && (this._backCap || this._printed)) {
      // first segment after a landing: the band starts at the landing point
      // and its back end is the paddle's round print behind it, aligned with
      // this first motion and tiled (one coat; after a still press, the print
      // is the back end).
      this._sdx = ux; this._sdy = uy;
      flags |= SEG_FLAGS.CLIP_START;
      if (this._backCap) this._endCap(-ux, -uy, hw, SEG_FLAGS.CAP_START, LANDING_BEAD);
      this._backCap = false;
    } else if (this._hasSeg) {
      if (ux * this._sdx + uy * this._sdy < REVERSAL) {
        // hard reversal: a cap pair, no seam clip
        this._cap(this._px, this._py, hw, hw * CAP_HL, SEG_FLAGS.CAP_END | SEG_FLAGS.CAP_START, 0, COAT_ALPHA * 0.5);
        this._flick(this._px, this._py, true);
      } else {
        flags |= SEG_FLAGS.CLIP_START;
      }
    }
    const dryA = this._dry;
    this._setLoad(this._load - l / (LOAD_LENGTHS * g.lengthV));
    const overload = smooth01((this._load - 0.7) / 0.3);
    const asp = g.aspect;
    const u0 = this._px / asp, v0 = this._py, u1 = bx / asp, v1 = by;
    this.film.addSegment(u0, v0, u1, v1, ax, ay, hw, hl, this._sdx, this._sdy, flags, dryA, this._dry, 0.22 * overload, COAT_ALPHA);
    this._dyeDirty = true;
    this._segs++;
    this._cover(u0, v0, u1, v1, across * (1 - 0.5 * this._dry), COAT_ALPHA);

    this._sdx = ux; this._sdy = uy; this._hasSeg = true;
    this._px = bx; this._py = by;
    // moving on resets the pool
    const pdx = bx - this._poolX, pdy = by - this._poolY;
    if (pdx * pdx + pdy * pdy > (POOL_STILL * g.widthV) ** 2) {
      this._poolK = 0;
      this._holdT = 0;
      this._poolX = bx; this._poolY = by;
    }
    if (exit) {
      this._chain = false;
      this._hasSeg = false;
      if (this._isFreeEdge(qx, qy)) this._flick(qx, qy, false);
    }
  }

  /** Is plane point (x, y) toward the free edge (not the cuticle)? */
  _isFreeEdge(x, y) {
    const g = this._g;
    const a = ((x - g.cx) * g.alongX + (y - g.cy) * g.alongY) / (0.5 * g.lengthV);
    return a < -0.45;
  }

  /** Droplets on a fast flick off the free edge or a hard reversal (<= 3 per stroke). */
  _flick(qx, qy, reversal) {
    const g = this._g;
    if (this._flicks >= FLICKS_PER_STROKE) return;
    const sp = Math.sqrt(this._vx * this._vx + this._vy * this._vy) / g.widthV;
    if (sp < FLICK_SPEED * (reversal ? 1.3 : 1)) return;
    const n = Math.min(FLICKS_PER_STROKE - this._flicks, reversal ? 1 : 2);
    this._flicks += n;
    const P = this._planeToWorld(qx, qy, this._v0);
    const N = this._v2.copy(g.n);
    const vel = this._v1.copy(g.ju).multiplyScalar(this._vx).addScaledVector(g.jv, this._vy);
    this.brushEffects.emitFlick(P, N, this._pose.axis, this._hw * g.perPlane, vel, n);
  }

  /** Plane point -> world point on the nail's fit plane. */
  _planeToWorld(x, y, out) {
    const g = this._g;
    return out.copy(g.c).addScaledVector(g.ju, x).addScaledVector(g.jv, y);
  }

  // --------------------------------------------------------- per frame --

  /**
   * Per-frame update (FrameLoop order 10).
   * @param {number} dt seconds, from the loop
   */
  update(dt) {
    if (!this.isActive) return;
    this._frame++;
    if (dt > 0) this._lastDt = dt;
    const hm = this.handModel;

    // An autoStroke() sequence ends when a frame passes without a call.
    if (this._autoActive && this._frame > this._autoFrame + 1) this._endAutoStroke();

    // Safety net: someone changed the active nail without emitting nail:select.
    if (this.film && (hm.getCurrentHand() !== this._boundHand || hm.getActiveNail() !== this._boundFinger)) {
      this._rebind();
    }

    const nailMesh = hm.getNailMesh();
    const input = this.inputHandler;
    const film = this.film;
    const g = this._g;
    let changed = false;

    // Has the camera moved? (16-float compare, no allocation)
    const camMatrix = this.camera.matrixWorld;
    if (!this._lastCamera.equals(camMatrix)) {
      this._lastCamera.copy(camMatrix);
      this._needsPose = true;
    }

    let moved = false;
    let laid = 0;
    if (input && g && film && this._boundHand !== null) {
      input.beginFrame(nailMesh);
      moved = input.consumeMoved();
      if (input.strokeStart) {
        if (this._autoActive) this._endAutoStroke();
        if (this.isPainting) this._liftStroke();
        this._pressStart();
      }
      const n = input.sampleCount;
      if (n > 0 && this.isPainting) {
        const s = input.samples;
        const pen = input.pointerType === 'pen';
        const before = this._segs;
        for (let i = 0; i < n; i++) {
          const o = i * SAMPLE_STRIDE;
          const tMs = s[o + 5];
          const pr = pen ? input.tip.pressure : Math.min(1, 0.35 + Math.max(0, tMs) * 0.01);
          this._feed(s[o] * g.aspect, s[o + 1], tMs, s[o + 6], s[o + 7], pr);
          this._lastSampleMs = tMs;
          this._depU = s[o]; this._depV = s[o + 1];
        }
        laid = this._segs - before;
        if (laid > 0) this._holdT = 0;
      }
      if (this.isPainting && input.down) {
        // a press that has stayed still (no pointer event, by the event clock:
        // a slow frame may still hold the first moves) prints the brush now
        const stillS = (performance.now() - input.strokeStartMs - this._lastSampleMs) * 0.001;
        if (input.onNail && this._chain && this._segs === 0 && this._backCap && this._holdT + dt >= PRINT_STILL && stillS >= PRINT_STILL) {
          this._print(this._halfWidth(this._pressure), LANDING_BEAD);
        }
        if (input.onNail && this._chain && laid === 0) {
          // resting: a pool grows under the still brush (after the print, on
          // a press that has not moved yet; by the event clock too)
          this._holdT += dt;
          const rest = (this._segs > 0 || this._printed) && stillS >= POOL_DELAY;
          while (rest && this._holdT >= (this._poolK === 0 ? POOL_DELAY : POOL_EVERY)) {
            this._holdT -= this._poolK === 0 ? POOL_DELAY : POOL_EVERY;
            this._poolK++;
            const k = Math.min(1 + POOL_MAX, 1 + POOL_GROW * this._poolK);
            this._pressure = input.pointerType === 'pen' ? input.tip.pressure : Math.max(this._pressure, input.tip.pressure);
            const hw = this._halfWidth(this._pressure);
            // the first cap adds half a coat, later ones less: the pool grows
            // wider and thicker (relief) faster than it darkens
            this._cap(this._px, this._py, hw * k, hw * CAP_HL * k, SEG_FLAGS.CAP_START | SEG_FLAGS.CAP_END,
              Math.min(1, LANDING_BEAD + 0.08 * this._poolK), COAT_ALPHA * (this._poolK === 1 ? 0.5 : 0.3));
            this._setLoad(this._load - POOL_LOAD);
          }
          // the axis keeps settling, the velocity decays
          this._stepAxis(dt);
          this._axT += dt * 1000;
          const kd = Math.exp(-dt / 0.05);
          this._vx *= kd; this._vy *= kd;
        }
        changed = true;
      }
      if (this.isPainting && !input.down) {
        this._liftStroke();
        this.isPainting = false;
        changed = true;
      }
      film.flush();

      if (this.isPainting && this._strokeOpen) {
        const sp = Math.sqrt(this._vx * this._vx + this._vy * this._vy);
        const k = dt > 0 ? Math.min(1, dt * 14) : 1;
        this._speed += (sp - this._speed) * k;
        if (laid > 0 && input.tip.isValid) {
          this._emitStroke(this._speed, this._pressure, this._depU, this._depV, input.tip.surfacePoint);
        }
      }
    }

    // Re-dip after a lift (any lift, even a short one): a short pause, then
    // the load climbs back to 1 over REDIP_TIME. A new stroke does not stop
    // it, so quick strokes with lifts between them never run the brush dry;
    // only painting on without lifting does.
    if (this._sinceLift >= 0) {
      this._sinceLift += dt;
      if (this._sinceLift > REDIP_DELAY) {
        if (!this._dipEmitted) {
          this._dipEmitted = true;
          if (this._load < 0.98) this._emitDip();
        }
        const t0 = Math.max(0, this._sinceLift - dt - REDIP_DELAY);
        const step = Math.min(this._sinceLift - REDIP_DELAY, REDIP_TIME) - Math.min(t0, REDIP_TIME);
        if (step > 0) this._setLoad(this._load + step / REDIP_TIME);
        if (this._sinceLift >= REDIP_DELAY + REDIP_TIME || this._load >= 1) this._sinceLift = -1;
        if (!this.isPainting) this._needsPose = true;
      }
      changed = true;
    }

    // Film: levelling only while awake (idle cost is zero passes).
    if (film && film.tick(dt)) {
      if (this._boundHand !== null && hm.setFilmTexture) hm.setFilmTexture(this._boundHand, this._boundFinger, film.getFilmTexture());
      changed = true;
    }

    // The rig, posed on the newest sample.
    if (g && !this._autoActive) {
      if (input && (this._needsPose || moved || this.isPainting || input.sampleCount > 0 || input.strokeEnd)) {
        this._poseRig(input);
        this._needsPose = false;
        changed = true;
      } else if (!input && this._needsPose) {
        this._parkRig();
        this._needsPose = false;
      }
    }

    const bristles = this.bristleSystem;
    if (!bristles.isAtRest()) {
      bristles.update(dt, nailMesh, this.raycaster);
      changed = true;
    }
    if (this.brushEffects.update(dt)) changed = true;
    if (this._debugOn && this.debug) this._writeDebug();

    if (changed) this.invalidate();
  }

  /** Fill the rig's pose from the input tip and the engine state. */
  _poseRig(input) {
    const g = this._g;
    const tip = input.tip;
    const pose = this._pose;
    if (!input.hasPointer) {
      this._parkRig();
      return;
    }
    const contact = this.isPainting && input.down && tip.isValid && this._chain;
    const pen = input.pointerType === 'pen';
    const pressure = contact ? (pen ? tip.pressure : Math.max(this._pressure, tip.pressure)) : 0;
    if (tip.isValid) {
      pose.point.copy(tip.surfacePoint);
      pose.normal.copy(tip.surfaceNormal);
      pose.onSurface = true;
      if (contact) {
        this._lastContactP.copy(tip.surfacePoint);
        this._lastContactN.copy(tip.surfaceNormal);
        this._hasContactPlane = true;
      }
    } else {
      // Off the nail: under the pointer, on the nail's plane (not in mid-air).
      const cam = this.camera;
      const dir = this._v0.copy(tip.surfacePoint).sub(cam.position).normalize();
      const near = this._hasContactPlane && this.isPainting;
      const P0 = near ? this._lastContactP : g.c;
      const N0 = near ? this._lastContactN : g.n;
      const den = dir.dot(N0);
      if (Math.abs(den) > 1e-4) {
        const t = this._v1.copy(P0).sub(cam.position).dot(N0) / den;
        pose.point.copy(cam.position).addScaledVector(dir, t);
      } else {
        pose.point.copy(P0);
      }
      pose.normal.copy(N0);
      pose.onSurface = false;
    }
    if (contact) this._pressure = pressure;
    this._hw = this._halfWidth(pressure);
    // axis and velocity: plane -> world through the fit
    const ca = Math.cos(this._axA), sa = Math.sin(this._axA);
    const N = pose.normal;
    const ax = pose.axis.copy(g.ju).multiplyScalar(ca).addScaledVector(g.jv, sa);
    ax.addScaledVector(N, -ax.dot(N));
    if (ax.lengthSq() < 1e-12) ax.copy(g.ju);
    ax.normalize();
    if (contact) {
      pose.velocity.copy(g.ju).multiplyScalar(this._vx).addScaledVector(g.jv, this._vy);
      pose.velocity.addScaledVector(N, -pose.velocity.dot(N));
    } else {
      pose.velocity.set(0, 0, 0);
    }
    pose.halfWidth = this._hw * FAN_VISIBLE * g.perPlane;
    pose.pressure = pressure;
    pose.load = this._load;
    pose.contact = contact;
    pose.isTouch = !!tip.isTouch;
    pose.scale = g.widthV * g.perPlane;
    this.bristleSystem.setPose(pose);
  }

  /** No pointer yet: the brush hovers over the nail, toward the free edge. */
  _parkRig() {
    const g = this._g;
    if (!g) return;
    const pose = this._pose;
    const a = -0.55 * 0.5 * g.lengthV;
    this._planeToWorld(g.cx + g.alongX * a, g.cy + g.alongY * a, pose.point);
    pose.normal.copy(g.n);
    this._axA = Math.atan2(g.acrossY, g.acrossX);
    pose.axis.copy(g.ju).multiplyScalar(g.acrossX).addScaledVector(g.jv, g.acrossY).normalize();
    pose.velocity.set(0, 0, 0);
    this._hw = this._halfWidth(0);
    pose.halfWidth = this._hw * g.perPlane;
    pose.pressure = 0;
    pose.load = this._load;
    pose.contact = false;
    pose.isTouch = false;
    pose.scale = g.widthV * g.perPlane;
    pose.onSurface = true;
    this.bristleSystem.setPose(pose);
  }

  _project(v, out) {
    const p = this._v2.copy(v).project(this.camera);
    const r = this._rect;
    out[0] = r.left + (p.x + 1) * 0.5 * r.width;
    out[1] = r.top + (1 - p.y) * 0.5 * r.height;
    return out;
  }

  _writeDebug() {
    const d = this.debug;
    const b = this.bristleSystem;
    this._project(b.tipCenter, d.tipScreen);
    const input = this.inputHandler;
    if (input && input.tip.isValid) this._project(input.tip.surfacePoint, d.depositScreen);
    const pose = this._pose;
    const t = PolishBrush3D._dbg;
    this._project(this._v0.copy(pose.point).addScaledVector(pose.axis, pose.halfWidth), t);
    const x1 = t[0], y1 = t[1];
    this._project(this._v0.copy(pose.point).addScaledVector(pose.axis, -pose.halfWidth), t);
    d.halfWidthPx = 0.5 * Math.hypot(x1 - t[0], y1 - t[1]);
    d.axisAngle = ((Math.atan2(y1 - t[1], x1 - t[0]) * 180 / Math.PI) % 180 + 180) % 180;
    d.load = this._load;
    d.dry = this._dry;
  }

  // ------------------------------------------------------------ actions --

  /** Fill the active nail with one colour. */
  fillNail(color = this.color) {
    if (!this.film) return;
    if (!this.isActive) {
      // Paint straight into the baked target of the active nail.
      const hand = this.handModel.getCurrentHand();
      const finger = this.handModel.getActiveNail();
      const target = this.handModel.getPaintTarget(hand, finger, true);
      if (!target) return;
      this._setColorSRGB(color);
      this.film.fill(this._colorSRGB, 1);
      this.film.saveDye(target);
      this.film.clear();
      this._setColorSRGB(this.color);
      this.handModel.setPaintTexture(hand, finger, target.texture);
      this._filled(hand, finger);
      this.invalidate();
      return;
    }
    this._rebind();
    this._setColorSRGB(color);
    this.film.fill(this._colorSRGB, 1);
    this._setColorSRGB(this.color);
    this._dyeDirty = true;
    this._refreshBoundTexture();
    if (this._boundHand !== null) this._filled(this._boundHand, this._boundFinger);
    this.invalidate();
  }

  _filled(hand, finger) {
    const map = this.getCoverageMap(hand, finger, true);
    if (map) {
      map.fill();
      this._reportCoverage(hand, finger, map, true);
    }
    this.wetCure.splash(hand, finger);
  }

  /** Clear paint on the active nail (film + baked). Never touches decorations. */
  clearNail() {
    const hand = this.handModel.getCurrentHand();
    const finger = this.handModel.getActiveNail();
    if (this.film && hand === this._boundHand && finger === this._boundFinger) {
      this.film.clear();
      this._refreshBoundTexture();
      // a stroke in progress carries on from here, on a clean nail
      this._hasSeg = false;
    }
    this.handModel.clearPaint(hand, finger);
    const map = this.getCoverageMap(hand, finger, false);
    if (map) {
      map.clear();
      this._reportCoverage(hand, finger, map, true);
    } else if (this.onCoverageChange) {
      this.onCoverageChange(0);
    }
    this.wetCure.reset(hand, finger);
    this.invalidate();
  }

  /**
   * Programmatic stroke (intro demo): paints the segment (u0,v0)->(u1,v1)
   * up to t in [0,1] on the active nail, through the same band path as a
   * real stroke (pressure 0.8, loaded), with the brush drawn painting it.
   * Calls on consecutive frames are one stroke; it lifts once a frame passes
   * without a call. A real press takes over.
   */
  autoStroke(u0, v0, u1, v1, t = 1) {
    if (!this.film || !this.isActive) return;
    this._rebind();
    if (this._boundHand === null || !this._g || this.isPainting) return;
    const g = this._g;
    const k = Math.max(0, Math.min(1, t));
    const bx = u0 + (u1 - u0) * k;
    const by = v0 + (v1 - v0) * k;
    if (!this._autoActive) {
      this._autoActive = true;
      this._pressStart();
      this.isPainting = false; // not the player's stroke
      this._setLoad(1);
      this._autoT = 0;
      this._feed(u0 * g.aspect, v0, 0, 0, 0, AUTO_PRESSURE);
    }
    this._autoT += Math.max(1, this._lastDt * 1000);
    this._feed(bx * g.aspect, by, this._autoT, 0, 0, AUTO_PRESSURE);
    this.film.flush();
    this._autoFrame = this._frame;
    // the brush paints it: tips on the point
    const pose = this._pose;
    this._autoPoint(bx, by);
    pose.contact = true;
    pose.onSurface = true;
    pose.pressure = AUTO_PRESSURE;
    this._hw = this._halfWidth(AUTO_PRESSURE);
    pose.halfWidth = this._hw * g.perPlane;
    const ca = Math.cos(this._axA), sa = Math.sin(this._axA);
    pose.axis.copy(g.ju).multiplyScalar(ca).addScaledVector(g.jv, sa);
    pose.axis.addScaledVector(pose.normal, -pose.axis.dot(pose.normal)).normalize();
    pose.velocity.copy(g.ju).multiplyScalar(this._vx).addScaledVector(g.jv, this._vy);
    pose.load = this._load;
    pose.isTouch = false;
    pose.scale = g.widthV * g.perPlane;
    this.bristleSystem.setPose(pose);
    const speed = Math.sqrt(this._vx * this._vx + this._vy * this._vy);
    this._emitStroke(speed, AUTO_PRESSURE, bx, by, pose.point);
    this.invalidate();
  }

  /** World point and normal on the nail at uv, into the pose. */
  _autoPoint(u, v) {
    const g = this._g;
    const pose = this._pose;
    const mesh = this.handModel.getNailMesh();
    const approx = this._planeToWorld(u * g.aspect, v, this._v0);
    pose.point.copy(approx);
    pose.normal.copy(g.n);
    if (!mesh) return;
    const p = this._v1.copy(approx).project(this.camera);
    this._ndc.set(p.x, p.y);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this._hits;
    hits.length = 0;
    this.raycaster.intersectObject(mesh, false, hits);
    if (hits.length && hits[0].face) {
      pose.point.copy(hits[0].point);
      pose.normal.copy(hits[0].face.normal).transformDirection(mesh.matrixWorld);
      if (pose.normal.dot(g.n) < 0) pose.normal.negate();
    }
    hits.length = 0;
  }

  _endAutoStroke() {
    this._autoActive = false;
    if (this.isPainting) return;
    this._liftStroke();
    // the brush rests above the end of the stripe
    this._pose.contact = false;
    this._pose.pressure = 0;
    this._pose.velocity.set(0, 0, 0);
    this.bristleSystem.setPose(this._pose);
  }

  setUseFluidSim(enabled) {
    this.useFluidSim = enabled;
  }

  /** GPU state was lost with the context: paint is gone, start clean. */
  onContextRestored() {
    if (!this.film) return;
    this.film.onContextRestored();
    this._refreshBoundTexture();
  }

  dispose() {
    this.deactivate();
    if (this.events && this._onNailSelect) this.events.off(EVENTS.NAIL_SELECT, this._onNailSelect);
    this.bristleSystem.dispose();
    this.brushEffects.dispose();
    if (this.film) this.film.dispose();
    this.scene.remove(this.bristleSystem.group);
  }
}

PolishBrush3D._tmpColor = new THREE.Color();
PolishBrush3D._tmpRGB = { r: 0, g: 0, b: 0 };
PolishBrush3D._dbg = [0, 0];

export { BristleSystem } from './BristleSystem.js';
export { BrushInputHandler } from './BrushInputHandler.js';
