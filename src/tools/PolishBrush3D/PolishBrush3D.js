/**
 * PolishBrush3D.js
 * The polish brush: bristle physics for the look, a GPU fluid sim for the
 * paint. Paint goes from the sim's dye texture straight into the nail shader;
 * nothing is read back to the CPU and the decoration canvas is never touched.
 *
 * One sim, bound to the active nail. When the active nail changes (finger,
 * hand, or the brush is put away) the dye is saved into the previous nail's
 * baked target and the next nail's baked paint is loaded, so every nail keeps
 * its own paint.
 */
import * as THREE from 'three';
import { BristleSystem } from './BristleSystem.js';
import { BrushInputHandler } from './BrushInputHandler.js';
import { BrushEffects } from './BrushEffects.js';
import { FluidSimulator } from './FluidSimulator.js';
import { EVENTS } from '../../core/GameEvents.js';
import { soundManager } from '../../audio/SoundManager.js';

const BRUSH_RADIUS = 0.085;     // stroke radius in aspect-corrected UV units at full pressure
const MIN_PRESSURE_RADIUS = 0.7; // radius multiplier at the lightest touch
const INITIAL_POSITION = Object.freeze(new THREE.Vector3(0, 0.2, 0));
const INITIAL_NORMAL = Object.freeze(new THREE.Vector3(0, 1, 0));

function simOptions(settings) {
  return {
    simRes: settings.fluidSimRes,
    dyeRes: settings.fluidDyeRes,
    iterations: settings.pressureIterations,
    dyeType: settings.fluidDyeType,
    noFlow: !!settings.noFlow,
  };
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
    this.inputHandler = null;
    this.brushEffects = new BrushEffects(scene);

    this.fluidSim = null;
    this.useFluidSim = true;
    this.simEveryNFrames = 1;
    this._frame = 0;

    // Shared raycaster (perf harness contract: app.polishBrush3D.raycaster)
    this.raycaster = new THREE.Raycaster();

    // UI callbacks (kept for compatibility)
    this.onCoverageChange = null;
    this.onPaintStart = null;
    this.onPaintEnd = null;

    // Which nail the sim is bound to.
    this._boundHand = null;
    this._boundFinger = null;
    this._dyeDirty = false;

    // Stroke state (no allocations while painting)
    this._lastUV = new THREE.Vector2();
    this._hasLastUV = false;
    this._strokeSeed = 0;
    this._lastCamera = new THREE.Matrix4();
    this._camChanged = true;
    this._needsTransform = true;

    // Reused event payloads
    this._strokeStartPayload = { hand: 'left', finger: 'index', color: this.color, finish: this.finish };
    this._strokePayload = { speed: 0, pressure: 0, u: 0, v: 0, worldPos: new THREE.Vector3() };
    this._strokeEndPayload = { hand: 'left', finger: 'index' };

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
    if (this.renderer && !this.fluidSim) this.initFluidSim();
  }

  initFluidSim() {
    if (!this.renderer || this.fluidSim) return;
    const opts = this.settings ? simOptions(this.settings) : {};
    this.fluidSim = new FluidSimulator(this.renderer, opts);
  }

  /** Compile every fluid pass now so the first stroke never compiles. */
  prewarm() {
    if (this.fluidSim) this.fluidSim.prewarm();
  }

  // ------------------------------------------------------------- binding --

  /**
   * Bind the sim to the currently active nail (save previous, load next).
   */
  _rebind() {
    if (!this.fluidSim || !this.handModel) return;
    const hand = this.handModel.getCurrentHand();
    const finger = this.handModel.getActiveNail();
    if (!this.isActive) {
      this._unbind();
      return;
    }
    if (hand === this._boundHand && finger === this._boundFinger) return;
    this._unbind();
    if (!this.handModel.getNail(hand, finger)) return;

    const baked = this.handModel.getPaintTarget(hand, finger, false);
    this.fluidSim.loadDye(baked ? baked.texture : null);
    this._boundHand = hand;
    this._boundFinger = finger;
    this._dyeDirty = false;
    this.handModel.setPaintTexture(hand, finger, this.fluidSim.getTexture());
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
      this.fluidSim.saveDye(baked);
      hm.setPaintTexture(hand, finger, baked.texture);
    } else {
      hm.setPaintTexture(hand, finger, null);
    }
    this._boundHand = null;
    this._boundFinger = null;
    this._dyeDirty = false;
    this.invalidate();
  }

  _refreshBoundTexture() {
    if (this._boundHand !== null) {
      this.handModel.setPaintTexture(this._boundHand, this._boundFinger, this.fluidSim.getTexture());
    }
  }

  // ------------------------------------------------------- activation --

  activate() {
    if (this.isActive) return;
    this.isActive = true;
    if (this.renderer && !this.fluidSim) this.initFluidSim();

    const canvas = document.querySelector('#canvas-container canvas');
    const canvasContainer = document.querySelector('#canvas-container');
    if (canvas) {
      this.inputHandler = new BrushInputHandler(this.camera, canvas);
      this.inputHandler.attach();
    }
    if (canvasContainer) canvasContainer.classList.add('polish-brush-active');

    this.bristleSystem.setVisible(true);
    this.bristleSystem.setColor(this.color);
    this.bristleSystem.setBrushTransform(INITIAL_POSITION, INITIAL_NORMAL);
    this.brushEffects.setVisible(true);
    this._needsTransform = true;

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
    this.invalidate();
  }

  setFinish(finish) {
    this.finish = finish;
    if (this.handModel) this.handModel.setFinish(finish);
    this.invalidate();
  }

  /**
   * Apply quality settings: sim resolution, bristle count, physics budget and
   * baked-paint resolution. Paint is preserved.
   */
  setQuality(settings) {
    this.settings = settings;
    this.bristleSystem.configure({
      bristles: settings.bristles,
      radiusScale: settings.bristleRadiusScale || 1,
      substeps: settings.physicsSubstepsMax,
      collision: settings.bristleCollision,
    });
    if (this.fluidSim) {
      if (this.fluidSim.setQuality(simOptions(settings))) this._refreshBoundTexture();
      const sim = this.fluidSim;
      this.handModel.resizePaintTargets(settings.bakedPaintRes, (src, dst) => sim.blit(src, dst));
    }
    this.simEveryNFrames = 1;
    this.invalidate();
  }

  getNailMesh() {
    return this.handModel ? this.handModel.getNailMesh() : null;
  }

  // --------------------------------------------------------- per frame --

  _endStroke() {
    if (!this.isPainting) return;
    this.isPainting = false;
    this._hasLastUV = false;
    if (this.events) {
      this._strokeEndPayload.hand = this._boundHand || this.handModel.getCurrentHand();
      this._strokeEndPayload.finger = this._boundFinger || this.handModel.getActiveNail();
      this.events.emit(EVENTS.BRUSH_STROKE_END, this._strokeEndPayload);
    }
    if (this.onPaintEnd) this.onPaintEnd();
  }

  _startStroke() {
    this.isPainting = true;
    this._hasLastUV = false;
    this._strokeSeed = Math.random() * 6.2831;
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

  _splat(ax, ay, bx, by, pressure, dt) {
    const sim = this.fluidSim;
    const hand = this._boundHand;
    const finger = this._boundFinger;
    const aspect = this.handModel.getUVAspect(hand, finger);
    const radius = BRUSH_RADIUS * (MIN_PRESSURE_RADIUS + (1 - MIN_PRESSURE_RADIUS) * pressure);
    const strength = 0.75 + 0.25 * pressure;
    sim.splatSegment(ax, ay, bx, by, radius, this._colorSRGB, strength, aspect, this._strokeSeed);
    if (dt > 0) {
      sim.splatVelocity(ax, ay, bx, by, radius, (bx - ax) / dt, (by - ay) / dt, aspect);
    }
    this._dyeDirty = true;
  }

  /**
   * Per-frame update (FrameLoop order 10).
   * @param {number} dt seconds, from the loop
   */
  update(dt) {
    if (!this.isActive) return;
    this._frame++;
    const hm = this.handModel;

    // Safety net: someone changed the active nail without emitting nail:select.
    if (this.fluidSim && (hm.getCurrentHand() !== this._boundHand || hm.getActiveNail() !== this._boundFinger)) {
      this._rebind();
    }

    const input = this.inputHandler;
    let changed = false;
    const pressureChanged = input ? input.updatePressure(dt) : false;
    const moved = input ? input.consumeMoved() : false;

    // Has the camera moved? (16-float compare, no allocation)
    const camMatrix = this.camera.matrixWorld;
    if (!this._lastCamera.equals(camMatrix)) {
      this._lastCamera.copy(camMatrix);
      this._camChanged = true;
    }

    const nailMesh = hm.getNailMesh();
    let transform = null;
    if (input && (moved || pressureChanged || this._camChanged || this._needsTransform || input.isPointerDown)) {
      transform = input.getBrushTransform(nailMesh);
      this._camChanged = false;
      this._needsTransform = false;
      this.bristleSystem.setBrushTransform(transform.position, transform.normal);
      this.bristleSystem.setSurface(transform.surfacePoint, transform.surfaceNormal, transform.isValid);
      changed = true;
    }

    if (transform) {
      if (transform.isValid) {
        this.bristleSystem.pressure = transform.pressure;
        this.bristleSystem.isContacting = transform.pressure > 0;
        const down = input.isPainting();
        if (down && !this.isPainting) this._startStroke();
        else if (!down && this.isPainting) this._endStroke();

        if (this.isPainting && this.fluidSim && this.useFluidSim && transform.hasUV && this._boundHand !== null) {
          const uv = transform.uv;
          const pressure = Math.max(0.2, transform.pressure);
          const texel = 0.5 / this.fluidSim.opts.dyeRes;
          let speed = 0;
          if (!this._hasLastUV) {
            this._splat(uv.x, uv.y, uv.x, uv.y, pressure, 0);
            this._lastUV.copy(uv);
            this._hasLastUV = true;
          } else {
            const du = uv.x - this._lastUV.x;
            const dv = uv.y - this._lastUV.y;
            const dist = Math.sqrt(du * du + dv * dv);
            if (dist > texel) {
              this._splat(this._lastUV.x, this._lastUV.y, uv.x, uv.y, pressure, dt);
              speed = dt > 0 ? dist / dt : 0;
              this._lastUV.copy(uv);
            }
          }
          if (this.events) {
            const p = this._strokePayload;
            p.speed = speed;
            p.pressure = transform.pressure;
            p.u = uv.x;
            p.v = uv.y;
            p.worldPos.copy(transform.surfacePoint);
            this.events.emit(EVENTS.BRUSH_STROKE, p);
          }
        }
      } else {
        this.bristleSystem.pressure = 0;
        this.bristleSystem.isContacting = false;
        if (this.isPainting) this._endStroke();
      }
    }

    // Fluid: step only while awake (idle cost is zero passes).
    const sim = this.fluidSim;
    if (sim && this.useFluidSim && sim.isAwake()) {
      // Low tier: halve the sim rate while frames are slow.
      if (this.settings && this.settings.tier === 'low') this.simEveryNFrames = dt > 0.033 ? 2 : 1;
      if (this._frame % this.simEveryNFrames === 0) {
        sim.step(dt * this.simEveryNFrames);
        this._refreshBoundTexture();
      }
      changed = true;
    }
    if (this.isPainting) changed = true;

    // Bristles: skipped entirely while at rest.
    if (!this.bristleSystem.isAtRest()) {
      this.bristleSystem.update(dt, nailMesh, this.raycaster);
      changed = true;
    }

    if (this.brushEffects.update(dt)) changed = true;

    if (changed) this.invalidate();
  }

  // ------------------------------------------------------------ actions --

  /** Fill the active nail with one colour. */
  fillNail(color = this.color) {
    if (!this.fluidSim) return;
    if (!this.isActive) {
      // Paint straight into the baked target of the active nail.
      const hand = this.handModel.getCurrentHand();
      const finger = this.handModel.getActiveNail();
      const target = this.handModel.getPaintTarget(hand, finger, true);
      if (!target) return;
      this._setColorSRGB(color);
      this.fluidSim.fill(this._colorSRGB, 1);
      this.fluidSim.saveDye(target);
      this.fluidSim.clear();
      this._setColorSRGB(this.color);
      this.handModel.setPaintTexture(hand, finger, target.texture);
      this.invalidate();
      return;
    }
    this._rebind();
    this._setColorSRGB(color);
    this.fluidSim.fill(this._colorSRGB, 1);
    this._setColorSRGB(this.color);
    this._dyeDirty = true;
    this._refreshBoundTexture();
    this.invalidate();
  }

  /** Clear paint on the active nail (sim + baked). Never touches decorations. */
  clearNail() {
    const hand = this.handModel.getCurrentHand();
    const finger = this.handModel.getActiveNail();
    if (this.fluidSim && hand === this._boundHand && finger === this._boundFinger) {
      this.fluidSim.clear();
      this._refreshBoundTexture();
    }
    this.handModel.clearPaint(hand, finger);
    this._hasLastUV = false;
    if (this.onCoverageChange) this.onCoverageChange(0);
    this.invalidate();
  }

  /**
   * Programmatic partial stroke (WP6 demo / ghost finger): paints the part of
   * the segment (u0,v0)->(u1,v1) up to t in [0,1] on the active nail.
   */
  autoStroke(u0, v0, u1, v1, t = 1) {
    if (!this.fluidSim) return;
    if (!this.isActive) return;
    this._rebind();
    if (this._boundHand === null) return;
    const k = Math.max(0, Math.min(1, t));
    this._splat(u0, v0, u0 + (u1 - u0) * k, v0 + (v1 - v0) * k, 0.8, 0);
    this.invalidate();
  }

  setUseFluidSim(enabled) {
    this.useFluidSim = enabled;
  }

  /** GPU state was lost with the context: paint is gone, start clean. */
  onContextRestored() {
    if (!this.fluidSim) return;
    this.fluidSim.onContextRestored();
    this._refreshBoundTexture();
  }

  dispose() {
    this.deactivate();
    if (this.events && this._onNailSelect) this.events.off(EVENTS.NAIL_SELECT, this._onNailSelect);
    this.bristleSystem.dispose();
    this.brushEffects.dispose();
    if (this.fluidSim) this.fluidSim.dispose();
    this.scene.remove(this.bristleSystem.group);
  }
}

PolishBrush3D._tmpColor = new THREE.Color();
PolishBrush3D._tmpRGB = { r: 0, g: 0, b: 0 };

export { BristleSystem } from './BristleSystem.js';
export { BrushInputHandler } from './BrushInputHandler.js';
