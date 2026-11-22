/**
 * RevealDirector.js (WP7): the Slay reveal, a 4.5 s show driven by app.loop.
 *
 *   0.0  reveal:start; UI fades (body.revealing), brush away, input locked,
 *        wet nails cure, lights go down (scene.setDim 0.45 by 0.6 s)
 *   0.3  camera sweep (Catmull-Rom): low on the pinky side, over the
 *        knuckles, up to a 3/4 hero view; each painted nail it passes gets a
 *        shader glint (setRevealPulse), a sparkle pop and a shimmer
 *   2.2  finger wiggle (finger bones; whole-hand rock if none are found)
 *   2.8  the photo: a flash-lit frame is grabbed, white flash, reveal:flash
 *        (WP5 plays shutter, confetti pop and the jingle with its star dings),
 *        confetti cannons, the polaroid pops up and develops
 *   2.9  party lights back up; big stars pop in time with the jingle's dings
 *   4.0  camera glides back to where it was; the polaroid flies onto the stack under the door
 *   4.5  everything restored exactly, reveal:done (WP5: the client's "yay")
 *
 * Tap after 1 s skips to the end (the photo is still taken). A hidden tab
 * skips too. Zero allocations per frame; every program is pre-warmed.
 */
import * as THREE from 'three';
import { EVENTS } from '../core/GameEvents.js';
import { STAR } from './PolaroidWall.js';

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const END = 4.5;
const SWEEP0 = 0.3, SWEEP1 = 2.8;
const SHOT = 2.8;
const BACK0 = 4.0, BACK1 = 4.45;
const DROP = 4.05;
const DING = [1.07, 1.29, 1.51]; // revealJingle's star dings, after the flash
const PULSE = 0.6;

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const UP = new THREE.Vector3(0, 1, 0);
// uniform Catmull-Rom through 4 points (ends held), no allocation
const cr = (a, b, c, d, t, t2, t3) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
function spline(P, u, out) {
  const x = u * 3;
  const i = x < 2 ? x | 0 : 2;
  const t = x - i, t2 = t * t, t3 = t2 * t;
  const a = P[i ? i - 1 : 0], b = P[i], c = P[i + 1], d = P[i < 2 ? i + 2 : 3];
  return out.set(cr(a.x, b.x, c.x, d.x, t, t2, t3), cr(a.y, b.y, c.y, d.y, t, t2, t3), cr(a.z, b.z, c.z, d.z, t, t2, t3));
}
const XAXIS = new THREE.Vector3(1, 0, 0);

export class RevealDirector {
  constructor(app, { confetti, camera, wall }) {
    this.app = app;
    this.confetti = confetti;
    this.photo = camera;
    this.wall = wall;
    this.running = false;
    this.t = 0;

    const V = () => new THREE.Vector3();
    this._cp = [V(), V(), V(), V()];
    this._lp = [V(), V(), V(), V()];
    this._pos0 = V();
    this._tgt0 = V();
    this._q0 = new THREE.Quaternion();
    this._p = V();
    this._l = V();
    this._v = V();
    this._F = V();
    this._S = V();
    this._q = new THREE.Quaternion();
    this._nails = [V(), V(), V(), V(), V()];
    this._has = [false, false, false, false, false];
    // pulses: finger index and start time, in sweep order
    this._pf = new Int8Array(5);
    this._pt = new Float32Array(5);
    this._pn = 0;
    this._bones = [];
    this._rest = [];

    // DOM: flash, stars
    const el = (cls, html = '') => {
      const e = document.createElement('div');
      e.className = cls;
      e.innerHTML = html;
      document.body.appendChild(e);
      return e;
    };
    this.flash = el('rv-flash');
    this.starsEl = el('rv-stars', `<span>${STAR}</span><span>${STAR}</span><span>${STAR}</span>`);
    this._starSpans = Array.from(this.starsEl.children);

    this._tick = this._tick.bind(this);
    this._after = this._after.bind(this);
    this._poll = this._poll.bind(this);
    this._block = (e) => {
      if (!this.running) return;
      e.stopPropagation();
      if (e.type === 'pointerdown' && this.t > 1) this.skip();
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel', 'touchstart', 'touchmove']) {
      window.addEventListener(type, this._block, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.skip(); });
    window.addEventListener('resize', () => { if (this.running && !this._shot) this._layout(); });
  }

  /** Finger bones of a hand model (sanitised GLB names: index01, index02...). */
  _findBones(hand) {
    this._bones.length = 0;
    const model = this.app.nail.hands[hand] && this.app.nail.hands[hand].model;
    if (model) {
      model.traverse((o) => {
        const m = o.isBone && /^(thumb|index|middle|ring|pinky)0?([12])$/.exec(o.name);
        if (m) this._bones.push({ bone: o, f: FINGERS.indexOf(m[1]), k: m[2] === '1' ? 1 : 0.6 });
      });
    }
    while (this._rest.length < this._bones.length) this._rest.push(new THREE.Quaternion());
    for (let i = 0; i < this._bones.length; i++) this._rest[i].copy(this._bones[i].bone.quaternion);
  }

  /** Camera and look-at control points from the nail positions and the screen. */
  _layout() {
    const app = this.app;
    const cam = app.scene.camera;
    const N = this._nails;
    const all = this._v.set(0, 0, 0);
    const req = this._l.set(0, 0, 0);
    let na = 0, nr = 0;
    for (let i = 0; i < 5; i++) {
      if (!this._has[i]) continue;
      all.add(N[i]);
      na++;
      if (this._want[i]) { req.add(N[i]); nr++; }
    }
    all.divideScalar(na || 1);
    if (nr) req.divideScalar(nr); else req.copy(all);

    // finger direction (from the hand's middle out through the nails) and the pinky side
    const box = new THREE.Box3().setFromObject(app.nail.hands[this.hand].model);
    const F = box.getCenter(this._F);
    F.subVectors(all, F).setY(0);
    if (F.lengthSq() < 1e-6) F.set(-1, 0, 0);
    F.normalize();
    const S = this._S.crossVectors(UP, F);
    if (this._has[0] && this._has[4] && S.dot(this._p.subVectors(N[4], N[0])) < 0) S.negate();

    // hero: centred between the whole hand and the painted nails, framed for this screen
    const L = this._lp[3].lerpVectors(all, req, 0.6);
    let R = 0.2;
    for (let i = 0; i < 5; i++) if (this._has[i]) R = Math.max(R, N[i].distanceTo(L));
    const half = THREE.MathUtils.degToRad(cam.fov * 0.5);
    const fit = Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
    const d = (R * 0.8 + 0.02) / Math.tan(fit);
    this._cp[3].copy(UP).multiplyScalar(0.92).addScaledVector(F, -0.3).addScaledVector(S, 0.22).normalize().multiplyScalar(d).add(L);

    // low on the pinky side, then over the knuckles looking out to the tips
    const pinky = this._has[4] ? N[4] : req;
    this._cp[1].copy(pinky).addScaledVector(S, 0.32).addScaledVector(UP, 0.13).addScaledVector(F, 0.08);
    this._cp[2].copy(all).addScaledVector(F, -0.42).addScaledVector(UP, 0.62).addScaledVector(S, 0.05);
    this._lp[1].copy(req);
    this._lp[2].lerpVectors(req, all, 0.5).addScaledVector(F, 0.04);
  }

  /** Start the show. Payload: { stars, hand, fingers } (from reveal:request). */
  play({ stars = 1, hand, fingers } = {}) {
    if (this.running) return;
    const app = this.app;
    const hm = app.nail;
    const scene = app.scene;
    const cam = scene.camera;
    this.hand = hand || hm.getCurrentHand();
    this.stars = Math.max(1, Math.min(3, stars | 0));
    this.running = true;
    this.t = 0;
    this._last = -1;
    this._shot = false;
    this._flashT = -1;
    this._dropped = false;
    this._stars = 0;
    app.quality.hold();
    wallClose(this.wall);

    // snapshot the camera, stop any zoom in flight, lock the controls
    scene.isAnimating = false;
    this._pos0.copy(cam.position);
    this._q0.copy(cam.quaternion);
    this._tgt0.copy(scene.controls.target);
    this._ctl = scene.controls.enabled;
    scene.controls.enabled = false;

    // nails and their sweep order (pinky side first)
    this._want = [false, false, false, false, false];
    for (let i = 0; i < 5; i++) {
      this._has[i] = !!(hm.getNail(this.hand, FINGERS[i]) && hm.getNailWorldPosition(FINGERS[i], this._nails[i]));
      this._want[i] = this._has[i] && (!fingers || fingers.indexOf(FINGERS[i]) !== -1);
    }
    this._cp[0].copy(cam.position);
    this._lp[0].copy(this._tgt0);
    this._layout();
    const order = [];
    for (let i = 0; i < 5; i++) if (this._want[i]) order.push(i);
    order.sort((a, b) => this._nails[b].dot(this._S) - this._nails[a].dot(this._S));
    this._pn = order.length;
    for (let k = 0; k < order.length; k++) {
      this._pf[k] = order[k];
      this._pt[k] = order.length > 1 ? 0.7 + (1.5 * k) / (order.length - 1) : 1.3;
    }

    this._findBones(this.hand);
    this._rock = this._bones.length ? 0 : hm.getMesh().rotation.z;

    // brush away, every nail hard and glossy
    this._brush = app.polishBrush3D && app.polishBrush3D.isActive;
    if (this._brush) app.polishBrush3D.deactivate();
    if (app.brushJuice) app.brushJuice.cureAll(this.hand, 0.3);

    document.body.classList.add('revealing');
    for (const s of this._starSpans) s.className = '';
    this.starsEl.dataset.n = this.stars;
    this._warm = !this._warmed;
    this._warmed = true;
    if (this._warm) this.confetti.warm();
    this._safety = setTimeout(() => this.skip(), 7500);
    app.loop.add(this._tick, 50);
    app.loop.add(this._after, 95);
    app.events.emit(EVENTS.REVEAL_START, { stars: this.stars });
    app.invalidate();
  }

  _tick(dt, time) {
    if (!this.running) return;
    // real time (the loop clamps dt to 0.1 s; the show should not stretch on slow GPUs)
    if (this._last >= 0) dt = Math.min(0.25, (time - this._last) / 1000);
    this._last = time;
    const app = this.app;
    const scene = app.scene;
    const cam = scene.camera;
    const hm = app.nail;
    const t = (this.t += dt);

    // lights: down by 0.6 s; full "flash" light for the photo frame; party
    // lights back up right after the flash
    const up = this._shot ? clamp01((t - this._flashT - 0.1) / 0.6) : 0;
    scene.setDim(this._shot ? 0.45 + 0.55 * ease(up) : t >= SHOT ? 1 : 1 - 0.55 * ease(t / 0.6));

    // camera: sweep, hold the hero view, glide back
    const u = ease((t - SWEEP0) / (SWEEP1 - SWEEP0));
    spline(this._cp, u, this._p);
    spline(this._lp, u, this._l);
    const b = ease((t - BACK0) / (BACK1 - BACK0));
    if (b > 0) {
      this._p.lerp(this._pos0, b);
      this._l.lerp(this._tgt0, b);
    }
    cam.position.copy(this._p);
    cam.lookAt(this._l);
    scene.controls.target.copy(this._l);

    // glints on the painted nails
    for (let k = 0; k < this._pn; k++) {
      const f = this._pf[k];
      const x = (t - this._pt[k]) / PULSE;
      if (x >= 0 && x - dt / PULSE < 0) {
        const s = app.sparkles;
        const rec = hm.getNail(this.hand, FINGERS[f]);
        if (s && rec && hm.getNailWorldPosition(FINGERS[f], this._v)) {
          s.burst(this._v, 10);
          s.sweep(rec.mesh, 8, 0xffffff, 0.35);
        }
        app.sound.sparkle();
      }
      if (x > -0.1 && x < 1.2) hm.setRevealPulse(this.hand, FINGERS[f], x > 0 && x < 1 ? x : 0);
    }

    // finger wiggle 2.2 .. 3.2 s, a wave from the pinky to the thumb
    const w = (t - 2.2) / 1.0;
    if (w > 0 && w < 1.05) this._wiggle(w < 1 ? Math.sin(Math.PI * w) : 0, t);

    // stars, in time with the jingle's dings
    if (this._flashT >= 0 && this._stars < this.stars && t - this._flashT >= DING[this._stars]) {
      this._starSpans[this._stars++].className = 'on';
    }
    if (!this._dropped && t >= DROP) {
      this._dropped = true;
      this.wall.stack.classList.add('show');
      this.wall.drop();
      this.starsEl.classList.add('off');
    }
    if (t >= END) this.finish();
    else app.invalidate();
  }

  _wiggle(env, t) {
    const bones = this._bones;
    if (!bones.length) {
      this.app.nail.getMesh().rotation.z = this._rock + 0.052 * env * Math.sin(t * 13);
      return;
    }
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const a = 0.13 * b.k * env * Math.sin((t - 2.2) * 15 - (4 - b.f) * 0.7);
      b.bone.quaternion.copy(this._rest[i]).multiply(this._q.setFromAxisAngle(XAXIS, a));
    }
  }

  /** After the main render: grab the flash-lit frame for the polaroid. */
  _after() {
    if (!this.running || this._shot || !this.app.loop.renderedThisFrame) return;
    // First use of the encoder and the confetti draw (slow once on software
    // GL): paid together in the first, dark frame of the session.
    if (this._warm) {
      this._warm = false;
      this.photo.encode();
      this.confetti.stop();
    } else if (this.t >= SHOT) this._takePhoto();
  }

  /** Until the GPU has the photo (outlives the show if it must). */
  _poll(force) {
    const r = this.photo.poll(force === true);
    if (!r) return;
    this.app.loop.remove(this._poll);
    if (r < 0) this.wall.setPhoto('');
    else if (force === true) this.wall.setPhoto(this.photo.encode());
    else setTimeout(() => this.wall.setPhoto(this.photo.encode()), 0); // encode off the frame
  }

  _takePhoto() {
    const app = this.app;
    this._shot = true;
    this._flashT = this.t;
    if (!app.scene.contextLost && this.photo.capture(app.scene.renderer)) {
      this.wall.present(this.stars);
      app.loop.add(this._poll, 96);
    }
    // every painted nail glints for the camera
    for (let k = 0; k < this._pn; k++) {
      if (app.sparkles && app.nail.getNailWorldPosition(FINGERS[this._pf[k]], this._v)) app.sparkles.burst(this._v, 8, 0xffffff);
    }
    // one white flash; the full-screen layer exists only for its 0.3 s
    this.flash.classList.add('go');
    setTimeout(() => this.flash.classList.remove('go'), 350);
    app.events.emit(EVENTS.REVEAL_FLASH, { stars: this.stars });
    this.confetti.burst(app.quality.settings.confetti, app.scene.camera.aspect);
    this.starsEl.classList.remove('off');
    this.starsEl.classList.add('on');
  }

  /** Jump to the end (tap after 1 s, hidden tab, safety timer). The photo is still taken. */
  skip() {
    if (!this.running) return;
    if (!this._shot) {
      const scene = this.app.scene;
      spline(this._cp, 1, this._p);
      spline(this._lp, 1, this._l);
      scene.camera.position.copy(this._p);
      scene.camera.lookAt(this._l);
      scene.setDim(1);
      if (this._bones.length) this._wiggle(0, 0);
      scene.render();
      this._takePhoto();
    }
    if (this.photo.sync) this._poll(true);
    this.wall.dropNow();
    this.finish();
  }

  finish() {
    if (!this.running) return;
    const app = this.app;
    const scene = app.scene;
    const hm = app.nail;
    this.running = false;
    clearTimeout(this._safety);
    app.loop.remove(this._tick);
    app.loop.remove(this._after);

    // exact restore: camera, controls, lights, bones, glints
    scene.camera.position.copy(this._pos0);
    scene.camera.quaternion.copy(this._q0);
    scene.controls.target.copy(this._tgt0);
    scene.controls.enabled = this._ctl;
    scene.setDim(1);
    for (let i = 0; i < this._bones.length; i++) this._bones[i].bone.quaternion.copy(this._rest[i]);
    if (!this._bones.length) hm.getMesh().rotation.z = this._rock;
    for (let i = 0; i < 5; i++) if (this._has[i]) hm.setRevealPulse(this.hand, FINGERS[i], 0);
    if (!this._dropped) this.wall.dropNow();

    this.starsEl.classList.remove('on', 'off');
    this.wall.stack.classList.remove('show');
    document.body.classList.remove('revealing');
    if (this._brush && app.currentTool === 'polish') app.polishBrush3D.activate();
    app.quality.release();
    app.invalidate();
    app.events.emit(EVENTS.REVEAL_DONE, { stars: this.stars });
  }
}

function wallClose(wall) {
  if (wall.isOpen) wall.close();
}
