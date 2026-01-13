/**
 * BristleSystem.js
 * Instanced mesh bristle system with CPU Verlet physics
 * Multi-segment bristle chains (4 joints each) for realistic curved bending
 */
import * as THREE from 'three';

// Physics configuration - scaled for delicate nail polish brush
const PHYSICS_CONFIG = {
  bristleCount: 128,          // Dense bristles for fine brush
  bristleLength: 0.0125,      // Very short bristles for tiny brush
  bristleRadius: 0.00025,     // Ultra fine at base
  tipRadius: 0.000125,        // Even finer at tip
  jointsPerBristle: 4,        // 4 joints = 3 segments per bristle for curved bending
  baseDamping: 0.92,          // Base damping (adjusted per-bristle)
  baseStiffness: 0.15,        // Base angular stiffness (adjusted per-bristle)
  gravity: -0.02,             // Subtle gravity effect
  friction: 0.4,              // Surface friction coefficient
  edgeFriction: 0.6,          // Higher friction for edge bristles
  constraintIterations: 4,    // Constraint solver iterations
  collisionPushback: 0.0008,  // Surface offset
  physicsTimestep: 1/120,     // Fixed 120Hz physics timestep
};

// Brush head configuration - FLAT FAN shape like real nail polish brush
const BRUSH_CONFIG = {
  headWidth: 0.0075,          // Width of flat brush (X axis)
  headDepth: 0.002,           // Depth of flat brush (Y axis) - very thin
  headLength: 0.0075,         // Z extent for bristle attachment
  fanAngle: Math.PI / 16,     // Subtle outward angle at edges
  tipCurveRadius: 0.004,      // Curve at the tip for rounded profile
  rowCount: 6,                // Rows of bristles (depth)
  colCount: 22,               // Columns of bristles (width)
  // Stiffness distribution: center stiffer, edges more flexible
  centerStiffness: 0.22,      // Stiffness for center bristles
  edgeStiffness: 0.08,        // Stiffness for edge bristles
};

export class BristleSystem {
  constructor(bristleCount = PHYSICS_CONFIG.bristleCount) {
    this.bristleCount = bristleCount;
    this.jointsPerBristle = PHYSICS_CONFIG.jointsPerBristle;
    this.segmentsPerBristle = this.jointsPerBristle - 1; // 3 segments for 4 joints
    this.group = new THREE.Group();
    this.group.name = 'BristleSystem';

    // Instanced mesh for bristle segments (3 per bristle)
    this.instancedMesh = null;

    // Multi-segment physics data (typed arrays for performance)
    // Each bristle has jointsPerBristle joints: base (fixed) + 3 movable joints
    const totalJoints = bristleCount * this.jointsPerBristle;
    this.jointPositions = new Float32Array(totalJoints * 3);     // Current joint positions
    this.prevJointPositions = new Float32Array(totalJoints * 3); // Previous (for Verlet)
    this.restDirections = new Float32Array(bristleCount * 3);    // Rest direction per bristle

    // Per-bristle physics parameters (center vs edge variation)
    this.bristleStiffness = new Float32Array(bristleCount);      // Angular stiffness
    this.bristleDamping = new Float32Array(bristleCount);        // Velocity damping
    this.bristleFriction = new Float32Array(bristleCount);       // Surface friction

    // Segment lengths (distance between adjacent joints)
    this.segmentLength = PHYSICS_CONFIG.bristleLength / this.segmentsPerBristle;

    // Fixed timestep accumulator for frame-rate independence
    this.physicsAccumulator = 0;

    // Temporary vectors for calculations (reuse to avoid GC)
    this._tempVec = new THREE.Vector3();
    this._tempVec2 = new THREE.Vector3();
    this._tempVec3 = new THREE.Vector3();
    this._tempVec4 = new THREE.Vector3();
    this._tempMatrix = new THREE.Matrix4();
    this._tempQuaternion = new THREE.Quaternion();

    // Brush state
    this.brushPosition = new THREE.Vector3();
    this.brushNormal = new THREE.Vector3(0, 0, 1);
    this.pressure = 0;
    this.isContacting = false;

    // Contact points for paint application
    this.contactPoints = [];

    // Color
    this.color = new THREE.Color('#ff2a6d');

    this.createGeometry();
    this.initializePhysics();
  }

  /**
   * Create instanced mesh geometry for all bristle segments
   * 3 segments per bristle = 384 instances for 128 bristles
   */
  createGeometry() {
    // Single segment geometry - tapered cylinder (1/3 of bristle length)
    // Taper from base radius to tip radius across full bristle
    const baseRadius = PHYSICS_CONFIG.bristleRadius;
    const tipRadius = PHYSICS_CONFIG.tipRadius;

    // Average radius for segments (they'll be scaled per-segment)
    const geometry = new THREE.CylinderGeometry(
      tipRadius,                    // top radius (narrower)
      baseRadius,                   // bottom radius (wider)
      this.segmentLength,           // height = 1/3 bristle length
      4,                            // radial segments (low for perf)
      1,                            // height segments
      false                         // open ended
    );

    // Rotate so Y-up becomes Z-forward (segment points along local Z)
    geometry.rotateX(Math.PI / 2);
    // Move origin to base of segment
    geometry.translate(0, 0, this.segmentLength / 2);

    // Material for bristles - use emissive for better visibility at small scale
    const material = new THREE.MeshStandardMaterial({
      color: this.color,
      emissive: this.color,
      emissiveIntensity: 0.3,
      roughness: 0.4,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });

    // Create instanced mesh (3 segments per bristle)
    const totalSegments = this.bristleCount * this.segmentsPerBristle;
    this.instancedMesh = new THREE.InstancedMesh(
      geometry,
      material,
      totalSegments
    );
    this.instancedMesh.name = 'Bristles';
    this.instancedMesh.frustumCulled = false; // Always render

    this.group.add(this.instancedMesh);

    // Create brush handle visual
    this.createBrushHandle();
  }

  /**
   * Create nail polish bottle cap style handle (half scale)
   */
  createBrushHandle() {
    // Slender glossy handle like nail polish bottle cap
    const handleGeometry = new THREE.CylinderGeometry(
      0.003,  // top radius (narrow)
      0.004,  // bottom radius (slightly wider)
      0.04,   // height
      12      // segments for smoothness
    );
    handleGeometry.rotateX(Math.PI / 2);
    handleGeometry.translate(0, 0, -0.022);

    // Glossy dark plastic material
    const handleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x1a1a1a,
      roughness: 0.15,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
    });

    this.handle = new THREE.Mesh(handleGeometry, handleMaterial);
    this.handle.name = 'BrushHandle';
    this.group.add(this.handle);
  }

  /**
   * Initialize bristle positions in a flat fan arrangement (like real nail polish brush)
   * Each bristle has 4 joints along its rest direction
   */
  initializePhysics() {
    const { headWidth, headDepth, tipCurveRadius, rowCount, colCount, fanAngle,
            centerStiffness, edgeStiffness } = BRUSH_CONFIG;
    const { baseDamping, friction, edgeFriction } = PHYSICS_CONFIG;

    let bristleIndex = 0;

    for (let row = 0; row < rowCount && bristleIndex < this.bristleCount; row++) {
      for (let col = 0; col < colCount && bristleIndex < this.bristleCount; col++) {
        // Normalized position (-0.5 to 0.5)
        const tx = (col / (colCount - 1)) - 0.5;  // X: width direction
        const ty = (row / (rowCount - 1)) - 0.5;  // Y: depth direction

        // Base position on flat rectangular brush head
        let baseX = tx * headWidth;
        let baseY = ty * headDepth;
        let baseZ = 0;

        // Apply curved tip profile - center bristles pushed forward
        const curveOffset = Math.sqrt(Math.max(0, 1 - tx * tx * 4)) * tipCurveRadius;
        baseZ += curveOffset;

        // Add micro-jitter for natural look
        baseX += (Math.random() - 0.5) * 0.000125;
        baseY += (Math.random() - 0.5) * 0.00006;

        // Rest direction - slight fan outward at edges (X direction only)
        const fanAmount = Math.abs(tx) * fanAngle;
        const dirX = Math.sin(fanAmount) * Math.sign(tx || 1);
        const dirY = 0;
        const dirZ = Math.cos(fanAmount);

        // Normalize rest direction
        const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
        const restDirIdx = bristleIndex * 3;
        this.restDirections[restDirIdx] = dirX / len;
        this.restDirections[restDirIdx + 1] = dirY / len;
        this.restDirections[restDirIdx + 2] = dirZ / len;

        // Initialize all 4 joints along the rest direction
        // Joint 0 = base (fixed), joints 1-3 = movable
        for (let j = 0; j < this.jointsPerBristle; j++) {
          const jointIdx = (bristleIndex * this.jointsPerBristle + j) * 3;
          const t = j / this.segmentsPerBristle; // 0, 1/3, 2/3, 1

          // Position along rest direction
          const jx = baseX + this.restDirections[restDirIdx] * this.segmentLength * j;
          const jy = baseY + this.restDirections[restDirIdx + 1] * this.segmentLength * j;
          const jz = baseZ + this.restDirections[restDirIdx + 2] * this.segmentLength * j;

          this.jointPositions[jointIdx] = jx;
          this.jointPositions[jointIdx + 1] = jy;
          this.jointPositions[jointIdx + 2] = jz;

          // Copy to previous positions
          this.prevJointPositions[jointIdx] = jx;
          this.prevJointPositions[jointIdx + 1] = jy;
          this.prevJointPositions[jointIdx + 2] = jz;
        }

        // Per-bristle physics parameters based on position
        // Edge bristles (high |tx|) are more flexible, center bristles stiffer
        const edgeness = Math.abs(tx) * 2; // 0 at center, 1 at edge
        this.bristleStiffness[bristleIndex] = centerStiffness + (edgeStiffness - centerStiffness) * edgeness;
        this.bristleDamping[bristleIndex] = baseDamping - edgeness * 0.04; // Slightly less damping at edges
        this.bristleFriction[bristleIndex] = friction + (edgeFriction - friction) * edgeness;

        bristleIndex++;
      }
    }

    // Update visual
    this.updateInstanceMatrices();
  }

  /**
   * Run Verlet physics integration for multi-segment bristle chains
   * Uses fixed timestep for frame-rate independence
   * @param {number} dt - Fixed time step in seconds
   */
  stepPhysics(dt) {
    const gravity = PHYSICS_CONFIG.gravity * dt * dt;
    const segLen = this.segmentLength;

    for (let i = 0; i < this.bristleCount; i++) {
      const stiffness = this.bristleStiffness[i];
      const damping = this.bristleDamping[i];
      const restDirIdx = i * 3;
      const restDirX = this.restDirections[restDirIdx];
      const restDirY = this.restDirections[restDirIdx + 1];
      const restDirZ = this.restDirections[restDirIdx + 2];

      // Get base joint position (joint 0 - fixed)
      const baseIdx = (i * this.jointsPerBristle) * 3;
      const baseX = this.jointPositions[baseIdx];
      const baseY = this.jointPositions[baseIdx + 1];
      const baseZ = this.jointPositions[baseIdx + 2];

      // Integrate movable joints (1, 2, 3) using Verlet
      for (let j = 1; j < this.jointsPerBristle; j++) {
        const jointIdx = (i * this.jointsPerBristle + j) * 3;

        // Current position
        const currX = this.jointPositions[jointIdx];
        const currY = this.jointPositions[jointIdx + 1];
        const currZ = this.jointPositions[jointIdx + 2];

        // Previous position
        const prevX = this.prevJointPositions[jointIdx];
        const prevY = this.prevJointPositions[jointIdx + 1];
        const prevZ = this.prevJointPositions[jointIdx + 2];

        // Velocity from Verlet (current - previous) with damping
        let velX = (currX - prevX) * damping;
        let velY = (currY - prevY) * damping;
        let velZ = (currZ - prevZ) * damping;

        // Apply gravity
        velZ += gravity;

        // Store current as previous
        this.prevJointPositions[jointIdx] = currX;
        this.prevJointPositions[jointIdx + 1] = currY;
        this.prevJointPositions[jointIdx + 2] = currZ;

        // Update position
        this.jointPositions[jointIdx] = currX + velX;
        this.jointPositions[jointIdx + 1] = currY + velY;
        this.jointPositions[jointIdx + 2] = currZ + velZ;
      }

      // Apply angular stiffness - each joint pulls toward the rest direction
      // relative to its parent joint
      for (let j = 1; j < this.jointsPerBristle; j++) {
        const jointIdx = (i * this.jointsPerBristle + j) * 3;
        const parentIdx = (i * this.jointsPerBristle + j - 1) * 3;

        // Parent position
        const parentX = this.jointPositions[parentIdx];
        const parentY = this.jointPositions[parentIdx + 1];
        const parentZ = this.jointPositions[parentIdx + 2];

        // Current joint position
        let jx = this.jointPositions[jointIdx];
        let jy = this.jointPositions[jointIdx + 1];
        let jz = this.jointPositions[jointIdx + 2];

        // Rest position for this joint (along rest direction from parent)
        const restX = parentX + restDirX * segLen;
        const restY = parentY + restDirY * segLen;
        const restZ = parentZ + restDirZ * segLen;

        // Blend toward rest position (angular stiffness)
        jx += (restX - jx) * stiffness;
        jy += (restY - jy) * stiffness;
        jz += (restZ - jz) * stiffness;

        this.jointPositions[jointIdx] = jx;
        this.jointPositions[jointIdx + 1] = jy;
        this.jointPositions[jointIdx + 2] = jz;
      }
    }

    // Satisfy distance constraints (multiple iterations for stability)
    for (let iter = 0; iter < PHYSICS_CONFIG.constraintIterations; iter++) {
      this.satisfyDistanceConstraints();
    }
  }

  /**
   * Satisfy distance constraints between adjacent joints
   * Each segment must maintain its rest length
   */
  satisfyDistanceConstraints() {
    const segLen = this.segmentLength;

    for (let i = 0; i < this.bristleCount; i++) {
      // Process each segment (3 segments between 4 joints)
      for (let j = 0; j < this.segmentsPerBristle; j++) {
        const j0Idx = (i * this.jointsPerBristle + j) * 3;
        const j1Idx = (i * this.jointsPerBristle + j + 1) * 3;

        // Get joint positions
        const x0 = this.jointPositions[j0Idx];
        const y0 = this.jointPositions[j0Idx + 1];
        const z0 = this.jointPositions[j0Idx + 2];
        let x1 = this.jointPositions[j1Idx];
        let y1 = this.jointPositions[j1Idx + 1];
        let z1 = this.jointPositions[j1Idx + 2];

        // Direction and current length
        let dx = x1 - x0;
        let dy = y1 - y0;
        let dz = z1 - z0;
        const currentLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (currentLen > 0.00001) {
          // Correction factor
          const correction = (segLen - currentLen) / currentLen;

          // Joint 0 is either base (fixed) or a movable joint
          if (j === 0) {
            // Base joint is fixed, move only joint 1
            x1 += dx * correction;
            y1 += dy * correction;
            z1 += dz * correction;
          } else {
            // Both joints movable - split correction equally
            const halfCorr = correction * 0.5;
            this.jointPositions[j0Idx] -= dx * halfCorr;
            this.jointPositions[j0Idx + 1] -= dy * halfCorr;
            this.jointPositions[j0Idx + 2] -= dz * halfCorr;
            x1 += dx * halfCorr;
            y1 += dy * halfCorr;
            z1 += dz * halfCorr;
          }

          this.jointPositions[j1Idx] = x1;
          this.jointPositions[j1Idx + 1] = y1;
          this.jointPositions[j1Idx + 2] = z1;
        }
      }
    }
  }

  /**
   * Legacy method - now uses fixed timestep internally
   * @param {number} deltaTime - Variable frame time
   */
  updatePhysics(deltaTime) {
    // Accumulate time for fixed timestep physics
    this.physicsAccumulator += Math.min(deltaTime, 0.1); // Cap to avoid spiral of death

    const fixedDt = PHYSICS_CONFIG.physicsTimestep;

    // Run fixed timestep physics until we've caught up
    while (this.physicsAccumulator >= fixedDt) {
      this.stepPhysics(fixedDt);
      this.physicsAccumulator -= fixedDt;
    }
  }

  /**
   * Handle collision with nail surface for multi-segment bristles
   * Detects collision at tip joint and applies friction
   * @param {THREE.Mesh} nailMesh - The nail mesh to collide with
   * @param {THREE.Raycaster} raycaster - Shared raycaster instance
   * @returns {Array} Contact points with UV coordinates
   */
  handleCollision(nailMesh, raycaster) {
    this.contactPoints = [];

    if (!nailMesh || !this.isContacting) {
      return this.contactPoints;
    }

    const bristleLength = PHYSICS_CONFIG.bristleLength;
    const pushback = PHYSICS_CONFIG.collisionPushback;
    const worldMatrix = this.group.matrixWorld;
    const invMatrix = this._tempMatrix.copy(worldMatrix).invert();

    for (let i = 0; i < this.bristleCount; i++) {
      const friction = this.bristleFriction[i];

      // Get base joint (joint 0) and tip joint (joint 3) positions
      const baseIdx = (i * this.jointsPerBristle) * 3;
      const tipIdx = (i * this.jointsPerBristle + this.jointsPerBristle - 1) * 3;

      // Base in local space
      this._tempVec.set(
        this.jointPositions[baseIdx],
        this.jointPositions[baseIdx + 1],
        this.jointPositions[baseIdx + 2]
      );

      // Tip in local space
      this._tempVec2.set(
        this.jointPositions[tipIdx],
        this.jointPositions[tipIdx + 1],
        this.jointPositions[tipIdx + 2]
      );

      // Transform to world space
      this._tempVec.applyMatrix4(worldMatrix);
      this._tempVec2.applyMatrix4(worldMatrix);

      // Direction from base to tip
      this._tempVec3.subVectors(this._tempVec2, this._tempVec).normalize();

      // Raycast from base toward tip
      raycaster.set(this._tempVec, this._tempVec3);
      raycaster.far = bristleLength * 1.3;

      const intersects = raycaster.intersectObject(nailMesh, true);

      if (intersects.length > 0) {
        const hit = intersects[0];

        if (hit.distance < bristleLength * 1.15) {
          // Calculate which joints are past the surface
          const penetrationDepth = bristleLength - hit.distance;
          const segLen = this.segmentLength;

          // Push tip joint to surface + pushback
          const hitPoint = hit.point.clone();
          hitPoint.addScaledVector(hit.face.normal, pushback);

          // Transform hit point back to local space
          hitPoint.applyMatrix4(invMatrix);

          // Apply friction to tip joint velocity
          // Friction resists motion tangent to the surface
          const prevTipX = this.prevJointPositions[tipIdx];
          const prevTipY = this.prevJointPositions[tipIdx + 1];
          const prevTipZ = this.prevJointPositions[tipIdx + 2];

          // Current velocity
          let velX = this.jointPositions[tipIdx] - prevTipX;
          let velY = this.jointPositions[tipIdx + 1] - prevTipY;
          let velZ = this.jointPositions[tipIdx + 2] - prevTipZ;

          // Get surface normal in local space
          this._tempVec4.copy(hit.face.normal);
          this._tempVec4.transformDirection(invMatrix);

          // Project velocity onto surface normal (normal component)
          const normalVelMag = velX * this._tempVec4.x + velY * this._tempVec4.y + velZ * this._tempVec4.z;

          // Tangent velocity (parallel to surface)
          const tangentVelX = velX - normalVelMag * this._tempVec4.x;
          const tangentVelY = velY - normalVelMag * this._tempVec4.y;
          const tangentVelZ = velZ - normalVelMag * this._tempVec4.z;

          // Apply friction to tangent velocity
          const frictionFactor = 1 - friction;

          // Update tip joint position (at surface with friction-reduced tangent motion)
          this.jointPositions[tipIdx] = hitPoint.x + tangentVelX * frictionFactor;
          this.jointPositions[tipIdx + 1] = hitPoint.y + tangentVelY * frictionFactor;
          this.jointPositions[tipIdx + 2] = hitPoint.z + tangentVelZ * frictionFactor;

          // Also check and constrain joint 2 if it's past the surface
          const joint2Idx = (i * this.jointsPerBristle + 2) * 3;
          if (penetrationDepth > segLen) {
            // Joint 2 might also be past surface
            this._tempVec.set(
              this.jointPositions[joint2Idx],
              this.jointPositions[joint2Idx + 1],
              this.jointPositions[joint2Idx + 2]
            );
            this._tempVec.applyMatrix4(worldMatrix);

            // Check if joint 2 is below surface
            const j2ToHit = this._tempVec.clone().sub(hit.point);
            const j2Depth = -j2ToHit.dot(hit.face.normal);
            if (j2Depth > 0) {
              // Push joint 2 back to surface
              this._tempVec.addScaledVector(hit.face.normal, j2Depth + pushback * 0.5);
              this._tempVec.applyMatrix4(invMatrix);
              this.jointPositions[joint2Idx] = this._tempVec.x;
              this.jointPositions[joint2Idx + 1] = this._tempVec.y;
              this.jointPositions[joint2Idx + 2] = this._tempVec.z;
            }
          }

          // Record contact point for painting
          const pressure = Math.min(1, penetrationDepth / (bristleLength * 0.5));

          // Use actual UV if available, otherwise estimate from position
          let uv = hit.uv;
          if (!uv) {
            uv = this.estimateUVFromHit(hit, nailMesh);
          }

          if (uv) {
            this.contactPoints.push({
              position: hit.point.clone(),
              uv: uv.clone(),
              normal: hit.face.normal.clone(),
              pressure: Math.max(0.15, pressure),
              bristleIndex: i
            });
          }
        }
      }
    }

    return this.contactPoints;
  }

  /**
   * Estimate UV coordinates from hit position when mesh UVs are unavailable
   * @param {Object} hit - Raycast intersection result
   * @param {THREE.Mesh} nailMesh - The nail mesh
   * @returns {THREE.Vector2|null} Estimated UV coordinates
   */
  estimateUVFromHit(hit, nailMesh) {
    if (!nailMesh || !nailMesh.geometry) return null;

    // Compute bounding box if needed
    if (!nailMesh.geometry.boundingBox) {
      nailMesh.geometry.computeBoundingBox();
    }
    const bbox = nailMesh.geometry.boundingBox;
    if (!bbox) return null;

    // Transform hit point to local space of the nail mesh
    const localPoint = hit.point.clone();
    const invMatrix = new THREE.Matrix4().copy(nailMesh.matrixWorld).invert();
    localPoint.applyMatrix4(invMatrix);

    // Compute UV from local position relative to bounding box
    const size = new THREE.Vector3();
    bbox.getSize(size);

    // Avoid division by zero
    const sizeX = size.x || 1;
    const sizeY = size.y || 1;

    // Map position to 0-1 UV range
    const u = (localPoint.x - bbox.min.x) / sizeX;
    const v = (localPoint.y - bbox.min.y) / sizeY;

    // Clamp to valid UV range
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      return new THREE.Vector2(u, v);
    }

    return null;
  }

  /**
   * Apply splay effect when brush is pressed (flat brush splays outward in X direction)
   * Affects all movable joints, with more effect toward the tip
   * @param {number} pressure - Pressure amount (0-1)
   */
  applySplay(pressure) {
    if (pressure <= 0) return;

    const { headWidth, headDepth } = BRUSH_CONFIG;

    for (let i = 0; i < this.bristleCount; i++) {
      // Get base position for this bristle
      const baseIdx = (i * this.jointsPerBristle) * 3;
      const baseX = this.jointPositions[baseIdx];
      const baseY = this.jointPositions[baseIdx + 1];

      // Normalize position within brush head
      const normalizedX = baseX / (headWidth / 2);  // -1 to 1
      const normalizedY = baseY / (headDepth / 2);  // -1 to 1

      // Apply splay to each movable joint (1, 2, 3)
      // More splay toward the tip
      for (let j = 1; j < this.jointsPerBristle; j++) {
        const jointIdx = (i * this.jointsPerBristle + j) * 3;
        const t = j / this.segmentsPerBristle; // 0.33, 0.66, 1.0

        // Splay increases with distance from base
        const splayScale = t * t; // Quadratic increase

        // Flat brush splays OUTWARD in X direction primarily
        const splayForceX = normalizedX * pressure * 0.0008 * splayScale;
        const splayForceY = normalizedY * pressure * 0.0004 * splayScale;
        const compressZ = pressure * 0.0003 * splayScale;

        this.jointPositions[jointIdx] += splayForceX;
        this.jointPositions[jointIdx + 1] += splayForceY;
        this.jointPositions[jointIdx + 2] -= compressZ;
      }
    }
  }

  /**
   * Update instance matrices for rendering multi-segment bristles
   * Each bristle has 3 segments (between 4 joints) rendered as separate cylinders
   */
  updateInstanceMatrices() {
    const segLen = this.segmentLength;
    const defaultDir = new THREE.Vector3(0, 0, 1);

    for (let i = 0; i < this.bristleCount; i++) {
      // Render 3 segments per bristle
      for (let s = 0; s < this.segmentsPerBristle; s++) {
        const instanceIdx = i * this.segmentsPerBristle + s;

        // Joint indices for this segment
        const j0Idx = (i * this.jointsPerBristle + s) * 3;
        const j1Idx = (i * this.jointsPerBristle + s + 1) * 3;

        // Get joint positions
        this._tempVec.set(
          this.jointPositions[j0Idx],
          this.jointPositions[j0Idx + 1],
          this.jointPositions[j0Idx + 2]
        );
        this._tempVec2.set(
          this.jointPositions[j1Idx],
          this.jointPositions[j1Idx + 1],
          this.jointPositions[j1Idx + 2]
        );

        // Direction and length of this segment
        this._tempVec3.subVectors(this._tempVec2, this._tempVec);
        const currentLength = this._tempVec3.length();

        if (currentLength > 0.00001) {
          this._tempVec3.normalize();

          // Create rotation from default direction (0,0,1) to current segment direction
          this._tempQuaternion.setFromUnitVectors(defaultDir, this._tempVec3);

          // Scale factor for segment length (should be ~1 if constraints work)
          const lengthScale = currentLength / segLen;

          // Taper factor - segments get thinner toward tip
          // Segment 0: 1.0, Segment 1: 0.75, Segment 2: 0.5
          const taperScale = 1.0 - (s * 0.25);

          // Build transform matrix
          this._tempMatrix.compose(
            this._tempVec,           // Position at segment start (joint s)
            this._tempQuaternion,    // Rotation along segment direction
            new THREE.Vector3(taperScale, taperScale, lengthScale)
          );

          this.instancedMesh.setMatrixAt(instanceIdx, this._tempMatrix);
        }
      }
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Set brush position and orientation
   * @param {THREE.Vector3} position - World position
   * @param {THREE.Vector3} normal - Surface normal (unused - brush faces camera)
   */
  setBrushTransform(position, normal) {
    this.brushPosition.copy(position);
    this.brushNormal.copy(normal);

    // Position group
    this.group.position.copy(position);

    // Fixed diagonal orientation: handle bottom-right, bristles pointing left
    // Flip 180 degrees from current position to get handle on other side
    this.group.rotation.set(0, 0, -Math.PI / 3);
    // Debug: log once to verify new code is running
    if (!this._rotationLogged) {
      console.log('BRUSH ROTATION SET TO:', -Math.PI / 3, 'radians (-60 degrees)');
      this._rotationLogged = true;
    }
  }

  /**
   * Set brush color
   * @param {string|THREE.Color} color - New color
   */
  setColor(color) {
    this.color.set(color);
    if (this.instancedMesh?.material) {
      this.instancedMesh.material.color.copy(this.color);
      this.instancedMesh.material.emissive.copy(this.color);
    }
  }

  /**
   * Full update cycle
   * @param {number} deltaTime - Time step
   * @param {THREE.Mesh} nailMesh - Nail mesh for collision
   * @param {THREE.Raycaster} raycaster - Shared raycaster
   */
  update(deltaTime, nailMesh, raycaster) {
    // Apply splay based on pressure
    if (this.pressure > 0) {
      this.applySplay(this.pressure);
    }

    // Run physics
    this.updatePhysics(deltaTime);

    // Handle collision
    const contacts = this.handleCollision(nailMesh, raycaster);

    // Update visuals
    this.updateInstanceMatrices();

    return contacts;
  }

  /**
   * Set visibility
   */
  setVisible(visible) {
    this.group.visible = visible;
  }

  /**
   * Dispose of resources
   */
  dispose() {
    if (this.instancedMesh) {
      this.instancedMesh.geometry.dispose();
      this.instancedMesh.material.dispose();
    }
    if (this.handle) {
      this.handle.geometry.dispose();
      this.handle.material.dispose();
    }
  }
}
