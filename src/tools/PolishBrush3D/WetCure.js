/**
 * WetCure.js
 * Per-nail wetness: wet while painted, then it sets to "tacky", and the dryer
 * (or the reveal) cures it.
 *
 *   brush:strokeStart -> 1 (wet)
 *   brush:strokeEnd   -> hold 1 for 1.5 s, then ease to 0.35 over 6 s (tacky)
 *   dryer held        -> runs to 0 in about 1.2 s, then nail:cured
 *   cure(h, f, s)     -> to 0 over s seconds (0 = now), then nail:cured
 *
 * Drives HandModel.setWetness() (uniform only). Only nails that are changing
 * are touched each frame; update() returns false (no render needed) when
 * nothing animates. No allocations after construction.
 */
import { EVENTS } from '../../core/GameEvents.js';

export const WET = Object.freeze({
  HOLD: 1.5,
  TACKY_TIME: 6,
  TACKY: 0.35,
  DRYER_TIME: 1.2,
});

const IDLE = 0;      // resting (cured, tacky or never painted)
const PAINTING = 1;  // held at 1 while the brush is down
const HOLDING = 2;   // stroke ended, still glossy wet
const SETTING = 3;   // easing to tacky
const DRYING = 4;    // dryer / cure animation towards 0

function smooth(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

class NailWet {
  constructor(hand, finger) {
    this.hand = hand;
    this.finger = finger;
    this.w = 0;
    this.phase = IDLE;
    this.t = 0;
    this.from = 0;
    this.duration = 0;
    this.listed = false;
    this.painted = false; // ever had paint since the last reset
  }
}

export class WetCure {
  /**
   * @param {import('../../scene/HandModel.js').HandModel} handModel
   * @param {import('../../core/GameEvents.js').GameEvents|null} events
   */
  constructor(handModel, events = null) {
    this.handModel = handModel;
    this.events = events;
    this._nails = new Map(); // key "hand:finger" -> NailWet (created once per nail)
    this._active = [];       // NailWet currently animating (capacity grows to 10 once)
    this._activeCount = 0;
    this._curedPayload = { hand: 'left', finger: 'index' };
  }

  _get(hand, finger, create = true) {
    if (hand === null || finger === null) return null;
    let byHand = this._nails.get(hand);
    if (!byHand) {
      if (!create) return null;
      byHand = new Map();
      this._nails.set(hand, byHand);
    }
    let n = byHand.get(finger);
    if (!n && create) {
      n = new NailWet(hand, finger);
      byHand.set(finger, n);
    }
    return n || null;
  }

  _activate(n) {
    if (n.listed) return;
    n.listed = true;
    this._active[this._activeCount++] = n;
  }

  _apply(n) {
    this.handModel.setWetness(n.hand, n.finger, n.w);
  }

  /** 0..1 current wetness (0 when never painted). */
  get(hand, finger) {
    const n = this._get(hand, finger, false);
    return n ? n.w : 0;
  }

  /** True while the nail is wet or tacky (not cured). */
  isWet(hand, finger) {
    return this.get(hand, finger) > 0.001;
  }

  /** True while the dryer / cure animation runs on that nail. */
  isDrying(hand, finger) {
    const n = this._get(hand, finger, false);
    return !!n && n.phase === DRYING;
  }

  /** Fresh paint: wet, held until release(). */
  wet(hand, finger) {
    const n = this._get(hand, finger);
    if (!n) return;
    n.painted = true;
    n.w = 1;
    n.phase = PAINTING;
    n.t = 0;
    this._apply(n);
  }

  /** The brush lifted: start the hold -> tacky timeline. */
  release(hand, finger) {
    const n = this._get(hand, finger, false);
    if (!n || n.phase !== PAINTING) return;
    n.phase = HOLDING;
    n.t = 0;
    this._activate(n);
  }

  /** Paint applied in one go (fill, auto stroke): wet, then the usual timeline. */
  splash(hand, finger) {
    this.wet(hand, finger);
    this.release(hand, finger);
  }

  /**
   * Cure towards 0 over `seconds` (dryer: WET.DRYER_TIME). Emits nail:cured
   * when it lands. 0 seconds cures immediately.
   */
  cure(hand, finger, seconds = WET.DRYER_TIME) {
    const n = this._get(hand, finger, false);
    if (!n || n.w <= 0.001) return;
    if (seconds <= 0) {
      n.w = 0;
      n.phase = IDLE;
      this._apply(n);
      this._emitCured(n);
      return;
    }
    n.phase = DRYING;
    n.t = 0;
    n.from = n.w;
    // a partially cured nail takes proportionally less time
    n.duration = seconds * Math.max(0.25, n.w);
    this._activate(n);
  }

  /** Dryer released early: stay where it got to (and keep setting if above tacky). */
  stopCure(hand, finger) {
    const n = this._get(hand, finger, false);
    if (!n || n.phase !== DRYING) return;
    if (n.w > WET.TACKY) {
      n.phase = SETTING;
      n.from = n.w;
      n.t = 0;
      n.duration = WET.TACKY_TIME * (n.w - WET.TACKY) / (1 - WET.TACKY);
    } else {
      n.phase = IDLE;
    }
  }

  /** Cure every wet nail of a hand (the reveal). */
  cureAll(hand, seconds = 0.6) {
    const byHand = this._nails.get(hand);
    if (!byHand) return;
    byHand.forEach((n) => this.cure(n.hand, n.finger, seconds));
  }

  /** Paint cleared: back to a bare, dry nail. No event. */
  reset(hand, finger) {
    const n = this._get(hand, finger, false);
    if (!n) return;
    n.w = 0;
    n.phase = IDLE;
    n.painted = false;
    this._apply(n);
  }

  _emitCured(n) {
    if (!this.events) return;
    const p = this._curedPayload;
    p.hand = n.hand;
    p.finger = n.finger;
    this.events.emit(EVENTS.NAIL_CURED, p);
  }

  /**
   * Advance every animating nail. Returns true when anything changed.
   * @param {number} dt seconds (loop dt)
   */
  update(dt) {
    if (this._activeCount === 0) return false;
    let write = 0;
    const list = this._active;
    const count = this._activeCount;
    for (let i = 0; i < count; i++) {
      const n = list[i];
      n.t += dt;
      let done = false;
      switch (n.phase) {
        case HOLDING:
          if (n.t >= WET.HOLD) {
            n.phase = SETTING;
            n.t = 0;
            n.from = n.w;
            n.duration = WET.TACKY_TIME;
          }
          break;
        case SETTING: {
          const k = smooth(n.t / n.duration);
          n.w = n.from + (WET.TACKY - n.from) * k;
          this._apply(n);
          if (k >= 1) {
            n.phase = IDLE;
            done = true;
          }
          break;
        }
        case DRYING: {
          // ease-in so the gloss visibly "sets" towards the end
          const x = n.t / n.duration;
          const k = x >= 1 ? 1 : x * x * (2 - x);
          n.w = n.from * (1 - k);
          this._apply(n);
          if (x >= 1) {
            n.w = 0;
            n.phase = IDLE;
            this._apply(n);
            this._emitCured(n);
            done = true;
          }
          break;
        }
        default:
          // PAINTING (re-wet mid-timeline) or IDLE: leave the list
          done = true;
      }
      if (done) n.listed = false;
      else list[write++] = n;
    }
    // Listeners of nail:cured may have activated nails meanwhile (appended
    // after `count`): keep them.
    const total = this._activeCount;
    for (let i = count; i < total; i++) list[write++] = list[i];
    for (let i = write; i < total; i++) list[i] = null;
    this._activeCount = write;
    return true;
  }
}
