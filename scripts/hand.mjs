// Hand test (B9): the one hand file, the mirrored left hand, the nail units.
//
// Usage:
//   node scripts/hand.mjs [url] [--dist=dist] [--tier=high] [--shots=dir] [--prefix=b9]
//
// Boots the built game (`npx vite preview --port 4441 --strictPort`) in headless
// Chrome (SwiftShader) and checks:
//   H1  one model request: exactly one `.glb` fetched, even after showing the
//       other hand and coming back
//   H2  17 bones by name on both hands; the left hand's skin has a negative
//       matrix determinant (mirrored), the right hand's a positive one
//   H3  nail UV handedness: on every finger of both hands, seen from the
//       close-up camera, +u runs to screen right and +v down (a sticker reads
//       the right way round), same sign on both hands
//   H4  every nail has its frame from the file and a nail mask
//   H5  size: dist/models <= 1,150 KB, dist <= 2.15 MB
//   H6  no page errors, no external requests
//   H7  the skin carries the four colour masks (blush, palm, cavity, thinness)
// With --shots it writes zoomed-out (both hands) and index close-up screenshots
// (--fingers: a close-up of every finger too).
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
const DIST = path.resolve(String(flags.dist || 'dist'));
const TIER = String(flags.tier || 'high');
const SHOTS = flags.shots ? String(flags.shots) : null;
const PREFIX = String(flags.prefix || 'b9');
const UV_GATE = !flags['no-uv-gate'];
const CHROME = process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
let failed = 0;
function add(id, what, value, gate, ok) {
  rows.push({ id, what, value, gate, ok });
  if (ok === false) failed++;
}

function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
  }
  return n;
}

async function boot({ vw = 1280, vh = 720, params = {} } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const host = new URL(BASE_URL).host;
  const errors = [];
  const external = new Set();
  const glb = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  page.on('request', (r) => { if (/\.glb(\?|$)/.test(r.url())) glb.push(r.url()); });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host !== host && u.protocol.startsWith('http')) { external.add(u.host); return route.abort(); }
    return route.continue();
  });
  const u = new URL(BASE_URL);
  u.searchParams.set('tier', TIER);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  await page.goto(u.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() => window.app && window.app.__ready === true && app.nail && app.nail.getNailMesh && app.nail.getNailMesh(), null, { timeout: 90000 });
  await settle(page);
  return { browser, page, errors, external, glb };
}

// camera still and not painting for a while
async function settle(page) {
  await page.waitForFunction(() => {
    const c = app.scene.camera.position; const w = window.__still || (window.__still = { x: 0, y: 0, z: 0, n: 0 });
    const same = Math.abs(c.x - w.x) + Math.abs(c.y - w.y) + Math.abs(c.z - w.z) < 1e-6 && !app.polishBrush3D.isPainting && !app.scene.isAnimating;
    w.x = c.x; w.y = c.y; w.z = c.z; w.n = same ? w.n + 1 : 0;
    return w.n > 15;
  }, null, { timeout: 60000, polling: 50 });
  await sleep(250);
}

async function showHand(page, hand) {
  await page.evaluate((h) => app.switchHand(h), hand);
  await page.waitForFunction((h) => app.nail.getCurrentHand() === h && app.nail.isHandLoaded(h), hand, { timeout: 30000 });
  await page.evaluate(() => { window.__still = null; });
  await settle(page);
}

async function handFacts(page) {
  return page.evaluate(() => {
    const hm = app.nail;
    const hand = hm.getCurrentHand();
    const model = hm.hands[hand].model;
    model.updateMatrixWorld(true);
    let skin = null;
    model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const bones = skin ? skin.skeleton.bones.map((b) => b.name).sort() : [];
    const det = skin ? skin.matrixWorld.determinant() : 0;
    const V = app.scene.camera.position.constructor;
    const out = { hand, bones, det, nails: {} };
    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const rec = hm.getNail(hand, f);
      if (!rec) { out.nails[f] = null; continue; }
      const mesh = rec.mesh; mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
      // least squares: world = C + Ju u + Jv v over the vertices
      const M = new Float64Array(9), B = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
      const v = new V(); const r = [0, 0, 1];
      for (let i = 0; i < pos.count; i++) {
        if (rec.visible && !rec.visible[i]) continue; // B9: the hidden skirt / lip copy rim UVs
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        r[0] = uv.getX(i); r[1] = uv.getY(i);
        for (let j = 0; j < 3; j++) { B[0][j] += r[j] * v.x; B[1][j] += r[j] * v.y; B[2][j] += r[j] * v.z; for (let k = 0; k < 3; k++) M[j * 3 + k] += r[j] * r[k]; }
      }
      const solve = (b) => {
        const m = Array.from(M), y = Array.from(b);
        for (let i = 0; i < 3; i++) {
          let p = i; for (let j = i + 1; j < 3; j++) if (Math.abs(m[j * 3 + i]) > Math.abs(m[p * 3 + i])) p = j;
          for (let k = 0; k < 3; k++) { const t = m[i * 3 + k]; m[i * 3 + k] = m[p * 3 + k]; m[p * 3 + k] = t; }
          const t = y[i]; y[i] = y[p]; y[p] = t;
          for (let j = i + 1; j < 3; j++) { const q = m[j * 3 + i] / (m[i * 3 + i] || 1e-12); for (let k = i; k < 3; k++) m[j * 3 + k] -= q * m[i * 3 + k]; y[j] -= q * y[i]; }
        }
        const x = [0, 0, 0];
        for (let i = 2; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < 3; k++) s -= m[i * 3 + k] * x[k]; x[i] = s / (m[i * 3 + i] || 1e-12); }
        return x;
      };
      const X = solve(B[0]), Y = solve(B[1]), Z = solve(B[2]);
      const ju = new V(X[0], Y[0], Z[0]), jv = new V(X[1], Y[1], Z[1]);
      const pose = { pos: new V(), target: new V(), up: new V(), d: 0, ok: false };
      app.scene.focusPose(f, pose);
      const fwd = pose.target.clone().sub(pose.pos).normalize();
      const right = fwd.clone().cross(pose.up).normalize();
      const up = pose.up.clone().normalize();
      const u = rec.material.uniforms;
      out.nails[f] = {
        uRight: +(ju.clone().normalize().dot(right)).toFixed(3),
        vDown: +(-jv.clone().normalize().dot(up)).toFixed(3),
        handed: Math.sign(ju.clone().cross(jv).dot(fwd.clone().negate())),
        mask: (() => { const m = hm.getNailMask(hand, f); let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; })(),
        half: [+u.uNailHalf.value.x.toFixed(4), +u.uNailHalf.value.y.toFixed(4)],
        uvAspect: +rec.uvAspect.toFixed(3),
        verts: pos.count,
        frame: !!rec.frame,
        skinColor: (() => { let sk = null; model.traverse((o) => { if (o.isSkinnedMesh && !sk) sk = o; }); const c = sk && sk.geometry.attributes.color; return c ? c.itemSize : 0; })(),
      };
    }
    return out;
  });
}

const s = await boot();
const { page } = s;
const first = await handFacts(page);
if (SHOTS) {
  await page.evaluate(() => app.switchToFinger('index'));
  await page.evaluate(() => { window.__still = null; });
  await settle(page);
  await page.evaluate(() => app.polishBrush3D.clearNail()); // the intro's demo stripe
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-finger-index.png`) });
  await page.evaluate(() => app.scene.zoomOut());
  await page.evaluate(() => { window.__still = null; });
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-zoomed-out.png`) });
}
if (SHOTS && flags.fingers) {
  for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
    await page.evaluate((x) => app.switchToFinger(x), f);
    await page.evaluate(() => { window.__still = null; });
    await settle(page);
    await page.evaluate(() => app.polishBrush3D.clearNail());
    await sleep(200);
    await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-closeup-${f}-${TIER}.png`) });
  }
}
const other = first.hand === 'left' ? 'right' : 'left';
await showHand(page, other);
const second = await handFacts(page);
if (SHOTS) {
  await page.evaluate(() => app.scene.zoomOut());
  await page.evaluate(() => { window.__still = null; });
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-${other}-hand.png`) });
}
await showHand(page, first.hand);
if (SHOTS) {
  await page.evaluate(() => app.scene.zoomOut());
  await page.evaluate(() => { window.__still = null; });
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, `${PREFIX}-${first.hand}-hand.png`) });
}
await sleep(300);

add('H1', 'glb requests (both hands shown)', s.glb.length, '== 1', s.glb.length === 1);
const facts = { [first.hand]: first, [second.hand]: second };
for (const h of ['left', 'right']) {
  const f = facts[h];
  add('H2', `${h}: bones`, f.bones.length, '== 17', f.bones.length === 17);
  add('H2', `${h}: skin determinant`, +f.det.toFixed(3), h === 'left' ? '< 0' : '> 0', h === 'left' ? f.det < 0 : f.det > 0);
}
add('H7', 'skin vertex colour masks (components)', facts.left.nails.index ? facts.left.nails.index.skinColor : 0, '4', (facts.left.nails.index || {}).skinColor === 4);
add('H2', 'same bone names on both hands', facts.left.bones.join(',') === facts.right.bones.join(','), 'true', facts.left.bones.join(',') === facts.right.bones.join(','));
for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
  const L = facts.left.nails[f], R = facts.right.nails[f];
  if (!L || !R) { add('H4', `${f}: nail on both hands`, false, 'true', false); continue; }
  add('H3', `${f}: handedness L / R`, `${L.handed} / ${R.handed}`, 'equal', L.handed === R.handed);
  const upright = (n) => n.uRight > 0.7 && n.vDown > 0.7;
  add('H3', `${f}: +u right, +v down (L: ${L.uRight},${L.vDown}  R: ${R.uRight},${R.vDown})`, upright(L) && upright(R), UV_GATE ? 'true' : 'info', UV_GATE ? upright(L) && upright(R) : null);
  add('H4', `${f}: nail frame from the file (L / R)`, `${L.frame} / ${R.frame}`, 'true', L.frame && R.frame);
  add('H4', `${f}: mask cells L / R, half L, uvAspect L, verts`, `${L.mask} / ${R.mask}, ${L.half.join('x')}, ${L.uvAspect}, ${L.verts}`, '> 0', L.mask > 0 && R.mask > 0);
}
if (fs.existsSync(DIST)) {
  const models = path.join(DIST, 'models');
  const mb = fs.existsSync(models) ? dirSize(models) : 0;
  const db = dirSize(DIST);
  add('H5', 'dist/models bytes', mb, '<= 1,177,600', mb <= 1150 * 1024);
  add('H5', 'dist bytes', db, '<= 2,150,000', db <= 2150000);
} else add('H5', 'dist not found: ' + DIST, null, 'info', null);
add('H6', 'page errors', s.errors.length ? s.errors.slice(0, 3).join(' | ') : 0, '0', s.errors.length === 0);
add('H6', 'external requests', s.external.size, '0', s.external.size === 0);
await s.browser.close();

const pad = (x, n) => String(x).padEnd(n);
console.log(pad('id', 4) + pad('check', 72) + pad('value', 34) + pad('gate', 14) + 'ok');
for (const r of rows) console.log(pad(r.id, 4) + pad(r.what, 72) + pad(r.value, 34) + pad(r.gate, 14) + (r.ok === null ? '-' : r.ok ? 'PASS' : 'FAIL'));
if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${PREFIX}-hand.json`), JSON.stringify({ rows, facts }, null, 1));
console.log(failed ? `${failed} FAILED` : 'all gated checks pass');
process.exit(failed ? 1 : 0);
