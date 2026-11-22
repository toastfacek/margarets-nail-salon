/**
 * RevealDirector.js (WP7): the Slay reveal, a ~4.5 s show driven by app.loop.
 *
 *   0.0  reveal:start; UI fades (body.revealing), brush away, input locked,
 *        wet nails cure, lights go down (scene.setDim 0.45 by 0.6 s)
 *   0.3  camera sweep (Catmull-Rom): low on the pinky side, over the
 *        knuckles, to a low hero shot of the painted nails; each painted nail
 *        it passes gets a shader glint (setRevealPulse), a sparkle pop, a shimmer
 *   2.8  the photo (room at 0.75, backdrop kept dark so the colour pops),
 *        white flash, reveal:flash (WP5: shutter, confetti pop, the jingle and
 *        its star dings), confetti cannons; the polaroid pops up once the
 *        photo lands. Big stars and a canvas punch on each ding (CSS delays)
 *   3.0  jazz hands: the fingers wiggle over the dings
 *   last ding: the client's "yay", a pink heart burst, a second confetti volley
 *   END-0.45  camera glides back; the polaroid flies onto the stack
 *   END  everything restored exactly, reveal:done. END = last ding + 0.35 s,
 *        so WP5's yay on reveal:done collapses into ours (its 0.5 s gap)
 *
 * A tap after 1 s jumps to the photo; another tap ends the show. The tap is
 * swallowed until that pointer lifts (+300 ms). A hidden tab ends the show.
 * Zero allocations per frame.
 */
import * as THREE from 'three';
import { EVENTS } from '../core/GameEvents.js';
import { STAR } from './PolaroidWall.js';

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const SWEEP0 = 0.3, SHOT = 2.8;
const DING = [1.07, 1.29, 1.51]; // revealJingle's star dings, after the flash (also in reveal.css)
const PULSE = 0.6;
const PINK = 0xff2a6d;

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
// uniform Catmull-Rom through 4 points (ends held), no allocation
const cr = (a, b, c, d, t, t2, t3) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
function spline(P, u, out) {
  const x = u * 3;
  const i = x < 2 ? x | 0 : 2;
  const t = x - i, t2 = t * t, t3 = t2 * t;
  const a = P[i ? i - 1 : 0], b = P[i], c = P[i + 1], d = P[i < 2 ? i + 2 : 3];
  return out.set(cr(a.x, b.x, c.x, d.x, t, t2, t3), cr(a.y, b.y, c.y, d.y, t, t2, t3), cr(a.z, b.z, c.z, d.z, t, t2, t3));
}

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
    this._want = [false, false, false, false, false];
    // pulses: finger index and start time, in sweep order
    this._pf = new Int8Array(5);
    this._pt = new Float32Array(5);
    this._pn = 0;
    this._bones = [];
    this._rest = [];

    this.flash = document.createElement('div');
    this.flash.className = 'rv-flash';
    this.starsEl = document.createElement('div');
    this.starsEl.className = 'rv-stars';
    this.starsEl.innerHTML = `<span>${STAR}</span>`.repeat(3);
    document.body.append(this.flash, this.starsEl);

    this._tick = this._tick.bind(this);
    this._after = this._after.bind(this);
    this._poll = this._poll.bind(this);
    // Input lock. The tap that skips is swallowed until its pointer lifts
    // (+300 ms), so its up/click never lands on the restored UI.
    this._hold = -1;     // pointerId being swallowed
    this._until = 0;     // swallow everything until this time
    const block = (e) => {
      const now = performance.now();
      if (!this.running && now > this._until) return;
      e.stopPropagation();
      if ((e.type === 'pointerup' || e.type === 'pointercancel') && e.pointerId === this._hold) {
        this._hold = -1;
        this._until = now + 300;
      }
      if (e.type === 'pointerdown' && this.running && this.t > 1) {
        this._hold = e.pointerId;
        this._until = now + 2000; // released by that pointer's up, at the latest in 2 s
        if (this.t < SHOT && !this._shot) this._jump();
        else this.end();
      }
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
      window.addEventListener(type, block, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.end(); });
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
    const cam = this.app.scene.camera;
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
    const F = new THREE.Box3().setFromObject(this.app.nail.hands[this.hand].model).getCenter(this._F);
    F.subVectors(all, F).setY(0);
    if (F.lengthSq() < 1e-6) F.set(-1, 0, 0);
    F.normalize();
    const S = this._S.crossVectors(UP, F);
    if (this._has[0] && this._has[4] && S.dot(this._p.subVectors(N[4], N[0])) < 0) S.negate();

    // hero: the painted nails, low from the wrist side, framed for this screen
    const L = this._lp[3].lerpVectors(all, req, 0.8);
    let R = 0.2;
    for (let i = 0; i < 5; i++) if (this._has[i]) R = Math.max(R, N[i].distanceTo(L));
    const half = THREE.MathUtils.degToRad(cam.fov * 0.5);
    const fit = Math.min(half, Math.atan(Math.tan(half) * cam.aspect));
    const d = (R * 0.55 + 0.04) / Math.tan(fit);
    this._cp[3].copy(UP).multiplyScalar(0.7).addScaledVector(F, -0.6).addScaledVector(S, 0.2).normalize().multiplyScalar(d).add(L);

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
    this._flashT = this._end = 99;
    this._dropped = this._yay = false;
    app.quality.hold();
    if (this.wall.isOpen) this.wall.close();

    // hold the camera (no resize re-framing), snapshot it, stop any zoom in flight, lock the controls
    scene.holdCamera(true);
    scene.isAnimating = false;
    this._aspect = cam.aspect;
    this._pos0.copy(cam.position);
    this._q0.copy(cam.quaternion);
    this._tgt0.copy(scene.controls.target);
    this._ctl = scene.controls.enabled;
    scene.controls.enabled = false;

    // nails and their sweep order (pinky side first)
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
    this._rock = hm.getMesh().rotation.z;

    // brush away, every nail hard and glossy
    this._brush = app.polishBrush3D && app.polishBrush3D.isActive;
    if (this._brush) app.polishBrush3D.deactivate();
    if (app.brushJuice) app.brushJuice.cureAll(this.hand, 0.3);

    document.body.classList.add('revealing');
    this.starsEl.dataset.n = this.stars;
    this._safety = setTimeout(() => this.end(), 6000);
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
    const back = ease((t - this._end + 0.5) / 0.45); // glide home over the last half second

    // lights: down by 0.6 s; 0.75 for the photo with the room kept dark; after
    // the flash the hand is lit and the room stays low until the glide home
    const k = this._shot ? ease((t - this._flashT) / 0.5) : 0;
    const d = t < SHOT ? 1 - 0.55 * ease(t / 0.6) : this._shot ? 0.75 + 0.15 * k + 0.1 * back : 0.75;
    scene.setDim(d);
    if (scene.backdrop) scene.backdrop.setDim(0.4 + 0.6 * back);

    // camera: sweep to the hero shot, hold, glide back
    const u = ease((t - SWEEP0) / (SHOT - SWEEP0));
    spline(this._cp, u, this._p);
    spline(this._lp, u, this._l);
    if (back > 0) {
      this._p.lerp(this._pos0, back);
      this._l.lerp(this._tgt0, back);
    }
    cam.position.copy(this._p);
    cam.lookAt(this._l);
    scene.controls.target.copy(this._l);

    // glints on the painted nails
    for (let i = 0; i < this._pn; i++) {
      const f = this._pf[i];
      const x = (t - this._pt[i]) / PULSE;
      if (x >= 0 && x - dt / PULSE < 0) {
        const rec = hm.getNail(this.hand, FINGERS[f]);
        if (app.sparkles && rec && hm.getNailWorldPosition(FINGERS[f], this._v)) {
          app.sparkles.burst(this._v, 10);
          app.sparkles.sweep(rec.mesh, 8, 0xffffff, 0.35);
        }
        app.sound.sparkle();
      }
      if (x > -0.1 && x < 1.2) hm.setRevealPulse(this.hand, FINGERS[f], x > 0 && x < 1 ? x : 0);
    }

    // jazz hands over the dings
    const w = (t - 3.0) / 0.9;
    if (w > 0 && w < 1.1) this._wiggle(w < 1 ? Math.sin(Math.PI * w) : 0, t);

    // the last ding: the client loves it
    if (!this._yay && t - this._flashT >= DING[this.stars - 1]) {
      this._yay = true;
      app.sound.clientYay(this.stars - 1);
      for (let i = 0; i < this._pn; i++) {
        if (app.sparkles && hm.getNailWorldPosition(FINGERS[this._pf[i]], this._v)) app.sparkles.burst(this._v, 16, PINK);
      }
      this.confetti.burst(app.quality.settings.confetti, cam.aspect);
    }
    if (!this._dropped && t >= this._end - 0.45) {
      this._dropped = true;
      this.wall.stack.classList.add('show');
      this.wall.drop();
      this.starsEl.classList.add('off');
    }
    if (t >= this._end) this.finish();
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
      const a = 0.13 * b.k * env * Math.sin((t - 3) * 15 - (4 - b.f) * 0.7);
      b.bone.quaternion.copy(this._rest[i]).multiply(this._q.setFromAxisAngle(XAXIS, a));
    }
  }

  /** After the main render: take the photo of this frame. */
  _after() {
    if (this.running && !this._shot && this.t >= SHOT && this.app.loop.renderedThisFrame) this._takePhoto();
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
    this._end = this.t + DING[this.stars - 1] + 0.35;
    if (!app.scene.contextLost && this.photo.capture(app.scene.renderer)) {
      this.wall.present(this.stars);
      app.loop.add(this._poll, 96);
    }
    // every painted nail glints for the camera
    for (let i = 0; i < this._pn; i++) {
      if (app.sparkles && app.nail.getNailWorldPosition(FINGERS[this._pf[i]], this._v)) app.sparkles.burst(this._v, 8, 0xffffff);
    }
    // one white flash; stars and canvas punches run on CSS delays from here
    this.flash.classList.add('go');
    this.starsEl.className = 'rv-stars on';
    document.body.dataset.ding = this.stars;
    setTimeout(() => this.flash.classList.remove('go'), 350);
    app.events.emit(EVENTS.REVEAL_FLASH, { stars: this.stars });
    this.confetti.burst(app.quality.settings.confetti, app.scene.camera.aspect);
  }

  /** Tap before the photo: skip the sweep, straight to the hero shot. */
  _jump() {
    for (let i = 0; i < this._pn; i++) this.app.nail.setRevealPulse(this.hand, FINGERS[this._pf[i]], 0);
    this._pn = 0;
    this.t = SHOT;
  }

  /** End now (second tap, hidden tab, safety timer). The photo is still taken. */
  end() {
    if (!this.running) return;
    if (!this._shot) {
      const scene = this.app.scene;
      spline(this._cp, 1, this._p);
      spline(this._lp, 1, this._l);
      scene.camera.position.copy(this._p);
      scene.camera.lookAt(this._l);
      scene.setDim(0.75);
      if (this._bones.length) this._wiggle(0, 0);
      scene.render();
      this._takePhoto();
    }
    if (this.photo.sync) this._poll(true);
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

    // exact restore: camera, controls, lights, bones, glints. If the screen
    // changed shape meanwhile, NailScene re-frames the focused nail once released.
    scene.holdCamera(false);
    scene.camera.position.copy(this._pos0);
    scene.camera.quaternion.copy(this._q0);
    scene.controls.target.copy(this._tgt0);
    scene.controls.enabled = this._ctl;
    if (scene.camera.aspect !== this._aspect) scene.onResize();
    scene.setDim(1);
    for (let i = 0; i < this._bones.length; i++) this._bones[i].bone.quaternion.copy(this._rest[i]);
    hm.getMesh().rotation.z = this._rock;
    for (let i = 0; i < 5; i++) if (this._has[i]) hm.setRevealPulse(this.hand, FINGERS[i], 0);
    if (!this._dropped) this.wall.dropNow();

    this.starsEl.className = 'rv-stars';
    this.wall.stack.classList.remove('show');
    document.body.classList.remove('revealing');
    delete document.body.dataset.ding;
    if (this._brush && app.currentTool === 'polish') app.polishBrush3D.activate();
    app.quality.release();
    app.invalidate();
    app.events.emit(EVENTS.REVEAL_DONE, { stars: this.stars });
  }
}
