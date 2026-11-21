/**
 * BrushVoice.js
 * The continuous wet-brush sound: the heart of the soundscape.
 *
 *   pink noise (looping) -> highpass -> bandpass -> lowpass -> flutter -> amp -> out
 *   white noise (looping) -> lowpass 16 Hz -> depth ---^  (slow wet wobble)
 *   sine "body" 90..140 Hz -> bodyAmp -> out
 *
 * One voice for the whole stroke: nodes are built on the first stroke and
 * kept while strokes keep coming; they are torn down after a few idle
 * seconds. Per painting frame `update()` touches only AudioParams (at most one
 * batch of setTargetAtTime calls per frame) and never allocates.
 */

const IDLE_TEARDOWN_MS = 5000;
const MIN_UPDATE_GAP = 0.012; // s of audio time between param batches
const TAU = 0.045;            // smoothing time constant for live params
const SETTLE_DELAY = 0.12;    // if updates stop, ease to the resting sound
const SETTLE_TAU = 0.09;

export class BrushVoice {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} out
   * @param {{ white: AudioBuffer, pink: AudioBuffer, loopEnd: number }} bufs
   */
  constructor(ctx, out, bufs) {
    this.ctx = ctx;
    this.out = out;
    this.bufs = bufs;
    this.built = false;
    this.active = false;
    this._speed = 0;           // smoothed, 0..1
    this._lastUpdate = -1;
    this._teardownTimer = 0;
    this._teardown = this._teardown.bind(this);
  }

  _build() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.bufs.pink;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.bufs.loopEnd;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;
    hp.Q.value = 0.6;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.8;

    // Keep the top end silky rather than hissy.
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 4800;
    soft.Q.value = 0.5;

    // Wet wobble: very slow random amplitude movement, like paint dragging.
    const flutter = ctx.createGain();
    flutter.gain.value = 1;
    const modSrc = ctx.createBufferSource();
    modSrc.buffer = this.bufs.white;
    modSrc.loop = true;
    modSrc.loopStart = 0;
    modSrc.loopEnd = this.bufs.loopEnd;
    const modLp = ctx.createBiquadFilter();
    modLp.type = 'lowpass';
    modLp.frequency.value = 16;
    modLp.Q.value = 0.7;
    const modDepth = ctx.createGain();
    modDepth.gain.value = 0;

    const amp = ctx.createGain();
    amp.gain.value = 0;

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.value = 110;
    const bodyAmp = ctx.createGain();
    bodyAmp.gain.value = 0;

    src.connect(hp);
    hp.connect(bp);
    bp.connect(soft);
    soft.connect(flutter);
    flutter.connect(amp);
    amp.connect(this.out);
    modSrc.connect(modLp);
    modLp.connect(modDepth);
    modDepth.connect(flutter.gain);
    body.connect(bodyAmp);
    bodyAmp.connect(this.out);

    const offset = Math.random() * this.bufs.loopEnd * 0.9;
    src.start(t, offset);
    modSrc.start(t, offset * 0.5);
    body.start(t);

    this.src = src;
    this.modSrc = modSrc;
    this.body = body;
    this.bp = bp;
    this.amp = amp;
    this.bodyAmp = bodyAmp;
    this.modDepth = modDepth;
    this.built = true;
  }

  _teardown() {
    this._teardownTimer = 0;
    if (!this.built || this.active) return;
    const t = this.ctx.currentTime;
    try {
      this.src.stop(t + 0.05);
      this.modSrc.stop(t + 0.05);
      this.body.stop(t + 0.05);
    } catch (e) {
      // already stopped
    }
    this.amp.disconnect();
    this.bodyAmp.disconnect();
    this.src = this.modSrc = this.body = null;
    this.bp = this.amp = this.bodyAmp = this.modDepth = null;
    this.built = false;
  }

  /** Brush touched down. */
  start(pressure) {
    if (this._teardownTimer) {
      clearTimeout(this._teardownTimer);
      this._teardownTimer = 0;
    }
    if (!this.built) this._build();
    this.active = true;
    this._speed = 0;
    this._lastUpdate = -1;
    this.update(0, pressure === undefined ? 0.5 : pressure);
  }

  /**
   * Per painting frame. `speed` in nail-UV units per second, `pressure` 0..1.
   * Never allocates.
   */
  update(speed, pressure) {
    if (!this.active || !this.built) return;
    const t = this.ctx.currentTime;
    if (this._lastUpdate >= 0 && t - this._lastUpdate < MIN_UPDATE_GAP) return;
    this._lastUpdate = t;

    // Normalise and smooth speed: rise quickly, fall gently, so frames where
    // the brush moved less than a texel (speed 0) do not chop the sound.
    const s = speed > 0 ? speed / (speed + 1.4) : 0;
    this._speed += (s - this._speed) * (s > this._speed ? 0.6 : 0.18);
    const v = this._speed;
    const p = pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;

    const freq = 600 + 1600 * v;
    const q = 0.7 + 0.9 * p;
    const level = (0.2 + 0.85 * v) * (0.65 + 0.35 * p);
    const bodyF = 90 + 50 * p;
    const bodyLevel = (0.018 + 0.03 * p) * (0.7 + 0.3 * v);
    const wobble = 9 + 14 * v;

    const bp = this.bp;
    const amp = this.amp.gain;
    const bAmp = this.bodyAmp.gain;
    bp.frequency.cancelScheduledValues(t);
    bp.frequency.setTargetAtTime(freq, t, TAU);
    bp.frequency.setTargetAtTime(700, t + SETTLE_DELAY, SETTLE_TAU * 2);
    bp.Q.setTargetAtTime(q, t, TAU);
    amp.cancelScheduledValues(t);
    amp.setTargetAtTime(level, t, TAU);
    amp.setTargetAtTime(0.2 * (0.65 + 0.35 * p), t + SETTLE_DELAY, SETTLE_TAU);
    this.body.frequency.setTargetAtTime(bodyF, t, TAU);
    bAmp.cancelScheduledValues(t);
    bAmp.setTargetAtTime(bodyLevel, t, TAU);
    this.modDepth.gain.setTargetAtTime(wobble, t, 0.1);
  }

  /** Brush lifted: release smoothly (the caller plays the plip). */
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this.built) {
      const t = this.ctx.currentTime;
      this.amp.gain.cancelScheduledValues(t);
      this.amp.gain.setTargetAtTime(0, t, 0.05);
      this.bodyAmp.gain.cancelScheduledValues(t);
      this.bodyAmp.gain.setTargetAtTime(0, t, 0.04);
      this.bp.frequency.cancelScheduledValues(t);
      this.bp.frequency.setTargetAtTime(500, t, 0.08);
      this.modDepth.gain.setTargetAtTime(0, t, 0.1);
    }
    if (typeof setTimeout === 'function') {
      if (this._teardownTimer) clearTimeout(this._teardownTimer);
      this._teardownTimer = setTimeout(this._teardown, IDLE_TEARDOWN_MS);
    }
  }

  /** Last smoothed speed (0..1), used to size the lift plip. */
  get speed() {
    return this._speed;
  }

  dispose() {
    this.active = false;
    if (this._teardownTimer) clearTimeout(this._teardownTimer);
    this._teardown();
  }
}
