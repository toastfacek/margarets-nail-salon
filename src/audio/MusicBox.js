/**
 * MusicBox.js
 * Optional ambient bed: a generative music-box loop in C major pentatonic at
 * about 70 bpm, soft sine voices into a feedback delay.
 *
 * Scheduling: a 100 ms setInterval looks 200 ms ahead in audio time and
 * schedules any notes that fall inside it (the classic "two clocks"
 * pattern). Nothing runs per animation frame.
 */

import { penta, mtof } from './notes.js';

const BPM = 70;
const EIGHTH = 60 / BPM / 2;
const LOOKAHEAD = 0.2;
const TICK_MS = 100;
const STEPS = 16;               // one phrase = two bars of eighths
const BASS = [48, 45, 50, 43];  // C3 A2 D3 G2: one per bar, four-bar cycle
const MAX_NOTE_VOICES = 8;

/** A soft music-box note. Returns its length. */
export function musicBoxNote(ctx, out, t, f, peak) {
  const o1 = ctx.createOscillator();
  o1.frequency.value = f;
  const o2 = ctx.createOscillator();
  o2.frequency.value = f * 2;
  const g1 = ctx.createGain();
  const g2 = ctx.createGain();
  g1.gain.setValueAtTime(0, t);
  g1.gain.linearRampToValueAtTime(peak, t + 0.005);
  g1.gain.setTargetAtTime(0, t + 0.005, 0.42);
  g2.gain.setValueAtTime(0, t);
  g2.gain.linearRampToValueAtTime(peak * 0.14, t + 0.003);
  g2.gain.setTargetAtTime(0, t + 0.003, 0.12);
  o1.connect(g1);
  o2.connect(g2);
  g1.connect(out);
  g2.connect(out);
  const len = 0.005 + 0.42 * 6.9;
  o1.start(t);
  o2.start(t);
  o1.stop(t + len);
  o2.stop(t + 0.9);
  return len;
}

export class MusicBox {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.playing = false;
    this._timer = 0;
    this._nextTime = 0;
    this._step = 0;            // eighth index inside the 8-bar cycle
    this._seed = 0x2f6e2b1;
    this._phrase = new Int8Array(STEPS);
    this._variant = new Int8Array(STEPS);
    this._noteEnds = new Float64Array(MAX_NOTE_VOICES);
    this._tick = this._tick.bind(this);

    // Feedback delay (dotted eighth), darkened on every repeat.
    const input = ctx.createGain();
    input.gain.value = 1;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = EIGHTH * 1.5;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    const level = ctx.createGain();
    level.gain.value = 0;
    input.connect(level);
    input.connect(delay);
    delay.connect(dark);
    dark.connect(fb);
    fb.connect(delay);
    dark.connect(wet);
    wet.connect(level);
    level.connect(out);
    this.input = input;
    this.level = level;

    this._newPhrase();
    this._fresh = true;
  }

  _rand() {
    // mulberry32
    let t = (this._seed = (this._seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A two-bar phrase: a gentle random walk over C5..A6, rests in between. */
  _newPhrase() {
    let idx = 2 + ((this._rand() * 4) | 0);
    for (let i = 0; i < STEPS; i++) {
      const onBeat = (i & 1) === 0;
      const downBeat = (i & 7) === 0;
      const prob = downBeat ? 0.95 : onBeat ? 0.62 : 0.22;
      if (this._rand() < prob) {
        const r = this._rand();
        const move = r < 0.35 ? -1 : r < 0.7 ? 1 : r < 0.82 ? -2 : r < 0.94 ? 2 : 0;
        idx += move;
        if (idx < 0) idx = 1;
        if (idx > 9) idx = 8;
        this._phrase[i] = idx;
      } else {
        this._phrase[i] = -1;
      }
    }
    // The answer phrase: same start, new ending that lands on C or E.
    for (let i = 0; i < STEPS; i++) this._variant[i] = this._phrase[i];
    this._variant[12] = this._rand() < 0.5 ? -1 : 4;
    this._variant[13] = -1;
    this._variant[14] = this._rand() < 0.5 ? 2 : 5;
    this._variant[15] = -1;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    const t = this.ctx.currentTime;
    this.level.gain.cancelScheduledValues(t);
    this.level.gain.setTargetAtTime(1, t, 0.6);
    this._nextTime = t + 0.15;
    if (typeof setInterval === 'function') this._timer = setInterval(this._tick, TICK_MS);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = 0;
    const t = this.ctx.currentTime;
    this.level.gain.cancelScheduledValues(t);
    this.level.gain.setTargetAtTime(0, t, 0.25);
  }

  /** Schedule everything that starts before `until` (used by tests too). */
  scheduleUntil(until) {
    const ctx = this.ctx;
    while (this._nextTime < until) {
      const t = this._nextTime;
      const s = this._step;
      const bar = (s >> 3) & 3;
      const inPhrase = s & 15;
      const usingVariant = ((s >> 4) & 1) === 1;
      if (inPhrase === 0 && !usingVariant) {
        if (this._fresh) this._fresh = false;
        else this._newPhrase();
      }

      if ((s & 7) === 0) this._note(t, mtof(BASS[bar]), 0.11);
      const n = usingVariant ? this._variant[inPhrase] : this._phrase[inPhrase];
      if (n >= 0) this._note(t + (this._rand() - 0.5) * 0.012, penta(n, 72), 0.085 + this._rand() * 0.03);

      this._step = (s + 1) & 63; // 8-bar cycle
      this._nextTime = t + EIGHTH;
    }
  }

  _note(t, f, peak) {
    // Hard cap on overlapping note voices (long tails overlap a lot).
    const ends = this._noteEnds;
    let slot = -1;
    for (let i = 0; i < ends.length; i++) {
      if (ends[i] <= t) { slot = i; break; }
    }
    if (slot < 0) return; // all busy: skip this note rather than pile up
    ends[slot] = t + musicBoxNote(this.ctx, this.input, t, f, peak);
  }

  _tick() {
    const ctx = this.ctx;
    if (!this.playing || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // After a suspend or a throttled background tab, do not burst-catch-up.
    if (this._nextTime < now - 0.05) this._nextTime = now + 0.05;
    this.scheduleUntil(now + LOOKAHEAD);
  }

  dispose() {
    this.stop();
    this.level.disconnect();
  }
}
