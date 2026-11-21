/**
 * graph.js
 * The master signal chain, shared by the game and by offline test renders:
 *
 *   sfxBus ----------------------\
 *   musicBus -> musicDuck --------> master (volume) -> highpass 45 Hz
 *     -> "kind ears" lowpass 7.5 kHz -> DynamicsCompressor (gentle limiter)
 *     -> soft clipper (ceiling -3 dBFS) -> mute gain -> destination
 */

const CLIP_KNEE = 0.5;   // linear below -6 dBFS
const CLIP_CEIL = 0.7;   // never above -3.1 dBFS

/** Linear up to the knee, then a tanh shoulder that never passes the ceiling. */
function clipCurve() {
  const n = 2049;
  const curve = new Float32Array(n);
  const room = CLIP_CEIL - CLIP_KNEE;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE ? a : CLIP_KNEE + room * Math.tanh((a - CLIP_KNEE) / room);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

export function createGraph(ctx) {
  const sfxBus = ctx.createGain();
  sfxBus.gain.value = 1;
  const musicBus = ctx.createGain();
  musicBus.gain.value = 0.4;
  const musicDuck = ctx.createGain();
  musicDuck.gain.value = 1;
  const master = ctx.createGain();
  master.gain.value = 0.9;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 45;
  hp.Q.value = 0.7;

  // Rolls off the top octave: nothing shrill reaches small ears or speakers.
  const soft = ctx.createBiquadFilter();
  soft.type = 'lowpass';
  soft.frequency.value = 7500;
  soft.Q.value = 0.5;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;

  const clip = ctx.createWaveShaper();
  clip.curve = clipCurve();
  clip.oversample = '2x';

  const mute = ctx.createGain();
  mute.gain.value = 1;

  sfxBus.connect(master);
  musicBus.connect(musicDuck);
  musicDuck.connect(master);
  master.connect(hp);
  hp.connect(soft);
  soft.connect(comp);
  comp.connect(clip);
  clip.connect(mute);
  mute.connect(ctx.destination);

  return { sfxBus, musicBus, musicDuck, master, comp, mute };
}
