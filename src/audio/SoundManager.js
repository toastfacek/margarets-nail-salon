/**
 * SoundManager.js
 * All game audio, synthesised with the Web Audio API. There are no audio
 * files and nothing is fetched.
 *
 * - The AudioContext is created lazily inside the first user gesture
 *   (pointer/key/touch), never before, so browsers log no autoplay warnings.
 *   It is resumed on later gestures and on `visibilitychange`, and suspended
 *   while the tab is hidden.
 * - Graph (graph.js): sfxBus + musicBus -> master -> limiter -> mute -> out.
 * - Two shared noise buffers are built once (buffers.js); no play call ever
 *   creates a buffer.
 * - One-shots (recipes.js) run in a pool of at most 12 voices; the oldest is
 *   stolen with a 10 ms fade.
 * - The continuous brush sound is a single BrushVoice for the whole stroke.
 * - `setMuted(true, 'ad')` is the hook a future Poki SDK step uses around ad
 *   breaks; the player's own mute uses reason 'user' and is persisted.
 *
 * A missing or blocked AudioContext never throws: every method is a no-op.
 */

import { storage } from '../core/Storage.js';
import { createGraph } from './graph.js';
import { createNoiseBuffers } from './buffers.js';
import { RECIPES, MIN_GAP } from './recipes.js';
import { BrushVoice } from './BrushVoice.js';
import { DryerVoice } from './DryerVoice.js';
import { MusicBox } from './MusicBox.js';

const MAX_VOICES = 12;
const MAX_SOURCES_PER_VOICE = 24;
const STEAL_FADE = 0.01;
const MUTE_TAU = 0.008; // about -54 dB after 50 ms

const KEY_MUTED = 'audio.muted';
const KEY_MUSIC = 'audio.music';
const KEY_VOLUME = 'audio.volume';

const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'];

function now() {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** A pooled one-shot voice. `add` is what recipes call for each source. */
class Voice {
  constructor() {
    this.gain = null;
    this.sources = new Array(MAX_SOURCES_PER_VOICE).fill(null);
    this.count = 0;
    this.start = 0;
    this.end = 0;
  }

  add(node) {
    if (this.count < MAX_SOURCES_PER_VOICE) this.sources[this.count++] = node;
  }

  /** Fade out fast and stop everything (voice stealing). */
  kill(t) {
    if (this.gain) {
      const g = this.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(1, t);
      g.linearRampToValueAtTime(0, t + STEAL_FADE);
    }
    for (let i = 0; i < this.count; i++) {
      try {
        this.sources[i].stop(t + STEAL_FADE + 0.005);
      } catch (e) {
        // already stopped
      }
      this.sources[i] = null;
    }
    this.count = 0;
    this.end = 0;
  }

  reset() {
    for (let i = 0; i < this.count; i++) this.sources[i] = null;
    this.count = 0;
  }
}

class SoundManager {
  constructor() {
    this.audioContext = null; // old name, kept for callers
    this.ctx = null;
    this.initialized = false;
    this.unsupported = false;
    this.sfxEnabled = true;
    this.musicEnabled = true;
    this.volume = 0.9;

    this._muteReasons = new Set();
    this._graph = null;
    this._bufs = null;
    this._voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this._voices.push(new Voice());
    this._lastPlay = Object.create(null);
    this._brush = null;
    this._dryer = null;
    this._music = null;
    this._tapIndex = 2;
    this._hidden = typeof document !== 'undefined' && document.hidden;

    // Cheap counters for the perf hand-off (read via app.sound.stats).
    this.stats = {
      oneShots: 0,
      dropped: 0,
      steals: 0,
      voicesPeak: 0,
      brushUpdates: 0,
      mainMs: 0,
    };

    this._onGesture = this._onGesture.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
  }

  // ---------------------------------------------------------- lifecycle --

  /**
   * Install gesture and visibility listeners and read saved settings. Safe to
   * call many times and outside a gesture: the context itself is only made
   * inside a user gesture.
   */
  init() {
    if (this.initialized) {
      this._tryUnlock();
      return;
    }
    this.initialized = true;
    if (typeof window === 'undefined') return;

    if (storage.get(KEY_MUTED, false) === true) this._muteReasons.add('user');
    this.musicEnabled = storage.get(KEY_MUSIC, true) !== false;
    const vol = Number(storage.get(KEY_VOLUME, this.volume));
    if (Number.isFinite(vol)) this.volume = Math.max(0, Math.min(1, vol));

    for (let i = 0; i < GESTURE_EVENTS.length; i++) {
      window.addEventListener(GESTURE_EVENTS[i], this._onGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', this._onVisibility);
    this._tryUnlock();
  }

  /** True when the browser says a user gesture is active right now. */
  _gestureActive() {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return ua ? ua.isActive : false;
  }

  _tryUnlock() {
    if (!this.ctx) {
      if (this._gestureActive()) this._createContext();
    } else {
      this.resume();
    }
  }

  _onGesture(e) {
    if (!this.ctx) {
      // Without the User Activation API, trust the gesture event itself
      // (a touch pointerdown does not activate, so wait for pointerup).
      const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
      if (ua ? !ua.isActive : e.type === 'pointerdown' && e.pointerType === 'touch') return;
      this._createContext();
      return;
    }
    if (this.ctx.state !== 'running' && !this._hidden) this.resume();
  }

  _onVisibility() {
    this._hidden = document.hidden;
    if (!this.ctx) return;
    if (this._hidden) {
      this._brush.stop();
      this._dryer.stop();
      if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    } else {
      this.resume();
    }
  }

  _createContext() {
    if (this.ctx || this.unsupported) return;
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) {
      this.unsupported = true;
      return;
    }
    try {
      const ctx = new AC({ latencyHint: 'interactive' });
      this._graph = createGraph(ctx);
      this._bufs = createNoiseBuffers(ctx);
      this._graph.master.gain.value = this.volume;
      this._graph.mute.gain.value = this._muteReasons.size ? 0 : 1;
      this._brush = new BrushVoice(ctx, this._graph.sfxBus, this._bufs);
      this._dryer = new DryerVoice(ctx, this._graph.sfxBus, this._bufs);
      this._music = new MusicBox(ctx, this._graph.musicBus);
      this.ctx = ctx;
      this.audioContext = ctx;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      this._syncMusic();
    } catch (err) {
      this.unsupported = true;
      this.ctx = null;
      this.audioContext = null;
    }
  }

  /** Make sure the context is running (safe to call from anywhere). */
  resume() {
    if (!this.initialized) this.init();
    const ctx = this.ctx;
    if (!ctx) {
      if (this._gestureActive()) this._createContext();
      return;
    }
    if (ctx.state !== 'running' && ctx.state !== 'closed' && !this._hidden) {
      ctx.resume().catch(() => {});
    }
  }

  get ready() {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  // ------------------------------------------------------ mute / volume --

  /**
   * Mute or unmute. `reason` lets several owners mute independently: the
   * player ('user', persisted) and a future ad break ('ad'). Sound is on
   * only while no reason is active. Takes effect within 50 ms.
   * @returns {boolean} whether audio is now muted
   */
  setMuted(muted, reason = 'user') {
    const was = this._muteReasons.size > 0;
    if (muted) this._muteReasons.add(reason);
    else this._muteReasons.delete(reason);
    if (reason === 'user') storage.set(KEY_MUTED, !!muted);
    const is = this._muteReasons.size > 0;
    if (was === is) return is;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      const g = this._graph.mute.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(is ? 0 : 1, t, MUTE_TAU);
      if (is) {
        this._brush.stop();
        this._dryer.stop();
      }
    }
    this._syncMusic();
    return is;
  }

  isMuted(reason) {
    return reason ? this._muteReasons.has(reason) : this._muteReasons.size > 0;
  }

  get muted() {
    return this._muteReasons.size > 0;
  }

  toggleMute() {
    return this.setMuted(!this._muteReasons.has('user'), 'user');
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    storage.set(KEY_VOLUME, this.volume);
    if (this.ctx) this._graph.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  /** Lower the music by `amount` (0..1) for `seconds`, then bring it back. */
  duck(amount = 0.7, seconds = 1) {
    if (!this.ctx) return;
    const g = this._graph.musicDuck.gain;
    const t = this.ctx.currentTime;
    const a = Math.max(0, Math.min(1, amount));
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - a, t, 0.08);
    g.setTargetAtTime(1, t + Math.max(0.05, seconds), 0.4);
  }

  toggleSFX() {
    this.sfxEnabled = !this.sfxEnabled;
    if (!this.sfxEnabled && this.ctx) {
      this._brush.stop();
      this._dryer.stop();
    }
    return this.sfxEnabled;
  }

  toggleMusic() {
    this.setMusicEnabled(!this.musicEnabled);
    return this.musicEnabled;
  }

  setMusicEnabled(on) {
    this.musicEnabled = !!on;
    storage.set(KEY_MUSIC, this.musicEnabled);
    this._syncMusic();
  }

  _syncMusic() {
    if (!this._music) return;
    if (this.musicEnabled && this._muteReasons.size === 0) this._music.start();
    else this._music.stop();
  }

  // ---------------------------------------------------------- one-shots --

  _canPlay() {
    // A context made in this very gesture may still be 'suspended' for a few
    // ms; sounds scheduled now simply start when it runs. A hidden tab never
    // schedules (it would all play at once on return).
    return this.sfxEnabled && this.ctx !== null && this._muteReasons.size === 0 &&
      !this._hidden && this.ctx.state !== 'closed';
  }

  /**
   * Swallow a uiTap that follows within 45 ms (used when an event already
   * gave the same click its own sound).
   */
  holdTaps() {
    if (this.ctx) this._lastPlay.uiTap = this.ctx.currentTime + 0.004;
  }

  _allocVoice(t) {
    const voices = this._voices;
    let free = null;
    let oldest = null;
    let busy = 0;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.end <= t) {
        if (free === null) free = v;
      } else {
        busy++;
        if (oldest === null || v.start < oldest.start) oldest = v;
      }
    }
    if (free === null) {
      oldest.kill(t);
      this.stats.steals++;
      free = oldest;
    } else {
      busy++;
    }
    if (busy > this.stats.voicesPeak) this.stats.voicesPeak = busy;
    free.reset();
    const g = this.ctx.createGain();
    g.connect(this._graph.sfxBus);
    free.gain = g;
    free.start = t;
    return free;
  }

  /**
   * Play a recipe by name. Returns true when it played.
   * @param {string} name key of RECIPES
   * @param {number} [arg]
   * @param {number} [delay] seconds from now
   */
  play(name, arg, delay) {
    if (!this._canPlay()) return false;
    const recipe = RECIPES[name];
    if (recipe === undefined) return false;
    const ctx = this.ctx;
    const cur = ctx.currentTime;
    const t = cur + (delay > 0 ? delay : 0) + 0.004;
    const last = this._lastPlay[name];
    if (last !== undefined && t - last < (MIN_GAP[name] || 0)) {
      this.stats.dropped++;
      return false;
    }
    this._lastPlay[name] = t;
    const t0 = now();
    try {
      const v = this._allocVoice(cur);
      v.end = t + recipe(ctx, v.gain, t, this._bufs, v, arg) + 0.05;
      this.stats.oneShots++;
    } catch (err) {
      // A broken recipe must never take the game down.
    }
    this.stats.mainMs += now() - t0;
    return true;
  }

  // Named one-shots (the vocabulary the event wiring uses)
  uiTap(index) {
    if (index === undefined) {
      // Gentle random walk so repeated taps sound like a little tune.
      const r = Math.random();
      this._tapIndex += r < 0.45 ? -1 : r < 0.9 ? 1 : 0;
      if (this._tapIndex < 0) this._tapIndex = 1;
      if (this._tapIndex > 7) this._tapIndex = 6;
      index = this._tapIndex;
    }
    return this.play('uiTap', index);
  }
  bottlePop() { return this.play('bottlePop'); }
  stickerPop() { return this.play('stickerPop'); }
  gemClink() { return this.play('gemClink'); }
  sparkle() { return this.play('sparkle'); }
  plip(amount) { return this.play('plip', amount); }
  coverageRise(coverage) { return this.play('coverageRise', coverage); }
  covered() { return this.play('covered'); }
  cureTing() { return this.play('cureTing'); }
  starDing(n, delay) { return this.play('starDing', n, delay); }
  shutter() { return this.play('shutter'); }
  flashWhoosh() { return this.play('flashWhoosh'); }
  confettiPop() { return this.play('confettiPop'); }
  clientYay(variant) { return this.play('clientYay', variant); }
  doorBell() { return this.play('doorBell'); }
  swish(amount) { return this.play('swish', amount); }
  revealJingle(stars) { return this.play('revealJingle', stars); }

  // ------------------------------------------------- continuous voices --

  brushStart(pressure) {
    if (!this._canPlay()) return;
    this._brush.start(pressure);
  }

  /** Per painting frame. No allocation, at most one param batch per frame. */
  brushUpdate(speed, pressure) {
    const b = this._brush;
    if (b === null || !b.active) return;
    const t0 = now();
    b.update(speed, pressure);
    this.stats.brushUpdates++;
    this.stats.mainMs += now() - t0;
  }

  brushEnd() {
    const b = this._brush;
    if (b === null || !b.active) return;
    const s = b.speed;
    b.stop();
    this.play('plip', 0.55 + 0.45 * s);
  }

  get brushActive() {
    return this._brush !== null && this._brush.active;
  }

  dryerStart() {
    if (!this._canPlay()) return;
    this._dryer.start();
  }

  dryerStop() {
    if (this._dryer) this._dryer.stop();
  }

  // ------------------------------------------------ legacy method names --
  // Thin aliases so existing callers keep working.

  playClick() { this.resume(); return this.uiTap(); }
  playStickerPop() { this.resume(); return this.stickerPop(); }
  playGemClink() { this.resume(); return this.gemClink(); }
  playSuccess() { this.resume(); return this.covered(); }
  playSparkle() { this.resume(); return this.sparkle(); }
  playPolish() { this.resume(); return this.swish(0.6); }
  playFileSound(intensity = 0.5) { this.resume(); return this.play('fileScratch', intensity); }
  playDrawSolid() { return this.play('drawSolid'); }
  playDrawDotted() { return this.play('drawDotted'); }
  playDrawMetallic() { return this.play('drawMetallic'); }
  playDrawRainbow() { return this.play('drawRainbow'); }
  playDrawGlow() { return this.play('drawGlow'); }
  playDrawMarker() { return this.play('drawMarker'); }
  /** Legacy per-dab brush sound; silent while the continuous voice runs. */
  playPolishBrush(pressure = 0.5) {
    if (this.brushActive) return false;
    return this.play('polishDab', pressure);
  }
}

// Export singleton instance
export const soundManager = new SoundManager();
