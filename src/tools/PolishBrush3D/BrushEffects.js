/**
 * BrushEffects.js
 * Polish droplets that flick off fast strokes.
 *
 * Cheap by construction:
 * - One THREE.Points draw for every droplet (a pool sized for the highest
 *   tier; tiers cap how many can live at once via `settings.brushParticles`).
 * - Motion is computed on the GPU from per-droplet spawn attributes and one
 *   `uTime` uniform. The CPU only writes attributes when a droplet is born.
 * - While no droplet is alive the mesh is hidden and update() returns at once.
 * - No allocations after construction.
 *
 * Sound is not played here: WP5 listens to the brush events.
 */
import * as THREE from 'three';

const POOL = 48;              // highest tier's brushParticles
const LIFE = 0.5;             // seconds (per-droplet jitter in the shader)
const GRAVITY = -0.6;         // world units / s^2 (a nail is ~0.07 units wide)
const SIZE = 0.0034;          // world-space droplet diameter
const SPEED_START = 0.9;      // UV/s: slower strokes flick nothing
const RATE_PER_SPEED = 9;     // droplets per second per UV/s above SPEED_START
const MAX_RATE = 60;          // droplets per second
const MAX_PER_FRAME = 4;

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uScale;
uniform float uSize;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
varying float vAlpha;
void main() {
  float age = uTime - aBirth;
  float life = ${LIFE.toFixed(3)} * (0.7 + 0.6 * fract(aSeed * 7.31));
  float t = age / life;
  if (age < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  // light air drag on the throw, then gravity
  vec3 p = position + aVelocity * (1.0 - exp(-2.5 * age)) / 2.5;
  p.y += ${GRAVITY.toFixed(3)} * 0.5 * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = uSize * (0.55 + 0.9 * fract(aSeed * 3.17)) * (1.0 - 0.45 * t);
  gl_PointSize = max(1.0, s * uScale / -mv.z);
  vAlpha = 1.0 - smoothstep(0.6, 1.0, t);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;   // sRGB display values
uniform float uGlint;  // 0 on low tier
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  vec3 n = vec3(c.x, -c.y, sqrt(1.0 - r2));
  float diff = 0.5 + 0.5 * max(dot(n, vec3(-0.40, 0.55, 0.73)), 0.0);
  vec3 col = uColor * diff;
  // tiny wet glint (added over the droplet colour)
  float spec = pow(max(dot(n, vec3(-0.33, 0.47, 0.82)), 0.0), 36.0);
  col += vec3(spec * 0.95 * uGlint);
  gl_FragColor = vec4(col, vAlpha * smoothstep(1.0, 0.82, r2));
}
`;

const _scratchSize = new THREE.Vector2();

export class BrushEffects {
  constructor(scene) {
    this.scene = scene;
    this.visible = true;
    this.maxAlive = 24;
    this.time = 0;
    this._lastDeath = -1;     // time after which nothing is alive (-1: nothing alive)
    this._next = 0;
    this._budget = 0;         // fractional droplets owed by the rate limiter

    const geometry = new THREE.BufferGeometry();
    this._start = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
    this._vel = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
    this._seedAttr = new THREE.BufferAttribute(new Float32Array(POOL), 1);
    const birth = new Float32Array(POOL);
    birth.fill(-1000);
    this._birth = new THREE.BufferAttribute(birth, 1);
    this._start.setUsage(THREE.DynamicDrawUsage);
    this._vel.setUsage(THREE.DynamicDrawUsage);
    this._seedAttr.setUsage(THREE.DynamicDrawUsage);
    this._birth.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this._start);
    geometry.setAttribute('aVelocity', this._vel);
    geometry.setAttribute('aSeed', this._seedAttr);
    geometry.setAttribute('aBirth', this._birth);

    this.material = new THREE.ShaderMaterial({
      name: 'PolishDroplets',
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 400 },
        uSize: { value: SIZE },
        uColor: { value: new THREE.Color(1, 0.16, 0.43) },
        uGlint: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'PolishDroplets';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(_scratchSize);
      this.material.uniforms.uScale.value = camera.projectionMatrix.elements[5] * _scratchSize.y * 0.5;
    };
    // Legacy name
    this.particleMesh = this.points;
    this.scene.add(this.points);

    this.setColor('#ff2a6d');
  }

  /** Polish colour (sRGB string or hex). */
  setColor(color) {
    const c = this.material.uniforms.uColor.value;
    c.set(color);
    // The shader works in display values: undo three's sRGB -> linear conversion.
    c.convertLinearToSRGB();
  }

  /** Tier settings: droplet cap and glint. */
  setQuality(settings) {
    if (!settings) return;
    this.maxAlive = Math.max(1, Math.min(POOL, (settings.brushParticles | 0) || 24));
    if (this._next >= this.maxAlive) this._next = 0;
    this.material.uniforms.uGlint.value = settings.glints === false ? 0 : 1;
  }

  /**
   * Flick droplets from the stroke, rate-limited by stroke speed.
   * @param {Array} contacts BristleSystem contact pool
   * @param {number} contactCount live entries in `contacts`
   * @param {number} speed stroke speed in UV per second
   * @param {THREE.Vector3|null} worldVel brush velocity in world units per second
   * @param {number} dt seconds
   */
  emitFromStroke(contacts, contactCount, speed, worldVel, dt) {
    if (!this.visible || contactCount <= 0 || dt <= 0) return;
    const over = speed - SPEED_START;
    if (over <= 0) {
      this._budget = 0;
      return;
    }
    let rate = over * RATE_PER_SPEED;
    if (rate > MAX_RATE) rate = MAX_RATE;
    this._budget += rate * dt;
    let n = Math.floor(this._budget);
    if (n <= 0) return;
    this._budget -= n;
    if (n > MAX_PER_FRAME) n = MAX_PER_FRAME;
    for (let i = 0; i < n; i++) {
      const c = contacts[Math.floor(Math.random() * contactCount)];
      this._spawn(c.position, c.normal, worldVel);
    }
  }

  /** Legacy entry: a few droplets at contacts, no stroke velocity. */
  emitAtContacts(contacts, contactCount = contacts ? contacts.length : 0) {
    if (!contacts || contactCount <= 0) return;
    const n = Math.min(contactCount, 3);
    for (let i = 0; i < n; i++) this._spawn(contacts[i].position, contacts[i].normal, null);
  }

  _spawn(pos, normal, worldVel) {
    // The ring wraps at maxAlive: that caps how many droplets live at once.
    const i = this._next;
    this._next = (this._next + 1) % this.maxAlive;
    let vx = (Math.random() - 0.5) * 0.12 + normal.x * 0.1;
    let vy = (Math.random() - 0.5) * 0.12 + normal.y * 0.1;
    let vz = (Math.random() - 0.5) * 0.12 + normal.z * 0.1;
    if (worldVel) {
      // thrown along the stroke
      vx += worldVel.x * 0.55;
      vy += worldVel.y * 0.55;
      vz += worldVel.z * 0.55;
    }
    const s = this._start.array;
    const v = this._vel.array;
    s[i * 3] = pos.x; s[i * 3 + 1] = pos.y; s[i * 3 + 2] = pos.z;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    this._seedAttr.array[i] = Math.random();
    this._birth.array[i] = this.time;
    this._start.needsUpdate = true;
    this._vel.needsUpdate = true;
    this._seedAttr.needsUpdate = true;
    this._birth.needsUpdate = true;
    const death = this.time + LIFE * 1.3;
    if (death > this._lastDeath) this._lastDeath = death;
    this.material.uniforms.uTime.value = this.time;
    this.points.visible = this.visible;
  }

  /** Compile the droplet program now (it is hidden at startup). */
  prewarm(renderer, camera) {
    if (!renderer || !camera) return;
    const was = this.points.visible;
    this.points.visible = true;
    try {
      renderer.compile(this.points, camera, this.scene);
    } catch (err) {
      // optimisation only
    }
    this.points.visible = was;
  }

  /** True while at least one droplet may be alive. */
  get alive() {
    return this._lastDeath >= 0;
  }

  /**
   * Advance time. Free (and draws nothing) while no droplet is alive.
   * @returns {boolean} true when something changed on screen
   */
  update(dt) {
    if (this._lastDeath < 0) return false;
    this.time += dt;
    if (this.time > this._lastDeath) {
      this._lastDeath = -1;
      this.points.visible = false;
      return true; // one more render removes the last droplets
    }
    this.material.uniforms.uTime.value = this.time;
    return true;
  }

  /** Kill every droplet. */
  clear() {
    this._birth.array.fill(-1000);
    this._birth.needsUpdate = true;
    this._lastDeath = -1;
    this.points.visible = false;
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) this.clear();
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
