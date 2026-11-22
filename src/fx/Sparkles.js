/**
 * Sparkles.js
 * GPU-animated four-point star sparkles: the "you did it!" glitter for the
 * 90% coverage moment, the cure, decoration pops and (WP7) the reveal.
 *
 * - One THREE.Points of 64 sparkles, one draw call, additive.
 * - Per-sparkle attributes `position` (= aStart), `aVelocity`, `aSeed`,
 *   `aBirth`, `aColor`; the vertex shader computes position, size and
 *   twinkle from `uTime`. The CPU writes attributes only when sparkles spawn.
 * - Hidden (no draw) whenever no sparkle is alive; update() is then free.
 * - The star sprite is computed once into a 64x64 DataTexture.
 * - No allocations per frame. burst()/sweep() allocate nothing either.
 *
 * API: burst(worldPos, count, color[, normal]), sweep(mesh[, count, color]),
 *      update(dt) -> boolean (true while something is on screen),
 *      setQuality(settings), prewarm(renderer, camera), dispose().
 */
import * as THREE from 'three';

const POOL = 64;
const LIFE = 1.1;          // seconds, jittered per sparkle
const SIZE = 0.013;        // world-space sprite size (a nail is ~0.07 wide)
const TWINKLE_HZ = 2.6;    // stays under the 3 Hz flashing limit

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uScale;
uniform float uSize;
attribute vec3 aVelocity;
attribute float aSeed;
attribute float aBirth;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
void main() {
  float age = uTime - aBirth;
  float life = ${LIFE.toFixed(3)} * (0.65 + 0.7 * fract(aSeed * 5.13));
  float t = age / life;
  if (age < 0.0 || t >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  // fast pop outwards, strong drag, a little float upwards
  vec3 p = position + aVelocity * (1.0 - exp(-4.0 * age)) / 4.0;
  p.y += 0.02 * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.5 + 0.5 * sin(age * ${(TWINKLE_HZ * 6.2831853).toFixed(4)} + aSeed * 40.0);
  // ease-out-back grow, then shrink away
  float g = clamp(t / 0.16, 0.0, 1.0);
  float grow = 1.0 + 2.2 * pow(g - 1.0, 3.0) + 1.2 * pow(g - 1.0, 2.0);
  float fade = 1.0 - smoothstep(0.5, 1.0, t);
  float s = uSize * (0.55 + 0.9 * fract(aSeed * 3.71)) * grow * mix(0.7, 1.0, tw) * mix(0.35, 1.0, fade);
  gl_PointSize = max(1.0, s * uScale / -mv.z);
  vAlpha = fade * mix(0.55, 1.0, tw);
  vColor = aColor;
  vRot = aSeed * 6.2831853 + age * 1.6;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float cs = cos(vRot), sn = sin(vRot);
  vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) + 0.5;
  vec4 tex = texture2D(uMap, r);
  // r channel: star + glow, g channel: white-hot core
  vec3 col = mix(vColor, vec3(1.0), tex.g) * tex.r * vAlpha;
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 64x64 four-point star with a soft glow and a white core, built straight into
 * a typed array (a 2D canvas at startup stalls the first GL sync on weak GPUs).
 */
function makeStarTexture() {
  const N = 64;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = (x + 0.5) / N * 2 - 1;
      const py = (y + 0.5) / N * 2 - 1;
      const ax = Math.abs(px), ay = Math.abs(py);
      const rr = Math.sqrt(px * px + py * py);
      // two thin rays (horizontal + vertical), tapering to the tips
      const rayH = Math.max(0, 1 - ay / (0.11 * (1 - ax) + 0.004)) * (1 - ax);
      const rayV = Math.max(0, 1 - ax / (0.11 * (1 - ay) + 0.004)) * (1 - ay);
      // shorter diagonal rays
      const u = (px + py) * 0.7071, v = (px - py) * 0.7071;
      const au = Math.abs(u), av = Math.abs(v);
      const diag = 0.45 * (Math.max(0, 1 - av / (0.07 * (1 - au * 1.6) + 0.003)) * Math.max(0, 1 - au * 1.6) +
        Math.max(0, 1 - au / (0.07 * (1 - av * 1.6) + 0.003)) * Math.max(0, 1 - av * 1.6));
      const glow = Math.exp(-rr * rr * 9) * 0.75;
      const star = Math.min(1, rayH + rayV + diag + glow);
      const core = Math.exp(-rr * rr * 60);
      const o = (y * N + x) * 4;
      d[o] = Math.round(star * 255);
      d[o + 1] = Math.round(Math.min(1, core) * 255);
      d[o + 2] = 0;
      d[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.name = 'SparkleStar';
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const _size = new THREE.Vector2();
const _color = new THREE.Color();
const _v = new THREE.Vector3();
const _bias = new THREE.Vector3();

export class Sparkles {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} [camera] bursts lean towards the camera when given
   * @param {object} [settings] quality settings
   */
  constructor(scene, camera = null, settings = null) {
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    this.countScale = 1;
    this._lastDeath = -1;
    this._next = 0;

    const geometry = new THREE.BufferGeometry();
    this._start = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
    this._vel = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
    this._seed = new THREE.BufferAttribute(new Float32Array(POOL), 1);
    const birth = new Float32Array(POOL);
    birth.fill(-1000);
    this._birth = new THREE.BufferAttribute(birth, 1);
    this._color = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
    this._start.setUsage(THREE.DynamicDrawUsage);
    this._vel.setUsage(THREE.DynamicDrawUsage);
    this._seed.setUsage(THREE.DynamicDrawUsage);
    this._birth.setUsage(THREE.DynamicDrawUsage);
    this._color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this._start);
    geometry.setAttribute('aVelocity', this._vel);
    geometry.setAttribute('aSeed', this._seed);
    geometry.setAttribute('aBirth', this._birth);
    geometry.setAttribute('aColor', this._color);

    this.texture = makeStarTexture();
    this.material = new THREE.ShaderMaterial({
      name: 'Sparkles',
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 400 },
        uSize: { value: SIZE },
        uMap: { value: this.texture },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'Sparkles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, scene, cam) => {
      renderer.getDrawingBufferSize(_size);
      this.material.uniforms.uScale.value = cam.projectionMatrix.elements[5] * _size.y * 0.5;
    };
    scene.add(this.points);

    if (settings) this.setQuality(settings);
  }

  /** Low tier (no glints) gets half the sparkles per burst. */
  setQuality(settings) {
    this.countScale = settings && settings.glints === false ? 0.5 : 1;
  }

  /** Compile the program now (the points are hidden at startup). */
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

  _slot() {
    const i = this._next;
    this._next = (this._next + 1) % POOL;
    return i;
  }

  _write(i, x, y, z, vx, vy, vz, birth, color) {
    const s = this._start.array, v = this._vel.array, c = this._color.array;
    s[i * 3] = x; s[i * 3 + 1] = y; s[i * 3 + 2] = z;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    // variety: white and gold glints among the coloured ones (pink sparkles
    // alone vanish on pink polish)
    const k = Math.random();
    if (k < 0.3) {
      c[i * 3] = 1; c[i * 3 + 1] = 1; c[i * 3 + 2] = 1;
    } else if (k < 0.5) {
      c[i * 3] = 1; c[i * 3 + 1] = 0.86; c[i * 3 + 2] = 0.45;
    } else {
      c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b;
    }
    this._seed.array[i] = Math.random();
    this._birth.array[i] = birth;
    const death = birth + LIFE * 1.4;
    if (death > this._lastDeath) this._lastDeath = death;
  }

  _flush() {
    this._start.needsUpdate = true;
    this._vel.needsUpdate = true;
    this._seed.needsUpdate = true;
    this._birth.needsUpdate = true;
    this._color.needsUpdate = true;
    this.material.uniforms.uTime.value = this.time;
    this.points.visible = true;
  }

  _setColor(color) {
    if (color === undefined || color === null) _color.setRGB(1, 0.85, 0.95, THREE.SRGBColorSpace);
    else _color.set(color);
    // display values for the additive shader
    _color.convertLinearToSRGB();
    // keep sparkles bright: lift dark polish colours towards pastel
    const m = Math.max(_color.r, _color.g, _color.b, 1e-3);
    const k = m < 0.85 ? 0.85 / m : 1;
    _color.r = Math.min(1, _color.r * k);
    _color.g = Math.min(1, _color.g * k);
    _color.b = Math.min(1, _color.b * k);
    return _color;
  }

  /**
   * A pop of sparkles at a world position.
   * @param {THREE.Vector3} worldPos
   * @param {number} [count=24]
   * @param {THREE.ColorRepresentation} [color]
   * @param {THREE.Vector3} [normal] main direction (defaults to towards the camera)
   */
  burst(worldPos, count = 24, color, normal = null) {
    if (!worldPos) return;
    const n = Math.max(1, Math.min(POOL, Math.round(count * this.countScale)));
    const col = this._setColor(color);
    if (normal) _bias.copy(normal).normalize();
    else if (this.camera) _bias.copy(this.camera.position).sub(worldPos).normalize();
    else _bias.set(0, 1, 0);
    for (let k = 0; k < n; k++) {
      const i = this._slot();
      // random direction, leaning towards the bias so most sparkles are seen
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
      _v.normalize().addScaledVector(_bias, 0.7).normalize();
      const speed = 0.12 + Math.random() * 0.2;
      const j = 0.028;
      this._write(i,
        worldPos.x + (Math.random() - 0.5) * j, worldPos.y + (Math.random() - 0.5) * j, worldPos.z + (Math.random() - 0.5) * j,
        _v.x * speed, _v.y * speed, _v.z * speed,
        this.time + Math.random() * 0.06, col);
    }
    this._flush();
  }

  /**
   * Sparkles swept across a mesh's surface (left to right in its local x),
   * e.g. the reveal glint over a nail.
   * @param {THREE.Mesh} mesh
   * @param {number} [count=28]
   * @param {THREE.ColorRepresentation} [color]
   * @param {number} [duration=0.5] seconds for the sweep to cross the mesh
   */
  sweep(mesh, count = 28, color, duration = 0.5) {
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes.position) return;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const w = Math.max(1e-6, bb.max.x - bb.min.x);
    mesh.updateWorldMatrix(true, false);
    const n = Math.max(1, Math.min(POOL, Math.round(count * this.countScale)));
    const col = this._setColor(color);
    for (let k = 0; k < n; k++) {
      const vi = Math.floor(Math.random() * pos.count);
      _v.fromBufferAttribute(pos, vi);
      const delay = ((_v.x - bb.min.x) / w) * duration;
      _v.applyMatrix4(mesh.matrixWorld);
      if (this.camera) _bias.copy(this.camera.position).sub(_v).normalize();
      else _bias.set(0, 1, 0);
      const speed = 0.02 + Math.random() * 0.04;
      const i = this._slot();
      this._write(i, _v.x, _v.y, _v.z,
        (_bias.x + (Math.random() - 0.5)) * speed, (_bias.y + (Math.random() - 0.5)) * speed, (_bias.z + (Math.random() - 0.5)) * speed,
        this.time + delay, col);
    }
    this._flush();
  }

  /** True while at least one sparkle may be alive. */
  get alive() {
    return this._lastDeath >= 0;
  }

  /**
   * Advance time (loop dt). Free while nothing is alive.
   * @returns {boolean} true when the frame needs a render
   */
  update(dt) {
    if (this._lastDeath < 0) return false;
    this.time += dt;
    if (this.time > this._lastDeath) {
      this._lastDeath = -1;
      this.points.visible = false;
      return true;
    }
    this.material.uniforms.uTime.value = this.time;
    return true;
  }

  clear() {
    this._birth.array.fill(-1000);
    this._birth.needsUpdate = true;
    this._lastDeath = -1;
    this.points.visible = false;
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
