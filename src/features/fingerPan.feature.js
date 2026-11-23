/**
 * fingerPan.feature.js (B7): smart pan between the five fingers.
 *
 * The close-up has the nail pointing down the screen, so the fingers sit side
 * by side. A drag that starts OFF the active nail (skin, background, another
 * nail) slides the camera along the row of fingertips, following the finger
 * 1:1 (NailScene's rail: finger to finger, blending their focus poses).
 * On release it glides (ease-out, ~0.35 s, carrying the flick) and lands on a
 * finger, which becomes the active nail. A drag that starts ON the active nail
 * (or within GRACE_PX of it) is always the brush's, never a pan.
 *
 *  - a tap on another nail glides to it; a tap on a dot glides to its finger
 *  - rubber band past the first / last finger, no wrap
 *  - round mode: only the client's nails (RoundManager.goTo, no zoom); free
 *    mode: all five
 *  - never while a stroke is live, during the reveal, the bowl, a client's
 *    slide or the intro stroke; a second finger does nothing
 *
 * Exposes `app.fingerPan` = { busy, goTo(finger), allowed() }.
 * No allocation per pointer move or per frame (one Raycaster, scratch arrays).
 */
import * as THREE from 'three';
import '../../styles/pan.css';
import { EVENTS } from '../core/GameEvents.js';
import { TOUCH_NUDGE_PX } from '../tools/PolishBrush3D/BrushInputHandler.js';

export const order = 72;

const SLOP_PX = 8;          // movement before a press off the nail becomes a pan
const GRACE_PX = 10;        // a press this close to the active nail still paints
const TAP_MS = 400;
const FLICK_PROJ = 0.2;     // s of the release speed a flick carries on
const PAGE_PX = 70;         // a drag this long along the row moves at least one finger...
const FLICK_PX_S = 380;     // ...and so does a flick this fast (px/s)
const RUBBER = 0.3;         // finger units: how far past the end finger the band stretches
const RUBBER_K = 0.55;      // band stiffness at the start (screen px per px)
const NEAR_TAP_PX = 36;     // a tap this close to another nail's centre counts as on it

export function install(app) {
  const scene = app.scene;
  const hm = app.nail;
  const brush = app.polishBrush3D;
  const canvas = scene.renderer.domElement;
  const body = document.body;
  const RAIL = scene.railFingers;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const hits = [];
  let rectL = 0, rectT = 0, rectW = 1, rectH = 1;

  // allowed rail indices (sorted), refreshed on each press
  const allowedIdx = [];
  const pan = {
    id: -1, touch: false, x0: 0, y0: 0, lx: 0, ly: 0, t0: 0,
    moved: false, caught: false, sStart: 0, sRaw: 0, sDisp: 0, rate: 1, gx: 0, gy: 0,
    // release speed: a short history of (time, s, px along)
    ht: new Float64Array(8), hs: new Float64Array(8), hn: 0,
  };
  let swallowClick = false;

  // ------------------------------------------------------------- rules --
  function rounds() {
    return app.game && app.game.rounds;
  }
  /** Rail indices the camera may stop at now (empty: no pan). */
  function allowed() {
    allowedIdx.length = 0;
    const hand = hm.getCurrentHand();
    if (app.mode === 'round') {
      const r = rounds();
      if (!r || !r.request) return allowedIdx;
      for (let i = 0; i < RAIL.length; i++) if (r.request.fingers.indexOf(RAIL[i]) !== -1 && hm.getNail(hand, RAIL[i])) allowedIdx.push(i);
    } else {
      for (let i = 0; i < RAIL.length; i++) if (hm.getNail(hand, RAIL[i])) allowedIdx.push(i);
    }
    return allowedIdx;
  }
  function strokeLive() {
    return !!((brush && brush.inputHandler && brush.inputHandler.isPointerDown) || (app.brushTool && app.brushTool.isDrawing));
  }
  function canPan() {
    if (!scene.isZoomedIn || scene.cameraHeld || !app.__ready) return false;
    if (body.classList.contains('revealing') || body.classList.contains('bowl-open')) return false;
    if (app.mode === 'round') {
      const r = rounds();
      if (!r || r.state !== 'paint') return false;
    }
    if ((brush && brush._autoActive) || strokeLive()) return false;
    return allowed().length > 0;
  }

  // ----------------------------------------------------------- picking --
  function refreshRect() {
    const r = canvas.getBoundingClientRect();
    rectL = r.left; rectT = r.top; rectW = r.width || 1; rectH = r.height || 1;
  }
  function hitMesh(mesh, x, y) {
    ndc.x = ((x - rectL) / rectW) * 2 - 1;
    ndc.y = -((y - rectT) / rectH) * 2 + 1;
    ray.setFromCamera(ndc, scene.camera);
    hits.length = 0;
    ray.intersectObject(mesh, false, hits);
    const h = hits.length > 0;
    hits.length = 0;
    return h;
  }
  /** On the active nail, or close enough that a kid meant it (paint, not pan). */
  function onActiveNail(x, y, touch) {
    const mesh = hm.getNailMesh();
    if (!mesh) return false;
    if (hitMesh(mesh, x, y)) return true;
    if (touch && hitMesh(mesh, x, y - TOUCH_NUDGE_PX)) return true;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      if (hitMesh(mesh, x + Math.cos(a) * GRACE_PX, y + Math.sin(a) * GRACE_PX)) return true;
    }
    return false;
  }
  /** The allowed nail (not the active one) under a tap, as a rail index, or -1. */
  function tapTarget(x, y) {
    const hand = hm.getCurrentHand();
    const active = hm.getActiveNail();
    let best = -1, bd = NEAR_TAP_PX * NEAR_TAP_PX;
    for (let k = 0; k < allowedIdx.length; k++) {
      const i = allowedIdx[k];
      const rec = hm.getNail(hand, RAIL[i]);
      if (!rec || RAIL[i] === active) continue;
      if (hitMesh(rec.mesh, x, y)) return i;
      if (!hm.getNailWorldPosition(RAIL[i], tmp)) continue;
      tmp.project(scene.camera);
      if (tmp.z > 1) continue;
      const sx = rectL + (tmp.x + 1) * 0.5 * rectW, sy = rectT + (1 - tmp.y) * 0.5 * rectH;
      const d2 = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------ motion --
  const lo = () => allowedIdx[0];
  const hi = () => allowedIdx[allowedIdx.length - 1];
  /** Rubber band: raw rail position -> shown position. */
  function band(s) {
    const a = lo(), b = hi();
    if (s < a) return a - RUBBER * (1 - 1 / (((a - s) * RUBBER_K) / RUBBER + 1));
    if (s > b) return b + RUBBER * (1 - 1 / (((s - b) * RUBBER_K) / RUBBER + 1));
    return s;
  }
  function nearestAllowed(s) {
    let best = allowedIdx[0], bd = Infinity;
    for (let k = 0; k < allowedIdx.length; k++) {
      const d = Math.abs(allowedIdx[k] - s);
      if (d < bd) { bd = d; best = allowedIdx[k]; }
    }
    return best;
  }
  function currentS() {
    if (scene.railS >= 0) return scene.railS;
    const i = RAIL.indexOf(hm.getActiveNail());
    return i >= 0 ? i : 1;
  }
  function pushHistory(t) {
    const k = pan.hn % 8;
    pan.ht[k] = t; pan.hs[k] = pan.sRaw;
    pan.hn++;
  }
  /** Release speed over the last ~90 ms: [s per second, px per second along the row]. */
  function releaseSpeed(now, out) {
    out[0] = 0; out[1] = 0;
    // (px along the row = s x the rail's screen rate at the release)
    const n = Math.min(8, pan.hn);
    if (n < 2) return out;
    const last = (pan.hn - 1) % 8;
    let first = last;
    for (let j = 1; j < n; j++) {
      const k = (pan.hn - 1 - j) % 8;
      if (pan.ht[last] - pan.ht[k] > 90) break;
      first = k;
    }
    // a finger that stopped before lifting does not flick
    if (now - pan.ht[last] > 60 || first === last) return out;
    const dt = (pan.ht[last] - pan.ht[first]) / 1000;
    if (dt <= 0) return out;
    out[0] = (pan.hs[last] - pan.hs[first]) / dt;
    out[1] = out[0] * pan.rate;
    return out;
  }
  const speed = [0, 0];

  // The drag holds on to the world point that was under the finger when it
  // started (on the plane facing the camera) and keeps it under the finger:
  // each move solves for the rail position that projects it there
  // (Gauss-Newton along the rail, from the last position). Roll, the row
  // the camera backing off between fingers are all in that projection.
  const grip = new THREE.Vector3();
  const pa = [0, 0], pb = [0, 0], pc = [0, 0];
  function solve(x, y) {
    let s = pan.sRaw;
    const h = 0.01;
    for (let it = 0; it < 4; it++) {
      if (!scene.railScreenOf(s, grip, pc) || !scene.railScreenOf(s - h, grip, pa) || !scene.railScreenOf(s + h, grip, pb)) break;
      const jx = (pb[0] - pa[0]) / (2 * h), jy = (pb[1] - pa[1]) / (2 * h);
      const jj = jx * jx + jy * jy;
      if (jj < 1e-6) break;
      pan.rate = Math.sqrt(jj);
      let ds = -((pc[0] - x) * jx + (pc[1] - y) * jy) / jj;
      ds = Math.max(-0.5, Math.min(0.5, ds));
      s += ds;
      if (Math.abs(ds) < 2e-4) break;
    }
    return s;
  }

  // ------------------------------------------------------------ select --
  /** Make rail finger i active (the camera is already going there). */
  function select(i) {
    const finger = RAIL[i];
    if (finger === hm.getActiveNail()) return;
    if (app.mode === 'round') {
      const r = rounds();
      if (r && r.state === 'paint') r.goTo(finger, false);
    } else {
      app.selectNail(finger);
      app.updateFingerSelectorUI?.();
      app.updateOptionsPanel?.();
    }
    app.sound.swish?.(0.3);
  }
  let pendingSelect = -1;
  /** Glide to rail finger i (tap, dot, release) with rail speed v0. */
  function glideTo(i, v0) {
    scene.invalidateRail();
    if (scene.railS < 0) scene.railS = currentS();
    const from = scene.railS;
    const d = i - from;
    // the flick carries on, but never backwards and never far past the finger
    let v = v0;
    if (v * d <= 0) v = 0;
    else if (Math.abs(v) * 0.35 > 2.4 * Math.abs(d)) v = Math.sign(v) * (2.4 * Math.abs(d)) / 0.35;
    // the finger becomes active when the camera lands on it (the nail
    // switch bakes the old nail's paint: done on the landing frame, not
    // on the first frame of the glide)
    pendingSelect = i;
    scene.railGlideTo(i, v);
    syncDots();
  }

  // ------------------------------------------------------------ events --
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pan.id >= 0 || strokeLive()) {
      // a second finger during a pan or a stroke does nothing: it never
      // paints, pans or pinches the camera (the brush ignores it already)
      if (pan.id >= 0 || e.pointerType === 'touch') e.stopImmediatePropagation();
      return;
    }
    if (!canPan()) return;
    refreshRect();
    const gliding = scene.isRailGliding();
    const touch = e.pointerType === 'touch';
    // on the active nail: the brush's (unless the camera is still gliding)
    if (!gliding && onActiveNail(e.clientX, e.clientY, touch)) return;
    e.stopImmediatePropagation();
    pan.id = e.pointerId;
    pan.touch = touch;
    pan.x0 = pan.lx = e.clientX;
    pan.y0 = pan.ly = e.clientY;
    pan.t0 = performance.now();
    pan.moved = false;
    pan.caught = gliding;
    pan.rate = 1;
    pan.hn = 0;
    scene.pointerDown = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    if (gliding) {
      // catch the glide where it is
      pan.sStart = pan.sRaw = pan.sDisp = scene.railS;
      scene.railGrab(scene.railS);
      scene.railSet(scene.railS);
    }
    app.invalidate();
  }

  function onMove(e) {
    if (e.pointerId !== pan.id) return;
    const x = e.clientX, y = e.clientY;
    if (!pan.moved) {
      if (Math.hypot(x - pan.x0, y - pan.y0) < SLOP_PX) return;
      pan.moved = true;
      body.classList.add('fp-panning');
      stow(true);
      if (!pan.caught) {
        scene.invalidateRail();
        pan.sStart = pan.sRaw = pan.sDisp = currentS();
        scene.railGrab(pan.sStart);
      }
      // hold on to what is under the finger now (no jump for the slop)
      if (!scene.pickPanPoint(x - rectL, y - rectT, grip)) grip.copy(scene.controls.target);
      pan.gx = pan.lx = x;
      pan.gy = pan.ly = y;
      pushHistory(e.timeStamp || performance.now());
      return;
    }
    pan.lx = x;
    pan.ly = y;
    pan.sRaw = solve(x - rectL, y - rectT);
    pan.sDisp = band(pan.sRaw);
    pushHistory(e.timeStamp || performance.now());
    scene.railSet(pan.sDisp);
    syncDots();
  }

  function onUp(e) {
    if (e.pointerId !== pan.id) return;
    pan.id = -1;
    body.classList.remove('fp-panning');
    try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (err) { /* gone */ }
    if (!canPanAfter()) { stow(false); app.invalidate(); return; }
    if (!pan.moved) {
      // a tap: on another nail, glide there; a caught glide carries on
      if (e.type === 'pointerup' && performance.now() - pan.t0 < TAP_MS) {
        const i = tapTarget(e.clientX, e.clientY);
        if (i >= 0) { glideTo(i, 0); return; }
      }
      if (pan.caught) glideTo(nearestAllowed(scene.railS), 0);
      return;
    }
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    releaseSpeed(e.timeStamp || performance.now(), speed);
    const start = Math.round(pan.sStart);
    let target = Math.round(Math.max(-1, Math.min(RAIL.length, pan.sDisp + Math.max(-1.5, Math.min(1.5, speed[0] * FLICK_PROJ)))));
    // a deliberate drag or a flick always reaches the next finger that way
    let sign = 0;
    if (Math.abs(speed[1]) >= FLICK_PX_S) sign = Math.sign(speed[1]);
    else if (Math.abs(pan.sRaw - pan.sStart) * pan.rate >= PAGE_PX) sign = Math.sign(pan.sRaw - pan.sStart);
    if (sign > 0 && target <= start) target = start + 1;
    if (sign < 0 && target >= start) target = start - 1;
    target = nearestAllowed(Math.max(lo(), Math.min(hi(), target)));
    // inside the band the camera springs back without the flick
    const inBand = pan.sRaw < lo() || pan.sRaw > hi();
    glideTo(target, inBand ? 0 : speed[0]);
  }
  function canPanAfter() {
    // the pan may have been interrupted (reveal, a client leaving)
    if (!scene.isZoomedIn || scene.cameraHeld || body.classList.contains('revealing')) return false;
    if (app.mode === 'round') {
      const r = rounds();
      if (!r || r.state !== 'paint') return false;
    }
    return allowed().length > 0;
  }

  canvas.addEventListener('pointerdown', onDown, { capture: true });
  canvas.addEventListener('pointermove', onMove, { capture: true });
  canvas.addEventListener('pointerup', onUp, { capture: true });
  canvas.addEventListener('pointercancel', onUp, { capture: true });
  canvas.addEventListener('lostpointercapture', onUp);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  // the click that ends a dragged pan is not a tap on the nail (stickers, gems)
  canvas.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopImmediatePropagation();
  }, { capture: true });

  // the brush is stowed while the camera travels (a drag or a glide) and
  // comes back where the pointer is once it lands
  let stowed = false;
  const stow = (on) => {
    stowed = on;
    if (brush && brush.setStowed) brush.setStowed(on);
  };
  // watchdog: a glide cut short by someone else's flight (bowl, reveal)
  // never lands, so the brush comes back as soon as nothing travels
  app.loop.add(() => {
    if (stowed && pan.id < 0 && !scene.isRailGliding()) {
      pendingSelect = -1;
      stow(false);
    }
  }, 7);
  scene.onRailGlide = () => stow(true);
  scene.onRailSettle = (finger) => {
    if (pendingSelect >= 0 && RAIL[pendingSelect] === finger && canPanAfter()) select(pendingSelect);
    pendingSelect = -1;
    stow(false);
    syncDots();
    app.invalidate();
  };

  // -------------------------------------------------------------- dots --
  // Round mode with 2+ nails: one dot per nail of the client's request, the
  // active one filled. Wordless; each is a 48 px tap target.
  const dots = document.createElement('div');
  dots.className = 'fp-dots';
  dots.setAttribute('aria-label', 'fingers');
  const dotEls = RAIL.map((f, i) => {
    const b = document.createElement('button');
    b.className = 'fp-dot';
    b.dataset.i = i;
    b.setAttribute('aria-label', f);
    b.innerHTML = '<i></i>';
    dots.appendChild(b);
    return b;
  });
  body.appendChild(dots);
  dots.addEventListener('click', (e) => {
    const b = e.target.closest('.fp-dot');
    if (!b || !canPan()) return;
    const i = +b.dataset.i;
    if (allowedIdx.indexOf(i) === -1) return;
    app.sound.uiTap?.(2);
    glideTo(i, 0);
  });
  // last shown state (no string keys: this runs on pointer moves)
  const shown = { on: false, req: -2, cur: -2, rtl: false, hand: '' };
  function syncDots() {
    const r = rounds();
    const req = r && r.request;
    const show = app.mode === 'round' && !!req && req.fingers.length > 1 && (r.state === 'paint' || r.state === 'arrive');
    const s = scene.railS >= 0 ? scene.railS : currentS();
    const cur = Math.round(s);
    const hand = hm.getCurrentHand();
    const reqI = req ? req.index : -1;
    if (show === shown.on && reqI === shown.req && cur === shown.cur && hand === shown.hand) return;
    // the row on screen: does the hand run thumb to pinky left to right?
    let rtl = false;
    if (show && hm.getNailWorldPosition(RAIL[0], tmp)) {
      const x0 = tmp.project(scene.camera).x;
      if (hm.getNailWorldPosition(RAIL[RAIL.length - 1], tmp)) rtl = tmp.project(scene.camera).x < x0;
    }
    shown.on = show; shown.req = reqI; shown.cur = cur; shown.rtl = rtl; shown.hand = hand;
    dots.classList.toggle('on', show);
    dots.classList.toggle('rtl', rtl);
    for (let i = 0; i < dotEls.length; i++) {
      const want = show && req.fingers.indexOf(RAIL[i]) !== -1;
      dotEls[i].hidden = !want;
      dotEls[i].classList.toggle('on', want && i === cur);
    }
  }
  app.events.on(EVENTS.NAIL_SELECT, syncDots);
  app.events.on(EVENTS.MODE_CHANGE, syncDots);
  app.events.on(EVENTS.ROUND_START, syncDots);
  app.events.on(EVENTS.ROUND_END, () => { dots.classList.remove('on'); shown.on = false; });
  app.events.on(EVENTS.REVEAL_START, () => {
    // a pan in progress ends where it is; the reveal owns the camera
    pan.id = -1;
    body.classList.remove('fp-panning');
    stow(false);
  });
  syncDots();

  app.fingerPan = {
    get busy() { return pan.id >= 0 || scene.isRailGliding(); },
    /** Glide to a finger the current rules allow (tests, UI). */
    goTo(finger) {
      if (!canPan()) return false;
      const i = RAIL.indexOf(finger);
      if (allowedIdx.indexOf(i) === -1) return false;
      glideTo(i, 0);
      return true;
    },
    allowed() { return canPan() ? allowedIdx.map((i) => RAIL[i]) : []; },
    /** Test hook: mid-drag, where the gripped point shows vs the finger (CSS px). */
    track() {
      if (pan.id < 0 || !pan.moved) return null;
      tmp.copy(grip).project(scene.camera);
      return { start: [pan.gx, pan.gy], pointer: [pan.lx, pan.ly], grip: [rectL + (tmp.x + 1) * 0.5 * rectW, rectT + (1 - tmp.y) * 0.5 * rectH], s: pan.sDisp };
    },
  };
}
