/**
 * NailMaterial.js
 * v1 nail shader: composites the natural nail, legacy solid polish, the live
 * (or baked) paint texture and the decoration canvas, then lights the result.
 *
 * Layer order, bottom to top:
 *   natural nail  ->  legacy solid colour (setPolishColor)  ->  paint  ->  deco
 * Stickers and drawings live in the deco layer, so painting never covers or
 * wipes them.
 *
 * Paint texture contract (written by FluidSimulator):
 *   rgb = sRGB colour blended over black with the splat alpha,
 *   a   = coverage with a bristle-streak profile (max-blended).
 * Deco texture: 2D canvas, premultiplied on upload, sRGB.
 *
 * The lighting block is deliberately plain and clearly marked: WP3 replaces it.
 * All materials share one program (identical source, no per-nail defines), so
 * ten nails cost one compile.
 */
import * as THREE from 'three';

export const FINISH_IDS = Object.freeze({
  glossy: 0,
  matte: 1,
  shimmer: 2,
  chrome: 3,
  holographic: 4,
});

// Per-finish lighting parameters for the v1 block (uniform-driven, no recompiles).
const FINISH_PARAMS = Object.freeze({
  glossy: Object.freeze({ specular: 1.0, shininess: 140, metal: 0.0, sparkle: 0.0, env: 0.55 }),
  matte: Object.freeze({ specular: 0.06, shininess: 10, metal: 0.0, sparkle: 0.0, env: 0.05 }),
  shimmer: Object.freeze({ specular: 0.9, shininess: 90, metal: 0.25, sparkle: 1.0, env: 0.5 }),
  chrome: Object.freeze({ specular: 1.6, shininess: 320, metal: 0.85, sparkle: 0.0, env: 1.4 }),
  holographic: Object.freeze({ specular: 1.1, shininess: 160, metal: 0.35, sparkle: 0.4, env: 0.8 }),
});

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;

void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uPaintMap;
uniform float uHasPaint;
uniform sampler2D uDecoMap;
uniform float uHasDeco;
uniform vec3 uBaseColor;
uniform vec3 uUnderColor;
uniform float uUnderAmount;
uniform float uWet;
uniform int uFinish;
uniform float uHighlight;
uniform float uRevealPulse;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform samplerCube uEnvMap;
uniform float uHasEnv;
uniform float uSpecular;
uniform float uShininess;
uniform float uMetal;
uniform float uSparkle;
uniform float uEnvAmount;

varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;

vec3 decodeSRGB(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // --- LAYERS ---
  vec3 albedo = mix(uBaseColor, uUnderColor, uUnderAmount);
  float cover = uUnderAmount;

  if (uHasPaint > 0.5) {
    vec4 paint = texture2D(uPaintMap, vUv);
    // Soft splat edges are colour-over-black: un-premultiply them. Dense paint
    // has converged to the true colour, so use it as stored.
    vec3 straight = paint.rgb / max(paint.a, 0.004);
    vec3 pc = clamp(mix(straight, paint.rgb, smoothstep(0.55, 0.8, paint.a)), 0.0, 1.0);
    float k = smoothstep(0.02, 0.6, paint.a);
    albedo = mix(albedo, decodeSRGB(pc), k);
    cover = max(cover, k);
  }

  if (uHasDeco > 0.5) {
    vec4 deco = texture2D(uDecoMap, vUv); // premultiplied alpha
    vec3 decoStraight = deco.rgb / max(deco.a, 0.004);
    albedo = albedo * (1.0 - deco.a) + decodeSRGB(decoStraight) * deco.a;
  }

  // --- LIGHTING (WP3 replaces) ---
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 5.0);

  float metal = uMetal * cover;
  float shin = mix(48.0, uShininess, cover);
  float specK = mix(0.35, uSpecular, cover) * (1.0 + 0.6 * uWet);
  float spec = pow(ndh, shin) * specK * (shin + 8.0) * 0.04;

  vec3 ambient = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  vec3 diffuseCol = albedo * (1.0 - metal);
  vec3 specCol = mix(vec3(1.0), albedo, metal);

  vec3 lit = diffuseCol * (ambient + uLightColor * ndl);
  lit += specCol * uLightColor * spec;

  // Cheap environment: sky/ground gradient seen in the reflection.
  vec3 R = reflect(-V, N);
  vec3 env = mix(uGroundColor, uSkyColor, smoothstep(-0.4, 0.8, R.y));
  if (uHasEnv > 0.5) env = textureCube(uEnvMap, R).rgb;
  float envK = mix(0.15, uEnvAmount, cover) * (0.04 + 0.96 * fres + metal * 0.6);
  lit += env * specCol * envK;

  if (uSparkle > 0.0) {
    float s = step(0.94, hash12(floor(vUv * 220.0)));
    lit += s * uSparkle * cover * uLightColor * (0.25 + 1.5 * pow(ndh, 6.0));
  }

  if (uFinish == 4) {
    // holographic: hue drifts with view angle
    vec3 holo = 0.5 + 0.5 * cos(6.2831 * (ndv * 1.3 + vUv.x * 0.6 + vec3(0.0, 0.33, 0.67)));
    lit += holo * cover * 0.35 * (0.3 + fres);
  }

  // Selection highlight: soft pink rim, never washes the paint.
  lit += uHighlight * (0.15 + fres) * vec3(1.0, 0.55, 0.75) * 0.35;

  // Reveal sparkle sweep.
  if (uRevealPulse > 0.0) {
    float centre = uRevealPulse * 1.4 - 0.2;
    float band = 1.0 - smoothstep(0.0, 0.08, abs(vUv.y + vUv.x * 0.3 - centre));
    lit += band * vec3(1.0, 0.92, 0.96) * 0.9;
  }

  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Shared lighting uniforms. Every nail material references the same objects,
 * so NailScene can update the light once for all nails.
 */
export function createNailLighting() {
  return {
    uLightDir: { value: new THREE.Vector3(0.2, 1.0, 0.45).normalize() },
    // ACES in three applies exposure / 0.6, so ~0.5 irradiance reads as albedo.
    uLightColor: { value: new THREE.Color(1.0, 0.98, 0.96).multiplyScalar(0.5) },
    uSkyColor: { value: new THREE.Color('#ffffff').multiplyScalar(0.3) },
    uGroundColor: { value: new THREE.Color('#ffd6e2').multiplyScalar(0.12) },
    uEnvMap: { value: null },
    uHasEnv: { value: 0 },
  };
}

/**
 * Create one nail material.
 * @param {object} settings quality settings (unused by v1; WP3 picks defines from it)
 * @param {object} lighting result of createNailLighting(), shared between nails
 */
export function createNailMaterial(settings, lighting) {
  const shared = lighting || createNailLighting();
  const material = new THREE.ShaderMaterial({
    name: 'NailMaterial',
    vertexShader,
    fragmentShader,
    uniforms: {
      uPaintMap: { value: null },
      uHasPaint: { value: 0 },
      uDecoMap: { value: null },
      uHasDeco: { value: 0 },
      uBaseColor: { value: new THREE.Color('#FFDDD2') },
      uUnderColor: { value: new THREE.Color('#FFDDD2') },
      uUnderAmount: { value: 0 },
      uWet: { value: 0 },
      uFinish: { value: FINISH_IDS.glossy },
      uHighlight: { value: 0 },
      uRevealPulse: { value: 0 },
      uSpecular: { value: FINISH_PARAMS.glossy.specular },
      uShininess: { value: FINISH_PARAMS.glossy.shininess },
      uMetal: { value: FINISH_PARAMS.glossy.metal },
      uSparkle: { value: FINISH_PARAMS.glossy.sparkle },
      uEnvAmount: { value: FINISH_PARAMS.glossy.env },
      uLightDir: shared.uLightDir,
      uLightColor: shared.uLightColor,
      uSkyColor: shared.uSkyColor,
      uGroundColor: shared.uGroundColor,
      uEnvMap: shared.uEnvMap,
      uHasEnv: shared.uHasEnv,
    },
    side: THREE.FrontSide,
  });
  return material;
}

/**
 * Point a nail material at a finish. Uniform writes only.
 */
export function applyNailFinish(material, finish) {
  const params = FINISH_PARAMS[finish] || FINISH_PARAMS.glossy;
  const u = material.uniforms;
  u.uFinish.value = FINISH_IDS[finish] ?? FINISH_IDS.glossy;
  u.uSpecular.value = params.specular;
  u.uShininess.value = params.shininess;
  u.uMetal.value = params.metal;
  u.uSparkle.value = params.sparkle;
  u.uEnvAmount.value = params.env;
}
