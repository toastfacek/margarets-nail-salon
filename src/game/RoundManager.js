/**
 * RoundManager.js (WP6)
 * The game loop: a client arrives, the kid paints, presses the Done heart,
 * gets 1 to 3 stars (never fewer than 1), the client leaves, the next one
 * arrives. No timer, no fail.
 *
 *   arrive -> paint -> done -> (reveal) -> leave -> arrive ...
 *
 * ------------------------------------------------------------------------
 * POKI HOOKS (the later SDK step needs exactly these two events, nothing else)
 *   roundStart { index, request }  -> PokiSDK.gameplayStart()
 *       fired once per client, when the hand has arrived and painting opens.
 *   roundEnd   { index, stars }    -> PokiSDK.gameplayStop(), then
 *       PokiSDK.commercialBreak(). Fired once per client, only after that
 *       client's reveal is over: between clients, never mid-paint, never
 *       before the first reveal. To hold the next client until the break is
 *       finished, set `app.game.between = () => promise`; it is awaited
 *       before the next client arrives (mute audio with the 'ad' reason).
 * ------------------------------------------------------------------------
 *
 * WP7 handoff: on Done this emits `reveal:request { stars, hand, fingers }`
 * and waits for `reveal:done` (hard timeout 8 s). With no reveal installed it
 * plays a tiny fallback (stars pop, ding, yay) and goes on.
 */
import { EVENTS } from '../core/GameEvents.js';
import { makeRequest, rng, PALETTE } from './ClientRequests.js';
import { score } from './Scoring.js';

const FINGER_LIST = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const SLIDE_IN = 0.6;
const SLIDE_OUT = 0.45;
const ADVANCE_DELAY = 0.5;
const REVEAL_TIMEOUT = 8000;
const NPAL = PALETTE.length + 1; // palette colours + "other"

const backOut = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

export class RoundManager {
  /**
   * @param {object} app the NailArtistApp
   * @param {object} ui { onArrive(req), onPaint(), onDone(stars), onLeave(), onAdvance(finger), celebrate(stars) -> Promise }
   */
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.state = 'idle';
    this.index = -1;
    this.request = null;
    this.rand = rng(Date.now());
    this.result = null;
    this.ready = false;
    // stroke frames per (finger, palette colour), for the colour match
    this.counts = new Float32Array(FINGER_LIST.length * NPAL);
    this._col = NPAL - 1;
    this._advanceT = -1;
    this.noAdvance = false; // ?perf=1
    this._slide = 0;       // seconds left in the slide, 0 = none
    this._slideDir = 0;    // 1 = in, -1 = out
    this._base = app.nail.getMesh().position.clone();
    this._down = this._base.clone();
    this._slideDist = 0.6;

    const ev = app.events;
    ev.on(EVENTS.BRUSH_STROKE_START, (p) => {
      this._col = PALETTE.indexOf(p.color);
      if (this._col < 0) this._col = NPAL - 1;
    });
    ev.on(EVENTS.BRUSH_STROKE, () => {
      if (this.state !== 'paint') return;
      const fi = FINGER_LIST.indexOf(app.nail.getActiveNail());
      if (fi >= 0) this.counts[fi * NPAL + this._col] += 1;
    });
    ev.on(EVENTS.NAIL_COVERED, (p) => {
      if (this.state === 'paint' && this.wants(p.finger) && p.finger === app.nail.getActiveNail()) this._advanceT = ADVANCE_DELAY;
    });
    ev.on(EVENTS.UI_DONE, () => {
      if (app.mode === 'round' && this.state === 'paint' && this.ready) this.done();
    });
  }

  get hand() {
    return this.app.nail.getCurrentHand();
  }

  wants(finger) {
    return !!this.request && this.request.fingers.indexOf(finger) !== -1;
  }

  coverage(finger) {
    return this.app.polishBrush3D.getCoverage(this.hand, finger);
  }

  /** Average coverage over the requested nails. */
  average() {
    const f = this.request ? this.request.fingers : [];
    let s = 0;
    for (let i = 0; i < f.length; i++) s += this.coverage(f[i]);
    return f.length ? s / f.length : 0;
  }

  /** First requested finger after `from` still under 90%, or null. */
  nextFinger(from) {
    const f = this.request.fingers;
    const k = f.indexOf(from);
    for (let i = 1; i <= f.length; i++) {
      const g = f[(k + i) % f.length];
      if (this.coverage(g) < 0.9) return g;
    }
    return null;
  }

  // ------------------------------------------------------------- states --

  /** Next client. `instant`: no slide (the very first client on load). */
  arrive(instant = false) {
    const app = this.app;
    this.state = 'arrive';
    this.index++;
    this.request = makeRequest(this.index, this.rand);
    this.result = null;
    this.ready = false;
    this.counts.fill(0);
    this._advanceT = -1;
    const req = this.request;

    this._placeHand(0);
    if (this.index > 0) this.clearHand();
    this.setSkin(req.skinTone);
    if (this.index === 0) app.polishBrush3D.setColor(req.color);
    app.selectNail(req.fingers[0]);
    app.polishBrush3D.setFinish(req.finish);
    app.zoomToFinger(req.fingers[0]);
    app.updateFingerSelectorUI?.();
    this.ui.onArrive(req);

    if (instant) {
      this.paint();
    } else {
      // slide in from below the screen
      this._down.set(0, -1, 0).applyQuaternion(app.scene.camera.quaternion);
      this._slideDir = 1;
      this._slide = SLIDE_IN;
      this._placeHand(1);
      app.quality.hold(1200);
    }
  }

  paint() {
    this.state = 'paint';
    this.ui.onPaint();
    this.app.events.emit(EVENTS.ROUND_START, { index: this.index, request: this.request });
  }

  /** The kid pressed Done: score, reveal, then the client leaves. */
  async done() {
    const app = this.app;
    const req = this.request;
    this.state = 'done';
    this._advanceT = -1;
    const cov = req.fingers.map((f) => this.coverage(f));
    // the colour painted most on the requested nails
    let best = -1, bestN = 0;
    for (let c = 0; c < NPAL; c++) {
      let n = 0;
      for (const f of req.fingers) n += this.counts[FINGER_LIST.indexOf(f) * NPAL + c];
      if (n > bestN) { bestN = n; best = c; }
    }
    this.result = score(cov, best >= 0 && best < PALETTE.length ? PALETTE[best] : null, req.color);
    const stars = this.result.stars;
    this.ui.onDone(stars);

    const ev = app.events;
    if (ev.listenerCount(EVENTS.REVEAL_REQUEST) > 0) {
      app.quality.hold();
      await new Promise((resolve) => {
        let off = null;
        const t = setTimeout(() => { off(); resolve(); }, REVEAL_TIMEOUT);
        off = ev.once(EVENTS.REVEAL_DONE, () => { clearTimeout(t); resolve(); });
        ev.emit(EVENTS.REVEAL_REQUEST, { stars, hand: this.hand, fingers: req.fingers.slice() });
      });
      app.quality.release();
    } else {
      await this.ui.celebrate(stars);
    }

    // Poki: gameplayStop + commercialBreak hook (see header).
    ev.emit(EVENTS.ROUND_END, { index: this.index, stars });
    app.storage.set('seen.intro', true);
    if (app.game && typeof app.game.between === 'function') {
      try { await app.game.between(); } catch (err) { /* never block the next client */ }
    }
    this.leave();
  }

  leave() {
    this.state = 'leave';
    this.ui.onLeave();
    this._down.set(0, -1, 0).applyQuaternion(this.app.scene.camera.quaternion);
    this._slideDir = -1;
    this._slide = SLIDE_OUT;
    this.app.quality.hold(1000);
  }

  // -------------------------------------------------------------- frame --

  /** FrameLoop callback. Returns true when something moved. */
  update(dt, pointerDown) {
    if (this._slide > 0) {
      this._slide = Math.max(0, this._slide - dt);
      if (this._slideDir > 0) {
        this._placeHand(1 - backOut(1 - this._slide / SLIDE_IN));
        if (this._slide === 0) this.paint();
      } else {
        const t = 1 - this._slide / SLIDE_OUT;
        this._placeHand(t * t);
        if (this._slide === 0) this.arrive();
      }
      return true;
    }
    if (this._advanceT >= 0 && !pointerDown && !this.noAdvance) {
      this._advanceT -= dt;
      if (this._advanceT < 0) {
        const next = this.nextFinger(this.app.nail.getActiveNail());
        if (next) this.goTo(next);
      }
    }
    return false;
  }

  /** Paint another requested nail (auto-advance or a tap on it). */
  goTo(finger) {
    const app = this.app;
    app.selectNail(finger);
    app.polishBrush3D.setFinish(this.request.finish);
    app.zoomToFinger(finger);
    app.updateFingerSelectorUI?.();
    this.ui.onAdvance(finger);
  }

  // ------------------------------------------------------------ helpers --

  /** Hand offset along screen-down: 0 = at rest, 1 = fully below. */
  _placeHand(k) {
    const root = this.app.nail.getMesh();
    root.position.copy(this._base).addScaledVector(this._down, this._slideDist * k);
    root.updateMatrixWorld(true);
    this.app.invalidate();
  }

  /** Paint, decorations and finish off every nail of the current hand. */
  clearHand() {
    const app = this.app;
    const hm = app.nail;
    const hand = this.hand;
    for (const f of FINGER_LIST) {
      if (!hm.getNail(hand, f)) continue;
      hm.setActiveNail(f);
      app.polishBrush3D.clearNail();
      hm.clearDrawing();
      app.gemTool?.clearNail?.(hand, f);
      hm.setFinish('glossy', hand, f);
    }
  }

  /** Client skin tone (uniform only). Uses WP3's setSkinTone when present. */
  setSkin(hex) {
    const hm = this.app.nail;
    if (typeof hm.setSkinTone === 'function') {
      hm.setSkinTone(hex);
    } else {
      for (const h of ['left', 'right']) {
        for (const s of (hm.hands && hm.hands[h] && hm.hands[h].skins) || []) {
          if (s.standard && s.standard.color) s.standard.color.set(hex);
          if (s.lambert) s.lambert.color.set(hex);
        }
      }
    }
    this.app.invalidate();
  }
}
