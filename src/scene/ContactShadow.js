/**
 * ContactShadow.js
 * A soft shadow of the hand on the desk, baked once per hand (the hand is
 * static). Zero per-frame cost on every tier: the desk shader samples the
 * result.
 *
 *   high / medium  GPU bake: the hand is rendered from an orthographic camera
 *                  under the desk looking up, with a black override material
 *                  whose alpha falls off with height above the desk (contact is
 *                  dark, raised fingers are faint). Then a separable 9-tap blur
 *                  (2 passes high, 1 medium). One-time cost, a few draws.
 *   low            no GPU pass at all: the skinned vertices are splatted on the
 *                  CPU into a small canvas, blurred with the 2D canvas filter.
 *
 * World xz -> shadow uv is affine; `mapping` holds origin + the two axes so the
 * desk shader never needs to know the camera conventions.
 */
import * as THREE from 'three';

const MARGIN = 0.35;         // world units around the hand footprint
const MAX_HEIGHT = 0.9;      // above the desk, the hand casts nothing

const blurVertex = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const blurFragment = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
vec4 s = texture2D(uSource, vUv) * 0.2270270270;
s += texture2D(uSource, vUv + uStep * 1.3846153846) * 0.3162162162;
s += texture2D(uSource, vUv - uStep * 1.3846153846) * 0.3162162162;
s += texture2D(uSource, vUv + uStep * 3.2307692308) * 0.0702702703;
s += texture2D(uSource, vUv - uStep * 3.2307692308) * 0.0702702703;
gl_FragColor = s;
}
`;

export class ContactShadow {
  constructor() {
    this.texture = null;          // what the desk samples (r channel = darkness)
    this._target = null;          // GPU result
    this._canvasTexture = null;   // CPU result
    // uv = origin + x * axisX + z * axisZ
    this.mapping = {
      origin: new THREE.Vector2(0, 0),
      axisX: new THREE.Vector2(1, 0),
      axisZ: new THREE.Vector2(0, 1),
    };
    this._bounds = new THREE.Box3();
  }

  /**
   * Compute the footprint and the desk height for a hand group.
   * @returns {{ bounds: THREE.Box3, points: Float32Array }}
   */
  static sampleHand(group, stride = 2) {
    const v = new THREE.Vector3();
    const pts = [];
    const bounds = new THREE.Box3();
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      if (o.isSkinnedMesh) o.skeleton.update();
      for (let i = 0; i < pos.count; i += stride) {
        if (o.isSkinnedMesh) o.getVertexPosition(i, v);
        else v.fromBufferAttribute(pos, i);
        v.applyMatrix4(o.matrixWorld);
        pts.push(v.x, v.y, v.z);
        bounds.expandByPoint(v);
      }
    });
    return { bounds, points: new Float32Array(pts) };
  }

  /**
   * Bake the shadow for one hand.
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene} opts.scene        the main scene (others are hidden during the bake)
   * @param {THREE.Object3D} opts.hand      the hand model (visible)
   * @param {number} opts.deskY
   * @param {{bounds: THREE.Box3, points: Float32Array}} opts.sample
   * @param {object} opts.settings          quality settings
   */
  bake({ renderer, scene, hand, deskY, sample, settings }) {
    const b = this._bounds.copy(sample.bounds);
    b.min.x -= MARGIN; b.min.z -= MARGIN;
    b.max.x += MARGIN; b.max.z += MARGIN;
    const res = settings.contactShadowRes || 0;
    if (res > 0 && renderer) {
      try {
        this._bakeGPU(renderer, scene, hand, deskY, res, settings.contactShadowBlurPasses || 1);
        return this.texture;
      } catch (err) {
        // fall back to the CPU splat below
      }
    }
    this._bakeCPU(sample.points, deskY);
    return this.texture;
  }

  _setMapping(origin, ax, az) {
    this.mapping.origin.copy(origin);
    this.mapping.axisX.copy(ax);
    this.mapping.axisZ.copy(az);
  }

  _bakeCPU(points, deskY) {
    const N = 160;
    const b = this._bounds;
    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    // Max-splat the vertices (darkness falls off with height), then blur.
    const raw = document.createElement('canvas');
    raw.width = N;
    raw.height = N;
    const rctx = raw.getContext('2d');
    rctx.fillStyle = '#000';
    rctx.fillRect(0, 0, N, N);
    rctx.globalCompositeOperation = 'lighten';
    for (let i = 0; i < points.length; i += 3) {
      const h = (points[i + 1] - deskY) / MAX_HEIGHT;
      if (h >= 1 || h < -0.05) continue;
      const v = Math.round(255 * Math.pow(1 - Math.max(0, h), 1.6));
      rctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      rctx.fillRect(((points[i] - b.min.x) / sx) * N - 1, ((points[i + 2] - b.min.z) / sz) * N - 1, 2, 2);
    }
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'blur(3px)';
    ctx.drawImage(raw, 0, 0);
    ctx.filter = 'none';

    const tex = new THREE.CanvasTexture(canvas);
    tex.name = 'ContactShadowBlob';
    tex.flipY = false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this._disposeTextures();
    this._canvasTexture = tex;
    this.texture = tex;
    this._setMapping(
      new THREE.Vector2(-b.min.x / sx, -b.min.z / sz),
      new THREE.Vector2(1 / sx, 0),
      new THREE.Vector2(0, 1 / sz),
    );
  }

  _bakeGPU(renderer, scene, hand, deskY, res, passes) {
    const b = this._bounds;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const hx = (b.max.x - b.min.x) / 2;
    const hz = (b.max.z - b.min.z) / 2;

    // Camera under the desk looking straight up.
    const cam = new THREE.OrthographicCamera(-hx, hx, hz, -hz, 0.0, MAX_HEIGHT);
    cam.up.set(0, 0, -1);
    cam.position.set(cx, deskY, cz);
    cam.lookAt(cx, deskY + 1, cz);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    // Affine world xz -> uv from three projected points (uv = ndc * 0.5 + 0.5).
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const p = new THREE.Vector3();
    const uvOf = (x, z, out) => {
      p.set(x, deskY + 0.1, z).applyMatrix4(vp);
      return out.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    };
    const o = uvOf(0, 0, new THREE.Vector2());
    const ux = uvOf(1, 0, new THREE.Vector2()).sub(o);
    const uz = uvOf(0, 1, new THREE.Vector2()).sub(o);

    const opts = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      stencilBuffer: false,
    };
    const rtA = new THREE.WebGLRenderTarget(res, res, Object.assign({ depthBuffer: true }, opts));
    const rtB = new THREE.WebGLRenderTarget(res, res, Object.assign({ depthBuffer: false }, opts));
    rtA.texture.name = 'ContactShadow';

    // Height-faded black: darkness = (1 - h)^2, h = height above the desk / MAX_HEIGHT.
    const caster = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    caster.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n{ float hh = clamp(gl_FragCoord.z, 0.0, 1.0); float d = pow(1.0 - hh, 1.6); gl_FragColor = vec4(d, d, d, 1.0); }',
      );
    };
    caster.customProgramCacheKey = () => 'contact-shadow-caster';

    // Render only the hand, with the override material.
    const hidden = [];
    for (let i = 0; i < scene.children.length; i++) {
      const c = scene.children[i];
      if (c !== hand && c.visible && !isAncestor(c, hand)) {
        c.visible = false;
        hidden.push(c);
      }
    }
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevEnv = scene.environment;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevToneMapping = renderer.toneMapping;

    scene.overrideMaterial = caster;
    scene.background = null;
    scene.environment = null;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NoToneMapping;
    try {
      renderer.setRenderTarget(rtA);
      renderer.render(scene, cam);

      // Separable blur, ping-pong A -> B -> A.
      const blurMat = new THREE.ShaderMaterial({
        vertexShader: blurVertex,
        fragmentShader: blurFragment,
        uniforms: { uSource: { value: null }, uStep: { value: new THREE.Vector2() } },
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
      tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      const quad = new THREE.Mesh(tri, blurMat);
      quad.frustumCulled = false;
      const blurScene = new THREE.Scene();
      blurScene.add(quad);
      const step = 2.6 / res;
      for (let i = 0; i < passes; i++) {
        blurMat.uniforms.uSource.value = rtA.texture;
        blurMat.uniforms.uStep.value.set(step * (1 + i), 0);
        renderer.setRenderTarget(rtB);
        renderer.render(blurScene, cam);
        blurMat.uniforms.uSource.value = rtB.texture;
        blurMat.uniforms.uStep.value.set(0, step * (1 + i));
        renderer.setRenderTarget(rtA);
        renderer.render(blurScene, cam);
      }
      blurMat.dispose();
      tri.dispose();
    } finally {
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      scene.environment = prevEnv;
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.toneMapping = prevToneMapping;
      caster.dispose();
      rtB.dispose();
    }

    this._disposeTextures();
    this._target = rtA;
    this.texture = rtA.texture;
    this._setMapping(o, ux, uz);
  }

  get gpuBytes() {
    if (this._target) return this._target.width * this._target.height * 4;
    if (this._canvasTexture) return 160 * 160 * 4;
    return 0;
  }

  _disposeTextures() {
    if (this._target) this._target.dispose();
    if (this._canvasTexture) this._canvasTexture.dispose();
    this._target = null;
    this._canvasTexture = null;
    this.texture = null;
  }

  dispose() {
    this._disposeTextures();
  }
}

function isAncestor(a, b) {
  let p = b.parent;
  while (p) {
    if (p === a) return true;
    p = p.parent;
  }
  return false;
}
