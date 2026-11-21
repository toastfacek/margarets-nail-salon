/**
 * DryerVoice.js
 * The nail dryer / UV lamp: a warm filtered-noise whir with a slow LFO on the
 * filter, plus a very quiet G3 hum. One instance, started and stopped by
 * events; nothing per frame.
 */

const MAX_SECONDS = 10; // safety: never whir forever if a stop is missed

export class DryerVoice {
  constructor(ctx, out, bufs) {
    this.ctx = ctx;
    this.out = out;
    this.bufs = bufs;
    this.running = false;
    this._nodes = null;
    this._autoStop = 0;
    this.stop = this.stop.bind(this);
  }

  start() {
    if (this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this._release(t); // drop any tail still fading

    const src = ctx.createBufferSource();
    src.buffer = this.bufs.pink;
    src.loop = true;
    src.loopEnd = this.bufs.loopEnd;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 850;
    lp.Q.value = 1.4;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.45;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 260;
    const hum = ctx.createOscillator();
    hum.frequency.value = 196;
    const humAmp = ctx.createGain();
    humAmp.gain.value = 0.035;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.24, t + 0.3);

    src.connect(lp);
    lfo.connect(lfoDepth);
    lfoDepth.connect(lp.frequency);
    lp.connect(amp);
    hum.connect(humAmp);
    humAmp.connect(amp);
    amp.connect(this.out);
    src.start(t, Math.random());
    lfo.start(t);
    hum.start(t);

    this._nodes = { src, lfo, hum, amp };
    this.running = true;
    if (typeof setTimeout === 'function') this._autoStop = setTimeout(this.stop, MAX_SECONDS * 1000);
  }

  _release(t) {
    const n = this._nodes;
    if (!n) return;
    n.amp.gain.cancelScheduledValues(t);
    n.amp.gain.setTargetAtTime(0, t, 0.09);
    const end = t + 0.6;
    n.src.stop(end);
    n.lfo.stop(end);
    n.hum.stop(end);
    this._nodes = null;
  }

  stop() {
    if (this._autoStop) {
      clearTimeout(this._autoStop);
      this._autoStop = 0;
    }
    if (!this.running) return;
    this.running = false;
    this._release(this.ctx.currentTime);
  }
}
