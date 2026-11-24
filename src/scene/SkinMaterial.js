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

const lightingChunk = /* glsl */ `
uniform vec3 uTone;
uniform vec3 uBlush;
uniform vec3 uPalm;
uniform vec3 uCavity;
uniform vec3 uGlow;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform float uDim;
// m = skin masks (vertex colour, B9): r blush, g palm side, b cavity, a thinness.
// Every colour is derived from uTone (setSkinTone), so any client tone works.
vec3 skinShade(vec3 N, vec3 V, float sheen, vec4 m) {
float ndl = dot(N, uKeyDir);
float wrap = max((ndl + 0.35 + 0.12 * m.a) / (1.35 + 0.12 * m.a), 0.0);
float ndv = clamp(dot(N, V), 0.0, 1.0);
vec3 tone = mix(uTone, uPalm, m.g * 0.75);
tone = mix(tone, uBlush, m.r * 0.55);
tone *= mix(vec3(1.0), uCavity, m.b * 0.7);
vec3 col = tone * (mix(uGround, uSky, N.y * 0.5 + 0.5) + uKeyColor * wrap);
col += uGlow * (0.7 + 0.6 * m.a) * ((wrap - max(ndl, 0.0)) * 0.9 + pow(1.0 - ndv, 3.0) * 0.55);
col += uRimColor * pow(1.0 - ndv, 2.0) * max(dot(N, uRimDir), 0.0);
col += uKeyColor * pow(max(dot(N, normalize(uKeyDir + V)), 0.0), 28.0) * 0.07 * sheen;
return col * uDim;
}
`;

const skinVertexHead = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
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
varying vec3 vN;
varying vec3 vP;
varying vec4 vM;
void main() {
${skinVertexBody}
vN = nW;
vP = wp.xyz;
vM = skinMask();
}
`;
const fullFragment = /* glsl */ `
${lightingChunk}
varying vec3 vN;
varying vec3 vP;
varying vec4 vM;
void main() {
gl_FragColor = vec4(skinShade(normalize(vN), normalize(cameraPosition - vP), 1.0 - 0.6 * vM.b, vM), 1.0);
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
vec3 v = IN * (skinShade(nW, normalize(cameraPosition - wp.xyz), 0.0, skinMask()) * 2.0);
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
export function createSkinMaterials(shared) {
  const full = new THREE.ShaderMaterial({
    name: 'SkinFull',
    vertexShader: fullVertex,
    fragmentShader: fullFragment,
    uniforms: shared,
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
  shared.uGlow.value.set(GLOW_COLOR).lerp(shared.uTone.value, 0.3).multiplyScalar(0.16);
  // B9 masks, relative to the tone: blush redder, palm lighter and pinker
  // (most visible on darker tones), cavity a warm red-brown (never grey).
  const t = shared.uTone.value;
  shared.uBlush.value.setRGB(t.r * 1.04, t.g * 0.80, t.b * 0.80);
  shared.uPalm.value.copy(t).lerp(PALM_PINK, 0.35);
  shared.uCavity.value.setRGB(0.80, 0.62, 0.58);
}
