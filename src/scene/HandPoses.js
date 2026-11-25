/**
 * HandPoses.js (B9.4): joint limits and the pose library, as plain numbers.
 *
 * A pose is a Float32Array(17 * 3): per bone (BONES order) [flex, spread,
 * twist] in degrees, about the bone's own axes (src/scene/HandRig.js):
 *   flex   + curls toward the palm (every finger, the thumb, palm, wrist)
 *   spread + toward the pinky side (fingers); for the thumb + brings it in
 *          beside the index (its rest, THUMB_REST, is the file's bind: 0)
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
// the thumb's, about its bind (B9.8: the file's thumb now rests beside the index;
// before, about a thumb sticking straight out: base flex -15..25, spread -20..36,
// twist -15..25, middle -5..45, last -10..55; tools/blender/rig.py re-derives them)
const L_THUMB = [[-19, 21, -47, 9, -9, 21], [-17, 33, 0, 0, 0, 0], [-20, 45, 0, 0, -1, 1]];
const L_PALM = [-10, 10, -6, 6, 0, 0];
const L_WRIST = [-10, 10, -8, 8, 0, 0];

/**
 * Per-model pose sets. The thumb's poses are about each file's own bind, so a
 * hand model built around a different thumb rest needs its own numbers; the
 * model names its set in its armature's glTF extras (`handPoseSet`, read by
 * HandModel) and useHandPoseSet() switches to it. 'v2' is the default (the
 * numbers above, B9.8). 'v3' is the hand built from the anatomical distance
 * field (tools/blender/hv3): its thumb rests beside the index with a first web
 * only ~7 mm wide, so its poses open the thumb through the MCP and IP joints
 * and turn the nail with the base twist, never pushing the thumb toward the
 * index; its limits are where tools/blender/hv3/build3.py finds no flipped
 * triangle (the finger knuckles' flex stops at 25: past ~28 linear blend
 * skinning folds v3's volar finger roots; the game's poses stay under ~20;
 * the last joints stop at 40, where one sliver on the index pad turned over at 45).
 * Mirrored in tools/blender/hv3/rig3.py (POSE_SET_V3).
 */
export const POSE_SETS = Object.freeze({
  v2: Object.freeze({
    finger: L_FINGER,
    thumb: L_THUMB,
    // [base flex, base spread, base twist, middle joint flex, last joint flex]
    relaxed: Object.freeze([2.6, 7.3, -1.9, -2, 2]),   // before B9.8: [8, 34, 4, 10, 12]
    fan: Object.freeze([-2.9, -9.3, 7.8, -10, -8]),    // before B9.8: [0, 18, 10, 2, 2]
    thumbActive: Object.freeze([-1.2, -7.1, 14.9, -8, -5]),
    thumbOther: Object.freeze([1.7, 1.2, -0.9, 2, 2]),
    spreadAway: 3,
    active: Object.freeze([-8, 4, 4]),
    other: Object.freeze([8, 10, 5]),
  }),
  v3: Object.freeze({
    finger: [[-15, 25, -12, 12, 0, 0], [0, 45, 0, 0, 0, 0], [-5, 40, 0, 0, -1, 1]],
    thumb: [[-12, 3, -14, 2, -8, 20], [-16, 6, 0, 0, 0, 0], [-12, 45, 0, 0, -1, 1]],
    // relaxed: the rest, the last joint softly curled
    relaxed: Object.freeze([0, -1, 0, 0, 5]),
    // fan: the thumb opens away from the index (MCP and IP straighten), nail a little up
    fan: Object.freeze([-2, -3, 4, -12, -10]),
    // presented: forward and away from the index, the nail turned up toward the camera
    thumbActive: Object.freeze([-2, -1, 14, -10, -4]),
    // another finger presented: the thumb stays put, the last joint a touch curled
    thumbOther: Object.freeze([0, 0, 0, 0, 2]),
    // the other fingers part further from the presented one: v3's fingers lie
    // close side by side, and a neighbour packed against the active finger
    // fills the close-up with skin (its fill rate) and crowds the nail
    spreadAway: 8,   // 12 put the pinky nail behind the side panel at the rail stop (pan.mjs P3)
    // the presented finger lifts and the others curl a little under it
    // (further curls keep neighbours out of the close-up but break the pan:
    // a finger under the pointer must not move much as the rail glides,
    // pan.mjs P1b, hand.mjs H3, hand-pose.mjs P4)
    active: Object.freeze([-12, 2, 2]),
    other: Object.freeze([10, 12, 6]),
  }),
});
let _set = POSE_SETS.v2;
let _setName = 'v2';

function fillLimits(a, set) {
  a.set(L_WRIST, 0);
  a.set(L_PALM, 6);
  for (let f = 0; f < 5; f++) {
    for (let k = 0; k < 3; k++) a.set((f === 0 ? set.thumb : set.finger)[k], (fingerBase(f) + k) * 6);
  }
  return a;
}

/** LIMITS[b * 6 + k]: per bone, flex/spread/twist min and max (degrees), of the current pose set. */
export const LIMITS = fillLimits(new Float32Array(NB * 6), _set);

/**
 * Switch the pose set ('v2' | 'v3'): the thumb's named and present poses and
 * LIMITS (rewritten in place) follow. Unknown names keep the current set.
 * @returns {string} the set now in use
 */
export function useHandPoseSet(name) {
  if (POSE_SETS[name] && name !== _setName) {
    _set = POSE_SETS[name];
    _setName = name;
    fillLimits(LIMITS, _set);
  }
  return _setName;
}

/** The pose set in use. */
export function handPoseSet() {
  return _setName;
}

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

/**
 * The thumb's natural rest (Jesse, B9 review): beside the index at about 30
 * degrees, turned a little toward the palm, both joints a little curled, the
 * nail partly sideways. Since B9.8 that is the file's own bind pose (the
 * pipeline poses the thumb there in Blender and smooths the thenar web, which
 * linear blend skinning used to crease), so the rest is all zeros. Every pose
 * starts from it (neutral included); the thumb values below are about it.
 * [base flex, base spread, base twist, middle joint flex, last joint flex]
 */
export const THUMB_REST = Object.freeze([0, 0, 0, 0, 0]);

function thumb(out, t) {
  const b = fingerBase(0) * 3;
  out[b] = t[0]; out[b + 1] = t[1]; out[b + 2] = t[2]; out[b + 3] = t[3]; out[b + 6] = t[4];
  return out;
}

// The present pose (plan 5.3): the active finger lifts its tip toward the
// camera, the others relax out of the way and spread a little away from it.
export const PRESENT = Object.freeze({
  // knuckle, middle joint, last joint (flex): the pose set's (v2: [-8, 4, 4] / [8, 10, 5])
  get active() { return _set.active; },
  get other() { return _set.other; },
  get spreadAway() { return _set.spreadAway; },
  // the thumb, about THUMB_REST: presented it comes forward a little away
  // from the index with its nail turned up (its joints straighten toward the
  // file's old straight thumb, never hyper-extended); while another finger is
  // presented it tucks a little closer
  // (before B9.8, about the straight-out thumb: [2, 20, 18, 4, 5] / [6, 28, 4, 14, 12])
  // the thumb's numbers are the pose set's (POSE_SETS: thumbActive, thumbOther)
  get thumbActive() { return _set.thumbActive; },
  get thumbOther() { return _set.thumbOther; },
});

/**
 * Write the present pose of finger `i` (0 = thumb .. 4 = pinky) into `out`.
 */
export function writePresent(i, out) {
  out.fill(0);
  for (let f = 0; f < 5; f++) {
    const b = fingerBase(f) * 3;
    if (f === 0) {
      thumb(out, i === 0 ? PRESENT.thumbActive : PRESENT.thumbOther);
    } else if (f === i) {
      const a = PRESENT.active;
      out[b] = a[0]; out[b + 3] = a[1]; out[b + 6] = a[2];
    } else {
      const o = PRESENT.other;
      out[b] = o[0]; out[b + 3] = o[1]; out[b + 6] = o[2];
      // spread away from the active finger (toward the pinky when on its side)
      out[b + 1] = f > i ? PRESENT.spreadAway : -PRESENT.spreadAway;
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
  for (let f = 1; f < 5; f++) {
    const b = fingerBase(f) * 3;
    out[b] = flex[f][0]; out[b + 3] = flex[f][1]; out[b + 6] = flex[f][2];
    out[b + 1] = spread[f];
  }
  return out;
}

/** Named poses. 'neutral' is the file's rest pose with the thumb at THUMB_REST. */
export const POSE_NAMES = Object.freeze(['neutral', 'relaxed', 'fan']);

export function writeNamed(name, out) {
  out.fill(0);
  if (name === 'relaxed') {
    thumb(out, _set.relaxed);
    return fingers(out, [null, [6, 10, 5], [6, 10, 5], [6, 10, 5], [6, 10, 5]], [0, -1, 0, 1, 2]);
  }
  if (name === 'fan') {
    // the show-off: fingers spread 8-10 degrees, tips a little up, the thumb opens
    thumb(out, _set.fan);
    return fingers(out, [null, [-5, 0, 0], [-5, 0, 0], [-5, 0, 0], [-4, 0, 0]], [0, -9, -2, 5, 10]);
  }
  return thumb(out, THUMB_REST);
}

/**
 * Motion feel (B9.5): the animation-style dials of the hand animation lab
 * (animation-tests/anim.js PRESETS), solved the same way (its HandRig.simulate):
 * every joint angle is a damped spring x'' = k (target - x) - 2 zeta sqrt(k) x'.
 *   stiff   k (1/s^2) of the knuckles; each joint further out is softer by
 *           (1 - 0.45 lag)^level, so fingertips trail the knuckles
 *   bounce  knuckle damping: zeta = max(0.08, 1 - bounce (1 - pa))
 *   tip     the outer joints' damping, the same way
 *   firm    while the brush is on the nail, pa = firm: k x (1 + pa) and the
 *           bounce fades, so the hand firms up and paint lands where it touches
 *   amp     reaction size (the reveal wiggle, the anticipation dip)
 *   ant     anticipation: a small dip against a pose change before it goes
 *   life    idle breathing and drift
 *   lag     see stiff
 *   squash, boil, fps  the lab's hand squash / line boil / stepped frames:
 *           not used in the game (the hand does not translate; no stepping)
 * Pick a preset with MOTION.preset (or ?handfeel=<name>); tune live through
 * app.hand.motion.presets.softpop.stiff = ...
 */
export const MOTION = {
  preset: 'softpop', // Jesse's pick (Nov 24): Soft jelly pop
  presets: {
    softpop: { name: 'Soft jelly pop', stiff: 190, bounce: 0.55, amp: 1.25, ant: 0.6, squash: 0.45, life: 0.9, lag: 0.7, tip: 0.82, boil: 0, firm: 0.9 },
    snappyjelly: { name: 'Snappy jelly', stiff: 380, bounce: 0.45, amp: 1.4, ant: 0.95, squash: 0.6, life: 0.8, lag: 0.6, tip: 0.78, boil: 0, firm: 1.0 },
    cartoon: { name: 'Cartoon snap', stiff: 420, bounce: 0.55, amp: 1.55, ant: 1.0, squash: 1.0, life: 0.4, lag: 0.15, tip: 0.55, boil: 0, firm: 0 },
    jelly: { name: 'Springy jelly', stiff: 70, bounce: 0.75, amp: 1.15, ant: 0.4, squash: 0.5, life: 0.7, lag: 0.7, tip: 0.75, boil: 0, firm: 0 },
  },
  // how fast the brush-down firmness comes and goes (the lab ramps over 0.35 s)
  blendMs: { toFirm: 60, toSpringy: 350 },
};

/** The current preset's dials. */
export function feelOf(motion = MOTION) {
  return motion.presets[motion.preset] || motion.presets.softpop;
}

/** One-shot wiggle: a 0.6 s wave of knuckle flex, pinky to index, 6 degrees. */
export const WIGGLE = Object.freeze({ T: 0.6, amp: 6, fingers: [4, 3, 2, 1], lag: 0.09, width: 0.22 });
