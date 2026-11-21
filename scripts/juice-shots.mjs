// WP4 juice check: paints the active nail until 90% coverage, screenshots
// mid-stroke and at the sparkle burst, then holds the dryer, then places a gem
// and a sticker. Usage: node juice-shots.mjs <url> <outDir>
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:4184/?perf=1&tier=high';
const out = process.argv[3] || '.';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/home/claude/browsers/chrome-headless-shell-linux64/chrome-headless-shell',
  args: ['--use-angle=swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push('console: ' + m.text().slice(0, 300)); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.app && window.app.__ready === true && window.app.nail.getNailMesh(), null, { timeout: 60000 });
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const app = window.app;
  window.__log = { dryer: [], coverage: [], covered: 0, cured: 0, start: 0, stroke: 0, end: 0, deco: [] , programs0: app.scene.renderer.info.programs.length };
  const L = window.__log;
  app.events.on('nail:coverage', (p) => L.coverage.push(+p.coverage.toFixed(3)));
  app.events.on('nail:covered', () => { L.covered++; L.coveredAt = performance.now(); });
  app.events.on('nail:cured', () => L.cured++);
  app.events.on('brush:strokeStart', () => L.start++);
  app.events.on('brush:stroke', () => L.stroke++);
  app.events.on('brush:strokeEnd', () => L.end++);
  app.events.on('deco:placed', (p) => L.deco.push(p.type));
  app.events.on("dryer:start", () => L.dryer.push("start")); app.events.on("dryer:stop", (p) => L.dryer.push("stop" + (p.cured ? "-cured" : "")));
});

const box = await page.evaluate(() => {
  const app = window.app;
  const mesh = app.nail.getNailMesh();
  const cam = app.scene.camera;
  const rc = new app.polishBrush3D.raycaster.constructor();
  const canvas = document.querySelector('#canvas-container canvas');
  const r = canvas.getBoundingClientRect();
  const xs = [], ys = [];
  for (let gx = 0; gx <= 160; gx++) for (let gy = 0; gy <= 90; gy++) {
    const sx = r.left + r.width * gx / 160, sy = r.top + r.height * gy / 90;
    rc.setFromCamera({ x: (sx - r.left) / r.width * 2 - 1, y: -((sy - r.top) / r.height) * 2 + 1 }, cam);
    if (rc.intersectObject(mesh, false).length) { xs.push(sx); ys.push(sy); }
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
});
console.log('box', JSON.stringify(box));

// Zigzag over the nail, fast horizontal passes (flicks droplets).
const rows = 9;
let shotMid = false;
await page.mouse.move(box.x0 + 4, box.y0 + 4);
await page.mouse.down();
for (let r = 0; r <= rows; r++) {
  const y = box.y0 + 3 + (box.y1 - box.y0 - 6) * r / rows;
  const xa = r % 2 ? box.x1 - 3 : box.x0 + 3;
  const xb = r % 2 ? box.x0 + 3 : box.x1 - 3;
  await page.mouse.move(xa, y, { steps: 2 });
  let covered = 0;
  for (let k = 1; k <= 5 && !covered; k++) {
    await page.mouse.move(xa + (xb - xa) * k / 5, y);
    if (r === 4 && k === 3 && !shotMid) {
      shotMid = true;
      await page.screenshot({ path: `${out}/mid-stroke.png` });
    }
    covered = await page.evaluate(() => window.__log.covered);
  }
  if (covered) {
    await page.screenshot({ path: `${out}/burst-a.png` });
    await page.screenshot({ path: `${out}/burst-b.png` });
    break;
  }
}
await page.mouse.up();
await page.waitForTimeout(400);
let state = await page.evaluate(() => {
  const app = window.app;
  const h = app.nail.getCurrentHand(), f = app.nail.getActiveNail();
  return { cov: app.polishBrush3D.getCoverage(), wet: app.polishBrush3D.wetCure.get(h, f), dryer: document.querySelector('.juice-dryer').classList.contains('is-shown'), meter: document.querySelector('.polish-progress .coverage-text')?.textContent };
});
console.log('after paint', JSON.stringify(state));
await page.screenshot({ path: `${out}/wet.png` });
// let it set to tacky a bit
await page.waitForTimeout(3500);
// hold the dryer
const db = await page.evaluate(() => { const r = document.querySelector('.juice-dryer').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(db.x, db.y);
await page.mouse.down();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/dryer-hold.png` });
await page.waitForFunction(() => window.__log.cured > 0, null, { timeout: 8000 });
await page.screenshot({ path: `${out}/cured.png` });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/cured-settled.png` });
await page.mouse.up();
state = await page.evaluate(() => {
  const app = window.app;
  const h = app.nail.getCurrentHand(), f = app.nail.getActiveNail();
  return { wet: app.polishBrush3D.wetCure.get(h, f), dryer: document.querySelector('.juice-dryer').classList.contains('is-shown') };
});
console.log('after dryer', JSON.stringify(state));

// gem + sticker
await page.evaluate(() => { document.querySelector('[data-tool="bling"]').click(); });
await page.waitForTimeout(300);
await page.evaluate(() => { window.app.gemTool.selectGem('diamond'); window.app.stickerTool.selectSticker(null); });
const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
await page.mouse.move(cx - 10, cy);
await page.mouse.click(cx - 10, cy);
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/gem-pop.png` });
await page.evaluate(() => { window.app.gemTool.selectGem(null); window.app.stickerTool.selectSticker('heart'); });
await page.mouse.click(cx + 12, cy + 10);
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/sticker-pop.png` });
await page.waitForTimeout(800);
const log = await page.evaluate(() => { const L = window.__log; L.programs1 = window.app.scene.renderer.info.programs.length; L.coverage = L.coverage.length + ' events, last ' + L.coverage[L.coverage.length - 1]; return L; });
console.log(JSON.stringify(log));
console.log('errors', JSON.stringify(errors));
await browser.close();
