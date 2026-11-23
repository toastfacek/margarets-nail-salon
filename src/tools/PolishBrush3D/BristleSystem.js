/**
 * BristleSystem.js
 * The polish brush rig: a real nail polish brush (a thick, rounded bundle of
 * nylon bristles in a round stem, see brushPresets.js) whose bristle tips sit
 * on the paint point. It leans, turns across the stroke, and only its tip
 * region bends and splays into a paddle as wide as the paint band; the body
 * stays a bundle.
 *
 * Driven by a pose (shared contract, docs/upgrade/brush-plan.md 4.4):
 *
 *   bristles.setPose(pose)   // reused object, copied, fields:
 *     point, normal          // world contact point on the nail, surface normal
 *     axis                   // world unit vector, brush width direction (tangent plane)
 *     velocity               // world tangent-plane velocity of the contact point (units/s)
 *     halfWidth              // world half width of the paint band (pressed tips span exactly this)
 *     pressure, load         // 0..1
 *     contact                // touching the nail (false = hovering above `point`)
 *     isTouch                // more upright brush so it clears a finger
 *     scale                  // active nail width in world units
 *     onSurface (optional)   // false when `point` is not on the nail (no landing blob)
 *   bristles.update(dt, nailMesh, raycaster) -> contact count
 *   bristles.tipCenter       // world centroid of the bristle tips (read only)
 *   bristles.setCamera(cam)  // optional: the view the handle leans in (else the
 *                            // first camera that renders the bristles)
 *   bristles.setPreset(p)    // brush shape (brushPresets.js), default classic
 *   bristles.prewarm(renderer, camera, scene)  // optional: compile now
 *   bristles.measureShape(out) // harness: rendered shape in nail widths
 *
 * The handle is tilted from a blend of view direction and surface normal (55
 * deg mouse, 52 deg touch), leans toward the bottom of the screen, turned 40
 * deg to the right (B7: the brush comes in from the lower right).
 *
 * The old calls (`setBrushTransform`, `setSurface`, `pressure`,
 * `isContacting`) still work: they fill the pose internally.
 *
 * Physics (cheap, analytic, nothing allocated per frame):
 * - The bundle is a stiff body (straight from the stem) plus a tip region
 *   that bends like a cantilever: a cubic from the body's end to the tips.
 *   Its bend follows pressure (less with a steep handle), through a spring
 *   tuned like nylon (zeta 0.55: ~12% overshoot, settles in ~0.1 s).
 * - The tips trail the motion through the same kind of spring: a reversal
 *   flips the bend through straight with a small overshoot; a lift springs
 *   back to the rest dome.
 * - Pressed, the tip region splays to the band's width (a rounded paddle,
 *   front edge an arc from the concentric-ring dome trim) and flattens.
 * - Wet cohesion: a loaded brush is one clumped glossy mass with a few loose
 *   strands; as the load drops the clump loosens (lumpier section, deeper
 *   strand grooves, less clear coat, loose strands fly apart).
 *
 * Rendering: ONE mesh for the head (a lofted closed bundle, elliptical
 * sections along the bend field, plus the loose strands as ribbons), shaded
 * with a wet clear coat, fresnel, procedural strand grooves and a
 * Kajiya-Kay hair highlight (dropped on low). `jointPositions` keeps one
 * skeleton strand per bristle (root at joint 0, tip at the last joint) for
 * contacts, the tip centroid and the harness; they are not drawn.
 *
 * Draw calls: head 1, bead 1, stem + cap 1, landing blob 1.
 */
import * as THREE from 'three';
import { brushPreset, DEFAULT_BRUSH } from './brushPresets.js';

const MAX_BRISTLES = 128;
const JOINTS = 5;
const SEGMENTS = JOINTS - 1;
const RINGS = 12;                 // loft sections along the bundle
const AROUND = 14;                // vertices per section (+1 seam column)
const COLS = AROUND + 1;
const LOFT_VERTS = RINGS * COLS + 1;   // + the centre tip
const LOFT_INDEX = (RINGS - 1) * AROUND * 6 + AROUND * 3;
const MAX_LOOSE = 10;
const LOOSE_SEG = 4;
const FRAMES = 25;                // centreline samples per frame
const FST = 11;                   // frame stride: C xyz, X xyz, N xyz, half width, half thickness
const RAY_BANDS = 5;  // samples across the tip line at -0.5, -0.25, 0, 0.25, 0.5 (centre = the hit itself)
const DEG = Math.PI / 180;

// Motion tuning. Sizes x scale (the active nail's width).
const RIG = Object.freeze({
  clearance: 0.004,        // tips this far above the tangent plane (no z-fight)
  hoverLift: 0.15,         // tips above the point while hovering
  viewBlend: 0.5,          // handle "up" = this much view direction + the rest surface normal
  tiltMouse: 70 * DEG,     // handle angle from that up: laid down, so the stem stays small on screen
  tiltTouch: 66 * DEG,     // a little more upright: clears the finger
  minAN: 0.3,              // handle never closer than ~73 deg to the surface normal
  leanSide: -1,            // the handle's side of the screen: -1 = bottom (the reference: the
                           // brush comes in from the lower right; the finger comes from the top)
  leanRight: 40 * DEG,     // handle turned from that side toward screen-right
  leanRightPortrait: 25 * DEG, // ... less on a tall screen (the nail is narrow there)
  leanLead: 0.6,           // ... and pulled toward the motion by up to this (the handle leads, the bristles drag)
  maxSwing: 20 * DEG,      // ... but never further than this from its resting direction (it never lies across the nail)
  leanFloor: 0.2,          // never past the screen horizon (the finger's side)
  maxSkew: 70 * DEG,       // max angle between the lean and the across-band direction (the face is held flat, the tips twist to the band)
  downTurn: 25 * DEG,      // strokes away from the handle: the lean turns only this much further (the bristles buckle instead)
  downSkew: 15 * DEG,      // ... and may leave the across-band direction this much further
  rightBias: 0.1,          // edge-on strokes put the handle on the screen-right side
  minHeight: 0.25,         // stem end never lower than this above the nail
  trailMax: 0.2,           // the stem leads the tips by up to this at full drag
  trailLag: 0.18,          // the bend's belly lags further (the last third curves back along the stroke)
  trailTilt: 0.55,         // the tips' direction tilts back along the trail
  trailSpeed: 1.0,         // nail widths / s that saturate the drag
  springOmega: 60,         // nylon: zeta 0.55 -> ~12% overshoot, within 5% in ~90 ms
  springZeta: 0.55,
  bendLight: 0.5,          // bend at the lightest touch (full pressure: 1)
  pushBend: 0.35,          // pushing away from the handle: extra bend ...
  pushBow: 0.12,           // ... and the bend's belly bows up (the bristles buckle)
  steepEase: 0.5,          // a steep handle (near the normal) bends this much less
  leanOmega: 14,           // the hand re-aims within ~0.25 s
  axisOmega: 42,           // legacy driver only (the engine sends its own axis)
  widthOmega: 26,          // footprint closing after a lift
  liftOmega: 40,           // tips leaving the surface after a lift
  dirStep: 0.02,           // legacy: nail widths of travel per direction update
  beadRadius: 0.028,       // hovering only: on the nail the polish is in the film
  splayEnd: 0.8,           // pressed: the footprint width is reached here along the bundle
  flatten: 0.75,           // pressed: the tip region gets this much thinner (a paddle)
  domePress: 0.4,          // pressed: the dome trim shrinks by this (an arc front edge stays)
  maxTwist: 40 * DEG,      // the tip region twists at most this from the bundle's own width axis
  edgeLift: 0.6,           // light touch: dome edges outside the footprint lift by this x their overhang
  looseW: 0.0032,          // loose strand half width
});

const PHYSICS_CONFIG = Object.freeze({
  springStep: 1 / 240,
  maxSubsteps: 12,
  restEnergy: 1e-7,
});

// Wet look: polish on a brush is the dense bottle colour, much deeper than a
// sheer coat (reference-brush-1.png): darker and more saturated toward the
// tip where it pools, lighter and drier at the stem.
const SHADE = Object.freeze({ tipDark: 0.38, tipSat: 1.4, root: 0.5, emissive: 0.02 });

const LEGACY_TOUCH_TILT = -1.2;  // PolishBrush3D passes -pi*0.42 for touch, -pi/3 for mouse
const DEFAULT_SCALE = 0.068;

// Deterministic jitter so re-layouts on tier change look the same each time.
function jitter(i, salt) {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

function smooth01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Critically/under-damped vector spring step (semi-implicit Euler). */
function springStep(x, v, tx, ty, tz, omega, zeta, h) {
  const k = omega * omega;
  const c = 2 * zeta * omega;
  v.x += (k * (tx - x.x) - c * v.x) * h;
  v.y += (k * (ty - x.y) - c * v.y) * h;
  v.z += (k * (tz - x.z) - c * v.z) * h;
  x.x += v.x * h;
  x.y += v.y * h;
  x.z += v.z * h;
}

// Head shading: Phong plus a wet clear coat, fresnel, strand grooves and a
// Kajiya-Kay highlight along the bristles (aTan). One program on every tier
// (uAniso switches the hair term), so a tier change never compiles.
const HEAD_VERT_PARS = 'attribute vec3 aTan;\nattribute vec2 aSt;\nvarying vec3 vTanV;\nvarying vec2 vSt;\n';
const HEAD_VERT = '#include <begin_vertex>\nvTanV = normalize(normalMatrix * aTan);\nvSt = aSt;\n';
const HEAD_FRAG_PARS = `uniform vec3 uTipCol;
uniform vec3 uRootCol;
uniform float uWet;
uniform float uAniso;
uniform float uGroove;
varying vec3 vTanV;
varying vec2 vSt;
// ~14 wet clumps of uneven width around the bundle (per-clump hash, no trig)
float brushGroove(vec2 st) {
  return st.x * 14.0;
}
vec2 brushClump(float g) {
  float i = floor(g), f = fract(g);
  float c = 0.3 + 0.4 * fract(i * 0.6180339 + 0.13);   // clump centre
  float w = 0.32 + 0.3 * fract(i * 0.3819660 + 0.71);  // clump half width
  float d = clamp((f - c) / w, -1.0, 1.0);
  return vec2(d, 1.0 - d * d);                          // slope, height
}
`;
const HEAD_COLOR = `float tipK = smoothstep(0.25, 1.0, vSt.y);
float grooveP = brushGroove(vSt);
vec2 clump = brushClump(grooveP);
float grooveF = clump.x;                               // -1..1 across one clump
float grooveS = clump.y;                               // 0 between clumps, 1 on a clump
diffuseColor.rgb = mix(uRootCol, uTipCol, tipK) * (1.0 - uGroove * (0.55 + 0.3 * tipK) * (1.0 - grooveS));
`;
const HEAD_NORMAL = `#include <normal_fragment_maps>
vec3 hairT = normalize(vTanV - normal * dot(normal, vTanV) + 1e-5);
normal = normalize(normal + cross(normal, hairT) * (grooveF * uGroove * 0.6));
`;
const HEAD_LIGHT = `vec3 brushV = normalize(vViewPosition);
vec3 brushX = vec3(0.0);
#if NUM_DIR_LIGHTS > 0
#pragma unroll_loop_start
for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
  {
  vec3 bL = directionalLights[ i ].direction;
  vec3 bH = normalize(bL + brushV);
  float bWin = smoothstep(-0.15, 0.4, dot(normal, bL)) * (UNROLLED_LOOP_INDEX == 0 ? 1.0 : 0.25);  // the key light; the rim only grazes
  float bCoat = pow(max(dot(normal, bH), 0.0), 600.0) * 0.8 * uWet;
  float bHair = 0.0;
  if (uAniso > 0.5) {
    float b1 = dot(normalize(hairT + normal * 0.1), bH);
    float b2 = dot(normalize(hairT - normal * 0.2), bH);
    bHair = pow(max(1.0 - b1 * b1, 0.0), 120.0) * (0.12 + 0.12 * uWet);
    brushX += directionalLights[ i ].color * diffuseColor.rgb * (pow(max(1.0 - b2 * b2, 0.0), 16.0) * 0.18 * bWin);
  }
  float bSheen = pow(max(dot(normal, bH), 0.0), 24.0) * 0.07 * uWet;   // broad wet lobe, every tier
  brushX += directionalLights[ i ].color * (bWin * (bCoat + bHair + bSheen));
  }
}
#pragma unroll_loop_end
#endif
float brushFr = 1.0 - abs(dot(normal, brushV));
brushFr *= brushFr;
brushFr *= brushFr;
brushX += vec3(0.92, 0.9, 1.0) * brushFr * (0.03 + 0.12 * uWet);
outgoingLight += brushX;
#include <opaque_fragment>`;

export class BristleSystem {
  constructor(bristleCount = MAX_BRISTLES) {
    this.maxBristles = MAX_BRISTLES;
    this.jointsPerBristle = JOINTS;
    this.segmentsPerBristle = SEGMENTS;
    this.group = new THREE.Group();
    this.group.name = 'BristleSystem';
    this.preset = brushPreset(DEFAULT_BRUSH);

    // World-space joints of every skeleton strand (the group stays at the origin).
    this.jointPositions = new Float32Array(MAX_BRISTLES * JOINTS * 3);
    // Layout (per strand, set by initializePhysics()): position in the
    // bundle's section, -1..1 across its width (a) and thickness (b).
    this._sa = new Float32Array(MAX_BRISTLES);
    this._sb = new Float32Array(MAX_BRISTLES);
    this._bandDh = new Float32Array(RAY_BANDS);   // height of the real surface under each band
    // Centreline frames (C, width axis, thickness axis, half sizes) for this frame.
    this._fr = new Float32Array(FRAMES * FST);
    this._fs = new Float32Array(FST);
    this._q = new Float32Array(6);   // bend handles
    // Section table and per-vertex clump jitter.
    this._ca = new Float32Array(COLS);
    this._cb = new Float32Array(COLS);
    for (let k = 0; k < COLS; k++) {
      this._ca[k] = Math.cos((k / AROUND) * Math.PI * 2);
      this._cb[k] = Math.sin((k / AROUND) * Math.PI * 2);
    }
    this._vj = new Float32Array(RINGS * COLS);
    for (let r = 0; r < RINGS; r++) for (let k = 0; k < COLS; k++) this._vj[r * COLS + k] = jitter((r * 31 + (k % AROUND)) | 0, 11);
    this._ringC = new Float32Array(RINGS * 3);
    // Loose strands
    this._loose = 0;
    this._la = new Float32Array(MAX_LOOSE);
    this._lb = new Float32Array(MAX_LOOSE);
    this._lj = new Float32Array(MAX_LOOSE);
    this._lp = new Float32Array((LOOSE_SEG + 1) * 3);
    for (let l = 0; l < MAX_LOOSE; l++) {
      this._la[l] = (l % 2 ? -1 : 1) * (1.0 + 0.05 * (jitter(l, 21) + 0.5));
      this._lb[l] = jitter(l, 22) * 1.4;
      this._lj[l] = jitter(l, 23) + 0.5;
    }

    this.physicsSubstepsMax = 3;
    this.collisionMode = 'plane';
    this.radiusScale = 1;
    this.energy = 0;
    this._needsMatrices = true;
    this._dirty = true;

    // The pose (4.4). setPose() copies into it.
    this.pose = {
      point: new THREE.Vector3(0, 0.2, 0),
      normal: new THREE.Vector3(0, 1, 0),
      axis: new THREE.Vector3(1, 0, 0),
      velocity: new THREE.Vector3(),
      halfWidth: 0,
      pressure: 0,
      load: 1,
      contact: false,
      isTouch: false,
      scale: DEFAULT_SCALE,
      onSurface: false,
    };
    this.tipCenter = new THREE.Vector3(0, 0.2, 0);
    // Camera used for the lean (screen-up). Set it, or it is picked up from
    // the first render of the bristles.
    this.camera = null;

    // Rig state (springs)
    this._trail = new THREE.Vector3();
    this._trailVel = new THREE.Vector3();
    this._bend = 0;             // tip-region bend 0 (straight) .. 1 (lying on the nail), springy
    this._bendVel = 0;
    this._lean = new THREE.Vector3();
    this._leanVel = new THREE.Vector3();
    this._leanInit = false;
    this._downK = 0;            // 0..1 how much the stroke runs down the screen (smoothed)
    this._skew = RIG.maxSkew;
    this._side = 1;
    this._hw = DEFAULT_SCALE * this.preset.tipW * 0.5;
    this._c = 0;                // contact blend 1 = on the surface
    this._wasContact = false;
    this._tilt = RIG.tiltMouse;
    this._dry = 0;              // 0 loaded .. 1 dry (clump loosens)
    this._push = 0;             // 0..1 pushing away from the handle (smoothed)

    // Frame of the current pose (scratch, reused)
    this._P = new THREE.Vector3();
    this._N = new THREE.Vector3(0, 1, 0);
    this._X = new THREE.Vector3(1, 0, 0);
    this._Xt = new THREE.Vector3(1, 0, 0);  // the tips' width axis (band axis, twist-limited)
    this._Y = new THREE.Vector3(0, 0, 1);
    this._A = new THREE.Vector3(0, 1, 0);   // handle direction
    this._U = new THREE.Vector3(0, 1, 0);   // handle 'up' (view/normal blend)
    this._F = new THREE.Vector3(1, 0, 0);   // stem width direction (bundle width at the root)
    this._Fn = new THREE.Vector3(0, 0, 1);  // stem thickness direction
    this._Fc = new THREE.Vector3();         // bundle root centre (the stem's end)
    this._B = new THREE.Vector3();          // end of the stiff body, start of the bend
    this._Bt = new THREE.Vector3();         // body direction (root -> B)
    this._tT = new THREE.Vector3();         // tangent at the tips
    this._T = new THREE.Vector3();          // trail in the tangent plane
    this._tipC = new THREE.Vector3();
    this._toCam = new THREE.Vector3(0, 1, 0);
    this._t0 = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._hits = [];
    this._sbody = 0.62;         // fraction of the length that stays a stiff body
    this._warmed = false;
    this._cameraSet = false;

    // Legacy driver state (setBrushTransform / setSurface / pressure / isContacting)
    this._legacy = true;
    this._legacyTouch = false;
    this.brushPosition = new THREE.Vector3();
    this.brushNormal = new THREE.Vector3(0, 0, 1);
    this.pressure = 0;
    this.isContacting = false;
    this.hasSurface = false;
    this._planePoint = new THREE.Vector3();
    this._planeNormal = new THREE.Vector3(0, 1, 0);
    this._lastPoint = new THREE.Vector3();
    this._hasLastPoint = false;
    this._anchor = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._hasDir = false;
    this._axis = new THREE.Vector3(1, 0, 0);
    this._axisVel = new THREE.Vector3();
    this._nailMesh = null;
    this._nailScale = DEFAULT_SCALE;
    this._nailAxis = 1;          // local axis that runs across the nail
    this._nailWidthDir = new THREE.Vector3(1, 0, 0);

    // Contact pool for effects (world space). Read contactCount entries.
    this.contactCount = 0;
    this.contactPoints = new Array(MAX_BRISTLES);
    for (let i = 0; i < MAX_BRISTLES; i++) {
      this.contactPoints[i] = { position: new THREE.Vector3(), normal: new THREE.Vector3(), pressure: 0, bristleIndex: i };
    }

    this.color = new THREE.Color('#ff2a6d');
    this.load = 1;

    this.bristleCount = Math.min(MAX_BRISTLES, bristleCount);
    this._setTierLook(this.bristleCount);
    this.createGeometry();
    this.initializePhysics();
  }

  // ------------------------------------------------------------ meshes --

  createGeometry() {
    const verts = LOFT_VERTS + MAX_LOOSE * LOOSE_SEG * 4;
    const positions = new Float32Array(verts * 3);
    const normals = new Float32Array(verts * 3);
    const tangents = new Float32Array(verts * 3);
    const st = new Float32Array(verts * 2);
    const index = new Uint16Array(LOFT_INDEX + MAX_LOOSE * LOOSE_SEG * 6);
    let o = 0;
    // Loft: (RINGS-1) x AROUND quads, wound so cross(along, around) is outward.
    for (let r = 0; r < RINGS - 1; r++) {
      for (let k = 0; k < AROUND; k++) {
        const v00 = r * COLS + k, v01 = v00 + 1, v10 = v00 + COLS, v11 = v10 + 1;
        index[o++] = v00; index[o++] = v10; index[o++] = v01;
        index[o++] = v01; index[o++] = v10; index[o++] = v11;
      }
    }
    // Tip cap: the last section (the dome outline) to the centre tip.
    const tip = RINGS * COLS;
    for (let k = 0; k < AROUND; k++) {
      const v = (RINGS - 1) * COLS + k;
      index[o++] = v; index[o++] = tip; index[o++] = v + 1;
    }
    // Loose strand ribbons.
    for (let q = 0; q < MAX_LOOSE * LOOSE_SEG; q++) {
      const v = LOFT_VERTS + q * 4;
      index[o++] = v; index[o++] = v + 1; index[o++] = v + 2;
      index[o++] = v + 2; index[o++] = v + 1; index[o++] = v + 3;
    }
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    for (let i = 0; i < tangents.length; i += 3) tangents[i] = 1;

    const geometry = new THREE.BufferGeometry();
    this._positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    this._normalAttr = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
    this._tanAttr = new THREE.BufferAttribute(tangents, 3).setUsage(THREE.DynamicDrawUsage);
    this._stAttr = new THREE.BufferAttribute(st, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this._positionAttr);
    geometry.setAttribute('normal', this._normalAttr);
    geometry.setAttribute('aTan', this._tanAttr);
    geometry.setAttribute('aSt', this._stAttr);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, LOFT_INDEX + this._loose * LOOSE_SEG * 6);
    // Vertices are rewritten in world space every moving frame: a fixed
    // bounding sphere would be wrong, and the mesh is never culled anyway.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const uni = this._uni = {
      uTipCol: { value: new THREE.Color() },
      uRootCol: { value: new THREE.Color() },
      uWet: { value: 1 },
      uAniso: { value: this._aniso },
      uGroove: { value: 0.3 },
    };
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 1,
      specular: 0x222222,
      shininess: 36,
      side: THREE.FrontSide,   // closed loft wound outward; ribbons wound to the camera
    });
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + HEAD_VERT_PARS)
        .replace('#include <begin_vertex>', HEAD_VERT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + HEAD_FRAG_PARS)
        .replace('#include <color_fragment>', HEAD_COLOR)
        .replace('#include <normal_fragment_maps>', HEAD_NORMAL)
        .replace('#include <opaque_fragment>', HEAD_LIGHT);
    };
    material.customProgramCacheKey = () => 'polishBrushHead1';

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'Bristles';
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      if (camera !== this.camera && camera.isPerspectiveCamera && camera.fov !== 90 && !this._cameraSet) this.camera = camera;
      if (!this._warmed) this._scheduleWarm(renderer, scene, camera);
    };
    this.group.add(this.mesh);

    // The bead: one small glossy sphere, squashed on contact. Same program
    // as the stem (Phong + vertex colours, front faces).
    const beadMaterial = new THREE.MeshPhongMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 0.06,
      specular: 0x9a9a9a,
      shininess: 220,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    const beadGeometry = new THREE.SphereGeometry(1, 14, 10);
    const white = new Float32Array(beadGeometry.attributes.position.count * 3);
    white.fill(1);
    beadGeometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
    this.bead = new THREE.Mesh(beadGeometry, beadMaterial);
    this.bead.name = 'BrushBead';
    this.bead.frustumCulled = false;
    this.bead.matrixAutoUpdate = false;
    this.bead.raycast = () => {};
    this.group.add(this.bead);

    this.createBrushHandle();
    this.createLandingBlob();
  }

  /** Legacy name kept for callers that reach for the bristle mesh. */
  get instancedMesh() {
    return this.mesh;
  }

  /** Harness: the tip-trail spring (world vector, units of the drag saturation). */
  get trail() {
    return this._trail;
  }

  /** Harness: the tip-region bend now (0 straight .. 1 lying on the nail; springy). */
  get bend() {
    return this._bend;
  }

  /**
   * Round stem (the rod the bristles sit in) -> slim purple cap, one merged
   * mesh in units of the nail width (the matrix scales it), +Y along the
   * handle. Vertex coloured, same program as the bead.
   */
  _handleGeometry() {
    const parts = [];
    const add = (geo, color) => {
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      const c = new THREE.Color(color);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(geo);
    };
    const r = 0.5 * this.preset.stemD;
    // The stem's end: a short bevelled collar, closed, so the bundle comes
    // out of a solid face (its root section is hidden inside).
    const collar = new THREE.CylinderGeometry(r, r * 0.84, 0.07, 22, 1, false);
    collar.translate(0, 0.035 - 0.012, 0);
    add(collar, 0xc4b6d6);
    // Stem: a pearly rod.
    const stem = new THREE.CylinderGeometry(r, r, 1.0, 22, 1, true);
    stem.translate(0, 0.058 + 0.5, 0);
    add(stem, 0xe6ddf0);
    // Cap: the bottle cap the hand holds, far enough up the stem that it
    // stays off the nail and the fresh paint.
    const capR = Math.max(0.21, r * 1.3);
    const capNeck = new THREE.CylinderGeometry(capR * 0.96, r * 1.04, 0.08, 22, 1, false);
    capNeck.translate(0, 1.058 + 0.04, 0);
    add(capNeck, 0x4a2270);
    const cap = new THREE.CylinderGeometry(capR, capR * 0.96, 0.9, 22, 1, false);
    cap.translate(0, 1.138 + 0.45, 0);
    add(cap, 0x5a2a82);
    const top = new THREE.SphereGeometry(capR, 22, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    top.scale(1, 0.4, 1);
    top.translate(0, 2.038, 0);
    add(top, 0x5a2a82);

    let vCount = 0, iCount = 0;
    for (const g of parts) { vCount += g.attributes.position.count; iCount += g.index.count; }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const col = new Float32Array(vCount * 3);
    const idx = new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      col.set(g.attributes.color.array, vo * 3);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      vo += g.attributes.position.count;
      io += gi.length;
      g.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    return geometry;
  }

  createBrushHandle() {
    const handleMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x140a1e,
      emissiveIntensity: 1,
      specular: 0xffffff,
      shininess: 80,
      vertexColors: true,
      side: THREE.FrontSide,   // closed: the collar and the cap neck close the open stem
    });
    this.handle = new THREE.Mesh(this._handleGeometry(), handleMaterial);
    this.handle.name = 'BrushHandle';
    this.handle.frustumCulled = false;
    this.handle.matrixAutoUpdate = false;
    this.handle.raycast = () => {};
    this.group.add(this.handle);
  }

  /** Soft dark disc on the nail under the hovering tip: where it will land. */
  createLandingBlob() {
    const seg = 20;
    const geo = new THREE.CircleGeometry(1, seg);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 4);
    const p = geo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(p[i * 3], p[i * 3 + 1]);
      col[i * 4] = 0.16; col[i * 4 + 1] = 0.06; col[i * 4 + 2] = 0.14;
      col[i * 4 + 3] = 1 - r;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthTest: true,
      depthWrite: false,
    });
    this.blob = new THREE.Mesh(geo, mat);
    this.blob.name = 'BrushLandingBlob';
    this.blob.frustumCulled = false;
    this.blob.matrixAutoUpdate = false;
    this.blob.renderOrder = 2;
    this.blob.raycast = () => {};
    // Visible (opacity 0) until prewarm() has compiled its program, so it
    // is compiled with the scene at load, never mid-stroke; hidden while
    // unused after that.
    this.group.add(this.blob);
  }

  /** Compile this rig's programs now (optional; also done once at idle). */
  prewarm(renderer, camera, scene = null) {
    this._warmed = true;
    try {
      const was = this.group.visible, blobWas = this.blob.visible;
      this.group.visible = true;
      this.blob.visible = true;
      renderer.compile(this.group, camera, scene || this.group.parent || undefined);
      this.group.visible = was;
      this.blob.visible = blobWas;
    } catch (err) {
      // optimisation only
    }
  }

  _scheduleWarm(renderer, scene, camera) {
    this._warmed = true;
    const go = () => this.prewarm(renderer, camera, scene);
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 500);
  }

  /** Set the camera whose screen the handle leans in (toward the lower right). */
  setCamera(camera) {
    this.camera = camera;
    this._cameraSet = !!camera;
  }

  /** Brush shape (brushPresets.js). Rebuilds the stem; no shader change. */
  setPreset(preset) {
    if (!preset || preset === this.preset) return;
    this.preset = preset;
    const old = this.handle.geometry;
    this.handle.geometry = this._handleGeometry();
    old.dispose();
    this.initializePhysics();
  }

  /** Per-tier look: loose strands and the hair highlight (high/medium only). */
  _setTierLook(count) {
    this._loose = count >= 128 ? MAX_LOOSE : count >= 64 ? 6 : 0;
    this._aniso = count >= 64 ? 1 : 0;
    if (this._uni) this._uni.uAniso.value = this._aniso;
    if (this.mesh) this.mesh.geometry.setDrawRange(0, LOFT_INDEX + this._loose * LOOSE_SEG * 6);
  }

  /**
   * Change bristle count / strand width / spring budget (tier change).
   */
  configure({ bristles = this.bristleCount, radiusScale = this.radiusScale, substeps = this.physicsSubstepsMax, collision = this.collisionMode } = {}) {
    this.physicsSubstepsMax = Math.max(1, substeps | 0);
    this.collisionMode = collision;
    const count = Math.max(8, Math.min(MAX_BRISTLES, bristles | 0));
    if (count !== this.bristleCount || radiusScale !== this.radiusScale) {
      this.bristleCount = count;
      this.radiusScale = radiusScale;
      this._setTierLook(count);
      this.initializePhysics();
    }
  }

  /**
   * Lay the skeleton strands out in concentric rings across the bundle's
   * section (patent US4454622: rings of bristles, the outer ring trimmed
   * shortest). The outer ring holds a = +-1 exactly, so pressed tips span
   * exactly the footprint.
   */
  initializePhysics() {
    const n = this.bristleCount;
    const radii = [1, 0.72, 0.45, 0.2];
    const sumR = radii[0] + radii[1] + radii[2] + radii[3];
    let b = 0;
    if (n > 0) { this._sa[0] = 0; this._sb[0] = 0; b = 1; }
    for (let ri = 0; ri < radii.length && b < n; ri++) {
      const r = radii[ri];
      let cnt = ri === radii.length - 1 ? n - b : Math.max(2, Math.round((n - 1) * r / sumR));
      if (ri === 0) cnt += cnt % 2;   // even: a = +1 and -1 both present
      cnt = Math.min(cnt, n - b);
      for (let j = 0; j < cnt; j++) {
        let phi = (j / cnt) * Math.PI * 2 + (ri % 2 ? Math.PI / cnt : 0);
        if (ri > 0) phi += jitter(b, 3) * 0.6 / cnt;
        const rr = ri > 0 ? r * (1 + jitter(b, 4) * 0.15) : r;
        this._sa[b] = rr * Math.cos(phi);
        this._sb[b] = rr * Math.sin(phi);
        b++;
      }
    }
    this.energy = 0;
    this._needsMatrices = true;
    this._dirty = true;
    this._writeColors();
    this.updateGeometry();
  }

  /** Head colours: wet ramp toward the tip (uniforms; no vertex rewrite). */
  _writeColors() {
    const c = this.color;
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    this._uni.uTipCol.value.setRGB(
      Math.max(0, lum + (c.r - lum) * SHADE.tipSat) * SHADE.tipDark,
      Math.max(0, lum + (c.g - lum) * SHADE.tipSat) * SHADE.tipDark,
      Math.max(0, lum + (c.b - lum) * SHADE.tipSat) * SHADE.tipDark,
    );
    this._uni.uRootCol.value.setRGB(c.r * SHADE.root, c.g * SHADE.root, c.b * SHADE.root);
    const m = this.mesh.material;
    m.emissive.setRGB(c.r * SHADE.emissive, c.g * SHADE.emissive, c.b * SHADE.emissive);
  }

  // -------------------------------------------------------------- pose --

  /**
   * Drive the rig (4.4). The pose object is copied; the caller may reuse it.
   * Call update(dt, ...) afterwards in the same frame.
   */
  setPose(pose) {
    const p = this.pose;
    p.point.copy(pose.point);
    p.normal.copy(pose.normal);
    if (pose.axis) p.axis.copy(pose.axis);
    if (pose.velocity) p.velocity.copy(pose.velocity); else p.velocity.set(0, 0, 0);
    p.scale = pose.scale > 0 ? pose.scale : this._nailScale;
    p.pressure = pose.pressure > 0 ? Math.min(1, pose.pressure) : 0;
    const pr = this.preset;
    p.halfWidth = pose.halfWidth > 0 ? pose.halfWidth : 0.5 * p.scale * (pr.bandMin + pr.bandPress * p.pressure);
    p.contact = !!pose.contact;
    p.isTouch = !!pose.isTouch;
    p.onSurface = pose.onSurface !== undefined ? !!pose.onSurface : true;
    if (pose.load !== undefined && Math.abs(pose.load - this.load) > 0.002) this.load = Math.max(0, Math.min(1, pose.load));
    this._legacy = false;
    this._dirty = true;
  }

  /**
   * Legacy driver: brush position (ignored for the pose: tips go to the
   * surface point) and handle tilt (only used to tell touch from mouse).
   * Also used by activate() to park the brush.
   */
  setBrushTransform(position, normal, tilt = 0) {
    this.brushPosition.copy(position);
    this.brushNormal.copy(normal);
    this._legacyTouch = tilt < LEGACY_TOUCH_TILT;
    this._legacy = true;
    this._dirty = true;
  }

  /**
   * Legacy driver: the collision surface for this frame (world space).
   * Pass hasSurface=false when the brush is off the nail.
   */
  setSurface(point, normal, hasSurface) {
    this.hasSurface = !!hasSurface;
    if (this.hasSurface) {
      this._planePoint.copy(point);
      this._planeNormal.copy(normal);
    }
    this._dirty = true;
  }

  /** Nail width (world) and its across direction, cached per mesh. */
  _nailMetrics(nailMesh) {
    if (!nailMesh || !nailMesh.geometry) return;
    const e = nailMesh.matrixWorld.elements;
    if (nailMesh !== this._nailMesh) {
      this._nailMesh = nailMesh;
      const geo = nailMesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const sx = Math.hypot(e[0], e[1], e[2]) * (bb.max.x - bb.min.x);
      const sy = Math.hypot(e[4], e[5], e[6]) * (bb.max.y - bb.min.y);
      const sz = Math.hypot(e[8], e[9], e[10]) * (bb.max.z - bb.min.z);
      // The middle extent is the width (longest = length, shortest = curve depth).
      let axis = 0, w = sx;
      if ((sy - sx) * (sy - sz) <= 0) { axis = 1; w = sy; } else if ((sz - sx) * (sz - sy) <= 0) { axis = 2; w = sz; }
      this._nailAxis = axis;
      this._nailScale = w > 1e-5 ? w : DEFAULT_SCALE;
    }
    const o = this._nailAxis * 4;
    this._nailWidthDir.set(e[o], e[o + 1], e[o + 2]).normalize();
  }

  /** Legacy: fill the pose from setBrushTransform / setSurface / pressure / isContacting. */
  _legacyPose(dt, nailMesh) {
    this._nailMetrics(nailMesh);
    const p = this.pose;
    const valid = this.hasSurface;
    if (valid) {
      p.point.copy(this._planePoint);
      p.normal.copy(this._planeNormal);
    } else {
      p.point.copy(this.brushPosition);
      p.normal.copy(this.brushNormal);
    }
    const contact = valid && this.isContacting;
    p.onSurface = valid;
    p.contact = contact;
    p.isTouch = this._legacyTouch;
    p.scale = this._nailScale;
    p.pressure = contact ? Math.max(0, Math.min(1, this.pressure)) : 0;
    p.halfWidth = 0.5 * p.scale * (this.preset.bandMin + this.preset.bandPress * p.pressure);
    p.load = this.load;
    const N = p.normal;

    // Velocity of the contact point (smoothed a little).
    if (contact && this._hasLastPoint && dt > 0) {
      const inv = 1 / dt;
      const k = 1 - Math.exp(-dt / 0.03);
      p.velocity.x += ((p.point.x - this._lastPoint.x) * inv - p.velocity.x) * k;
      p.velocity.y += ((p.point.y - this._lastPoint.y) * inv - p.velocity.y) * k;
      p.velocity.z += ((p.point.z - this._lastPoint.z) * inv - p.velocity.z) * k;
    } else {
      p.velocity.set(0, 0, 0);
    }
    this._lastPoint.copy(p.point);
    this._hasLastPoint = contact;

    // Axis: across the nail at stroke start, then across the direction of
    // travel (updated every 2% of a nail width), through a 70 ms spring.
    const ax = this._axis;
    if (contact && !this._wasContact) {
      ax.copy(this._nailWidthDir);
      this._axisVel.set(0, 0, 0);
      this._anchor.copy(p.point);
      this._hasDir = false;
    }
    ax.addScaledVector(N, -ax.dot(N));
    if (ax.lengthSq() < 1e-8) ax.copy(this._nailWidthDir).addScaledVector(N, -this._nailWidthDir.dot(N));
    ax.normalize();
    if (contact) {
      const d = this._t0.copy(p.point).sub(this._anchor);
      d.addScaledVector(N, -d.dot(N));
      if (d.length() > RIG.dirStep * p.scale) {
        this._dir.copy(d).normalize();
        this._anchor.copy(p.point);
        this._hasDir = true;
      }
      if (this._hasDir) {
        const tgt = this._t1.crossVectors(N, this._dir).normalize();
        if (tgt.dot(ax) < 0) tgt.negate();
        this._springVec(ax, this._axisVel, tgt, RIG.axisOmega, 1, dt);
        ax.addScaledVector(N, -ax.dot(N)).normalize();
      }
    }
    p.axis.copy(ax);
  }

  _springVec(x, v, target, omega, zeta, dt) {
    if (!(dt > 0)) return;
    const steps = Math.min(PHYSICS_CONFIG.maxSubsteps, Math.max(1, Math.ceil(dt / PHYSICS_CONFIG.springStep)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) springStep(x, v, target.x, target.y, target.z, omega, zeta, h);
  }

  /** Scalar spring for the bend (same nylon tuning). */
  _springBend(target, dt) {
    if (!(dt > 0)) return;
    const steps = Math.min(PHYSICS_CONFIG.maxSubsteps, Math.max(1, Math.ceil(dt / PHYSICS_CONFIG.springStep)));
    const h = dt / steps;
    const k = RIG.springOmega * RIG.springOmega, c = 2 * RIG.springZeta * RIG.springOmega;
    for (let s = 0; s < steps; s++) {
      this._bendVel += (k * (target - this._bend) - c * this._bendVel) * h;
      this._bend += this._bendVel * h;
    }
  }

  // ------------------------------------------------------------- rig ----

  /** Advance springs and solve the frame for this pose. Returns motion energy. */
  _solve(dt) {
    const pose = this.pose;
    const pr = this.preset;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const L = pr.length * scale;
    const P = this._P.copy(pose.point);
    const N = this._N.copy(pose.normal);
    if (N.lengthSq() < 1e-10) N.set(0, 1, 0);
    N.normalize();
    const contact = pose.contact;

    // View frame. The handle is placed against U, a blend of the view
    // direction and the surface normal, so its on-screen direction is
    // predictable even on a rolled finger (the normal there tilts ~20 deg).
    const cam = this.camera;
    const up = this._t0, right = this._t1;
    if (cam) {
      const e = cam.matrixWorld.elements;
      right.set(e[0], e[1], e[2]);
      up.set(e[4], e[5], e[6]);
      this._toCam.set(e[12] - P.x, e[13] - P.y, e[14] - P.z).normalize();
    } else {
      right.set(1, 0, 0);
      up.set(0, 0, -1);
      this._toCam.copy(N);
    }
    const U = this._U.copy(this._toCam).multiplyScalar(RIG.viewBlend).addScaledVector(N, 1 - RIG.viewBlend).normalize();
    up.addScaledVector(U, -up.dot(U));
    if (up.lengthSq() < 1e-8) { up.set(0, 0, -1); up.addScaledVector(U, -up.dot(U)); }
    up.normalize();
    right.addScaledVector(U, -right.dot(U)).addScaledVector(up, -right.dot(up));
    if (right.lengthSq() < 1e-8) right.crossVectors(up, U);
    right.normalize();

    // Width axis and across-band direction.
    const X = this._X.copy(pose.axis);
    X.addScaledVector(N, -X.dot(N));
    if (X.lengthSq() < 1e-8) X.copy(right);
    X.normalize();
    const Y = this._Y.crossVectors(N, X).normalize();

    // Contact blend: lands at once (tips on the paint in the same frame),
    // lifts over ~25 ms.
    if (contact) this._c = 1;
    else this._c *= Math.exp(-RIG.liftOmega * Math.max(0, dt));
    if (this._c < 1e-3) this._c = 0;
    const c = this._c;
    this._wasContact = contact;

    const p = contact ? pose.pressure : 0;
    const ld = this.load;
    this._dry = 1 - smooth01(ld / 0.35);

    // Trail: follows -velocity (direction, saturating magnitude), through
    // the nylon spring: a reversal swings through straight and overshoots a
    // little, a lift springs back to rest the same way.
    const v = this._t2.copy(pose.velocity);
    v.addScaledVector(N, -v.dot(N));
    const speed = v.length();
    let sat = 0;
    if (contact && speed > 1e-6) {
      sat = Math.min(1, speed / (RIG.trailSpeed * scale));
      v.multiplyScalar(-sat / speed);
    } else {
      v.set(0, 0, 0);
    }
    const tr = this._trail;
    const trX = tr.x, trY = tr.y, trZ = tr.z;
    this._springVec(tr, this._trailVel, v, RIG.springOmega, RIG.springZeta, dt);
    const T = this._T.copy(tr);
    T.addScaledVector(N, -T.dot(N));
    let energy = (tr.x - trX) ** 2 + (tr.y - trY) ** 2 + (tr.z - trZ) ** 2 + this._trailVel.lengthSq() * 1e-4;

    // Footprint: exactly the band while touching; closes to rest after a lift.
    const restHw = 0.5 * pr.tipW * scale;
    if (contact) {
      this._hw = pose.halfWidth;
    } else {
      const k = 1 - Math.exp(-RIG.widthOmega * Math.max(0, dt));
      const before = this._hw;
      this._hw += (restHw - this._hw) * k;
      energy += ((this._hw - before) / scale) ** 2;
    }

    // Lean (on screen): toward the handle's side (B: screen-down), turned
    // toward screen-right, pulled toward the motion (the handle leads, the
    // bristles drag behind), then kept within maxSkew of the across-band
    // direction so the flat face shows. The side is sticky and the lean
    // spring smooth, so a scrub does not swing it.
    const B = up.multiplyScalar(RIG.leanSide);
    const D = this._t2;  // v no longer needed
    // Strokes away from the handle (up the screen): turn the handle out to
    // the right (up to downTurn), so the stem stays level with or ahead of
    // the tips and the flat face shows. Held through brief stalls in contact.
    let downK = contact ? this._downK : 0;
    if (contact && sat > 0.04) {
      const vx = pose.velocity.x, vy = pose.velocity.y, vz = pose.velocity.z;
      const vu = vx * B.x + vy * B.y + vz * B.z;
      const vr = vx * right.x + vy * right.y + vz * right.z;
      const vs = Math.hypot(vu, vr);
      downK = vs > 1e-9 && vu < 0 ? -vu / vs : 0;
    }
    this._downK += (downK - this._downK) * (1 - Math.exp(-25 * Math.max(0, dt)));
    const leanR = cam && cam.aspect < 1 ? RIG.leanRightPortrait : RIG.leanRight;
    const leanA = leanR + RIG.downTurn * this._downK;
    this._skew = RIG.maxSkew + RIG.downSkew * this._downK;
    D.copy(B).multiplyScalar(Math.cos(leanA)).addScaledVector(right, Math.sin(leanA));
    if (contact && speed > 1e-6 && downK < 0.3) {
      const vx = pose.velocity.x, vy = pose.velocity.y, vz = pose.velocity.z;
      const vu = vx * U.x + vy * U.y + vz * U.z;
      const sx = vx - vu * U.x, sy = vy - vu * U.y, sz = vz - vu * U.z;
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1e-9) {
        const m = RIG.leanLead * sat / sl;
        D.x += sx * m; D.y += sy * m; D.z += sz * m;
      }
    }
    D.normalize();
    // the hand turns a little with the stroke, it does not swing the handle round
    {
      const r0x = B.x * Math.cos(leanR) + right.x * Math.sin(leanR);
      const r0y = B.y * Math.cos(leanR) + right.y * Math.sin(leanR);
      const r0z = B.z * Math.cos(leanR) + right.z * Math.sin(leanR);
      const cd = D.x * r0x + D.y * r0y + D.z * r0z;
      if (cd < Math.cos(RIG.maxSwing)) {
        let px = D.x - cd * r0x, py = D.y - cd * r0y, pz = D.z - cd * r0z;
        const pl = Math.hypot(px, py, pz);
        if (pl > 1e-6) { px /= pl; py /= pl; pz /= pl; } else { px = right.x; py = right.y; pz = right.z; }
        const cs = Math.cos(RIG.maxSwing), sn = Math.sin(RIG.maxSwing);
        D.set(r0x * cs + px * sn, r0y * cs + py * sn, r0z * cs + pz * sn);
      }
    }
    // never past the horizon of the screen (the finger's side)
    const du = D.dot(B);
    if (du < RIG.leanFloor) {
      const dr = D.dot(right) >= 0 ? 1 : -1;
      D.copy(B).multiplyScalar(RIG.leanFloor).addScaledVector(right, dr * Math.sqrt(1 - RIG.leanFloor * RIG.leanFloor));
    }
    const Ys = this._t1.copy(Y).addScaledVector(U, -Y.dot(U));
    if (Ys.lengthSq() < 1e-8) Ys.copy(B);
    Ys.normalize();
    const score = D.dot(Ys) + RIG.rightBias * right.dot(Ys);
    if (score > 0.15) this._side = 1;
    else if (score < -0.15) this._side = -1;
    const lean = this._t0; // up no longer needed
    this._clampSkew(lean.copy(D), Ys, right);
    if (!this._leanInit) {
      this._lean.copy(lean);
      this._leanVel.set(0, 0, 0);
      this._leanInit = true;
    } else {
      const lx = this._lean.x, ly = this._lean.y, lz = this._lean.z;
      this._springVec(this._lean, this._leanVel, lean, RIG.leanOmega + 18 * this._downK, 1, dt);
      energy += (this._lean.x - lx) ** 2 + (this._lean.y - ly) ** 2 + (this._lean.z - lz) ** 2;
    }
    const L2 = this._lean;
    L2.addScaledVector(U, -L2.dot(U));
    if (L2.lengthSq() < 1e-8) L2.copy(Ys);
    L2.normalize();
    this._clampSkew(L2, Ys, right);

    // Handle direction, kept clear of the surface.
    const tilt = pose.isTouch ? RIG.tiltTouch : RIG.tiltMouse;
    this._tilt = tilt;
    const A = this._A.copy(U).multiplyScalar(Math.cos(tilt)).addScaledVector(L2, Math.sin(tilt)).normalize();
    let an = A.dot(N);
    if (an < RIG.minAN) { A.addScaledVector(N, RIG.minAN - an).normalize(); an = A.dot(N); }

    // Bend: pressure, less with a steep handle; springy both ways.
    const steep = smooth01((an - 0.45) / 0.45);
    // Pushing away from the handle (the handle no longer swings round): the
    // tip region bends harder and its belly bows, as pressed nylon buckles.
    let push = 0;
    if (contact && sat > 0) {
      const ahx = A.x - N.x * an, ahy = A.y - N.y * an, ahz = A.z - N.z * an;
      const al = Math.hypot(ahx, ahy, ahz);
      if (al > 1e-6) {
        const vx = pose.velocity.x, vy = pose.velocity.y, vz = pose.velocity.z;
        const vl = Math.hypot(vx, vy, vz) || 1;
        push = Math.max(0, -(vx * ahx + vy * ahy + vz * ahz) / (vl * al)) * sat;
      }
    }
    this._push += (push - this._push) * (1 - Math.exp(-20 * Math.max(0, dt)));
    let bendT = contact ? (RIG.bendLight + (1 - RIG.bendLight) * p) * (1 - RIG.steepEase * steep) : 0;
    bendT = Math.min(1.05, bendT * (1 + RIG.pushBend * this._push));
    const b0 = this._bend;
    this._springBend(bendT, dt);
    energy += (this._bend - b0) ** 2 + this._bendVel * this._bendVel * 1e-4;
    const bend = this._bend < -0.25 ? -0.25 : this._bend > 1.1 ? 1.1 : this._bend;

    // Tips: on the surface while touching, hovering otherwise.
    const tipC = this._tipC.copy(P).addScaledVector(N, (RIG.clearance + (1 - c) * RIG.hoverLift) * scale);

    // Tip direction: from along the handle (straight) toward lying on the
    // nail (bent), tilted back along the trail.
    const G = this._t2.copy(A).negate().addScaledVector(N, an);   // -A in the tangent plane
    if (G.lengthSq() < 1e-8) G.copy(Y);
    G.normalize();
    const tT = this._tT.copy(A).multiplyScalar(-(1 - bend)).addScaledVector(G, bend).addScaledVector(T, RIG.trailTilt * c * (1 - 0.8 * this._push));
    if (tT.lengthSq() < 1e-8) tT.copy(A).negate();
    tT.normalize();

    // Walk back from the tips: the bent region (an arc, chord shortened by
    // its turn), then the stiff body along the handle to the stem's end.
    const sb = this._sbody = pr.tipStart - 0.06;
    const Lt = L * (1 - sb), Lb = L * sb;
    const ca = Math.max(-1, Math.min(1, -tT.dot(A)));
    const th = Math.acos(ca);
    const chord = th < 1e-3 ? Lt : Lt * Math.sin(th * 0.5) / (th * 0.5);
    const Bp = this._B.copy(A).multiplyScalar(-1).add(tT);
    if (Bp.lengthSq() < 1e-8) Bp.copy(A).negate();
    Bp.normalize();
    const drag = RIG.trailMax * scale * (0.5 + 0.5 * p) * c * (1 - 0.8 * this._push);
    Bp.multiplyScalar(-chord).add(tipC).addScaledVector(T, -drag);
    // Keep the bent region's length: scale its chord until the cubic
    // _buildFrames lays (same handles) is Lt long.
    this._Bt.copy(A).negate();
    for (let it = 0; it < 3; it++) {
      const arc = this._bendArc(scale);
      if (arc > 1e-9) Bp.sub(tipC).multiplyScalar(Lt / arc).add(tipC);
    }
    const Fc = this._Fc.copy(Bp).addScaledVector(A, Lb);
    const h = this._t1.copy(Fc).sub(P).dot(N);
    const minH = RIG.minHeight * scale;
    if (h < minH) { Fc.addScaledVector(N, minH - h); Bp.addScaledVector(N, minH - h); }
    this._Bt.copy(Bp).sub(Fc).normalize();

    // Stem axes: the flat face held flat to the nail (width axis in the
    // tangent plane, across the handle), on the band axis' side.
    const F = this._F.crossVectors(N, A);
    if (F.lengthSq() < 1e-8) F.copy(X).addScaledVector(A, -X.dot(A));
    F.normalize();
    if (F.dot(X) < 0) F.negate();
    this._Fn.crossVectors(A, F).normalize();
    // The tips' width axis: the band axis, but the bundle twists at most
    // maxTwist toward it from its own width axis (a bigger twist folds the
    // paddle; the band edges then run just past the tips).
    {
      const Xt = this._Xt.copy(X).addScaledVector(N, -X.dot(N));
      const Fp = this._t1.copy(F).addScaledVector(N, -F.dot(N));
      if (Fp.lengthSq() > 1e-8 && Xt.lengthSq() > 1e-8) {
        Fp.normalize(); Xt.normalize();
        const cf = Math.max(-1, Math.min(1, Fp.dot(Xt)));
        const ang = Math.acos(cf);
        if (ang > RIG.maxTwist) {
          Xt.addScaledVector(Fp, -cf);
          if (Xt.lengthSq() < 1e-8) Xt.crossVectors(N, Fp);
          Xt.normalize();
          Xt.multiplyScalar(Math.sin(RIG.maxTwist)).addScaledVector(Fp, Math.cos(RIG.maxTwist)).normalize();
        }
      } else Xt.copy(X);
    }

    this.energy = energy;
    return energy;
  }

  /** Bend handles q1, q2 (into this._q) from the body end to the tips. */
  _bendHandles(scale) {
    const Bp = this._B, Bt = this._Bt, tipC = this._tipC, tT = this._tT, T = this._T, q = this._q;
    const gap = Math.hypot(tipC.x - Bp.x, tipC.y - Bp.y, tipC.z - Bp.z);
    const hh = gap * 0.38;
    const lag = RIG.trailLag * scale * this._c * (1 - 0.7 * this._push);
    const bow = RIG.pushBow * scale * this._c * this._push, N = this._N;
    q[0] = Bp.x + Bt.x * hh + T.x * lag + N.x * bow; q[1] = Bp.y + Bt.y * hh + T.y * lag + N.y * bow; q[2] = Bp.z + Bt.z * hh + T.z * lag + N.z * bow;
    q[3] = tipC.x - tT.x * hh + T.x * lag * 0.5; q[4] = tipC.y - tT.y * hh + T.y * lag * 0.5; q[5] = tipC.z - tT.z * hh + T.z * lag * 0.5;
    return q;
  }

  /** Arc length of the bend cubic (8 chords). */
  _bendArc(scale) {
    const q = this._bendHandles(scale);
    const Bp = this._B, tipC = this._tipC;
    let len = 0, px = Bp.x, py = Bp.y, pz = Bp.z;
    for (let i = 1; i <= 8; i++) {
      const u = i / 8, w = 1 - u;
      const a0 = w * w * w, a1 = 3 * w * w * u, a2 = 3 * w * u * u, a3 = u * u * u;
      const x = a0 * Bp.x + a1 * q[0] + a2 * q[3] + a3 * tipC.x;
      const y = a0 * Bp.y + a1 * q[1] + a2 * q[4] + a3 * tipC.y;
      const z = a0 * Bp.z + a1 * q[2] + a2 * q[5] + a3 * tipC.z;
      len += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
    }
    return len;
  }

  /** Keep unit `v` within maxSkew of side * Ys (rotating it toward Ys). */
  _clampSkew(v, Ys, right) {
    const ys = this._side;
    const sk = this._skew || RIG.maxSkew;
    const dy = v.dot(Ys);
    if (dy * ys >= Math.cos(sk)) return v;
    v.addScaledVector(Ys, -dy);
    if (v.lengthSq() < 1e-8) v.copy(right).addScaledVector(Ys, -right.dot(Ys));
    if (v.lengthSq() < 1e-8) return v.copy(Ys).multiplyScalar(ys);
    return v.normalize().multiplyScalar(Math.sin(sk)).addScaledVector(Ys, ys * Math.cos(sk));
  }

  /**
   * On high: 4 rays across the tip line (the centre is the contact point)
   * find the real surface where the nail curves away from the tangent
   * plane; points in between are interpolated.
   */
  _refineBands(nailMesh, raycaster) {
    const bp = this._bandDh;
    bp.fill(0);
    if (!nailMesh || !raycaster) return;
    const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
    const L = this.preset.length * scale;
    const N = this._N, X = this._X, P = this._P;
    const prevFar = raycaster.far;
    const prevNear = raycaster.near;
    raycaster.near = 0;
    raycaster.far = L * 0.5;
    const origin = this._t1, dir = this._t2;
    dir.copy(N).negate();
    const hits = this._hits;
    for (let k = 0; k < RAY_BANDS; k++) {
      if (k * 2 === RAY_BANDS - 1) continue; // the centre is the contact point: dh = 0
      const tx = k / (RAY_BANDS - 1) - 0.5;
      origin.copy(P).addScaledVector(X, tx * 2 * this._hw).addScaledVector(N, L * 0.2);
      raycaster.set(origin, dir);
      hits.length = 0;
      // Mesh.raycast does not sort its hits: take the nearest.
      nailMesh.raycast(raycaster, hits);
      let best = -1, bd = Infinity;
      for (let i = 0; i < hits.length; i++) if (hits[i].face && hits[i].distance < bd) { bd = hits[i].distance; best = i; }
      if (best >= 0) {
        const dh = (hits[best].point.x - P.x) * N.x + (hits[best].point.y - P.y) * N.y + (hits[best].point.z - P.z) * N.z;
        bp[k] = dh > 0 ? 0 : dh;
      }
      hits.length = 0;
    }
    raycaster.far = prevFar;
    raycaster.near = prevNear;
  }

  // ------------------------------------------------------------ shape ---

  /** Rest width (nail widths) of the bundle at s (0 root .. 1 tip). */
  _restW(s) {
    const pr = this.preset;
    if (s <= pr.belly) { const k = 1 - s / pr.belly; return pr.rootW + (pr.bellyW - pr.rootW) * (1 - k * k); }
    const w1 = pr.bellyW * 0.97;
    if (s <= pr.tipStart) return pr.bellyW + (w1 - pr.bellyW) * (s - pr.belly) / (pr.tipStart - pr.belly);
    return w1 + (pr.tipEndW - w1) * smooth01((s - pr.tipStart) / (1 - pr.tipStart));
  }

  /** Rest thickness: grows to the belly, then a wedge to a near edge at the tip. */
  _restT(s) {
    const pr = this.preset;
    if (s <= pr.belly) { const k = 1 - s / pr.belly; return pr.rootT + (pr.bellyT - pr.rootT) * (1 - k * k); }
    const t1 = pr.bellyT * 0.86;
    if (s <= pr.tipStart) return pr.bellyT + (t1 - pr.bellyT) * (s - pr.belly) / (pr.tipStart - pr.belly);
    const k = (s - pr.tipStart) / (1 - pr.tipStart);
    return t1 + (pr.tipT - t1) * Math.pow(k, 0.85);
  }

  /** Where the strand at section position (a, b) ends (centre bristles longest). */
  _sEnd(a, b) {
    const pr = this.preset;
    const e = pr.domeExp;
    const ax = Math.min(1, Math.abs(a));
    const dome = pr.dome * 0.5 * pr.tipEndW / pr.length * (1 - Math.pow(1 - Math.pow(ax, e), 1 / e));
    return 1 - dome * (1 - RIG.domePress * this._bend * this._c) - 0.03 * b * b;
  }

  /**
   * Centreline frames for this pose: a stiff straight body from the stem's
   * end, then a cubic bend to the tips; the section turns from the stem's
   * width axis to the band's; widths splay and flatten with the bend.
   */
  _buildFrames() {
    const pose = this.pose;
    const pr = this.preset;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const fr = this._fr;
    const Fc = this._Fc, Bp = this._B, Bt = this._Bt, tipC = this._tipC;
    const F = this._F, X = this._Xt;
    const sb = this._sbody;
    const c = this._c;
    const bend = this._bend < 0 ? 0 : this._bend > 1 ? 1 : this._bend;
    const foot = 2 * this._hw / scale;   // footprint width, nail widths
    // Bend handles (the belly of the bend lags behind the motion).
    const q = this._bendHandles(scale);
    const q1x = q[0], q1y = q[1], q1z = q[2], q2x = q[3], q2y = q[4], q2z = q[5];
    for (let f = 0; f < FRAMES; f++) {
      const s = f / (FRAMES - 1);
      let cx, cy, cz, tx, ty, tz;
      if (s <= sb) {
        const k = s / sb;
        cx = Fc.x + (Bp.x - Fc.x) * k; cy = Fc.y + (Bp.y - Fc.y) * k; cz = Fc.z + (Bp.z - Fc.z) * k;
        tx = Bt.x; ty = Bt.y; tz = Bt.z;
      } else {
        const u = (s - sb) / (1 - sb), w = 1 - u;
        const a0 = w * w * w, a1 = 3 * w * w * u, a2 = 3 * w * u * u, a3 = u * u * u;
        cx = a0 * Bp.x + a1 * q1x + a2 * q2x + a3 * tipC.x;
        cy = a0 * Bp.y + a1 * q1y + a2 * q2y + a3 * tipC.y;
        cz = a0 * Bp.z + a1 * q1z + a2 * q2z + a3 * tipC.z;
        const d0 = 3 * w * w, d1 = 6 * w * u, d2 = 3 * u * u;
        tx = d0 * (q1x - Bp.x) + d1 * (q2x - q1x) + d2 * (tipC.x - q2x);
        ty = d0 * (q1y - Bp.y) + d1 * (q2y - q1y) + d2 * (tipC.y - q2y);
        tz = d0 * (q1z - Bp.z) + d1 * (q2z - q1z) + d2 * (tipC.z - q2z);
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
      }
      // width axis: the stem's in the body, the band's at the tips
      const kx = smooth01((s - sb * 0.7) / (0.9 - sb * 0.7));
      let xx = F.x + (X.x - F.x) * kx, xy = F.y + (X.y - F.y) * kx, xz = F.z + (X.z - F.z) * kx;
      const xd = xx * tx + xy * ty + xz * tz;
      xx -= xd * tx; xy -= xd * ty; xz -= xd * tz;
      let xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl; xy /= xl; xz /= xl;
      // at the tips the section lines up with the band axis itself (a skewed
      // paddle), so the pressed tips span exactly the band
      const xt = X.x * tx + X.y * ty + X.z * tz;
      const kb = smooth01((s - 0.8) / 0.12) * smooth01((0.97 - Math.abs(xt)) / 0.2);
      if (kb > 0) {
        xx += (X.x - xx) * kb; xy += (X.y - xy) * kb; xz += (X.z - xz) * kb;
        xl = Math.hypot(xx, xy, xz) || 1;
        xx /= xl; xy /= xl; xz /= xl;
      }
      // thickness axis = X x t (= the stem's Fn at the root)
      let nx = xy * tz - xz * ty, ny = xz * tx - xx * tz, nz = xx * ty - xy * tx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // section sizes: rest, splayed to the footprint and flattened when pressed
      const rw = this._restW(s);
      const ks = smooth01((s - sb) / (RIG.splayEnd - sb));
      const wide = foot > rw ? foot - rw : 0;
      const hw = 0.5 * scale * (rw + wide * ks * c);
      const hd = 0.5 * scale * this._restT(s) * (1 - RIG.flatten * ks * bend);
      const o = f * FST;
      fr[o] = cx; fr[o + 1] = cy; fr[o + 2] = cz;
      fr[o + 3] = xx; fr[o + 4] = xy; fr[o + 5] = xz;
      fr[o + 6] = nx; fr[o + 7] = ny; fr[o + 8] = nz;
      fr[o + 9] = hw; fr[o + 10] = hd;
    }
  }

  /** Frame at s into this._fs (linear between samples). */
  _frameAt(s) {
    const fr = this._fr, out = this._fs;
    let f = s * (FRAMES - 1);
    if (f < 0) f = 0;
    let i = Math.floor(f);
    if (i > FRAMES - 2) i = FRAMES - 2;
    const t = f - i, o = i * FST;
    for (let k = 0; k < FST; k++) out[k] = fr[o + k] + (fr[o + FST + k] - fr[o + k]) * t;
    return out;
  }

  /**
   * One point of the bundle: section position (a, b) at s, clump factor j,
   * settled on the nail while touching. Writes xyz to out[o..o+2].
   */
  _point(a, b, s, j, out, o) {
    const q = this._frameAt(s);
    const ra = a * q[9] * j, rb = b * q[10] * j;
    let x = q[0] + q[3] * ra + q[6] * rb;
    let y = q[1] + q[4] * ra + q[7] * rb;
    let z = q[2] + q[5] * ra + q[8] * rb;
    const c = this._c;
    if (c > 0 && s > this._sbody * 0.5) {
      const N = this._N, P = this._P;
      const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
      const ks = smooth01((s - this._sbody) / (1 - this._sbody));
      // a light touch: dome edges outside the footprint stay up
      const over = Math.abs(ra) - this._hw;
      let lift = over > 0 ? over * RIG.edgeLift * ks * c : 0;
      // never under the nail's tangent plane ...
      const hgt = (x - P.x) * N.x + (y - P.y) * N.y + (z - P.z) * N.z;
      const floor = RIG.clearance * scale;
      if (hgt + lift < floor) lift = floor - hgt;
      // ... then down onto the real (curved) surface across the band
      if (this.collisionMode === 'plane+rays' && this._c > 0.5) {
        const bd = this._bandDh;
        let f = (this._hw > 0 ? ra / (2 * this._hw) + 0.5 : 0.5) * (RAY_BANDS - 1);
        if (f < 0) f = 0; else if (f > RAY_BANDS - 1) f = RAY_BANDS - 1;
        const k0 = f >= RAY_BANDS - 1 ? RAY_BANDS - 2 : Math.floor(f);
        lift += (bd[k0] + (bd[k0 + 1] - bd[k0]) * (f - k0)) * ks * c;
      }
      x += N.x * lift; y += N.y * lift; z += N.z * lift;
    }
    out[o] = x; out[o + 1] = y; out[o + 2] = z;
  }

  /** Lay the skeleton strands, the bundle loft and the loose strands from the solved frame. */
  updateGeometry() {
    this._buildFrames();
    const n = this.bristleCount;
    const jp = this.jointPositions;
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;

    // Skeleton strands (contacts, tip centroid, harness).
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const a = this._sa[i], b = this._sb[i];
      const se = this._sEnd(a, b);
      const o = i * JOINTS * 3;
      for (let j = 0; j < JOINTS; j++) this._point(a, b, se * j / SEGMENTS, 1, jp, o + j * 3);
      const tip = o + SEGMENTS * 3;
      cx += jp[tip]; cy += jp[tip + 1]; cz += jp[tip + 2];
    }
    if (n > 0) {
      cx /= n; cy /= n; cz /= n;
      // Touching, the tips' centroid is the paint point: the dome trails the
      // edge tips back, so slide the whole brush along the nail to centre them.
      const c = this._c;
      if (c > 0) {
        const N = this._N, tc = this._tipC;
        let dx = cx - tc.x, dy = cy - tc.y, dz = cz - tc.z;
        const dn = dx * N.x + dy * N.y + dz * N.z;
        dx = (dx - dn * N.x) * c; dy = (dy - dn * N.y) * c; dz = (dz - dn * N.z) * c;
        for (let k = 0; k < n * JOINTS * 3; k += 3) { jp[k] -= dx; jp[k + 1] -= dy; jp[k + 2] -= dz; }
        const fr = this._fr;
        for (let f = 0; f < FRAMES; f++) { fr[f * FST] -= dx; fr[f * FST + 1] -= dy; fr[f * FST + 2] -= dz; }
        this._Fc.x -= dx; this._Fc.y -= dy; this._Fc.z -= dz;
        this._B.x -= dx; this._B.y -= dy; this._B.z -= dz;
        tc.x -= dx; tc.y -= dy; tc.z -= dz;
        cx -= dx; cy -= dy; cz -= dz;
      }
      this.tipCenter.set(cx, cy, cz);
    }

    // Loft: sections denser toward the tip, each line ending at its own
    // dome length; the clump loosens (lumpier) as the brush dries.
    const pos = this._positionAttr.array;
    const nor = this._normalAttr.array;
    const tan = this._tanAttr.array;
    const st = this._stAttr.array;
    const lump = 0.015 + 0.11 * this._dry;
    const rc = this._ringC;
    for (let r = 0; r < RINGS; r++) {
      const u = r / (RINGS - 1);
      const sr = 1 - Math.pow(1 - u, 1.35);
      let mx = 0, my = 0, mz = 0;
      for (let k = 0; k < COLS; k++) {
        const a = this._ca[k], b = this._cb[k];
        const v = r * COLS + k;
        const s = sr * this._sEnd(a, b) - (r === RINGS - 1 ? 0.012 * (this._vj[v] + 0.5) : 0);
        this._point(a, b, s, 1 + lump * this._vj[v] * (0.3 + 0.7 * u), pos, v * 3);
        st[v * 2] = k / AROUND; st[v * 2 + 1] = s;
        if (k < AROUND) { mx += pos[v * 3]; my += pos[v * 3 + 1]; mz += pos[v * 3 + 2]; }
      }
      rc[r * 3] = mx / AROUND; rc[r * 3 + 1] = my / AROUND; rc[r * 3 + 2] = mz / AROUND;
    }
    const tipV = RINGS * COLS;
    this._point(0, 0, 1, 1, pos, tipV * 3);
    st[tipV * 2] = 0.5; st[tipV * 2 + 1] = 1;
    // Normals (finite differences, consistent with the winding) and the
    // bristle direction for the hair highlight.
    for (let r = 0; r < RINGS; r++) {
      const rp = r > 0 ? r - 1 : 0;
      for (let k = 0; k < COLS; k++) {
        const v = r * COLS + k;
        const kp = (k + AROUND - 1) % AROUND, kn = (k + 1) % AROUND;
        const a0 = (r * COLS + kp) * 3, a1 = (r * COLS + kn) * 3;
        const dkx = pos[a1] - pos[a0], dky = pos[a1 + 1] - pos[a0 + 1], dkz = pos[a1 + 2] - pos[a0 + 2];
        const b0 = (rp * COLS + k) * 3, b1 = (r < RINGS - 1 ? (r + 1) * COLS + k : tipV) * 3;
        let drx = pos[b1] - pos[b0], dry = pos[b1 + 1] - pos[b0 + 1], drz = pos[b1 + 2] - pos[b0 + 2];
        let nx = dry * dkz - drz * dky, ny = drz * dkx - drx * dkz, nz = drx * dky - dry * dkx;
        const nl = Math.hypot(nx, ny, nz);
        const o = v * 3;
        if (nl > 1e-12) { nx /= nl; ny /= nl; nz /= nl; } else {
          nx = pos[o] - rc[r * 3]; ny = pos[o + 1] - rc[r * 3 + 1]; nz = pos[o + 2] - rc[r * 3 + 2];
          const l2 = Math.hypot(nx, ny, nz) || 1; nx /= l2; ny /= l2; nz /= l2;
        }
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
        const dl = Math.hypot(drx, dry, drz) || 1;
        tan[o] = drx / dl; tan[o + 1] = dry / dl; tan[o + 2] = drz / dl;
      }
    }
    const tT = this._tT;
    nor[tipV * 3] = tT.x; nor[tipV * 3 + 1] = tT.y; nor[tipV * 3 + 2] = tT.z;
    tan[tipV * 3] = tT.x; tan[tipV * 3 + 1] = tT.y; tan[tipV * 3 + 2] = tT.z;

    // Loose strands: a few at the edges, flying further apart as it dries.
    const lp = this._lp;
    const sep = (0.006 + 0.05 * this._dry) * scale;
    const lw = RIG.looseW * scale * Math.min(2, this.radiusScale);
    for (let l = 0; l < this._loose; l++) {
      const a = this._la[l], b = this._lb[l] > 1 ? 1 : this._lb[l] < -1 ? -1 : this._lb[l];
      const se = this._sEnd(a, b) * (0.96 + 0.04 * this._lj[l]);
      const s0 = 0.28;
      for (let j = 0; j <= LOOSE_SEG; j++) {
        const s = s0 + (se - s0) * j / LOOSE_SEG;
        this._point(a, b, s, 1, lp, j * 3);
        const q = this._frameAt(s);
        const g = Math.pow((s - s0) / (1 - s0), 1.5) * sep * (0.5 + this._lj[l]);
        const sa = a > 0 ? 1 : -1;
        lp[j * 3] += (q[3] * sa + q[6] * b * 0.4) * g;
        lp[j * 3 + 1] += (q[4] * sa + q[7] * b * 0.4) * g;
        lp[j * 3 + 2] += (q[5] * sa + q[8] * b * 0.4) * g;
      }
      for (let s = 0; s < LOOSE_SEG; s++) {
        const quad = l * LOOSE_SEG + s;
        const w = lw * (1 - 0.5 * s / LOOSE_SEG);
        this._ribbon(lp, s * 3, s * 3 + 3, quad, w, w * 0.85, (s + 0.5) / LOOSE_SEG, pos, nor, tan, st, 0.37 * l + 0.1);
      }
    }

    this._positionAttr.needsUpdate = true;
    this._normalAttr.needsUpdate = true;
    this._tanAttr.needsUpdate = true;
    this._stAttr.needsUpdate = true;
    const uni = this._uni;
    uni.uWet.value = 1 - 0.8 * this._dry;
    uni.uGroove.value = 0.18 + 0.5 * this._dry;
    this._needsMatrices = false;
    this.updateBead();
    this._placeHandle();
    this._placeBlob();
  }

  /** One flat ribbon quad from joint a to joint b (a loose strand). */
  _ribbon(jp, a, b, quad, wa, wb, t, pos, nor, tan, st, u) {
    const ax = jp[a], ay = jp[a + 1], az = jp[a + 2];
    const bx = jp[b], by = jp[b + 1], bz = jp[b + 2];
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // width direction: the stem's at the root, the band's at the tip
    const F = this._F, X = this._Xt;
    let wx = F.x + (X.x - F.x) * t, wy = F.y + (X.y - F.y) * t, wz = F.z + (X.z - F.z) * t;
    const wd = wx * dx + wy * dy + wz * dz;
    wx -= wd * dx; wy -= wd * dy; wz -= wd * dz;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    let nx = dy * wz - dz * wy, ny = dz * wx - dx * wz, nz = dx * wy - dy * wx;
    // wound to face the camera (the head is drawn front faces only)
    const tc = this._toCam;
    if (nx * tc.x + ny * tc.y + nz * tc.z < 0) { wx = -wx; wy = -wy; wz = -wz; nx = -nx; ny = -ny; nz = -nz; }
    const v0 = LOFT_VERTS + quad * 4;
    const o = v0 * 3;
    pos[o] = ax + wx * wa; pos[o + 1] = ay + wy * wa; pos[o + 2] = az + wz * wa;
    pos[o + 3] = ax - wx * wa; pos[o + 4] = ay - wy * wa; pos[o + 5] = az - wz * wa;
    pos[o + 6] = bx + wx * wb; pos[o + 7] = by + wy * wb; pos[o + 8] = bz + wz * wb;
    pos[o + 9] = bx - wx * wb; pos[o + 10] = by - wy * wb; pos[o + 11] = bz - wz * wb;
    const s0 = t - 0.5 / LOOSE_SEG, s1 = t + 0.5 / LOOSE_SEG;
    for (let v = 0; v < 4; v++) {
      nor[o + v * 3] = nx; nor[o + v * 3 + 1] = ny; nor[o + v * 3 + 2] = nz;
      tan[o + v * 3] = dx; tan[o + v * 3 + 1] = dy; tan[o + v * 3 + 2] = dz;
      st[(v0 + v) * 2] = u;
      st[(v0 + v) * 2 + 1] = 0.3 + 0.7 * (v < 2 ? s0 : s1);
    }
  }

  /** Stem and cap: from the bundle's root centre, along the handle direction. */
  _placeHandle() {
    const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
    const F = this._F, A = this._A, Fn = this._Fn, Fc = this._Fc;
    this.handle.matrix.set(
      F.x * scale, A.x * scale, Fn.x * scale, Fc.x,
      F.y * scale, A.y * scale, Fn.y * scale, Fc.y,
      F.z * scale, A.z * scale, Fn.z * scale, Fc.z,
      0, 0, 0, 1,
    );
    this.handle.matrixWorldNeedsUpdate = true;
  }

  /** Landing blob under the hovering tips. */
  _placeBlob() {
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const show = pose.onSurface ? 1 - this._c : 0;
    const mat = this.blob.material;
    mat.opacity = 0.5 * show;
    // No draw while painting; kept in the scene until its program is warm.
    this.blob.visible = show > 0.002 || !this._warmed;
    const r = this._hw * 1.15;
    const X = this._X, Y = this._Y, N = this._N, P = this._P;
    const lift = 0.0015 * scale;
    this.blob.matrix.set(
      X.x * r, Y.x * r * 0.55, N.x * r, P.x + N.x * lift,
      X.y * r, Y.y * r * 0.55, N.y * r, P.y + N.y * lift,
      X.z * r, Y.z * r * 0.55, N.z * r, P.z + N.z * lift,
      0, 0, 0, 1,
    );
    this.blob.matrixWorldNeedsUpdate = true;
  }

  /**
   * Bead at the tip, sized by load: hovering, it hangs on the nail-facing
   * side just behind the tip edge (the brush is wiped on its other side);
   * touching, it is squashed into the paint and pushed to the trailing side.
   */
  updateBead() {
    const bead = this.bead;
    if (!bead) return;
    const load = this.load;
    if (load < 0.05) {
      bead.visible = false;
      return;
    }
    // On the nail the polish is in the film (its landing / pooling relief):
    // the drop is gone at contact.
    const c = this._c;
    const k = 1 - c;
    if (k < 0.02) {
      bead.visible = false;
      return;
    }
    bead.visible = true;
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const r = RIG.beadRadius * scale * (0.4 + 0.6 * load) * k;
    const wide = r;
    const tall = r * 0.5;
    const N = this._N, X = this._X, Y = this._Y, tT = this._tT;
    const q = this._frameAt(0.95);
    // tucked under the tip's leading face (the nail-facing side; the brush
    // is wiped on the other one)
    const side = q[6] * N.x + q[7] * N.y + q[8] * N.z > 0 ? -1 : 1;
    const hang = q[10] + tall * 0.6;
    const px = q[0] + q[6] * side * hang + tT.x * r * 0.3;
    const py = q[1] + q[7] * side * hang + tT.y * r * 0.3;
    const pz = q[2] + q[8] * side * hang + tT.z * r * 0.3;
    bead.matrix.set(
      X.x * wide, N.x * tall, Y.x * wide * 0.9, px,
      X.y * wide, N.y * tall, Y.y * wide * 0.9, py,
      X.z * wide, N.z * tall, Y.z * wide * 0.9, pz,
      0, 0, 0, 1,
    );
    bead.matrixWorldNeedsUpdate = true;
  }

  /** 0..1 how much polish the brush holds (bead size, clump). */
  setLoad(load) {
    const l = load < 0 ? 0 : load > 1 ? 1 : load;
    if (Math.abs(l - this.load) < 0.002) return false;
    this.load = l;
    this.pose.load = l;
    this._dirty = true;
    this.updateBead();
    return true;
  }

  /** Legacy name. */
  updateInstanceMatrices() {
    this.updateGeometry();
  }

  setColor(color) {
    this.color.set(color);
    this._writeColors();
    const b = this.bead && this.bead.material;
    if (b) {
      b.color.copy(this.color);
      b.emissive.copy(this.color);
    }
  }

  /** True when update() would do nothing. */
  isAtRest() {
    return !this._dirty && this.energy < PHYSICS_CONFIG.restEnergy && !this._needsMatrices && this._c === 0;
  }

  /**
   * Harness: the rendered head's shape now, in nail widths (allocation free
   * when `out` is reused). length = centreline arc; width / thickness = the
   * widest section's extents along its own axes; dome = how much longer the
   * centre bristles are than the edge ones; footprint = pressed tip span.
   */
  measureShape(out = {}) {
    const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
    const fr = this._fr;
    let len = 0;
    for (let f = 1; f < FRAMES; f++) {
      const o = f * FST, p = o - FST;
      len += Math.hypot(fr[o] - fr[p], fr[o + 1] - fr[p + 1], fr[o + 2] - fr[p + 2]);
    }
    const pos = this._positionAttr.array;
    let bw = 0, bt = 0, bs = 0;
    for (let r = 0; r < RINGS; r++) {
      const s = 1 - Math.pow(1 - r / (RINGS - 1), 1.35);
      const q = this._frameAt(s);
      let w0 = Infinity, w1 = -Infinity, t0 = Infinity, t1 = -Infinity;
      for (let k = 0; k < AROUND; k++) {
        const o = (r * COLS + k) * 3;
        const dx = pos[o] - q[0], dy = pos[o + 1] - q[1], dz = pos[o + 2] - q[2];
        const w = dx * q[3] + dy * q[4] + dz * q[5];
        const t = dx * q[6] + dy * q[7] + dz * q[8];
        if (w < w0) w0 = w; if (w > w1) w1 = w;
        if (t < t0) t0 = t; if (t > t1) t1 = t;
      }
      if (w1 - w0 > bw) { bw = w1 - w0; bt = t1 - t0; bs = s; }
    }
    // dome: centre tip vs the outer-ring tips, along the tip direction
    const jp = this.jointPositions, tT = this._tT;
    const tipV = RINGS * COLS * 3;
    let edge = 0, ne = 0, foot0 = Infinity, foot1 = -Infinity;
    const X = this._X;
    for (let i = 0; i < this.bristleCount; i++) {
      const k = (i * JOINTS + SEGMENTS) * 3;
      const lat = (jp[k] - pos[tipV]) * X.x + (jp[k + 1] - pos[tipV + 1]) * X.y + (jp[k + 2] - pos[tipV + 2]) * X.z;
      if (lat < foot0) foot0 = lat; if (lat > foot1) foot1 = lat;
      if (Math.abs(this._sa[i]) > 0.95) {
        edge += (pos[tipV] - jp[k]) * tT.x + (pos[tipV + 1] - jp[k + 1]) * tT.y + (pos[tipV + 2] - jp[k + 2]) * tT.z;
        ne++;
      }
    }
    out.preset = this.preset.name;
    out.length = len / scale;
    out.width = bw / scale;
    out.thickness = bt / scale;
    out.thickOverWidth = bw > 0 ? bt / bw : 0;
    out.widestAt = bs;
    out.dome = ne ? edge / ne / scale : 0;
    out.tipSpan = (foot1 - foot0) / scale;
    out.footprint = 2 * this._hw / scale;
    out.bend = this._bend;
    out.contact = this._c;
    out.dry = this._dry;
    return out;
  }

  /**
   * Full update. Returns the contact count (contacts in `contactPoints`).
   * @param {number} deltaTime seconds (already clamped by the loop)
   * @param {THREE.Mesh} nailMesh
   * @param {THREE.Raycaster} raycaster
   * @returns {number}
   */
  update(deltaTime, nailMesh, raycaster) {
    if (this.isAtRest()) {
      this.contactCount = 0;
      return 0;
    }
    const dt = deltaTime > 0 ? Math.min(deltaTime, 0.1) : 0;
    if (this._legacy) this._legacyPose(dt, nailMesh);
    else this._nailMetrics(nailMesh);
    this._solve(dt);
    if (this.collisionMode === 'plane+rays' && this.pose.contact) this._refineBands(nailMesh, raycaster);
    this.updateGeometry();
    this._dirty = false;

    // Contacts: the tips, while touching.
    this.contactCount = 0;
    if (this.pose.contact) {
      const jp = this.jointPositions;
      const N = this._N;
      const pr = Math.max(0.15, this.pose.pressure);
      for (let i = 0; i < this.bristleCount; i++) {
        const k = (i * JOINTS + SEGMENTS) * 3;
        const cp = this.contactPoints[this.contactCount++];
        cp.position.set(jp[k], jp[k + 1], jp[k + 2]);
        cp.normal.copy(N);
        cp.pressure = pr;
        cp.bristleIndex = i;
      }
    }
    return this.contactCount;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    for (const m of [this.mesh, this.bead, this.handle, this.blob]) {
      if (m) {
        m.geometry.dispose();
        m.material.dispose();
      }
    }
  }
}
