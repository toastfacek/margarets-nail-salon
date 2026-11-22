/**
 * game.feature.js (WP6): the loop and the first 30 seconds.
 *
 * Round mode (default): the game opens zoomed on a nail with a wet stripe
 * already painted and a ghost finger showing the drag; a client's bubble asks
 * for a look in pictures; a bottle tray picks colours; a pulsing heart is
 * Done; stars fill live; the next client slides in. A door icon flips to free
 * mode (today's sandbox). No words anywhere.
 *
 * Exposes `app.game` = { rounds, ghost, bubble, stars, between }.
 * `?perf=1`: no ghost, no auto-advance, no camera sway, intro stripe <= 0.5 s.
 */
import * as THREE from 'three';
import '../../styles/game.css';
import { EVENTS } from '../core/GameEvents.js';
import { PALETTE } from '../game/ClientRequests.js';
import { RoundManager, DONE_AT } from '../game/RoundManager.js';
import { GhostFinger } from '../ui/GhostFinger.js';
import { RequestBubble } from '../ui/RequestBubble.js';
import { StarMeter } from '../ui/StarMeter.js';
import { STICKERS } from '../tools/StickerTool.js';
import { touchLiftPx, TOUCH_LIFT } from '../tools/PolishBrush3D/BrushInputHandler.js';

export const order = 70;

const HEART = '<svg viewBox="0 0 64 64"><rect x="25" y="2" width="14" height="14" rx="3" fill="#5a2a82"/>'
  + '<path d="M32 60C14 47 5 38 5 26c0-8 6-13 13-13 6 0 11 3 14 8 3-5 8-8 14-8 7 0 13 5 13 13 0 12-9 21-27 34z" fill="#ff2a6d" stroke="#fff" stroke-width="3"/>'
  + '<path d="M15 25c0-4 3-7 7-7" stroke="#fff" stroke-width="4" stroke-linecap="round" fill="none" opacity=".8"/></svg>';
const DOOR = '<svg viewBox="0 0 32 32"><rect x="7" y="3" width="18" height="27" rx="2" fill="#c77dff"/><rect x="10" y="6" width="12" height="24" fill="#9d4edd"/><circle cx="19" cy="18" r="1.8" fill="#ffd700"/></svg>';

const SWAY = 0.0175;    // 1 degree each way

export function install(app) {
  const ev = app.events;
  const brush = app.polishBrush3D;
  const hm = app.nail;
  const scene = app.scene;
  const cam = scene.camera;
  const sm = app.sound;
  const perf = app.perf;
  const canvas = scene.renderer.domElement;
  const store = app.storage;

  // ----------------------------------------------------------------- UI --
  const layer = document.createElement('div');
  layer.className = 'g-ui';
  document.body.appendChild(layer);
  const bubble = new RequestBubble(layer);
  const stars = new StarMeter(layer);
  const ghost = new GhostFinger(layer);

  const tray = document.createElement('div');
  tray.className = 'g-tray';
  tray.innerHTML = PALETTE.map((c, i) => `<button class="g-bottle" data-i="${i}" style="--c:${c}"><i></i></button>`).join('')
    + '<button class="g-stk"></button>';
  layer.appendChild(tray);
  const bottles = Array.from(tray.querySelectorAll('.g-bottle'));
  const stk = tray.lastChild;

  const mk = (cls, svg) => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = svg;
    layer.appendChild(b);
    return b;
  };
  const heart = mk('g-done', HEART);
  for (const el of [bubble.el, stars.el, tray, heart]) el.classList.add('g-round');
  const door = mk('g-door', DOOR);

  const markBottle = () => {
    for (const b of bottles) b.classList.toggle('sel', PALETTE[b.dataset.i] === brush.color);
  };

  // ------------------------------------------------------------- rounds --
  let sessionRound = 0;
  let kidPainted = false;
  let heartHinted = false;
  let ghostSoon = false;

  const rounds = new RoundManager(app, {
    onArrive(req) {
      bubble.show(req);
      stars.reset();
      stars.show(true);
      heart.classList.remove('on');
      tray.dataset.f = req.finish;
      for (const b of bottles) b.classList.toggle('want', PALETTE[b.dataset.i] === req.color);
      // restart the "pick me" bounce
      tray.classList.remove('bob');
      void tray.offsetWidth;
      tray.classList.add('bob');
      stk.textContent = '';
      stk.classList.remove('sel');
      stk.classList.toggle('on', !!req.sticker);
      const st = req.sticker && STICKERS.find((x) => x.id === req.sticker);
      if (st) stk.textContent = st.emoji;
      bubble.setPip(req.fingers[0], false, true);
      markBottle();
    },
    onPaint() {
      kidPainted = false;
      ghostSoon = sessionRound === 0;
      heartHinted = sessionRound > 0;
    },
    onDone() {
      heart.classList.remove('on');
      ghost.hide();
      if (app.currentTool !== 'polish') app.selectTool('polish');
    },
    onLeave() {
      bubble.hide();
      stars.show(false);
      sessionRound++;
    },
    onAdvance(finger) {
      bubble.setPip(finger, rounds.coverage(finger) >= DONE_AT, true);
      ghost.hide();
    }
  });
  rounds.noAdvance = perf;

  app.game = { rounds, ghost, bubble, stars, between: null };

  // -------------------------------------------------------- nail geometry --
  // Screen-space frame of the active nail: centre, tip direction (from the
  // hand's centre through the nail), half length / width along it.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const hc = new THREE.Vector3();
  const geo = { cx: 0, cy: 0, dx: 0, dy: -1, L: 1, W: 1, top: 0, bottom: 0 };
  let rect = null;
  const toScreen = (p) => {
    p.project(cam);
    return [rect.left + (p.x + 1) * 0.5 * rect.width, rect.top + (1 - p.y) * 0.5 * rect.height];
  };
  function nailGeom() {
    const mesh = hm.getNailMesh();
    if (!mesh) return null;
    rect = canvas.getBoundingClientRect();
    mesh.updateWorldMatrix(true, false);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const [cx, cy] = toScreen(bb.getCenter(v).applyMatrix4(mesh.matrixWorld));
    box.setFromObject(hm.getMesh());
    const [hx, hy] = toScreen(box.getCenter(hc));
    let dx = cx - hx, dy = cy - hy;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    let L = 0, W = 0, top = Infinity, bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mesh.matrixWorld);
      const [x, y] = toScreen(v);
      L = Math.max(L, Math.abs((x - cx) * dx + (y - cy) * dy));
      W = Math.max(W, Math.abs(-(x - cx) * dy + (y - cy) * dx));
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    Object.assign(geo, { cx, cy, dx, dy, L, W, top, bottom });
    return geo;
  }
  /** Screen point at s (0 cuticle .. 1 tip) and t (-1..1 across). */
  const at = (g, s, t) => [g.cx + g.dx * (s * 2 - 1) * g.L * 0.8 - g.dy * t * g.W * 0.7, g.cy + g.dy * (s * 2 - 1) * g.L * 0.8 + g.dx * t * g.W * 0.7];

  function uvAt(x, y) {
    const hit = scene.getRaycaster({ clientX: x, clientY: y }).intersectObject(hm.getNailMesh(), false)[0];
    return hit && hit.uv ? [hit.uv.x, hit.uv.y] : null;
  }

  // --------------------------------------------------------------- ghost --
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  /** Fingertip y for a paint point at y: on touch the brush paints above the finger. */
  function tipY(g, y) {
    if (!coarse) return y;
    const full = Math.min(TOUCH_LIFT.maxPx, TOUCH_LIFT.fraction * (g.bottom - g.top));
    return y + touchLiftPx(y + full, g.top, g.bottom);
  }
  let ghostFrom = 0.2;
  let ghostLoops = 0;
  function showNailGhost() {
    if (perf || app.mode !== 'round' || rounds.state !== 'paint') return;
    const g = nailGeom();
    if (!g) return;
    const [x0, y0] = at(g, ghostFrom, 0);
    const [x1, y1] = at(g, 0.92, 0);
    ghost.show('drag', x0, tipY(g, y0), x1, tipY(g, y1));
  }
  function pointAt(el, kind) {
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    ghostLoops = 0;
    ghost.show(kind, r.left + r.width / 2, r.top + r.height / 2);
  }
  ghost.onLoop = (kind) => {
    ghostLoops++;
    if (kind === 'drag') showNailGhost();
    else if (ghostLoops >= 3) ghost.hide();
  };

  // -------------------------------------------------------------- intro --
  // First ever session: a wet zig-zag stripe over the cuticle-side 40% of
  // the nail, painted by autoStroke in under a second, brush left resting at
  // its end. Points are picked on screen and raycast to UV.
  let introPending = app.mode === 'round' && !store.get('seen.intro', false);
  let path = null;      // [[u, v], ...] or null
  let introT = 0, introSeg = 0, restX = 0, restY = 0;
  const introDur = perf ? 0.5 : 0.9;

  function startIntro() {
    introPending = false;
    const g = nailGeom();
    if (!g) return;
    const uv = [];
    for (let k = 0; k < 8; k++) {
      const [x, y] = at(g, k < 7 ? 0.06 + k * 0.06 : 0.42, k < 7 ? (k & 1 ? 0.8 : -0.8) : 0);
      const u = uvAt(x, y);
      if (u) uv.push(u);
      restX = x; restY = y;
    }
    if (uv.length < 2) return;
    path = uv;
    introT = introSeg = 0;
    ghostFrom = 0.45;
    app.quality.hold(2500);
  }
  function stepIntro(dt) {
    introT += dt;
    const n = path.length - 1;
    const p = Math.min(1, introT / introDur) * n;
    const k = Math.min(n - 1, p | 0);
    // finish the segments passed since last frame, then the current one
    for (; introSeg <= k; introSeg++) {
      const a = path[introSeg], b = path[introSeg + 1];
      brush.autoStroke(a[0], a[1], b[0], b[1], introSeg < k ? 1 : p - k);
    }
    introSeg = k;
    if (p >= n) {
      path = null;
      // rest the brush at the end of the stripe (a hover, not a press)
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: restX, clientY: restY, pointerType: 'mouse', bubbles: true }));
    }
  }

  // ------------------------------------------------------------- events --
  let idle = 0;
  let dryerPending = false;

  window.addEventListener('pointerdown', () => {
    idle = 0;
    if (ghost.kind === 'drag' || ghost.kind === 'tap') ghost.hide();
    ghostSoon = false;
  }, true);

  // the Done heart waits for the kid's own first stroke on the nail
  canvas.addEventListener('pointerdown', () => { kidPainted = true; });

  ev.on(EVENTS.NAIL_COVERAGE, (p) => {
    if (!rounds.request || p.hand !== rounds.hand || !rounds.wants(p.finger)) return;
    if (rounds.state !== 'paint' && rounds.state !== 'arrive') return;
    stars.set(rounds.average());
    bubble.setPip(p.finger, p.coverage >= DONE_AT, false);
    if (!rounds.ready && kidPainted && p.coverage >= 0.3 && rounds.state === 'paint') {
      rounds.ready = true;
      heart.classList.add('on');
    }
  });

  ev.on(EVENTS.DECO_PLACED, () => {
    if (app.mode === 'round' && app.currentTool === 'bling') {
      stk.classList.remove('sel');
      app.selectTool('polish');
    }
  });

  ev.on(EVENTS.MODE_CHANGE, ({ mode }) => {
    ghost.hide();
    door.classList.toggle('on', mode === 'free');
    if (mode === 'round' && rounds.state === 'paint') {
      const a = hm.getActiveNail();
      rounds.goTo(rounds.wants(a) ? a : rounds.request.fingers[0]);
    }
  });

  // ----------------------------------------------------------------- UI --
  tray.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b === stk) {
      if (!rounds.request || !rounds.request.sticker) return;
      app.selectTool('bling');
      app.gemTool?.selectGem(null);
      app.stickerTool?.selectSticker(rounds.request.sticker);
      stk.classList.add('sel');
      return;
    }
    const i = +b.dataset.i;
    if (app.currentTool !== 'polish') app.selectTool('polish');
    stk.classList.remove('sel');
    app.selectedColor = PALETTE[i];
    brush.setColor(PALETTE[i]);
    sm.uiTap(i);
    markBottle();
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  });
  heart.addEventListener('click', () => {
    sm.uiTap(7);
    ev.emit(EVENTS.UI_DONE);
  });
  door.addEventListener('click', () => {
    // only while painting: never during the celebration or a client change
    if (rounds.state !== 'paint') return;
    sm.uiTap(2);
    app.setMode(app.mode === 'round' ? 'free' : 'round');
  });

  // -------------------------------------------------------------- dryer --
  // First appearance: the ghost presses and holds it once.
  const dryer = document.querySelector('.juice-dryer');
  if (dryer) {
    new MutationObserver(() => {
      const shown = dryer.classList.contains('is-shown');
      if (shown && !store.get('seen.dryer', false) && !perf) dryerPending = true;
      if (!shown && ghost.kind === 'hold') ghost.hide();
    }).observe(dryer, { attributes: true, attributeFilter: ['class'] });
    dryer.addEventListener('pointerdown', () => {
      if (ghost.kind === 'hold') ghost.hide();
    });
  }

  // --------------------------------------------------------------- loop --
  let swayT = 0, swayA = 0;
  const Y = new THREE.Vector3(0, 1, 0);
  const tick = (dt) => {
    const down = !!(brush.inputHandler && brush.inputHandler.isPointerDown);
    let moved = rounds.update(dt, down);

    if (introPending && app.__ready && !scene.isAnimating && rounds.state === 'paint') startIntro();
    if (path) {
      stepIntro(dt);
      moved = true;
    }

    const round = app.mode === 'round' && rounds.state === 'paint';
    idle = round && !down && !brush.isPainting ? idle + dt : 0;
    if (!perf && round && !path && !introPending && !scene.isAnimating) {
      if (!ghost.shown && (ghostSoon ? idle > 0.4 : idle > 6 && rounds.coverage(hm.getActiveNail()) < 0.2)) {
        ghostSoon = false;
        showNailGhost();
      } else if (!heartHinted && rounds.ready && idle > 2.5 && rounds.average() >= 0.6) {
        // the nail looks done and the kid stopped: show the Done heart (once)
        heartHinted = true;
        pointAt(heart, 'tap');
      } else if (dryerPending && idle > 0.8 && (!ghost.shown || ghost.kind === 'drag') && dryer.classList.contains('is-shown')) {
        dryerPending = false;
        store.set('seen.dryer', true);
        pointAt(dryer, 'hold');
      }
    }

    // gentle idle sway (high only: medium renders on demand)
    if (!perf && round && app.quality.tier === 'high' && !down && !scene.isAnimating) {
      swayT += dt;
      const a = SWAY * Math.sin(swayT * 0.45);
      const t = scene.controls.target;
      cam.position.sub(t).applyAxisAngle(Y, a - swayA).add(t);
      cam.lookAt(t);
      swayA = a;
      moved = true;
    }
    if (moved) app.invalidate();
  };
  app.loop.add(tick, 55);

  // first client: already here, no slide
  rounds.arrive(true);
}
