/**
 * GameEvents.js
 * Tiny synchronous event emitter used by every module to talk to every other
 * module. No dependencies.
 *
 * Payload objects of per-frame events (brush:stroke) are reused by the emitter
 * side, so listeners must copy what they need and never keep the object.
 */

export const EVENTS = Object.freeze({
  QUALITY_CHANGE: 'quality:change',
  TOOL_CHANGE: 'tool:change',
  NAIL_SELECT: 'nail:select',
  BRUSH_STROKE_START: 'brush:strokeStart',
  BRUSH_STROKE: 'brush:stroke',
  BRUSH_STROKE_END: 'brush:strokeEnd',
  NAIL_COVERAGE: 'nail:coverage',
  NAIL_COVERED: 'nail:covered',
  NAIL_CURED: 'nail:cured',
  DECO_PLACED: 'deco:placed',
  DRYER_START: 'dryer:start',
  DRYER_STOP: 'dryer:stop',
  UI_DONE: 'ui:done',
  UI_GALLERY: 'ui:gallery',
  UI_MUTE: 'ui:mute',
  ROUND_START: 'roundStart',
  ROUND_END: 'roundEnd',
  REVEAL_REQUEST: 'reveal:request',
  REVEAL_START: 'reveal:start',
  REVEAL_FLASH: 'reveal:flash',
  REVEAL_DONE: 'reveal:done',
  BOWL_OPEN: 'bowl:open',
  BOWL_DROP: 'bowl:drop',
  BOWL_DUNK: 'bowl:dunk',
  BOWL_CLOSE: 'bowl:close',
});

const EMPTY = Object.freeze([]);

export class GameEvents {
  constructor() {
    // name -> array of listeners. Arrays are replaced (copy-on-write) on
    // on/off so emit can iterate without allocating and without being
    // disturbed by listeners that unsubscribe themselves.
    this._listeners = new Map();
  }

  /**
   * Subscribe. Returns an unsubscribe function.
   */
  on(name, fn) {
    const list = this._listeners.get(name) || EMPTY;
    if (list.indexOf(fn) !== -1) return () => this.off(name, fn);
    const next = list.slice();
    next.push(fn);
    this._listeners.set(name, next);
    return () => this.off(name, fn);
  }

  /**
   * Subscribe for one emit only.
   */
  once(name, fn) {
    const wrapper = (payload) => {
      this.off(name, wrapper);
      fn(payload);
    };
    return this.on(name, wrapper);
  }

  off(name, fn) {
    const list = this._listeners.get(name);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i === -1) return;
    const next = list.slice();
    next.splice(i, 1);
    if (next.length) this._listeners.set(name, next);
    else this._listeners.delete(name);
  }

  emit(name, payload) {
    const list = this._listeners.get(name);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        // A broken listener must never take the game down.
        console.error(`[events] listener for "${name}" failed`, err);
      }
    }
  }

  listenerCount(name) {
    const list = this._listeners.get(name);
    return list ? list.length : 0;
  }
}
