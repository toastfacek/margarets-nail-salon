/**
 * CloseupCull.js (g-hv3e): the settled close-up draws only what it can show.
 *
 * In the close-up the other fingers curl away under the palm (HandPoses.js,
 * v3's present pose). Their tips and nails are still inside the view, behind
 * the presented finger: every one of their triangles costs vertex work and
 * triangle setup (on a software rasteriser, most of the hand's cost) and
 * shades nothing.
 *
 * Once the hand has settled on a finger, this measures what the close-up can
 * see: the hand is rasterised on the CPU into a small depth + triangle-id
 * buffer (no GPU pass: a new pipeline state costs a software rasteriser a
 * long JIT stall every time it comes back), from the camera and from the idle
 * sway's two extremes in the hand's current pose, and from the camera in its
 * exact present pose; one view per frame, never while the brush is down.
 * Then the skin draws through a shorter index buffer without the other
 * fingers' unseen triangles (a margin of three mesh rings round everything seen,
 * for the idle motion and the GPU's own edge rules), and the other nails that
 * show no pixel are hidden. The full index and the nails come back the moment
 * anything moves the camera or the hand beyond the idle layer: a pan, a
 * glide, the reveal, a manual pose, a one-shot, the press-give, a resize.
 *
 * The picture does not change (scripts check it pixel for pixel), only the
 * work. `?cull=0` turns it off (A/B).
 */
import * as THREE from 'three';

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const RINGS = 3;           // mesh rings kept round every triangle seen (2 let the idle motion show a few pixels at the pinky)
const SWAY = 0.0175;       // rad: the close-up's idle camera sway each way (game.feature.js, high)
const MEASURE_DEV = 1.5;   // degrees: the hand this close to its pose while the view is measured
const APPLY_DEV = 1.5;     // degrees: ... and no further from it while the cut is drawn
const MIN_CUT = 200;       // triangles: a smaller cut is not worth the index swap
const SCALE = 0.5;         // CPU raster size / drawing buffer
const DEPTH_EPS = 0.004;   // world units (about 0.5 mm): surfaces this close may trade pixels on the GPU

export class CloseupCull {
  /**
   * @param {object} app the game (scene, nail, hand, fingerPan, polishBrush3D)
   */
  constructor(app) {
    this.app = app;
    this.enabled = true;
    this.cutSkin = true;          // A/B switches (tests)
    this.cutNails = true;
    this.rings = RINGS;
    this.scale = SCALE;
    this.measureDev = MEASURE_DEV;
    this.stats = { measures: 0, measureMs: [], cutTris: 0, keptTris: 0, hiddenNails: 0, active: false };
    this._cache = new Map();      // `${hand}:${finger}` -> measured cut
    this._geo = new WeakMap();    // skin geometry -> tables
    this._job = null;
    this._applied = null;
    this._size = new THREE.Vector2();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._zbuf = null;
    this._ibuf = null;
  }

  /** Per frame, before the main render. */
  update() {
    const want = this.enabled ? this._eligible() : null;
    if (!want) { this._job = null; this._restore(); return; }
    const key = want.hand + ':' + want.finger;
    let d = this._cache.get(key);
    if (d && !this._sameView(d, want)) {
      this._restore();
      this._cache.delete(key);
      d = null;
    }
    const dev = this.app.hand.poseDev;
    if (!d) {
      this._restore();
      this._step(want, key, dev);
      return;
    }
    if (!(dev <= APPLY_DEV) || !d.worth) { this._restore(); return; }
    this._apply(d);
  }

  /** Tests: measure the current view now, all at once (cut not applied); the stats. */
  measureNow() {
    this._restore();
    this._job = null;
    const want = this._eligible();
    if (!want) return this.stats;
    const key = want.hand + ':' + want.finger;
    for (let i = 0; i < 16 && !this._cache.has(key); i++) this._step(want, key, 0, true);
    return this.stats;
  }

  /** Drop every measurement (hand rebuilt, skin tone, quality change). */
  reset() {
    this._restore();
    this._job = null;
    this._cache.clear();
  }

  // ------------------------------------------------------------- state --

  _eligible() {
    const app = this.app, sc = app.scene, hm = app.nail, H = app.hand;
    if (!sc || !hm || !H || !H.rig || !H.calm) return null;
    if (!sc.isZoomedIn || sc.isAnimating || sc.cameraHeld) return null;
    if (app.fingerPan && app.fingerPan.busy) return null;
    const s = sc.railS;
    if (!(s >= 0) || s !== Math.round(s)) return null;
    const finger = hm.getActiveNail();
    if (!finger || sc.zoomedFinger !== finger || sc.railFingers[s] !== finger) return null;
    const hand = hm.getCurrentHand();
    const h = hm.hands[hand];
    if (!h || !h.model || !h.skins || h.skins.length !== 1) return null;
    const skin = h.skins[0].mesh;
    if (!skin || !skin.isSkinnedMesh || !skin.visible || !skin.geometry.index) return null;
    return { hand, finger, skin, model: h.model, nails: h.nails };
  }

  /** The view now, to compare with a measured one. */
  _view() {
    const sc = this.app.scene, cam = sc.camera;
    sc.renderer.getDrawingBufferSize(this._size);
    const t = sc.controls.target;
    const dir = new THREE.Vector3().subVectors(cam.position, t);
    return { w: this._size.x, h: this._size.y, proj: Array.from(cam.projectionMatrix.elements), target: t.clone(), dist: dir.length(), dir };
  }

  /** Is the camera where (or within the idle sway of where) `d` was measured? */
  _sameView(d, want) {
    const sc = this.app.scene, cam = sc.camera;
    if (d.skin !== want.skin || d.geometry !== want.skin.geometry) return false;
    sc.renderer.getDrawingBufferSize(this._size);
    if (this._size.x !== d.view.w || this._size.y !== d.view.h) return false;
    const pm = cam.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(pm[i] - d.view.proj[i]) > 1e-6) return false;
    const t = sc.controls.target;
    if (t.distanceToSquared(d.view.target) > 1e-12) return false;
    const v = this._v.subVectors(cam.position, t);
    if (Math.abs(v.length() - d.view.dist) > 1e-5 * d.view.dist) return false;
    return v.angleTo(d.view.dir) <= SWAY * 1.05;
  }

  _apply(d) {
    if (this._applied === d) return;
    this._restore();
    if (d.cutIndex) d.skin.geometry.setIndex(d.cutIndex);
    for (const n of d.hideNails) {
      if (n.visible) { n.visible = false; d.hidden.push(n); }
    }
    this._applied = d;
    this.stats.active = true;
  }

  _restore() {
    const d = this._applied;
    if (!d) return;
    if (d.cutIndex && d.skin.geometry.index === d.cutIndex) d.skin.geometry.setIndex(d.fullIndex);
    for (const n of d.hidden) n.visible = true;
    d.hidden.length = 0;
    this._applied = null;
    this.stats.active = false;
  }

  // ----------------------------------------------------------- measure --

  /** The skin's tables, once per geometry: each triangle's finger, welded corners. */
  _geoInfo(skin) {
    const g = skin.geometry;
    let info = this._geo.get(g);
    if (info) return info;
    const index = g.index;
    const triCount = index.count / 3;
    const bones = skin.skeleton.bones;
    const boneFinger = bones.map((b) => FINGERS.findIndex((f) => b.name.toLowerCase().startsWith(f)));
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const triFinger = new Int8Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const a = index.getX(t * 3);
      let bw = -1, bi = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(a, k);
        if (w > bw) { bw = w; bi = si.getComponent(a, k); }
      }
      triFinger[t] = boneFinger[bi] === undefined ? -1 : boneFinger[bi];
    }
    // corners welded by position (a cut seam's twin vertices are one corner)
    const pos = g.attributes.position;
    const weld = new Int32Array(pos.count);
    const order = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) order[i] = i;
    const P = pos.array, st = pos.itemSize === 3 && !pos.isInterleavedBufferAttribute && !pos.normalized ? 3 : 0;
    const px = (i) => (st ? P[i * 3] : pos.getX(i)), py = (i) => (st ? P[i * 3 + 1] : pos.getY(i)), pz = (i) => (st ? P[i * 3 + 2] : pos.getZ(i));
    order.sort((a, b) => (px(a) - px(b)) || (py(a) - py(b)) || (pz(a) - pz(b)));
    let nW = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k], j = k > 0 ? order[k - 1] : -1;
      if (j < 0 || px(i) !== px(j) || py(i) !== py(j) || pz(i) !== pz(j)) nW++;
      weld[i] = nW - 1;
    }
    const idx = new Uint32Array(index.count);
    for (let t = 0; t < index.count; t++) idx[t] = index.getX(t);
    const tri = new Int32Array(index.count);
    for (let t = 0; t < index.count; t++) tri[t] = weld[idx[t]];
    info = { fullIndex: index, idx, triFinger, tri, nW, triCount, world: new Float32Array(pos.count * 3) };
    this._geo.set(g, info);
    return info;
  }

  /** World positions of the skin (skinned) and the nails, in the pose the bones hold now. */
  _positions(job) {
    const want = job.want, info = job.info, skin = want.skin, v = this._v;
    want.model.updateMatrixWorld(true);
    skin.skeleton.update();
    const P = info.world, n = skin.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      skin.getVertexPosition(i, v);
      v.applyMatrix4(skin.matrixWorld);
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    }
    const nails = [];
    FINGERS.forEach((f, k) => {
      const rec = want.nails[f];
      const m = rec && rec.mesh;
      if (!m || !m.visible) return;
      const g = m.geometry, pos = g.attributes.position;
      const w = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        w[i * 3] = v.x; w[i * 3 + 1] = v.y; w[i * 3 + 2] = v.z;
      }
      const ix = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
      nails.push({ k, world: w, idx: ix, flip: m.matrixWorld.determinant() < 0 });
    });
    return { skin: P.slice(0, n * 3), skinFlip: skin.matrixWorld.determinant() < 0, nails };
  }

  /**
   * Rasterise the hand from `cam` into a W x H depth + id buffer; mark the
   * skin triangles and nails that win any pixel. Triangles crossing the near
   * plane count as seen.
   */
  _raster(job, pos, cam) {
    const W = job.W, H = job.H, N = W * H;
    if (!this._zbuf || this._zbuf.length !== N) { this._zbuf = new Float32Array(N); this._ibuf = new Int32Array(N); }
    const Z = this._zbuf, I = this._ibuf;
    Z.fill(0);
    I.fill(0);
    const m = this._m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const seenTri = job.seenTri, seenNail = job.seenNail;
    let sx = job.sx, sy = job.sy, sz = job.sz, ok = job.ok;
    const project = (P, count) => {
      if (!sx || sx.length < count) { sx = job.sx = new Float32Array(count); sy = job.sy = new Float32Array(count); sz = job.sz = new Float32Array(count); ok = job.ok = new Uint8Array(count); }
      for (let i = 0; i < count; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(cw > 1e-6)) { ok[i] = 0; continue; }
        const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
        const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
        const nz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cw;
        ok[i] = nz >= -1 ? 1 : 0;
        sx[i] = (nx + 1) * 0.5 * W;
        sy[i] = (1 - ny) * 0.5 * H;
        sz[i] = 1 / cw;   // perspective-correct depth: 1 / w is affine on screen
      }
    };
    // pass 0 writes the nearest surface (Z = 1 / depth, larger is nearer;
    // id > 0: skin triangle id - 1; id < 0: nail -(k + 1)); pass 1 marks every
    // triangle within DEPTH_EPS of the nearest at any of its pixels (where
    // two surfaces touch, the GPU's depth test may pick either)
    const draw = (pass, idx, triCount, flip, idOf, mark, grow = 0) => {
      for (let t = 0; t < triCount; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        if (!ok[a] || !ok[b] || !ok[c]) { mark(t); continue; }
        const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
        // screen y runs down: a front face (CCW in NDC) has a negative area here
        const A = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (!((flip ? -A : A) < 0)) continue;
        const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
        if (minx > maxx || miny > maxy) continue;
        const z0 = sz[a], z1 = sz[b], z2 = sz[c];
        const inv = 1 / A;
        const id = pass === 0 ? idOf(t) : 0;
        let hit = false;
        for (let py = miny; py <= maxy; py++) {
          const cy = py + 0.5;
          for (let px = minx; px <= maxx; px++) {
            const cx = px + 0.5;
            // barycentrics (signed by the triangle's own winding)
            const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv;
            const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            hit = true;
            const z = w0 * z0 + w1 * z1 + w2 * z2;
            const o = py * W + px;
            if (pass === 0) {
              if (z > Z[o]) { Z[o] = z; I[o] = id; }
            } else if (1 / z <= 1 / Z[o] + DEPTH_EPS || (grow && near(px, py, z))) { mark(t); py = maxy + 1; break; }
          }
        }
        // smaller than a pixel: the pixel under its centre decides (conservative)
        if (!hit) {
          const o = Math.min(maxy, Math.max(miny, Math.round((y0 + y1 + y2) / 3 - 0.5))) * W + Math.min(maxx, Math.max(minx, Math.round((x0 + x1 + x2) / 3 - 0.5)));
          const z = Math.max(z0, z1, z2);
          if (pass === 0) {
            if (z > Z[o]) { Z[o] = z; I[o] = id; }
          } else if (1 / z <= 1 / Z[o] + DEPTH_EPS) mark(t);
        }
      }
    };
    // a triangle on the GPU can win a multisample at a pixel's edge where
    // this buffer's pixel centre missed it: its neighbours count too
    const near = (px, py, z) => {
      for (let dy = -1; dy <= 1; dy++) {
        const y = py + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx;
          if (x < 0 || x >= W) continue;
          if (1 / z <= 1 / Z[y * W + x] + DEPTH_EPS) return true;
        }
      }
      return false;
    };
    const nSkin = pos.skin.length / 3;
    const markTri = (t) => { seenTri[t] = 1; };
    for (let pass = 0; pass < 2; pass++) {
      project(pos.skin, nSkin);
      draw(pass, job.info.idx, job.info.triCount, pos.skinFlip, (t) => t + 1, markTri, 1);
      for (const nl of pos.nails) {
        const markNail = () => { seenNail[nl.k] = 1; };
        project(nl.world, nl.world.length / 3);
        draw(pass, nl.idx, nl.idx.length / 3, nl.flip, () => -(nl.k + 1), markNail, 1);
      }
    }
    for (let o = 0; o < N; o++) {
      const id = I[o];
      if (id > 0) seenTri[id - 1] = 1;
      else if (id < 0) seenNail[-id - 1] = 1;
    }
  }

  /** One piece of the measurement (each a few ms); the cut is cached once done. */
  _step(want, key, dev, force = false) {
    const app = this.app;
    if (!force) {
      if (!(dev <= this.measureDev)) return;
      const b = app.polishBrush3D;
      if (b && ((b.inputHandler && b.inputHandler.isPointerDown) || b.isPainting)) return;
    }
    let job = this._job;
    if (job && (job.key !== key || !this._sameView(job, want))) job = null;
    if (!job) {
      const sc = app.scene;
      sc.renderer.getDrawingBufferSize(this._size);
      const W = Math.max(8, Math.round(this._size.x * this.scale)), H = Math.max(8, Math.round(this._size.y * this.scale));
      const info = this._geoInfo(want.skin);
      job = this._job = {
        key, want, info, W, H, step: 0, ms: 0,
        skin: want.skin, geometry: want.skin.geometry, view: this._view(),
        seenTri: new Uint8Array(info.triCount), seenNail: new Uint8Array(FINGERS.length),
        pos: null, sx: null, sy: null, sz: null, ok: null,
      };
      return;
    }
    const t0 = performance.now();
    const sc = app.scene, cam = sc.camera;
    if (job.step === 0) {
      job.pos = this._positions(job);
    } else if (job.step <= 3) {
      // the view as it is, and at the idle sway's extremes (a turn about the
      // world's up through the look-at point)
      const a = [0, SWAY, -SWAY][job.step - 1];
      const c = this._cam || (this._cam = cam.clone());
      c.copy(cam);
      const t = job.view.target;
      c.position.sub(t).applyAxisAngle(_Y, a).add(t);
      c.up.copy(cam.up).applyAxisAngle(_Y, a);
      c.lookAt(t);
      c.projectionMatrix.copy(cam.projectionMatrix);
      c.updateMatrixWorld();
      this._raster(job, job.pos, c);
    } else if (job.step === 4) {
      // the exact present pose (no idle), from the camera
      app.hand.withPose(want.finger, () => { job.pos = this._positions(job); });
      cam.updateMatrixWorld();
      this._raster(job, job.pos, cam);
    } else {
      this._finish(job);
      this._job = null;
      // the buffers are only needed while measuring (about 2 MB at 640 x 360)
      this._zbuf = this._ibuf = null;
    }
    const dt = performance.now() - t0;
    job.ms += dt;
    job.maxStep = Math.max(job.maxStep || 0, dt);
    job.step++;
  }

  _finish(job) {
    const info = job.info, want = job.want;
    const keep = job.seenTri;
    const mark = new Uint8Array(info.nW);
    for (let ring = 0; ring < this.rings; ring++) {
      for (let t = 0; t < info.triCount; t++) {
        if (!keep[t]) continue;
        mark[info.tri[t * 3]] = 1; mark[info.tri[t * 3 + 1]] = 1; mark[info.tri[t * 3 + 2]] = 1;
      }
      for (let t = 0; t < info.triCount; t++) {
        if (!keep[t] && (mark[info.tri[t * 3]] || mark[info.tri[t * 3 + 1]] || mark[info.tri[t * 3 + 2]])) keep[t] = 1;
      }
    }
    // only the other fingers' triangles are ever cut (the palm, the wrist and
    // the presented finger always draw)
    const act = FINGERS.indexOf(want.finger);
    const full = info.fullIndex;
    const out = new (full.array.constructor)(info.idx.length);
    let n = 0, cut = 0;
    for (let t = 0; t < info.triCount; t++) {
      const f = info.triFinger[t];
      if (this.cutSkin && f >= 0 && f !== act && !keep[t]) { cut++; continue; }
      out[n++] = info.idx[t * 3]; out[n++] = info.idx[t * 3 + 1]; out[n++] = info.idx[t * 3 + 2];
    }
    const hideNails = [];
    FINGERS.forEach((f, k) => {
      const rec = want.nails[f];
      if (this.cutNails && rec && rec.mesh && k !== act && !job.seenNail[k]) hideNails.push(rec.mesh);
    });
    const worthCut = cut >= MIN_CUT;
    const d = {
      skin: job.skin, geometry: job.geometry, view: job.view, fullIndex: full,
      cutIndex: worthCut ? new THREE.BufferAttribute(out.slice(0, n), 1) : null,
      hideNails, hidden: [], worth: worthCut || hideNails.length > 0,
    };
    this._cache.set(job.key, d);
    this.stats.measures++;
    this.stats.measureMs = [+job.ms.toFixed(1), +(job.maxStep || 0).toFixed(1)];
    this.stats.cutTris = worthCut ? cut : 0;
    this.stats.keptTris = worthCut ? n / 3 : info.triCount;
    this.stats.hiddenNails = hideNails.length;
  }
}

const _Y = new THREE.Vector3(0, 1, 0);
