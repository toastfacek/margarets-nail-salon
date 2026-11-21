// Frame-time test for Margaret's Nail Salon.
// Usage: node perf.mjs <url> [label]
// Runs headless Chrome with a software GPU (SwiftShader), which is slow like a cheap
// Chromebook. Blocks every request that leaves the local server (like Poki does) and
// counts them. Paints strokes over the active nail for a few seconds and reports frame times.
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:4173/';
const label = process.argv[3] || 'run';
const host = new URL(url).host;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell',
  args: ['--use-angle=swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const external = new Set();
await page.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.host !== host && u.protocol.startsWith('http')) { external.add(u.host); return route.abort(); }
  return route.continue();
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.app && window.app.__ready !== false && window.app.nail && window.app.nail.getNailMesh && window.app.nail.getNailMesh(), null, { timeout: 60000 });
const loadMs = Date.now() - t0;
await page.waitForTimeout(1500);

async function measure(ms, paint) {
  await page.evaluate(() => {
    window.__ft = []; let last = performance.now();
    window.__ftStop = false;
    const loop = (t) => { window.__ft.push(t - last); last = t; if (!window.__ftStop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const start = Date.now();
  if (paint) {
    if (!box) throw new Error('nail not found on screen');
    const cx = (box.x0 + box.x1) / 2, w = (box.x1 - box.x0) * 0.35, h = (box.y1 - box.y0) * 0.35, cy = (box.y0 + box.y1) / 2;
    await page.mouse.move(cx, cy - h);
    await page.mouse.down();
    let i = 0;
    while (Date.now() - start < ms) {
      const a = i * 0.25;
      await page.mouse.move(cx + Math.sin(a) * w, cy + Math.cos(a * 0.7) * h, { steps: 2 });
      i++;
    }
    await page.mouse.up();
  } else {
    await page.waitForTimeout(ms);
  }
  const ft = await page.evaluate(() => { window.__ftStop = true; return window.__ft.slice(2); });
  ft.sort((a, b) => a - b);
  const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
  return { frames: ft.length, avgMs: +avg.toFixed(1), p95Ms: +ft[Math.floor(ft.length * 0.95)].toFixed(1), fps: +(1000 / avg).toFixed(1) };
}

const sceneOnly = await measure(3000, false);

// Start painting: pick the polish tool if the app has a tool bar, else assume brush is live.
await page.evaluate(() => {
  const b = document.querySelector('[data-tool="polish"]');
  if (b) b.click();
});
await page.waitForTimeout(2500); // let camera zoom settle

// Screen box of the active nail.
const box = await page.evaluate(() => {
  // Scan the screen with rays and keep the points that hit the active nail.
  const app = window.app;
  const mesh = app.nail.getNailMesh();
  const cam = app.scene?.camera || app.camera;
  const rc = window.__perfRaycaster || new (app.polishBrush3D?.raycaster?.constructor)();
  const canvas = document.querySelector('#canvas-container canvas');
  const r = canvas.getBoundingClientRect();
  const xs = [], ys = [];
  for (let gx = 0; gx <= 80; gx++) for (let gy = 0; gy <= 45; gy++) {
    const sx = r.left + r.width * gx / 80, sy = r.top + r.height * gy / 45;
    rc.setFromCamera({ x: (sx - r.left) / r.width * 2 - 1, y: -((sy - r.top) / r.height) * 2 + 1 }, cam);
    if (rc.intersectObject(mesh, false).length) { xs.push(sx); ys.push(sy); }
  }
  if (!xs.length) return null;
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), hits: xs.length };
});

// Optional renderer facts (only reported when the app exposes them).
const info = () => page.evaluate(() => {
  const r = window.app?.scene?.renderer;
  if (!r || !r.info) return null;
  return {
    programs: r.info.programs ? r.info.programs.length : null,
    calls: r.info.render.calls,
    textures: r.info.memory.textures,
    tier: window.app.quality?.tier ?? null,
    scale: window.app.quality?.scale ?? null,
  };
});
const heapNow = () => page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);

const idle = await measure(3000, false); // brush on, not painting
const infoBefore = await info();
const heapBefore = await heapNow();
const painting = await measure(6000, true);
const heap = await heapNow();
const infoAfter = await info();
await page.screenshot({ path: `shot-${label}.png` });

console.log(JSON.stringify({ label, loadMs, nailBox: box, sceneOnly, idle, painting, heapMB: heap, heapBeforePaintMB: heapBefore, rendererBeforePaint: infoBefore, rendererAfterPaint: infoAfter, blockedExternalHosts: [...external], pageErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
