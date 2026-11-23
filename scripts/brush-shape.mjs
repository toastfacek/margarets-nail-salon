// Brush shape and spring test (B8): is the head a real nail polish brush?
//
// Usage:
//   node scripts/brush-shape.mjs [url] [--tiers=high,low] [--brushes=classic,prowide]
//        [--shots=dir] [--prefix=b8]
//
// Boots the built game (`npx vite preview --port 4411 --strictPort`) in headless
// Chrome (SwiftShader), and per tier x brush measures:
//   S1  rest (hovering): head length / width on screen (the loft's own vertices,
//       projected; principal axes) and in 3D, in nail widths
//   S2  side view: thickness / width of the widest section (3D, the rendered
//       vertices along the section's own axes), target 0.4 .. 0.6
//   S3  tip dome: centre bristles longer than the edge ones (nail widths)
//   S4  mid-stroke (cuticle -> free edge, the natural stroke): pressed
//       footprint (tip span) / nail width, and the paint band the engine lays
//       (debug.halfWidthPx) / nail width on screen; S4u the push stroke (info)
//   S5  springs: a synthetic reversal (the rig driven at 120 Hz with the
//       contact velocity flipped) and a lift: overshoot % and settle time to
//       within 5% (target ~10-15%, 80-120 ms)
//   S6  on-screen reversal: stem minus tips along the motion (px) over time
// With --shots it also writes the screenshot set (close-up mid-stroke high and
// low, push stroke, hover, side-ish views, pressed footprint, dry stroke,
// prowide, portrait 390x844) and the raw numbers (<prefix>-shape.json).
// Exits 1 when a gated line fails.
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
const BASE_URL = pos[0] || 'http://localhost:4411/';
const TIERS = String(flags.tiers || 'high,low').split(',');
const BRUSHES = String(flags.brushes || 'classic,prowide').split(',');
const SHOTS = flags.shots ? String(flags.shots) : null;
const PREFIX = String(flags.prefix || 'b8');
const CHROME = process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : +(+v).toFixed(3));

async function boot(tier, brush, vw = 1280, vh = 720) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const host = new URL(BASE_URL).host;
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host !== host && u.protocol.startsWith('http')) return route.abort();
    return route.continue();
  });
  const u = new URL(BASE_URL);
  u.searchParams.set('tier', tier);
  u.searchParams.set('perf', '1');
  u.searchParams.set('brush', brush);
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.__ready === true && window.app.nail && window.app.nail.getNailMesh
    && window.app.nail.getNailMesh() && window.app.polishBrush3D && window.app.polishBrush3D.inputHandler, null, { timeout: 90000 });
  // wait for the intro (camera flight, demo stroke) to finish: camera still, not painting
  await page.waitForFunction(() => {
    const c = app.scene.camera.position; const w = window.__still || (window.__still = { x: 0, y: 0, z: 0, n: 0 });
    const same = Math.abs(c.x - w.x) + Math.abs(c.y - w.y) + Math.abs(c.z - w.z) < 1e-6 && !app.polishBrush3D.isPainting;
    w.x = c.x; w.y = c.y; w.z = c.z; w.n = same ? w.n + 1 : 0;
    return w.n > 20;
  }, null, { timeout: 60000, polling: 50 });
  await sleep(300);
  // nail box on screen (raycast grid)
  const box = await page.evaluate(() => {
    const m = app.nail.getNailMesh(); const cam = app.scene.camera; const rc = app.polishBrush3D.raycaster;
    const r = app.scene.renderer.domElement.getBoundingClientRect();
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let y = 0; y < r.height; y += 4) for (let x = 0; x < r.width; x += 4) {
      rc.setFromCamera({ x: x / r.width * 2 - 1, y: 1 - y / r.height * 2 }, cam);
      if (rc.intersectObject(m, false).length) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { x0: x0 + r.left, x1: x1 + r.left, y0: y0 + r.top, y1: y1 + r.top };
  });
  // in-page helpers
  await page.evaluate(() => {
    const b = app.polishBrush3D.bristleSystem;
    const cam = app.scene.camera;
    const V = cam.position.constructor;
    const v = new V();
    window.__shape = {
      // head on screen: principal axes of the loft's projected vertices
      screen() {
        const r = app.scene.renderer.domElement.getBoundingClientRect();
        const p = b.mesh.geometry.attributes.position.array;
        const n = 12 * 15 + 1; // loft vertices (RINGS x COLS + tip)
        const xs = [], ys = [];
        for (let i = 0; i < n; i++) { v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).project(cam); xs.push(r.left + (v.x + 1) / 2 * r.width); ys.push(r.top + (1 - v.y) / 2 * r.height); }
        let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
        let sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); const ca = Math.cos(ang), sa = Math.sin(ang);
        let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
        for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; const pa = dx * ca + dy * sa, pb = -dx * sa + dy * ca; a0 = Math.min(a0, pa); a1 = Math.max(a1, pa); b0 = Math.min(b0, pb); b1 = Math.max(b1, pb); }
        return { lenPx: a1 - a0, widPx: b1 - b0 };
      },
      measure() { return b.measureShape(); },
      dbg() { const d = app.polishBrush3D.debug; return d ? { hwPx: d.halfWidthPx, load: d.load, dry: d.dry } : null; },
      // stem (root joints) minus tips, on screen
      rootTip() {
        const r = app.scene.renderer.domElement.getBoundingClientRect();
        const jp = b.jointPositions, J = b.jointsPerBristle, n = b.bristleCount;
        let rx = 0, ry = 0, tx = 0, ty = 0;
        for (let i = 0; i < n; i++) {
          v.set(jp[i * J * 3], jp[i * J * 3 + 1], jp[i * J * 3 + 2]).project(cam); rx += v.x; ry += v.y;
          const k = (i * J + J - 1) * 3; v.set(jp[k], jp[k + 1], jp[k + 2]).project(cam); tx += v.x; ty += v.y;
        }
        return [(rx - tx) / n * r.width / 2, -(ry - ty) / n * r.height / 2];
      },
      // a side view of the head: a temporary camera looking along the widest section's width axis
      side(dist) {
        const r = app.renderer || app.scene.renderer;
        const p = b.mesh.geometry.attributes.position.array;
        let mx = 0, my = 0, mz = 0; const n = 12 * 15 + 1;
        for (let i = 0; i < n; i++) { mx += p[i * 3]; my += p[i * 3 + 1]; mz += p[i * 3 + 2]; }
        const c = new V(mx / n, my / n, mz / n);
        const F = new V(b.handle.matrix.elements[0], b.handle.matrix.elements[1], b.handle.matrix.elements[2]).normalize();
        const A = new V(b.handle.matrix.elements[4], b.handle.matrix.elements[5], b.handle.matrix.elements[6]).normalize();
        const cam2 = cam.clone();
        // side-ish: mostly along the width axis, a little from the face, so the thickness shows
        const Fn = new V(b.handle.matrix.elements[8], b.handle.matrix.elements[9], b.handle.matrix.elements[10]).normalize();
        cam2.position.copy(c).addScaledVector(F, dist * 0.87).addScaledVector(Fn, dist * 0.5);
        cam2.up.copy(A);
        cam2.lookAt(c);
        cam2.updateMatrixWorld();
        r.render(app.scene.scene || app.scene, cam2);
        return r.domElement.toDataURL('image/png');
      },
      // springs: drive the rig with a synthetic contact at the current pose point
      springs() {
        const pose = { point: b.pose.point.clone(), normal: b.pose.normal.clone(), axis: b.pose.axis.clone(), velocity: new V(), halfWidth: b.pose.halfWidth || 0.01, pressure: 1, load: 1, contact: true, isTouch: false, scale: b.pose.scale, onSurface: true };
        const dir = new V().crossVectors(pose.normal, pose.axis).normalize();
        const speed = 2 * pose.scale; // saturates the drag
        const dt = 1 / 120;
        const nail = app.nail.getNailMesh();
        const run = (vel, contact, pressure, steps, rec) => {
          for (let i = 0; i < steps; i++) {
            pose.velocity.copy(dir).multiplyScalar(vel); pose.contact = contact; pose.pressure = pressure;
            b.setPose(pose); b.update(dt, nail, app.polishBrush3D.raycaster);
            if (rec) rec.push([b.trail.dot(dir), b.bend]);
          }
        };
        const pre = []; run(speed, true, 1, 60, pre);
        const rev = []; run(-speed, true, 1, 60, rev);
        const lift = []; run(0, false, 0, 60, lift);
        return { pre: pre[pre.length - 1], rev, lift, dtMs: dt * 1000 };
      },
    };
  });
  return { browser, ctx, page, errors, box, tier, brush };
}

// step response: x(t) going from x0 to x1; overshoot % and settle (5%) time
function step(series, dtMs, x0, x1) {
  const span = x1 - x0;
  let peak = 0; let settle = 0;
  for (let i = 0; i < series.length; i++) {
    const over = (series[i] - x1) / span;
    if (over > peak) peak = over;
    if (Math.abs(series[i] - x1) > 0.05 * Math.abs(span)) settle = (i + 1) * dtMs;
  }
  return { overshootPct: +(peak * 100).toFixed(1), settleMs: +settle.toFixed(0) };
}

async function shot(s, name) {
  if (!SHOTS) return;
  await s.page.screenshot({ path: path.join(SHOTS, `${PREFIX}-${name}.png`) });
}

async function stroke(s, pts, durMs, { hold = false, shotAt = null, shotName = null } = {}) {
  const m = s.page.mouse;
  await m.move(pts[0][0], pts[0][1]);
  await m.down();
  const n = Math.max(2, Math.round(durMs / 16));
  let rec = [];
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const seg = f * (pts.length - 1); const k = Math.min(pts.length - 2, Math.floor(seg)); const t = seg - k;
    await m.move(pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t);
    await sleep(16);
    if (shotAt !== null && Math.abs(f - shotAt) < 0.5 / n) {
      if (shotName) await shot(s, shotName);
      rec.push(await s.page.evaluate(() => ({ m: __shape.measure(), sc: __shape.screen(), d: __shape.dbg() })));
    }
  }
  if (!hold) await m.up();
  return rec;
}

const results = [];
const lines = [];
const add = (id, what, value, pass, target) => lines.push({ id, what, value, pass, target });

for (const tier of TIERS) {
  for (const brush of BRUSHES) {
    const s = await boot(tier, brush);
    const tag = `${tier}-${brush}`;
    const { box } = s;
    const nailW = box.x1 - box.x0, nailH = box.y1 - box.y0;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const R = { tag, nailWpx: nailW };
    // S1-S3: hover at rest
    await s.page.mouse.move(cx + 10, cy + nailH * 0.18);
    await sleep(50);
    await s.page.mouse.move(cx + 12, cy + nailH * 0.18 + 1);
    await sleep(900);
    R.rest = await s.page.evaluate(() => ({ m: __shape.measure(), sc: __shape.screen() }));
    if (tier === 'high' && brush === 'classic') await shot(s, 'hover-rest');
    if (tier === 'high') {
      const url = await s.page.evaluate(() => __shape.side(app.polishBrush3D.bristleSystem.pose.scale * 2.2));
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${PREFIX}-side-${brush}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
    // S4: mid-stroke (free edge -> cuticle, centre), shot mid-way
    const y0 = cy + nailH * 0.34, y1 = cy - nailH * 0.3;
    const mid = await stroke(s, [[cx, y0], [cx, y1]], 900, { shotAt: 0.55, shotName: tier === 'high' && brush === 'classic' ? 'closeup-push-high' : null });
    R.up = mid[0];
    await sleep(400);
    // S4: the natural stroke (cuticle -> free edge, toward the handle), off-centre
    const c2t = await stroke(s, [[cx + nailW * 0.12, cy - nailH * 0.3], [cx + nailW * 0.12, cy + nailH * 0.32]], 900, { shotAt: 0.55, shotName: tier === 'high' ? (brush === 'classic' ? 'closeup-midstroke-high' : 'prowide-midstroke') : (brush === 'classic' ? 'closeup-midstroke-low' : null) });
    R.mid = c2t[0];
    await sleep(400);
    // pressed footprint, side to side across the nail, held still at the end
    const fp = await stroke(s, [[cx - nailW * 0.28, cy + nailH * 0.1], [cx + nailW * 0.1, cy + nailH * 0.1]], 600, { hold: true, shotAt: 1.0, shotName: tier === 'high' && brush === 'classic' ? 'pressed-footprint' : null });
    R.side = fp[0];
    await s.page.mouse.up();
    await sleep(300);
    // S6: on-screen reversal: right, then back left, recording stem - tip along x
    {
      const m = s.page.mouse; const yR = cy - nailH * 0.05; const xa = cx - nailW * 0.25, xb = cx + nailW * 0.2;
      await m.move(xa, yR); await m.down();
      const rec = [];
      const t0 = Date.now();
      for (let i = 1; i <= 24; i++) { await m.move(xa + (xb - xa) * i / 24, yR); await sleep(16); }
      for (let i = 1; i <= 24; i++) { await m.move(xb - (xb - xa) * i / 24, yR); await sleep(16); rec.push([Date.now() - t0, (await s.page.evaluate(() => __shape.rootTip()))[0]]); }
      for (let i = 0; i < 8; i++) { await sleep(16); rec.push([Date.now() - t0, (await s.page.evaluate(() => __shape.rootTip()))[0]]); }
      await m.up();
      R.screenRev = rec.map((q) => [q[0], +q[1].toFixed(1)]);
    }
    await sleep(300);
    // dry brush: scrub without lifting until the load is low, then a stroke
    if (tier === 'high' && brush === 'classic') {
      const m = s.page.mouse;
      await m.move(cx - nailW * 0.2, cy - nailH * 0.25); await m.down();
      for (let k = 0; k < 14; k++) {
        for (let i = 1; i <= 10; i++) { const f = i / 10; const up = k % 2 ? 1 - f : f; await m.move(cx - nailW * 0.2 + nailW * 0.4 * (k % 3) / 2, cy - nailH * 0.25 + nailH * 0.5 * up); await sleep(10); }
      }
      R.dry = await s.page.evaluate(() => ({ m: __shape.measure(), d: __shape.dbg() }));
      await shot(s, 'dry-stroke');
      await m.up();
    }
    // S5: springs (synthetic; last, it moves the rig)
    const sp = await s.page.evaluate(() => __shape.springs());
    const revX = sp.rev.map((q) => q[0]);
    // exact target: the steady trail magnitude before the flip
    R.reversal = step(revX, sp.dtMs, sp.pre[0], -sp.pre[0]);
    const liftB = sp.lift.map((q) => q[1]);
    R.liftBend = step(liftB, sp.dtMs, sp.rev[sp.rev.length - 1][1], 0);
    const liftT = sp.lift.map((q) => q[0]);
    R.liftTrail = step(liftT, sp.dtMs, sp.rev[sp.rev.length - 1][0], 0);
    R.errors = s.errors;
    await s.browser.close();

    // portrait
    if (tier === 'high' && brush === 'classic' && SHOTS) {
      const p = await boot(tier, brush, 390, 844);
      const b = p.box; const px = (b.x0 + b.x1) / 2, py = (b.y0 + b.y1) / 2, ph = b.y1 - b.y0;
      await stroke(p, [[px, py + ph * 0.3], [px, py - ph * 0.25]], 700, { shotAt: 0.6, shotName: 'portrait-390x844' });
      await p.browser.close();
    }

    results.push(R);
    const restLW = R.rest.sc.lenPx / R.rest.sc.widPx;
    console.log(JSON.stringify({ tag, nailWpx: r3(nailW), up: R.up ? R.up.m : null, rest: { m: R.rest.m, screenLW: r3(restLW) }, mid: R.mid ? { m: R.mid.m, screenLW: r3(R.mid.sc.lenPx / R.mid.sc.widPx), bandFrac: R.mid.d ? r3(2 * R.mid.d.hwPx / nailW) : null } : null, side: R.side ? { m: R.side.m, bandFrac: R.side.d ? r3(2 * R.side.d.hwPx / nailW) : null } : null, dry: R.dry || null, reversal: R.reversal, liftBend: R.liftBend, liftTrail: R.liftTrail, screenRev: R.screenRev, errors: R.errors }));

    const pr = brush === 'prowide';
    add(`S1.${tag}`, 'rest length (nail widths, 3D) / screen length:width', `${r3(R.rest.m.length)} / ${r3(restLW)}`, R.rest.m.length >= 0.83 && R.rest.m.length <= 0.97 && restLW >= (pr ? 1.4 : 2.0), pr ? '0.83-0.97 / >= 1.4' : '0.83-0.97 / >= 2');
    add(`S2.${tag}`, 'widest section thickness / width (3D)', `${r3(R.rest.m.thickOverWidth)} (w ${r3(R.rest.m.width)}, t ${r3(R.rest.m.thickness)})`, R.rest.m.thickOverWidth >= (pr ? 0.3 : 0.4) && R.rest.m.thickOverWidth <= 0.6, pr ? '0.3-0.6' : '0.4-0.6');
    add(`S3.${tag}`, 'tip dome: centre minus edge length (nail widths)', `${r3(R.rest.m.dome)}`, R.rest.m.dome > 0.02, '> 0.02');
    if (R.mid) {
      const tipSpan = R.mid.m.tipSpan, band = R.mid.d ? 2 * R.mid.d.hwPx / nailW : null;
      add(`S4.${tag}`, 'mid-stroke (cuticle -> free edge) footprint (tip span) / nail width; band on screen / nail width', `${r3(tipSpan)}; ${r3(band)}`, pr ? tipSpan >= 0.4 && tipSpan <= 0.5 : tipSpan >= 0.29 && tipSpan <= 0.37, pr ? '0.40-0.50' : '0.29-0.37');
      if (R.up) add(`S4u.${tag}`, 'push stroke (free edge -> cuticle, away from the handle): tip span / band (info: bristles run along the band axis there)', `${r3(R.up.m.tipSpan)} / ${r3(R.up.m.footprint)}`, null, 'info');
    }
    add(`S5.${tag}`, 'reversal overshoot % / settle ms; lift bend overshoot % / settle ms', `${R.reversal.overshootPct} / ${R.reversal.settleMs}; ${R.liftBend.overshootPct} / ${R.liftBend.settleMs}`, R.reversal.overshootPct >= 8 && R.reversal.overshootPct <= 18 && R.reversal.settleMs >= 60 && R.reversal.settleMs <= 140, '8-18 %, 60-140 ms');
    add(`E.${tag}`, 'page errors', `${R.errors.length}`, R.errors.length === 0, '0');
  }
}

if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${PREFIX}-shape.json`), JSON.stringify(results, null, 1));
console.log('\n| id | measure | value | target | pass |\n|---|---|---|---|---|');
let fail = 0;
for (const l of lines) { console.log(`| ${l.id} | ${l.what} | ${l.value} | ${l.target} | ${l.pass === null ? 'INFO' : l.pass ? 'PASS' : 'FAIL'} |`); if (l.pass === false) fail++; }
process.exit(fail ? 1 : 0);
