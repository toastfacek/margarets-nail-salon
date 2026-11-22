/**
 * SwirlBowl.js (WP9): water marbling, the stretch showpiece.
 *
 * Play: a floating bowl button (free mode) puts the brush away and flies the
 * camera to a glazed bowl on the desk just past the fingertip. Bottles drop
 * colour into the water (a tap on the water drops there), a drag is a
 * toothpick that pulls the rings into feathers, and the dunk button dips the
 * hand, prints the film under the nail's footprint onto the nail and moves
 * on to the next finger. Back returns to painting on the last marbled nail.
 * No words.
 *
 * How:
 * - Drops use the exact ink-drop warp (BowlMaterial.js): successive drops
 *   nest as clean concentric rings: one warp pass per drop, the spread
 *   (a third of a second) eased open at display time.
 * - Swirls are velocity splats into a second FluidSimulator whose velocity
 *   decays like water (0.93 per 30 Hz step instead of polish's 0.74). It
 *   exists only while the bowl is open, steps at a fixed 30 Hz and stops
 *   1.6 s after a swirl; the brush sim is asleep (brush deactivated).
 * - The print: white base coat through the brush's own fillNail (coverage,
 *   wetness, nail:covered), then the film blitted "over" it into the nail's
 *   baked paint target. The lifted film leaves a clear hole in the water.
 * - Programs are compiled at idle (warm-up), never while open. Nothing
 *   allocates per frame. Pointer input is captured on window while open, so
 *   the canvas's own listeners (orbit, nail pick, double-click) stay out.
 *
 * Events: bowl:open, bowl:drop { color }, bowl:dunk { hand, finger },
 * bowl:close (payloads reused). Exposes `app.bowl` (open, close, group, sim).
 */
import * as THREE from 'three';
import { FluidSimulator } from '../tools/PolishBrush3D/FluidSimulator.js';
import { makeBowlMaterial, makeWarpMaterial } from './BowlMaterial.js';
import { whenIdle, warmRender } from '../scene/Warmup.js';
import { EVENTS } from '../core/GameEvents.js';
import { PALETTE } from '../game/ClientRequests.js';
import { FINGERS as FINGER_IDS } from '../scene/HandModel.js';

// World units (a nail is about 0.1 long). Lathe profile (radius, height):
// outer wall -> rim -> inner wall, stopping under the water (no hidden floor to shade).
const PROFILE = [0.26, 0, 0.3, 0.04, 0.33, 0.09, 0.345, 0.14, 0.35, 0.155, 0.34, 0.168, 0.325, 0.16, 0.318, 0.13, 0.313, 0.1];
const RIM = 0.35;
const WR = 0.315; // water radius (BowlMaterial's planar uv assumes it)
const WY = 0.11;  // water height
const ZOOM = 2.4; // nail footprint scale in the water: more rings per nail
// The camera sits on the mirror of the key light, so the ring light lands in the water.
const VIEW = new THREE.Vector3(0.3, 1, 0.22).normalize();
const COLORS = PALETTE.concat('#ffffff');
const FINGERS = Object.values(FINGER_IDS);
const ICON = {
  bowl: '<path d="M32 3c5 7 7 10 7 13a7 7 0 0 1-14 0c0-3 2-6 7-13z" fill="#00b4d8"/><ellipse cx="32" cy="33" rx="27" ry="9" fill="#c8f0ff"/><path d="M5 33c0 15 12 26 27 26s27-11 27-26c0 5-12 9-27 9S5 38 5 33z" fill="#ff9fcf"/><path d="M17 32c5-6 12-5 14 0s11 5 15-1" stroke="#ff2a6d" stroke-width="3.5" fill="none" stroke-linecap="round"/>',
  dunk: '<path d="M3 44q7-6 14 0t15 0 15 0 14 0v17H3z" fill="#7fd3ff"/><rect x="23" y="1" width="18" height="40" rx="9" fill="#f6d3c2"/><rect x="26" y="24" width="12" height="14" rx="6" fill="#ff2a6d"/><path d="M32 48v9m-11-5-4 5m26-5 4 5" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>',
  back: '<path d="M40 12 20 32l20 20" stroke="#9d4edd" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export function installBowl(app) {
  const { scene: S, events: ev, sound: sm, nail: hm, polishBrush3D: brush } = app;
  if (!S || !brush || !hm || !ev) return;
  const L = S.nailLighting;
  const canvas = S.renderer.domElement;
  const body = document.body;

  // ------------------------------------------------------------ 3D --
  const water = makeBowlMaterial(1, L);
  const wat = water.uniforms;
  const dropMat = makeBowlMaterial(2, L);
  const warp = makeWarpMaterial();
  const wu = warp.uniforms;
  const group = new THREE.Group();
  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    return group.add(m) && m;
  };
  // Surface of revolution of a (radius, height) profile, no seam (smooth normals all round).
  // A profile running up faces outward; the water's runs inward so it faces up.
  const revolve = (p, n) => {
    const m = p.length / 2;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      for (let j = 0; j < m; j++) {
        pos.push(p[j * 2] * Math.sin(a), p[j * 2 + 1], p[j * 2] * Math.cos(a));
        uv.push(i / n, j / (m - 1));
        const k = i * m + j;
        const k2 = ((i + 1) % n) * m + j;
        if (j < m - 1) idx.push(k, k2, k + 1, k + 1, k2, k2 + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  mk(revolve(PROFILE, 48), makeBowlMaterial(0, L));
  mk(revolve([WR, WY, 0, WY], 64), water);
  const drop = mk(new THREE.SphereGeometry(0.024, 16, 12), dropMat);
  drop.visible = group.visible = false;
  S.add(group);
  const C = group.position;

  // Scratch (never reallocated)
  const v1 = new THREE.Vector3();
  const box = new THREE.Box3();
  const uvT = new THREE.Vector4();
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const rgb = { r: 0, g: 0, b: 0 };
  const tmpCol = new THREE.Color();
  const handBase = new THREE.Vector3();
  const dunkOff = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const quat0 = new THREE.Quaternion();
  const q = new Float32Array(56); // 8 queued drops: r g b a u v area
  const cur = new Float32Array(7);
  const dropPayload = { color: COLORS[0] };
  const dunkPayload = { hand: 'left', finger: 'index' };

  let sim = null;
  let open = false;
  let qHead = 0;
  let qCount = 0;
  let phase = 0; // 0 idle, 1 falling, 2 landing, 3 spreading
  let t = 0;
  let dunkT = -1;
  let printed = false;
  let awake = 0;   // seconds of swirl left to simulate
  let acc = 0;
  let dragging = false;
  let u = 0.5;
  let v = 0.5;
  let lu = 0.5;
  let lv = 0.5;
  let moved = 0;
  let hasMove = false;
  let dipU = 0.5;
  let dipV = 0.5;
  let sumU = 0;
  let sumV = 0;
  let sumN = 0;
  let dunks = 0;
  let sx = 0.2;
  let sy = 0.2;
  let rect = null;
  let brushWas = false;
  let ctrlWas = true;
  let lastDunk = null;

  function makeSim(simRes, dyeRes, iterations) {
    const s = app.quality.settings;
    const m = new FluidSimulator(S.renderer, { simRes, dyeRes, iterations, dyeType: s.fluidDyeType, noFlow: s.noFlow });
    m.flowScale = 0.5;
    // Water, not polish: this instance's velocity decay (step() writes it to
    // the advect uniform; dye passes write 1) is remapped from 0.74 to 0.93
    // per 30 Hz step, so a swirl coasts on for a second or so.
    let d = 1;
    Object.defineProperty(m.materials.advect.uniforms.uDissipation, 'value', { get: () => d, set: (x) => { d = x < 1 ? x ** 0.24 : x; } });
    // The print composites the film "over" the nail's base coat.
    const c = m.materials.copy;
    c.blendSrc = c.blendSrcAlpha = THREE.OneFactor;
    c.blendDst = c.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    return m;
  }

  function warpPass(cu, cv, area, r, g, b, a) {
    wu.uS.value = sim.dye.read.texture;
    wu.uC.value.set(cu, cv);
    wu.uA.value = area;
    wu.uK.value.set(r * a, g * a, b * a, a);
    wu.uT.value = 1 / sim.opts.dyeRes;
    sim.renderPass(warp, sim.dye.write);
    sim.dye.swap();
    wu.uS.value = null;
  }

  const ripple = (ru, rv, amp) => wat.uR.value.set(ru, rv, 0.01, amp);

  /** Queue a drop: sRGB colour (a = 0: clear water), water uv, spread area (uv^2). */
  function addDrop(r, g, b, a, du, dv, area) {
    if (!open || qCount >= 8) return;
    const i = ((qHead + qCount++) % 8) * 7;
    q[i] = r; q[i + 1] = g; q[i + 2] = b; q[i + 3] = a; q[i + 4] = du; q[i + 5] = dv; q[i + 6] = area;
  }

  const dropAt = (du, dv) => {
    tmpCol.set(dropPayload.color).getRGB(rgb, THREE.SRGBColorSpace);
    addDrop(rgb.r, rgb.g, rgb.b, 1, du, dv, 0.016);
    // The film's centre is where the drops landed: the nail dips there.
    sumU += du;
    sumV += dv;
    sumN++;
  };

  // Bowl on the desk just past the active fingertip (hand centre -> nail).
  function place() {
    const hand = hm.getCurrentHand();
    let minY = Infinity;
    hm.forEachNail(hand, (rec, f) => {
      minY = Math.min(minY, hm.getNailWorldPosition(f, v1).y);
    });
    const nail = hm.getNailWorldPosition(hm.getActiveNail(), handBase);
    box.setFromObject(hm.hands[hand].model).getCenter(v1);
    v1.sub(nail).setY(0).setLength(-(RIM + 0.05));
    C.set(nail.x + v1.x, minY - 0.1, nail.z + v1.z);
    plane.constant = -(C.y + WY);
    // Fly with NailScene's own camera animation (ease-out; the controls follow).
    const cam = S.camera;
    const tgt = S.targetTarget.copy(nail).sub(C).multiplyScalar(0.22).add(C);
    tgt.y = C.y + WY;
    const dist = (RIM * 1.3) / (Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * Math.min(1, cam.aspect));
    S.targetCameraPos.copy(VIEW).multiplyScalar(dist).add(tgt);
    S.startCameraPos.copy(cam.position);
    S.startTarget.copy(S.controls.target);
    S.controls.maxDistance = 9;
    S.animationProgress = 0;
    S.isAnimating = true;
  }

  // The dunk: white base coat, then the film under the nail's footprint.
  function print() {
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    brush.fillNail('#ffffff');
    const target = hm.getPaintTarget(hand, finger, true);
    const copy = sim.materials.copy;
    copy.blending = THREE.CustomBlending;
    sim.blit(sim.getTexture(), target, uvT.set(sx, sy, dipU - sx / 2, dipV - sy / 2));
    copy.blending = THREE.NoBlending;
    hm.setPaintTexture(hand, finger, target.texture);
    // The nail lifts the film away: clear water closes in and pushes the rest aside.
    addDrop(0, 0, 0, 0, dipU, dipV, (0.45 * Math.max(sx, sy)) ** 2);
    ripple(dipU, dipV, 0.7);
    lastDunk = dunkPayload.finger = finger;
    dunkPayload.hand = hand;
    if (app.sparkles) app.sparkles.burst(hm.getNailWorldPosition(finger, v1), 30);
    sm.sparkle();
    ev.emit(EVENTS.BOWL_DUNK, dunkPayload);
  }

  // ------------------------------------------------------- per frame --
  function update(dt) {
    let changed = false;

    // Drops: fall, then spread with the ring warp.
    if (phase === 0 && qCount > 0) {
      for (let j = 0; j < 7; j++) cur[j] = q[qHead * 7 + j];
      qHead = (qHead + 1) % 8;
      qCount--;
      t = 0;
      phase = cur[3] > 0 ? 1 : 2;
      if (phase === 1) dropMat.uniforms.uC.value.setRGB(cur[0], cur[1], cur[2]);
    }
    if (phase === 1) {
      t += dt;
      const k = Math.min(1, t / 0.24);
      drop.position.set((cur[4] - 0.5) * 2 * WR, WY + 0.45 * (1 - k * k), (0.5 - cur[5]) * 2 * WR);
      drop.visible = k < 1;
      if (k >= 1) {
        phase = 2;
        ripple(cur[4], cur[5], 0.5);
        sm.plip(0.9);
        dunkBtn.classList.add('ready');
        ev.emit(EVENTS.BOWL_DROP, dropPayload);
      }
      changed = true;
    }
    // Spread: the whole warp in one pass; the water shader eases it open.
    if (phase === 2) {
      warpPass(cur[4], cur[5], cur[6], cur[0], cur[1], cur[2], cur[3]);
      wat.uP.value.set(cur[4], cur[5], cur[6]);
      phase = 3;
      t = 0;
    }
    if (phase === 3) {
      t += dt;
      const k = Math.min(1, t / 0.34);
      wat.uP.value.z = cur[6] * (1 - k) ** 3;
      if (k >= 1) phase = 0;
      changed = true;
    }

    // Toothpick: velocity only, one segment per frame.
    if (dragging && hasMove && dt > 0) {
      hasMove = false;
      sim.splatVelocity(lu, lv, u, v, 0.02, (u - lu) / dt, (v - lv) / dt, 1);
      lu = u;
      lv = v;
      awake = 1.6;
    }
    // Fixed 30 Hz steps: every step resamples (blurs) the film, so a fast
    // screen must not blur it twice as fast. Stops 1.6 s after the last swirl.
    sim.tick();
    if (awake > 0) {
      awake -= dt;
      if ((acc += dt) >= 1 / 30) {
        sim.step(acc);
        acc = 0;
      }
      changed = true;
    }
    wat.uD.value = sim.getTexture();

    const rip = wat.uR.value;
    if (rip.w > 0.003) {
      rip.z += dt * 0.32;
      rip.w *= Math.exp(-dt * 2.4);
      changed = true;
    } else {
      rip.w = 0;
    }

    // Dunk: the hand arcs over the rim, dips, prints and comes home.
    if (dunkT >= 0) {
      const k = (dunkT += dt / 1.15);
      const a = clamp01(k / 0.38);
      const b = clamp01((k - 0.62) / 0.38);
      const h = smooth(a) * (1 - smooth(b));
      const g = hm.group;
      // Fingertip first: pitch the hand down about the nail, then carry it over the rim.
      quat.setFromAxisAngle(axis, 0.6 * h);
      g.quaternion.multiplyQuaternions(quat, quat0);
      const p = g.position.copy(handBase).sub(pivot).applyQuaternion(quat).add(pivot).addScaledVector(dunkOff, h);
      p.y += 0.12 * (Math.sin(Math.PI * a) + Math.sin(Math.PI * b));
      if (!printed && k >= 0.5) {
        printed = true;
        print();
      }
      if (k >= 1) {
        p.copy(handBase);
        g.quaternion.copy(quat0);
        dunkT = -1;
        dunkBtn.classList.remove('busy');
        // dunk, dunk, dunk: each dip moves on to the next finger.
        const next = FINGERS[(FINGERS.indexOf(hm.getActiveNail()) + 1) % 5];
        if (hm.getNail(hm.getCurrentHand(), next)) toFinger(next);
      }
      changed = true;
    }
    if (changed) app.invalidate();
  }

  // ------------------------------------------------------------- input --
  function hit(e) {
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((e.clientY - rect.top) / rect.height) * 2);
    ray.setFromCamera(ndc, S.camera);
    if (!ray.ray.intersectPlane(plane, v1)) return false;
    u = (v1.x - C.x) / (2 * WR) + 0.5;
    v = (C.z - v1.z) / (2 * WR) + 0.5;
    return (u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.25;
  }

  function up() {
    if (dragging && moved < 0.02) dropAt(u, v);
    dragging = false;
  }

  const mine = (e) => e.target === canvas && (e.stopPropagation(), true);
  const LISTENERS = [
    ['pointerdown', (e) => {
      if (!mine(e)) return;
      rect = canvas.getBoundingClientRect();
      if (dunkT >= 0 || !hit(e)) return;
      lu = u;
      lv = v;
      moved = 0;
      hasMove = false;
      dragging = true;
      canvas.setPointerCapture?.(e.pointerId);
    }],
    ['pointermove', (e) => {
      if (!dragging) return;
      e.stopPropagation();
      const pu = u;
      const pv = v;
      hit(e);
      if (moved < 0.03 && (moved += Math.hypot(u - pu, v - pv)) >= 0.03) sm.swish(0.35);
      hasMove = true;
    }],
    ['pointerup', (e) => {
      if (dragging) e.stopPropagation();
      up();
    }],
    ['pointercancel', up],
    ['click', mine],
    ['dblclick', mine],
  ];

  // ---------------------------------------------------------------- UI --
  const btn = (cls, html, parent, title, onClick) => {
    const b = parent.appendChild(document.createElement('button'));
    b.type = 'button';
    b.className = cls;
    b.innerHTML = html;
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  const svg = (s) => `<svg viewBox="0 0 64 64">${s}</svg>`;
  const ui = body.appendChild(document.createElement('div'));
  ui.className = 'bowl-ui';
  const row = ui.appendChild(document.createElement('div'));
  row.className = 'bowl-row';
  const bottles = COLORS.map((c, i) => {
    const b = btn('bowl-bottle', '<i></i>', row, 0, () => {
      pick(i);
      dropAt(0.5, 0.5);
    });
    b.style.setProperty('--c', c);
    return b;
  });
  const pick = (i) => {
    dropPayload.color = COLORS[i];
    bottles.forEach((b, j) => b.classList.toggle('sel', j === i));
  };
  pick(0);
  const toFinger = (f) => {
    app.selectNail(f);
    app.updateFingerSelectorUI?.();
  };

  function openBowl() {
    if (open || body.classList.contains('revealing')) return;
    brushWas = brush.isActive;
    brush.deactivate();
    ctrlWas = S.controls.enabled;
    S.controls.enabled = false;
    S.holdCamera(true);
    app.quality.hold(1500);
    const s = app.quality.settings;
    sim = makeSim(128, 384, Math.max(4, s.pressureIterations));
    wat.uE.value = s.tier === 'low' ? 0 : sim.opts.dyeRes;
    sumU = sumV = sumN = dunks = awake = 0;
    lastDunk = null;
    place();
    group.visible = open = true;
    dunkBtn.classList.remove('ready', 'busy');
    body.classList.add('bowl-open');
    for (const [n, f] of LISTENERS) window.addEventListener(n, f, true);
    app.loop.add(update, 6);
    sm.bottlePop();
    ev.emit(EVENTS.BOWL_OPEN);
    app.invalidate();
  }

  function close() {
    if (!open) return;
    if (dunkT >= 0) {
      hm.group.position.copy(handBase);
      hm.group.quaternion.copy(quat0);
    }
    dunkT = -1;
    sim.dispose();
    sim = wat.uD.value = null;
    wat.uR.value.w = wat.uP.value.z = qCount = phase = 0;
    group.visible = drop.visible = open = dragging = false;
    for (const [n, f] of LISTENERS) window.removeEventListener(n, f, true);
    app.loop.remove(update);
    body.classList.remove('bowl-open');
    S.holdCamera(false);
    S.controls.enabled = ctrlWas;
    if (lastDunk && lastDunk !== hm.getActiveNail()) toFinger(lastDunk);
    app.zoomToFinger(hm.getActiveNail());
    if (brushWas) brush.activate();
    sm.swish(0.5);
    ev.emit(EVENTS.BOWL_CLOSE);
    app.invalidate();
  }

  btn('bowl-btn', svg(ICON.bowl), body, 'Marble bowl', openBowl);
  btn('bowl-back', svg(ICON.back), ui, 'Back', close);
  const dunkBtn = btn('bowl-dunk', svg(ICON.dunk), ui, 'Dip', () => {
    if (!open || dunkT >= 0) return;
    // Dip at the film's centre, turned a golden angle per dunk: each nail gets its own crop.
    const n = Math.max(sumN, 1);
    dipU = (sumN ? sumU / n : 0.5) + 0.06 * Math.cos(dunks * 2.4);
    dipV = (sumN ? sumV / n : 0.5) + 0.06 * Math.sin(dunks++ * 2.4);
    const finger = hm.getActiveNail();
    const rec = hm.getNail(hm.getCurrentHand(), finger);
    // Footprint in the water (measured at rest, before the hand pitches).
    const geo = rec.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    box.copy(geo.boundingBox).applyMatrix4(rec.mesh.matrixWorld);
    const a = hm.getUVAspect(hm.getCurrentHand(), finger);
    const k = (Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * ZOOM) / (2 * WR);
    sx = a >= 1 ? k : k * a;
    sy = a >= 1 ? k / a : k;
    const nail = hm.getNailWorldPosition(finger, pivot);
    dunkOff.set(C.x + (dipU - 0.5) * 2 * WR - nail.x, C.y + WY - nail.y - 0.004, C.z - (dipV - 0.5) * 2 * WR - nail.z);
    // Pitch axis: up x (horizontal dip direction), so the fingertip goes down.
    axis.set(dunkOff.z, 0, -dunkOff.x).normalize();
    handBase.copy(hm.group.position);
    quat0.copy(hm.group.quaternion);
    dunkT = 0;
    printed = false;
    dunkBtn.classList.add('busy');
    app.quality.hold(1500);
    sm.swish(0.7);
  });

  ev.on(EVENTS.MODE_CHANGE, (p) => p.mode !== 'free' && close());
  ev.on(EVENTS.REVEAL_START, close);
  canvas.addEventListener('webglcontextlost', close);

  // Compile the bowl program (to screen) and the warp (to a target) at idle.
  whenIdle(() => {
    drop.visible = group.visible = true;
    warmRender(S.renderer, group, S.camera);
    drop.visible = group.visible = false;
    sim = makeSim(4, 4, 1);
    warpPass(0.5, 0.5, 0, 0, 0, 0, 0);
    sim.dispose();
    sim = null;
  }, 2500);

  app.bowl = { open: openBowl, close, group, get sim() { return sim; } };
}
