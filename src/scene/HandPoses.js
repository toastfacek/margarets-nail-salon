/**
 * HandPoses.js (B9.4): joint limits and the pose library, as plain numbers.
 *
 * A pose is a Float32Array(17 * 3): per bone (BONES order) [flex, spread,
 * twist] in degrees, about the bone's own axes (src/scene/HandRig.js):
 *   flex   + curls toward the palm (every finger, the thumb, palm, wrist)
 *   spread + toward the pinky side (fingers); for the thumb + lifts its tip
 *          away from the desk (palmar abduction)
 *   twist  thumb only: + turns its nail up (toward the camera)
 * Tunable without Blender: the asset only has to keep the 17 bone names.
 * The limits are mirrored in tools/blender/rig.py (the pipeline checks the
 * mesh at every limit).
 */

export const BONES = Object.freeze([
  'wrist', 'palm',
  'thumb.01', 'thumb.02', 'thumb.03',
  'index.01', 'index.02', 'index.03',
  'middle.01', 'middle.02', 'middle.03',
  'ring.01', 'ring.02', 'ring.03',
  'pinky.01', 'pinky.02', 'pinky.03',
]);
export const NB = BONES.length;
export const N3 = NB * 3;
/** Finger order of the rail (NailScene): thumb .. pinky. */
export const FINGER_ORDER = Object.freeze(['thumb', 'index', 'middle', 'ring', 'pinky']);
/** Index in BONES of a finger's first bone (.01). */
export function fingerBase(fingerIndex) {
  return 2 + fingerIndex * 3;
}

// [flex min, flex max, spread min, spread max, twist min, twist max] in degrees.
// finger knuckle / middle joint flex tightened from the plan's 60 / 70 to 45 / 45: past
// ~50 linear blend skinning folds the pad (tools/blender/rig.py checks every limit)
const L_FINGER = [[-15, 45, -12, 12, 0, 0], [0, 45, 0, 0, 0, 0], [-5, 45, 0, 0, -1, 1]];
const L_THUMB = [[-15, 35, -20, 30, -15, 25], [-5, 45, 0, 0, 0, 0], [-10, 55, 0, 0, -1, 1]];
const L_PALM = [-10, 10, -6, 6, 0, 0];
const L_WRIST = [-10, 10, -8, 8, 0, 0];

/** LIMITS[b * 6 + k]: per bone, flex/spread/twist min and max (degrees). */
export const LIMITS = (() => {
  const a = new Float32Array(NB * 6);
  a.set(L_WRIST, 0);
  a.set(L_PALM, 6);
  for (let f = 0; f < 5; f++) {
    for (let k = 0; k < 3; k++) a.set((f === 0 ? L_THUMB : L_FINGER)[k], (fingerBase(f) + k) * 6);
  }
  return a;
})();

/** Clamp a pose (in place) to the limits. */
export function clampPose(p) {
  for (let b = 0; b < NB; b++) {
    for (let k = 0; k < 3; k++) {
      const lo = LIMITS[b * 6 + k * 2], hi = LIMITS[b * 6 + k * 2 + 1];
      const v = p[b * 3 + k];
      p[b * 3 + k] = v < lo ? lo : v > hi ? hi : v;
    }
  }
  return p;
}

// The present pose (plan 5.3): the active finger lifts its tip toward the
// camera, the others relax out of the way and spread a little away from it.
export const PRESENT = Object.freeze({
  active: [-8, 4, 4],          // knuckle, middle joint, last joint (flex)
  other: [8, 10, 5],
  // the thumb hangs close to the desk: it never curls toward it, it lifts a little
  thumbOther: [0, 0, 0],
  thumbOtherLift: 4,
  spreadAway: 3,
  thumbActive: { flex: [-6, 4, 4], spread: 15, twist: 20 },
});

/**
 * Write the present pose of finger `i` (0 = thumb .. 4 = pinky) into `out`.
 */
export function writePresent(i, out) {
  out.fill(0);
  for (let f = 0; f < 5; f++) {
    const b = fingerBase(f) * 3;
    if (f === i) {
      const a = f === 0 ? PRESENT.thumbActive.flex : PRESENT.active;
      out[b] = a[0]; out[b + 3] = a[1]; out[b + 6] = a[2];
      if (f === 0) {
        out[b + 1] = PRESENT.thumbActive.spread;
        out[b + 2] = PRESENT.thumbActive.twist;
      }
    } else {
      const o = f === 0 ? PRESENT.thumbOther : PRESENT.other;
      out[b] = o[0]; out[b + 3] = o[1]; out[b + 6] = o[2];
      // spread away from the active finger: the thumb's spread lifts it,
      // the fingers spread toward the pinky when on its side
      if (f > 0) out[b + 1] = f > i ? PRESENT.spreadAway : -PRESENT.spreadAway;
      else out[b + 1] = PRESENT.thumbOtherLift;
    }
  }
  return out;
}

const _a = new Float32Array(N3);
const _b = new Float32Array(N3);

/**
 * The present pose at rail position s (0 = thumb .. 4 = pinky, fractional
 * between two fingers): a smoothstep blend of the two neighbours' poses.
 * On a whole number it is exactly that finger's pose.
 */
export function writePresentS(s, out) {
  const sc = Math.max(0, Math.min(4, s));
  const i = Math.min(3, Math.floor(sc));
  let t = sc - i;
  if (t <= 1e-6) return writePresent(i, out);
  if (t >= 1 - 1e-6) return writePresent(i + 1, out);
  t = t * t * (3 - 2 * t);
  writePresent(i, _a);
  writePresent(i + 1, _b);
  for (let k = 0; k < N3; k++) out[k] = _a[k] + (_b[k] - _a[k]) * t;
  return out;
}

function fingers(out, flex, spread) {
  for (let f = 0; f < 5; f++) {
    const b = fingerBase(f) * 3;
    out[b] = flex[f][0]; out[b + 3] = flex[f][1]; out[b + 6] = flex[f][2];
    out[b + 1] = spread[f];
  }
  return out;
}

/** Named poses. 'neutral' is the file's rest pose. */
export const POSE_NAMES = Object.freeze(['neutral', 'relaxed', 'fan']);

export function writeNamed(name, out) {
  out.fill(0);
  if (name === 'relaxed') {
    return fingers(out, [[0, 0, 0], [6, 10, 5], [6, 10, 5], [6, 10, 5], [6, 10, 5]], [4, -1, 0, 1, 2]);
  }
  if (name === 'fan') {
    // the show-off: fingers spread 8-10 degrees, tips a little up
    return fingers(out, [[-4, 2, 2], [-5, 0, 0], [-5, 0, 0], [-5, 0, 0], [-4, 0, 0]], [10, -9, -2, 5, 10]);
  }
  return out;
}

/** One-shot wiggle: a 0.6 s wave of knuckle flex, pinky to index, 6 degrees. */
export const WIGGLE = Object.freeze({ T: 0.6, amp: 6, fingers: [4, 3, 2, 1], lag: 0.09, width: 0.22 });
