// Brush feel harness (brush plan B0): measures what the player feels.
//
// Usage:
//   node scripts/brush-feel.mjs [url] [--tiers=high,low] [--inputs=mouse,touch]
//        [--out=dir] [--gate=A,B1] [--quick] [--no-perf] [--no-shots]
//
// Boots the built game (`npx vite preview --port 4411 --strictPort`) in headless
// Chrome with SwiftShader, once per tier x input, plays the stroke set of
// docs/upgrade/brush-plan.md (B0) with real CDP mouse or touch events sent at
// 120 Hz (pipelined, so the browser coalesces them like a real device), and
// records per frame: pointer, deposit point, bristle tips, input samples,
// raycasts, off-screen passes, load, camera. The dye (and the film relief when
// there is one) is read back through an 8-bit blit and mapped to the screen by
// a per-pixel raycast map of the nail.
//
// Prints one JSON line per stroke, then a pass/fail table for section 6 (A1..A20)
// and for B1's acceptance (B1.*). Exits 1 when a gated line fails (default: every
// A and B1 line; `--gate=B1` gates on B1 lines only). Results and screenshots go
// to --out (default: $TMPDIR/brush-feel).
//
// Reads `app.polishBrush3D.debug` (plan 4.7) when the engine provides it; until
// then it falls back to public fields of today's brush (`inputHandler.result`,
// `bristleSystem.jointPositions`, `fluidSim`). Private `_names` are mangled in the
// build, so nothing here touches them.
import fs from 'fs';
import os from 'os';
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
const BASE_URL = pos[0] || 'http://localhost:4411/';
const TIERS = String(flags.tiers || 'high,low').split(',');
const INPUTS = String(flags.inputs || 'mouse,touch').split(',');
const OUT = flags.out || path.join(os.tmpdir(), 'brush-feel');
const QUICK = !!flags.quick;
const PERF = !flags['no-perf'] && !QUICK;
const SHOTS = !flags['no-shots'];
const GATE = flags.gate ? String(flags.gate).split(',') : ['A', 'B1'];
const CHROME = process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell';
const NUDGE = 12; // plan 3.1: constant touch nudge, CSS px up
const HZ = 120;   // input rate
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : +(+v).toFixed(1));
const r3 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : +(+v).toFixed(3));
function stats(a) {
  const v = a.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (!v.length) return null;
  const s = [...v].sort((x, y) => x - y);
  const mean = v.reduce((x, y) => x + y, 0) / v.length;
  return { n: v.length, mean: r1(mean), med: r1(s[s.length >> 1]), min: r1(s[0]), max: r1(s[s.length - 1]), p95: r1(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]) };
}
const median = (a) => { const s = stats(a); return s ? s.med : null; };
const mean = (a) => { const s = stats(a); return s ? s.mean : null; };

// ------------------------------------------------------------------ boot --

async function boot(tier, kind) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, hasTouch: kind === 'touch', isMobile: false });
  const page = await ctx.newPage();
  const host = new URL(BASE_URL).host;
  const errors = [];
  const external = new Set();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host !== host && u.protocol.startsWith('http')) { external.add(u.host); return route.abort(); }
    return route.continue();
  });
  const u = new URL(BASE_URL);
  u.searchParams.set('tier', tier);
  u.searchParams.set('perf', '1'); // no ghost, no auto-advance, no camera sway
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.__ready === true && window.app.nail && window.app.nail.getNailMesh
    && window.app.nail.getNailMesh() && window.app.polishBrush3D && window.app.polishBrush3D.inputHandler, null, { timeout: 90000 });
  const cdp = await ctx.newCDPSession(page);
  const s = { browser, ctx, page, cdp, errors, external, kind, tier };
  s.input = makeInput(s);
  return s;
}

// CDP input, pipelined: sends are not awaited one by one, so several events land
// between two frames and the page sees them as one coalesced pointermove.
function makeInput(s) {
  const { cdp, kind } = s;
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, buttons, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse',
  });
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  return {
    hover: (x, y) => mouse('mouseMoved', x, y, 0),
    down: (x, y) => (kind === 'touch' ? touch('touchStart', [{ x, y, id: 1 }]) : mouse('mousePressed', x, y, 1)),
    move: (x, y, extra) => (kind === 'touch' ? touch('touchMove', [{ x, y, id: 1 }].concat(extra || [])) : mouse('mouseMoved', x, y, 1)),
    up: (x, y) => (kind === 'touch' ? touch('touchEnd', []) : mouse('mouseReleased', x, y, 0)),
    touch,
  };
}

function polyline(pts) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(d); total += d; }
  const at = (f) => {
    if (pts.length < 2) return pts[0];
    let d = f * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) { const k = segs[i] ? Math.min(1, d / segs[i]) : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
      d -= segs[i];
    }
    return pts[pts.length - 1];
  };
  return { at, total };
}

// A stroke along polyline `pts` in `dur` ms. Options: hold (ms still after down
// and before up), hz, second ({ from, to, pts } fraction window for a second
// finger, touch only), noUp (leave the pointer down), mid (async callback at a
// fraction of the stroke, while moving).
async function stroke(s, pts, dur, { hold = 60, hz = HZ, second = null, noUp = false, mid = null, skipDown = false } = {}) {
  const inp = s.input;
  const { at, total } = polyline(pts);
  if (!skipDown) {
    if (s.kind === 'mouse') await inp.hover(pts[0][0], pts[0][1]);
    await inp.down(pts[0][0], pts[0][1]);
    await sleep(hold);
  }
  const pend = [];
  let last = pts[0];
  let secondOn = false;
  let midDone = !mid;
  const t0 = Date.now();
  if (total > 0) {
    for (;;) {
      const f = Math.min(1, (Date.now() - t0) / dur);
      const p = at(f);
      last = p;
      if (second && s.kind === 'touch') {
        const inWin = f >= second.from && f <= second.to;
        const q = polyline(second.pts).at(Math.min(1, Math.max(0, (f - second.from) / (second.to - second.from))));
        const p2 = { x: q[0], y: q[1], id: 2 };
        if (inWin && !secondOn) { pend.push(inp.touch('touchStart', [{ x: p[0], y: p[1], id: 1 }, p2])); secondOn = true; }
        else if (!inWin && secondOn) { pend.push(inp.touch('touchEnd', [{ x: p[0], y: p[1], id: 1 }])); secondOn = false; }
        else pend.push(inp.move(p[0], p[1], secondOn ? [p2] : null));
      } else {
        pend.push(inp.move(p[0], p[1]));
      }
      if (!midDone && f >= mid.at) { midDone = true; pend.push(mid.fn()); }
      if (f >= 1) break;
      await sleep(1000 / hz);
    }
  } else {
    await sleep(dur);
  }
  await Promise.all(pend);
  if (noUp) return last;
  await sleep(hold);
  await inp.up(last[0], last[1]);
  return last;
}

// ------------------------------------------------------------ page side --

async function install(page) {
  return page.evaluate(() => {
    const app = window.app;
    const brush = app.polishBrush3D;
    const cam = app.scene.camera;
    const renderer = app.scene.renderer;
    const canvas = document.querySelector('#canvas-container canvas');
    const V3 = cam.position.constructor;
    const rc = new brush.raycaster.constructor();
    const T = window.__T = {
      rec: false, frames: [], events: [], evN: 0, ptr: { x: 0, y: 0, id: -1, down: false }, ptr2: null,
      covered: 0, engineStarts: 0, passes: 0, reading: false, throttleMs: 0, a3: false, rcN: 0, ft: null,
    };
    let R = canvas.getBoundingClientRect();
    const tmp = new V3();
    const projXYZ = (x, y, z) => { tmp.set(x, y, z).project(cam); return [R.left + (tmp.x + 1) / 2 * R.width, R.top + (1 - tmp.y) / 2 * R.height]; };
    const proj = (v) => projXYZ(v.x, v.y, v.z);
    T.proj = proj;
    const ndc = { x: 0, y: 0 };
    T.hit = (sx, sy) => {
      ndc.x = (sx - R.left) / R.width * 2 - 1; ndc.y = -((sy - R.top) / R.height) * 2 + 1;
      rc.setFromCamera(ndc, cam);
      const h = rc.intersectObject(app.nail.getNailMesh(), false);
      return h.length ? h[0] : null;
    };
    T.box = () => {
      R = canvas.getBoundingClientRect();
      const xs = [], ys = []; const N = 160, M = 90;
      for (let gx = 0; gx <= N; gx++) for (let gy = 0; gy <= M; gy++) {
        const sx = R.left + R.width * gx / N, sy = R.top + R.height * gy / M;
        if (T.hit(sx, sy)) { xs.push(sx); ys.push(sy); }
      }
      if (!xs.length) return null;
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    // per-pixel uv map of the nail (1 CSS px), built once: the camera holds still
    T.buildMap = (box, pad = 12) => {
      const x0 = Math.floor(box.x0 - pad), y0 = Math.floor(box.y0 - pad);
      const W = Math.ceil(box.x1 - box.x0 + 2 * pad), H = Math.ceil(box.y1 - box.y0 + 2 * pad);
      const u = new Float32Array(W * H).fill(-1), v = new Float32Array(W * H).fill(-1);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const h = T.hit(x0 + x + 0.5, y0 + y + 0.5);
        if (h && h.uv) { u[y * W + x] = h.uv.x; v[y * W + x] = h.uv.y; }
      }
      T.map = { x0, y0, W, H, u, v };
      let n = 0; for (let i = 0; i < W * H; i++) if (u[i] >= 0) n++;
      return { x0, y0, W, H, nail: n };
    };
    // 8-bit readback of a texture through the sim's blit
    T.readTex = (tex, N) => {
      const sim = brush.fluidSim;
      if (!T.rt || T.rt.width !== N) {
        let RT = sim.dye && sim.dye.read ? sim.dye.read.constructor : null;
        if (!RT) RT = app.nail.getPaintTarget(app.nail.getCurrentHand(), app.nail.getActiveNail(), true).constructor;
        T.rt = new RT(N, N, { depthBuffer: false });
        T.rt.texture.minFilter = 1003; T.rt.texture.magFilter = 1003; T.rt.texture.generateMipmaps = false;
        T.buf = new Uint8Array(N * N * 4);
      }
      T.reading = true;
      sim.blit(tex, T.rt);
      renderer.readRenderTargetPixels(T.rt, 0, 0, N, N, T.buf);
      T.reading = false;
      return T.buf;
    };
    const mapTex = (buf, N, ch) => {
      const m = T.map; const out = new Array(m.W * m.H);
      for (let i = 0; i < m.W * m.H; i++) {
        const uu = m.u[i];
        if (uu < 0) { out[i] = -1; continue; }
        const tx = Math.min(N - 1, Math.max(0, Math.floor(uu * N))), ty = Math.min(N - 1, Math.max(0, Math.floor(m.v[i] * N)));
        out[i] = buf[(ty * N + tx) * 4 + ch];
      }
      return out;
    };
    T.mask = (N = 256) => {
      const m = T.map;
      return { x0: m.x0, y0: m.y0, W: m.W, H: m.H, a: mapTex(T.readTex(brush.fluidSim.getTexture(), N), N, 3), appCov: brush.getCoverage() };
    };
    T.film = (N = 256) => {
      const sim = brush.fluidSim;
      const tex = sim.getFilmTexture ? sim.getFilmTexture() : null;
      if (!tex) return null;
      const m = T.map;
      return { x0: m.x0, y0: m.y0, W: m.W, H: m.H, a: mapTex(T.readTex(tex, N), N, 0), awake: sim.isAwake ? sim.isAwake() : null };
    };
    // one texel, same frame (A3): blit, then read back a single pixel
    T.dyeAt = (u, v, N = 256) => {
      if (!T.rt || T.rt.width !== N) T.readTex(brush.fluidSim.getTexture(), N);
      const tx = Math.min(N - 1, Math.max(0, Math.floor(u * N))), ty = Math.min(N - 1, Math.max(0, Math.floor(v * N)));
      const px = T.px1 || (T.px1 = new Uint8Array(4));
      T.reading = true;
      brush.fluidSim.blit(brush.fluidSim.getTexture(), T.rt);
      renderer.readRenderTargetPixels(T.rt, tx, ty, 1, 1, px);
      T.reading = false;
      return px[3];
    };
    T.clear = () => {
      brush.clearNail();
      if (typeof brush.dip === 'function') brush.dip();
      brush.bristleSystem.setLoad(1);
    };
    T.info = () => {
      const hm = app.nail; const sim = brush.fluidSim; const ih = brush.inputHandler;
      return {
        hand: hm.getCurrentHand(), finger: hm.getActiveNail(), aspect: hm.getUVAspect ? hm.getUVAspect(hm.getCurrentHand(), hm.getActiveNail()) : null,
        tier: app.quality.tier, scale: app.quality.scale, mode: app.mode, active: brush.isActive,
        sim: sim ? (sim.opts ? JSON.parse(JSON.stringify(sim.opts)) : sim.constructor.name) : null,
        film: !!(sim && sim.getFilmTexture && sim.getFilmTexture()), debugHook: !!brush.debug,
        input: ih ? { maxSamples: ih.maxSamples ?? null, eventSource: ih.eventSource || 'pointermove', samplesApi: typeof ih.sampleCount === 'number' } : null,
        bristles: brush.bristleSystem.bristleCount, cap: ih && ih.maxSamples ? ih.maxSamples : 1,
      };
    };
    // handle + head height on screen (projected mesh bounding boxes)
    T.rigScreen = () => {
      const b = brush.bristleSystem; b.group.updateMatrixWorld(true);
      const one = (mesh) => {
        if (!mesh || !mesh.geometry) return null;
        const g = mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (let i = 0; i < 8; i++) {
          tmp.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mesh.matrixWorld);
          const p = proj(tmp); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        }
        return { w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1), y0: +y0.toFixed(1), y1: +y1.toFixed(1) };
      };
      const hd = one(b.handle), hb = one(b.mesh);
      return { handle: hd, head: hb, totalH: hd && hb ? +(Math.max(hd.y1, hb.y1) - Math.min(hd.y0, hb.y0)).toFixed(1) : null };
    };

    // pointer log, mirroring the input handler's event source
    const onEv = (e) => {
      const ih = brush.inputHandler;
      const src = (ih && ih.eventSource) || 'pointermove';
      const t = e.type;
      if (t === 'pointerdown') {
        if (!T.ptr.down) { T.ptr.id = e.pointerId; T.ptr.down = true; T.ptr.x = e.clientX; T.ptr.y = e.clientY; }
        else T.ptr2 = { x: e.clientX, y: e.clientY };
      } else if (t === 'pointerup' || t === 'pointercancel') {
        if (e.pointerId === T.ptr.id) T.ptr.down = false; else T.ptr2 = null;
      } else if (t === src) {
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        const n = list && list.length ? list.length : 1;
        const lastE = list && list.length ? list[list.length - 1] : e;
        if (e.pointerId === T.ptr.id || (!T.ptr.down && e.pointerType !== 'touch')) {
          if (T.ptr.down) T.evN += n;
          // every delivered (coalesced) position of the tracked pointer while down
          if (T.rec && T.ptr.down) { if (list && list.length) for (const c of list) T.events.push([+c.timeStamp.toFixed(1), 'c', e.pointerId, +c.clientX.toFixed(1), +c.clientY.toFixed(1)]); else T.events.push([+e.timeStamp.toFixed(1), 'c', e.pointerId, +e.clientX.toFixed(1), +e.clientY.toFixed(1)]); }
          T.ptr.x = lastE.clientX; T.ptr.y = lastE.clientY;
        } else if (T.ptr2) { T.ptr2.x = lastE.clientX; T.ptr2.y = lastE.clientY; }
      } else return;
      if (T.rec) T.events.push([+performance.now().toFixed(1), t, e.pointerId, +e.clientX.toFixed(1), +e.clientY.toFixed(1)]);
    };
    for (const n of ['pointerdown', 'pointermove', 'pointerrawupdate', 'pointerup', 'pointercancel']) window.addEventListener(n, onEv, true);
    app.events.on('nail:covered', () => { T.covered++; });
    app.events.on('brush:strokeStart', () => { T.engineStarts++; });

    // off-screen passes: renderer.render calls into a render target (ours excluded)
    const origRender = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => { if (!T.reading && renderer.getRenderTarget() !== null) T.passes++; return origRender(scene, camera); };

    const wrapRaycaster = () => {
      const ih = brush.inputHandler;
      if (!ih || ih.raycaster === T.wrappedRc) return;
      const r = ih.raycaster; const orig = r.intersectObject.bind(r);
      r.intersectObject = (o, rec, arr) => { T.rcN++; return orig(o, rec, arr); };
      T.wrappedRc = r;
    };

    const tipV = new V3();
    const sample = (t) => {
      const ih = brush.inputHandler; const b = brush.bristleSystem; const dbg = brush.debug || null;
      const res = ih ? (ih.tip || ih.result) : null;
      const f = { t: +t.toFixed(1), ev: T.evN, px: T.ptr.x, py: T.ptr.y, painting: !!brush.isPainting, rc: T.rcN, passes: T.passes };
      if (T.ptr2) f.p2 = [T.ptr2.x, T.ptr2.y];
      f.down = ih ? !!(ih.down !== undefined ? ih.down : ih.isPointerDown) : false;
      f.valid = res ? !!res.isValid : false;
      f.hover = res ? !!res.hover : false;
      if (dbg && dbg.depositScreen) f.dep = [+dbg.depositScreen[0].toFixed(2), +dbg.depositScreen[1].toFixed(2)];
      else if (res && res.isValid) { const p = proj(res.surfacePoint); f.dep = [+p[0].toFixed(2), +p[1].toFixed(2)]; }
      f.uv = res && res.isValid && res.hasUV ? [res.uv.x, res.uv.y] : null;
      f.lift = ih && ih.touchLift !== undefined ? ih.touchLift : null;
      if (ih && typeof ih.sampleCount === 'number') {
        f.sc = ih.sampleCount; f.ss = !!ih.strokeStart; f.se = !!ih.strokeEnd;
        if (ih.sampleCount) {
          const s = ih.samples; f.samp = [];
          for (let i = 0; i < ih.sampleCount; i++) { const o = i * 8; const p = projXYZ(s[o + 2], s[o + 3], s[o + 4]); f.samp.push(+p[0].toFixed(2), +p[1].toFixed(2), s[o + 6]); }
        }
      }
      f.load = dbg && dbg.load !== undefined ? dbg.load : b.load;
      f.dry = dbg && dbg.dry !== undefined ? dbg.dry : null;
      f.hwPx = dbg && dbg.halfWidthPx !== undefined ? dbg.halfWidthPx : null;
      f.axisDbg = dbg && dbg.axisAngle !== undefined ? dbg.axisAngle : null;
      f.cam = [cam.position.x, cam.position.y, cam.position.z];
      // bristle tips: joints may be stored in group-local or world space
      b.group.updateMatrixWorld();
      const J = b.jointsPerBristle || 4, n = b.bristleCount, jp = b.jointPositions;
      if (jp && n) {
        const mw = b.group.matrixWorld; let world = false;
        if (b.tipCenter) {
          let lx = 0, ly = 0, lz = 0, wx = 0, wy = 0, wz = 0;
          for (let i = 0; i < n; i++) { const k = (i * J + J - 1) * 3; tipV.set(jp[k], jp[k + 1], jp[k + 2]); wx += tipV.x; wy += tipV.y; wz += tipV.z; tipV.applyMatrix4(mw); lx += tipV.x; ly += tipV.y; lz += tipV.z; }
          const tc = b.tipCenter;
          world = Math.hypot(wx / n - tc.x, wy / n - tc.y, wz / n - tc.z) < Math.hypot(lx / n - tc.x, ly / n - tc.y, lz / n - tc.z);
        }
        let mx = 0, my = 0, qx = 0, qy = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; const P = T.tipPts || (T.tipPts = new Float64Array(512));
        for (let i = 0; i < n; i++) {
          const k = (i * J + J - 1) * 3; tipV.set(jp[k], jp[k + 1], jp[k + 2]); if (!world) tipV.applyMatrix4(mw);
          const p = proj(tipV); P[i * 2] = p[0]; P[i * 2 + 1] = p[1]; mx += p[0]; my += p[1];
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
          for (let j = 1; j < J - 1; j++) { const q = (i * J + j) * 3; tipV.set(jp[q], jp[q + 1], jp[q + 2]); if (!world) tipV.applyMatrix4(mw); const pp = proj(tipV); qx += pp[0]; qy += pp[1]; }
        }
        mx /= n; my /= n; qx /= n * Math.max(1, J - 2); qy /= n * Math.max(1, J - 2);
        let sxx = 0, syy = 0, sxy = 0;
        for (let i = 0; i < n; i++) { const dx = P[i * 2] - mx, dy = P[i * 2 + 1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); const ca = Math.cos(ang), sa = Math.sin(ang);
        let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
        for (let i = 0; i < n; i++) { const dx = P[i * 2] - mx, dy = P[i * 2 + 1] - my; const pa = dx * ca + dy * sa, pb = -dx * sa + dy * ca; if (pa < a0) a0 = pa; if (pa > a1) a1 = pa; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb; }
        f.tipC = [+mx.toFixed(2), +my.toFixed(2)]; f.mid = [+qx.toFixed(2), +qy.toFixed(2)];
        f.span = [+(x1 - x0).toFixed(1), +(y1 - y0).toFixed(1)];
        f.fanAng = +((((ang * 180 / Math.PI) % 180) + 180) % 180).toFixed(1); f.fanMaj = +(a1 - a0).toFixed(1); f.fanMin = +(b1 - b0).toFixed(1);
      }
      if (dbg && dbg.tipScreen) f.tip = [+dbg.tipScreen[0].toFixed(2), +dbg.tipScreen[1].toFixed(2)];
      else if (b.tipCenter) { const p = proj(b.tipCenter); f.tip = [+p[0].toFixed(2), +p[1].toFixed(2)]; }
      else if (f.tipC) f.tip = f.tipC;
      if (T.a3 && f.painting && f.uv) f.a3 = T.dyeAt(f.uv[0], f.uv[1]);
      return f;
    };
    T.sample = sample;
    let lastT = -1;
    const loop = (t) => {
      wrapRaycaster();
      if (T.rec) T.frames.push(sample(t));
      if (T.ft && lastT >= 0) T.ft.push(t - lastT);
      lastT = t;
      T.evN = 0; T.rcN = 0; T.passes = 0;
      if (T.throttleMs) { while (performance.now() - t < T.throttleMs) { /* slow device */ } }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return true;
  });
}

// ------------------------------------------------------------- analysis --

const maskAt = (m, x, y) => {
  const xi = Math.floor(x - m.x0), yi = Math.floor(y - m.y0);
  if (xi < 0 || yi < 0 || xi >= m.W || yi >= m.H) return -1;
  return m.a[yi * m.W + xi];
};
function coverage(m, thr = 128) {
  let nail = 0, p = 0;
  for (const a of m.a) { if (a < 0) continue; nail++; if (a > thr) p++; }
  return nail ? p / nail : 0;
}
function bbox(m, thr = 128) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) { if (m.a[y * m.W + x] > thr) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return x1 < x0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function linFitResidStd(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const k = sxx ? sxy / sxx : 0; let s = 0;
  for (let i = 0; i < n; i++) { const r = ys[i] - (my + k * (xs[i] - mx)); s += r * r; }
  return Math.sqrt(s / n);
}
// Profiles across a straight stroke p0 -> p1 (screen px). `off` = expected
// band centre offset along the normal (touch nudge).
function band(m, p0, p1, { trim = 12, expect = [0, 0] } = {}) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const widths = [], centres = [], nailW = [], peaks = [], cores = [], e1090 = [], soft = [], edgeA = [], edgeB = [], ts = [];
  let gaps = 0, cols = 0;
  for (let t = trim; t <= len - trim; t += 1) {
    const cx = p0[0] + ux * t + expect[0], cy = p0[1] + uy * t + expect[1];
    const prof = []; for (let s = -110; s <= 110; s++) prof.push(maskAt(m, cx + nx * s, cy + ny * s));
    let nh = 0, first = -1, last = -1, peak = 0;
    for (let i = 0; i < prof.length; i++) { const a = prof[i]; if (a >= 0) nh++; if (a > 128) { if (first < 0) first = i; last = i; } if (a > peak) peak = a; }
    if (!nh) continue;
    cols++; nailW.push(nh); peaks.push(peak);
    if (first < 0) { gaps++; continue; }
    widths.push(last - first + 1); centres.push((first + last) / 2 - 110); cores.push(prof[Math.round((first + last) / 2)]);
    let sr = 0; for (const a of prof) if (a > 0.08 * 255 && a < 0.92 * 255) sr++; soft.push(sr);
    // 10-90 % edges, skipped where the band runs into the nail outline
    const pk = peak;
    const edge = (from, step) => {
      let i10 = -1, i90 = -1, i50 = -1;
      for (let i = from; i >= 0 && i < prof.length; i += step) {
        const a = prof[i]; if (a < 0) { i10 = -1; i50 = -1; continue; }
        if (i10 < 0 && a >= 0.1 * pk) { i10 = i; const back = prof[i - step * 2]; if (back === undefined || back < 0) return null; }
        if (i50 < 0 && a >= 0.5 * pk) i50 = i;
        if (a >= 0.9 * pk) { i90 = i; break; }
      }
      return i10 < 0 || i90 < 0 ? null : { w: Math.abs(i90 - i10), at: i50 };
    };
    const ea = edge(0, 1), eb = edge(prof.length - 1, -1);
    if (ea) { e1090.push(ea.w); edgeA.push([t, ea.at]); }
    if (eb) { e1090.push(eb.w); edgeB.push([t, eb.at]); }
    ts.push(t);
  }
  const wob = [edgeA, edgeB].map((e) => linFitResidStd(e.map((q) => q[0]), e.map((q) => q[1]))).filter((x) => x !== null);
  const cm = mean(cores);
  return {
    widthPx: stats(widths), nailWidthPx: stats(nailW), centreOffPx: stats(centres), gapCols: gaps, cols,
    peak: stats(peaks), coreAlpha: cm === null ? null : r3(cm / 255), coreDevPct: cm ? r1(Math.max(...cores.map((c) => Math.abs(c - cm))) / cm * 100) : null,
    edge1090Px: stats(e1090), softPx: stats(soft), wobblePx: wob.length ? r3(Math.max(...wob)) : null,
    widthFrac: widths.length && nailW.length ? r3(median(widths) / median(nailW)) : null,
  };
}
function distToPolyline(p, pl) {
  let best = Infinity;
  for (let i = 0; i + 1 < pl.length; i++) {
    const a = pl[i], b = pl[i + 1]; const vx = b[0] - a[0], vy = b[1] - a[1]; const L = vx * vx + vy * vy;
    let k = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0; k = Math.max(0, Math.min(1, k));
    best = Math.min(best, Math.hypot(a[0] + vx * k - p[0], a[1] + vy * k - p[1]));
  }
  if (pl.length === 1) best = Math.hypot(pl[0][0] - p[0], pl[0][1] - p[1]);
  return best;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
// axis angles live modulo 180 degrees: mean of doubled-angle unit vectors
function axStats(a) {
  const v = a.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (!v.length) return null;
  let c = 0, s = 0; for (const x of v) { c += Math.cos(x * Math.PI / 90); s += Math.sin(x * Math.PI / 90); }
  const m = ((Math.atan2(s, c) * 90 / Math.PI) + 180) % 180;
  return { n: v.length, mean: r1(m), spread: r1(Math.max(...v.map((x) => angDiff180(x, m)))) };
}
const angDiff180 = (a, b) => { let d = Math.abs(a - b) % 180; return d > 90 ? 180 - d : d; };

// Points the engine consumed: all input samples when the engine walks them (debug
// hook present = B5 engine), else the newest deposit per frame.
function consumedPath(frames, engineWalksSamples) {
  const pts = [];
  for (const f of frames) {
    if (!f.down && !f.painting) continue;
    if (engineWalksSamples && f.samp) { for (let i = 0; i < f.samp.length; i += 3) pts.push([f.samp[i], f.samp[i + 1]]); }
    else if (f.painting && f.dep) pts.push(f.dep);
  }
  return pts;
}
function samplePath(frames) {
  const pts = []; for (const f of frames) if (f.samp) for (let i = 0; i < f.samp.length; i += 3) pts.push([f.samp[i], f.samp[i + 1], f.samp[i + 2]]);
  return pts;
}

function frameStats(frames, kind, info) {
  const p = frames.filter((f) => f.painting && f.dep);
  const d = frames.filter((f) => f.down);
  const dts = []; for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t);
  const steps = []; for (let i = 1; i < p.length; i++) steps.push(Math.hypot(p[i].dep[0] - p[i - 1].dep[0], p[i].dep[1] - p[i - 1].dep[1]));
  const tipDep = p.filter((f) => f.tip).map((f) => Math.hypot(f.tip[0] - f.dep[0], f.tip[1] - f.dep[1]));
  const samplesApi = d.some((f) => f.sc !== undefined);
  // samples used per frame vs pointer events delivered while down
  const used = d.map((f) => (samplesApi ? f.sc : null));
  return {
    frames: frames.length, paintFrames: p.length, dtMs: stats(dts), evPerFrame: stats(d.map((f) => f.ev)),
    samplesPerFrame: samplesApi ? stats(used) : null,
    usedOfExpected: samplesApi ? r3(d.reduce((a, f) => a + (f.sc || 0), 0) / Math.max(1, d.reduce((a, f) => a + Math.min(f.ev, info.cap) + (f.samp ? f.samp.filter((_, i) => i % 3 === 2 && f.samp[i] === 1).length : 0), 0))) : null,
    stepPx: stats(steps), tipToDepPx: stats(tipDep),
    tipMinusDep: p.length && p[0].tip ? [stats(p.map((f) => f.tip[0] - f.dep[0])), stats(p.map((f) => f.tip[1] - f.dep[1]))] : null,
    depMinusPtr: p.length ? [stats(p.map((f) => f.dep[0] - f.px)), stats(p.map((f) => f.dep[1] - f.py))] : null,
    fanMajPx: stats(p.map((f) => f.fanMaj)), fanAng: axStats(p.map((f) => f.fanAng)), span: p.length && p[0].span ? [stats(p.map((f) => f.span[0])), stats(p.map((f) => f.span[1]))] : null,
    raycastsMax: Math.max(0, ...frames.map((f) => f.rc)), raycasts: stats(frames.map((f) => f.rc)),
    passes: stats(p.map((f) => f.passes)),
    camMove: frames.length ? +Math.max(...frames.map((f) => Math.hypot(f.cam[0] - frames[0].cam[0], f.cam[1] - frames[0].cam[1], f.cam[2] - frames[0].cam[2]))).toFixed(5) : 0,
    load: frames.length ? [r3(frames[0].load), r3(frames[frames.length - 1].load)] : null,
    inputStarts: samplesApi ? frames.filter((f) => f.ss).length : null,
    inputEnds: samplesApi ? frames.filter((f) => f.se).length : null,
    edgeSamples: samplesApi ? samplePath(frames).filter((q) => q[2] === 1).length : null,
  };
}

// --------------------------------------------------------------- a combo --

async function runCombo(tier, kind) {
  const tag = `${tier}-${kind}`;
  const s = await boot(tier, kind);
  const { page } = s;
  await sleep(6000); // intro stripe and zoom settle
  await install(page);
  const info = await page.evaluate(() => __T.info());
  const box = await page.evaluate(() => __T.box());
  if (!box) throw new Error('nail not found on screen');
  const mapInfo = await page.evaluate((b) => __T.buildMap(b), box);
  const w = box.x1 - box.x0, h = box.y1 - box.y0, cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const clip = { x: Math.max(0, box.x0 - 110), y: Math.max(0, box.y0 - 150), width: w + 220, height: h + 260 };
  const L = box.x0 + 0.12 * w, R = box.x1 - 0.12 * w;
  const nudge = kind === 'touch' ? NUDGE : 0;
  const engineWalksSamples = !!info.debugHook;
  const res = { tag, tier, kind, info, box, mapInfo, strokes: {}, errors: s.errors };
  const emit = (name, o) => { res.strokes[name] = o; console.log(JSON.stringify({ combo: tag, stroke: name, ...o })); };

  // nail size on screen (px) from the map: width across the finger (vertical on
  // screen: cuticle right, tip left), length along it
  const mask0 = await page.evaluate(() => __T.mask());
  const colN = (x) => { let n = 0; for (let y = 0; y < mask0.H; y++) if (maskAt(mask0, x, mask0.y0 + y) >= 0) n++; return n; };
  const rowN = (y) => { let n = 0; for (let x = 0; x < mask0.W; x++) if (maskAt(mask0, mask0.x0 + x, y) >= 0) n++; return n; };
  const nailW = colN(cx), nailL = rowN(cy);
  res.nailWidthPx = nailW; res.nailLengthPx = nailL;

  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), clip }); };
  const clear = async () => {
    await page.evaluate(() => __T.clear());
    if (kind === 'mouse') await s.input.hover(box.x1 + 150, box.y0 - 120);
    await sleep(450);
  };
  const rec = async (on) => page.evaluate((v) => { if (v) { __T.frames = []; __T.events = []; } __T.rec = v; }, on);
  const frames = () => page.evaluate(() => __T.frames);
  const counters = () => page.evaluate(() => ({ covered: __T.covered, engineStarts: __T.engineStarts }));

  async function run(name, pts, dur, opts = {}) {
    if (!opts.keep) await clear();
    if (opts.fps) await page.evaluate((ms) => { __T.throttleMs = ms; }, 1000 / opts.fps);
    if (opts.a3) await page.evaluate(() => { __T.a3 = true; });
    const c0 = await counters();
    await rec(true);
    await sleep(120);
    await stroke(s, pts, dur, opts);
    await sleep(150);
    await rec(false);
    await page.evaluate(() => { __T.throttleMs = 0; __T.a3 = false; });
    const fr = await frames();
    const c1 = await counters();
    const out = { pts, dur, ...frameStats(fr, kind, info), engineStarts: c1.engineStarts - c0.engineStarts, coveredFired: c1.covered - c0.covered };
    // Time-critical reads first (the film levels within a second; a SwiftShader
    // screenshot alone can take that long).
    if (opts.film) { const fm = await page.evaluate(() => __T.film()); out.film0 = fm; }
    if (opts.atLift) out.atLift = await opts.atLift();
    await shot(`${name}-wet`);
    const m = await page.evaluate(() => __T.mask());
    out.cov = r3(coverage(m)); out.appCov = r3(m.appCov);
    if (opts.settle) {
      await sleep(opts.settleMs || 2500);
      await shot(`${name}-settled`);
      const m1 = await page.evaluate(() => __T.mask());
      let diff = 0, n = 0, changed = 0;
      for (let i = 0; i < m.a.length; i++) { if (m.a[i] < 0) continue; n++; const d = Math.abs(m.a[i] - m1.a[i]); diff += d; if (d > 8) changed++; }
      out.settleMeanAbsPct = r3(diff / n / 255 * 100); out.settleChangedPct = r3(changed / n * 100);
    }
    out._frames = fr; out._mask = m;
    return out;
  }
  const strip = (o) => { const c = { ...o }; delete c._frames; delete c._mask; delete c.film0; return c; };

  // hover sweep (mouse): brush vs pointer, rig size
  if (kind === 'mouse') {
    await clear();
    await rec(true);
    for (let i = 0; i <= 30; i++) { await s.input.hover(R + (L - R) * i / 30, cy); await sleep(30); }
    await sleep(200);
    await rec(false);
    const fr = await frames();
    const f = fr.filter((x) => x.dep);
    const rig = await page.evaluate(() => __T.rigScreen());
    await shot('hover');
    emit('hover', { frames: fr.length, onNail: f.length, hoverFlag: f.filter((x) => x.hover).length, tipMinusPtr: f.length && f[0].tip ? [stats(f.map((x) => x.tip[0] - x.px)), stats(f.map((x) => x.tip[1] - x.py))] : null, depMinusPtr: stats(f.map((x) => Math.hypot(x.dep[0] - x.px, x.dep[1] - x.py))), fanMajPx: stats(f.map((x) => x.fanMaj)), rig });
    res.rig = rig;
    res.hover = { onNail: f.length, hoverFlag: f.filter((x) => x.hover).length };
  }

  const exp = [0, -nudge];
  const S = {};
  const straight = async (name, p0, p1, dur, opts = {}) => {
    const o = await run(name, [p0, p1], dur, opts);
    o.band = band(o._mask, p0, p1, { expect: exp });
    S[name] = o; emit(name, strip(o));
    return o;
  };
  await straight('c2t-slow', [R, cy], [L, cy], 1600, { settle: true, film: true });
  await straight('c2t-med', [R, cy], [L, cy], 450, { settle: true, film: true });
  await straight('c2t-fast', [R, cy], [L, cy], 110);
  await straight('t2c-med', [L, cy], [R, cy], 450);
  await straight('side-med', [cx, box.y0 + 0.12 * h], [cx, box.y1 - 0.12 * h], 400);
  await straight('side-up-med', [cx, box.y1 - 0.12 * h], [cx, box.y0 + 0.12 * h], 400);
  // A3: same-frame readback of the dye at the newest deposit
  { const o = await run('a3', [[R, cy], [L, cy]], 450, { a3: true }); const v = o._frames.filter((f) => f.a3 !== undefined); o.a3 = { frames: v.length, over50: v.filter((f) => f.a3 > 128).length, min: v.length ? Math.min(...v.map((f) => f.a3)) : null }; S.a3 = o; emit('a3', strip(o)); }
  // second pass on the same line (A18)
  { const o = await run('pass2', [[R, cy], [L, cy]], 450, { keep: true }); o.band = band(o._mask, [R, cy], [L, cy], { expect: exp }); S.pass2 = o; emit('pass2', strip(o)); await shot('pass2'); }
  // A19 streaks: fresh stroke and 1.5 s later, luminance rows across the band
  {
    await clear();
    // the band's half width is known from the c2t strokes (same stroke)
    const bw = S['c2t-med'] && S['c2t-med'].band && S['c2t-med'].band.widthPx ? S['c2t-med'].band.widthPx.med : 20;
    const half = bw / 2;
    const region = { x0: L + 20, x1: R - 20, y0: cy - nudge - half * 0.8, y1: cy - nudge + half * 0.8 };
    const count = async () => {
      const buf = await page.screenshot({ clip: { x: Math.floor(region.x0), y: Math.floor(region.y0), width: Math.max(4, Math.ceil(region.x1 - region.x0)), height: Math.max(4, Math.ceil(region.y1 - region.y0)) } });
      return page.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; const rows = [];
        for (let y = 0; y < c.height; y++) { let s = 0; for (let x = 0; x < c.width; x++) { const k = (y * c.width + x) * 4; s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; } rows.push(s / c.width); }
        // detrend (7-row box) and count separated peaks > 1.5 levels
        const sm = rows.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) { s += rows[j]; n++; } return s / n; });
        const res = rows.map((v, i) => v - sm[i]); let peaks = 0, lastP = -9;
        for (let i = 1; i + 1 < res.length; i++) if (res[i] > 1.5 && res[i] >= res[i - 1] && res[i] >= res[i + 1] && i - lastP >= 2) { peaks++; lastP = i; }
        return { rows: rows.length, peaks, maxResid: +Math.max(...res).toFixed(2) };
      }, buf.toString('base64'));
    };
    const o = await run('streaks', [[R, cy], [L, cy]], 450, { keep: true, atLift: () => count() });
    const wet = o.atLift;
    await sleep(1500);
    const dry = await count();
    o.streaks = { wet, settled: dry };
    S.streaks = o; emit('streaks', strip(o));
  }
  await run('tap', [[cx, cy]], 60, { hold: 20 }).then((o) => { o.print = bbox(o._mask); S.tap = o; emit('tap', strip(o)); });
  await shot('tap');
  await run('hold', [[cx, cy]], 1000).then((o) => { o.print = bbox(o._mask); S.hold = o; emit('hold', strip(o)); });
  await run('off-start', [[box.x1 + 70, cy], [L, cy]], 600).then((o) => { S['off-start'] = o; emit('off-start', strip(o)); });
  await run('off-end', [[R, cy], [box.x0 - 70, cy]], 600).then((o) => { S['off-end'] = o; emit('off-end', strip(o)); });
  // leave the nail over its side edge and come back, one press (A12)
  {
    const pts = [[box.x1 - 0.3 * w, cy], [cx, box.y0 - 45], [box.x0 + 0.3 * w, cy]];
    const o = await run('leave-return', pts, 700);
    // walk the expected deposit path at 1 px, find on-nail runs and their paint
    // expected paint point: nudged, or the raw contact point when only that is on the nail
    const { at: atRaw, total } = polyline(pts);
    const at = (f) => { const p = atRaw(f); if (!nudge) return p; const q = [p[0], p[1] - nudge]; return maskAt(o._mask, q[0], q[1]) < 0 && maskAt(o._mask, p[0], p[1]) >= 0 ? p : q; };
    const runs = []; let cur = null;
    for (let d = 0; d <= total; d += 1) {
      const p = at(d / total); const a = maskAt(o._mask, p[0], p[1]);
      if (a >= 0) { if (!cur) { cur = { from: d, n: 0, painted: 0, firstPaint: null, lastPaint: null, to: d }; runs.push(cur); } cur.n++; cur.to = d; if (a > 128) { cur.painted++; if (cur.firstPaint === null) cur.firstPaint = d; cur.lastPaint = d; } }
      else cur = null;
    }
    o.runs = runs.map((q) => ({ len: q.n, paintedFrac: r3(q.painted / q.n), gapAtStartPx: q.firstPaint === null ? q.n : q.firstPaint - q.from, gapAtEndPx: q.lastPaint === null ? q.n : q.to - q.lastPaint }));
    // input edge samples vs the true boundary crossings
    const sp = samplePath(o._frames).filter((q) => q[2] === 1);
    const bounds = []; for (let i = 0; i < runs.length; i++) { if (i > 0 || runs[i].from > 0) bounds.push(at(runs[i].from / total)); if (runs[i].to < Math.floor(total)) bounds.push(at(runs[i].to / total)); }
    o.edgeErrPx = sp.length ? r1(Math.max(...sp.map((q) => Math.min(...bounds.map((b) => Math.hypot(b[0] - q[0], b[1] - q[1])))))) : null;
    o.boundaries = bounds.length;
    S['leave-return'] = o; emit('leave-return', strip(o));
    await shot('leave-return');
  }
  await run('diag-through', [[box.x1 + 30, box.y0 - 30], [box.x0 - 30, box.y1 + 30]], 500).then((o) => { S['diag-through'] = o; emit('diag-through', strip(o)); });
  // fast zig-zag: 8 turns in 600 ms, native frame rate and 20 fps (A4, B1)
  const zig = []; for (let i = 0; i <= 8; i++) zig.push([R + (L - R) * i / 8, i % 2 ? box.y0 + 0.15 * h : box.y1 - 0.15 * h]);
  for (const fps of [null, 20]) {
    const name = fps ? 'zig-fast-20fps' : 'zig-fast';
    const o = await run(name, zig, 600, { fps, settle: !fps });
    const truth = zig.map((p) => [p[0], p[1] - nudge]);
    const consumed = consumedPath(o._frames, engineWalksSamples);
    const corners = truth.slice(1, -1);
    o.consumedPts = consumed.length;
    o.cornerErrPx = consumed.length > 1 ? r1(Math.max(...corners.map((c) => distToPolyline(c, consumed)))) : null;
    const smp = samplePath(o._frames);
    o.samplePts = smp.length || null;
    o.sampleOffPathPx = smp.length ? r1(Math.max(...smp.map((q) => distToPolyline(q, truth)))) : null;
    o.sampleCornerErrPx = smp.length > 1 ? r1(Math.max(...corners.map((c) => distToPolyline(c, smp)))) : null;
    // against what the browser actually delivered (120 Hz input cuts corners by itself)
    const evRaw = (await page.evaluate(() => __T.events)).filter((e) => e[1] === 'c');
    const evs = evRaw.map((e) => [e[3], e[4] - nudge]);
    // each delivered event belongs to the first frame at or after it; in frames
    // with no more events than the cap, every event must be a sample
    const fr = o._frames; let k = 0; const kept = [];
    for (const e of evRaw) { while (k < fr.length && fr[k].t < e[0]) k++; if (k < fr.length && fr[k].ev <= info.cap && maskAt(o._mask, e[3], e[4] - nudge) >= 0) kept.push([e[3], e[4] - nudge]); }
    o.underCapEvents = kept.length;
    o.underCapErrPx = smp.length > 1 && kept.length ? r1(Math.max(...kept.map((p) => distToPolyline(p, smp)))) : null;
    const onNail = evs.filter((p) => maskAt(o._mask, p[0], p[1]) >= 0);
    o.deliveredPts = evs.length;
    o.eventCornerErrPx = evs.length > 1 ? r1(Math.max(...corners.map((c) => distToPolyline(c, evs)))) : null;
    o.sampleVsEventsPx = smp.length > 1 && onNail.length ? r1(Math.max(...onNail.map((p) => distToPolyline(p, smp)))) : null;
    // gap columns between the first and last painted x of the zig-zag
    let gaps = 0, cols = 0;
    for (let x = Math.ceil(L + 12); x <= R - 12; x++) { let nh = 0, pa = 0; for (let y = 0; y < o._mask.H; y++) { const a = maskAt(o._mask, x, o._mask.y0 + y); if (a >= 0) nh++; if (a > 128) pa++; } if (nh) { cols++; if (!pa) gaps++; } }
    o.gapCols = gaps; o.gapColsOf = cols;
    S[name] = o; emit(name, strip(o));
  }
  // c2t at 20 fps: are all samples used?
  await run('c2t-med-20fps', [[R, cy], [L, cy]], 450, { fps: 20 }).then((o) => { S['c2t-med-20fps'] = o; emit('c2t-med-20fps', strip(o)); });
  // three strokes: centre, +28 %, -28 % of the nail width (no clear in between)
  {
    const off = 0.28 * nailW;
    await clear();
    const c0 = await counters();
    const a = await run('three-1', [[R, cy], [L, cy]], 500, { keep: true }); S['three-1'] = a; emit('three-1', strip(a));
    const b = await run('three-2', [[R, cy - off], [L, cy - off]], 500, { keep: true }); S['three-2'] = b; emit('three-2', strip(b));
    const c = await run('three-3', [[R, cy + off], [L, cy + off]], 500, { keep: true, settle: true }); S['three-3'] = c;
    c.coveredAfterThree = (await counters()).covered - c0.covered; emit('three-3', strip(c));
  }
  // 12-stroke scrub
  if (!QUICK) {
    await clear();
    const covs = [];
    for (let n = 0; n < 12; n++) { const yy = box.y0 + h * (0.1 + 0.8 * ((n * 0.37) % 1)); await stroke(s, [[R, yy], [L, yy]], 350); await sleep(60); covs.push(await page.evaluate(() => [+app.polishBrush3D.getCoverage().toFixed(3), +(app.polishBrush3D.debug ? app.polishBrush3D.debug.load : app.polishBrush3D.bristleSystem.load).toFixed(2)])); }
    const m = await page.evaluate(() => __T.mask());
    S.scrub12 = { scrub: covs, cov: r3(coverage(m)), appCov: covs[covs.length - 1][0] }; emit('scrub12', S.scrub12);
    await shot('scrub12');
  }
  // Load (A10): dry out by scrubbing along the centre line without lifting, clear
  // the paint mid-press, then lay one c2t pass and compare it with a loaded pass.
  async function dryTest(nl) {
    await clear();
    const travel = nl * nailL; const seg = R - L; const n = Math.max(1, Math.round(travel / seg));
    const pts = []; for (let i = 0; i <= n; i++) pts.push([i % 2 ? L : R, cy]);
    await rec(true);
    const end = await stroke(s, pts, n * seg / 0.7, { noUp: true }); // 700 px/s
    // back to the cuticle side, still pressed
    if (Math.abs(end[0] - R) > 1) await stroke(s, [end, [R, cy]], 250, { noUp: true, skipDown: true });
    await page.evaluate(() => app.polishBrush3D.clearNail());
    await sleep(80);
    await stroke(s, [[R, cy], [L, cy]], 450, { skipDown: true });
    await sleep(150);
    await rec(false);
    const fr = await frames();
    const m = await page.evaluate(() => __T.mask());
    const bd = band(m, [R, cy], [L, cy], { expect: exp });
    await sleep(500);
    const after = await page.evaluate(() => (app.polishBrush3D.debug ? app.polishBrush3D.debug.load : app.polishBrush3D.bristleSystem.load));
    // travel along the way, from the deposit path
    let tr = 0; const tw = []; let last = null;
    for (const f of fr) { if (!f.painting || !f.dep) { last = null; continue; } if (last) tr += Math.hypot(f.dep[0] - last[0], f.dep[1] - last[1]); last = f.dep; tw.push([r3(tr / nailL), r3(f.load), f.hwPx, f.dry]); }
    if (SHOTS && nl > 3) await shot(`dry-${nl}`);
    return { nl, cov: r3(coverage(m)), widthPx: bd.widthPx ? bd.widthPx.med : null, coreAlpha: bd.coreAlpha, loadAtEnd: tw.length ? tw[tw.length - 1][1] : null, loadAfter500ms: r3(after), trace: tw.filter((_, i) => i % 6 === 0) };
  }
  if (!QUICK) {
    S.dry = { d14: await dryTest(1.4), d26: await dryTest(2.6), d50: await dryTest(5) };
    const tr = S.dry.d50.trace.filter((q) => q[2] !== null);
    const hw0 = tr.length ? Math.max(...tr.map((q) => q[2])) : null;
    S.dry.widthDropAtNL = hw0 ? (tr.find((q) => q[2] < 0.97 * hw0) || [null])[0] : null;
    emit('dry', { ...S.dry, d14: { ...S.dry.d14, trace: undefined }, d26: { ...S.dry.d26, trace: undefined }, d50: { ...S.dry.d50, trace: S.dry.d50.trace.slice(0, 40) } });
  }
  // Pose (A11): an L-shaped stroke (left, then down) and 4 straight directions with
  // a screenshot mid-motion.
  {
    const p0 = [R, box.y0 + 0.3 * h], p1 = [cx - 0.05 * w, box.y0 + 0.3 * h], p2 = [cx - 0.05 * w, box.y1 - 0.15 * h];
    const o = await run('turn', [p0, p1, p2], 700);
    const fr = o._frames.filter((f) => f.painting && f.dep && f.fanAng !== undefined);
    // the turn frame: first frame whose deposit is past the corner
    let turnT = null; for (const f of fr) { if (f.dep[1] > p1[1] - nudge + 2) { turnT = f.t; break; } }
    const angAt = (dt) => { const f = fr.find((q) => q.t >= turnT + dt); return f ? f.fanAng : null; };
    const before = fr.filter((f) => turnT !== null && f.t < turnT - 50 && f.t > fr[0].t + 120).map((f) => f.fanAng);
    o.axisBeforeTurn = axStats(before);
    o.axisErrBeforeDeg = before.length ? r1(Math.max(...before.map((a) => angDiff180(a, 90)))) : null;
    o.axisAt120msDeg = turnT !== null ? r1(angAt(120)) : null;
    o.axisErrAt120msDeg = o.axisAt120msDeg !== null ? r1(angDiff180(o.axisAt120msDeg, 0)) : null;
    S.turn = o; emit('turn', strip(o));
  }
  const dirs = { left: [[R, cy], [L + 0.2 * w, cy]], right: [[L, cy], [R - 0.2 * w, cy]], down: [[cx, box.y0 + 0.12 * h], [cx, box.y1 - 0.25 * h]], up: [[cx, box.y1 - 0.12 * h], [cx, box.y0 + 0.25 * h]] };
  S.pose = {};
  for (const [dn, pts] of Object.entries(dirs)) {
    await clear();
    await rec(true);
    await stroke(s, pts, 500, { hold: 150, mid: { at: 0.6, fn: () => shot(`pose-${dn}`) } });
    await sleep(100);
    await rec(false);
    const fr = await frames();
    const d = sub(pts[1], pts[0]); const dl = Math.hypot(d[0], d[1]); const u = [d[0] / dl, d[1] / dl];
    const pressed = fr.filter((f) => f.painting && f.mid && f.tipC);
    const rest = pressed.filter((f) => Math.hypot(f.px - pts[0][0], f.py - pts[0][1]) < 0.5);
    const moving = pressed.filter((f) => Math.hypot(f.px - pts[0][0], f.py - pts[0][1]) > 15 && Math.hypot(f.px - pts[1][0], f.py - pts[1][1]) > 5);
    const trailOf = (f) => (f.mid[0] - f.tipC[0]) * u[0] + (f.mid[1] - f.tipC[1]) * u[1];
    const restT = mean(rest.map(trailOf)), movT = mean(moving.map(trailOf));
    S.pose[dn] = { trailPx: restT !== null && movT !== null ? r1(movT - restT) : null, fanAng: axStats(moving.map((f) => f.fanAng)), axisDbg: axStats(moving.map((f) => f.axisDbg)), tipToDep: stats(moving.filter((f) => f.dep && f.tip).map((f) => Math.hypot(f.tip[0] - f.dep[0], f.tip[1] - f.dep[1]))) };
  }
  emit('pose', S.pose);
  // second finger (touch): finger 2 lands on the nail mid-stroke and moves
  if (kind === 'touch') {
    const o = await run('second-finger', [[R, cy], [L, cy]], 700, { second: { from: 0.3, to: 0.75, pts: [[cx, box.y1 - 0.1 * h], [R, box.y1 - 0.1 * h]] } });
    const truth = [[R, cy - nudge], [L, cy - nudge]];
    const p = o._frames.filter((f) => f.painting && f.dep);
    o.depOffPathPx = p.length ? r1(Math.max(...p.map((f) => distToPolyline(f.dep, truth)))) : null;
    o.depVsFinger1Px = p.length ? r1(Math.max(...p.map((f) => Math.abs(f.dep[0] - f.px)))) : null;
    S['second-finger'] = o; emit('second-finger', strip(o));
  }
  // A9 relief levelling and A17 idle passes: one stroke, then watch 6 s
  {
    await clear();
    const o = await run('level', [[R, cy], [L, cy]], 450, { keep: true, film: true });
    const rms = (fm) => { if (!fm) return null; let s2 = 0, n = 0; for (const a of fm.a) { if (a < 0) continue; s2 += (a / 255) ** 2; n++; } return n ? Math.sqrt(s2 / n) : null; };
    const f0 = o.film0; await sleep(1050);
    const f1 = await page.evaluate(() => __T.film());
    await sleep(4800);
    await rec(true); await sleep(1000); await rec(false);
    const idle = await frames();
    const f2 = await page.evaluate(() => __T.film());
    o.relief = f0 ? { rms0: r3(rms(f0)), rms12: r3(rms(f1)), dropPct: rms(f0) ? r1((1 - rms(f1) / rms(f0)) * 100) : null, awakeAfter6s: f2 ? f2.awake : null } : null;
    o.idlePasses = stats(idle.map((f) => f.passes));
    o.paintPasses = stats(o._frames.filter((f) => f.painting).map((f) => f.passes));
    S.level = o; emit('level', strip(o));
  }
  // perf (A14, A15, A16): idle vs painting, mouse runs only
  if (PERF && kind === 'mouse') {
    const ft = async (ms, paint) => {
      await page.evaluate(() => { __T.ft = []; });
      if (paint) {
        const t0 = Date.now(); const pend = []; let i = 0;
        await s.input.hover(cx, cy - 0.35 * h); await s.input.down(cx, cy - 0.35 * h);
        while (Date.now() - t0 < ms) { const a = i * 0.06; pend.push(s.input.move(cx + Math.sin(a) * 0.35 * w, cy + Math.cos(a * 0.7) * 0.35 * h)); i++; await sleep(1000 / 60); }
        await Promise.all(pend); await s.input.up(cx, cy);
      } else await sleep(ms);
      const a = (await page.evaluate(() => { const v = __T.ft; __T.ft = null; return v; })).slice(2).sort((x, y) => x - y);
      const avg = a.reduce((x, y) => x + y, 0) / a.length;
      return { frames: a.length, avgMs: r1(avg), p95Ms: r1(a[Math.floor(a.length * 0.95)]) };
    };
    const rinfo = () => page.evaluate(() => { const r = app.scene.renderer; return { programs: r.info.programs ? r.info.programs.length : null, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(2) : null }; });
    await clear();
    const idle = await ft(3000, false);
    const before = await rinfo();
    const painting = await ft(6000, true);
    const after = await rinfo();
    S.perf = { idle, painting, deltaMs: r1(painting.avgMs - idle.avgMs), p95OverAvg: r3(painting.p95Ms / painting.avgMs), heapGrowthMB: before.heapMB !== null ? r3(after.heapMB - before.heapMB) : null, programsBefore: before.programs, programsAfter: after.programs };
    emit('perf', S.perf);
  }
  await s.browser.close();
  res.external = [...s.external];
  for (const k of Object.keys(S)) { if (S[k] && S[k]._frames) S[k] = strip(S[k]); }
  res.S = S;
  fs.writeFileSync(path.join(OUT, `result-${tag}.json`), JSON.stringify(res, null, 1));
  return res;
}

// ------------------------------------------------------- lines (sect. 6) --

function lines(res) {
  const S = res.S, kind = res.kind, tier = res.tier, info = res.info;
  const L = [];
  const add = (id, measure, value, pass, target) => L.push({ id, measure, value, pass, target });
  const dirs4 = ['c2t-med', 't2c-med', 'side-med', 'side-up-med'];
  // A1
  const td = dirs4.map((k) => S[k].tipToDepPx).filter(Boolean);
  const a1m = td.length ? r1(td.reduce((a, s) => a + s.mean * s.n, 0) / td.reduce((a, s) => a + s.n, 0)) : null;
  const a1x = td.length ? Math.max(...td.map((s) => s.max)) : null;
  add('A1', 'tip centroid to paint point (px)', `mean ${a1m} max ${a1x}`, a1m !== null && a1m <= 3 && a1x <= 6, 'mean <= 3, max <= 6');
  // A2
  const dp = dirs4.map((k) => S[k].depMinusPtr).filter(Boolean);
  if (kind === 'mouse') {
    const mx = Math.max(...dp.map((d) => Math.max(Math.abs(d[0].max), Math.abs(d[0].min), Math.abs(d[1].max), Math.abs(d[1].min))));
    add('A2', 'paint point to pointer, mouse (px)', `max ${r1(mx)}`, mx <= 1, '0');
  } else {
    const ys = dp.map((d) => d[1]);
    const lo = Math.min(...ys.map((s) => -s.max)), hi = Math.max(...ys.map((s) => -s.min));
    add('A2', 'paint above finger, touch (px)', `${r1(lo)}..${r1(hi)}`, lo >= 11 && hi <= 13, '12 +/- 1, constant');
  }
  // A3
  const a3 = S.a3.a3; add('A3', 'frames with dye < 0.5 at the newest deposit', `${a3.frames - a3.over50} of ${a3.frames}`, a3.frames > 0 && a3.over50 === a3.frames, '0');
  // A4
  const z60 = S['zig-fast'], z20 = S['zig-fast-20fps'];
  add('A4', 'zig-zag gap cols / corner error px (60, 20 fps)', `${z60.gapCols}/${z60.cornerErrPx}, ${z20.gapCols}/${z20.cornerErrPx}`, z60.gapCols === 0 && z20.gapCols === 0 && z60.cornerErrPx <= 4 && z20.cornerErrPx <= 4, 'no gaps; <= 4 px');
  // A5
  const b = S['c2t-med'].band; const fan = S['c2t-med'].fanMajPx ? S['c2t-med'].fanMajPx.med : null; const bw = b.widthPx ? b.widthPx.med : null;
  add('A5', 'band / nail width; fan / band', `${r1(b.widthFrac * 100)}%; ${fan && bw ? r3(fan / bw) : null}`, b.widthFrac >= 0.31 && b.widthFrac <= 0.37 && fan && bw && Math.abs(fan / bw - 1) <= 0.1, '34% +/- 3; 1 +/- 0.1');
  // A6
  const c1 = S['three-1'].cov, c3 = S['three-3'].cov, fired = S['three-3'].coveredAfterThree;
  add('A6', 'coverage one / three strokes; nail:covered', `${r1(c1 * 100)}% / ${r1(c3 * 100)}%; ${fired ? 'fired' : 'no'}`, c1 >= 0.3 && c3 >= 0.9 && fired > 0, '>= 30% / >= 90%, fires');
  // A7
  const tap = S.tap.cov, hold = S.hold.cov;
  add('A7', 'tap print / hold 1 s', `${r1(tap * 100)}% / x${tap ? r3(hold / tap) : null}`, tap >= 0.03 && hold >= 1.25 * tap, '>= 3% / grows >= 25%');
  // A8
  const es = S['c2t-slow'].band.edge1090Px, ef = S['c2t-fast'].band.edge1090Px;
  const wob = [S['c2t-slow'].band.wobblePx, S['c2t-fast'].band.wobblePx];
  add('A8', 'edge 10-90% px slow / fast (wobble px)', `${es ? es.med : null} / ${ef ? ef.med : null} (${wob.join(', ')})`, es && ef && es.med <= 3 && ef.med <= 3 && wob.every((x) => x !== null && x >= 0.25 && x <= 2.5), '<= 3 both, small wobble');
  // A9
  if (tier === 'low') add('A9', 'relief (low tier skips it)', 'n/a', true, 'n/a on low');
  else { const rl = S.level.relief; add('A9', 'relief RMS at lift -> 1.2 s, awake after 6 s', rl ? `${rl.rms0} -> ${rl.rms12} (-${rl.dropPct}%), ${rl.awakeAfter6s}` : 'no film', !!rl && rl.rms0 > 0.01 && rl.dropPct >= 80 && rl.awakeAfter6s === false, 'ridges; -80% in 1.2 s; asleep'); }
  // A10
  if (S.dry) {
    const d = S.dry; const w14 = d.d14.widthPx && S['c2t-med'].band.widthPx ? d.d14.widthPx / S['c2t-med'].band.widthPx.med : null;
    const w26 = d.d26.widthPx && S['c2t-med'].band.widthPx ? d.d26.widthPx / S['c2t-med'].band.widthPx.med : null;
    const a26 = d.d26.coreAlpha && S['c2t-med'].band.coreAlpha ? d.d26.coreAlpha / S['c2t-med'].band.coreAlpha : null;
    const covR = S['c2t-med'].cov ? d.d50.cov / S['c2t-med'].cov : null;
    const refill = d.d50.loadAfter500ms;
    const pass = w14 !== null && w14 >= 0.97 && ((w26 !== null && w26 <= 0.92) || (a26 !== null && a26 <= 0.9)) && covR >= 0.5 && refill >= 0.99;
    add('A10', 'width at 1.4 NL; width/alpha at 2.6 NL; dry cov; load 0.5 s after lift', `${r3(w14)}; ${r3(w26)}/${r3(a26)}; ${r3(covR)}; ${refill}`, pass, '>= 0.97; <= 0.92 or <= 0.9; >= 0.5; 1');
  } else add('A10', 'load', 'skipped (--quick)', null, '');
  // A11
  const tr = S.turn; const trails = Object.values(S.pose).map((p) => p.trailPx);
  add('A11', 'axis err 120 ms after turn (deg); trail px L/R/D/U', `${tr.axisErrAt120msDeg}; ${trails.join('/')}`, tr.axisErrAt120msDeg !== null && tr.axisErrAt120msDeg <= 15 && trails.every((t) => t !== null && t < -1), '<= 15; all < -1 (behind)');
  // A12
  const lr = S['leave-return'];
  const both = lr.runs.length >= 2 && lr.runs.every((q) => q.paintedFrac >= 0.9);
  const edgeGap = lr.runs.length >= 2 ? Math.max(lr.runs[0].gapAtEndPx, lr.runs[lr.runs.length - 1].gapAtStartPx) : null;
  add('A12', 'leave+return: painted parts, gap at exit/entry px, engine strokes', `${lr.runs.map((q) => q.paintedFrac).join('/')}, ${edgeGap}, ${lr.engineStarts}`, both && edgeGap <= 4 && lr.engineStarts === 1, 'both >= 0.9, <= 4, 1');
  // A13
  const cam = Math.max(...Object.values(S).filter((o) => o && o.camMove !== undefined).map((o) => o.camMove));
  const sf = S['second-finger'];
  add('A13', 'camera move (units); second finger deviation px', `${cam}; ${sf ? sf.depOffPathPx : 'n/a'}`, cam <= 0.001 && (!sf || sf.depOffPathPx <= 2), '0; ignored');
  // A14 / A15 / A16
  if (S.perf) {
    if (tier === 'low') add('A14', 'perf low: painting vs idle (ms), p95/avg', `+${S.perf.deltaMs} (${S.perf.idle.avgMs} -> ${S.perf.painting.avgMs}), ${S.perf.p95OverAvg}`, S.perf.deltaMs <= 8 && S.perf.p95OverAvg <= 1.6, '<= +8 ms; <= 1.6');
    else add('A15', 'perf high: painting avg (ms)', `${S.perf.painting.avgMs}`, S.perf.painting.avgMs <= 85, '<= 85');
    add('A16', 'heap growth MB over 6 s painting; programs', `${S.perf.heapGrowthMB}; ${S.perf.programsBefore} -> ${S.perf.programsAfter}`, S.perf.heapGrowthMB !== null && S.perf.heapGrowthMB <= 2 && S.perf.programsAfter === S.perf.programsBefore, '<= 2 MB; no new');
  }
  // A17
  const lv = S.level; const want = tier === 'low' ? 1 : 3;
  add('A17', 'off-screen passes per frame painting / idle', `${lv.paintPasses ? lv.paintPasses.med : null} / ${lv.idlePasses ? lv.idlePasses.max : null}`, lv.paintPasses && lv.paintPasses.med <= want && lv.idlePasses && lv.idlePasses.max === 0, `<= ${want} / 0`);
  // A18
  const p1 = S['c2t-med'].band, p2 = S.pass2.band;
  add('A18', 'core alpha one / two passes; centreline dev %', `${p1.coreAlpha} / ${p2.coreAlpha}; ${p1.coreDevPct}`, p1.coreAlpha >= 0.55 && p1.coreAlpha <= 0.7 && p2.coreAlpha >= 0.85 && p1.coreDevPct <= 4, '0.55-0.70 / >= 0.85; <= 4');
  // A19
  if (tier === 'low') add('A19', 'wet streaks (low tier skips them)', 'n/a', true, 'n/a on low');
  else { const st = S.streaks.streaks; add('A19', 'highlight lines fresh / 1.5 s', `${st.wet.peaks} / ${st.settled.peaks}`, st.wet.peaks >= 8 && st.settled.peaks <= 1, '>= 8 / none'); }
  add('A20', 'eyes: screenshot set', `${OUT}/${res.tag}-*.png`, null, 'Fable review');

  // ---- B1 acceptance
  const api = info.input && info.input.samplesApi;
  const cap = info.cap;
  const nat = S['c2t-slow'], s20 = S['c2t-med-20fps'];
  add('B1.samples', 'samples/frame at native fps (events/frame); used of expected at 20 fps', api ? `${nat.samplesPerFrame.mean} (${nat.evPerFrame.mean}) @${nat.dtMs.med} ms; ${s20.usedOfExpected} (${s20.evPerFrame.mean} ev/f)` : `1 (${nat.evPerFrame.mean} ev/f)`,
    !!api && (nat.evPerFrame.mean < 2 || nat.samplesPerFrame.mean >= 2) && s20.usedOfExpected >= 0.95, `>= 2; all up to cap ${cap}`);
  if (kind === 'touch') {
    const ys = dp.map((d) => d[1]); const lo = Math.min(...ys.map((q) => -q.max)), hi = Math.max(...ys.map((q) => -q.min));
    add('B1.nudge', 'touch nudge, paint above finger (px)', `${r1(lo)}..${r1(hi)}`, lo >= 11 && hi <= 13, '12 +/- 1');
  }
  if (kind === 'mouse') {
    // frames with more than `cap` events are subsampled by design, so the line
    // asks that samples sit on the path and that every event of an under-cap
    // frame is a sample; corner errors (vs the ideal path and vs the input's
    // own polyline) are reported for B5's A4
    add('B1.curves', 'fast zig-zag (native, 20 fps): samples off path px / under-cap events missing from samples px (n) / corner err px (input\'s own)',
      `${z60.sampleOffPathPx}/${z60.underCapErrPx} (${z60.underCapEvents})/${z60.sampleCornerErrPx} (${z60.eventCornerErrPx}) @${z60.dtMs.med} ms; ${z20.sampleOffPathPx}/${z20.underCapErrPx} (${z20.underCapEvents})/${z20.sampleCornerErrPx} (${z20.eventCornerErrPx}) @${z20.dtMs.med} ms`,
      !!api && z60.sampleOffPathPx <= 2 && z20.sampleOffPathPx <= 2 && z60.underCapErrPx !== null && z60.underCapErrPx <= 1 && z20.underCapErrPx !== null && z20.underCapErrPx <= 1, '<= 2 / <= 1');
  }
  add('B1.leave', 'leave+return: input strokeStart / edge samples / edge err px', `${lr.inputStarts} / ${lr.edgeSamples} / ${lr.edgeErrPx}`, lr.inputStarts === 1 && lr.edgeSamples === 2 && lr.edgeErrPx !== null && lr.edgeErrPx <= 2, '1 / 2 / <= 2');
  const os = S['off-start'];
  add('B1.offstart', 'press off the nail: strokeStart / entry edge samples', `${os.inputStarts} / ${os.edgeSamples}`, os.inputStarts === 1 && os.edgeSamples === 1, '1 / 1');
  if (kind === 'touch') add('B1.finger', 'second finger: deposit off finger-1 path (px)', `${sf.depOffPathPx}`, sf.depOffPathPx <= 1, '<= 1');
  const rcMax = Math.max(...Object.values(S).filter((o) => o && o.raycastsMax !== undefined).map((o) => o.raycastsMax));
  add('B1.raycasts', 'raycasts per frame, max', `${rcMax} (cap ${cap})`, rcMax <= cap + 4 && !!api, `<= cap + 4`);
  if (kind === 'mouse') add('B1.hover', 'mouse hover over the nail: tip.hover frames', `${res.hover.hoverFlag} of ${res.hover.onNail}`, res.hover.onNail > 0 && res.hover.hoverFlag === res.hover.onNail, 'all');
  return L;
}

// ------------------------------------------------------------------ main --

const all = [];
for (const tier of TIERS) for (const kind of INPUTS) {
  const t0 = Date.now();
  console.error(`== ${tier}-${kind}`);
  const res = await runCombo(tier, kind);
  res.lines = lines(res);
  fs.writeFileSync(path.join(OUT, `result-${res.tag}.json`), JSON.stringify(res, null, 1));
  console.error(`== ${tier}-${kind} done in ${((Date.now() - t0) / 1000).toFixed(0)} s, page errors: ${res.errors.length}, external: ${res.external.length}`);
  all.push(res);
}

// table: one row per line id, one column per combo
const ids = []; for (const r of all) for (const l of r.lines) if (!ids.includes(l.id)) ids.push(l.id);
let failed = 0;
console.log('\n| line | measure | ' + all.map((r) => r.tag).join(' | ') + ' | target |');
console.log('|---|---|' + all.map(() => '---').join('|') + '|---|');
for (const id of ids) {
  const ls = all.map((r) => r.lines.find((l) => l.id === id));
  const one = ls.find(Boolean);
  const cells = ls.map((l) => (l ? `${l.pass === null ? 'REVIEW' : l.pass ? 'PASS' : 'FAIL'} ${l.value}` : '-'));
  const gated = GATE.some((g) => (g === 'A' ? /^A\d+$/.test(id) : id === g || id.startsWith(g + '.')));
  if (gated && ls.some((l) => l && l.pass === false)) failed++;
  console.log(`| ${id} | ${one.measure} | ${cells.join(' | ')} | ${one.target} |`);
}
const errs = all.flatMap((r) => r.errors.map((e) => `${r.tag}: ${e}`));
if (errs.length) console.log('\npage errors:\n' + errs.join('\n'));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(all.map((r) => ({ tag: r.tag, info: r.info, nailWidthPx: r.nailWidthPx, nailLengthPx: r.nailLengthPx, rig: r.rig, lines: r.lines })), null, 1));
console.log(`\n${failed} gated line(s) failed (gate: ${GATE.join(',')}). Output: ${OUT}`);
process.exit(failed || errs.length ? 1 : 0);
