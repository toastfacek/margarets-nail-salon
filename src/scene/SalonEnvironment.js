/**
 * SalonEnvironment.js
 * The salon "room" as an environment map, built in code once at load.
 *
 * A throwaway scene of emissive shapes (HDR values above 1) is rendered once:
 *   - a gradient dome: warm cream top, rose middle, deep plum floor
 *   - a big overhead softbox
 *   - a tall warm window strip on one side, a pink neon bar on the other
 *   - the signature ring light (only in the PMREM copy: the nail shader draws
 *     the ring analytically, crisper than any cube texel could)
 *
 * Outputs
 *   envCube  WebGLCubeRenderTarget (mipmapped). The nail shader samples it with
 *            textureLod(uEnvMap, R, lod): roughness -> lod. Not physically exact
 *            prefiltering, visually right for polish, one fetch.
 *   pmrem    (high / medium only) a PMREM of the same room with the ring, set
 *            as scene.environment so skin, gems and the brush cap see the room.
 *
 * Everything is rendered once; nothing here runs per frame.
 */
import * as THREE from 'three';

// The lighting rig, in world space (y up; the camera looks down at the hand
// from slightly toward +z, screen-up is -z, the fingertips point to -x).
// The key light and the ring light share one direction: up and a little
// toward the upper left of the screen, so the ring sits off-centre on the nail.
export const RIG = Object.freeze({
  keyDir: Object.freeze(new THREE.Vector3(-0.30, 1.0, -0.22).normalize()),
  rimDir: Object.freeze(new THREE.Vector3(0.55, 0.35, 1.0).normalize()),
  ringInner: 0.16,   // radians (angular radius of the ring's inner edge)
  ringOuter: 0.27,   // radians
  ringIntensity: 7.0,
  // Room colours (linear, before intensity).
  domeTop: '#fff1e2',
  domeMid: '#f7bfcf',
  domeFloor: '#3b1b38',
  window: '#ffd7a6',
  neon: '#ff4f9e',
  softbox: '#fff7ef',
});

// RGBA8 cube targets cannot hold values above 1: store env / ENV_RANGE_LDR.
const ENV_RANGE_LDR = 4.0;
const ENV_DISTANCE = 6;

function makeDome() {
  const geo = new THREE.SphereGeometry(ENV_DISTANCE * 1.6, 48, 24);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(RIG.domeTop);
  const mid = new THREE.Color(RIG.domeMid);
  const floor = new THREE.Color(RIG.domeFloor);
  const c = new THREE.Color();
  const r = ENV_DISTANCE * 1.6;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / r; // -1..1
    if (y >= 0.0) {
      // bright cream ceiling, a darker rose band mid-wall, lighter at the horizon:
      // the contrast is what makes chrome read as metal
      const t = Math.pow(y, 1.6);
      c.copy(mid).multiplyScalar(0.30).lerp(top.clone().multiplyScalar(1.3), t);
      c.lerp(mid.clone().multiplyScalar(0.75), Math.pow(1 - y, 8) * 0.8);
    } else {
      // rose horizon falling into a plum floor
      const t = Math.min(1, -y * 2.2);
      c.copy(mid).multiplyScalar(0.6).lerp(floor.clone().multiplyScalar(0.35), Math.pow(t, 0.6));
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}

function emissive(color, intensity) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

/** Place `mesh` at `dist` along `dir`, facing the origin. */
function placeFacing(mesh, dir, dist) {
  mesh.position.copy(dir).normalize().multiplyScalar(dist);
  mesh.lookAt(0, 0, 0);
}

export class SalonEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} settings quality settings (envCubeRes, envCubeType, tier)
   */
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.envCube = null;
    this.pmrem = null;
    this.envScale = 1;
    this.dim = 1;
    this._build(settings);
  }

  _buildScene() {
    const scene = new THREE.Scene();
    scene.add(makeDome());

    // Overhead softbox: a big soft rectangle near the zenith, behind the ring.
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 3.2), emissive(RIG.softbox, 2.2));
    placeFacing(softbox, new THREE.Vector3(0.35, 1.0, 0.25), ENV_DISTANCE);
    scene.add(softbox);

    // Two long strip lights overhead: the streaks chrome is known for.
    const stripGeo = new THREE.PlaneGeometry(0.35, 7.0);
    for (const sx of [-0.9, 1.0]) {
      const strip = new THREE.Mesh(stripGeo, emissive('#fff4ea', 3.0));
      strip.position.set(sx, ENV_DISTANCE * 0.95, -0.4);
      strip.rotation.x = Math.PI / 2;
      strip.rotation.z = 0.35;
      scene.add(strip);
    }

    // Tall warm window strip, screen-top side (-z), reads on the far nail edge.
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 4.2), emissive(RIG.window, 3.2));
    placeFacing(win, new THREE.Vector3(0.5, 0.45, -1.0), ENV_DISTANCE);
    scene.add(win);

    // Pink neon bar, screen-bottom side (+z), reads on the near nail edge.
    const neon = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.22, 0.22), emissive(RIG.neon, 3.5));
    placeFacing(neon, new THREE.Vector3(-0.3, 0.32, 1.0), ENV_DISTANCE);
    scene.add(neon);

    // A couple of small warm bulbs low on the walls: tiny glints for chrome.
    const bulbGeo = new THREE.SphereGeometry(0.18, 12, 8);
    const bulbMat = emissive('#ffe6c4', 6.0);
    const bulbDirs = [
      new THREE.Vector3(-1.0, 0.18, -0.4),
      new THREE.Vector3(1.0, 0.22, 0.35),
      new THREE.Vector3(-0.6, 0.12, 0.9),
    ];
    for (let i = 0; i < bulbDirs.length; i++) {
      const b = new THREE.Mesh(bulbGeo, bulbMat);
      b.position.copy(bulbDirs[i]).normalize().multiplyScalar(ENV_DISTANCE);
      scene.add(b);
    }

    // The ring light (only rendered into the PMREM copy).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        Math.tan(RIG.ringInner) * ENV_DISTANCE,
        Math.tan(RIG.ringOuter) * ENV_DISTANCE,
        64, 1,
      ),
      emissive('#fff6ee', RIG.ringIntensity),
    );
    placeFacing(ring, RIG.keyDir, ENV_DISTANCE);
    ring.visible = false;
    scene.add(ring);

    return { scene, ring };
  }

  _build(settings) {
    const renderer = this.renderer;
    const res = settings.envCubeRes || 128;
    const halfFloat = settings.envCubeType === THREE.HalfFloatType;
    const type = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.envScale = halfFloat ? 1 : ENV_RANGE_LDR;

    const { scene, ring } = this._buildScene();

    // LDR targets: scale the whole room down so it fits in 0..1.
    if (!halfFloat) {
      scene.traverse((o) => {
        if (!o.isMesh) return;
        if (o.material.vertexColors) {
          const col = o.geometry.attributes.color;
          for (let i = 0; i < col.array.length; i++) col.array[i] /= ENV_RANGE_LDR;
        } else {
          o.material.color.multiplyScalar(1 / ENV_RANGE_LDR);
        }
      });
    }

    const cubeTarget = new THREE.WebGLCubeRenderTarget(res, {
      type,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    cubeTarget.texture.name = 'SalonEnvCube';
    const cubeCamera = new THREE.CubeCamera(0.1, 50, cubeTarget);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    try {
      cubeCamera.update(renderer, scene);
    } catch (err) {
      // An env map is an optimisation for looks; without it the nail falls back
      // to its analytic sky/ground gradient.
      cubeTarget.dispose();
      this.envScale = 1;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    this.envCube = cubeTarget;

    // PMREM for the standard materials (high / medium).
    if (settings.tier !== 'low') {
      if (!halfFloat) {
        // keep the PMREM in HDR even if the cube was LDR
        scene.traverse((o) => {
          if (!o.isMesh) return;
          if (o.material.vertexColors) {
            const col = o.geometry.attributes.color;
            for (let i = 0; i < col.array.length; i++) col.array[i] *= ENV_RANGE_LDR;
          } else {
            o.material.color.multiplyScalar(ENV_RANGE_LDR);
          }
        });
      }
      ring.visible = true;
      let gen = null;
      try {
        gen = new THREE.PMREMGenerator(renderer);
        this.pmrem = gen.fromScene(scene, 0.04);
        this.pmrem.texture.name = 'SalonPMREM';
      } catch (err) {
        this.pmrem = null;
      }
      if (gen) gen.dispose();
      renderer.setRenderTarget(prevTarget);
    }

    // The env scene is throwaway: free its geometry and materials.
    scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.material.dispose();
    });
  }

  /** Cube texture for the nail shader. */
  get texture() {
    return this.envCube ? this.envCube.texture : null;
  }

  /** Bytes held on the GPU (for the hand-off texture list). */
  get gpuBytes() {
    let b = 0;
    if (this.envCube) {
      const r = this.envCube.width;
      const bpp = this.envCube.texture.type === THREE.HalfFloatType ? 8 : 4;
      b += Math.round(r * r * 6 * bpp * 4 / 3);
    }
    if (this.pmrem) {
      const t = this.pmrem;
      b += t.width * t.height * 8;
    }
    return b;
  }

  dispose() {
    if (this.envCube) this.envCube.dispose();
    if (this.pmrem) this.pmrem.dispose();
    this.envCube = null;
    this.pmrem = null;
  }
}
