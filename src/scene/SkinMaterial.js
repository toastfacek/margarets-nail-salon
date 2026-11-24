/**
 * SkinMaterial.js
 * The hand's skin: one small custom shader (skinning-aware), two variants.
 *
 *   full (high / medium)  per-pixel: hemisphere + wrapped warm key light,
 *                         subsurface warmth at the terminator, a soft rim and
 *                         a faint sheen. No light loops, no env-map fetches:
 *                         cheaper than MeshStandardMaterial and warmer.
 * Both read the B9 skin masks from the vertex colour (blush, palm side,
 * cavity, thinness; tools/blender/masks.py).
 *   lite (low)            the same model evaluated per VERTEX (10k verts),
 *                         tone-mapped and encoded in the vertex shader; the
 *                         fragment shader only writes the interpolated colour.
 *
 * All skin materials share one uniforms object, so setSkinTone(), setDim()
 * and tier swaps are uniform writes / pointer swaps, never recompiles.
 */
import * as THREE from 'three';
import { RIG } from './SalonEnvironment.js';

const DEFAULT_TONE = '#efb7a2';
const GLOW_COLOR = '#ff6a5a';
const PALM_PINK = new THREE.Color('#f6c6bd');

// m = skin masks (vertex colour, B9): r blush, g palm side, b cavity, a thinness.
// Every colour is derived from uTone (setSkinTone), so any client tone works.
// The masks are smooth per-vertex data: the tone mix is done per vertex on
// every tier (the full variant passes it on), so the per-pixel cost is the
// same as the plain one-tone skin.
const toneChunk = /* glsl */ `
uniform vec3 uTone;
uniform vec3 uBlush;
uniform vec3 uPalm;
uniform vec3 uCavity;
uniform float uSheenK;
// rgb = albedo, a = thinness
vec4 skinTone(vec4 m) {
vec3 tone = mix(uTone, uPalm, m.g * 0.75);
tone = mix(tone, uBlush, m.r * 0.55);
tone *= mix(vec3(1.0), uCavity, m.b * 0.7);
return vec4(tone, m.a);
}
// sheen damped in cavities and on the blushed nail folds, and on darker tones
// (uSheenK): a white sheen on dark skin read as a pale ridge on the nail fold
float skinSheen(vec4 m) { return (1.0 - 0.6 * m.b) * (1.0 - 0.5 * m.r) * uSheenK; }
`;
const lightingChunk = /* glsl */ `
uniform vec3 uGlow;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform float uDim;
vec3 skinShade(vec3 N, vec3 V, float sheen, vec4 t) {
float ndl = dot(N, uKeyDir);
float wrap = max((ndl + 0.35 + 0.12 * t.a) / (1.35 + 0.12 * t.a), 0.0);
float ndv = clamp(dot(N, V), 0.0, 1.0);
vec3 col = t.rgb * (mix(uGround, uSky, N.y * 0.5 + 0.5) + uKeyColor * wrap);
col += uGlow * (0.7 + 0.6 * t.a) * ((wrap - max(ndl, 0.0)) * 0.9 + pow(1.0 - ndv, 3.0) * 0.55);
col += uRimColor * pow(1.0 - ndv, 2.0) * max(dot(N, uRimDir), 0.0);
col += uKeyColor * pow(max(dot(N, normalize(uKeyDir + V)), 0.0), 28.0) * 0.07 * sheen;
return col * uDim;
}
`;

// v3 skin (hand v2, hand-v2-plan.md 6.4), behind SKIN_DETAIL: set only when the
// geometry has uv and the detail map exists (v1's hand never sees it).
//   Nd: the baked detail normal (RG, tangent frame from screen derivatives)
//       plus, on high (SKIN_MICRO), the micro tile: pores on the back, a fine
//       ridge print on the palm side and the pads (mask g); faded by distance
//   diffuse: a spectral wrap (red sees a softer normal and wraps furthest)
//   ambient: the hemisphere, times the cavity (map B x mask b), warm
//   transmission: thin parts (mask a) glow when the key light is behind them
//   specular: two Blinn lobes (one on medium, SKIN_ONE_LOBE), Schlick F0 0.028
const detailChunk = /* glsl */ `
uniform sampler2D uDetailMap;
uniform float uDetailScale;
uniform vec3 uWrap;
#ifdef SKIN_MICRO
uniform sampler2D uMicroMap;
uniform float uMicroRepeat;
#endif
varying vec2 vUv2;
varying vec2 vMask;
vec3 skinShadeDetail(vec3 Ng, vec3 V, float sheen, vec4 t) {
vec3 dp1 = dFdx(vP), dp2 = dFdy(vP);
vec2 du1 = dFdx(vUv2), du2 = dFdy(vUv2);
vec3 dp2p = cross(dp2, Ng), dp1p = cross(Ng, dp1);
vec3 T = dp2p * du1.x + dp1p * du2.x;
vec3 B = dp2p * du1.y + dp1p * du2.y;
T -= Ng * dot(Ng, T);
B -= Ng * dot(Ng, B);
float lt = length(T), lb = length(B);
vec4 dm = texture2D(uDetailMap, vUv2);
vec2 g = (dm.rg - 0.5) * (2.0 / uDetailScale);
vec3 Nd = Ng;
if (lt > 1e-12 && lb > 1e-12) {
T /= lt; B /= lb;
// the map's G is along +v as baked (Blender's v); glTF stores 1 - v, so the
// frame built from vUv2 has B reversed
vec3 p = g.x * T - g.y * B;
#ifdef SKIN_MICRO
// the micro tile: rg pores (back), ba ridges (palm side); fades by footprint
vec2 mu = vUv2 * uMicroRepeat;
vec4 mt = texture2D(uMicroMap, mu);
float foot = length(fwidth(mu));
float mf = 1.0 - smoothstep(0.35, 0.9, foot);
vec2 mg = mix((mt.rg - 0.5) * 0.55, (mt.ba - 0.5) * 0.7, smoothstep(0.25, 0.7, vMask.x)) * mf;
p += mg.x * T + mg.y * B;
#endif
Nd = normalize(Ng + p);
}
if (dot(Nd, V) < 0.0) Nd = Ng;
float cav = dm.b * (0.6 + 0.4 * vMask.y);
float thin = t.a;
vec3 L = uKeyDir;
float nr = dot(normalize(mix(Nd, Ng, 0.6)), L);
float ng = dot(normalize(mix(Nd, Ng, 0.25)), L);
float nb = dot(Nd, L);
vec3 w = uWrap * (1.0 + 0.6 * thin);
vec3 diff = clamp((vec3(nr, ng, nb) + w) / (1.0 + w), 0.0, 1.0);
float ndv = clamp(dot(Nd, V), 0.0, 1.0);
vec3 amb = mix(uGround, uSky, Nd.y * 0.5 + 0.5) * (1.0 - 0.3 * cav) * mix(vec3(1.0), vec3(1.0, 0.86, 0.82), cav);
vec3 col = t.rgb * (amb + uKeyColor * diff);
// the terminator's warm scatter (as v2), the transmission through thin parts
col += uGlow * (0.7 + 0.6 * thin) * ((diff.r - max(nb, 0.0)) * 0.6 + pow(1.0 - ndv, 3.0) * 0.45);
float tr = pow(clamp(dot(V, -normalize(L + Ng * 0.35)), 0.0, 1.0), 3.0);
col += uGlow * thin * tr * 1.6;
col += uRimColor * pow(1.0 - ndv, 2.0) * max(dot(Nd, uRimDir), 0.0);
vec3 H = normalize(L + V);
float nh = max(dot(Nd, H), 0.0);
float F = 0.028 + 0.972 * pow(1.0 - clamp(dot(H, V), 0.0, 1.0), 5.0);
#ifdef SKIN_ONE_LOBE
float spec = pow(nh, 20.0) * 0.9;
#else
float spec = pow(nh, 14.0) * 0.75 + pow(nh, 56.0) * 0.25 * 2.2;
#endif
col += uKeyColor * spec * F * 2.4 * sheen * (1.0 - 0.7 * cav) * max(nb, 0.0);
return col * uDim;
}
`;

const skinVertexHead = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
${toneChunk}
vec4 skinMask() {
#if defined(USE_COLOR_ALPHA)
return color;
#elif defined(USE_COLOR)
return vec4(color, 0.0);
#else
return vec4(0.0);
#endif
}
`;
const skinVertexBody = /* glsl */ `
#include <skinbase_vertex>
#include <begin_vertex>
#include <beginnormal_vertex>
#include <skinnormal_vertex>
#include <skinning_vertex>
vec4 wp = modelMatrix * vec4(transformed, 1.0);
vec3 nW = normalize(mat3(modelMatrix) * objectNormal);
gl_Position = projectionMatrix * viewMatrix * wp;
`;

const fullVertex = /* glsl */ `
${skinVertexHead}
varying vec4 vN;
varying vec3 vP;
varying vec4 vT;
#ifdef SKIN_DETAIL
varying vec2 vUv2;
varying vec2 vMask;
#endif
void main() {
${skinVertexBody}
vec4 m = skinMask();
vN = vec4(nW, skinSheen(m));
vP = wp.xyz;
vT = skinTone(m);
#ifdef SKIN_DETAIL
vUv2 = uv;
vMask = vec2(m.g, m.b);
#endif
}
`;
const fullFragment = /* glsl */ `
${lightingChunk}
varying vec4 vN;
varying vec3 vP;
varying vec4 vT;
#ifdef SKIN_DETAIL
${detailChunk}
#endif
void main() {
#ifdef SKIN_DETAIL
gl_FragColor = vec4(skinShadeDetail(normalize(vN.xyz), normalize(cameraPosition - vP), vN.w, vT), 1.0);
#else
gl_FragColor = vec4(skinShade(normalize(vN.xyz), normalize(cameraPosition - vP), vN.w, vT), 1.0);
#endif
#include <tonemapping_fragment>
#include <colorspace_fragment>
}
`;

// ACES (as the renderer, exposure 1.2) and a gamma encode, for the vertex path.
const liteVertex = /* glsl */ `
${skinVertexHead}
${lightingChunk}
varying vec3 vC;
void main() {
${skinVertexBody}
const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
vec3 v = IN * (skinShade(nW, normalize(cameraPosition - wp.xyz), 0.0, skinTone(skinMask())) * 2.0);
v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
vC = pow(clamp(OUT * v, 0.0, 1.0), vec3(1.0 / 2.2));
}
`;
const liteFragment = /* glsl */ `
varying vec3 vC;
void main() { gl_FragColor = vec4(vC, 1.0); }
`;

/** Uniforms shared by every skin material (both hands, all tiers). */
export function createSkinShared() {
  const s = {
    uTone: { value: new THREE.Color(DEFAULT_TONE) },
    uBlush: { value: new THREE.Color() },
    uPalm: { value: new THREE.Color() },
    uCavity: { value: new THREE.Color() },
    uSheenK: { value: 1 },
    uGlow: { value: new THREE.Color() },
    uKeyDir: { value: RIG.keyDir.clone() },
    uKeyColor: { value: new THREE.Color(1.0, 0.93, 0.86).multiplyScalar(0.62) },
    uSky: { value: new THREE.Color(1.0, 0.95, 0.93).multiplyScalar(0.42) },
    uGround: { value: new THREE.Color(0.95, 0.66, 0.72).multiplyScalar(0.2) },
    uRimDir: { value: RIG.rimDir.clone() },
    uRimColor: { value: new THREE.Color(0, 0, 0) },
    uDim: { value: 1 },
  };
  setSkinTone(s, DEFAULT_TONE);
  return s;
}

/**
 * Build the two skin variants (they share `shared`).
 * @returns {{ full: THREE.ShaderMaterial, lite: THREE.ShaderMaterial }}
 */
export function createSkinMaterials(shared, detail = null) {
  // detail (hand v2): { map, micro?, tier: 'high' | 'medium' }; null keeps v2's skin
  const defines = {};
  let uniforms = shared;
  if (detail && detail.map) {
    defines.SKIN_DETAIL = '';
    if (detail.tier === 'high' && detail.micro) defines.SKIN_MICRO = '';
    else defines.SKIN_ONE_LOBE = '';
    uniforms = Object.assign({}, shared, {
      uDetailMap: { value: detail.map },
      uDetailScale: { value: detail.scale || 2.5 },
      uWrap: { value: new THREE.Vector3(0.5, 0.26, 0.12) },
      uMicroMap: { value: detail.micro || null },
      uMicroRepeat: { value: detail.repeat || 34 },
    });
  }
  const full = new THREE.ShaderMaterial({
    name: 'SkinFull',
    vertexShader: fullVertex,
    fragmentShader: fullFragment,
    uniforms,
    defines,
    vertexColors: true,
  });
  const lite = new THREE.ShaderMaterial({
    name: 'SkinLite',
    vertexShader: liteVertex,
    fragmentShader: liteFragment,
    uniforms: shared,
    toneMapped: false,
    vertexColors: true,
  });
  return { full, lite };
}

/**
 * Set the skin tone (WP6 clients). Uniform writes only.
 * @param {object} shared result of createSkinShared()
 * @param {THREE.ColorRepresentation} tone
 */
export function setSkinTone(shared, tone) {
  shared.uTone.value.set(tone);
  // Subsurface glow: a warmer, deeper version of the tone.
  // Darker tones get less of it (melanin absorbs it; at full strength it read
  // as a pale rim on the nail folds of the darkest tone).
  const lum = shared.uTone.value.r * 0.3 + shared.uTone.value.g * 0.59 + shared.uTone.value.b * 0.11;
  shared.uGlow.value.set(GLOW_COLOR).lerp(shared.uTone.value, 0.3).multiplyScalar(0.16 * Math.min(1, 0.35 + lum * 1.3));
  shared.uSheenK.value = Math.min(1, 0.25 + lum * 1.4);
  // B9 masks, relative to the tone: blush redder, palm lighter and pinker
  // (most visible on darker tones), cavity a warm red-brown (never grey).
  const t = shared.uTone.value;
  shared.uBlush.value.setRGB(t.r * 1.04, t.g * 0.80, t.b * 0.80);
  shared.uPalm.value.copy(t).lerp(PALM_PINK, 0.35);
  shared.uCavity.value.setRGB(0.80, 0.62, 0.58);
}

/**
 * The skin's micro tile (hand v2, high tier): 256 x 256, generated at load,
 * repeat + mipmaps. rg = a pore / fine-line normal (the diamond lattice of
 * skin: the edges of a jittered cell noise), ba = fine parallel ridges (the
 * pads' print, slightly wavy). Tangent-space slopes, 0.5 = flat.
 */
export function createSkinMicroTile(size = 256) {
  const n = size;
  const h = new Float32Array(n * n);
  const r = new Float32Array(n * n);
  const cells = 22;
  const hash = (x, y) => {
    let k = (x * 374761393 + y * 668265263) | 0;
    k = Math.imul(k ^ (k >>> 13), 1274126177);
    return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
  };
  const pts = [];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + 0.2 + 0.6 * hash(i, j)) / cells, (j + 0.2 + 0.6 * hash(i + 91, j + 17)) / cells]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      const ci = Math.floor(u * cells), cj = Math.floor(v * cells);
      let d1 = 9, d2 = 9;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = (ci + di + cells) % cells, jj = (cj + dj + cells) % cells;
        const p = pts[jj * cells + ii];
        let dx = p[0] + Math.floor((ci + di) / cells) * 0 - u, dy = p[1] - v;
        dx -= Math.round(dx); dy -= Math.round(dy);
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      // a groove along the cell edges, a soft pore dimple at random cells
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      h[y * n + x] = -Math.exp(-edge * edge * cells * cells * 18) - 0.35 * Math.exp(-d1 * cells * cells * 9) * (hash(ci, cj + 5) > 0.6 ? 1 : 0);
      const wv = v * 46 + Math.sin(u * 6.283 * 2) * 0.6 + Math.sin(u * 6.283 * 5 + 1.3) * 0.15;
      r[y * n + x] = Math.sin(wv * 6.283) * 0.5;
    }
  }
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x, xr = y * n + ((x + 1) % n), yr = ((y + 1) % n) * n + x;
      const xl = y * n + ((x - 1 + n) % n), yl = ((y - 1 + n) % n) * n + x;
      const gx = (h[xr] - h[xl]) * 0.5, gy = (h[yr] - h[yl]) * 0.5;
      const rx = (r[xr] - r[xl]) * 0.5, ry = (r[yr] - r[yl]) * 0.5;
      data[i * 4] = Math.max(0, Math.min(255, 128 - gx * 160));
      data[i * 4 + 1] = Math.max(0, Math.min(255, 128 - gy * 160));
      data[i * 4 + 2] = Math.max(0, Math.min(255, 128 - rx * 160));
      data[i * 4 + 3] = Math.max(0, Math.min(255, 128 - ry * 160));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
