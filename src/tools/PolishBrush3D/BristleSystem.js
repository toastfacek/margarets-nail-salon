/**
 * BristleSystem.js
 * Instanced bristle chains (4 joints, 3 segments each) with CPU Verlet physics.
 *
 * Performance rules:
 * - The bristle mesh is allocated once for the maximum bristle count; tiers
 *   change its draw range. Bristles are ONE merged mesh of tapered ribbons
 *   (one draw call) rewritten on the CPU only while they move: an
 *   InstancedMesh of 384 tiny cylinders cost several ms per frame on
 *   software GPUs, which pay a fixed price per instance.
 * - At most `physicsSubstepsMax` fixed steps per frame; leftover time is
 *   dropped (no spiral of death).
 * - Collision is against the tangent plane at the brush hit (one plane per
 *   frame); on high it is refined with 8 evenly spaced raycasts.
 * - Contacts go into a preallocated pool; nothing is cloned or allocated in
 *   update().
 * - update() is skipped entirely while there is no pressure and the joints
 *   are at rest.
 */
import * as THREE from 'three';

const MAX_BRISTLES = 128;
const JOINTS = 4;
const SEGMENTS = JOINTS - 1;

const PHYSICS_CONFIG = Object.freeze({
  bristleLength: 0.0125,
  bristleRadius: 0.00025,
  tipRadius: 0.000125,
  baseDamping: 0.92,
  gravity: -0.02,
  friction: 0.4,
  edgeFriction: 0.6,
  constraintIterations: 4,
  collisionPushback: 0.0008,
  physicsTimestep: 1 / 120,
  restEnergy: 1e-9,         // squared joint displacement per step (~30 um) considered "at rest"
});

// Flat fan, like a real nail polish brush.
const BRUSH_CONFIG = Object.freeze({
  headWidth: 0.0075,
  headDepth: 0.002,
  fanAngle: Math.PI / 16,
  tipCurveRadius: 0.004,
  centerStiffness: 0.22,
  edgeStiffness: 0.08,
});

// Wet look: bristles darken toward the ferrule and gloss toward the tip; a bead
// of polish hangs at the tip while the brush is loaded.
const WET_RAMP = Object.freeze({ ferrule: 0.32, tip: 1.12, power: 1.3 });
const BEAD_RADIUS = 0.0021;
const DEFAULT_TILT = -Math.PI / 3;

const RAY_BANDS = 8;
const Z_AXIS = Object.freeze(new THREE.Vector3(0, 0, 1));

// Deterministic jitter so re-layouts on tier change look the same each time.
function jitter(i, salt) {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s) - 0.5;
}

export class BristleSystem {
  constructor(bristleCount = MAX_BRISTLES) {
    this.maxBristles = MAX_BRISTLES;
    this.jointsPerBristle = JOINTS;
    this.segmentsPerBristle = SEGMENTS;
    this.group = new THREE.Group();
    this.group.name = 'BristleSystem';

    const totalJoints = MAX_BRISTLES * JOINTS;
    this.jointPositions = new Float32Array(totalJoints * 3);
    this.prevJointPositions = new Float32Array(totalJoints * 3);
    this.restDirections = new Float32Array(MAX_BRISTLES * 3);
    this.bristleStiffness = new Float32Array(MAX_BRISTLES);
    this.bristleDamping = new Float32Array(MAX_BRISTLES);
    this.bristleFriction = new Float32Array(MAX_BRISTLES);
    this.bristleBand = new Uint8Array(MAX_BRISTLES);

    this.segmentLength = PHYSICS_CONFIG.bristleLength / SEGMENTS;
    this.physicsAccumulator = 0;
    this.physicsSubstepsMax = 3;
    this.collisionMode = 'plane';
    this.radiusScale = 1;
    this.energy = 0;
    this._needsMatrices = true;

    // Scratch (reused, never reallocated)
    this._tempVec = new THREE.Vector3();
    this._tempVec2 = new THREE.Vector3();
    this._tempVec3 = new THREE.Vector3();
    this._invMatrix = new THREE.Matrix4();
    this._planePoint = new THREE.Vector3();
    this._planeNormal = new THREE.Vector3(0, 1, 0);
    this._hits = [];
    // Per-band local planes: px, py, pz, nx, ny, nz, valid
    this._bandPlanes = new Float32Array(RAY_BANDS * 7);

    // Brush state
    this.brushPosition = new THREE.Vector3();
    this.brushNormal = new THREE.Vector3(0, 0, 1);
    this.pressure = 0;
    this.isContacting = false;
    this.hasSurface = false;

    // Contact pool for effects (world space). Read contactCount entries.
    this.contactCount = 0;
    this.contactPoints = new Array(MAX_BRISTLES);
    for (let i = 0; i < MAX_BRISTLES; i++) {
      this.contactPoints[i] = { position: new THREE.Vector3(), normal: new THREE.Vector3(), pressure: 0, bristleIndex: i };
    }

    this.color = new THREE.Color('#ff2a6d');

    // Bead: 0 = empty brush, 1 = freshly loaded.
    this.load = 1;
    this._centerBristle = 0;

    this.bristleCount = Math.min(MAX_BRISTLES, bristleCount);
    this.createGeometry();
    this.initializePhysics();
  }

  createGeometry() {
    const maxSegments = MAX_BRISTLES * SEGMENTS;
    const positions = new Float32Array(maxSegments * 4 * 3);
    const normals = new Float32Array(maxSegments * 4 * 3);
    const index = new Uint16Array(maxSegments * 6);
    for (let k = 0; k < maxSegments; k++) {
      const v = k * 4;
      const o = k * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v + 2; index[o + 4] = v + 1; index[o + 5] = v + 3;
    }
    // Ribbons lie in the flat brush plane (local x-z); their normal is local +y.
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
    // Static wet ramp along each bristle (vertex colour multiplies the polish colour).
    const shades = new Float32Array(maxSegments * 4 * 3);
    for (let k = 0; k < maxSegments; k++) {
      const s = k % SEGMENTS;
      const fa = WET_RAMP.ferrule + (WET_RAMP.tip - WET_RAMP.ferrule) * Math.pow(s / SEGMENTS, WET_RAMP.power);
      const fb = WET_RAMP.ferrule + (WET_RAMP.tip - WET_RAMP.ferrule) * Math.pow((s + 1) / SEGMENTS, WET_RAMP.power);
      for (let v = 0; v < 4; v++) {
        const f = v < 2 ? fa : fb;
        const o = (k * 4 + v) * 3;
        shades[o] = shades[o + 1] = shades[o + 2] = f;
      }
    }

    const geometry = new THREE.BufferGeometry();
    this._positionAttr = new THREE.BufferAttribute(positions, 3);
    this._positionAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this._positionAttr);
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(shades, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, this.bristleCount * SEGMENTS * 6);

    const material = new THREE.MeshPhongMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 0.16,
      specular: 0x9a9a9a,
      shininess: 70,
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'Bristles';
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // The hanging bead: one small glossy sphere, squashed on contact.
    // Same program as the bristles (Phong + vertex colours: all white here),
    // so the bead adds no shader compile.
    const beadMaterial = new THREE.MeshPhongMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 0.22,
      specular: 0xffffff,
      shininess: 110,
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
    this.group.add(this.bead);

    this.createBrushHandle();
  }

  /** Legacy name kept for callers that reach for the bristle mesh. */
  get instancedMesh() {
    return this.mesh;
  }

  createBrushHandle() {
    // A cute polish-bottle cap: tapered (narrow at the bristles), tray purple,
    // slightly self-lit so it never reads as a black stick. One cheap mesh.
    const handleGeometry = new THREE.CylinderGeometry(0.0035, 0.0065, 0.04, 16);
    handleGeometry.rotateX(Math.PI / 2);
    handleGeometry.translate(0, 0, -0.022);
    const handleMaterial = new THREE.MeshPhongMaterial({
      color: 0x5a2a82,
      emissive: 0x5a2a82,
      emissiveIntensity: 0.25,
      specular: 0xffffff,
      shininess: 80,
    });
    this.handle = new THREE.Mesh(handleGeometry, handleMaterial);
    this.handle.name = 'BrushHandle';
    this.group.add(this.handle);
  }

  /**
   * Change bristle count / radius / physics budget (tier change).
   */
  configure({ bristles = this.bristleCount, radiusScale = this.radiusScale, substeps = this.physicsSubstepsMax, collision = this.collisionMode } = {}) {
    this.physicsSubstepsMax = Math.max(1, substeps | 0);
    this.collisionMode = collision;
    const count = Math.max(8, Math.min(MAX_BRISTLES, bristles | 0));
    if (count !== this.bristleCount || radiusScale !== this.radiusScale) {
      this.bristleCount = count;
      this.radiusScale = radiusScale;
      this.mesh.geometry.setDrawRange(0, count * SEGMENTS * 6);
      this.initializePhysics();
    }
  }

  /**
   * Lay the bristles out in a flat fan. Rows and columns adapt to the count so
   * fewer bristles still cover the full head.
   */
  initializePhysics() {
    const { headWidth, headDepth, tipCurveRadius, fanAngle, centerStiffness, edgeStiffness } = BRUSH_CONFIG;
    const { baseDamping, friction, edgeFriction } = PHYSICS_CONFIG;
    const n = this.bristleCount;
    const rowCount = n >= 96 ? 6 : n >= 48 ? 4 : 2;
    const colCount = Math.ceil(n / rowCount);
    this._centerBristle = Math.min(n - 1, Math.floor(rowCount / 2) * colCount + Math.floor(colCount / 2));

    let b = 0;
    for (let row = 0; row < rowCount && b < n; row++) {
      for (let col = 0; col < colCount && b < n; col++) {
        const tx = colCount > 1 ? (col / (colCount - 1)) - 0.5 : 0;
        const ty = rowCount > 1 ? (row / (rowCount - 1)) - 0.5 : 0;

        const baseX = tx * headWidth + jitter(b, 1) * 0.000125;
        const baseY = ty * headDepth + jitter(b, 2) * 0.00006;
        const baseZ = Math.sqrt(Math.max(0, 1 - tx * tx * 4)) * tipCurveRadius;

        const fanAmount = Math.abs(tx) * fanAngle;
        const dirX = Math.sin(fanAmount) * Math.sign(tx || 1);
        const dirZ = Math.cos(fanAmount);
        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        const r = b * 3;
        this.restDirections[r] = dirX / len;
        this.restDirections[r + 1] = 0;
        this.restDirections[r + 2] = dirZ / len;

        for (let j = 0; j < JOINTS; j++) {
          const k = (b * JOINTS + j) * 3;
          const jx = baseX + this.restDirections[r] * this.segmentLength * j;
          const jy = baseY;
          const jz = baseZ + this.restDirections[r + 2] * this.segmentLength * j;
          this.jointPositions[k] = this.prevJointPositions[k] = jx;
          this.jointPositions[k + 1] = this.prevJointPositions[k + 1] = jy;
          this.jointPositions[k + 2] = this.prevJointPositions[k + 2] = jz;
        }

        const edgeness = Math.abs(tx) * 2;
        this.bristleStiffness[b] = centerStiffness + (edgeStiffness - centerStiffness) * edgeness;
        this.bristleDamping[b] = baseDamping - edgeness * 0.04;
        this.bristleFriction[b] = friction + (edgeFriction - friction) * edgeness;
        this.bristleBand[b] = Math.min(RAY_BANDS - 1, Math.floor((tx + 0.5) * RAY_BANDS));
        b++;
      }
    }
    this.physicsAccumulator = 0;
    this.energy = 0;
    this.updateGeometry();
  }

  /**
   * One fixed Verlet step for all bristles. Tracks `energy` (max squared joint
   * displacement) so the system knows when it is at rest.
   */
  stepPhysics(dt) {
    // Splay per step (not per frame) so the look does not depend on frame rate.
    if (this.pressure > 0) this.applySplay(this.pressure * 0.5);
    const gravity = PHYSICS_CONFIG.gravity * dt * dt;
    const segLen = this.segmentLength;
    const jp = this.jointPositions;
    const pp = this.prevJointPositions;
    let energy = 0;

    for (let i = 0; i < this.bristleCount; i++) {
      const stiffness = this.bristleStiffness[i];
      const damping = this.bristleDamping[i];
      const r = i * 3;
      const rdx = this.restDirections[r];
      const rdy = this.restDirections[r + 1];
      const rdz = this.restDirections[r + 2];

      for (let j = 1; j < JOINTS; j++) {
        const k = (i * JOINTS + j) * 3;
        const cx = jp[k], cy = jp[k + 1], cz = jp[k + 2];
        const vx = (cx - pp[k]) * damping;
        const vy = (cy - pp[k + 1]) * damping;
        const vz = (cz - pp[k + 2]) * damping + gravity;
        pp[k] = cx; pp[k + 1] = cy; pp[k + 2] = cz;
        jp[k] = cx + vx; jp[k + 1] = cy + vy; jp[k + 2] = cz + vz;
      }

      for (let j = 1; j < JOINTS; j++) {
        const k = (i * JOINTS + j) * 3;
        const p = k - 3;
        jp[k] += (jp[p] + rdx * segLen - jp[k]) * stiffness;
        jp[k + 1] += (jp[p + 1] + rdy * segLen - jp[k + 1]) * stiffness;
        jp[k + 2] += (jp[p + 2] + rdz * segLen - jp[k + 2]) * stiffness;
      }
    }

    for (let iter = 0; iter < PHYSICS_CONFIG.constraintIterations; iter++) {
      this.satisfyDistanceConstraints();
    }

    // Energy after constraints: how far joints moved this step.
    for (let i = 0; i < this.bristleCount; i++) {
      for (let j = 1; j < JOINTS; j++) {
        const k = (i * JOINTS + j) * 3;
        const dx = jp[k] - pp[k], dy = jp[k + 1] - pp[k + 1], dz = jp[k + 2] - pp[k + 2];
        const e = dx * dx + dy * dy + dz * dz;
        if (e > energy) energy = e;
      }
    }
    this.energy = energy;
  }

  satisfyDistanceConstraints() {
    const segLen = this.segmentLength;
    const jp = this.jointPositions;
    for (let i = 0; i < this.bristleCount; i++) {
      for (let j = 0; j < SEGMENTS; j++) {
        const a = (i * JOINTS + j) * 3;
        const b = a + 3;
        const dx = jp[b] - jp[a];
        const dy = jp[b + 1] - jp[a + 1];
        const dz = jp[b + 2] - jp[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len <= 0.00001) continue;
        const corr = (segLen - len) / len;
        if (j === 0) {
          jp[b] += dx * corr; jp[b + 1] += dy * corr; jp[b + 2] += dz * corr;
        } else {
          const h = corr * 0.5;
          jp[a] -= dx * h; jp[a + 1] -= dy * h; jp[a + 2] -= dz * h;
          jp[b] += dx * h; jp[b + 1] += dy * h; jp[b + 2] += dz * h;
        }
      }
    }
  }

  /**
   * Fixed-timestep integration, capped at physicsSubstepsMax steps per frame.
   * Returns the number of steps taken.
   */
  updatePhysics(deltaTime) {
    const fixedDt = PHYSICS_CONFIG.physicsTimestep;
    this.physicsAccumulator += deltaTime;
    let steps = 0;
    while (this.physicsAccumulator >= fixedDt && steps < this.physicsSubstepsMax) {
      this.stepPhysics(fixedDt);
      this.physicsAccumulator -= fixedDt;
      steps++;
    }
    // Drop whatever is left: a slow frame must not schedule more work.
    if (steps >= this.physicsSubstepsMax) this.physicsAccumulator = 0;
    return steps;
  }

  /**
   * Set the collision surface for this frame: the tangent plane at the brush
   * hit (world space). Pass hasSurface=false when the brush is off the nail.
   */
  setSurface(point, normal, hasSurface) {
    this.hasSurface = !!hasSurface;
    if (this.hasSurface) {
      this._planePoint.copy(point);
      this._planeNormal.copy(normal);
    }
  }

  /**
   * On high: 8 rays (one per band of bristles) refine the tangent plane where
   * the nail curves away.
   */
  _refineBands(nailMesh, raycaster, gnx, gny, gnz) {
    const bp = this._bandPlanes;
    for (let k = 0; k < RAY_BANDS; k++) bp[k * 7 + 6] = 0;
    if (!nailMesh || !raycaster) return;
    const world = this.group.matrixWorld;
    const inv = this._invMatrix;
    const len = PHYSICS_CONFIG.bristleLength;
    const prevFar = raycaster.far;
    raycaster.far = len * 1.3;
    const { headWidth } = BRUSH_CONFIG;
    for (let k = 0; k < RAY_BANDS; k++) {
      const tx = (k + 0.5) / RAY_BANDS - 0.5;
      this._tempVec.set(tx * headWidth, 0, Math.sqrt(Math.max(0, 1 - tx * tx * 4)) * BRUSH_CONFIG.tipCurveRadius).applyMatrix4(world);
      this._tempVec2.copy(Z_AXIS).transformDirection(world);
      raycaster.set(this._tempVec, this._tempVec2);
      const hits = this._hits;
      hits.length = 0;
      // Mesh.raycast does not sort its hits: take the nearest.
      nailMesh.raycast(raycaster, hits);
      let h = null;
      for (let i = 0; i < hits.length; i++) if (hits[i].face && (h === null || hits[i].distance < h.distance)) h = hits[i];
      if (h !== null) {
        this._tempVec3.copy(h.point).applyMatrix4(inv);
        this._tempVec2.copy(h.face.normal).transformDirection(nailMesh.matrixWorld).transformDirection(inv);
        // face the same way as the global plane (towards the brush)
        if (this._tempVec2.x * gnx + this._tempVec2.y * gny + this._tempVec2.z * gnz < 0) this._tempVec2.negate();
        const o = k * 7;
        bp[o] = this._tempVec3.x; bp[o + 1] = this._tempVec3.y; bp[o + 2] = this._tempVec3.z;
        bp[o + 3] = this._tempVec2.x; bp[o + 4] = this._tempVec2.y; bp[o + 5] = this._tempVec2.z;
        bp[o + 6] = 1;
      }
      hits.length = 0;
    }
    raycaster.far = prevFar;
  }

  /**
   * Collide tips (and joint 2) with the tangent plane. Writes contacts into
   * the pool and returns the contact count.
   */
  handleCollision(nailMesh, raycaster) {
    this.contactCount = 0;
    if (!this.hasSurface || !this.isContacting) return 0;

    this.group.updateMatrixWorld();
    const world = this.group.matrixWorld;
    const inv = this._invMatrix.copy(world).invert();

    // Global plane in local space.
    const lp = this._tempVec.copy(this._planePoint).applyMatrix4(inv);
    const ln = this._tempVec2.copy(this._planeNormal).transformDirection(inv);
    const gpx = lp.x, gpy = lp.y, gpz = lp.z;
    const gnx = ln.x, gny = ln.y, gnz = ln.z;

    const refine = this.collisionMode === 'plane+rays';
    if (refine) this._refineBands(nailMesh, raycaster, gnx, gny, gnz);
    const bp = this._bandPlanes;

    const pushback = PHYSICS_CONFIG.collisionPushback;
    const len = PHYSICS_CONFIG.bristleLength;
    const jp = this.jointPositions;
    const pp = this.prevJointPositions;
    const worldNormal = this._planeNormal;

    for (let i = 0; i < this.bristleCount; i++) {
      let px = gpx, py = gpy, pz = gpz, nx = gnx, ny = gny, nz = gnz;
      if (refine) {
        const o = this.bristleBand[i] * 7;
        if (bp[o + 6] > 0) {
          px = bp[o]; py = bp[o + 1]; pz = bp[o + 2];
          nx = bp[o + 3]; ny = bp[o + 4]; nz = bp[o + 5];
        }
      }

      const tip = (i * JOINTS + SEGMENTS) * 3;
      const d = (jp[tip] - px) * nx + (jp[tip + 1] - py) * ny + (jp[tip + 2] - pz) * nz - pushback;
      if (d >= 0) continue;

      // Push tip onto the plane and apply friction to its tangent motion.
      const friction = this.bristleFriction[i];
      const vx = jp[tip] - pp[tip], vy = jp[tip + 1] - pp[tip + 1], vz = jp[tip + 2] - pp[tip + 2];
      const vn = vx * nx + vy * ny + vz * nz;
      const keep = 1 - friction;
      jp[tip] = jp[tip] - d * nx - (vx - vn * nx) * friction;
      jp[tip + 1] = jp[tip + 1] - d * ny - (vy - vn * ny) * friction;
      jp[tip + 2] = jp[tip + 2] - d * nz - (vz - vn * nz) * friction;
      pp[tip] = jp[tip] - (vx - vn * nx) * keep;
      pp[tip + 1] = jp[tip + 1] - (vy - vn * ny) * keep;
      pp[tip + 2] = jp[tip + 2] - (vz - vn * nz) * keep;

      const j2 = tip - 3;
      const d2 = (jp[j2] - px) * nx + (jp[j2 + 1] - py) * ny + (jp[j2 + 2] - pz) * nz - pushback * 0.5;
      if (d2 < 0) {
        jp[j2] -= d2 * nx; jp[j2 + 1] -= d2 * ny; jp[j2 + 2] -= d2 * nz;
      }

      const c = this.contactPoints[this.contactCount++];
      c.position.set(jp[tip], jp[tip + 1], jp[tip + 2]).applyMatrix4(world);
      c.normal.copy(worldNormal);
      c.pressure = Math.max(0.15, Math.min(1, -d / (len * 0.5)));
      c.bristleIndex = i;
    }
    return this.contactCount;
  }

  /**
   * Splay outward when pressed (more toward the tip).
   */
  applySplay(pressure) {
    if (pressure <= 0) return;
    const { headWidth, headDepth } = BRUSH_CONFIG;
    const jp = this.jointPositions;
    for (let i = 0; i < this.bristleCount; i++) {
      const base = (i * JOINTS) * 3;
      const nxp = jp[base] / (headWidth / 2);
      const nyp = jp[base + 1] / (headDepth / 2);
      for (let j = 1; j < JOINTS; j++) {
        const k = (i * JOINTS + j) * 3;
        const t = j / SEGMENTS;
        const s = t * t;
        jp[k] += nxp * pressure * 0.0008 * s;
        jp[k + 1] += nyp * pressure * 0.0004 * s;
        jp[k + 2] -= pressure * 0.0003 * s;
      }
    }
  }

  /**
   * Rewrite the ribbon vertices from the joints (only called while moving).
   */
  updateGeometry() {
    const jp = this.jointPositions;
    const pos = this._positionAttr.array;
    const rs = this.radiusScale;
    const r0 = PHYSICS_CONFIG.bristleRadius * rs;
    const dr = (PHYSICS_CONFIG.tipRadius - PHYSICS_CONFIG.bristleRadius) * rs / SEGMENTS;
    for (let i = 0; i < this.bristleCount; i++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (i * JOINTS + s) * 3;
        const b = a + 3;
        const ax = jp[a], ay = jp[a + 1], az = jp[a + 2];
        const bx = jp[b], by = jp[b + 1], bz = jp[b + 2];
        // side = normalize(cross(b - a, +y)) = (-dz, 0, dx)
        let sx = -(bz - az);
        let sz = bx - ax;
        const len = Math.sqrt(sx * sx + sz * sz);
        if (len > 1e-9) { sx /= len; sz /= len; } else { sx = 1; sz = 0; }
        const wa = r0 + dr * s;
        const wb = r0 + dr * (s + 1);
        const o = (i * SEGMENTS + s) * 12;
        pos[o] = ax + sx * wa; pos[o + 1] = ay; pos[o + 2] = az + sz * wa;
        pos[o + 3] = ax - sx * wa; pos[o + 4] = ay; pos[o + 5] = az - sz * wa;
        pos[o + 6] = bx + sx * wb; pos[o + 7] = by; pos[o + 8] = bz + sz * wb;
        pos[o + 9] = bx - sx * wb; pos[o + 10] = by; pos[o + 11] = bz - sz * wb;
      }
    }
    this._positionAttr.needsUpdate = true;
    this._needsMatrices = false;
    this.updateBead();
  }

  /**
   * Place the bead at the centre bristle's tip, sized by load and squashed
   * by pressure. Cheap (a few float writes); called with the geometry and
   * whenever the load changes.
   */
  updateBead() {
    const bead = this.bead;
    if (!bead) return;
    const load = this.load;
    if (load <= 0.02) {
      bead.visible = false;
      return;
    }
    bead.visible = true;
    const p = this.isContacting ? Math.min(1, this.pressure) : 0;
    const r = BEAD_RADIUS * (0.4 + 0.6 * load);
    const wide = r * (1 + 0.3 * p);
    const tall = r * (1 - 0.5 * p);
    const k = (this._centerBristle * JOINTS + SEGMENTS) * 3;
    const jp = this.jointPositions;
    // Hangs just past the tip; pressed flat into the paint on contact.
    bead.position.set(jp[k], jp[k + 1], jp[k + 2] + tall * (0.55 - 0.45 * p));
    bead.scale.set(wide, wide * 0.92, tall);
  }

  /** 0..1 how much polish the brush holds (bead size). */
  setLoad(load) {
    const l = load < 0 ? 0 : load > 1 ? 1 : load;
    if (Math.abs(l - this.load) < 0.002) return false;
    this.load = l;
    this.updateBead();
    return true;
  }

  /** Legacy name. */
  updateInstanceMatrices() {
    this.updateGeometry();
  }

  /**
   * Position and orient the brush. The orientation is a fixed diagonal
   * (handle bottom-right, bristles pointing left).
   */
  setBrushTransform(position, normal, tilt = DEFAULT_TILT) {
    this.brushPosition.copy(position);
    this.brushNormal.copy(normal);
    this.group.position.copy(position);
    this.group.rotation.set(0, 0, tilt);
  }

  setColor(color) {
    this.color.set(color);
    const m = this.mesh && this.mesh.material;
    if (m) {
      m.color.copy(this.color);
      m.emissive.copy(this.color);
    }
    const b = this.bead && this.bead.material;
    if (b) {
      b.color.copy(this.color);
      b.emissive.copy(this.color);
    }
  }

  /** True when update() would do nothing. */
  isAtRest() {
    return this.pressure <= 0 && !this.isContacting && this.energy < PHYSICS_CONFIG.restEnergy && !this._needsMatrices;
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
      this.physicsAccumulator = 0;
      return 0;
    }
    this.updatePhysics(deltaTime);
    const contacts = this.handleCollision(nailMesh, raycaster);
    this.updateGeometry();
    return contacts;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    if (this.bead) {
      this.bead.geometry.dispose();
      this.bead.material.dispose();
    }
    if (this.handle) {
      this.handle.geometry.dispose();
      this.handle.material.dispose();
    }
  }
}
