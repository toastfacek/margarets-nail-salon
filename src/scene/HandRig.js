/**
 * HandRig.js (B9.4 / B9.5): what poses the hand.
 *
 * HandRig      one per hand: the 17 bones, their rest rotations and their
 *              flex / spread / twist axes; apply(pose) writes the bones.
 * HandAnimator app.hand: the layers (base, override, idle, reaction), the
 *              press-give spring, one-shots, and the public API (plan 5.2).
 *
 * Axes are computed once from the loaded (unmirrored) file in its rest pose,
 * in each bone's own local space: flex = cross(back normal, bone direction)
 * (+ curls toward the palm on every finger), twist = the bone direction,
 * spread = flex x twist. The back normal of a finger is its nail's +Z (the
 * file's canonical nail frame); the palm and wrist use the middle nail's.
 * Both hands use the same local rotations (the left hand is a mirrored clone
 * with identical bones), which is exactly the mirror image of the motion.
 *
 * Final angles = clamp(base + override + idle + reaction, limits), then
 * bone.quaternion = rest * R(flex) * R(spread) * R(twist). Preallocated
 * arrays, no per-frame allocation; nothing is written when nothing changed.
 * After a write the model's matrices are updated at once, so nail
 * matrixWorld is current before input and the brush run (loop order 10).
 */
import * as THREE from 'three';
import {
  BONES, NB, N3, FINGER_ORDER, fingerBase, LIMITS, clampPose,
  writePresent, writePresentS, writeNamed, POSE_NAMES, WIGGLE,
} from './HandPoses.js';

const DEG = Math.PI / 180;
const EPS = 1e-4;        // degrees: below this a joint has not moved
const SETTLE = 0.05;     // degrees: `settled` threshold (plan 5.2)
const EASE_T = 0.35;     // s: base pose changes (entering / leaving the close-up, setPose)

// Press-give (plan 5.3): a damped spring on the active finger's last joint.
const PRESS = Object.freeze({ hz: 9, damping: 0.5, ext: 2.0, roll: 1.0, knuckle: 0.3 });
// Idle (plan 5.3).
const IDLE = Object.freeze({ swayHz: 0.25, swayDeg: 0.4, driftDeg: 0.4, strokeScale: 0.2, downT: 0.15, upT: 0.6 });

const NAIL_NAMES = Object.freeze({ thumb: 'Nail_Thumb', index: 'Nail_Index', middle: 'Nail_Middle', ring: 'Nail_Ring', pinky: 'Nail_Pinky' });

function findSkin(root) {
  let skin = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
  return skin;
}

/** Bones by their file name ('index.01'); three's loader drops the dot ('index01'). */
function boneMap(root) {
  const skin = findSkin(root);
  const map = {};
  if (skin) {
    const byName = {};
    for (const b of skin.skeleton.bones) byName[b.name] = b;
    for (const n of BONES) map[n] = byName[n] || byName[n.replace('.', '')] || byName[n.replace('.', '_')] || null;
  }
  return map;
}

/**
 * Bone axes (local) and sign conventions, from the unmirrored file in rest pose.
 * @returns {{ axes: Float32Array, ok: boolean }} axes[b * 9 + 0..8] = flex, spread, twist (unit, bone-local)
 */
export function computeRigAxes(source) {
  const axes = new Float32Array(NB * 9);
  source.updateMatrixWorld(true);
  const bones = boneMap(source);
  const pos = (name, out) => out.setFromMatrixPosition(bones[name].matrixWorld);
  const nailN = (f, out) => {
    const n = source.getObjectByName(NAIL_NAMES[f]);
    if (!n) return out.set(0, 1, 0);
    return out.set(0, 0, 1).transformDirection(n.matrixWorld);
  };
  const up = new THREE.Vector3(0, 1, 0);
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
  const qW = new THREE.Quaternion(), qI = new THREE.Quaternion();
  const tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
  // across the hand, toward the pinky
  const P = new THREE.Vector3();
  if (bones['pinky.01'] && bones['index.01']) pos('pinky.01', P).sub(pos('index.01', p0)).normalize();
  let ok = true;
  for (let b = 0; b < NB; b++) {
    const name = BONES[b];
    const bone = bones[name];
    if (!bone) { ok = false; continue; }
    pos(name, p0);
    let finger = null;
    if (name === 'wrist') pos('palm', p1);
    else if (name === 'palm') pos('middle.01', p1);
    else {
      finger = name.split('.')[0];
      const k = +name.slice(-1);
      if (k < 3) pos(finger + '.0' + (k + 1), p1);
      else { pos(finger + '.02', p1); p1.subVectors(p0, p1).add(p0); }
    }
    d.subVectors(p1, p0).normalize();
    nailN(finger || 'middle', n);
    X.crossVectors(n, d);
    if (X.lengthSq() < 1e-10) X.set(1, 0, 0);
    X.normalize();
    Y.copy(d);
    Z.crossVectors(X, Y).normalize();
    // semantic signs: spread + toward the pinky (thumb: tip up), twist + turns the nail up
    let sSpread = 1, sTwist = 1;
    if (finger === 'thumb') {
      sSpread = -X.dot(up) > 0 ? 1 : -1;
      sTwist = tmpS.crossVectors(d, n).dot(up) > 0 ? 1 : -1;
    } else {
      sSpread = -X.dot(P) > 0 ? 1 : -1;
    }
    // into the bone's local space (rest)
    bone.matrixWorld.decompose(tmpP, qW, tmpS);
    qI.copy(qW).invert();
    const o = b * 9;
    p0.copy(X).applyQuaternion(qI).normalize();
    axes[o] = p0.x; axes[o + 1] = p0.y; axes[o + 2] = p0.z;
    p0.copy(Z).applyQuaternion(qI).normalize().multiplyScalar(sSpread);
    axes[o + 3] = p0.x; axes[o + 4] = p0.y; axes[o + 5] = p0.z;
    p0.copy(Y).applyQuaternion(qI).normalize().multiplyScalar(sTwist);
    axes[o + 6] = p0.x; axes[o + 7] = p0.y; axes[o + 8] = p0.z;
  }
  return { axes, ok };
}

/** One hand's bones. */
export class HandRig {
  /**
   * @param {THREE.Object3D} model the hand's root (HandModel.hands[h].model)
   * @param {Float32Array} axes computeRigAxes(...).axes
   */
  constructor(model, axes) {
    this.model = model;
    this.axes = axes;
    const map = boneMap(model);
    this.bones = BONES.map((n) => map[n] || null);
    this.rest = this.bones.map((b) => (b ? b.quaternion.clone() : new THREE.Quaternion()));
    this.applied = new Float32Array(N3);   // what the bones show now (degrees)
    this.ok = this.bones.every((b) => !!b);
    this._q = new THREE.Quaternion();
    this._qa = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  /**
   * Write a pose (degrees, BONES order) to the bones. Returns true when any
   * bone changed. `force` writes every bone.
   */
  apply(pose, force = false) {
    if (!this.ok) return false;
    let changed = false;
    const ax = this.axes, ap = this.applied, q = this._q, qa = this._qa, v = this._v;
    for (let b = 0; b < NB; b++) {
      const i = b * 3;
      const f = pose[i], s = pose[i + 1], t = pose[i + 2];
      if (!force && Math.abs(f - ap[i]) < EPS && Math.abs(s - ap[i + 1]) < EPS && Math.abs(t - ap[i + 2]) < EPS) continue;
      ap[i] = f; ap[i + 1] = s; ap[i + 2] = t;
      const o = b * 9;
      q.copy(this.rest[b]);
      if (f !== 0) q.multiply(qa.setFromAxisAngle(v.set(ax[o], ax[o + 1], ax[o + 2]), f * DEG));
      if (s !== 0) q.multiply(qa.setFromAxisAngle(v.set(ax[o + 3], ax[o + 4], ax[o + 5]), s * DEG));
      if (t !== 0) q.multiply(qa.setFromAxisAngle(v.set(ax[o + 6], ax[o + 7], ax[o + 8]), t * DEG));
      this.bones[b].quaternion.copy(q);
      changed = true;
    }
    if (changed) this.model.updateMatrixWorld(true);
    return changed;
  }
}

/**
 * app.hand (plan 5.2). One instance; drives the shown hand's rig.
 */
export class HandAnimator {
  /**
   * @param {import('./HandModel.js').HandModel} handModel
   * @param {import('./NailScene.js').NailScene} scene
   */
  constructor(handModel, scene) {
    this.hm = handModel;
    this.scene = scene;
    this.rigs = { left: null, right: null };
    this._axes = null;
    this.limits = LIMITS;       // per bone: flex / spread / twist min, max (degrees; HandPoses.js)

    this._target = new Float32Array(N3);
    this._base = new Float32Array(N3);
    this._from = new Float32Array(N3);
    this._manual = new Float32Array(N3);
    this._override = new Float32Array(N3);
    this._overrideTarget = new Float32Array(N3);
    this._idle = new Float32Array(N3);
    this._react = new Float32Array(N3);
    this._final = new Float32Array(N3);
    this._withStack = [new Float32Array(N3), new Float32Array(N3), new Float32Array(N3), new Float32Array(N3)];
    this._withDepth = 0;
    this._withTmp = new Float32Array(N3);

    this._mode = 'auto';        // 'auto' (follows the camera) | 'manual' (setPose / presentFinger)
    this._manualKey = '';
    this._key = '';
    this._ease = 1;             // 0..1 progress of the base ease
    this._easeT = EASE_T;

    // press-give spring (x = 0..1 of the full give), and the roll side
    this.press = { x: 0, v: 0, target: 0, side: 0 };
    // one-shot (wiggle)
    this._shot = { name: '', t: 0 };
    // idle
    this.idleScale = 1;         // setIdle()
    this._idleK = 1;            // eased (brush damping)
    this._idleKTarget = 1;
    this._idleT = 0;
    this._lastIdleInvalidate = -Infinity;
    this.idleRunning = false;
    this.settled = true;
    this.changedThisFrame = false;
  }

  // ------------------------------------------------------------- set up --

  /** The rig of the shown hand (created on first use once the hand is loaded). */
  get rig() {
    return this._rigFor(this.hm.getCurrentHand());
  }

  _rigFor(hand) {
    let r = this.rigs[hand];
    if (r) return r;
    const h = this.hm.hands[hand];
    if (!h || !h.model || !this.hm.sourceModel) return null;
    if (!this._axes) this._axes = computeRigAxes(this.hm.sourceModel).axes;
    r = this.rigs[hand] = new HandRig(h.model, this._axes);
    return r.ok ? r : null;
  }

  // ----------------------------------------------------------- the API --

  /**
   * The active finger lifts toward the camera, the others relax.
   * presentFinger(null) = neutral. presentFinger('auto') = follow the camera
   * again (the default: the close-up presents the finger on screen).
   */
  presentFinger(finger, { ms = 350 } = {}) {
    if (finger === 'auto') { this._mode = 'auto'; return; }
    const i = FINGER_ORDER.indexOf(finger);
    if (i >= 0) writePresent(i, this._manual);
    else this._manual.fill(0);
    this._setManual('f:' + finger, ms);
  }

  /** Named pose ('neutral' | 'relaxed' | 'fan'); setPose('auto') follows the camera again. */
  setPose(name, { ms = 350 } = {}) {
    if (name === 'auto') { this._mode = 'auto'; return; }
    writeNamed(POSE_NAMES.includes(name) ? name : 'neutral', this._manual);
    this._setManual('n:' + name, ms);
  }

  _setManual(key, ms) {
    this._mode = 'manual';
    this._manualKey = key;
    this._easeT = Math.max(0.001, ms / 1000);
  }

  /**
   * Game-driven override on one finger, clamped to the limits: curl01 0..1
   * (a relaxed curl at 1), spreadDeg on the knuckle.
   */
  setFingerPose(finger, curl01 = 0, spreadDeg = 0) {
    const i = FINGER_ORDER.indexOf(finger);
    if (i < 0) return;
    const c = Math.max(0, Math.min(1, +curl01 || 0));
    const b = fingerBase(i) * 3;
    const o = this._overrideTarget;
    o[b] = c * 35; o[b + 3] = c * 45; o[b + 6] = c * 25;
    o[b + 1] = Math.max(-30, Math.min(30, +spreadDeg || 0));
  }

  /** Clear every override. */
  clearOverrides() {
    this._overrideTarget.fill(0);
  }

  /** Brush pressure on the active nail (0 on lift); u (0..1 across the nail) picks the roll side. */
  setPress(amount01, u = 0.5) {
    const a = Math.max(0, Math.min(1, +amount01 || 0));
    this.press.target = a;
    if (a > 0) this.press.side = Math.max(-1, Math.min(1, ((+u || 0.5) - 0.5) * 2));
  }

  /** One-shots: 'wiggle'. */
  play(name) {
    if (name !== 'wiggle') return;
    this._shot.name = name;
    this._shot.t = 0;
  }

  /** Idle motion scale (0 = off). */
  setIdle(scale01) {
    this.idleScale = Math.max(0, Math.min(1, +scale01 || 0));
  }

  /**
   * Apply a pose instantly, run fn, restore (for measuring: the camera rail,
   * the reveal path, the contact shadow). poseOrFinger: a finger name (its
   * present pose), a rail position (number), a pose name, or a pose array.
   */
  withPose(poseOrFinger, fn) {
    const rig = this.rig;
    if (!rig || this._withDepth >= this._withStack.length) return fn();
    const saved = this._withStack[this._withDepth++];
    saved.set(rig.applied);
    const p = this._withTmp;
    if (typeof poseOrFinger === 'number') writePresentS(poseOrFinger, p);
    else if (typeof poseOrFinger === 'string') {
      const i = FINGER_ORDER.indexOf(poseOrFinger);
      if (i >= 0) writePresent(i, p);
      else writeNamed(poseOrFinger, p);
    } else if (poseOrFinger && poseOrFinger.length === N3) p.set(poseOrFinger);
    else p.fill(0);
    clampPose(p);
    rig.apply(p, true);
    try {
      return fn();
    } finally {
      rig.apply(saved, true);
      this._withDepth--;
    }
  }

  /** The pose the camera-driven base wants at rail position s (for tests). */
  presentAt(s, out = new Float32Array(N3)) {
    return clampPose(writePresentS(s, out));
  }

  // -------------------------------------------------------------- frame --

  _autoTarget(out) {
    const sc = this.scene;
    if (sc && sc.isZoomedIn && sc.zoomedFinger) {
      const s = sc.railS >= 0 ? sc.railS : FINGER_ORDER.indexOf(sc.zoomedFinger);
      if (s >= 0) {
        writePresentS(s, out);
        return 'p';
      }
    }
    out.fill(0);
    return 'n';
  }

  /** Is finger i the active (presented) one? -1 when none. */
  _activeIndex() {
    const sc = this.scene;
    if (this._mode === 'manual') {
      const k = this._manualKey;
      return k.startsWith('f:') ? FINGER_ORDER.indexOf(k.slice(2)) : -1;
    }
    if (sc && sc.isZoomedIn && sc.zoomedFinger) {
      if (sc.railS >= 0) return Math.round(sc.railS);
      return FINGER_ORDER.indexOf(sc.zoomedFinger);
    }
    return -1;
  }

  /**
   * Per frame (handPose.feature.js, loop order 6). Returns true when the
   * bones moved (the caller invalidates).
   */
  update(dt) {
    this.changedThisFrame = false;
    const rig = this.rig;
    if (!rig) return false;
    dt = Math.min(dt, 0.1);

    // ---- base
    const tg = this._target;
    let key;
    if (this._mode === 'manual') {
      tg.set(this._manual);
      key = 'm' + this._manualKey;
    } else {
      key = this._autoTarget(tg);
      if (key !== this._key) this._easeT = EASE_T;
    }
    if (key !== this._key) {
      this._from.set(this._base);
      this._ease = this._key === '' ? 1 : 0;
      this._key = key;
    }
    const base = this._base;
    if (this._ease < 1) {
      this._ease = Math.min(1, this._ease + dt / this._easeT);
      const e = this._ease * this._ease * (3 - 2 * this._ease);
      for (let k = 0; k < N3; k++) base[k] = this._from[k] + (tg[k] - this._from[k]) * e;
    } else base.set(tg);

    // ---- override (eased toward its target)
    const ov = this._override, ot = this._overrideTarget;
    const kOv = 1 - Math.exp(-dt * 12);
    let ovBusy = false;
    for (let k = 0; k < N3; k++) {
      const dlt = ot[k] - ov[k];
      if (Math.abs(dlt) > 1e-3) { ov[k] += dlt * kOv; ovBusy = true; } else ov[k] = ot[k];
    }

    // ---- idle (B9.5)
    const idleOn = this._stepIdle(dt);

    // ---- reaction: press-give + one-shots
    const rc = this._react;
    rc.fill(0);
    const pressBusy = this._stepPress(dt);
    const act = this._activeIndex();
    if (act >= 0 && (this.press.x !== 0 || pressBusy)) {
      const b = fingerBase(act) * 3;
      const x = this.press.x;
      rc[b + 6] -= PRESS.ext * x;                       // last joint: extension
      rc[b + 8] += PRESS.roll * x * this.press.side;     // last joint: roll toward the brush side
      rc[b] -= PRESS.knuckle * x;                        // knuckle
    }
    const shotBusy = this._stepShot(dt, rc, act);

    // ---- final
    const fin = this._final;
    for (let k = 0; k < N3; k++) fin[k] = base[k] + ov[k] + this._idle[k];
    clampPose(fin);
    for (let k = 0; k < N3; k++) fin[k] += rc[k];
    clampPose(fin);
    const moved = rig.apply(fin);
    this.changedThisFrame = moved;
    this.settled = this._ease >= 1 && !ovBusy && !pressBusy && !shotBusy;
    this.idleRunning = idleOn;
    return moved;
  }

  _stepPress(dt) {
    const p = this.press;
    const w = 2 * Math.PI * PRESS.hz;
    const c = 2 * PRESS.damping * w;
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(t, 1 / 240);
      p.v += (-(w * w) * (p.x - p.target) - c * p.v) * h;
      p.x += p.v * h;
      t -= h;
    }
    if (Math.abs(p.x - p.target) < 1e-4 && Math.abs(p.v) < 1e-3) {
      p.x = p.target;
      p.v = 0;
      return false;
    }
    return true;
  }

  _stepShot(dt, rc, act) {
    const s = this._shot;
    if (!s.name) return false;
    s.t += dt;
    if (s.name === 'wiggle') {
      const W = WIGGLE;
      for (let j = 0; j < W.fingers.length; j++) {
        const f = W.fingers[j];
        const x = (s.t - j * W.lag) / W.width;
        if (x <= 0 || x >= 1) continue;
        // the active chain gets a quarter of it
        const k = f === act ? 0.25 : 1;
        rc[fingerBase(f) * 3] += W.amp * k * Math.sin(Math.PI * x);
      }
      if (s.t >= W.T) s.name = '';
    }
    return !!s.name;
  }

  /** Idle layer (B9.5). Returns true while it moves anything. */
  _stepIdle(dt) {
    const id = this._idle;
    const target = this.idleScale;
    // the brush damps it: down in 150 ms, back in 600 ms
    const kt = this._idleKTarget;
    const T = kt < this._idleK ? IDLE.downT : IDLE.upT;
    this._idleK += (kt - this._idleK) * Math.min(1, dt / T * 2.5);
    const amp = target * this._idleK;
    if (amp <= 1e-4) {
      if (this.idleRunning) id.fill(0);
      return false;
    }
    this._idleT += dt;
    const t = this._idleT;
    id.fill(0);
    const act = this._activeIndex();
    if (act < 0) {
      // zoomed out: breathing sway on the wrist and the palm
      const a = Math.sin(t * 2 * Math.PI * IDLE.swayHz) * IDLE.swayDeg * amp;
      id[0] = a * 0.6; id[1] = a * 0.25; id[3] = a * 0.6;
    } else {
      // close-up: only the four other fingers drift, each on its own slow phase
      for (let f = 0; f < 5; f++) {
        if (f === act) continue;
        const ph = 1.7 * f + 0.4;
        id[fingerBase(f) * 3] = Math.sin(t * (0.9 + 0.17 * f) + ph) * IDLE.driftDeg * amp;
      }
    }
    return true;
  }

  /** brush:strokeStart / strokeEnd: idle eases to 20% while the brush is down. */
  setStroke(down) {
    this._idleKTarget = down ? IDLE.strokeScale : 1;
  }

  /**
   * Should the idle layer ask for a render now? Render-on-demand tiers:
   * at most every `minMs` (low 50, medium 33); high renders every frame.
   */
  idleWantsRender(nowMs, minMs) {
    if (!this.idleRunning) return false;
    if (nowMs - this._lastIdleInvalidate < minMs) return false;
    this._lastIdleInvalidate = nowMs;
    return true;
  }

  /** A frame was rendered for any reason: idle needs no frame of its own until minMs later. */
  noteRendered(nowMs) {
    this._lastIdleInvalidate = nowMs;
  }
}

export { LIMITS, BONES };
