// Hand pose test (B9.4 / B9.5): the hand as a controllable surface.
//
// Usage:
//   node scripts/hand-pose.mjs [url] [--tier=high] [--shots=dir] [--prefix=b9r]
//
// Boots the built game (`npx vite preview --port 4441 --strictPort`) with
// ?perf=1 (continuous rendering, no ghost or camera sway) in headless Chrome
// (SwiftShader) and checks app.hand (src/scene/HandRig.js):
//   P1  fuzz: 500 random setFingerPose / setPose / presentFinger / setPress /
//       play calls (some out of range), frames between: every bone matrix
//       finite, every joint inside its limits
//   P2  transitions: presentFinger for each of the five settles within 600 ms
//       (measured in frames' time), no joint past a limit on the way
//   P3  contact at rest: 9 UV probes on the active nail of every finger, both
//       hands: the probe's world point projected to the screen and raycast
//       from that pixel gives back its UV within 0.5 paint texel (of 256)
//   P4  contact while moving: the same mid-transition, at full press-give and
//       while idle runs
//   P5  end to end, every finger of both hands: a real mouse dab at the screen
//       point of UV (0.5, 0.5) with idle running; the dab's centre (paint read
//       back from the GPU) is within 2 texels of (0.5, 0.5) (plan 7). The same
//       dab on a still hand (idle off) is reported beside it. (Dab centres
//       vary by ~1-2 texels run to run with the brush's own physics.)
//   P6  active nail steady: 3 s in the close-up with idle on: active nail
//       centre moves <= 0.5 px; with full press <= 3 px; the neighbours move
//       >= 1 px (idle runs)
//   P7  brush damping: idle amplitude with the brush down <= 25% of free idle
//   P8  rail: on every finger the camera is the focus pose (nail centre within
//       2 px of where focusPose puts it), the neighbours' nails on screen
//   P9  desk: no skin vertex below the desk + 0.01 in any library pose
//   P10 idle cost: 10 s idle on low without ?perf=1 (render on demand): heap
//       (retained, after a forced GC) <= +0.3 MB, rendered frames <= 21 per second
//   P11 motion feel (MOTION in src/scene/HandPoses.js, the chosen preset): a
//       knuckle step overshoots >= 5% with the brush up and <= 1% with the
//       brush down, where it also settles faster
// Exits 1 when a gated check fails.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const flags = {};
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else pos.push(a);
}
const BASE_URL = pos[0] || 'http://localhost:4441/';
const TIER = String(flags.tier || 'high');
const SHOTS = flags.shots ? String(flags.shots) : null;
const PREFIX = String(flags.prefix || 'b9r');
const CHROME = process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell';
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
let failed = 0;
function add(id, what, value, gate, ok) {
  rows.push({ id, what, value, gate, ok });
  if (ok === false) failed++;
}

async function boot({ tier = TIER, perf = true, vw = 1280, vh = 720 } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  const u = new URL(BASE_URL);
  u.searchParams.set('tier', tier);
  if (perf) u.searchParams.set('perf', '1');
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.__ready === true && app.nail && app.nail.getNailMesh && app.nail.getNailMesh() && app.hand && app.hand.rig, null, { timeout: 90000 });
  await page.evaluate(installHelpers);
  await settle(page);
  return { browser, page, errors };
}

// camera still, hand settled, not painting
async function settle(page) {
  await page.evaluate(() => { window.__still = null; });
  await page.waitForFunction(() => {
    const c = app.scene.camera.position; const w = window.__still || (window.__still = { x: 0, y: 0, z: 0, n: 0 });
    const same = Math.abs(c.x - w.x) + Math.abs(c.y - w.y) + Math.abs(c.z - w.z) < 1e-6 && !app.polishBrush3D.isPainting && !app.scene.isAnimating && app.hand.settled;
    w.x = c.x; w.y = c.y; w.z = c.z; w.n = same ? w.n + 1 : 0;
    return w.n > 8;
  }, null, { timeout: 60000, polling: 50 });
  await sleep(150);
}

// In-page helpers (window.__hp).
function installHelpers() {
  const THREE_V = app.scene.camera.position.constructor;
  const hp = window.__hp = {};
  const rc = new app.polishBrush3D.raycaster.constructor();
  const canvas = app.scene.renderer.domElement;
  hp.rect = () => canvas.getBoundingClientRect();
  // UV -> nail-local point (visible plate triangles), barycentric
  hp.uvPoint = (rec, u, v, out) => {
    const g = rec.mesh.geometry;
    const P = g.attributes.position, U = g.attributes.uv, I = g.index;
    const vis = rec.visible;
    const n = I ? I.count : P.count;
    for (let t = 0; t < n; t += 3) {
      const a = I ? I.getX(t) : t, b = I ? I.getX(t + 1) : t + 1, c = I ? I.getX(t + 2) : t + 2;
      if (vis && (!vis[a] || !vis[b] || !vis[c])) continue;
      const ax = U.getX(a), ay = U.getY(a), bx = U.getX(b), by = U.getY(b), cx = U.getX(c), cy = U.getY(c);
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
      const l2 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      out.set(0, 0, 0);
      out.x = P.getX(a) * l1 + P.getX(b) * l2 + P.getX(c) * l3;
      out.y = P.getY(a) * l1 + P.getY(b) * l2 + P.getY(c) * l3;
      out.z = P.getZ(a) * l1 + P.getZ(b) * l2 + P.getZ(c) * l3;
      return out;
    }
    return null;
  };
  hp.toScreen = (w) => {
    const r = hp.rect();
    const p = w.clone().project(app.scene.camera);
    return [r.left + (p.x + 1) * 0.5 * r.width, r.top + (1 - p.y) * 0.5 * r.height];
  };
  hp.screenOfUV = (finger, u, v) => {
    const rec = app.nail.getNail(app.nail.getCurrentHand(), finger);
    const p = hp.uvPoint(rec, u, v, new THREE_V());
    if (!p) return null;
    rec.mesh.updateWorldMatrix(true, false);
    return hp.toScreen(p.applyMatrix4(rec.mesh.matrixWorld));
  };
  hp.uvAtScreen = (finger, x, y) => {
    const r = hp.rect();
    rc.setFromCamera({ x: (x - r.left) / r.width * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 }, app.scene.camera);
    const rec = app.nail.getNail(app.nail.getCurrentHand(), finger);
    const h = rc.intersectObject(rec.mesh, false)[0];
    return h && h.uv ? [h.uv.x, h.uv.y] : null;
  };
  // 9 probes: max UV error in paint texels (of 256), without screen rounding
  hp.probe = (finger) => {
    const rec = app.nail.getNail(app.nail.getCurrentHand(), finger);
    app.scene.camera.updateMatrixWorld();
    let worst = 0, n = 0, miss = 0;
    for (const u of [0.2, 0.5, 0.8]) for (const v of [0.2, 0.5, 0.8]) {
      const s = hp.screenOfUV(finger, u, v);
      if (!s) continue;
      const got = hp.uvAtScreen(finger, s[0], s[1]);
      if (!got) { miss++; continue; }
      n++;
      worst = Math.max(worst, Math.hypot(got[0] - u, got[1] - v) * 256);
    }
    return { worst: n ? worst : Infinity, n, miss };
  };
  hp.limitsOk = () => {
    const rig = app.hand.rig;
    const L = app.hand.limits;
    let bad = 0, finite = true;
    for (let b = 0; b < rig.bones.length; b++) {
      const e = rig.bones[b].matrixWorld.elements;
      for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) finite = false;
      for (let k = 0; k < 3; k++) {
        const v = rig.applied[b * 3 + k];
        if (v < L[b * 6 + k * 2] - 1e-3 || v > L[b * 6 + k * 2 + 1] + 1e-3) bad++;
      }
    }
    return { finite, bad };
  };
  hp.nailScreen = (finger) => {
    const w = app.nail.getNailWorldPosition(finger, new THREE_V());
    return w ? hp.toScreen(w) : null;
  };
  // the paint of the bound nail, read back at N x N: alpha-weighted centre (texels) and coverage
  hp.dabCentre = (N = 256) => {
    const brush = app.polishBrush3D;
    const sim = brush.fluidSim;
    if (!hp.rt) {
      const RT = app.nail.getPaintTarget(app.nail.getCurrentHand(), app.nail.getActiveNail(), true).constructor;
      hp.rt = new RT(N, N, { depthBuffer: false });
      hp.rt.texture.minFilter = 1003; hp.rt.texture.magFilter = 1003; hp.rt.texture.generateMipmaps = false;
      hp.buf = new Uint8Array(N * N * 4);
    }
    sim.blit(sim.getTexture(), hp.rt);
    app.scene.renderer.readRenderTargetPixels(hp.rt, 0, 0, N, N, hp.buf);
    let sx = 0, sy = 0, sw = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const a = hp.buf[(y * N + x) * 4 + 3];
      if (a < 40) continue;
      sx += (x + 0.5) * a; sy += (y + 0.5) * a; sw += a;
    }
    return sw ? { x: sx / sw, y: sy / sw, w: sw / 255 } : null;
  };
}

async function frames(page, n) {
  await page.evaluate((k) => new Promise((res) => { let i = 0; const f = () => { if (++i >= k) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);
}

async function toFinger(page, f) {
  await page.evaluate((x) => app.switchToFinger(x), f);
  await settle(page);
}

async function dab(page, finger) {
  await page.evaluate(() => app.polishBrush3D.clearNail());
  await frames(page, 3);
  const p = await page.evaluate((f) => __hp.screenOfUV(f, 0.5, 0.5), finger);
  await page.mouse.move(p[0] - 30, p[1] + 40);
  await frames(page, 2);
  await page.mouse.move(p[0], p[1], { steps: 4 });
  await page.mouse.down();
  await sleep(260);
  await page.mouse.up();
  await frames(page, 4);
  await page.mouse.move(p[0] + 200, p[1] + 260);
  await frames(page, 2);
  return page.evaluate(() => __hp.dabCentre());
}

// ------------------------------------------------------------------ run --
const s = await boot();
const { page } = s;
const hasLimits = await page.evaluate(() => !!app.hand.limits);
add('P0', 'app.hand exposes the limits table', hasLimits, 'true', hasLimits);

// P1 fuzz
{
  const r = await page.evaluate(async () => {
    const H = app.hand;
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const F = ['thumb', 'index', 'middle', 'ring', 'pinky', 'nope'];
    let worstBad = 0, finite = true;
    for (let i = 0; i < 500; i++) {
      const k = Math.floor(rnd() * 6);
      if (k === 0) H.setFingerPose(F[Math.floor(rnd() * 6)], rnd() * 3 - 1, rnd() * 120 - 60);
      else if (k === 1) H.setPose(['neutral', 'relaxed', 'fan', 'bogus', 'auto'][Math.floor(rnd() * 5)], { ms: rnd() * 400 });
      else if (k === 2) H.presentFinger(F[Math.floor(rnd() * 6)], { ms: rnd() * 400 });
      else if (k === 3) H.setPress(rnd() * 4 - 1, rnd() * 3 - 1);
      else if (k === 4) H.play(rnd() < 0.5 ? 'wiggle' : 'nothing');
      else H.update(rnd() * 0.2);
      if (i % 10 === 0) await new Promise((res) => requestAnimationFrame(res));
      const c = __hp.limitsOk();
      if (!c.finite) finite = false;
      worstBad = Math.max(worstBad, c.bad);
    }
    H.clearOverrides(); H.setPress(0); H.setPose('auto');
    return { finite, worstBad };
  });
  add('P1', 'fuzz 500 calls: bone matrices finite', r.finite, 'true', r.finite);
  add('P1', 'fuzz 500 calls: joints outside limits (worst frame)', r.worstBad, '0', r.worstBad === 0);
}
await page.evaluate(() => app.switchToFinger('index'));
await settle(page);

// P2 transitions (manual presentFinger, real frames)
{
  const r = await page.evaluate(async () => {
    const H = app.hand;
    const out = {};
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      H.presentFinger(f);
      const t0 = performance.now();
      let bad = 0, ms = null, moving = false;
      while (performance.now() - t0 < 5000) {
        await new Promise((res) => requestAnimationFrame(res));
        bad = Math.max(bad, __hp.limitsOk().bad);
        if (!H.settled) moving = true;
        else if (moving) { ms = performance.now() - t0; break; }
      }
      out[f] = { ms: ms === null ? null : Math.round(ms), bad };
    }
    H.presentFinger('auto');
    return out;
  });
  for (const f of FINGERS) add('P2', `presentFinger('${f}'): settled ms, joints past a limit`, `${r[f].ms}, ${r[f].bad}`, '<= 600, 0', r[f].ms !== null && r[f].ms <= 600 && r[f].bad === 0);
}
await settle(page);

// P3-P5, P8 per hand and finger
const e2e = [];
for (const hand of ['left', 'right']) {
  if ((await page.evaluate(() => app.nail.getCurrentHand())) !== hand) {
    await page.evaluate((h) => app.switchHand(h), hand);
    await page.waitForFunction((h) => app.nail.getCurrentHand() === h && app.nail.isHandLoaded(h) && app.hand.rig, hand, { timeout: 30000 });
    await settle(page);
  }
  for (const f of FINGERS) {
    await toFinger(page, f);
    const rest = await page.evaluate((x) => __hp.probe(x), f);
    add('P3', `${hand} ${f}: contact error at rest (texels of 256, 9 probes)`, `${rest.worst.toFixed(3)} (${rest.n})`, '<= 0.5', rest.n === 9 && rest.worst <= 0.5);
    // rail: camera is the focus pose
    const rail = await page.evaluate((x) => {
      const V = app.scene.camera.position.constructor;
      const pose = { pos: new V(), target: new V(), up: new V(), d: 0, ok: false };
      app.scene.focusPose(x, pose);
      const cam = app.scene.camera.clone();
      cam.position.copy(pose.pos); cam.up.copy(pose.up); cam.lookAt(pose.target); cam.updateMatrixWorld(true);
      const w = app.nail.getNailWorldPosition(x, new V());
      const a = __hp.toScreen(w);
      const p = w.clone().project(cam); const r = __hp.rect();
      const b = [r.left + (p.x + 1) * 0.5 * r.width, r.top + (1 - p.y) * 0.5 * r.height];
      const nb = [];
      for (const g of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        if (g === x) continue;
        const s = __hp.nailScreen(g);
        nb.push(s && s[0] > r.left - 40 && s[0] < r.right + 40 && s[1] > r.top - 40 && s[1] < r.bottom + 40 ? 1 : 0);
      }
      return { err: Math.hypot(a[0] - b[0], a[1] - b[1]), neighbours: nb, railS: app.scene.railS };
    }, f);
    add('P8', `${hand} ${f}: nail centre vs focusPose (px), railS`, `${rail.err.toFixed(2)}, ${rail.railS}`, '<= 2', rail.err <= 2);
    // moving: mid-transition (present another finger, a few frames), full press, idle
    const moving = await page.evaluate(async (x) => {
      const H = app.hand;
      const res = {};
      const other = x === 'index' ? 'middle' : 'index';
      H.presentFinger(other);
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      const pm = __hp.probe(x);
      res.mid = pm.n >= 7 ? pm.worst : Infinity;
      res.midMiss = pm.miss;
      H.presentFinger('auto');
      while (!H.settled) await new Promise((r) => requestAnimationFrame(r));
      H.setPress(1, 0.8);
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      res.press = __hp.probe(x).worst;
      H.setPress(0);
      H.setIdle(1);
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
      res.idle = __hp.probe(x).worst;
      return res;
    }, f);
    add('P4', `${hand} ${f}: contact error mid-transition / full press / idle (texels)`, `${moving.mid.toFixed(3)} (${moving.midMiss} grazing) / ${moving.press.toFixed(3)} / ${moving.idle.toFixed(3)}`, '<= 0.5', Math.max(moving.mid, moving.press, moving.idle) <= 0.5);
    await settle(page);
    // end to end: still hand vs press-give + idle
    await page.evaluate(() => app.hand.setIdle(0));
    await settle(page);
    const still = await dab(page, f);
    await page.evaluate(() => app.hand.setIdle(1));
    await settle(page);
    const live = await dab(page, f);
    e2e.push({ hand, f, still, live });
    const ok = still && live;
    const dLive = ok ? Math.hypot(live.x - still.x, live.y - still.y) : Infinity;
    const dTarget = ok ? Math.hypot(live.x - 128, live.y - 128) : Infinity;
    const dStill = ok ? Math.hypot(still.x - 128, still.y - 128) : Infinity;
    add('P5', `${hand} ${f}: live dab centre vs uv (0.5,0.5) (texels); still hand, live vs still`, `${dTarget.toFixed(2)}; ${dStill.toFixed(2)}, ${dLive.toFixed(2)}`, '<= 2 (plan 7)', dTarget <= 2);
    if (SHOTS && hand === 'right') {
      await page.evaluate(() => app.polishBrush3D.clearNail());
      await settle(page);
      await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-pose-${f}.png`) });
    }
  }
}

// P6 / P7 steadiness and damping (right hand, index)
await toFinger(page, 'index');
{
  const r = await page.evaluate(async () => {
    const H = app.hand;
    const track = async (ms, setup) => {
      setup();
      const first = {}, dev = {};
      const F = ['thumb', 'index', 'middle', 'ring', 'pinky'];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await new Promise((res) => requestAnimationFrame(res));
        for (const f of F) {
          const s = __hp.nailScreen(f);
          if (!s) continue;
          if (!first[f]) { first[f] = s; dev[f] = 0; }
          dev[f] = Math.max(dev[f], Math.hypot(s[0] - first[f][0], s[1] - first[f][1]));
        }
      }
      return dev;
    };
    H.setIdle(1); H.setStroke(false);
    const free = await track(3000, () => {});
    const press = await track(1500, () => H.setPress(1, 0.5));
    H.setPress(0);
    await new Promise((res) => setTimeout(res, 600));
    H.setStroke(true);
    await new Promise((res) => setTimeout(res, 400));
    const damped = await track(3000, () => {});
    H.setStroke(false);
    return { free, press, damped };
  });
  const nb = ['thumb', 'middle', 'ring', 'pinky'];
  const freeNb = Math.max(...nb.map((f) => r.free[f] || 0));
  const dampNb = Math.max(...nb.map((f) => r.damped[f] || 0));
  add('P6', 'active nail centre, 3 s idle (px)', +r.free.index.toFixed(3), '<= 0.5', r.free.index <= 0.5);
  add('P6', 'active nail centre, full press (px)', +r.press.index.toFixed(3), '<= 3', r.press.index <= 3);
  add('P6', 'neighbours move with idle on (max px)', +freeNb.toFixed(2), '>= 1', freeNb >= 1);
  add('P7', 'idle with the brush down vs free (neighbours, ratio)', +(dampNb / Math.max(freeNb, 1e-6)).toFixed(3), '<= 0.25', dampNb <= 0.25 * freeNb);
}

// P11 motion feel: joint springs, springy free, nearly stiff with the brush down
{
  const r = await page.evaluate(async () => {
    const H = app.hand;
    // index knuckle (bone 5, flex): presented (-8) -> as another finger (+8) and back
    const step = async (firm) => {
      H.setStroke(firm);
      H.presentFinger('index', { ms: 0 });
      while (!H.settled) await new Promise((res) => requestAnimationFrame(res));
      for (let i = 0; i < 20; i++) await new Promise((res) => requestAnimationFrame(res));
      const a0 = H.rig.applied[15];
      H.presentFinger('middle', { ms: 0 });
      const t0 = performance.now();
      let peak = a0, settle = null, a1 = null, moving = false;
      while (performance.now() - t0 < 5000) {
        await new Promise((res) => requestAnimationFrame(res));
        const a = H.rig.applied[15];
        peak = Math.max(peak, a);
        if (!H.settled) moving = true;
        else if (moving && settle === null) { settle = performance.now() - t0; a1 = a; }
      }
      a1 = H.rig.applied[15];
      H.setStroke(false);
      H.presentFinger('auto');
      return { overshoot: (peak - a1) / Math.max(1e-6, a1 - a0), settle };
    };
    const springy = await step(false);
    const firm = await step(true);
    return { springy, firm };
  });
  const feel = await page.evaluate(() => app.hand.motion.preset);
  add('P11', `${feel}, brush up: knuckle step overshoot (fraction), settle ms`, `${r.springy.overshoot.toFixed(3)}, ${Math.round(r.springy.settle)}`, '>= 0.05 (springy)', r.springy.overshoot >= 0.05);
  add('P11', `${feel}, brush down: knuckle step overshoot (fraction), settle ms`, `${r.firm.overshoot.toFixed(3)}, ${Math.round(r.firm.settle)}`, '<= 0.01, faster than up', r.firm.overshoot <= 0.01 && r.firm.settle !== null && (r.springy.settle === null || r.firm.settle < r.springy.settle));
  await settle(page);
}

// P9 desk
{
  const r = await page.evaluate(() => {
    const hm = app.nail;
    const model = hm.hands[hm.getCurrentHand()].model;
    let skin = null; model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const V = app.scene.camera.position.constructor;
    const v = new V();
    const desk = app.scene.backdrop && app.scene.backdrop.desk ? app.scene.backdrop.desk.position.y : null;
    const out = {};
    for (const p of ['neutral', 'relaxed', 'fan', 'thumb', 'index', 'middle', 'ring', 'pinky']) {
      out[p] = app.hand.withPose(p, () => {
        skin.skeleton.update();
        let lo = Infinity;
        const P = skin.geometry.attributes.position;
        // fingers only: the forearm dips under the towel on purpose
        const ws = skin.geometry.attributes.skinWeight, ix = skin.geometry.attributes.skinIndex;
        const bones = skin.skeleton.bones;
        for (let i = 0; i < P.count; i++) {
          let fw = 0;
          for (let k = 0; k < 4; k++) { const n = bones[ix.getComponent(i, k)].name; if (/0?[123]$/.test(n)) fw += ws.getComponent(i, k); }
          if (fw < 0.5) continue;
          skin.getVertexPosition(i, v); v.applyMatrix4(skin.matrixWorld);
          if (v.y < lo) lo = v.y;
        }
        return lo;
      });
    }
    return { desk, out };
  });
  for (const [p, lo] of Object.entries(r.out)) add('P9', `pose ${p}: lowest finger vertex - (desk + 0.01)`, +(lo - r.desk - 0.01).toFixed(4), '>= 0', lo >= r.desk + 0.01);
}
if (SHOTS) {
  await page.evaluate(() => app.scene.zoomOut());
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-zoomed-out.png`) });
}
add('P', 'page errors', s.errors.length ? s.errors.slice(0, 3).join(' | ') : 0, '0', s.errors.length === 0);
await s.browser.close();

// P10 idle cost on low, render on demand
{
  const t = await boot({ tier: 'low', perf: false });
  const r = await t.page.evaluate(async () => {
    app.switchToFinger('index');
    // let the intro, the brush and the film go to sleep (the base game then renders 4 frames a second)
    await new Promise((res) => setTimeout(res, 15000));
    let rendered = 0, frames = 0;
    const count = () => { frames++; if (app.loop.renderedThisFrame) rendered++; };
    app.loop.add(count, 99);
    // retained heap (after a full GC at both ends): garbage from rendering
    // 19 frames a second is not growth
    const heap = () => { if (window.gc) window.gc(); return performance.memory ? performance.memory.usedJSHeapSize : 0; };
    const h0 = heap();
    const t0 = performance.now();
    await new Promise((res) => setTimeout(res, 10000));
    const secs = (performance.now() - t0) / 1000;
    const h1 = heap();
    app.loop.remove(count);
    return { perSec: rendered / secs, frames: frames / secs, heapMB: (h1 - h0) / 1e6, idle: app.hand.idleRunning };
  });
  add('P10', 'low, 10 s idle: rendered frames per second (rAF frames)', `${r.perSec.toFixed(1)} (${r.frames.toFixed(1)}), idle ${r.idle}`, '<= 21', r.perSec <= 21);
  add('P10', 'low, 10 s idle: retained heap growth after GC (MB)', +r.heapMB.toFixed(3), '<= 0.3', r.heapMB <= 0.3);
  add('P', 'page errors (low)', t.errors.length ? t.errors.slice(0, 3).join(' | ') : 0, '0', t.errors.length === 0);
  await t.browser.close();
}

const pad = (x, n) => String(x).padEnd(n);
console.log(pad('id', 5) + pad('check', 74) + pad('value', 30) + pad('gate', 14) + 'ok');
for (const r of rows) console.log(pad(r.id, 5) + pad(r.what, 74) + pad(r.value, 30) + pad(r.gate, 14) + (r.ok === null ? '-' : r.ok ? 'PASS' : 'FAIL'));
if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${PREFIX}-hand-pose.json`), JSON.stringify({ rows, e2e }, null, 1));
console.log(failed ? `${failed} FAILED` : 'all gated checks pass');
process.exit(failed ? 1 : 0);
