/**
 * BristleSystem.js
 * The polish brush rig: a flat brush whose bristle tips sit on the paint
 * point, that leans, turns across the stroke, fans into a paddle as wide as
 * the paint band and drags behind the motion.
 *
 * Driven by a pose (shared contract, docs/upgrade/brush-plan.md 4.4):
 *
 *   bristles.setPose(pose)   // reused object, copied, fields:
 *     point, normal          // world contact point on the nail, surface normal
 *     axis                   // world unit vector, brush width direction (tangent plane)
 *     velocity               // world tangent-plane velocity of the contact point (units/s)
 *     halfWidth              // world half width of the paint band (tips span exactly this)
 *     pressure, load         // 0..1
 *     contact                // touching the nail (false = hovering above `point`)
 *     isTouch                // more upright brush so it clears a finger
 *     scale                  // active nail width in world units
 *     onSurface (optional)   // false when `point` is not on the nail (no landing blob)
 *   bristles.update(dt, nailMesh, raycaster) -> contact count
 *   bristles.tipCenter       // world centroid of the tip line (read only)
 *
 * The old calls (`setBrushTransform`, `setSurface`, `pressure`,
 * `isContacting`) still work: they fill the pose internally (velocity,
 * axis spring and band width are derived here until the stroke engine
 * sends them).
 *
 * Bristles are analytic: each one is a quadratic curve from its root on the
 * ferrule to its tip on the surface, sampled into ONE merged ribbon mesh (one
 * draw call). No Verlet chains: the drag, the reversal flip and the lift
 * wobble come from a small spring on a 2-D "trail" vector, so the cost is a
 * few float ops per bristle and nothing is allocated per frame.
 *
 * Draw calls: bristles (strands + wet core strip) 1, bead 1, handle 1,
 * landing blob 1. Bristles, bead and handle share one program
 * (Phong + vertex colours, double sided).
 */
import * as THREE from 'three';

const MAX_BRISTLES = 128;
const JOINTS = 5;
const SEGMENTS = JOINTS - 1;
const CORE_QUADS = SEGMENTS;     // the flat wet core strip under the strands
const RAY_BANDS = 8;
const DEG = Math.PI / 180;

// Sizes are fractions of the active nail's width (`scale`), so the brush
// feels the same on a thumb and a pinky.
const RIG = Object.freeze({
  length: 0.55,            // bristle length L
  restWidth: 0.21,         // tip line width at rest
  ferruleWidth: 0.15,      // bundle width where it leaves the ferrule
  ferruleDepth: 0.03,      // bundle thickness at the ferrule
  clearance: 0.004,        // tips this far above the tangent plane (no z-fight)
  hoverLift: 0.25,         // x L: tips above the point while hovering
  viewBlend: 0.65,         // handle "up" = this much view direction + the rest surface normal
  tiltMouse: 55 * DEG,     // handle angle from that up: low, so the bristles show their length
  tiltTouch: 42 * DEG,     // more upright: clears the finger
  minAN: 0.3,              // handle never closer than ~73 deg to the surface normal
  leanRight: 15 * DEG,     // handle turned from screen-up toward screen-right
  leanTrail: 0.35,         // ... and pulled behind the motion by up to this
  leanFloor: 0.2,          // never below the screen horizon (finger side)
  maxSkew: 40 * DEG,       // max angle between the lean and the across-band direction
  rightBias: 0.3,          // edge-on strokes put the handle on the screen-right side
  pressDrop: 0.3,          // ferrule comes down by this x L at full pressure
  minHeight: 0.28,         // x L: ferrule never lower than this
  trailMax: 0.3,           // x L: tips trail the ferrule by up to this
  trailLag: 0.4,           // x L: the curve's belly lags further
  trailSpeed: 1.0,         // nail widths / s that saturate the drag
  trailOmega: 34,          // critically damped, ~60 ms
  wobbleOmega: 2 * Math.PI * 8,
  wobbleZeta: 0.2,         // ~2 visible cycles
  wobbleTime: 0.4,
  leanOmega: 9,            // slow: the hand re-aims, the bristles flip
  axisOmega: 32,           // legacy driver only (the engine sends its own axis)
  widthOmega: 26,          // fan closing after a lift
  liftOmega: 40,           // tips leaving the surface after a lift
  dirStep: 0.02,           // legacy: nail widths of travel per direction update
  beadRadius: 0.042,
  fanOpen: 0.45,           // belly already this far out toward its tip's place in the fan
  rowSpread: 0.35,         // x half width: rows of tips spread along the stroke while pressed
});

const PHYSICS_CONFIG = Object.freeze({
  springStep: 1 / 240,
  maxSubsteps: 12,
  restEnergy: 1e-7,
});

// Wet look: per-strand shade (+/-18%), darker / more saturated toward the
// tip where the polish sits, lighter and drier at the ferrule.
const SHADE = Object.freeze({ strand: 0.18, tipDark: 0.62, tipSat: 1.3, ferruleLight: 0.12, core: 0.5 });

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

export class BristleSystem {
  constructor(bristleCount = MAX_BRISTLES) {
    this.maxBristles = MAX_BRISTLES;
    this.jointsPerBristle = JOINTS;
    this.segmentsPerBristle = SEGMENTS;
    this.group = new THREE.Group();
    this.group.name = 'BristleSystem';

    // World-space joints of every bristle (the group stays at the origin).
    this.jointPositions = new Float32Array(MAX_BRISTLES * JOINTS * 3);
    // Layout (per bristle, set by initializePhysics()).
    this._ux = new Float32Array(MAX_BRISTLES);    // tip across the band, -0.5..0.5
    this._uy = new Float32Array(MAX_BRISTLES);    // row, -0.5..0.5
    this._rx = new Float32Array(MAX_BRISTLES);    // root across the ferrule
    this._ry = new Float32Array(MAX_BRISTLES);    // root through the bundle
    this._bend = new Float32Array(MAX_BRISTLES);  // stiffness variety
    this._twist = new Float32Array(MAX_BRISTLES); // normal twist: strands catch light differently
    this._shade = new Float32Array(MAX_BRISTLES);
    this._tipJ = new Float32Array(MAX_BRISTLES);  // tip along-stroke irregularity
    this._bandDh = new Float32Array(RAY_BANDS);   // height of the real surface under each band
    this._cols = 1;

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
    this._lean = new THREE.Vector3();
    this._leanVel = new THREE.Vector3();
    this._leanInit = false;
    this._side = 1;
    this._hw = DEFAULT_SCALE * RIG.restWidth * 0.5;
    this._c = 0;                // contact blend 1 = on the surface
    this._wasContact = false;
    this._wobble = 0;           // seconds of lift wobble left
    this._tilt = RIG.tiltMouse;

    // Frame of the current pose (scratch, reused)
    this._P = new THREE.Vector3();
    this._N = new THREE.Vector3(0, 1, 0);
    this._X = new THREE.Vector3(1, 0, 0);
    this._Y = new THREE.Vector3(0, 0, 1);
    this._A = new THREE.Vector3(0, 1, 0);   // handle direction
    this._U = new THREE.Vector3(0, 1, 0);   // handle 'up' (view/normal blend)
    this._F = new THREE.Vector3(1, 0, 0);   // ferrule width direction
    this._Fn = new THREE.Vector3(0, 0, 1);  // ferrule thickness direction
    this._Fc = new THREE.Vector3();         // ferrule centre
    this._T = new THREE.Vector3();          // trail in the tangent plane
    this._tipC = new THREE.Vector3();
    this._toCam = new THREE.Vector3(0, 1, 0);
    this._t0 = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._hits = [];
    this._rowSide = 0;
    this._coreJ = new Float32Array(JOINTS * 3 * 2);
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
    this.createGeometry();
    this.initializePhysics();
  }

  // ------------------------------------------------------------ meshes --

  createGeometry() {
    const quads = CORE_QUADS + MAX_BRISTLES * SEGMENTS;
    const positions = new Float32Array(quads * 4 * 3);
    const normals = new Float32Array(quads * 4 * 3);
    const colors = new Float32Array(quads * 4 * 3);
    const index = new Uint16Array(quads * 6);
    for (let k = 0; k < quads; k++) {
      const v = k * 4;
      const o = k * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v + 2; index[o + 4] = v + 1; index[o + 5] = v + 3;
    }
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;

    const geometry = new THREE.BufferGeometry();
    this._positionAttr = new THREE.BufferAttribute(positions, 3);
    this._positionAttr.setUsage(THREE.DynamicDrawUsage);
    this._normalAttr = new THREE.BufferAttribute(normals, 3);
    this._normalAttr.setUsage(THREE.DynamicDrawUsage);
    this._colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('position', this._positionAttr);
    geometry.setAttribute('normal', this._normalAttr);
    geometry.setAttribute('color', this._colorAttr);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, (CORE_QUADS + this.bristleCount * SEGMENTS) * 6);
    // Vertices are rewritten in world space every moving frame: a fixed
    // bounding sphere would be wrong, and the mesh is never culled anyway.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    // Polish colour lives in the vertex colours (ramp + per-strand shade),
    // so the material colour is white.
    const material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x000000,
      emissiveIntensity: 1,
      specular: 0x8c8c8c,
      shininess: 80,
      vertexColors: true,
      side: THREE.DoubleSide,
    });

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
    // as the bristles (Phong + vertex colours, double sided).
    const beadMaterial = new THREE.MeshPhongMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 0.12,
      specular: 0xffffff,
      shininess: 120,
      vertexColors: true,
      side: THREE.DoubleSide,
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

  /**
   * Flat oval ferrule -> thin stem -> purple cap, one merged mesh in units
   * of the bristle length (the matrix scales it), +Y along the handle,
   * +X across the ferrule. Vertex coloured, same program as the bristles.
   */
  createBrushHandle() {
    const parts = [];
    const add = (geo, color, sx, sz) => {
      geo.scale(sx, 1, sz);
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      const c = new THREE.Color(color);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(geo);
    };
    const ferruleW = RIG.ferruleWidth / RIG.length;   // in units of L
    // Ferrule: flat oval sleeve hugging the bundle.
    const ferrule = new THREE.CylinderGeometry(0.5, 0.42, 0.16, 20, 1, false);
    ferrule.translate(0, 0.08 - 0.02, 0);
    add(ferrule, 0x3d1f5c, ferruleW * 1.12, 0.16);
    // Stem: thin pearly rod.
    const stem = new THREE.CylinderGeometry(0.03, 0.04, 0.9, 10, 1, true);
    stem.translate(0, 0.14 + 0.45, 0);
    add(stem, 0xe9e2f2, 1, 1);
    // Cap: the purple bottle cap the hand holds.
    const capNeck = new THREE.CylinderGeometry(0.12, 0.08, 0.08, 18, 1, false);
    capNeck.translate(0, 1.04 + 0.04, 0);
    add(capNeck, 0x4a2270, 1, 1);
    const cap = new THREE.CylinderGeometry(0.13, 0.135, 0.85, 18, 1, false);
    cap.translate(0, 1.12 + 0.425, 0);
    add(cap, 0x5a2a82, 1, 1);
    const top = new THREE.SphereGeometry(0.13, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    top.translate(0, 1.97, 0);
    add(top, 0x5a2a82, 1, 1);

    // Merge (indexed).
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
    geometry.computeVertexNormals();

    const handleMaterial = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x140a1e,
      emissiveIntensity: 1,
      specular: 0xffffff,
      shininess: 80,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.handle = new THREE.Mesh(geometry, handleMaterial);
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
    // Always "visible" (opacity 0 when unused) so its program is compiled
    // with the scene at load, never mid-stroke.
    this.group.add(this.blob);
  }

  /** Compile this rig's programs now (optional; also done once at idle). */
  prewarm(renderer, camera, scene = null) {
    this._warmed = true;
    try {
      const was = this.group.visible;
      this.group.visible = true;
      renderer.compile(this.group, camera, scene || this.group.parent || undefined);
      this.group.visible = was;
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

  /** Set the camera used to lean the handle toward screen-up. */
  setCamera(camera) {
    this.camera = camera;
    this._cameraSet = !!camera;
  }

  /**
   * Change bristle count / radius / spring budget (tier change).
   */
  configure({ bristles = this.bristleCount, radiusScale = this.radiusScale, substeps = this.physicsSubstepsMax, collision = this.collisionMode } = {}) {
    this.physicsSubstepsMax = Math.max(1, substeps | 0);
    this.collisionMode = collision;
    const count = Math.max(8, Math.min(MAX_BRISTLES, bristles | 0));
    if (count !== this.bristleCount || radiusScale !== this.radiusScale) {
      this.bristleCount = count;
      this.radiusScale = radiusScale;
      this.mesh.geometry.setDrawRange(0, (CORE_QUADS + count * SEGMENTS) * 6);
      this.initializePhysics();
    }
  }

  /**
   * Lay the bristles out: rows of columns, odd rows staggered by half a
   * column so neighbouring rows fill each other's gaps. All tips end on one
   * straight line (squared-off tip) spanning exactly -0.5..0.5.
   */
  initializePhysics() {
    const n = this.bristleCount;
    const rows = n >= 96 ? 6 : n >= 48 ? 4 : 2;
    const cols = Math.ceil(n / rows);
    this._cols = cols;
    const ux = this._ux, uy = this._uy;
    let b = 0;
    let lo = Infinity, hi = -Infinity;
    for (let row = 0; row < rows && b < n; row++) {
      for (let col = 0; col < cols && b < n; col++) {
        const stagger = row % 2 ? 0.75 : 0.25;
        const tx = (col + stagger) / cols - 0.5 + jitter(b, 1) * 0.3 / cols;
        const ty = rows > 1 ? row / (rows - 1) - 0.5 : 0;
        ux[b] = tx;
        uy[b] = ty + jitter(b, 2) * 0.2 / rows;
        this._rx[b] = tx + jitter(b, 3) * 0.2 / cols;
        this._ry[b] = ty;
        this._bend[b] = 1 + jitter(b, 4) * 0.24;
        this._twist[b] = jitter(b, 5) * 0.7;
        this._shade[b] = 1 + jitter(b, 6) * 2 * SHADE.strand;
        this._tipJ[b] = jitter(b, 7);
        if (tx < lo) lo = tx;
        if (tx > hi) hi = tx;
        b++;
      }
    }
    // Exact span and zero mean across the band: the fan is the band.
    const span = hi - lo > 1e-6 ? hi - lo : 1;
    let mean = 0;
    for (let i = 0; i < n; i++) { ux[i] = (ux[i] - lo) / span - 0.5; mean += ux[i]; }
    mean /= n;
    let ymean = 0;
    for (let i = 0; i < n; i++) ymean += uy[i];
    ymean /= n;
    for (let i = 0; i < n; i++) { ux[i] -= mean; uy[i] -= ymean; }
    this.energy = 0;
    this._needsMatrices = true;
    this._dirty = true;
    this._writeColors();
    this.updateGeometry();
  }

  /** Vertex colours: wet ramp x per-strand shade (rewritten on colour / layout change only). */
  _writeColors() {
    const col = this._colorAttr.array;
    const c = this.color;
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    // tip: darker, more saturated; ferrule: lighter, drier
    const tr = Math.max(0, lum + (c.r - lum) * SHADE.tipSat) * SHADE.tipDark;
    const tg = Math.max(0, lum + (c.g - lum) * SHADE.tipSat) * SHADE.tipDark;
    const tb = Math.max(0, lum + (c.b - lum) * SHADE.tipSat) * SHADE.tipDark;
    const fl = SHADE.ferruleLight;
    const fr = c.r + (1 - c.r) * fl, fg = c.g + (1 - c.g) * fl, fb = c.b + (1 - c.b) * fl;
    const ramp = (t) => smooth01((t - 0.1) / 0.9);
    // Core strip (first CORE_QUADS quads): dark wet polish.
    for (let s = 0; s < CORE_QUADS; s++) {
      for (let v = 0; v < 4; v++) {
        const t = (s + (v < 2 ? 0 : 1)) / SEGMENTS;
        const k = ramp(t);
        const o = (s * 4 + v) * 3;
        col[o] = (fr + (tr - fr) * k) * SHADE.core;
        col[o + 1] = (fg + (tg - fg) * k) * SHADE.core;
        col[o + 2] = (fb + (tb - fb) * k) * SHADE.core;
      }
    }
    for (let i = 0; i < this.bristleCount; i++) {
      const sh = this._shade[i];
      for (let s = 0; s < SEGMENTS; s++) {
        for (let v = 0; v < 4; v++) {
          const t = (s + (v < 2 ? 0 : 1)) / SEGMENTS;
          const k = ramp(t);
          const o = ((CORE_QUADS + i * SEGMENTS + s) * 4 + v) * 3;
          col[o] = (fr + (tr - fr) * k) * sh;
          col[o + 1] = (fg + (tg - fg) * k) * sh;
          col[o + 2] = (fb + (tb - fb) * k) * sh;
        }
      }
    }
    this._colorAttr.needsUpdate = true;
    const m = this.mesh.material;
    m.emissive.setRGB(c.r * 0.07, c.g * 0.07, c.b * 0.07);
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
    p.halfWidth = pose.halfWidth > 0 ? pose.halfWidth : 0.5 * p.scale * (0.20 + 0.14 * p.pressure);
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
    p.halfWidth = 0.5 * p.scale * (0.20 + 0.14 * p.pressure);
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

  // ------------------------------------------------------------- rig ----

  /** Advance springs and solve the frame for this pose. Returns motion energy. */
  _solve(dt) {
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const L = RIG.length * scale;
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
    if (this._wasContact && !contact) this._wobble = RIG.wobbleTime;
    this._wasContact = contact;
    if (this._wobble > 0) this._wobble = Math.max(0, this._wobble - dt);

    const p = contact ? pose.pressure : 0;

    // Trail: follows -velocity (direction, saturating magnitude).
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
    if (contact || this._wobble <= 0) this._springVec(tr, this._trailVel, v, RIG.trailOmega, 1, dt);
    else this._springVec(tr, this._trailVel, v, RIG.wobbleOmega, RIG.wobbleZeta, dt);
    const T = this._T.copy(tr);
    T.addScaledVector(N, -T.dot(N));
    let energy = (tr.x - trX) ** 2 + (tr.y - trY) ** 2 + (tr.z - trZ) ** 2 + this._trailVel.lengthSq() * 1e-4;

    // Fan width: exactly the band while touching; closes to rest after a lift.
    const restHw = 0.5 * RIG.restWidth * scale;
    if (contact) {
      this._hw = pose.halfWidth;
    } else {
      const k = 1 - Math.exp(-RIG.widthOmega * Math.max(0, dt));
      const before = this._hw;
      this._hw += (restHw - this._hw) * k;
      energy += ((this._hw - before) / scale) ** 2;
    }
    const hw = this._hw;

    // Lean (on screen): up, turned toward screen-right, pulled a little
    // behind the motion (the handle trails), then kept within maxSkew of
    // the across-band direction so the flat face shows. The side is sticky
    // and the lean spring slow, so a scrub does not swing the handle.
    const D = this._t2;  // v no longer needed
    D.copy(up).multiplyScalar(Math.cos(RIG.leanRight)).addScaledVector(right, Math.sin(RIG.leanRight));
    if (contact && speed > 1e-6) {
      const vx = pose.velocity.x, vy = pose.velocity.y, vz = pose.velocity.z;
      const vu = vx * U.x + vy * U.y + vz * U.z;
      const sx = vx - vu * U.x, sy = vy - vu * U.y, sz = vz - vu * U.z;
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1e-9) {
        const m = -RIG.leanTrail * sat / sl;
        D.x += sx * m; D.y += sy * m; D.z += sz * m;
      }
    }
    D.normalize();
    // never below the horizon of the screen (a finger comes from below)
    const du = D.dot(up);
    if (du < RIG.leanFloor) {
      const dr = D.dot(right) >= 0 ? 1 : -1;
      D.copy(up).multiplyScalar(RIG.leanFloor).addScaledVector(right, dr * Math.sqrt(1 - RIG.leanFloor * RIG.leanFloor));
    }
    const Ys = this._t1.copy(Y).addScaledVector(U, -Y.dot(U));
    if (Ys.lengthSq() < 1e-8) Ys.copy(up);
    Ys.normalize();
    // Which side of the band the handle sits on: the one D points to, with
    // a bias to screen-right (ties on edge-on strokes go right) and hysteresis.
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
      this._springVec(this._lean, this._leanVel, lean, RIG.leanOmega, 1, dt);
      energy += (this._lean.x - lx) ** 2 + (this._lean.y - ly) ** 2 + (this._lean.z - lz) ** 2;
    }
    // The smoothed lean is clamped again against the current band axis, so
    // the flat face never turns edge-on while the axis spring is faster.
    const L2 = this._lean;
    L2.addScaledVector(U, -L2.dot(U));
    if (L2.lengthSq() < 1e-8) L2.copy(Ys);
    L2.normalize();
    this._clampSkew(L2, Ys, right);

    // Handle direction, kept clear of the surface.
    const tilt = pose.isTouch ? RIG.tiltTouch : RIG.tiltMouse;
    this._tilt = tilt;
    const A = this._A.copy(U).multiplyScalar(Math.cos(tilt)).addScaledVector(L2, Math.sin(tilt)).normalize();
    const an = A.dot(N);
    if (an < RIG.minAN) A.addScaledVector(N, RIG.minAN - an).normalize();

    // Tip line centre: on the surface while touching, hovering otherwise.
    const tipC = this._tipC.copy(P).addScaledVector(N, RIG.clearance * scale + (1 - c) * RIG.hoverLift * L);

    // Ferrule: back along the handle, lower when pressed, ahead of the
    // tips by the trail (so the tips drag behind it).
    const pc = p * c;
    const drag = RIG.trailMax * L * (0.5 + 0.5 * p);
    const Fc = this._Fc.copy(tipC).addScaledVector(A, L * (1 - RIG.pressDrop * pc)).addScaledVector(T, -drag);
    const h = this._t1.copy(Fc).sub(P).dot(N);
    const minH = RIG.minHeight * L;
    if (h < minH) Fc.addScaledVector(N, minH - h);

    // Ferrule axes.
    const F = this._F.copy(X).addScaledVector(A, -X.dot(A));
    if (F.lengthSq() < 1e-8) F.crossVectors(A, N);
    F.normalize();
    this._Fn.crossVectors(A, F).normalize();

    this.energy = energy;
    return energy;
  }

  /** Keep unit `v` within maxSkew of side * Ys (rotating it toward Ys). */
  _clampSkew(v, Ys, right) {
    const ys = this._side;
    const dy = v.dot(Ys);
    if (dy * ys >= Math.cos(RIG.maxSkew)) return v;
    v.addScaledVector(Ys, -dy);
    if (v.lengthSq() < 1e-8) v.copy(right).addScaledVector(Ys, -right.dot(Ys));
    if (v.lengthSq() < 1e-8) return v.copy(Ys).multiplyScalar(ys);
    return v.normalize().multiplyScalar(Math.sin(RIG.maxSkew)).addScaledVector(Ys, ys * Math.cos(RIG.maxSkew));
  }

  /**
   * On high: 8 rays (one per band of tips) find the real surface under the
   * tip line where the nail curves away from the tangent plane.
   */
  _refineBands(nailMesh, raycaster) {
    const bp = this._bandDh;
    bp.fill(0);
    if (!nailMesh || !raycaster) return;
    const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
    const L = RIG.length * scale;
    const N = this._N, X = this._X, P = this._P;
    const prevFar = raycaster.far;
    const prevNear = raycaster.near;
    raycaster.near = 0;
    raycaster.far = L * 0.8;
    const origin = this._t1, dir = this._t2;
    dir.copy(N).negate();
    const hits = this._hits;
    for (let k = 0; k < RAY_BANDS; k++) {
      const tx = (k + 0.5) / RAY_BANDS - 0.5;
      origin.copy(P).addScaledVector(X, tx * 2 * this._hw).addScaledVector(N, L * 0.3);
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

  /**
   * Write one bristle's joints. ux/uy: tip layout; rx/ry: root layout.
   * Returns nothing; joints go to `out` at offset `o`.
   */
  _curve(ux, uy, rx, ry, bend, tipJ, dh, out, o) {
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const L = RIG.length * scale;
    const N = this._N, X = this._X, Y = this._Y, A = this._A, F = this._F, Fn = this._Fn, T = this._T;
    const c = this._c;
    const p = pose.contact ? pose.pressure : 0;
    const pc = p * c;
    const hw = this._hw;
    const wf = RIG.ferruleWidth * scale * (1 + 0.15 * pc);
    const wd = RIG.ferruleDepth * scale;

    // Root on the ferrule.
    const Fc = this._Fc;
    const r0x = Fc.x + F.x * rx * wf + Fn.x * ry * wd;
    const r0y = Fc.y + F.y * rx * wf + Fn.y * ry * wd;
    const r0z = Fc.z + F.z * rx * wf + Fn.z * ry * wd;

    // Tip on the line through the point along X; rows spread along the
    // across-band direction (toward the trail / lean side) while touching.
    const tipC = this._tipC;
    const rowSide = this._rowSide;
    const rowOff = uy * RIG.rowSpread * hw * c * rowSide + tipJ * 0.05 * hw * c;
    const t2x = tipC.x + X.x * ux * 2 * hw + Y.x * rowOff + N.x * dh;
    const t2y = tipC.y + X.y * ux * 2 * hw + Y.y * rowOff + N.y * dh;
    const t2z = tipC.z + X.z * ux * 2 * hw + Y.z * rowOff + N.z * dh;

    // Belly: straight when hovering; pressed, the bristle leaves the ferrule
    // along the handle and comes down to lie toward the tip, and lags
    // behind the motion a little more than the tips.
    const hr = (r0x - tipC.x) * N.x + (r0y - tipC.y) * N.y + (r0z - tipC.z) * N.z;
    const an = Math.max(0.25, A.x * N.x + A.y * N.y + A.z * N.z);
    const k = (hr * 0.72) / an;
    // ... and already part way out to its place in the fan (a straight
    // wedge from ferrule to tip, not a trumpet).
    const fx = (t2x - r0x) * RIG.fanOpen, fy = (t2y - r0y) * RIG.fanOpen, fz = (t2z - r0z) * RIG.fanOpen;
    const lat = fx * X.x + fy * X.y + fz * X.z;
    const bx = r0x - A.x * k + X.x * lat, by = r0y - A.y * k + X.y * lat, bz = r0z - A.z * k + X.z * lat;
    const mx = (r0x + t2x) * 0.5, my = (r0y + t2y) * 0.5, mz = (r0z + t2z) * 0.5;
    let amt = c * (0.35 + 0.65 * p) * bend;
    if (amt > 1) amt = 1;
    const lag = RIG.trailLag * L * (0.5 + 0.5 * p);
    const p1x = mx + (bx - mx) * amt + T.x * lag;
    const p1y = my + (by - my) * amt + T.y * lag;
    const p1z = mz + (bz - mz) * amt + T.z * lag;

    for (let j = 0; j < JOINTS; j++) {
      const t = j / SEGMENTS;
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
      out[o + j * 3] = a * r0x + b * p1x + d * t2x;
      out[o + j * 3 + 1] = a * r0y + b * p1y + d * t2y;
      out[o + j * 3 + 2] = a * r0z + b * p1z + d * t2z;
    }
  }

  /** Lay the strands and the core strip from the solved frame. */
  updateGeometry() {
    const n = this.bristleCount;
    const jp = this.jointPositions;
    const pos = this._positionAttr.array;
    const nor = this._normalAttr.array;
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const X = this._X;
    const hw = this._hw;

    // Which side the rows spread to (smooth sign: flips through flat on a reversal).
    const sv = (this._T.x + this._lean.x * 0.3) * this._Y.x + (this._T.y + this._lean.y * 0.3) * this._Y.y + (this._T.z + this._lean.z * 0.3) * this._Y.z;
    this._rowSide = sv > 1 ? 1 : sv < -1 ? -1 : sv;

    const refine = this.collisionMode === 'plane+rays' && this._c > 0.5;
    const bd = this._bandDh;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      let dh = 0;
      if (refine) {
        const f = (this._ux[i] + 0.5) * RAY_BANDS - 0.5;
        const k0 = f <= 0 ? 0 : f >= RAY_BANDS - 1 ? RAY_BANDS - 2 : Math.floor(f);
        const w = Math.min(1, Math.max(0, f - k0));
        dh = bd[k0] + (bd[k0 + 1] - bd[k0]) * w;
      }
      const o = i * JOINTS * 3;
      this._curve(this._ux[i], this._uy[i], this._rx[i], this._ry[i], this._bend[i], this._tipJ[i], dh, jp, o);
      const tip = o + SEGMENTS * 3;
      cx += jp[tip]; cy += jp[tip + 1]; cz += jp[tip + 2];
    }
    if (n > 0) this.tipCenter.set(cx / n, cy / n, cz / n);

    const cols = this._cols;
    const wf = RIG.ferruleWidth * scale;
    // Ribbon half width: a bit over half the column spacing at that point
    // along the fan, so neighbouring strands in a row just touch.
    const wk = 0.62 * (0.85 + 0.15 * Math.min(2, this.radiusScale)) / cols;
    const w0 = wf * wk, w1 = (2 * hw - wf) * wk;

    // Ribbons.
    for (let i = 0; i < n; i++) {
      const tw = this._twist[i];
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (i * JOINTS + s) * 3;
        const quad = CORE_QUADS + i * SEGMENTS + s;
        const wa = w0 + w1 * (s / SEGMENTS);
        const wb = w0 + w1 * ((s + 1) / SEGMENTS);
        this._ribbon(jp, a, a + 3, quad, wa, wb, (s + 0.5) / SEGMENTS, tw, pos, nor);
      }
    }

    // Core strip: the wet bundle under the strands, from the left to the
    // right edge curve, pushed a hair away from the camera.
    const tmp = this._coreJ;
    this._curve(-0.46, 0, -0.42, 0, 1, 0, 0, tmp, 0);
    this._curve(0.46, 0, 0.42, 0, 1, 0, 0, tmp, JOINTS * 3);
    const back = 0.0025 * scale;
    const tc = this._toCam;
    for (let s = 0; s < SEGMENTS; s++) {
      const o = s * 12;
      for (let e = 0; e < 2; e++) {
        const j = s + e;
        const l = j * 3, r = JOINTS * 3 + j * 3;
        const vo = o + e * 6;
        pos[vo] = tmp[l] - tc.x * back; pos[vo + 1] = tmp[l + 1] - tc.y * back; pos[vo + 2] = tmp[l + 2] - tc.z * back;
        pos[vo + 3] = tmp[r] - tc.x * back; pos[vo + 4] = tmp[r + 1] - tc.y * back; pos[vo + 5] = tmp[r + 2] - tc.z * back;
      }
      // normal: across x along
      const ax = pos[o + 6] - pos[o], ay = pos[o + 7] - pos[o + 1], az = pos[o + 8] - pos[o + 2];
      let nx = X.y * az - X.z * ay, ny = X.z * ax - X.x * az, nz = X.x * ay - X.y * ax;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * tc.x + ny * tc.y + nz * tc.z < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (let v = 0; v < 4; v++) { nor[o + v * 3] = nx; nor[o + v * 3 + 1] = ny; nor[o + v * 3 + 2] = nz; }
    }

    this._positionAttr.needsUpdate = true;
    this._normalAttr.needsUpdate = true;
    this._needsMatrices = false;
    this.updateBead();
    this._placeHandle();
    this._placeBlob();
  }

  /** One flat ribbon quad from joint a to joint b. */
  _ribbon(jp, a, b, quad, wa, wb, t, twist, pos, nor) {
    const ax = jp[a], ay = jp[a + 1], az = jp[a + 2];
    const bx = jp[b], by = jp[b + 1], bz = jp[b + 2];
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // width direction: ferrule axis at the root, band axis at the tip
    const F = this._F, X = this._X;
    let wx = F.x + (X.x - F.x) * t, wy = F.y + (X.y - F.y) * t, wz = F.z + (X.z - F.z) * t;
    const wd = wx * dx + wy * dy + wz * dz;
    wx -= wd * dx; wy -= wd * dy; wz -= wd * dz;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    // normal = d x w, twisted a little per strand so highlights break into lines
    let nx = dy * wz - dz * wy, ny = dz * wx - dx * wz, nz = dx * wy - dy * wx;
    nx += wx * twist; ny += wy * twist; nz += wz * twist;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const o = quad * 12;
    pos[o] = ax + wx * wa; pos[o + 1] = ay + wy * wa; pos[o + 2] = az + wz * wa;
    pos[o + 3] = ax - wx * wa; pos[o + 4] = ay - wy * wa; pos[o + 5] = az - wz * wa;
    pos[o + 6] = bx + wx * wb; pos[o + 7] = by + wy * wb; pos[o + 8] = bz + wz * wb;
    pos[o + 9] = bx - wx * wb; pos[o + 10] = by - wy * wb; pos[o + 11] = bz - wz * wb;
    for (let v = 0; v < 4; v++) { nor[o + v * 3] = nx; nor[o + v * 3 + 1] = ny; nor[o + v * 3 + 2] = nz; }
  }

  /** Handle: ferrule at the ferrule centre, along the handle direction. */
  _placeHandle() {
    const scale = this.pose.scale > 0 ? this.pose.scale : DEFAULT_SCALE;
    const L = RIG.length * scale;
    const F = this._F, A = this._A, Fn = this._Fn, Fc = this._Fc;
    this.handle.matrix.set(
      F.x * L, A.x * L, Fn.x * L, Fc.x,
      F.y * L, A.y * L, Fn.y * L, Fc.y,
      F.z * L, A.z * L, Fn.z * L, Fc.z,
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
    mat.opacity = 0.42 * show;
    const r = this._hw * 0.9;
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
   * Bead at the tip line centre, sized by load, squashed into the paint on
   * contact, hanging under the tips while hovering, hidden when dry.
   */
  updateBead() {
    const bead = this.bead;
    if (!bead) return;
    const load = this.load;
    if (load < 0.05) {
      bead.visible = false;
      return;
    }
    bead.visible = true;
    const pose = this.pose;
    const scale = pose.scale > 0 ? pose.scale : DEFAULT_SCALE;
    const c = this._c;
    const p = pose.contact ? pose.pressure : 0;
    const r = RIG.beadRadius * scale * (0.4 + 0.6 * load);
    const wide = r * (1 + 0.5 * p * c);
    const tall = r * (1 - 0.6 * p * c);
    const N = this._N, X = this._X, Y = this._Y;
    const tc = this.tipCenter;
    // contact: sits in the paint; hovering: hangs under the tip line
    const off = c * tall * 0.3 - (1 - c) * tall * 0.75;
    const px = tc.x + N.x * off, py = tc.y + N.y * off, pz = tc.z + N.z * off;
    bead.matrix.set(
      X.x * wide, N.x * tall, Y.x * wide * 0.9, px,
      X.y * wide, N.y * tall, Y.y * wide * 0.9, py,
      X.z * wide, N.z * tall, Y.z * wide * 0.9, pz,
      0, 0, 0, 1,
    );
    bead.matrixWorldNeedsUpdate = true;
  }

  /** 0..1 how much polish the brush holds (bead size). */
  setLoad(load) {
    const l = load < 0 ? 0 : load > 1 ? 1 : load;
    if (Math.abs(l - this.load) < 0.002) return false;
    this.load = l;
    this.pose.load = l;
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
