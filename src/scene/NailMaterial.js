/**
 * NailMaterial.js
 * v2 nail shader (WP3): one shader, tier #defines, uniform-driven finishes.
 *
 * Layer order, bottom to top:
 *   natural nail -> legacy solid colour (setPolishColor) -> paint -> deco -> top coat
 * Stickers and drawings live in the deco layer, so painting never covers or
 * wipes them; the top coat seals everything under one gloss.
 *
 * Paint texture contract (uPaintMap, written by FluidSimulator, WP4):
 *   PREMULTIPLIED alpha, accumulated with the "over" operator:
 *     rgb = splat colour * splat alpha, composited over (0,0,0,0)
 *     a   = coverage, a_new = a_src + a_dst * (1 - a_src)
 *   i.e. colour: SRC_ALPHA (straight splat colour) / ONE_MINUS_SRC_ALPHA,
 *        alpha:  ONE / ONE_MINUS_SRC_ALPHA, both with ADD.
 *   Colour values are sRGB-encoded 0..1 (decoded after un-premultiplying).
 *   The shader ALWAYS un-premultiplies (rgb / a). It also tolerates the WP1
 *   max-blended alpha (where rgb / a can exceed 1): it renormalises by the
 *   largest channel, which keeps the hue exact for repeated same-colour dabs.
 *   Streaks in `a` only modulate the wet relief, never the colour.
 * Deco texture (uDecoMap): 2D canvas, premultiplied on upload, sRGB.
 *
 * Tier defines (quality.settings.nailShaderDefines):
 *   high   GLITTER_2, WET_NORMAL_TAPS, ENV_LOD, HOLO
 *   medium GLITTER_1, WET_NORMAL_DERIV, ENV_LOD
 *   low    GLITTER_CHEAP (single env tap, no wet relief)
 *
 * All nails of one tier share one program. Variants for other tiers share the
 * SAME uniforms object, so a tier swap is a material pointer swap.
 */
import * as THREE from 'three';
import { RIG } from './SalonEnvironment.js';

export const FINISH_IDS = Object.freeze({
  glossy: 0,
  matte: 1,
  shimmer: 2,
  chrome: 3,
  holographic: 4,
});

/**
 * Finish parameters (uniforms only, no recompiles).
 *   metal      0 = dielectric pigment, 1 = coloured mirror (chrome)
 *   coat       top-coat reflection strength (0 = matte)
 *   rough      cured top-coat roughness 0..1 (-> env lod and ring blur)
 *   flake      glitter density 0..1, flakeScale cells per nail length, flakeGain brightness
 *   sheen      soft velvet sheen at grazing angles (matte)
 *   holo       rainbow flakes and sheen (high tier only; plain flakes elsewhere)
 */
export const FINISHES = Object.freeze({
  glossy: Object.freeze({ metal: 0.0, coat: 1.0, rough: 0.06, flake: 0.0, flakeScale: 60, flakeGain: 0.0, sheen: 0.0, holo: 0.0 }),
  matte: Object.freeze({ metal: 0.0, coat: 0.0, rough: 0.6, flake: 0.0, flakeScale: 60, flakeGain: 0.0, sheen: 1.0, holo: 0.0 }),
  shimmer: Object.freeze({ metal: 0.25, coat: 0.9, rough: 0.08, flake: 0.6, flakeScale: 38, flakeGain: 3.2, sheen: 0.0, holo: 0.0 }),
  chrome: Object.freeze({ metal: 1.0, coat: 0.3, rough: 0.1, flake: 0.0, flakeScale: 60, flakeGain: 0.0, sheen: 0.0, holo: 0.0 }),
  holographic: Object.freeze({ metal: 0.35, coat: 1.0, rough: 0.07, flake: 0.55, flakeScale: 52, flakeGain: 2.2, sheen: 0.0, holo: 1.0 }),
});

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
varying vec3 vTanW;
varying vec3 vBitW;

void main() {
  vUv = uv;
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  mat3 m = mat3(modelMatrix);
  vNormalW = normalize(m * normal);
  // Nail UVs are a planar projection of local x / y: tangent = local x, bitangent = local y.
  vTanW = normalize(m[0]);
  vBitW = normalize(m[1]);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uPaintMap;
uniform float uHasPaint;
uniform float uPaintTexel;      // 1 / paint texture size
uniform sampler2D uDecoMap;
uniform float uHasDeco;
uniform vec3 uBaseColor;        // natural nail tint (linear)
uniform vec3 uUnderColor;
uniform float uUnderAmount;
uniform float uWet;
uniform float uHighlight;
uniform float uRevealPulse;
uniform float uAspect;          // nail width / length (u over v), for round flakes

// nail frame in object space (natural nail features, cuticle shading)
uniform vec3 uNailCentre;
uniform vec3 uNailAxis;         // unit, points toward the cuticle
uniform vec3 uNailSide;         // unit, across the nail
uniform vec2 uNailHalf;         // half length, half width

// finish
uniform float uMetal;
uniform float uCoat;
uniform float uRough;
uniform float uFlake;
uniform float uFlakeScale;
uniform float uFlakeGain;
uniform float uSheen;
uniform float uHolo;

// shared lighting
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform samplerCube uEnvMap;
uniform float uHasEnv;
uniform float uEnvScale;
uniform float uEnvMaxLod;
uniform float uEnvIntensity;
uniform vec4 uRing;             // inner radius, outer radius (rad), intensity, unused
uniform vec3 uRimDir;
uniform vec3 uRimColor;

varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vLocal;
varying vec3 vTanW;
varying vec3 vBitW;

vec3 decodeSRGB(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 envSample(vec3 dir, float lod) {
  if (uHasEnv < 0.5) return mix(uGroundColor, uSkyColor, smoothstep(-0.3, 0.7, dir.y)) * 2.0;
  #ifdef ENV_LOD
    return textureLod(uEnvMap, dir, lod).rgb * uEnvScale;
  #else
    return textureLod(uEnvMap, dir, 1.0).rgb * uEnvScale;
  #endif
}

// The ring light, drawn analytically: crisp at any cube resolution.
float ringLight(vec3 R, float blur) {
  float c = dot(R, uLightDir);
  float ang = sqrt(max(2.0 - 2.0 * c, 0.0));
  return smoothstep(uRing.x - blur, uRing.x + blur, ang) * (1.0 - smoothstep(uRing.y - blur, uRing.y + blur, ang));
}

#ifdef WET_NORMAL_TAPS
float paintA(vec2 uv) { return texture2D(uPaintMap, uv).a; }
#endif

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  if (dot(N, V) < 0.0) N = -N;
  vec3 T = normalize(vTanW - N * dot(N, vTanW));
  vec3 B = normalize(vBitW - N * dot(N, vBitW) - T * dot(T, vBitW));

  // --- natural nail -------------------------------------------------------
  vec3 rel = vLocal - uNailCentre;
  float s = dot(rel, uNailAxis) / uNailHalf.x;   // -1 free edge .. +1 cuticle
  float w = dot(rel, uNailSide) / uNailHalf.y;   // -1 .. +1 across
  vec3 nail = uBaseColor;
  // lunula: a pale half moon at the cuticle
  float lun = 1.0 - smoothstep(0.75, 1.0, length(vec2(w * 0.9, (s - 1.05) * 2.1)));
  nail = mix(nail, vec3(0.93, 0.80, 0.76), lun * 0.55);
  // free edge: whiter and a touch translucent
  float freeEdge = smoothstep(-0.62, -0.86, s);
  nail = mix(nail, vec3(0.97, 0.90, 0.84), freeEdge * 0.85);
  // faint longitudinal ridges
  nail *= 0.985 + 0.015 * sin(w * 37.0);

  // --- layers ---------------------------------------------------------------
  vec3 albedo = mix(nail, uUnderColor, uUnderAmount);
  float cov = uUnderAmount;
  float relief = 0.0;
  vec2 g = vec2(0.0);
  if (uHasPaint > 0.5) {
    vec4 p = texture2D(uPaintMap, vUv);
    vec3 straight = p.rgb / max(p.a, 0.004);
    straight /= max(1.0, max(straight.r, max(straight.g, straight.b)));
    float k = smoothstep(0.03, 0.45, p.a);
    // pooled pigment: a slightly deeper rim where coverage changes fast
    float pool = clamp(fwidth(p.a) * 6.0, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, p.a));
    vec3 pc = decodeSRGB(straight) * (1.0 - 0.22 * pool * (0.5 + uWet));
    albedo = mix(albedo, pc, k);
    cov = max(cov, k);
    // wet relief, faded when the paint texture is minified (no moire)
    float foot = max(fwidth(vUv.x), fwidth(vUv.y)) / uPaintTexel;
    relief = uWet * k * (1.0 - smoothstep(0.6, 1.8, foot));
    #ifdef WET_NORMAL_TAPS
      if (relief > 0.001) {
        float d = uPaintTexel * 1.5;
        g = vec2(paintA(vUv + vec2(d, 0.0)) - paintA(vUv - vec2(d, 0.0)),
                 paintA(vUv + vec2(0.0, d)) - paintA(vUv - vec2(0.0, d)));
      }
    #elif defined(WET_NORMAL_DERIV)
      g = vec2(dFdx(p.a), dFdy(p.a));
    #endif
  }
  vec3 pigment = albedo;

  if (uHasDeco > 0.5) {
    vec4 deco = texture2D(uDecoMap, vUv); // premultiplied
    vec3 decoStraight = deco.rgb / max(deco.a, 0.004);
    albedo = albedo * (1.0 - deco.a) + decodeSRGB(decoStraight) * deco.a;
    cov = max(cov, deco.a);
  }

  // --- normal: wet relief + liquid wobble ----------------------------------
  #ifdef WET_NORMAL_TAPS
    N = normalize(N - (g.x * T + g.y * B) * relief * 0.9);
  #elif defined(WET_NORMAL_DERIV)
    {
      vec3 dpx = dFdx(vPosW);
      vec3 dpy = dFdy(vPosW);
      vec3 r1 = cross(dpy, N);
      vec3 r2 = cross(N, dpx);
      float det = dot(dpx, r1);
      vec3 grad = sign(det) * (g.x * r1 + g.y * r2);
      N = normalize(abs(det) * N - grad * relief * 0.35);
    }
  #endif
  float wob = uWet * cov;
  N = normalize(N + (sin(vUv.y * 23.0 + vUv.x * 9.0) * T + cos(vUv.x * 19.0 - vUv.y * 13.0) * B) * 0.03 * wob);

  vec3 L = uLightDir;
  vec3 R = reflect(-V, N);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float NdL = max(dot(N, L), 0.0);
  float F = 0.05 + 0.95 * pow(1.0 - NdV, 5.0);

  // finish weights fade to the natural nail where nothing is painted
  float metal = uMetal * cov;
  float coatK = mix(0.7, uCoat, cov);
  float rough = mix(0.16, uRough, cov);
  float sheenK = uSheen * cov;

  // --- base layer ----------------------------------------------------------
  vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  vec3 irr = hemi + uLightColor * NdL + uRimColor * pow(1.0 - NdV, 2.0) * max(dot(N, uRimDir), 0.0);
  // cuticle and side folds sit in the skin's shadow
  float ao = 1.0 - 0.38 * smoothstep(0.72, 1.02, s) - 0.28 * smoothstep(0.78, 1.0, abs(w));
  vec3 col = albedo * irr * 1.12 * ao * (1.0 - metal);

  // matte: soft velvet sheen, no mirror
  col += sheenK * pow(1.0 - NdV, 2.5) * hemi * (0.35 + 0.65 * albedo);

  // chrome: a coloured mirror of the room
  vec3 tint = mix(vec3(1.0), pigment / max(max(pigment.r, pigment.g), max(pigment.b, 0.02)), 0.88);
  if (metal > 0.001) {
    float mlod = (rough + 0.06) * uEnvMaxLod;
    vec3 env = envSample(R, mlod);
    // stylised mirror: push the room's contrast so a small, mostly top-lit
    // nail still reads as polished metal (bright streaks, deep tinted bands)
    float el = dot(env, vec3(0.3, 0.5, 0.2));
    vec3 m = tint * mix(0.22, 1.7, smoothstep(0.12, 1.5, el)) + max(env - 1.3, 0.0) * 0.5;
    m += ringLight(R, 0.02 + rough * 0.25) * uRing.z * mix(tint, vec3(1.0), 0.5);
    // a broad hot spot around the ring: the bright "powder chrome" bloom
    m += pow(max(dot(R, L), 0.0), 10.0) * 1.6 * mix(tint, vec3(1.0), 0.4);
    col += m * metal * uEnvIntensity * ao;
  }

  // --- glitter / shimmer ----------------------------------------------------
  float flake = uFlake * cov;
  if (flake > 0.001) {
    vec2 gp = vUv * vec2(uAspect, 1.0) * uFlakeScale;
    float fw = length(fwidth(gp));
    float resolve = 1.0 - smoothstep(0.45, 1.1, fw);   // cells under ~1px: average, do not crawl
    vec3 fl = vec3(0.0);
    #if defined(GLITTER_2) || defined(GLITTER_1)
      {
        vec2 cell = floor(gp);
        vec2 f = fract(gp) - 0.5;
        float h = hash12(cell);
        vec2 tilt = hash22(cell + 7.3) * 2.0 - 1.0;
        vec3 Nf = normalize(N + (tilt.x * T + tilt.y * B) * 0.55);
        float on = step(1.0 - flake, h) * (1.0 - smoothstep(0.18, 0.34, length(f)));
        vec3 Rf = reflect(-V, Nf);
        float sp = pow(max(dot(Rf, L), 0.0), 40.0) * 3.0 + ringLight(Rf, 0.12) * 1.5;
        vec3 fc = mix(vec3(1.0), pigment * 1.6 + 0.15, 0.55);
        #ifdef HOLO
          fc = mix(fc, 0.55 + 0.45 * cos(6.2831 * (NdV * 1.6 + h * 0.8 + vec3(0.0, 0.33, 0.67))), uHolo);
        #endif
        fl += on * sp * fc;
      }
    #endif
    #ifdef GLITTER_2
      {
        vec2 gp2 = gp * 2.3 + 17.0;
        vec2 cell = floor(gp2);
        vec2 f = fract(gp2) - 0.5;
        float h = hash12(cell);
        vec2 tilt = hash22(cell + 3.1) * 2.0 - 1.0;
        vec3 Nf = normalize(N + (tilt.x * T + tilt.y * B) * 0.7);
        float on = step(1.0 - flake * 0.8, h) * (1.0 - smoothstep(0.16, 0.32, length(f)));
        float sp = pow(max(dot(reflect(-V, Nf), L), 0.0), 56.0) * 2.0;
        fl += on * sp * mix(vec3(1.0), pigment + 0.2, 0.4) * (1.0 - smoothstep(0.4, 1.0, fw * 2.3));
      }
    #endif
    #ifdef GLITTER_CHEAP
      {
        float h = hash12(floor(gp));
        float tw = fract(h * 13.7 + dot(V, vec3(3.1, 1.7, 2.3)) * 2.0);
        fl += step(1.0 - flake * 0.6, h) * smoothstep(0.82, 0.98, tw) * (0.4 + NdL) * 1.6 * (pigment + 0.35);
      }
    #endif
    // what the eye still sees of sub-pixel flakes: a fine sparkle haze
    vec3 haze = (pigment + 0.3) * flake * (0.18 + 0.9 * pow(max(dot(R, L), 0.0), 6.0));
    col += (fl * resolve * uFlakeGain + haze * (1.0 - resolve * 0.6)) * uLightColor * 1.6;
    #ifdef HOLO
      col += uHolo * cov * 0.22 * (0.55 + 0.45 * cos(6.2831 * (NdV * 1.3 + vUv.x * 0.7 + vec3(0.0, 0.33, 0.67)))) * (0.3 + F);
    #endif
  }

  // --- top coat: the wet-to-cured story --------------------------------------
  if (coatK > 0.001) {
    float coatRough = mix(rough, 0.0, uWet);
    vec3 env = envSample(R, coatRough * uEnvMaxLod);
    float ringBlur = mix(0.012 + rough * 0.3, 0.03, uWet);
    float ring = ringLight(R, ringBlur) * uRing.z * mix(1.0, 1.35, uWet);
    vec3 coat = (env + ring) * F * coatK * uEnvIntensity;
    col += coat * mix(1.0, ao, 0.5);
  }

  // selection: a soft pink rim that never washes the paint
  col += uHighlight * pow(1.0 - NdV, 3.0) * vec3(1.0, 0.45, 0.7) * 0.25;

  // reveal sparkle sweep
  if (uRevealPulse > 0.0) {
    float centre = uRevealPulse * 1.4 - 0.2;
    float band = 1.0 - smoothstep(0.0, 0.08, abs(vUv.y + vUv.x * 0.3 - centre));
    col += band * vec3(1.0, 0.92, 0.96) * 0.9;
  }

  // Hue-preserving tone mapping blend: ACES alone pushes saturated pigments
  // toward white (a royal blue reads periwinkle). Map the brightest channel and
  // scale the colour, then keep a little of the filmic roll-off for highlights.
  #ifdef TONE_MAPPING
    float mx = max(col.r, max(col.g, col.b));
    vec3 aces = toneMapping(col);
    vec3 hp = col * (toneMapping(vec3(mx)).g / max(mx, 1e-4));
    col = mix(aces, hp, 0.7);
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Shared lighting uniforms. Every nail material references the same objects,
 * so NailScene updates light, environment and dimming once for all nails.
 */
export function createNailLighting() {
  return {
    uLightDir: { value: RIG.keyDir.clone() },
    uLightColor: { value: new THREE.Color(1.0, 0.94, 0.88).multiplyScalar(0.62) },
    uSkyColor: { value: new THREE.Color('#fff3ea').multiplyScalar(0.46) },
    uGroundColor: { value: new THREE.Color('#f3b6c6').multiplyScalar(0.2) },
    uEnvMap: { value: null },
    uHasEnv: { value: 0 },
    uEnvScale: { value: 1 },
    uEnvMaxLod: { value: 7 },
    uEnvIntensity: { value: 1 },
    uRing: { value: new THREE.Vector4(RIG.ringInner, RIG.ringOuter, 16.0, 0) },
    uRimDir: { value: RIG.rimDir.clone() },
    uRimColor: { value: new THREE.Color(0, 0, 0) },
  };
}

function definesFor(settings) {
  const d = settings && settings.nailShaderDefines;
  return Object.assign({}, d || { GLITTER_CHEAP: '' });
}

/**
 * Create a nail's uniforms (per nail; lighting entries are shared objects).
 */
export function createNailUniforms(lighting) {
  const shared = lighting || createNailLighting();
  const f = FINISHES.glossy;
  return {
    uPaintMap: { value: null },
    uHasPaint: { value: 0 },
    uPaintTexel: { value: 1 / 512 },
    uDecoMap: { value: null },
    uHasDeco: { value: 0 },
    uBaseColor: { value: new THREE.Color('#f7c3c6') },
    uUnderColor: { value: new THREE.Color('#FFDDD2') },
    uUnderAmount: { value: 0 },
    uWet: { value: 0 },
    uFinish: { value: FINISH_IDS.glossy },
    uHighlight: { value: 0 },
    uRevealPulse: { value: 0 },
    uAspect: { value: 1 },
    uNailCentre: { value: new THREE.Vector3() },
    uNailAxis: { value: new THREE.Vector3(0, 1, 0) },
    uNailSide: { value: new THREE.Vector3(1, 0, 0) },
    uNailHalf: { value: new THREE.Vector2(1, 1) },
    uMetal: { value: f.metal },
    uCoat: { value: f.coat },
    uRough: { value: f.rough },
    uFlake: { value: f.flake },
    uFlakeScale: { value: f.flakeScale },
    uFlakeGain: { value: f.flakeGain },
    uSheen: { value: f.sheen },
    uHolo: { value: f.holo },
    uLightDir: shared.uLightDir,
    uLightColor: shared.uLightColor,
    uSkyColor: shared.uSkyColor,
    uGroundColor: shared.uGroundColor,
    uEnvMap: shared.uEnvMap,
    uHasEnv: shared.uHasEnv,
    uEnvScale: shared.uEnvScale,
    uEnvMaxLod: shared.uEnvMaxLod,
    uEnvIntensity: shared.uEnvIntensity,
    uRing: shared.uRing,
    uRimDir: shared.uRimDir,
    uRimColor: shared.uRimColor,
  };
}

/**
 * Create one nail material for a tier.
 * @param {object} settings quality settings (nailShaderDefines)
 * @param {object} lighting result of createNailLighting(), shared between nails
 * @param {object} [uniforms] an existing nail's uniforms (tier variants share them)
 */
export function createNailMaterial(settings, lighting, uniforms = null) {
  return new THREE.ShaderMaterial({
    name: 'NailMaterial',
    vertexShader,
    fragmentShader,
    uniforms: uniforms || createNailUniforms(lighting),
    defines: definesFor(settings),
    side: THREE.FrontSide,
  });
}

/** Stable key for the define set of a tier (one material variant per key). */
export function nailVariantKey(settings) {
  const d = (settings && settings.nailShaderDefines) || { GLITTER_CHEAP: '' };
  return Object.keys(d).sort().join('|');
}

/**
 * Point a nail material at a finish. Uniform writes only.
 */
export function applyNailFinish(material, finish) {
  const p = FINISHES[finish] || FINISHES.glossy;
  const u = material.uniforms;
  u.uFinish.value = FINISH_IDS[finish] ?? FINISH_IDS.glossy;
  u.uMetal.value = p.metal;
  u.uCoat.value = p.coat;
  u.uRough.value = p.rough;
  u.uFlake.value = p.flake;
  u.uFlakeScale.value = p.flakeScale;
  u.uFlakeGain.value = p.flakeGain;
  u.uSheen.value = p.sheen;
  u.uHolo.value = p.holo;
}
