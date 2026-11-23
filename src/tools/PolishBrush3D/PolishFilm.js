/**
 * PolishFilm.js
 * The wet polish film on the active nail (brush plan B2). Replaces the
 * smoke-style fluid sim for the brush (the swirl bowl keeps FluidSimulator).
 *
 * Two textures, both in nail UV space:
 *
 *   dye   (dyeRes, dyeType)  the paint. Same contract as FluidSimulator's dye:
 *         PREMULTIPLIED sRGB colour, alpha = coverage, Porter-Duff "over".
 *         One brush pass lays `coat` alpha (COAT_ALPHA 0.62 in the engine), so
 *         coats are sheer and build: 0.62, 0.86, 0.95.
 *   film  (filmRes, RG8; none when filmRes === 0, i.e. low tier)
 *         R = relief height 0..1 (0 = flat): fine bristle ridges running along
 *             the stroke, a thicker rim, the landing bead.
 *         G = freshness 0..1 (1 = just laid, decays over ~1.6 s).
 *         The levelling pass (tick) melts the ridges and flattens the film.
 *
 * Deposits are segments of a rounded box swept along the stroke, laid as one
 * band exactly as wide as the bristle fan. Up to 16 segments are batched into
 * one draw per target (flush). Consecutive segments of one stroke TILE: they
 * share a hard clip line through the shared sample, so a sheer or dry stroke
 * shows no darker dots where segments meet.
 *
 * Units: A/B are nail UV (0..1). axis, seam, hw, hl are in nail-plane units:
 * UV scaled by (aspect, 1) (the "v units" of the old splat radius). Call
 * setAspect() on every bind.
 *
 * Rules kept from FluidSimulator: every material is built in the constructor,
 * prewarm() compiles them, every pass saves/restores the renderer's target and
 * autoClear, nothing allocates in addSegment/flush/tick, idle = zero passes.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- shaders --

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// One quad per queued segment, placed on the segment's bounding box.
const segmentVertex = /* glsl */ `
uniform float uAspect;
uniform vec2 uTexel;
attribute vec4 aAB;      // A.xy, B.xy in UV
attribute vec4 aFrame;   // axis.xy (plane units, unit), hw, hl (plane units)
attribute vec4 aSeam;    // seam.xy (unit, plane units), flags, coat
attribute vec2 aExtra;   // dry, bead
flat varying vec4 vAB;
flat varying vec4 vFrame;
flat varying vec4 vSeam;
flat varying vec2 vExtra;
void main() {
  vAB = aAB;
  vFrame = aFrame;
  vSeam = aSeam;
  vExtra = aExtra;
  vec2 s = vec2(uAspect, 1.0);
  vec2 A = aAB.xy * s;
  vec2 B = aAB.zw * s;
  vec2 ex = aFrame.xy;
  vec2 ey = vec2(-ex.y, ex.x);
  // box + edge wobble + cap jitter + 3 texels
  vec2 ext = abs(ex) * aFrame.z * 1.1 + abs(ey) * aFrame.w * 1.35 + uTexel * s * 3.0;
  vec2 P = mix(min(A, B) - ext, max(A, B) + ext, position.xy);
  gl_Position = vec4(P / s * 2.0 - 1.0, 0.0, 1.0);
}
`;

const segmentFragment = /* glsl */ `
precision highp float;
uniform float uAspect;
uniform vec2 uTexel;     // 1 / target size
uniform vec3 uColor;     // sRGB, straight
uniform float uSeed;
flat varying vec4 vAB;
flat varying vec4 vFrame;
flat varying vec4 vSeam;
flat varying vec2 vExtra;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}
float noise2(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Fine bristle ridges across the band (s = -1..1): about 14 lines, irregular.
float ridge(float s) {
  float x = s * 6.5 + 0.9 * noise1(s * 3.0 + uSeed * 7.0);
  float r = 0.5 + 0.30 * sin(6.2832 * x + uSeed)
                + 0.14 * sin(6.2832 * 1.618 * x + 2.3 * uSeed)
                + 0.36 * (noise1(x * 2.0 + uSeed * 5.0) - 0.5);
  return clamp(r, 0.0, 1.0);
}

void main() {
  vec2 sc = vec2(uAspect, 1.0);
  // Exact pixel centre: both sides of a shared clip line see the same P.
  vec2 P = gl_FragCoord.xy * uTexel * sc;
  vec2 A = vAB.xy * sc;
  vec2 B = vAB.zw * sc;
  vec2 dq = B - A;
  float len2 = dot(dq, dq);
  int flags = int(vSeam.z + 0.5);
#ifdef FILM
  // The film is "replace", not "over", so it needs no tiling: each segment
  // runs past its end and the next one fades in over 3 texels at the seam.
  // (Earlier film has levelled a little; a hard seam would show as a line.)
  float seamFade = 1.0;
  if ((flags & 1) != 0) {
    float ds = dot(P - A, vSeam.xy);
    if (ds < 0.0) discard;
    seamFade = smoothstep(0.0, 3.0 * max(uTexel.x * uAspect, uTexel.y), ds);
  }
#else
  // Tiling clips (hard, no AA: the two sides partition pixels exactly).
  if ((flags & 1) != 0 && dot(P - A, vSeam.xy) < 0.0) discard;
  if ((flags & 2) != 0 && len2 > 1e-14 && dot(P - B, dq) > 0.0) discard;
#endif

  vec2 ex = vFrame.xy;
  vec2 ey = vec2(-ex.y, ex.x);
  float hw = vFrame.z;
  float hl = vFrame.w;
  vec2 q0 = P - A;
  vec2 q = vec2(dot(q0, ex), dot(q0, ey));
  vec2 d = vec2(dot(dq, ex), dot(dq, ey));

  // Across-band coordinate (constant along the motion).
  float tau = len2 > 1e-14 ? clamp(dot(q, d) / len2, 0.0, 1.0) : 0.0;
  float s = (q.x - d.x * tau) / max(hw, 1e-6);

  // Soft, irregular edge: the half width wobbles with the bristle tips
  // (low-frequency noise in plane position, continuous across segments).
  float bw = 2.0 * hw;
  float wob = noise2(P / bw * 1.3 + uSeed * 3.7) * 0.7 + noise2(P / bw * 4.1 - uSeed) * 0.3;
  float r = min(hl, 0.35 * hw);
  float hx = (hw - r) * (1.0 + 0.16 * (wob - 0.5));
  float hy = max(hl - r, 0.0);

  float m1 = abs(q.x - d.x * 0.5) - (hx + abs(d.x) * 0.5);
  float m2 = abs(q.y - d.y * 0.5) - (hy + abs(d.y) * 0.5);
  float sd = max(m1, m2);
  if (len2 > 1e-14) {
    vec2 nd = vec2(-d.y, d.x) * inversesqrt(len2);
    float m3 = abs(dot(q - d * 0.5, nd)) - (hx * abs(nd.x) + hy * abs(nd.y));
    sd = max(sd, m3);
  }
  sd -= r;
  // Caps (landing / lift): bristle ends push the outline in and out.
  if ((flags & 12) != 0) sd += 0.25 * hl * (noise1(s * 9.0 + uSeed * 2.0) - 0.5) * 2.0;

  float aa = 1.25 * max(uTexel.x * uAspect, uTexel.y);
  float mask = 1.0 - smoothstep(-aa, aa, sd);
  if (mask <= 0.0) discard;

  float rg = ridge(s);
  // Bristles touch unevenly: each line fades in and out along the stroke.
  float lineAmp = smoothstep(0.15, 0.75, noise2(vec2(s * 9.0, 0.0) + P / bw * vec2(1.7, 1.7) + uSeed));
  rg = mix(0.45, rg, 0.35 + 0.65 * lineAmp);
  float dry = vExtra.x;
  // Dry brush: gaps open between bristle clumps (about half coverage at dry = 1).
  float clump = noise1(s * 9.0 + uSeed * 11.0) * 0.65 + noise1(s * 23.0 - uSeed) * 0.35;
  float gate = smoothstep(0.5 * dry - 0.12, 0.5 * dry + 0.12, clump);
  float body = mix(1.0, gate, dry);
#ifdef FILM
  float rim = smoothstep(0.72, 1.0, abs(s));
  float dome = smoothstep(0.0, 1.0, -sd / max(min(hw, hl * 2.0), 1e-6));
  float h = (0.28 + 0.50 * rg + 0.30 * rim) * body + 0.5 * vExtra.y * dome;
  gl_FragColor = vec4(min(h, 1.0), 1.0, 0.0, mask * seamFade);
#else
  float a = mask * body * vSeam.w * (0.94 + 0.06 * rg);
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
#endif
}
`;

// Levelling: ridges melt (blur), the film flattens and loses its fresh gloss.
// The flattening rate follows the film's own age (G): slow while fresh, fast
// after about half a second, so a stroke keeps its brush lines briefly and
// then melts smooth within about a second (an S-curve, not an exponential).
// The -0.6/255 bias guarantees 8-bit values reach 0 (rounding would stall them).
const levelFragment = /* glsl */ `
precision highp float;
uniform sampler2D uFilm;
uniform vec2 uTexel;
uniform float uBlurK;
uniform float uDt;
uniform float uFreshDecay;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(uFilm, vUv).rg;
  float b = c.r
    + texture2D(uFilm, vUv + vec2(uTexel.x, 0.0)).r
    + texture2D(uFilm, vUv - vec2(uTexel.x, 0.0)).r
    + texture2D(uFilm, vUv + vec2(0.0, uTexel.y)).r
    + texture2D(uFilm, vUv - vec2(0.0, uTexel.y)).r;
  float rate = LEVEL_SLOW + LEVEL_FAST * (1.0 - smoothstep(0.55, 0.95, c.g));
  float h = mix(c.r, b * 0.2, uBlurK) * exp(-uDt * rate) - 0.0024;
  float g = c.g * uFreshDecay - 0.0024;
  gl_FragColor = vec4(max(h, 0.0), max(g, 0.0), 0.0, 1.0);
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
  dyeRes: 384,
  dyeType: THREE.HalfFloatType,
  filmRes: 192,
});

export const MAX_SEGMENTS = 16;
export const SEG_FLAGS = Object.freeze({ CLIP_START: 1, CLIP_END: 2, CAP_START: 4, CAP_END: 8 });

const AWAKE_SECONDS = 6;       // levelling runs this long after the last deposit
const BLUR_TAU = 0.40;         // s: ridge melt rate (blur mix per frame = 1 - exp(-dt / tau))
const LEVEL_SLOW = 0.15;       // 1/s: flattening while fresh (G > 0.95)
const LEVEL_FAST = 4.0;        // 1/s: extra flattening once G < 0.55 (about 0.9 s old)
const FRESH_TAU = 1.6;         // s: local fresh gloss fades

const IDENTITY_UV = Object.freeze([1, 1, 0, 0]);

function makeTarget(res, type, format) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type,
    format,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

const overBlend = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendEquationAlpha: THREE.AddEquation,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

export class PolishFilm {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ dyeRes?: number, dyeType?: number, filmRes?: number }} [opts]
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = Object.assign({}, DEFAULTS, opts);
    this.aspect = 1;

    this.sinceDeposit = AWAKE_SECONDS;
    this.queued = 0;
    this.drawCalls = 0;      // off-screen draws since the last resetCounters() (harness)
    this.levelPasses = 0;

    this._savedClear = new THREE.Color();
    this._dyeTexel = new THREE.Vector2();
    this._filmTexel = new THREE.Vector2();
    this._prevTarget = null;
    this._prevAutoClear = true;

    // Geometry: full-screen triangle, and the segment batch (16 quads).
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._triGeometry = tri;

    const n = MAX_SEGMENTS * 4;
    const corners = new Float32Array(n * 3);
    const index = new Uint16Array(MAX_SEGMENTS * 6);
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const v = i * 4;
      corners.set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], v * 3);
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const seg = new THREE.BufferGeometry();
    seg.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    seg.setIndex(new THREE.BufferAttribute(index, 1));
    this._ab = new Float32Array(n * 4);
    this._frame = new Float32Array(n * 4);
    this._seam = new Float32Array(n * 4);
    this._extra = new Float32Array(n * 2);
    const dyn = (arr, size) => {
      const a = new THREE.BufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    seg.setAttribute('aAB', dyn(this._ab, 4));
    seg.setAttribute('aFrame', dyn(this._frame, 4));
    seg.setAttribute('aSeam', dyn(this._seam, 4));
    seg.setAttribute('aExtra', dyn(this._extra, 2));
    seg.setDrawRange(0, 0);
    this._segGeometry = seg;

    this._mesh = new THREE.Mesh(tri, null);
    this._mesh.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
    this._scene.matrixWorldAutoUpdate = false;
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // All materials are created here, once.
    const base = { depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false };
    const aspect = { value: 1 };
    const seed = { value: 0 };
    const color = { value: new THREE.Vector3(1, 0, 0.5) };

    const depositDye = new THREE.ShaderMaterial(Object.assign({
      name: 'FilmDepositDye',
      vertexShader: segmentVertex,
      fragmentShader: segmentFragment,
      uniforms: { uAspect: aspect, uTexel: { value: this._dyeTexel }, uColor: color, uSeed: seed },
    }, overBlend));
    const depositFilm = new THREE.ShaderMaterial(Object.assign({
      name: 'FilmDepositRelief',
      vertexShader: segmentVertex,
      fragmentShader: segmentFragment,
      defines: { FILM: '' },
      uniforms: { uAspect: aspect, uTexel: { value: this._filmTexel }, uColor: color, uSeed: seed },
    }, overBlend));
    const level = new THREE.ShaderMaterial(Object.assign({
      name: 'FilmLevel',
      vertexShader: fullscreenVertex,
      fragmentShader: levelFragment,
      defines: { LEVEL_SLOW: LEVEL_SLOW.toFixed(3), LEVEL_FAST: LEVEL_FAST.toFixed(3) },
      uniforms: {
        uFilm: { value: null },
        uTexel: { value: this._filmTexel },
        uBlurK: { value: 0 },
        uDt: { value: 0 },
        uFreshDecay: { value: 1 },
      },
    }, base));
    const copy = new THREE.ShaderMaterial(Object.assign({
      name: 'FilmCopy',
      vertexShader: fullscreenVertex,
      fragmentShader: copyFragment,
      uniforms: { uSource: { value: null }, uUvTransform: { value: new THREE.Vector4(1, 1, 0, 0) } },
    }, base));
    const fill = new THREE.ShaderMaterial(Object.assign({
      name: 'FilmFill',
      vertexShader: fullscreenVertex,
      fragmentShader: fillFragment,
      uniforms: { uValue: { value: new THREE.Vector4() } },
    }, base));
    this.materials = { depositDye, depositFilm, level, copy, fill };
    this._uAspect = aspect;
    this._uSeed = seed;
    this._uColor = color;

    this.dye = null;
    this.film = null;   // { read, write } or null on low
    this._allocate(this.opts, null);
  }

  // ------------------------------------------------------------ resources --

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

  _allocDye(res, type, oldTexture) {
    let dye = makeTarget(res, type, THREE.RGBAFormat);
    if (type !== THREE.UnsignedByteType && !this._validates(dye)) {
      dye.dispose();
      dye = makeTarget(res, THREE.UnsignedByteType, THREE.RGBAFormat);
    }
    dye.texture.name = 'PolishDye';
    this.dye = dye;
    this._dyeTexel.set(1 / res, 1 / res);
    this._clearTarget(dye);
    if (oldTexture) this.blit(oldTexture, dye);
  }

  _allocFilm(res) {
    this.film = null;
    if (!res) return;
    let format = THREE.RGFormat;
    let read = makeTarget(res, THREE.UnsignedByteType, format);
    if (!this._validates(read)) {
      read.dispose();
      format = THREE.RGBAFormat;
      read = makeTarget(res, THREE.UnsignedByteType, format);
    }
    const write = makeTarget(res, THREE.UnsignedByteType, format);
    read.texture.name = write.texture.name = 'PolishFilm';
    this.film = { read, write };
    this._filmTexel.set(1 / res, 1 / res);
    this._clearTarget(read);
    this._clearTarget(write);
  }

  _allocate(opts, oldDye) {
    this._allocDye(opts.dyeRes, opts.dyeType, oldDye ? oldDye.texture : null);
    this._allocFilm(opts.filmRes | 0);
  }

  _disposeFilm() {
    if (!this.film) return;
    this.film.read.dispose();
    this.film.write.dispose();
    this.film = null;
  }

  /**
   * Reallocate for new quality settings, preserving the dye by blit (the
   * transient film starts flat). Returns true when a texture object changed:
   * re-read getTexture() and getFilmTexture().
   */
  setQuality(opts) {
    const next = Object.assign({}, this.opts, opts);
    const dyeSame = next.dyeRes === this.opts.dyeRes && next.dyeType === this.opts.dyeType;
    const filmSame = (next.filmRes | 0) === (this.opts.filmRes | 0);
    if (dyeSame && filmSame) return false;
    this.flush();
    this.opts = next;
    if (!dyeSame) {
      const old = this.dye;
      this._allocDye(next.dyeRes, next.dyeType, old.texture);
      old.dispose();
    }
    if (!filmSame) {
      this._disposeFilm();
      this._allocFilm(next.filmRes | 0);
      this.sinceDeposit = AWAKE_SECONDS;
    }
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

  /** Render one pass into `target`. Saves and restores target and autoClear. */
  renderPass(material, target, geometry = this._triGeometry) {
    this._begin(target);
    this._mesh.geometry = geometry;
    this._mesh.material = material;
    this.renderer.render(this._scene, this._camera);
    this._end();
    this.drawCalls++;
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

  // ------------------------------------------------------------- strokes --

  /** Nail u/v world aspect of the bound nail (plane units = UV * (aspect, 1)). */
  setAspect(aspect) {
    if (aspect > 0 && aspect !== this._uAspect.value) {
      this.flush();
      this._uAspect.value = aspect;
      this.aspect = aspect;
    }
  }

  /**
   * Start a stroke: its colour (sRGB 0..1: Vector3 or {r,g,b}) and the seed
   * that phases its bristle ridges. Flushes anything still queued.
   * @param {number} [aspect] optional, same as setAspect()
   */
  beginStroke(colorSRGB, seed = 0, aspect = 0) {
    this.flush();
    if (aspect) this.setAspect(aspect);
    const c = this._uColor.value;
    if (colorSRGB.isVector3) c.copy(colorSRGB);
    else c.set(colorSRGB.r, colorSRGB.g, colorSRGB.b);
    this._uSeed.value = seed % 6.2831853;
  }

  /**
   * Queue one band segment (drawn by flush(); flushes itself when 16 are queued).
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by  UV
   * @param {number} axisX @param {number} axisY  unit brush-width direction, plane units
   * @param {number} hw half width, plane units   @param {number} hl half contact length
   * @param {number} seamX @param {number} seamY  unit direction of the previous segment (bit0 clip)
   * @param {number} flags bit0 clip at start seam, bit1 clip at end, bit2 landing cap, bit3 lift cap
   * @param {number} dryA @param {number} dryB  0 loaded .. 1 dry (at A and B; the band uses the mean)
   * @param {number} bead 0..1 extra relief (landing / pooling)
   * @param {number} coat alpha of one pass (caps: pass 0.5 * coat)
   */
  addSegment(ax, ay, bx, by, axisX, axisY, hw, hl, seamX, seamY, flags, dryA, dryB, bead, coat) {
    if (!(hw > 0) || !(hl > 0)) return;
    if (this.queued >= MAX_SEGMENTS) this.flush();
    const i = this.queued++;
    const il = 1 / (Math.sqrt(axisX * axisX + axisY * axisY) || 1);
    axisX *= il;
    axisY *= il;
    const dry = 0.5 * (dryA + dryB);
    const ab = this._ab;
    const fr = this._frame;
    const se = this._seam;
    const ex = this._extra;
    for (let k = 0; k < 4; k++) {
      const v4 = (i * 4 + k) * 4;
      ab[v4] = ax; ab[v4 + 1] = ay; ab[v4 + 2] = bx; ab[v4 + 3] = by;
      fr[v4] = axisX; fr[v4 + 1] = axisY; fr[v4 + 2] = hw; fr[v4 + 3] = hl;
      se[v4] = seamX; se[v4 + 1] = seamY; se[v4 + 2] = flags; se[v4 + 3] = coat;
      const v2 = (i * 4 + k) * 2;
      ex[v2] = dry; ex[v2 + 1] = bead;
    }
  }

  /** Draw everything queued: one draw into the dye, one into the film (none on low). */
  flush() {
    const n = this.queued;
    if (n === 0) return;
    this.queued = 0;
    const g = this._segGeometry;
    const a = g.attributes;
    const v = n * 4;
    this._mark(a.aAB, v * 4);
    this._mark(a.aFrame, v * 4);
    this._mark(a.aSeam, v * 4);
    this._mark(a.aExtra, v * 2);
    g.setDrawRange(0, n * 6);
    this.renderPass(this.materials.depositDye, this.dye, g);
    if (this.film) this.renderPass(this.materials.depositFilm, this.film.read, g);
    this.sinceDeposit = 0;
  }

  _mark(attr, count) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
  }

  /**
   * Levelling, one pass while awake (6 s after the last deposit). Returns true
   * while it still needs frames; after a true, the film texture object changed:
   * re-read getFilmTexture().
   * @param {number} dt seconds
   */
  tick(dt) {
    if (this.sinceDeposit >= AWAKE_SECONDS) return false;
    if (!(dt > 0)) return true;
    if (dt > 0.1) dt = 0.1;
    this.sinceDeposit += dt;
    if (!this.film) return this.sinceDeposit < AWAKE_SECONDS;
    const m = this.materials.level;
    const u = m.uniforms;
    u.uFilm.value = this.film.read.texture;
    u.uBlurK.value = 1 - Math.exp(-dt / BLUR_TAU);
    u.uDt.value = dt;
    u.uFreshDecay.value = Math.exp(-dt / FRESH_TAU);
    this.renderPass(m, this.film.write);
    u.uFilm.value = null;
    const t = this.film.read;
    this.film.read = this.film.write;
    this.film.write = t;
    this.levelPasses++;
    return true;
  }

  isAwake() {
    return this.sinceDeposit < AWAKE_SECONDS;
  }

  // ------------------------------------------------------------- dye i/o --

  /** The paint texture (premultiplied "over", see header). */
  getTexture() {
    return this.dye.texture;
  }

  /** Relief/freshness texture (R/G), null on low. Changes object after tick(). */
  getFilmTexture() {
    return this.film ? this.film.read.texture : null;
  }

  /** Copy a texture into a target (optional uv transform: scale xy, offset zw). */
  blit(srcTexture, dstTarget, uvTransform = null) {
    const m = this.materials.copy;
    m.uniforms.uSource.value = srcTexture;
    const t = uvTransform || IDENTITY_UV;
    if (t.isVector4) m.uniforms.uUvTransform.value.copy(t);
    else m.uniforms.uUvTransform.value.set(t[0], t[1], t[2], t[3]);
    this.renderPass(m, dstTarget);
    m.uniforms.uSource.value = null;
  }

  _flatFilm() {
    this.queued = 0;
    if (this.film) {
      this._clearTarget(this.film.read);
      this._clearTarget(this.film.write);
    }
    this.sinceDeposit = AWAKE_SECONDS;
  }

  /** Replace the dye with a texture (or clear it); the film starts flat. */
  loadDye(texture) {
    this._flatFilm();
    if (texture) this.blit(texture, this.dye);
    else this._clearTarget(this.dye);
  }

  /** Copy the dye into a nail's baked target. */
  saveDye(target) {
    if (!target) return;
    this.flush();
    this.blit(this.dye.texture, target);
  }

  /** Fill the whole dye with one colour (sRGB 0..1) and alpha (written premultiplied). */
  fill(color, alpha = 1) {
    this._flatFilm();
    const m = this.materials.fill;
    if (color.isVector3) m.uniforms.uValue.value.set(color.x * alpha, color.y * alpha, color.z * alpha, alpha);
    else m.uniforms.uValue.value.set(color.r * alpha, color.g * alpha, color.b * alpha, alpha);
    this.renderPass(m, this.dye);
  }

  /** Clear dye and film. */
  clear() {
    this._flatFilm();
    this._clearTarget(this.dye);
  }

  /** Compile every program now (1x1 targets) so no shader compiles while painting. */
  prewarm() {
    const tinyDye = makeTarget(1, this.dye.texture.type, THREE.RGBAFormat);
    const tinyFilm = makeTarget(1, THREE.UnsignedByteType, this.film ? this.film.read.texture.format : THREE.RGFormat);
    const m = this.materials;
    this.addSegment(0.5, 0.5, 0.5, 0.5, 1, 0, 0.01, 0.01, 0, 0, 0, 0, 0, 0, 0);
    const g = this._segGeometry;
    const a = g.attributes;
    this._mark(a.aAB, 16);
    this._mark(a.aFrame, 16);
    this._mark(a.aSeam, 16);
    this._mark(a.aExtra, 8);
    g.setDrawRange(0, 6);
    this.queued = 0;
    this.renderPass(m.depositDye, tinyDye, g);
    this.renderPass(m.depositFilm, tinyFilm, g);
    m.level.uniforms.uFilm.value = tinyDye.texture;
    this.renderPass(m.level, tinyFilm);
    m.level.uniforms.uFilm.value = null;
    this.blit(this.dye.texture, tinyDye);
    this.renderPass(m.fill, tinyDye);
    tinyDye.dispose();
    tinyFilm.dispose();
  }

  /** GPU state was lost with the context: paint is gone, start clean. */
  onContextRestored() {
    this.clear();
  }

  /** Harness: zero the draw counters. */
  resetCounters() {
    this.drawCalls = 0;
    this.levelPasses = 0;
  }

  dispose() {
    this._disposeFilm();
    if (this.dye) this.dye.dispose();
    this.dye = null;
    Object.values(this.materials).forEach((mat) => mat.dispose());
    this._triGeometry.dispose();
    this._segGeometry.dispose();
  }

  // ------------------------------------------------------- nail helpers --

  /**
   * The bound nail's frame in nail-plane units (once per bind; allocates).
   * Fits plane = centre + along * a + across * w over the nail's vertices,
   * where a = +1 at the cuticle, -1 at the free edge and w = +-1 at the side
   * walls. The cuticle direction is found from the skin around the nail (it
   * does not trust uNailAxis, whose wide skin search can point across the
   * nail).
   * Returns { aspect, widthV, lengthV, cx, cy (plane), alongX, alongY,
   * acrossX, acrossY (unit, plane) }.
   */
  static nailFrame(handModel, hand, finger) {
    const rec = handModel.getNail(hand, finger);
    if (!rec) return null;
    const aspect = handModel.getUVAspect(hand, finger);
    const mesh = rec.mesh;
    const pos = mesh.geometry.attributes.position;
    const nrm = mesh.geometry.attributes.normal;
    const uv = mesh.geometry.attributes.uv;
    // The cuticle direction, from the skin right around the nail (the finger
    // continues past the cuticle, not past the free edge). The skin search is
    // kept tight (about one nail length): a wide one reaches other fingers.
    mesh.updateWorldMatrix(true, false);
    const v = new THREE.Vector3();
    const cW = new THREE.Vector3();
    const nW = new THREE.Vector3();
    const n = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const box = new THREE.Box3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      cW.add(v);
      box.expandByPoint(v);
      if (nrm) {
        n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        if (n.y > 0) nW.add(n);
      }
    }
    cW.multiplyScalar(1 / Math.max(1, pos.count));
    if (nW.lengthSq() < 1e-10) nW.set(0, 1, 0);
    nW.normalize();
    const reach = box.getSize(new THREE.Vector3()).length() * 0.9;
    const toBase = new THREE.Vector3();
    let skin = null;
    const model = handModel.hands && handModel.hands[hand] && handModel.hands[hand].model;
    if (model) model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    if (skin) {
      skin.skeleton.update();
      const sp = skin.geometry.attributes.position;
      for (let i = 0; i < sp.count; i++) {
        skin.getVertexPosition(i, v);
        v.applyMatrix4(skin.matrixWorld).sub(cW);
        if (v.lengthSq() < reach * reach) toBase.add(v);
      }
    }
    toBase.addScaledVector(nW, -toBase.dot(nW));
    if (toBase.lengthSq() < 1e-12) toBase.set(1, 0, 0).addScaledVector(nW, -nW.x);
    const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const ax = toBase.normalize().clone().transformDirection(inv);
    const c = cW.clone().applyMatrix4(inv);
    const nL = nW.clone().transformDirection(inv);
    const sd = new THREE.Vector3().crossVectors(nL, ax).normalize();
    const half = new THREE.Vector2();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(c);
      half.x = Math.max(half.x, Math.abs(v.dot(ax)));
      half.y = Math.max(half.y, Math.abs(v.dot(sd)));
    }
    // normal equations for [a w 1] -> px and py
    const M = new Float64Array(9);
    const bx = new Float64Array(3);
    const by = new Float64Array(3);
    const r = [0, 0, 1];
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.y, dz = pos.getZ(i) - c.z;
      r[0] = (dx * ax.x + dy * ax.y + dz * ax.z) / half.x;
      r[1] = (dx * sd.x + dy * sd.y + dz * sd.z) / half.y;
      const px = uv.getX(i) * aspect, py = uv.getY(i);
      for (let j = 0; j < 3; j++) {
        bx[j] += r[j] * px;
        by[j] += r[j] * py;
        for (let k = 0; k < 3; k++) M[j * 3 + k] += r[j] * r[k];
      }
    }
    const solve = (b) => {
      const m = Array.from(M), v = Array.from(b);
      for (let i = 0; i < 3; i++) {
        let p = i;
        for (let j = i + 1; j < 3; j++) if (Math.abs(m[j * 3 + i]) > Math.abs(m[p * 3 + i])) p = j;
        for (let k = 0; k < 3; k++) { const t = m[i * 3 + k]; m[i * 3 + k] = m[p * 3 + k]; m[p * 3 + k] = t; }
        const t = v[i]; v[i] = v[p]; v[p] = t;
        for (let j = i + 1; j < 3; j++) {
          const f = m[j * 3 + i] / (m[i * 3 + i] || 1e-12);
          for (let k = i; k < 3; k++) m[j * 3 + k] -= f * m[i * 3 + k];
          v[j] -= f * v[i];
        }
      }
      const x = [0, 0, 0];
      for (let i = 2; i >= 0; i--) {
        let s = v[i];
        for (let k = i + 1; k < 3; k++) s -= m[i * 3 + k] * x[k];
        x[i] = s / (m[i * 3 + i] || 1e-12);
      }
      return x;
    };
    const X = solve(bx), Y = solve(by);
    const lenA = Math.hypot(X[0], Y[0]) || 1e-6;
    const lenW = Math.hypot(X[1], Y[1]) || 1e-6;
    return {
      aspect,
      widthV: 2 * lenW,
      lengthV: 2 * lenA,
      cx: X[2], cy: Y[2],
      alongX: X[0] / lenA, alongY: Y[0] / lenA,
      acrossX: X[1] / lenW, acrossY: Y[1] / lenW,
    };
  }

  // --------------------------------------------------- self-test driver --
  // Dev / harness only (B2/B4 acceptance before the B5 engine exists). Not
  // used by the game. Drives a PolishFilm bound to the active nail with a
  // minimal stand-in for the B5 stroke engine (band 20..34% of the nail width,
  // tiling segments, landing and lift caps, COAT_ALPHA 0.62).
  //   const PF = (await import('/src/tools/PolishBrush3D/PolishFilm.js')).PolishFilm;
  //   await PF.debugStroke(app, { path: [[-0.9, 0], [0.9, 0]], ms: 450 });
  //   PF.debugRead(app, 'film')  -> Uint8Array (RGBA, 256 x 256)

  /** Bind (or rebind) the debug film to the active nail. */
  static debugBind(app, { clear = false } = {}) {
    const hm = app.nail;
    const s = app.quality.settings;
    let d = app.__filmDebug;
    if (!d) {
      const film = new PolishFilm(app.scene.renderer, {
        dyeRes: s.fluidDyeRes, dyeType: s.fluidDyeType, filmRes: s.filmRes === undefined ? 192 : s.filmRes,
      });
      film.prewarm();
      d = app.__filmDebug = { film, frame: null, hand: null, finger: null, strokes: [], last: 0, running: false, sinceLift: 99, pauseAt: -1 };
    }
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    if (clear || hand !== d.hand || finger !== d.finger) {
      d.film.clear();
      d.hand = hand;
      d.finger = finger;
      d.frame = PolishFilm.nailFrame(hm, hand, finger);
      d.film.setAspect(d.frame.aspect);
    }
    hm.setPaintTexture(hand, finger, d.film.getTexture());
    if (hm.setFilmTexture) hm.setFilmTexture(hand, finger, d.film.getFilmTexture());
    if (!d.running) {
      d.running = true;
      d.last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.1, (now - d.last) / 1000);
        d.last = now;
        PolishFilm._debugFrame(app, d, dt, now);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
    return d;
  }

  /**
   * Paint one stroke along `path` (nail coords [a, w]: a = -1 free edge .. +1
   * cuticle, w = -1..1 across) in `ms`. Resolves when the brush lifts.
   */
  static debugStroke(app, opts = {}) {
    const d = PolishFilm.debugBind(app);
    return new Promise((resolve) => {
      d.strokes.push(Object.assign({
        path: [[-0.9, 0], [0.9, 0]], ms: 450, pressure: 1, dry: 0, coat: 0.62, color: '#b8a2f2',
        samplesPerFrame: 3, bead: 0.6, seed: Math.random() * 6.28,
      }, opts, { resolve, t: -1 }));
    });
  }

  static _debugPoint(d, path, f, out) {
    // f in 0..1 by arc length over the polyline (nail coords)
    const fr = d.frame;
    let total = 0;
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    let want = f * total;
    let a = path[0][0], w = path[0][1];
    for (let i = 1; i < path.length; i++) {
      const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      if (want <= l || i === path.length - 1) {
        const k = l > 0 ? Math.min(1, want / l) : 0;
        a = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * k;
        w = path[i - 1][1] + (path[i][1] - path[i - 1][1]) * k;
        break;
      }
      want -= l;
    }
    const px = fr.cx + fr.alongX * a * fr.lengthV * 0.5 + fr.acrossX * w * fr.widthV * 0.5;
    const py = fr.cy + fr.alongY * a * fr.lengthV * 0.5 + fr.acrossY * w * fr.widthV * 0.5;
    out[0] = px; // plane units
    out[1] = py;
  }

  static _debugFrame(app, d, dt, now) {
    const film = d.film;
    const hm = app.nail;
    const st = d.strokes[0];
    if (st) {
      const fr = d.frame;
      const asp = fr.aspect;
      if (st.t < 0) {
        st.t = 0;
        st.p = [0, 0];
        st.q = [0, 0];
        PolishFilm._debugPoint(d, st.path, 0, st.p);
        st.dir = [fr.alongX, fr.alongY];
        st.prevDir = null;
        const c = new THREE.Color(st.color);
        const rgb = { r: 0, g: 0, b: 0 };
        c.getRGB(rgb, THREE.SRGBColorSpace);
        film.beginStroke(rgb, st.seed);
        st.hw = fr.widthV * (0.20 + 0.14 * st.pressure) * (1 - 0.25 * st.dry) * 0.5;
        // landing cap, axis across the nail
        film.addSegment(st.p[0] / asp, st.p[1], st.p[0] / asp, st.p[1], fr.acrossX, fr.acrossY, st.hw * 1.04, st.hw * 0.3,
          0, 0, SEG_FLAGS.CAP_START, st.dry, st.dry, st.bead, st.coat * 0.5);
        d.sinceLift = -1;
      }
      const t0 = st.t;
      st.t = Math.min(st.ms, st.t + dt * 1000);
      const n = st.samplesPerFrame;
      for (let k = 1; k <= n; k++) {
        const f = (t0 + (st.t - t0) * k / n) / st.ms;
        PolishFilm._debugPoint(d, st.path, f, st.q);
        const dx = st.q[0] - st.p[0], dy = st.q[1] - st.p[1];
        const l = Math.hypot(dx, dy);
        if (l < 1e-5) continue;
        const ux = dx / l, uy = dy / l;
        let flags = SEG_FLAGS.CLIP_END;
        if (st.prevDir) {
          if (ux * st.prevDir[0] + uy * st.prevDir[1] < -0.3) {
            film.addSegment(st.p[0] / asp, st.p[1], st.p[0] / asp, st.p[1], -st.prevDir[1], st.prevDir[0], st.hw, st.hw * 0.3,
              0, 0, SEG_FLAGS.CAP_END | SEG_FLAGS.CAP_START, st.dry, st.dry, 0, st.coat * 0.5);
          } else {
            flags |= SEG_FLAGS.CLIP_START;
          }
        }
        film.addSegment(st.p[0] / asp, st.p[1], st.q[0] / asp, st.q[1], -uy, ux, st.hw, st.hw * 0.3,
          st.prevDir ? st.prevDir[0] : 0, st.prevDir ? st.prevDir[1] : 0, flags, st.dry, st.dry, 0, st.coat);
        st.prevDir = [ux, uy];
        st.p[0] = st.q[0];
        st.p[1] = st.q[1];
      }
      if (st.t >= st.ms) {
        const pd = st.prevDir || [fr.alongX, fr.alongY];
        film.addSegment(st.p[0] / asp, st.p[1], st.p[0] / asp, st.p[1], -pd[1], pd[0], st.hw, st.hw * 0.3,
          0, 0, SEG_FLAGS.CAP_END, st.dry, st.dry, 0, st.coat * 0.5);
        film.flush();
        d.sinceLift = 0;
        d.strokes.shift();
        st.resolve(now);
      }
      film.flush();
    }
    // pauseAt >= 0: freeze levelling and wetness that long after the lift
    // (screenshots on a software GPU take seconds).
    if (!st && d.pauseAt >= 0 && d.sinceLift >= d.pauseAt) return;
    const awake = film.tick(dt);
    if (hm.setFilmTexture) hm.setFilmTexture(d.hand, d.finger, film.getFilmTexture());
    // Wetness as WetCure drives it: 1 while painting, held 1.5 s, then tacky.
    if (!st && d.sinceLift >= 0) d.sinceLift += dt;
    const t = d.sinceLift < 0 ? 0 : Math.max(0, d.sinceLift - 1.5) / 6;
    const e = t >= 1 ? 1 : t * t * (3 - 2 * t);
    hm.setWetness(d.hand, d.finger, 1 - 0.65 * e);
    if (st || awake) app.invalidate();
  }

  /** Freeze the debug film `t` seconds after the last lift (t < 0: run). */
  static debugPauseAt(app, t) {
    const d = app.__filmDebug;
    if (d) d.pauseAt = t;
  }

  /** Read the debug film's dye or film back as RGBA8 (res x res). */
  static debugRead(app, which = 'dye', res = 256) {
    const d = app.__filmDebug;
    if (!d) return null;
    const film = d.film;
    const tex = which === 'film' ? film.getFilmTexture() : film.getTexture();
    if (!tex) return null;
    const rt = makeTarget(res, THREE.UnsignedByteType, THREE.RGBAFormat);
    film.blit(tex, rt);
    const out = new Uint8Array(res * res * 4);
    app.scene.renderer.readRenderTargetPixels(rt, 0, 0, res, res, out);
    rt.dispose();
    return out;
  }
}
