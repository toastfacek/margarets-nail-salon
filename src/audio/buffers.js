/**
 * buffers.js
 * The only AudioBuffers the game ever creates: two seconds of white noise and
 * two seconds of pink noise, built once per AudioContext. Every noisy sound
 * plays a slice of one of these, so no play call ever calls createBuffer.
 */

const SECONDS = 2;

// Small deterministic PRNG (mulberry32) so renders are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalise(data, peak) {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > max) max = v;
  }
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
}

const FADE_SECONDS = 0.02;

/**
 * Seamless loop: crossfade the last 20 ms into the first 20 ms. Sample
 * `len - n - 1` is then followed naturally by sample 0, so a looping source
 * must use the returned loopEnd (len - n samples).
 */
function makeLoopable(data, n) {
  const len = data.length;
  for (let i = 0; i < n; i++) {
    const w = i / n;
    data[i] = data[i] * w + data[len - n + i] * (1 - w);
  }
}

/**
 * @param {BaseAudioContext} ctx
 * @returns {{ white: AudioBuffer, pink: AudioBuffer, loopEnd: number }}
 */
export function createNoiseBuffers(ctx) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * SECONDS);
  const rand = rng(0x5a17);

  const white = ctx.createBuffer(1, len, sr);
  const w = white.getChannelData(0);
  for (let i = 0; i < len; i++) w[i] = rand() * 2 - 1;
  normalise(w, 0.9);

  // Pink noise, Paul Kellet's refined filter.
  const pink = ctx.createBuffer(1, len, sr);
  const p = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const x = rand() * 2 - 1;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.96900 * b2 + x * 0.1538520;
    b3 = 0.86650 * b3 + x * 0.3104856;
    b4 = 0.55000 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.0168980;
    p[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
  }
  // Remove DC so loops and filters start clean.
  let mean = 0;
  for (let i = 0; i < len; i++) mean += p[i];
  mean /= len;
  for (let i = 0; i < len; i++) p[i] -= mean;
  normalise(p, 0.9);

  const n = Math.floor(sr * FADE_SECONDS);
  makeLoopable(w, n);
  makeLoopable(p, n);
  return { white, pink, loopEnd: (len - n) / sr };
}

/** Seconds of noise that one-shots may start anywhere inside (leaves room). */
export const NOISE_SECONDS = SECONDS - FADE_SECONDS;
