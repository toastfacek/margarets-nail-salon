// Finger pan test (B7): the smart pan between the five fingers.
//
// Usage:
//   node scripts/pan.mjs [url] [--inputs=mouse,touch] [--out=dir] [--shots]
//
// Boots the built game (`npx vite preview --port 4511 --strictPort`) in headless
// Chrome (SwiftShader), once per input kind, sends real CDP mouse or touch
// events and checks:
//   P1  a drag that starts off the active nail moves to the next finger, which
//       becomes active; the camera settles exactly on that finger's focus pose
//   P2  a flick (short, fast) moves one finger
//   P3  a tap on a neighbouring nail glides to it (camera parked between two
//       fingers first, so the neighbour is on screen)
//   P4  rubber band past the last finger (pinky): the camera gives a little,
//       springs back, the active nail stays
//   P5  a drag that starts on the active nail paints (one stroke) and never pans;
//       a press just outside the nail (grace) paints too
//   P6  touch: a second finger during a stroke does not pan
//   P7  round mode: a one-nail client never leaves the nail; a three-nail client
//       pans among its nails only (thumb refused), each nail keeps its paint
//   P8  glide frame time (rAF) vs a painting baseline measured in the same page
//       (round mode, the three-nail client)
// Exits 1 when a check fails or the page logs errors.
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
const BASE_URL = pos[0] || 'http://localhost:4511/';
const INPUTS = String(flags.inputs || 'mouse,touch').split(',');
const OUT = flags.out || path.join(os.tmpdir(), 'pan-test');
const CHROME = process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(kind, params) {
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
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.__ready === true && window.app.fingerPan, null, { timeout: 90000 });
  await sleep(2500);
  const cdp = await ctx.newCDPSession(page);
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, buttons, button: buttons || type !== 'mouseMoved' ? 'left' : 'none', clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const input = {
    down: (x, y) => (kind === 'touch' ? touch('touchStart', [{ x, y, id: 1 }]) : mouse('mousePressed', x, y, 1)),
    move: (x, y) => (kind === 'touch' ? touch('touchMove', [{ x, y, id: 1 }]) : mouse('mouseMoved', x, y, 1)),
    up: (x, y) => (kind === 'touch' ? touch('touchEnd', []) : mouse('mouseReleased', x, y, 0)),
    hover: (x, y) => (kind === 'touch' ? Promise.resolve() : mouse('mouseMoved', x, y, 0)),
    touch,
  };
  await page.evaluate(() => {
    const T = window.__P = { starts: 0, ft: null };
    app.events.on('brush:strokeStart', () => { T.starts++; });
    let last = -1;
    const loop = (t) => { if (T.ft && last >= 0) T.ft.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const V = app.scene.camera.position.constructor;
    // screen point of a nail's frame centre
    T.nailXY = (f) => {
      const rec = app.nail.getNail(app.nail.getCurrentHand(), f); if (!rec) return null;
      rec.mesh.updateWorldMatrix(true, false);
      const c = rec.material.uniforms.uNailCentre.value.clone().applyMatrix4(rec.mesh.matrixWorld).project(app.scene.camera);
      const r = app.scene.renderer.domElement.getBoundingClientRect();
      return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
    };
    // active nail's screen box from a raycast grid
    T.box = () => {
      const cam = app.scene.camera; const mesh = app.nail.getNailMesh();
      const rc = new app.polishBrush3D.raycaster.constructor(); const r = app.scene.renderer.domElement.getBoundingClientRect();
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let gx = 0; gx <= 160; gx++) for (let gy = 0; gy <= 120; gy++) {
        const sx = r.width * gx / 160, sy = r.height * gy / 120;
        rc.setFromCamera({ x: sx / r.width * 2 - 1, y: -(sy / r.height) * 2 + 1 }, cam);
        if (rc.intersectObject(mesh, false).length) { x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
      }
      return x1 < x0 ? null : { x0, x1, y0, y1, fill: Math.max(x1 - x0, y1 - y0) / Math.min(r.width, r.height) };
    };
    T.hit = (x, y) => {
      const rc = new app.polishBrush3D.raycaster.constructor(); const r = app.scene.renderer.domElement.getBoundingClientRect();
      rc.setFromCamera({ x: (x - r.left) / r.width * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 }, app.scene.camera);
      return rc.intersectObject(app.nail.getNailMesh(), false).length > 0;
    };
    T.state = () => {
      const s = app.scene; const cam = s.camera;
      const pose = { pos: new V(), target: new V(), up: new V(), d: 0, ok: false };
      const f = app.nail.getActiveNail();
      s.focusPose(f, pose);
      return {
        finger: f, railS: +s.railS.toFixed(4), anim: s.isAnimating, busy: app.fingerPan.busy,
        cam: cam.position.toArray(), tgt: s.controls.target.toArray(),
        poseErr: pose.ok ? +Math.max(cam.position.distanceTo(pose.pos), s.controls.target.distanceTo(pose.target), cam.up.distanceTo(pose.up)).toExponential(2) : null,
        starts: T.starts,
      };
    };
    T.cov = (f) => app.polishBrush3D.getCoverage(app.nail.getCurrentHand(), f);
  });
  return { browser, page, input, errors, external, kind };
}

// a drag along pts in dur ms, 120 Hz, pipelined
async function drag(s, pts, dur, { hold = 40, noUp = false } = {}) {
  const { input } = s;
  await input.hover(pts[0][0], pts[0][1]);
  await input.down(pts[0][0], pts[0][1]);
  await sleep(hold);
  const t0 = Date.now(); const pend = []; let last = pts[0];
  const seg = (f) => { const k = f * (pts.length - 1); const i = Math.min(pts.length - 2, Math.floor(k)); const t = k - i; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; };
  for (;;) {
    const f = Math.min(1, (Date.now() - t0) / dur);
    last = seg(f);
    pend.push(input.move(last[0], last[1]));
    if (f >= 1) break;
    await sleep(1000 / 120);
  }
  await Promise.all(pend);
  if (noUp) return last;
  await input.up(last[0], last[1]);
  return last;
}
async function tap(s, x, y) {
  await s.input.hover(x, y);
  await s.input.down(x, y);
  await sleep(60);
  await s.input.up(x, y);
}
const st = (s) => s.page.evaluate(() => __P.state());
const ev = (s, fn, arg) => s.page.evaluate(fn, arg);
const settle = async (s) => { for (let i = 0; i < 40; i++) { const q = await st(s); if (!q.anim && !q.busy) return q; await sleep(100); } return st(s); };

// unit screen vector from the active nail toward finger f's nail
async function toward(s, f) {
  const [a, b] = await ev(s, (f) => [__P.nailXY(app.nail.getActiveNail()), __P.nailXY(f)], f);
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}
// an off-nail start point: from the nail centre along dir until `extra` px past
// the nail's edge (canvas only, clear of the side panels)
async function offNail(s, dir, extra = 60) {
  const box = await ev(s, () => __P.box());
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  return ev(s, ([cx, cy, dx, dy, extra]) => {
    let t = 0;
    while (t < 2000 && __P.hit(cx + dx * t, cy + dy * t)) t += 2;
    t += extra;
    let x = cx + dx * t, y = cy + dy * t;
    x = Math.max(90, Math.min(990, x)); y = Math.max(90, Math.min(600, y));
    return { x, y, on: __P.hit(x, y) };
  }, [cx, cy, dir[0], dir[1], extra]);
}

const results = [];
const check = (kind, id, what, value, pass, target) => { results.push({ kind, id, what, value, pass, target }); console.log(`${pass ? 'PASS' : 'FAIL'} ${kind} ${id} ${what}: ${typeof value === 'string' ? value : JSON.stringify(value)} (${target})`); };

for (const kind of INPUTS) {
  // ---------------------------------------------------------------- free --
  const s = await boot(kind, { perf: '1', mode: 'free' });
  const q0 = await st(s);
  // P1: drag off the nail toward the middle finger (content moves away from it)
  {
    const d = await toward(s, 'middle');
    const p = await offNail(s, [d[0], d[1]], 70);
    const len = 360;
    const shotMid = drag(s, [[p.x, p.y], [p.x - d[0] * len, p.y - d[1] * len]], 450, { noUp: true });
    const end = await shotMid;
    await sleep(250); // the last move lands, any grab blend is over
    const mid = await st(s);
    // 1:1: how far the gripped point moved along the drag, per px the finger moved
    const tr = await ev(s, () => app.fingerPan.track());
    const u = [-d[0], -d[1]];
    const follow = tr ? ((tr.grip[0] - tr.start[0]) * u[0] + (tr.grip[1] - tr.start[1]) * u[1]) / ((tr.pointer[0] - tr.start[0]) * u[0] + (tr.pointer[1] - tr.start[1]) * u[1]) : null;
    const offPx = tr ? Math.hypot(tr.grip[0] - tr.pointer[0], tr.grip[1] - tr.pointer[1]) : null;
    if (flags.shots) await s.page.screenshot({ path: path.join(OUT, `${kind}-mid-pan.png`) });
    await s.input.up(end[0], end[1]);
    const q = await settle(s);
    const box = await ev(s, () => __P.box());
    check(kind, 'P1', 'drag off-nail index -> middle: active, railS, pose error, fill, strokes', `${q0.finger}->${q.finger}, ${q.railS}, ${q.poseErr}, ${box && box.fill.toFixed(3)}, ${q.starts - q0.starts}; mid-drag railS ${mid.railS}`,
      p.on === false && q.finger === 'middle' && q.railS === 2 && +q.poseErr < 1e-5 && box.fill >= 0.5 && q.starts === q0.starts && mid.railS > 1 && mid.railS < 2, 'middle, 2, < 1e-5, framed, 0 strokes');
    check(kind, 'P1b', 'mid-drag: gripped point follows the finger (along the drag, ratio) / off the finger (px)', `${follow === null ? null : follow.toFixed(3)} / ${offPx === null ? null : offPx.toFixed(1)}`, follow !== null && follow > 0.9 && follow < 1.1, '1:1 (0.9..1.1)');
  }
  // P2: flick toward the ring finger
  {
    const a = await st(s);
    const d = await toward(s, 'ring');
    const p = await offNail(s, d, 70);
    const t0 = Date.now();
    await drag(s, [[p.x, p.y], [p.x - d[0] * 90, p.y - d[1] * 90]], 60, { hold: 20 });
    const q = await settle(s);
    check(kind, 'P2', 'flick (90 px in 60 ms) middle -> ring', `${a.finger}->${q.finger} in ${Date.now() - t0} ms, pose err ${q.poseErr}`, q.finger === 'ring' && +q.poseErr < 1e-5, 'ring');
  }
  // P3: tap a neighbouring nail (camera parked half way to the pinky so it shows)
  {
    // park the camera between the ring and the pinky, as far toward the ring as
    // still shows the pinky nail clear of the side panel
    const xy = await ev(s, () => {
      app.scene.invalidateRail();
      let p = null;
      for (let k = 3.3; k <= 3.95; k += 0.05) {
        app.scene.railSet(k); app.scene.camera.updateMatrixWorld();
        p = __P.nailXY('pinky');
        if (p[0] > 40 && p[0] < 960 && p[1] > 60 && p[1] < 600) break;
      }
      return p;
    });
    await sleep(300);
    const vis = xy[0] > 0 && xy[0] < 1000 && xy[1] > 0 && xy[1] < 640;
    if (flags.shots) await s.page.screenshot({ path: path.join(OUT, `${kind}-tap-before.png`) });
    await tap(s, xy[0], xy[1]);
    const q = await settle(s);
    if (q.finger !== 'pinky') { await ev(s, () => app.fingerPan.goTo('pinky')); await settle(s); }
    check(kind, 'P3', 'tap on the pinky nail (on screen) glides to it', `visible ${vis} at ${xy.map(Math.round)}, active ${q.finger}, railS ${q.railS}, pose err ${q.poseErr}, strokes ${q.starts - q0.starts}`, vis && q.finger === 'pinky' && q.railS === 4 && +q.poseErr < 1e-5 && q.starts === q0.starts, 'pinky, 4');
  }
  // P4: rubber band past the pinky
  {
    const d = await toward(s, 'ring'); // past the pinky = away from the ring
    const p = await offNail(s, [d[0], d[1]], 70);
    const len = 300;
    const end = await drag(s, [[p.x, p.y], [p.x + d[0] * len, p.y + d[1] * len]], 400, { noUp: true });
    const mid = await st(s);
    await s.input.up(end[0], end[1]);
    const q = await settle(s);
    check(kind, 'P4', 'rubber band past the pinky: railS while stretched, after', `${mid.railS} -> ${q.railS}, active ${q.finger}, pose err ${q.poseErr}`, mid.railS > 4 && mid.railS < 4.3 && q.railS === 4 && q.finger === 'pinky' && +q.poseErr < 1e-5, '4 < s < 4.3, back to 4');
  }
  // P5: a drag on the active nail paints, never pans; a press 6 px outside paints too
  {
    const a = await st(s);
    const box = await ev(s, () => __P.box());
    const cx = (box.x0 + box.x1) / 2;
    await drag(s, [[cx - 0.2 * (box.x1 - box.x0), box.y0 + 0.3 * (box.y1 - box.y0)], [cx + 0.2 * (box.x1 - box.x0), box.y0 + 0.7 * (box.y1 - box.y0)]], 500);
    await sleep(400);
    const b = await st(s);
    const cov = await ev(s, () => __P.cov('pinky'));
    // grace: find the nail edge below the centre (the free edge), start 6 px past it
    const cy = (box.y0 + box.y1) / 2;
    let y = cy; while (y < 720 && await ev(s, ([x, y]) => __P.hit(x, y), [cx, y + 1])) y += 1;
    const gy = y + 6;
    const onGrace = await ev(s, ([x, y]) => __P.hit(x, y), [cx, gy]);
    await drag(s, [[cx, gy], [cx, gy - 60]], 300);
    await sleep(400);
    const c = await st(s);
    const moved = Math.max(...a.cam.map((v, i) => Math.abs(v - c.cam[i])));
    check(kind, 'P5', 'drag on the nail: strokes, coverage, camera move; grace press 6 px off the edge: strokes', `${b.starts - a.starts}, ${cov.toFixed(3)}, ${moved.toExponential(1)}; ${onGrace ? 'on nail?' : 'off'} ${c.starts - b.starts}`,
      b.starts - a.starts === 1 && cov > 0.02 && moved < 1e-6 && c.starts - b.starts === 1 && !onGrace && c.finger === 'pinky', '1, > 0, 0; off 1');
  }
  // P6: touch only: a second finger lands off the nail during a stroke and drags
  if (kind === 'touch') {
    const a = await st(s);
    const box = await ev(s, () => __P.box());
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    await s.input.touch('touchStart', [{ x: cx, y: cy - 40, id: 1 }]);
    await sleep(80);
    await s.input.touch('touchStart', [{ x: cx, y: cy - 40, id: 1 }, { x: 900, y: 600, id: 2 }]);
    for (let i = 1; i <= 20; i++) { await s.input.touch('touchMove', [{ x: cx, y: cy - 40 + i * 3, id: 1 }, { x: 900 - i * 20, y: 600, id: 2 }]); await sleep(16); }
    await s.input.touch('touchEnd', [{ x: cx, y: cy + 20, id: 1 }]);
    await s.input.touch('touchEnd', []);
    await sleep(500);
    const b = await st(s);
    const moved = Math.max(...a.cam.map((v, i) => Math.abs(v - b.cam[i])));
    check(kind, 'P6', 'second finger off the nail during a stroke: strokes, camera move, active', `${b.starts - a.starts}, ${moved.toExponential(1)}, ${b.finger}`, b.starts - a.starts === 1 && moved < 1e-6 && b.finger === a.finger, '1, 0, same');
  }
  check(kind, 'P0', 'page errors / external requests (free)', `${s.errors.length} / ${s.external.size}`, s.errors.length === 0 && s.external.size === 0, '0 / 0');
  if (s.errors.length) console.log(s.errors.join('\n'));
  await s.browser.close();

  // --------------------------------------------------------------- round --
  const r = await boot(kind, { perf: '1' });
  {
    const a = await st(r);
    // one-nail client: drag off the nail both ways
    for (const f of ['middle', 'thumb']) {
      const d = await toward(r, f);
      const p = await offNail(r, [d[0], d[1]], 70);
      if (p.on) console.log('warning: start on the nail', p);
      await drag(r, [[p.x, p.y], [p.x - d[0] * 300, p.y - d[1] * 300]], 350);
      await settle(r);
    }
    const b = await st(r);
    check(kind, 'P7a', 'round, one-nail client: drags off the nail both ways', `${a.finger} -> ${b.finger}, railS ${b.railS}, pose err ${b.poseErr}, strokes ${b.starts - a.starts}`, b.finger === 'index' && b.railS === 1 && +b.poseErr < 1e-5 && b.starts === a.starts, 'stays index');
    // three-nail client
    await ev(r, () => { app.game.rounds.arrive(true); });
    await settle(r);
    await sleep(600);
    const c = await st(r);
    const want = await ev(r, () => app.game.rounds.request.fingers.join(','));
    const box = await ev(r, () => __P.box());
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    await drag(r, [[cx, cy - 0.3 * (box.y1 - box.y0)], [cx, cy + 0.3 * (box.y1 - box.y0)]], 500);
    await sleep(500);
    const covIndex = await ev(r, () => __P.cov('index'));
    // toward the thumb: not in the request
    {
      const d = await toward(r, 'thumb');
      const p = await offNail(r, [d[0], d[1]], 70);
      await drag(r, [[p.x, p.y], [p.x - d[0] * 300, p.y - d[1] * 300]], 300);
    }
    const t = await settle(r);
    // toward the middle
    {
      const d = await toward(r, 'middle');
      const p = await offNail(r, [d[0], d[1]], 70);
      await drag(r, [[p.x, p.y], [p.x - d[0] * 300, p.y - d[1] * 300]], 300);
    }
    const m = await settle(r);
    const after = await ev(r, () => ({ index: __P.cov('index'), middle: __P.cov('middle'), dots: [...document.querySelectorAll('.fp-dot')].filter((b) => !b.hidden).length, dotOn: [...document.querySelectorAll('.fp-dot.on')].map((b) => b.getAttribute('aria-label')).join(), state: app.game.rounds.state }));
    if (flags.shots) await r.page.screenshot({ path: path.join(OUT, `${kind}-round3.png`) });
    check(kind, 'P7b', 'round, three nails (index, middle, ring): thumb refused, pan to middle, paint kept per nail, dots', `${want}; ${c.finger} -thumb-> ${t.finger} -> ${m.finger} (${m.railS}); index cov ${covIndex.toFixed(3)} -> ${after.index.toFixed(3)}, middle ${after.middle.toFixed(3)}; dots ${after.dots} on ${after.dotOn}; ${after.state}`,
      want === 'index,middle,ring' && t.finger === 'index' && m.finger === 'middle' && m.railS === 2 && covIndex > 0.02 && Math.abs(after.index - covIndex) < 1e-6 && after.middle === 0 && after.dots === 3 && after.dotOn === 'middle' && after.state === 'paint', 'index stays; middle; cov kept; 3 dots');
    // a dot tap glides to its finger
    const dot = await ev(r, () => { const b = document.querySelector('.fp-dot[aria-label="ring"]'); const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2, q.width, q.height]; });
    await tap(r, dot[0], dot[1]);
    const g = await settle(r);
    check(kind, 'P7c', 'round: tap the ring dot (size)', `${g.finger}, railS ${g.railS}, dot ${dot[2]}x${dot[3]}`, g.finger === 'ring' && g.railS === 3 && dot[2] >= 44 && dot[3] >= 44, 'ring, >= 44 px');
  }
  // P8: glide frame time vs painting, same page (round mode, three-nail client).
  // Alternating blocks; frames are counted while the brush paints / while the
  // camera glides (rAF time), with no page polling in either block.
  {
    const box = await ev(r, () => __P.box());
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const pts = []; for (let i = 0; i <= 30; i++) pts.push([cx + Math.sin(i * 0.4) * 0.3 * (box.x1 - box.x0), cy + Math.cos(i * 0.27) * 0.3 * (box.y1 - box.y0)]);
    await ev(r, () => {
      __P.fp = []; __P.fg = []; let last = -1;
      const loop = (t) => {
        if (last >= 0) {
          if (app.polishBrush3D.inputHandler && app.polishBrush3D.inputHandler.isPointerDown) __P.fp.push(t - last);
          else if (app.scene.isRailGliding()) __P.fg.push(t - last);
        }
        last = t; if (!__P.stopP8) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    for (let k = 0; k < 3; k++) {
      // painting starts on the active nail (re-measured after each glide block)
      const b = await ev(r, () => __P.box());
      const bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2;
      await drag(r, pts.map((q) => [q[0] - cx + bx, q[1] - cy + by]), 3000);
      await sleep(300);
      for (const f of k % 2 ? ['ring', 'middle', 'index', 'middle'] : ['middle', 'ring', 'middle', 'index']) {
        await ev(r, (f) => app.fingerPan.goTo(f), f);
        await sleep(900);
      }
      await ev(r, () => app.fingerPan.goTo('index'));
      await sleep(900);
    }
    const [paint, glide] = await ev(r, () => { __P.stopP8 = true; return [__P.fp.slice(), __P.fg.slice()]; });
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
    check(kind, 'P8', 'frame ms painting avg/p95 vs glide avg/p95', `${avg(paint).toFixed(1)}/${p95(paint).toFixed(1)} (${paint.length} frames) vs ${avg(glide).toFixed(1)}/${p95(glide).toFixed(1)} (${glide.length} frames)`, glide.length > 30 && avg(glide) <= avg(paint), 'glide <= painting');
  }
  check(kind, 'P0r', 'page errors / external requests (round)', `${r.errors.length} / ${r.external.size}`, r.errors.length === 0 && r.external.size === 0, '0 / 0');
  if (r.errors.length) console.log(r.errors.join('\n'));
  await r.browser.close();
}

const failed = results.filter((x) => !x.pass);
fs.writeFileSync(path.join(OUT, 'pan-results.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} pan checks passed. Output: ${OUT}`);
process.exit(failed.length ? 1 : 0);
