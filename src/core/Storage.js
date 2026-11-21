/**
 * Storage.js
 * The only module allowed to touch localStorage. Every access is wrapped in
 * try/catch so the game is fully playable with storage blocked (private mode,
 * blocked site data, quota exceeded, sandboxed iframes).
 */

export class Storage {
  constructor(prefix = 'mns.') {
    this.prefix = prefix;
    this._mem = new Map(); // fallback so reads after writes still work when storage is blocked
    this._backend = null;
    try {
      const ls = window.localStorage;
      const probe = `${prefix}__probe`;
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      this._backend = ls;
    } catch (err) {
      this._backend = null;
    }
  }

  get available() {
    return this._backend !== null;
  }

  /**
   * Read a JSON value. Returns `fallback` on any error or when missing.
   */
  get(key, fallback = null) {
    const k = this.prefix + key;
    try {
      if (this._backend) {
        const raw = this._backend.getItem(k);
        if (raw === null) return this._mem.has(k) ? this._mem.get(k) : fallback;
        return JSON.parse(raw);
      }
    } catch (err) {
      // fall through to memory
    }
    return this._mem.has(k) ? this._mem.get(k) : fallback;
  }

  /**
   * Write a JSON value. Returns false when it could not be persisted
   * (quota, blocked storage, unserialisable value).
   */
  set(key, value) {
    const k = this.prefix + key;
    this._mem.set(k, value);
    if (!this._backend) return false;
    try {
      this._backend.setItem(k, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  remove(key) {
    const k = this.prefix + key;
    this._mem.delete(k);
    if (!this._backend) return;
    try {
      this._backend.removeItem(k);
    } catch (err) {
      // ignore
    }
  }
}

export const storage = new Storage();
