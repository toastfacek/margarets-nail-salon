/**
 * Backdrop.js
 * The salon around the hand: an out-of-focus room behind everything and the
 * desk the hand rests on (a pastel spa towel on white marble, with the
 * contact shadow).
 *
 * Cost model (the harness rasterises on the CPU, so every shaded pixel counts):
 *
 * Desk
 *   Everything about the desk (terry towel, satin stripes, marble veins, the
 *   light pool, the contact shadow, the fade into the room, tone mapping and
 *   sRGB encoding) is rendered ONCE into a display-referred texture. At run
 *   time the desk is a plane with a one-fetch shader. Re-baked only when the
 *   shown hand changes.
 *
 * Room (backdrop)
 *   A sphere cap around the camera (it follows the camera, so it has rotation
 *   parallax only, like a sky) covering the directions from just below the
 *   horizon upward. Looking down at the hand it rasterises nothing at all; it
 *   only costs pixels where the room is actually visible. Its colour is a
 *   function of direction: warm wall gradient, a blurred shelf of bottle
 *   silhouettes, drifting bokeh discs.
 *     high    animated, 12 bokeh
 *     medium  animated, 8 bokeh (NailScene throttles invalidation to 20 Hz)
 *     low     the same function baked ONCE into a 512x256 texture on the
 *             sphere's own UVs: one fetch per pixel
 *   The room and the desk meet at the horizon in the same colour (FOG), so
 *   there is no horizon line.
 */
import * as THREE from 'three';

const MAX_BOKEH = 12;
const DOME_RADIUS = 40;
const DOME_THETA = Math.PI / 2 + 0.06;   // zenith down to ~3.4 degrees below the horizon

// The colour where desk and room meet (linear, before tone mapping).
const FOG = Object.freeze([0.70, 0.55, 0.57]);
const EXPOSURE = 1.2;

// Shared GLSL: tone mapping identical to the renderer's (ACES, exposure 1.2),
// for the passes that bake display-referred colour.
const acesChunk = /* glsl */ `
vec3 bakeRRT(vec3 v) {
vec3 a = v * (v + 0.0245786) - 0.000090537;
vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
return a / b;
}
vec3 bakeDisplay(vec3 color) {
const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
color *= ${EXPOSURE.toFixed(3)} / 0.6;
color = OUT * bakeRRT(IN * color);
color = clamp(color, 0.0, 1.0);
return sRGBTransferOETF(vec4(color, 1.0)).rgb;
}
`;

// Shared GLSL: the room as a function of a world direction (linear colour).
const roomChunk = /* glsl */ `
uniform float uTime;
uniform float uBokehCount;
uniform vec3 uBokeh[${MAX_BOKEH}];
uniform vec3 uBokehCol[${MAX_BOKEH}];
const float PI = 3.14159265;
float bhash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float rbox(vec2 p, vec2 b, float r) {
vec2 q = abs(p) - b + r;
return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 roomColor(vec3 d, float animate) {
d = normalize(d);
float e = d.y;
float az = atan(d.z, d.x);
vec3 fogCol = vec3(${FOG.map((v) => v.toFixed(3)).join(', ')});
vec3 lowWall = vec3(0.62, 0.40, 0.46);
vec3 highWall = vec3(0.74, 0.58, 0.54);
vec3 col = mix(lowWall, highWall, smoothstep(0.05, 0.8, e));
col = mix(col, fogCol, smoothstep(0.2, -0.03, e));
col += vec3(0.22, 0.13, 0.05) * pow(max(dot(d, normalize(vec3(0.5, 0.35, -1.0))), 0.0), 5.0);
float shelfE = 0.17;
if (e > shelfE - 0.06 && e < shelfE + 0.26) {
float band = smoothstep(0.035, 0.0, abs(e - shelfE));
col = mix(col, vec3(0.42, 0.24, 0.31), band * 0.6);
float seg = PI / 9.0;
float idx = floor(az / seg);
float lx = (az - (idx + 0.5) * seg) * cos(shelfE);
float h1 = bhash(idx + 3.0);
float h2 = bhash(idx + 11.0);
float bw = 0.018 + 0.016 * h1;
float bh = 0.045 + 0.06 * h2;
vec2 bp = vec2(lx - (h1 - 0.5) * 0.04, e - (shelfE + 0.012 + bh));
float bottle = 1.0 - smoothstep(-0.012, 0.016, rbox(bp, vec2(bw, bh), bw * 0.8));
vec3 bc = 0.5 + 0.45 * cos(6.2831 * (h2 * 0.8 + vec3(0.0, 0.33, 0.67)));
bc = mix(bc, vec3(1.0, 0.45, 0.65), 0.35);
float cap = 1.0 - smoothstep(-0.008, 0.014, rbox(bp - vec2(0.0, bh + 0.018), vec2(bw * 0.45, 0.016), 0.006));
col = mix(col, bc * 0.75, bottle * 0.8);
col = mix(col, vec3(0.85, 0.62, 0.35), cap * 0.7);
col += bottle * 0.16 * smoothstep(0.01, 0.0, abs(bp.x + bw * 0.4));
}
if (e > 0.05) {
for (int i = 0; i < ${MAX_BOKEH}; i++) {
if (float(i) >= uBokehCount) break;
vec3 b = uBokeh[i];
float drift = animate * uTime;
vec2 c = vec2(b.x + 0.05 * sin(drift * 0.11 + float(i) * 1.7), b.y + 0.02 * sin(drift * 0.07 + float(i) * 2.3));
float da = az - c.x;
da = da - 2.0 * PI * floor((da + PI) / (2.0 * PI));
vec2 q = vec2(da * cos(e), e - c.y);
float r = length(q) / b.z;
float disc = 1.0 - smoothstep(0.82, 1.0, r);
float rim = smoothstep(0.55, 0.95, r) * disc;
col += uBokehCol[i] * (disc * 0.6 + rim * 0.4);
}
}
return col;
}
`;

const domeVertex = /* glsl */ `
varying vec3 vDir;
varying vec2 vUv;
void main() {
vDir = position;
vUv = uv;
gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const domeFragmentAnimated = /* glsl */ `
uniform float uDim;
varying vec3 vDir;
varying vec2 vUv;
${roomChunk}
${acesChunk}
float dither(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
vec3 col = bakeDisplay(roomColor(vDir, 1.0)) * uDim;
gl_FragColor = vec4(col + (dither(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}
`;

const domeFragmentBaked = /* glsl */ `
uniform sampler2D uRoom;
uniform float uDim;
varying vec3 vDir;
varying vec2 vUv;
void main() {
gl_FragColor = vec4(texture2D(uRoom, vUv).rgb * uDim, 1.0);
}
`;

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Bakes the room on the dome's own UVs (THREE.SphereGeometry convention).
const roomBakeFragment = /* glsl */ `
varying vec2 vUv;
${roomChunk}
${acesChunk}
void main() {
float phi = vUv.x * 6.2831853;
float theta = (1.0 - vUv.y) * ${DOME_THETA.toFixed(5)};
vec3 d = vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
gl_FragColor = vec4(bakeDisplay(roomColor(d, 0.0)), 1.0);
}
`;

// Bakes the desk (display-referred) over a world xz region.
const deskBakeFragment = /* glsl */ `
uniform sampler2D uShadow;
uniform vec2 uShadowO;
uniform vec2 uShadowAx;
uniform vec2 uShadowAz;
uniform float uHasShadow;
uniform vec2 uRegionMin;
uniform vec2 uRegionSize;
uniform vec2 uCentre;
uniform vec4 uTowelRect;
uniform vec3 uTowelColor;
uniform vec3 uLightXZ;
uniform vec4 uRoll;
uniform vec2 uRollSize;
varying vec2 vUv;
${acesChunk}
float h21(vec2 p) {
vec3 p3 = fract(vec3(p.xyx) * 0.1031);
p3 += dot(p3, p3.yzx + 33.33);
return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
vec2 i = floor(p), f = fract(p);
vec2 u = f * f * (3.0 - 2.0 * f);
return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
float s = 0.0, a = 0.5;
for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
return s;
}
void main() {
vec2 p = uRegionMin + vUv * uRegionSize;
vec2 tq = abs(p - uTowelRect.xy) - uTowelRect.zw;
float towelSd = max(tq.x, tq.y) - 0.04 * (vnoise(p * 3.0) - 0.5);
float onTowel = 1.0 - smoothstep(-0.01, 0.01, towelSd);
vec3 towel = vec3(0.0);
vec3 marble = vec3(0.0);
if (towelSd < 0.02) {
float loops = vnoise(p * 34.0) * 0.6 + vnoise(p * 71.0 + 3.0) * 0.4;
float weave = 0.5 + 0.5 * sin(p.x * 120.0 + loops * 2.0) * sin(p.y * 120.0 + loops * 3.0);
float folds = vnoise(p * 0.9 + 4.0) * 0.65 + vnoise(p * 2.1 + 9.0) * 0.35;
towel = uTowelColor * (0.86 + 0.16 * loops + 0.04 * weave) * (0.9 + 0.2 * folds);
float a = abs((p.x - uTowelRect.x) / uTowelRect.z);
float stripe = smoothstep(0.72, 0.735, a) * (1.0 - smoothstep(0.80, 0.815, a))
+ smoothstep(0.85, 0.86, a) * (1.0 - smoothstep(0.875, 0.885, a));
vec3 satin = mix(uTowelColor, vec3(1.0, 0.97, 0.94), 0.55) * (1.02 + 0.06 * sin(p.y * 260.0));
towel = mix(towel, satin, stripe * 0.85);
towel *= 1.0 - 0.22 * smoothstep(-0.10, 0.0, towelSd);
}
if (towelSd > -0.02) {
float t = fbm(p * 0.7);
float v1 = pow(1.0 - abs(sin((p.x * 0.8 + p.y * 0.5) * 3.0 + t * 7.0)), 12.0);
float v2 = pow(1.0 - abs(sin((p.x * 0.3 - p.y * 1.1) * 5.0 + vnoise(p * 1.7 + 9.0) * 4.0 + t * 3.0)), 30.0);
marble = vec3(0.86, 0.80, 0.79) * (0.95 + 0.06 * t) - vec3(0.10, 0.20, 0.16) * v1 - vec3(0.05, 0.10, 0.08) * v2;
marble *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.22, towelSd));
}
vec3 col = mix(marble, towel, onTowel);
float r = length(p - uCentre);
col *= 0.70 + 0.42 * exp(-r * r * 0.30);
if (uHasShadow > 0.5) {
vec2 q = p - uLightXZ.xy * uLightXZ.z;
vec2 suv = uShadowO + q.x * uShadowAx + q.y * uShadowAz;
float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
float sh = texture2D(uShadow, suv).r * inside;
vec2 suv2 = uShadowO + p.x * uShadowAx + p.y * uShadowAz;
float ao = 0.0;
ao += texture2D(uShadow, suv2 + vec2(0.012, 0.0)).r;
ao += texture2D(uShadow, suv2 - vec2(0.012, 0.0)).r;
ao += texture2D(uShadow, suv2 + vec2(0.0, 0.012)).r;
ao += texture2D(uShadow, suv2 - vec2(0.0, 0.012)).r;
sh = max(sh, ao * 0.15 * step(0.0, suv2.x) * step(suv2.x, 1.0) * step(0.0, suv2.y) * step(suv2.y, 1.0));
col *= mix(vec3(1.0), vec3(0.50, 0.33, 0.46), clamp(sh, 0.0, 1.0));
}
if (uRollSize.y > 0.0) {
vec2 rq = p - uRoll.xy - uLightXZ.xy * uRollSize.y * 0.6;
float along2 = dot(rq, uRoll.zw);
float across = abs(dot(rq, vec2(-uRoll.w, uRoll.z)));
float cap = max(abs(along2) - uRollSize.x, 0.0);
float d = length(vec2(cap, max(across - uRollSize.y * 0.55, 0.0)));
col *= mix(vec3(1.0), vec3(0.55, 0.40, 0.52), (1.0 - smoothstep(0.0, uRollSize.y * 1.1, d)) * 0.5);
}
vec2 e = min(vUv, 1.0 - vUv);
float fade = 1.0 - smoothstep(0.0, 0.22, min(e.x * uRegionSize.x, e.y * uRegionSize.y) / max(uRegionSize.x, uRegionSize.y) * 2.0);
col = mix(col, vec3(${FOG.map((v) => v.toFixed(3)).join(', ')}), fade);
gl_FragColor = vec4(bakeDisplay(col), 1.0);
}
`;

const deskVertex = /* glsl */ `
uniform vec2 uRegionMin;
uniform vec2 uRegionSize;
varying vec2 vUv;
void main() {
vec4 wp = modelMatrix * vec4(position, 1.0);
vUv = (wp.xz - uRegionMin) / uRegionSize;
gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// One fetch. The texture is display-referred: no tone mapping, no encoding.
const deskFragment = /* glsl */ `
uniform sampler2D uDesk;
uniform float uDim;
varying vec2 vUv;
void main() {
gl_FragColor = vec4(texture2D(uDesk, vUv).rgb * uDim, 1.0);
}
`;

/** Small tiling terry texture for the towel roll (soft loops, sRGB). */
function makeTerryTexture() {
  const N = 128;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  let seed = 5;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = new Float32Array(32 * 32);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (i, j) => g[(j & 31) * 32 + (i & 31)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const fx = x / 4, fy = y / 4;
      const xi = Math.floor(fx), yi = Math.floor(fy);
      const tx = fx - xi, ty = fy - yi;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = at(xi, yi), b = at(xi + 1, yi), cc = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      const n = a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy;
      const v = Math.round(255 * (0.9 + 0.1 * n));
      const i = (y * N + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.name = 'TowelTerry';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 3);
  return tex;
}

function fullscreenTriangle() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

/** Render `material` over the whole of `target` once. */
function bakePass(renderer, material, target) {
  const scene = new THREE.Scene();
  const tri = fullscreenTriangle();
  const quad = new THREE.Mesh(tri, material);
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  const prevToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.toneMapping = prevToneMapping;
  tri.dispose();
}

function bakeTarget(w, h, name) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  t.texture.name = name;
  return t;
}

export class Backdrop {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} settings quality settings
   */
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.time = 0;
    this.dim = 1;
    this.towelColor = new THREE.Color('#d9c4ec');

    // Bokeh layout (fixed directions; the drift is animated in the shader).
    const bokeh = [];
    const bokehCol = [];
    const palette = ['#fff1d6', '#ffd1e0', '#ffe2b0', '#ffc2d6', '#fff8ee', '#f8c8ff'];
    let s = 11;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < MAX_BOKEH; i++) {
      const az = (i / MAX_BOKEH) * Math.PI * 2 + rnd() * 0.4;
      const el = 0.36 + rnd() * 0.5;
      const r = 0.05 + rnd() * 0.07;
      bokeh.push(new THREE.Vector3(az, el, r));
      bokehCol.push(new THREE.Color(palette[i % palette.length]).multiplyScalar(0.22 + rnd() * 0.18));
    }

    this.roomUniforms = {
      uTime: { value: 0 },
      uBokehCount: { value: MAX_BOKEH },
      uBokeh: { value: bokeh },
      uBokehCol: { value: bokehCol },
      uDim: { value: 1 },
    };

    const common = { depthTest: true, depthWrite: false, side: THREE.BackSide, toneMapped: false };
    this.animatedMaterial = new THREE.ShaderMaterial(Object.assign({
      name: 'RoomAnimated',
      vertexShader: domeVertex,
      fragmentShader: domeFragmentAnimated,
      uniforms: this.roomUniforms,
    }, common));
    this.bakedMaterial = new THREE.ShaderMaterial(Object.assign({
      name: 'RoomBaked',
      vertexShader: domeVertex,
      fragmentShader: domeFragmentBaked,
      uniforms: { uRoom: { value: null }, uDim: this.roomUniforms.uDim },
    }, common));
    this._roomTarget = null;

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 48, 14, 0, Math.PI * 2, 0, DOME_THETA),
      this.animatedMaterial,
    );
    dome.name = 'SalonRoom';
    dome.frustumCulled = false;
    dome.renderOrder = 1000; // last among opaques
    dome.onBeforeRender = (r, sc, camera) => {
      dome.position.copy(camera.position);
      dome.updateMatrixWorld();
    };
    this.mesh = dome;

    // ---- desk
    this.deskUniforms = {
      uDesk: { value: null },
      uRegionMin: { value: new THREE.Vector2(-5, -4) },
      uRegionSize: { value: new THREE.Vector2(6, 4.5) },
      uDim: this.roomUniforms.uDim,
    };
    this.deskMaterial = new THREE.ShaderMaterial({
      name: 'Desk',
      vertexShader: deskVertex,
      fragmentShader: deskFragment,
      uniforms: this.deskUniforms,
      toneMapped: false,
    });
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 1, 1), this.deskMaterial);
    desk.name = 'Desk';
    desk.rotation.x = -Math.PI / 2;
    desk.renderOrder = 500; // after the hand: pixels under the hand fail the depth test
    desk.visible = false;   // until the first bake
    this.desk = desk;
    this._deskTarget = null;
    this._deskBakeMaterial = null;
    this._layout = null;

    // ---- a rolled spa towel under the wrist (salons use one as a hand rest)
    this._rollTexture = makeTerryTexture();
    this.rollMaterial = new THREE.MeshLambertMaterial({
      name: 'TowelRoll',
      color: this.towelColor,
      map: this._rollTexture,
      emissive: this.towelColor.clone().multiplyScalar(0.28),
    });
    const roll = new THREE.Mesh(new THREE.BufferGeometry(), this.rollMaterial);
    roll.name = 'TowelRoll';
    roll.visible = false;
    this.roll = roll;

    this.setQuality(settings);
  }

  _placeRoll(deskY, r) {
    const roll = this.roll;
    // A capsule: soft rounded ends, like a real rolled towel.
    // A sphere with an odd number of rings, its halves pushed apart.
    roll.geometry.dispose();
    const g = new THREE.SphereGeometry(r.radius, 28, 15);
    const pos = g.attributes.position;
    const h = Math.max(0, r.halfLength - r.radius);
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + Math.sign(pos.getY(i)) * h);
    roll.geometry = g;
    roll.position.set(r.x, deskY + r.radius * 0.85, r.z);
    // cylinder axis (local y) along (dirX, 0, dirZ)
    roll.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(r.dirX, 0, r.dirZ));
    roll.updateMatrixWorld(true);
    roll.visible = true;
  }

  /**
   * Bake the desk under a hand.
   * @param {object} layout { deskY, centreX, centreZ, towelHalfX, towelHalfZ }
   * @param {import('./ContactShadow.js').ContactShadow|null} shadow
   * @param {THREE.Vector3} lightDir key light direction (toward the light)
   */
  bakeDesk(layout, shadow, lightDir) {
    this._layout = layout;
    const renderer = this.renderer;
    const sizeX = layout.towelHalfX * 2 + 2.4;
    const sizeZ = layout.towelHalfZ * 2 + 2.0;
    const minX = layout.centreX - sizeX / 2;
    const minZ = layout.centreZ - sizeZ / 2;
    this.deskUniforms.uRegionMin.value.set(minX, minZ);
    this.deskUniforms.uRegionSize.value.set(sizeX, sizeZ);

    // Texel density per world unit (the desk is out of focus anyway), capped.
    const density = this.settings.tier === 'high' ? 240 : this.settings.tier === 'medium' ? 190 : 150;
    const w = Math.min(2048, Math.round(sizeX * density / 64) * 64);
    const h = Math.min(1536, Math.round(sizeZ * density / 64) * 64);
    if (!this._deskTarget || this._deskTarget.width !== w || this._deskTarget.height !== h) {
      if (this._deskTarget) this._deskTarget.dispose();
      this._deskTarget = bakeTarget(w, h, 'DeskBaked');
    }

    if (!this._deskBakeMaterial) {
      this._deskBakeMaterial = new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: deskBakeFragment,
        uniforms: {
          uShadow: { value: null },
          uShadowO: { value: new THREE.Vector2() },
          uShadowAx: { value: new THREE.Vector2(1, 0) },
          uShadowAz: { value: new THREE.Vector2(0, 1) },
          uHasShadow: { value: 0 },
          uRegionMin: { value: new THREE.Vector2() },
          uRegionSize: { value: new THREE.Vector2() },
          uCentre: { value: new THREE.Vector2() },
          uTowelRect: { value: new THREE.Vector4() },
          uTowelColor: { value: new THREE.Color() },
          uLightXZ: { value: new THREE.Vector3() },
          uRoll: { value: new THREE.Vector4(0, 0, 1, 0) },
          uRollSize: { value: new THREE.Vector2(0, 0) },
        },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
    }
    const u = this._deskBakeMaterial.uniforms;
    u.uRegionMin.value.set(minX, minZ);
    u.uRegionSize.value.set(sizeX, sizeZ);
    u.uCentre.value.set(layout.centreX, layout.centreZ);
    u.uTowelRect.value.set(layout.centreX, layout.centreZ, layout.towelHalfX, layout.towelHalfZ);
    u.uTowelColor.value.copy(this.towelColor);
    // shadows fall away from the light: offset by the average finger height
    const lx = -lightDir.x / Math.max(0.2, lightDir.y);
    const lz = -lightDir.z / Math.max(0.2, lightDir.y);
    u.uLightXZ.value.set(lx, lz, 0.12);
    if (shadow && shadow.texture) {
      u.uShadow.value = shadow.texture;
      u.uShadowO.value.copy(shadow.mapping.origin);
      u.uShadowAx.value.copy(shadow.mapping.axisX);
      u.uShadowAz.value.copy(shadow.mapping.axisZ);
      u.uHasShadow.value = 1;
    } else {
      u.uShadow.value = null;
      u.uHasShadow.value = 0;
    }

    const roll = layout.roll;
    if (roll) {
      u.uRoll.value.set(roll.x, roll.z, roll.dirX, roll.dirZ);
      u.uRollSize.value.set(roll.halfLength, roll.radius);
      this._placeRoll(layout.deskY, roll);
    } else {
      u.uRollSize.value.set(0, 0);
      this.roll.visible = false;
    }

    bakePass(renderer, this._deskBakeMaterial, this._deskTarget);
    u.uShadow.value = null;
    this.deskUniforms.uDesk.value = this._deskTarget.texture;

    this.desk.position.set(layout.centreX, layout.deskY, layout.centreZ);
    this.desk.updateMatrixWorld(true);
    this.desk.visible = true;
  }

  /** Re-render the baked textures (after a WebGL context loss). */
  rebake() {
    if (this._roomTarget) {
      this._roomTarget.dispose();
      this._roomTarget = null;
      this._ensureRoomBaked();
    }
  }

  get animated() {
    return this.mesh.material === this.animatedMaterial;
  }

  setQuality(settings) {
    this.settings = settings;
    const mode = settings.backdrop || 'baked';
    if (mode === 'baked') {
      this._ensureRoomBaked();
      this.mesh.material = this.bakedMaterial;
    } else {
      this.roomUniforms.uBokehCount.value = mode === 'animated8' ? 8 : MAX_BOKEH;
      this.mesh.material = this.animatedMaterial;
    }
  }

  _ensureRoomBaked() {
    if (this._roomTarget) return;
    this._roomTarget = bakeTarget(512, 256, 'RoomBaked');
    const mat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: roomBakeFragment,
      uniforms: this.roomUniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const prevCount = this.roomUniforms.uBokehCount.value;
    this.roomUniforms.uBokehCount.value = MAX_BOKEH;
    bakePass(this.renderer, mat, this._roomTarget);
    this.roomUniforms.uBokehCount.value = prevCount;
    mat.dispose();
    this.bakedMaterial.uniforms.uRoom.value = this._roomTarget.texture;
  }

  precompile(renderer, scene, camera) {
    // Both room variants (the dome is often hidden at this point: show it for
    // the compile only), so neither orbiting nor a tier change compiles.
    const cur = this.mesh.material;
    const vis = this.mesh.visible;
    if (cur === this.animatedMaterial) this._ensureRoomBaked();
    this.mesh.visible = true;
    for (const m of [this.animatedMaterial, this.bakedMaterial]) {
      this.mesh.material = m;
      try { renderer.compile(scene, camera); } catch (err) { /* compile on demand */ }
    }
    this.mesh.material = cur;
    this.mesh.visible = vis;
  }

  /** 1 = normal, 0 = dark (reveal). Uniform only. */
  setDim(x) {
    this.dim = x;
    this.roomUniforms.uDim.value = x;
  }

  update(dt) {
    this.time += dt;
    this.roomUniforms.uTime.value = this.time;
  }

  /** GPU bytes held (for budgets and the hand-off). */
  get gpuBytes() {
    let b = 0;
    if (this._deskTarget) b += this._deskTarget.width * this._deskTarget.height * 4;
    if (this._roomTarget) b += 512 * 256 * 4;
    return b;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.animatedMaterial.dispose();
    this.bakedMaterial.dispose();
    this.desk.geometry.dispose();
    this.deskMaterial.dispose();
    this.roll.geometry.dispose();
    this.rollMaterial.dispose();
    this._rollTexture.dispose();
    if (this._deskBakeMaterial) this._deskBakeMaterial.dispose();
    if (this._deskTarget) this._deskTarget.dispose();
    if (this._roomTarget) this._roomTarget.dispose();
  }
}
