/**
 * Confetti.js (WP7)
 * Two confetti cannons fire from the bottom corners of the screen.
 *
 * One instanced quad mesh, `settings.confetti` pieces (160 / 90 / 40), fully
 * GPU-animated: per-piece `aSeed` (vec4) and `aColor` are written once at
 * construction; the vertex shader does ballistic flight with drag, flutter
 * sway and a paper flip from `uT`. Positions are in screen units (y -1..1,
 * x -aspect..aspect), so it works for any camera position. The CPU writes one
 * uniform per frame and nothing at all while idle (mesh hidden: no draw).
 */
import * as THREE from 'three';

const MAX = 160;
const LIFE = 2.7; // seconds until the last piece has left

// sRGB values written straight to the (sRGB) canvas: no colour management.
const COLORS = [0xff2a6d, 0xffd21f, 0x22c3ff, 0x5ef0a0, 0xb15cff, 0xff8a1f, 0xffffff, 0xff7ad9];

const vertexShader = /* glsl */ `
uniform float uT;
uniform float uAspect;
uniform float uScale;
attribute vec4 aSeed;
attribute vec3 aColor;
varying vec3 vC;
varying float vA;
void main() {
  float t = uT - aSeed.w * 0.18;
  if (t < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  float side = aSeed.x < 0.5 ? -1.0 : 1.0;
  float ang = 0.22 + 0.7 * fract(aSeed.x * 7.31);
  float sp = 2.6 + 1.5 * aSeed.y;
  vec2 v = vec2(-side * sin(ang) * min(1.0, uAspect * 0.8), cos(ang)) * sp;
  const float k = 2.2;
  const float g = 3.0;
  float e = (1.0 - exp(-k * t)) / k;
  vec2 c = vec2(side * (uAspect + 0.02), -1.06);
  c.x += v.x * e + 0.07 * sin(t * (4.0 + 3.0 * aSeed.z) + aSeed.y * 6.28) * smoothstep(0.3, 0.9, t);
  c.y += (v.y + g / k) * e - g / k * t;
  float w = 0.03 * uScale * (0.75 + 0.6 * aSeed.z);
  float h = w * (0.4 + 0.35 * aSeed.y);
  float flip = cos(t * (6.0 + 8.0 * aSeed.y) + aSeed.z * 6.28);
  float r = aSeed.y * 6.28 + t * (3.0 + 5.0 * aSeed.z) * side;
  vec2 q = vec2(position.x * w * flip, position.y * h);
  q = vec2(q.x * cos(r) - q.y * sin(r), q.x * sin(r) + q.y * cos(r));
  c += q;
  gl_Position = vec4(c.x / uAspect, c.y, 0.0, 1.0);
  float f = abs(flip);
  vC = aColor * (0.62 + 0.38 * f) + 0.3 * pow(f, 12.0);
  vA = 1.0 - smoothstep(${(LIFE - 0.6).toFixed(2)}, ${LIFE.toFixed(2)}, t);
}`;

const fragmentShader = /* glsl */ `
varying vec3 vC;
varying float vA;
void main() { gl_FragColor = vec4(vC, vA); }`;

export class Confetti {
  constructor(scene) {
    this.scene = scene;
    this.t = 0;
    this.active = false;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seed = new Float32Array(MAX * 4);
    const col = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) {
      seed[i * 4] = (i & 1) * 0.5 + Math.random() * 0.5; // alternate cannons
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random();
      seed[i * 4 + 3] = Math.random();
      const c = COLORS[i % COLORS.length];
      col[i * 3] = (c >> 16) / 255;
      col[i * 3 + 1] = ((c >> 8) & 255) / 255;
      col[i * 3 + 2] = (c & 255) / 255;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
    geo.instanceCount = MAX;

    this.material = new THREE.ShaderMaterial({
      name: 'Confetti',
      vertexShader,
      fragmentShader,
      uniforms: { uT: { value: 0 }, uAspect: { value: 1 }, uScale: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Confetti';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Compile the program now so the burst never compiles a shader. */
  prewarm(renderer, camera) {
    this.mesh.visible = true;
    try { renderer.compile(this.mesh, camera, this.scene); } catch (err) { /* optimisation only */ }
    this.mesh.visible = this.active;
  }

  /**
   * Fire `count` pieces (capped at 160) for a screen of the given aspect.
   * Fewer pieces are drawn bigger (sqrt(160 / count)) so 40 still read.
   * Calling it again refires the same pieces.
   */
  burst(count, aspect) {
    const n = Math.max(1, Math.min(MAX, count | 0));
    const u = this.material.uniforms;
    this.mesh.geometry.instanceCount = n;
    u.uAspect.value = aspect || 1;
    u.uScale.value = Math.sqrt(MAX / n);
    this.t = 0;
    u.uT.value = 0;
    this.active = true;
    this.mesh.visible = true;
  }

  /** Loop dt. Returns true while confetti is on screen. */
  update(dt) {
    if (!this.active) return false;
    this.t += dt;
    if (this.t > LIFE + 0.2) {
      this.active = false;
      this.mesh.visible = false;
    }
    this.material.uniforms.uT.value = this.t;
    return true;
  }

  stop() {
    this.active = false;
    this.mesh.visible = false;
  }
}
