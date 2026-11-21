/**
 * recipes.js
 * One-shot sound recipes. Each recipe builds a tiny node graph that plays
 * once and ends itself; nothing here runs per frame.
 *
 * Signature: recipe(ctx, out, t, bufs, voice, arg) -> duration (seconds)
 *   ctx   BaseAudioContext (works with OfflineAudioContext for test renders)
 *   out   AudioNode the sound feeds (a pooled voice gain in the game)
 *   t     start time in ctx time
 *   bufs  { white, pink } from buffers.js (never created here)
 *   voice { add(sourceNode) } so the pool can stop a stolen voice
 *   arg   recipe-specific number
 *
 * House style, so every sound is kind to small ears:
 * - pitches from C major pentatonic (notes.js)
 * - fast but never instant attacks (>= 1 ms) and exponential decays
 * - fundamentals under about 3.5 kHz, overtones short and quiet
 * - recipe peaks around -10 to -6 dBFS before the master limiter
 */

import { penta, C5, E5, G5, A5, C6, D6, E6, G6, A6, C7, G4 } from './notes.js';
import { NOISE_SECONDS } from './buffers.js';

const TAIL = 6.9; // time constants to fall 60 dB

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

/** Linear attack to `peak`, then an exponential fall. Returns the length. */
function env(param, t, peak, attack, tau) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
  return attack + tau * TAIL;
}

/** One enveloped oscillator. Optional exponential glide to `glideTo`. */
function partial(ctx, out, v, t, freq, peak, attack, tau, type, glideTo, glideTime) {
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + glideTime);
  const g = ctx.createGain();
  g.gain.value = 0;
  const dur = env(g.gain, t, peak, attack, tau);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
  v.add(o);
  return dur;
}

/** A slice of the shared noise buffer, started at `t` for `dur` seconds. */
function noise(ctx, bufs, v, t, dur, pink) {
  const src = ctx.createBufferSource();
  src.buffer = pink ? bufs.pink : bufs.white;
  const len = Math.min(dur, NOISE_SECONDS - 0.05);
  const offset = Math.random() * (NOISE_SECONDS - len - 0.02);
  src.start(t, offset, len);
  v.add(src);
  return src;
}

function filter(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Enveloped filtered noise. Returns the length. */
function noiseHit(ctx, out, bufs, v, t, pink, type, freq, q, peak, attack, tau, sweepTo, sweepTime) {
  const dur = attack + tau * TAIL;
  const src = noise(ctx, bufs, v, t, dur + 0.02, pink);
  const f = filter(ctx, type, freq, q);
  if (sweepTo) {
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(sweepTo, t + sweepTime);
  }
  const g = ctx.createGain();
  g.gain.value = 0;
  env(g.gain, t, peak, attack, tau);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  return dur;
}

/** A soft bell: fundamental plus two short, quiet overtones. */
function bell(ctx, out, v, t, f, peak, tau) {
  let d = partial(ctx, out, v, t, f, peak, 0.003, tau);
  d = Math.max(d, partial(ctx, out, v, t, f * 2.0, peak * 0.22, 0.002, tau * 0.35));
  d = Math.max(d, partial(ctx, out, v, t, f * 3.01, peak * 0.07, 0.002, tau * 0.18));
  return d;
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

// ---------------------------------------------------------------- UI ----

/** Marimba-like tap. `index` walks the pentatonic scale from C5. */
function uiTap(ctx, out, t, bufs, v, index) {
  const f = penta(clamp(index | 0, 0, 9), 72);
  let d = partial(ctx, out, v, t, f, 0.3, 0.002, 0.075);
  d = Math.max(d, partial(ctx, out, v, t, f * 3.93, 0.045, 0.001, 0.014));
  d = Math.max(d, noiseHit(ctx, out, bufs, v, t, false, 'bandpass', 1800, 0.9, 0.05, 0.001, 0.0035));
  return d;
}

/** Cork pop for opening a polish bottle. */
function bottlePop(ctx, out, t, bufs, v) {
  let d = noiseHit(ctx, out, bufs, v, t, false, 'lowpass', 380, 8, 0.32, 0.001, 0.02, 2000, 0.035);
  d = Math.max(d, partial(ctx, out, v, t, 190, 0.3, 0.002, 0.028, 'sine', 95, 0.05));
  d = Math.max(d, partial(ctx, out, v, t + 0.006, G5, 0.12, 0.002, 0.03, 'sine', C6 * 1.2, 0.025));
  return d;
}

/** Bubbly sticker pop: a quick upward chirp that lands on a scale note. */
function stickerPop(ctx, out, t, bufs, v) {
  const top = pick([C6, D6, E6, G6]);
  let d = partial(ctx, out, v, t, top * 0.45, 0.26, 0.002, 0.05, 'sine', top, 0.045);
  d = Math.max(d, partial(ctx, out, v, t + 0.01, top * 2, 0.035, 0.002, 0.03, 'sine'));
  d = Math.max(d, noiseHit(ctx, out, bufs, v, t, false, 'lowpass', 2600, 0.7, 0.06, 0.001, 0.006));
  return d;
}

/** Crystal clink: two slightly detuned high sines that shimmer as they ring. */
function gemClink(ctx, out, t, bufs, v) {
  const f = pick([E6, G6, A6]);
  let d = partial(ctx, out, v, t, f, 0.11, 0.0015, 0.32);
  d = Math.max(d, partial(ctx, out, v, t, f * 1.0045, 0.1, 0.0015, 0.28));
  d = Math.max(d, partial(ctx, out, v, t, f * 2.76, 0.035, 0.001, 0.05));
  d = Math.max(d, noiseHit(ctx, out, bufs, v, t, false, 'bandpass', 3000, 1.5, 0.03, 0.001, 0.003));
  return d;
}

/** Soft ripple for switching the brush / pen / file tools. */
function sparkle(ctx, out, t, bufs, v) {
  let d = 0;
  for (let i = 0; i < 4; i++) {
    const f = penta(10 + ((Math.random() * 4) | 0), 72); // C7..G7
    d = Math.max(d, 0.035 * i + partial(ctx, out, v, t + 0.035 * i, f, 0.045, 0.002, 0.055));
  }
  return d;
}

// ------------------------------------------------------------ painting ----

/** Wet "plip" when the brush lifts: a short downward-bending blip and a tick. */
function plip(ctx, out, t, bufs, v, amount) {
  const a = clamp(amount || 0.7, 0.2, 1);
  const f = pick([G5, A5, C6]);
  let d = partial(ctx, out, v, t, f, 0.25 * a, 0.002, 0.026, 'sine', f * 0.5, 0.055);
  d = Math.max(d, noiseHit(ctx, out, bufs, v, t, false, 'lowpass', 2000, 0.8, 0.045 * a, 0.001, 0.004));
  return d;
}

/** A note that climbs the scale as the coverage meter fills. */
function coverageRise(ctx, out, t, bufs, v, coverage) {
  const step = clamp(Math.floor((coverage || 0) * 10) - 1, 0, 8);
  return bell(ctx, out, v, t, penta(step, 72), 0.14, 0.22);
}

/** Nail fully covered: rising C-E-G arpeggio and a high shimmer. */
function covered(ctx, out, t, bufs, v) {
  let d = bell(ctx, out, v, t, C6, 0.1, 0.28);
  d = Math.max(d, 0.08 + bell(ctx, out, v, t + 0.08, E6, 0.1, 0.28));
  d = Math.max(d, 0.16 + bell(ctx, out, v, t + 0.16, G6, 0.105, 0.38));
  d = Math.max(d, 0.26 + partial(ctx, out, v, t + 0.26, C7, 0.04, 0.01, 0.18));
  d = Math.max(d, 0.31 + partial(ctx, out, v, t + 0.31, penta(12, 72), 0.03, 0.01, 0.16));
  d = Math.max(d, 0.36 + partial(ctx, out, v, t + 0.36, penta(13, 72), 0.025, 0.01, 0.14));
  return d;
}

/** Cured: a glass "ting" with three inharmonic partials. */
function cureTing(ctx, out, t, bufs, v) {
  const f = E6;
  let d = partial(ctx, out, v, t, f, 0.14, 0.0015, 0.42);
  d = Math.max(d, partial(ctx, out, v, t, f * 2.32, 0.05, 0.0015, 0.16));
  d = Math.max(d, partial(ctx, out, v, t, f * 4.25, 0.016, 0.001, 0.04));
  return d;
}

// --------------------------------------------------------------- round ----

/** Star `n` (1, 2, 3...) dings higher than the one before. */
function starDing(ctx, out, t, bufs, v, n) {
  const notes = [C6, E6, G6, C7];
  const f = notes[clamp((n | 0) - 1, 0, 3)];
  return bell(ctx, out, v, t, f, 0.15, 0.36);
}

/** Camera shutter: two soft mechanical clicks. */
function shutter(ctx, out, t, bufs, v) {
  let d = noiseHit(ctx, out, bufs, v, t, false, 'bandpass', 2200, 1.3, 0.24, 0.001, 0.006);
  d = Math.max(d, noiseHit(ctx, out, bufs, v, t, true, 'lowpass', 600, 0.8, 0.18, 0.001, 0.014));
  d = Math.max(d, 0.075 + noiseHit(ctx, out, bufs, v, t + 0.075, false, 'bandpass', 1700, 1.3, 0.18, 0.001, 0.008));
  return d;
}

/** Soft whoosh for the flash. */
function flashWhoosh(ctx, out, t, bufs, v) {
  const len = 0.75;
  const src = noise(ctx, bufs, v, t, len, true);
  const f = filter(ctx, 'bandpass', 300, 1.1);
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(2200, t + 0.26);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.42, t + 0.2);
  g.gain.setTargetAtTime(0, t + 0.28, 0.08);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  return len;
}

/** Party-popper: a pop, a little thump and a scatter of high tinkles. */
function confettiPop(ctx, out, t, bufs, v) {
  let d = noiseHit(ctx, out, bufs, v, t, false, 'lowpass', 2400, 0.9, 0.3, 0.001, 0.028);
  d = Math.max(d, partial(ctx, out, v, t, 130, 0.3, 0.002, 0.045, 'sine', 60, 0.08));
  for (let i = 0; i < 5; i++) {
    const dt = 0.05 + Math.random() * 0.32;
    const f = penta(10 + ((Math.random() * 4) | 0), 72);
    d = Math.max(d, dt + partial(ctx, out, v, t + dt, f, 0.035, 0.002, 0.045));
  }
  return d;
}

/**
 * Wordless happy "yay": a sawtooth glide (up, then down) through two vowel
 * formants. Variant 0 "woo", 1 "yay" (default), 2 "wee".
 */
const YAY = [
  // [start, peak, end] Hz, F1 from/to, F2 from/to, level
  [G4, 587.33, C5, 360, 650, 820, 1150, 0.25],
  [C5, 783.99, E5, 680, 720, 1650, 2100, 0.24],
  [E5, 1046.5, A5, 700, 900, 2200, 2400, 0.28],
];
function clientYay(ctx, out, t, bufs, v, variant) {
  const p = YAY[clamp(variant === undefined ? 1 : variant | 0, 0, 2)];
  const len = 0.38;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(p[0], t);
  o.frequency.exponentialRampToValueAtTime(p[1], t + 0.12);
  o.frequency.exponentialRampToValueAtTime(p[2], t + 0.33);
  // Gentle vibrato so it sounds alive.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 6.2;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(p[1] * 0.012, t + 0.2);
  lfo.connect(depth);
  depth.connect(o.frequency);

  const soft = filter(ctx, 'lowpass', 3000, 0.5);
  const f1 = filter(ctx, 'bandpass', p[3], 4);
  f1.frequency.setValueAtTime(p[3], t);
  f1.frequency.linearRampToValueAtTime(p[4], t + 0.15);
  const f2 = filter(ctx, 'bandpass', p[5], 6);
  f2.frequency.setValueAtTime(p[5], t);
  f2.frequency.linearRampToValueAtTime(p[6], t + 0.15);
  const g2 = ctx.createGain();
  g2.gain.value = 0.55;

  const amp = ctx.createGain();
  const peak = p[7];
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(peak, t + 0.04);
  amp.gain.linearRampToValueAtTime(peak * 0.8, t + 0.26);
  amp.gain.linearRampToValueAtTime(0, t + len);

  o.connect(soft);
  soft.connect(f1);
  soft.connect(f2);
  f1.connect(amp);
  f2.connect(g2);
  g2.connect(amp);
  amp.connect(out);
  o.start(t);
  lfo.start(t);
  o.stop(t + len + 0.02);
  lfo.stop(t + len + 0.02);
  v.add(o);
  v.add(lfo);
  return len;
}

/** "Ding-dong" for the next client. */
function doorBell(ctx, out, t, bufs, v) {
  let d = bell(ctx, out, v, t, E5, 0.15, 0.55);
  d = Math.max(d, partial(ctx, out, v, t, E5 * 4.2, 0.012, 0.001, 0.05));
  d = Math.max(d, 0.42 + bell(ctx, out, v, t + 0.42, C5, 0.15, 0.7));
  d = Math.max(d, 0.42 + partial(ctx, out, v, t + 0.42, C5 * 4.2, 0.012, 0.001, 0.05));
  return d;
}

/** Soft air swish for camera moves. */
function swish(ctx, out, t, bufs, v, amount) {
  const a = clamp(amount || 1, 0.2, 1);
  const len = 0.42;
  const src = noise(ctx, bufs, v, t, len, true);
  const f = filter(ctx, 'bandpass', 500, 0.9);
  f.frequency.setValueAtTime(500, t);
  f.frequency.exponentialRampToValueAtTime(1500, t + 0.16);
  f.frequency.exponentialRampToValueAtTime(700, t + 0.36);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.24 * a, t + 0.12);
  g.gain.setTargetAtTime(0, t + 0.17, 0.06);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  return len;
}

/**
 * Reveal jingle: a sparkling run up the scale, a warm landing chord, then one
 * ding per star.
 */
function revealJingle(ctx, out, t, bufs, v, stars) {
  const n = clamp(stars | 0 || 1, 1, 3);
  let d = 0;
  const run = [0, 2, 4, 5, 7, 9]; // C5 E5 A5 C6 E6 A6 (pentatonic steps)
  for (let i = 0; i < run.length; i++) {
    const dt = i * 0.065;
    d = Math.max(d, dt + bell(ctx, out, v, t + dt, penta(run[i], 72), 0.07, 0.16));
  }
  const land = 0.42;
  d = Math.max(d, land + bell(ctx, out, v, t + land, C6, 0.075, 0.5));
  d = Math.max(d, land + bell(ctx, out, v, t + land, G5, 0.06, 0.5));
  d = Math.max(d, land + bell(ctx, out, v, t + land, E5, 0.06, 0.5));
  for (let i = 1; i <= n; i++) {
    const dt = land + 0.25 + i * 0.22;
    d = Math.max(d, dt + starDing(ctx, out, t + dt, bufs, v, i));
  }
  return d;
}

// -------------------------------------------------- legacy pen / file ----

function drawSolid(ctx, out, t, bufs, v) {
  return noiseHit(ctx, out, bufs, v, t, true, 'lowpass', 650, 0.7, 0.2, 0.004, 0.018);
}
function drawDotted(ctx, out, t, bufs, v) {
  const f = pick([C6, D6, E6, G6]);
  return partial(ctx, out, v, t, f, 0.08, 0.002, 0.03, 'sine', f * 0.5, 0.06);
}
function drawMetallic(ctx, out, t, bufs, v) {
  const f = pick([G6, A6]);
  let d = partial(ctx, out, v, t, f, 0.045, 0.002, 0.04);
  d = Math.max(d, partial(ctx, out, v, t, f * 2.76, 0.012, 0.001, 0.015));
  return d;
}
function drawRainbow(ctx, out, t, bufs, v) {
  const i = (Math.random() * 5) | 0;
  return partial(ctx, out, v, t, penta(i + 3, 72), 0.06, 0.004, 0.04, 'sine', penta(i + 5, 72), 0.08);
}
function drawGlow(ctx, out, t, bufs, v) {
  let d = partial(ctx, out, v, t, 196, 0.05, 0.01, 0.05);
  d = Math.max(d, partial(ctx, out, v, t, 392, 0.025, 0.01, 0.04));
  return d;
}
function drawMarker(ctx, out, t, bufs, v) {
  return noiseHit(ctx, out, bufs, v, t, true, 'bandpass', 900, 2, 0.3, 0.004, 0.022);
}
function fileScratch(ctx, out, t, bufs, v, intensity) {
  const i = clamp(intensity === undefined ? 0.5 : intensity, 0, 1);
  return noiseHit(ctx, out, bufs, v, t, false, 'bandpass', 1300 + 1200 * i, 1.2, 0.08 + 0.16 * i, 0.006, 0.018);
}
/** Legacy short brush burst (the continuous BrushVoice replaces it). */
function polishDab(ctx, out, t, bufs, v, pressure) {
  const p = clamp(pressure === undefined ? 0.5 : pressure, 0.1, 1);
  return noiseHit(ctx, out, bufs, v, t, true, 'bandpass', 800 + 300 * p, 0.8, 0.35 * p, 0.01, 0.04);
}

export const RECIPES = {
  uiTap,
  bottlePop,
  stickerPop,
  gemClink,
  sparkle,
  plip,
  coverageRise,
  covered,
  cureTing,
  starDing,
  shutter,
  flashWhoosh,
  confettiPop,
  clientYay,
  doorBell,
  swish,
  revealJingle,
  drawSolid,
  drawDotted,
  drawMetallic,
  drawRainbow,
  drawGlow,
  drawMarker,
  fileScratch,
  polishDab,
};

/**
 * Minimum gap between two plays of the same recipe, in seconds. Stops
 * machine-gun retriggers and collapses a direct call plus an event for the
 * same action into one sound.
 */
export const MIN_GAP = {
  uiTap: 0.045,
  bottlePop: 0.12,
  stickerPop: 0.06,
  gemClink: 0.06,
  sparkle: 0.09,
  plip: 0.09,
  coverageRise: 0.08,
  covered: 0.5,
  cureTing: 0.3,
  starDing: 0.08,
  shutter: 0.3,
  flashWhoosh: 0.4,
  confettiPop: 0.3,
  clientYay: 0.5,
  doorBell: 1.0,
  swish: 0.25,
  revealJingle: 1.5,
  drawSolid: 0.07,
  drawDotted: 0.07,
  drawMetallic: 0.07,
  drawRainbow: 0.07,
  drawGlow: 0.07,
  drawMarker: 0.07,
  fileScratch: 0.06,
  polishDab: 0.1,
};
