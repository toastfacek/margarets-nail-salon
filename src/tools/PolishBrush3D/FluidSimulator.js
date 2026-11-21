/**
 * FluidSimulator.js
 * GPU Stable Fluids in nail UV space. The dye texture IS the paint: the nail
 * shader samples it directly, so nothing is ever read back to the CPU.
 *
 * - No module-level state: several instances can coexist (WP9's swirl bowl).
 * - Every material is created once in the constructor. No shader is compiled
 *   after `prewarm()`.
 * - Splats are ONE small blended quad over the stroke capsule's bounding box,
 *   drawn straight into `dye.read` (no ping-pong, no full-screen pass).
 * - The sim sleeps: when nothing moves `isAwake()` is false and the caller
 *   skips `step()`, so idle cost is zero passes.
 * - Every pass saves and restores the renderer's target, autoClear and clear
 *   colour; no pass ever leaves a target bound.
 *
 * Dye texture contract: rgb = sRGB colour blended over black with the splat
 * alpha; a = coverage with a bristle-streak profile (max-blended).
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- shaders --

// Full-screen triangle; uv covers [0,1] on screen.
const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Unit quad mapped onto a UV rectangle (x0, y0, x1, y1) of the target.
const rectVertex = /* glsl */ `
uniform vec4 uRect;
varying vec2 vUv;
void main() {
  vUv = mix(uRect.xy, uRect.zw, uv);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const advectFragment = /* glsl */ `
precision highp float;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uSimTexel;   // 1 / simRes
uniform float uDt;
uniform float uDissipation;
varying vec2 vUv;
void main() {
  // velocity is stored in sim texels per second
  vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uSimTexel;
  gl_FragColor = uDissipation * texture2D(uSource, coord);
}
`;

const divergenceFragment = /* glsl */ `
precision highp float;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

const pressureFragment = /* glsl */ `
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float div = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + T + B - div) * 0.25, 0.0, 0.0, 1.0);
}
`;

const gradientFragment = /* glsl */ `
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  vec2 vel = texture2D(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

// Shared capsule maths for the two splat shaders.
const capsuleChunk = /* glsl */ `
uniform vec2 uA;
uniform vec2 uB;
uniform float uRadius;    // in aspect-corrected UV units (v units)
uniform float uAspect;    // u extent / v extent of the nail in world units
varying vec2 vUv;

// returns x = distance to segment, y = signed perpendicular coordinate
vec2 capsule(vec2 p) {
  vec2 s = vec2(uAspect, 1.0);
  vec2 pa = (p - uA) * s;
  vec2 ba = (uB - uA) * s;
  float len2 = dot(ba, ba);
  float h = len2 > 1e-10 ? clamp(dot(pa, ba) / len2, 0.0, 1.0) : 0.0;
  vec2 d = pa - ba * h;
  vec2 dir = len2 > 1e-10 ? ba * inversesqrt(len2) : vec2(1.0, 0.0);
  float perp = dir.x * pa.y - dir.y * pa.x;
  return vec2(length(d), perp);
}
`;

const dyeSplatFragment = /* glsl */ `
precision highp float;
${capsuleChunk}
uniform vec3 uColor;      // sRGB
uniform float uStrength;
uniform float uStreakFreq;
uniform float uSeed;
void main() {
  vec2 c = capsule(vUv);
  float edge = 1.0 - smoothstep(uRadius * 0.62, uRadius, c.x);
  if (edge <= 0.0) discard;
  float streak = 0.88 + 0.12 * sin(c.y * uStreakFreq + uSeed);
  gl_FragColor = vec4(uColor, clamp(edge * streak * uStrength, 0.0, 1.0));
}
`;

const velocitySplatFragment = /* glsl */ `
precision highp float;
${capsuleChunk}
uniform vec2 uForce;      // sim texels per second
void main() {
  vec2 c = capsule(vUv);
  float k = 1.0 - smoothstep(0.0, uRadius, c.x);
  if (k <= 0.0) discard;
  gl_FragColor = vec4(uForce * k * k, 0.0, 0.0);
}
`;

const copyFragment = /* glsl */ `
precision highp float;
uniform sampler2D uSource;
uniform vec4 uUvTransform; // xy scale, zw offset
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uSource, vUv * uUvTransform.xy + uUvTransform.zw);
}
`;

const fillFragment = /* glsl */ `
precision highp float;
uniform vec4 uValue;
void main() {
  gl_FragColor = uValue;
}
`;

// ----------------------------------------------------------------- config --

const DEFAULTS = Object.freeze({
  simRes: 128,
  dyeRes: 384,
  iterations: 4,
  dyeType: THREE.HalfFloatType,
  noFlow: false,
});

const VELOCITY_DISSIPATION = 0.82; // per step, frame-rate corrected by dt
const SLEEP_ENERGY = 1e-3;
const SLEEP_FRAMES = 30;

const IDENTITY_UV = Object.freeze([1, 1, 0, 0]);

function makeTarget(res, type, format, filter = THREE.LinearFilter) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type,
    format,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

class DoubleTarget {
  constructor(res, type, format) {
    this.read = makeTarget(res, type, format);
    this.write = makeTarget(res, type, format);
    this.res = res;
  }
  swap() {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  }
  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

export class FluidSimulator {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ simRes?: number, dyeRes?: number, iterations?: number, dyeType?: number, noFlow?: boolean }} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = Object.assign({}, DEFAULTS, typeof opts === 'number' ? { dyeRes: opts } : opts);

    this.energy = 0;
    this.framesSinceSplat = SLEEP_FRAMES;
    this.flowScale = 0.12; // UV speed -> injected velocity

    this._savedClear = new THREE.Color();
    this._simTexel = new THREE.Vector2();
    this._dyeTexel = new THREE.Vector2();

    // Geometry: one full-screen triangle and one unit quad, shared by all passes.
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
    quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this._triGeometry = tri;
    this._quadGeometry = quad;

    this._mesh = new THREE.Mesh(tri, null);
    this._mesh.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene.matrixWorldAutoUpdate = false;

    // All materials are created here, once. Nothing else creates a material.
    const base = { depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false };
    const simTexel = { value: this._simTexel };

    const advect = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidAdvect',
      vertexShader: fullscreenVertex,
      fragmentShader: advectFragment,
      uniforms: {
        uVelocity: { value: null },
        uSource: { value: null },
        uSimTexel: simTexel,
        uDt: { value: 0.016 },
        uDissipation: { value: 1 },
      },
    }, base));

    const divergence = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidDivergence',
      vertexShader: fullscreenVertex,
      fragmentShader: divergenceFragment,
      uniforms: { uVelocity: { value: null }, uTexel: simTexel },
    }, base));

    const pressure = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidPressure',
      vertexShader: fullscreenVertex,
      fragmentShader: pressureFragment,
      uniforms: { uPressure: { value: null }, uDivergence: { value: null }, uTexel: simTexel },
    }, base));

    const gradient = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidGradient',
      vertexShader: fullscreenVertex,
      fragmentShader: gradientFragment,
      uniforms: { uPressure: { value: null }, uVelocity: { value: null }, uTexel: simTexel },
    }, base));

    const capsuleUniforms = () => ({
      uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uA: { value: new THREE.Vector2() },
      uB: { value: new THREE.Vector2() },
      uRadius: { value: 0.05 },
      uAspect: { value: 1 },
    });

    const dyeSplatUniforms = capsuleUniforms();
    dyeSplatUniforms.uColor = { value: new THREE.Vector3(1, 0, 0.5) };
    dyeSplatUniforms.uStrength = { value: 1 };
    dyeSplatUniforms.uStreakFreq = { value: 380 };
    dyeSplatUniforms.uSeed = { value: 0 };
    const dyeSplat = new THREE.ShaderMaterial({
      name: 'FluidDyeSplat',
      vertexShader: rectVertex,
      fragmentShader: dyeSplatFragment,
      uniforms: dyeSplatUniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    const velUniforms = capsuleUniforms();
    velUniforms.uForce = { value: new THREE.Vector2() };
    const velocitySplat = new THREE.ShaderMaterial({
      name: 'FluidVelocitySplat',
      vertexShader: rectVertex,
      fragmentShader: velocitySplatFragment,
      uniforms: velUniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    const copy = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidCopy',
      vertexShader: fullscreenVertex,
      fragmentShader: copyFragment,
      uniforms: { uSource: { value: null }, uUvTransform: { value: new THREE.Vector4(1, 1, 0, 0) } },
    }, base));

    const fill = new THREE.ShaderMaterial(Object.assign({
      name: 'FluidFill',
      vertexShader: fullscreenVertex,
      fragmentShader: fillFragment,
      uniforms: { uValue: { value: new THREE.Vector4() } },
    }, base));

    this.materials = { advect, divergence, pressure, gradient, dyeSplat, velocitySplat, copy, fill };

    this._allocate(this.opts, null);
    this.clear();
  }

  // ------------------------------------------------------------ resources --

  /**
   * Check that a render-target format is complete on this GPU.
   */
  _validates(target) {
    const renderer = this.renderer;
    const prev = renderer.getRenderTarget();
    let ok = true;
    try {
      renderer.setRenderTarget(target);
      const gl = renderer.getContext();
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    } catch (err) {
      ok = false;
    }
    renderer.setRenderTarget(prev);
    return ok;
  }

  _makeDouble(res, type, preferred, fallback) {
    let d = new DoubleTarget(res, type, preferred);
    if (preferred !== fallback && !this._validates(d.read)) {
      d.dispose();
      d = new DoubleTarget(res, type, fallback);
    }
    return d;
  }

  _allocate(opts, oldDye) {
    const { simRes, dyeRes, iterations, dyeType, noFlow } = opts;
    const flow = !noFlow;

    this.velocity = flow ? this._makeDouble(simRes, THREE.HalfFloatType, THREE.RGFormat, THREE.RGBAFormat) : null;
    const needPressure = flow && iterations > 0;
    this.pressure = needPressure ? this._makeDouble(simRes, THREE.HalfFloatType, THREE.RedFormat, THREE.RGBAFormat) : null;
    this.divergence = null;
    if (needPressure) {
      this.divergence = makeTarget(simRes, THREE.HalfFloatType, this.pressure.read.texture.format);
    }

    this.dye = new DoubleTarget(dyeRes, dyeType, THREE.RGBAFormat);
    this.dye.read.texture.name = 'FluidDye';
    this.dye.write.texture.name = 'FluidDye';
    if (dyeType !== THREE.UnsignedByteType && !this._validates(this.dye.read)) {
      this.dye.dispose();
      this.dye = new DoubleTarget(dyeRes, THREE.UnsignedByteType, THREE.RGBAFormat);
    }

    this._simTexel.set(1 / simRes, 1 / simRes);
    this._dyeTexel.set(1 / dyeRes, 1 / dyeRes);

    this._clearTarget(this.dye.read);
    this._clearTarget(this.dye.write);
    if (oldDye) this.blit(oldDye.texture, this.dye.read);
    if (this.velocity) {
      this._clearTarget(this.velocity.read);
      this._clearTarget(this.velocity.write);
    }
    if (this.pressure) {
      this._clearTarget(this.pressure.read);
      this._clearTarget(this.pressure.write);
      this._clearTarget(this.divergence);
    }
  }

  _disposeTargets() {
    if (this.velocity) this.velocity.dispose();
    if (this.pressure) this.pressure.dispose();
    if (this.divergence) this.divergence.dispose();
    this.velocity = this.pressure = this.divergence = null;
  }

  /**
   * Reallocate for new quality settings, preserving the dye by blit.
   */
  setQuality(opts) {
    const next = Object.assign({}, this.opts, opts);
    const same = next.simRes === this.opts.simRes && next.dyeRes === this.opts.dyeRes &&
      next.iterations === this.opts.iterations && next.dyeType === this.opts.dyeType &&
      next.noFlow === this.opts.noFlow;
    if (same) return false;
    const oldDye = this.dye;
    this._disposeTargets();
    this.opts = next;
    this._allocate(next, oldDye.read);
    oldDye.dispose();
    this.energy = 0;
    this.framesSinceSplat = SLEEP_FRAMES;
    return true;
  }

  // ---------------------------------------------------------------- passes --

  _begin(target) {
    const r = this.renderer;
    this._prevTarget = r.getRenderTarget();
    this._prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(target);
  }

  _end() {
    const r = this.renderer;
    r.setRenderTarget(this._prevTarget);
    r.autoClear = this._prevAutoClear;
    this._prevTarget = null;
  }

  /**
   * Render one pass into `target`. Saves and restores target and autoClear.
   */
  renderPass(material, target, geometry = this._triGeometry) {
    this._begin(target);
    this._mesh.geometry = geometry;
    this._mesh.material = material;
    this.renderer.render(this._scene, this._camera);
    this._end();
  }

  _clearTarget(target) {
    if (!target) return;
    const r = this.renderer;
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this._savedClear);
    this._begin(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    this._end();
    r.setClearColor(this._savedClear, prevAlpha);
  }

  _setCapsule(u, ax, ay, bx, by, radius, aspect) {
    // Bounding box of the capsule in plain UV (radius is in v units).
    const ru = radius / Math.max(aspect, 1e-3);
    const rv = radius;
    u.uRect.value.set(
      Math.max(0, Math.min(ax, bx) - ru),
      Math.max(0, Math.min(ay, by) - rv),
      Math.min(1, Math.max(ax, bx) + ru),
      Math.min(1, Math.max(ay, by) + rv)
    );
    u.uA.value.set(ax, ay);
    u.uB.value.set(bx, by);
    u.uRadius.value = radius;
    u.uAspect.value = aspect;
  }

  /**
   * Paint one stroke segment (a capsule from A to B) straight into the dye.
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by  UV
   * @param {number} radius in aspect-corrected UV (v) units
   * @param {{r:number,g:number,b:number}|THREE.Vector3} color sRGB 0..1 (x/y/z or r/g/b)
   * @param {number} strength 0..1
   * @param {number} aspect nail u/v world aspect
   * @param {number} [seed] streak phase
   */
  splatSegment(ax, ay, bx, by, radius, color, strength, aspect, seed = 0) {
    const m = this.materials.dyeSplat;
    const u = m.uniforms;
    this._setCapsule(u, ax, ay, bx, by, radius, aspect);
    if (color.isVector3) u.uColor.value.copy(color);
    else u.uColor.value.set(color.r, color.g, color.b);
    u.uStrength.value = strength;
    u.uSeed.value = seed;
    u.uStreakFreq.value = 2 * Math.PI * 9 / (2 * radius); // about nine streaks across the brush
    const rect = u.uRect.value;
    if (rect.z <= rect.x || rect.w <= rect.y) return;
    this.renderPass(m, this.dye.read, this._quadGeometry);
    this.framesSinceSplat = 0;
  }

  /**
   * Push the fluid along a stroke segment (additive into velocity.read).
   * @param {number} vx @param {number} vy stroke velocity in UV per second
   */
  splatVelocity(ax, ay, bx, by, radius, vx, vy, aspect) {
    if (!this.velocity) return;
    const m = this.materials.velocitySplat;
    const u = m.uniforms;
    this._setCapsule(u, ax, ay, bx, by, radius * 1.4, aspect);
    const res = this.opts.simRes;
    const fx = vx * res * this.flowScale;
    const fy = vy * res * this.flowScale;
    u.uForce.value.set(fx, fy);
    const rect = u.uRect.value;
    if (rect.z <= rect.x || rect.w <= rect.y) return;
    this.renderPass(m, this.velocity.read, this._quadGeometry);
    const speed = Math.sqrt(vx * vx + vy * vy) * this.flowScale;
    if (speed > this.energy) this.energy = speed;
    this.framesSinceSplat = 0;
  }

  isAwake() {
    if (!this.velocity) return false;
    return this.energy > SLEEP_ENERGY || this.framesSinceSplat < SLEEP_FRAMES;
  }

  /**
   * Advance the simulation. The caller skips this while !isAwake().
   * After a step the dye texture object changes (swap): re-read getTexture().
   * @param {number} dt seconds
   */
  step(dt) {
    if (!this.velocity) return;
    if (dt > 0.033) dt = 0.033;
    if (dt <= 0) return;
    const decay = 1 / (1 + (1 - VELOCITY_DISSIPATION) * 60 * dt);

    const advect = this.materials.advect;
    const au = advect.uniforms;

    // 1. advect velocity
    au.uVelocity.value = this.velocity.read.texture;
    au.uSource.value = this.velocity.read.texture;
    au.uDt.value = dt;
    au.uDissipation.value = decay;
    this.renderPass(advect, this.velocity.write);
    this.velocity.swap();

    // 2. advect dye (paint never fades)
    au.uVelocity.value = this.velocity.read.texture;
    au.uSource.value = this.dye.read.texture;
    au.uDissipation.value = 1;
    this.renderPass(advect, this.dye.write);
    this.dye.swap();

    // 3. projection (skipped on low)
    const iterations = this.opts.iterations;
    if (iterations > 0 && this.pressure) {
      const div = this.materials.divergence;
      div.uniforms.uVelocity.value = this.velocity.read.texture;
      this.renderPass(div, this.divergence);

      // Warm start from the previous pressure (no clear pass).
      const pm = this.materials.pressure;
      pm.uniforms.uDivergence.value = this.divergence.texture;
      for (let i = 0; i < iterations; i++) {
        pm.uniforms.uPressure.value = this.pressure.read.texture;
        this.renderPass(pm, this.pressure.write);
        this.pressure.swap();
      }

      const gm = this.materials.gradient;
      gm.uniforms.uPressure.value = this.pressure.read.texture;
      gm.uniforms.uVelocity.value = this.velocity.read.texture;
      this.renderPass(gm, this.velocity.write);
      this.velocity.swap();
    }

    this.energy *= decay;
    this.framesSinceSplat++;
  }

  // ------------------------------------------------------------- dye i/o --

  /** The current paint texture (changes object after every step). */
  getTexture() {
    return this.dye.read.texture;
  }

  /**
   * Copy a texture into a target (optionally with a uv transform: scale xy, offset zw).
   * Used for dye load/save and by WP9.
   */
  blit(srcTexture, dstTarget, uvTransform = null) {
    const m = this.materials.copy;
    m.uniforms.uSource.value = srcTexture;
    const t = uvTransform || IDENTITY_UV;
    if (t.isVector4) m.uniforms.uUvTransform.value.copy(t);
    else m.uniforms.uUvTransform.value.set(t[0], t[1], t[2], t[3]);
    this.renderPass(m, dstTarget);
    m.uniforms.uSource.value = null;
  }

  /** Replace the dye with a texture (or clear it) and reset the flow. */
  loadDye(texture) {
    if (texture) this.blit(texture, this.dye.read);
    else this._clearTarget(this.dye.read);
    this._resetFlow();
  }

  /** Copy the dye into a nail's baked target. */
  saveDye(target) {
    if (!target) return;
    this.blit(this.dye.read.texture, target);
  }

  /** Fill the whole dye with one colour (sRGB 0..1) and alpha. */
  fill(color, alpha = 1) {
    const m = this.materials.fill;
    if (color.isVector3) m.uniforms.uValue.value.set(color.x, color.y, color.z, alpha);
    else m.uniforms.uValue.value.set(color.r, color.g, color.b, alpha);
    this.renderPass(m, this.dye.read);
    this._resetFlow();
  }

  _resetFlow() {
    if (this.velocity) {
      this._clearTarget(this.velocity.read);
      this._clearTarget(this.velocity.write);
    }
    if (this.pressure) {
      this._clearTarget(this.pressure.read);
      this._clearTarget(this.pressure.write);
    }
    this.energy = 0;
    this.framesSinceSplat = SLEEP_FRAMES;
  }

  /** Clear dye and flow. */
  clear() {
    this._clearTarget(this.dye.read);
    this._clearTarget(this.dye.write);
    this._resetFlow();
  }

  /**
   * Compile every pass program now (render each material once into a 1x1
   * target) so no shader compiles on the first stroke.
   */
  prewarm() {
    const tiny = makeTarget(1, this.dye.read.texture.type, THREE.RGBAFormat);
    const m = this.materials;
    const tex = this.dye.read.texture;
    const prevAdvect = [m.advect.uniforms.uVelocity.value, m.advect.uniforms.uSource.value];
    m.advect.uniforms.uVelocity.value = tex;
    m.advect.uniforms.uSource.value = tex;
    this.renderPass(m.advect, tiny);
    m.advect.uniforms.uVelocity.value = prevAdvect[0];
    m.advect.uniforms.uSource.value = prevAdvect[1];
    this.renderPass(m.divergence, tiny);
    this.renderPass(m.pressure, tiny);
    this.renderPass(m.gradient, tiny);
    this._setCapsule(m.dyeSplat.uniforms, 0.5, 0.5, 0.5, 0.5, 0.1, 1);
    m.dyeSplat.uniforms.uStrength.value = 0;
    this.renderPass(m.dyeSplat, tiny, this._quadGeometry);
    this._setCapsule(m.velocitySplat.uniforms, 0.5, 0.5, 0.5, 0.5, 0.1, 1);
    m.velocitySplat.uniforms.uForce.value.set(0, 0);
    this.renderPass(m.velocitySplat, tiny, this._quadGeometry);
    this.blit(tex, tiny);
    this.renderPass(m.fill, tiny);
    tiny.dispose();
  }

  /** Recreate GPU state after a context restore (paint is lost). */
  onContextRestored() {
    this.clear();
  }

  dispose() {
    this._disposeTargets();
    if (this.dye) this.dye.dispose();
    this.dye = null;
    Object.values(this.materials).forEach((mat) => mat.dispose());
    this._triGeometry.dispose();
    this._quadGeometry.dispose();
  }
}
