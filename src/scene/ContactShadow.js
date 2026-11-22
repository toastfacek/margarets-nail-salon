/**
 * ContactShadow.js
 * A soft shadow of the hand on the desk, baked once per hand (the hand is
 * static) and folded into the baked desk: zero per-frame cost.
 *
 * No GPU pass: the skinned vertices are max-splatted on the CPU into a small
 * canvas (darkness falls off with height above the desk: contact is dark,
 * raised fingers are faint), then blurred with the 2D canvas filter. It reads
 * the same as a rendered silhouette once blurred, and costs no shader compile.
 *
 * World xz -> shadow uv is affine; `mapping` holds origin + the two axes so the
 * desk shader never needs to know the camera conventions.
 */
import * as THREE from 'three';

const MARGIN = 0.35;         // world units around the hand footprint
const MAX_HEIGHT = 0.9;      // above the desk, the hand casts nothing

export class ContactShadow {
  constructor() {
    this.texture = null;          // what the desk samples (r channel = darkness)
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
   * @param {{ deskY: number, sample: {bounds: THREE.Box3, points: Float32Array} }} opts
   */
  bake({ deskY, sample }) {
    const b = this._bounds.copy(sample.bounds);
    b.min.x -= MARGIN; b.min.z -= MARGIN;
    b.max.x += MARGIN; b.max.z += MARGIN;
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

  get gpuBytes() {
    if (this._canvasTexture) return 160 * 160 * 4;
    return 0;
  }

  _disposeTextures() {
    if (this._canvasTexture) this._canvasTexture.dispose();
    this._canvasTexture = null;
    this.texture = null;
  }

  dispose() {
    this._disposeTextures();
  }
}
