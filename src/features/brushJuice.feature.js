/**
 * brushJuice.feature.js (WP4)
 * Makes every stroke answer back:
 *   - sparkle burst + glitter sweep the first time a nail crosses 90% coverage
 *   - wet shine that sets to tacky (PolishBrush3D.wetCure), cured by the dryer
 *     (the stroke's own fresh gloss comes from the polish film, brush plan B5)
 *   - flicked droplets land on the desk (BrushEffects floor)
 *   - the dryer: a big UV-lamp icon button, press and hold to cure the nail
 *   - decoration pops (sparkles for stickers and gems, gem pop-in)
 *   - the coverage meter shows the active nail's own coverage
 *   - the BrushTool's decoration uploads happen at most once per frame
 *
 * Integrates only through the spine: events, app.loop, app.quality.
 * Exposes `app.sparkles` (WP7's reveal uses it) and `app.brushJuice`
 * ({ sparkles, wet, cure(hand, finger, seconds), cureAll(hand, seconds) }).
 */
import * as THREE from 'three';
import '../../styles/juice.css';
import { EVENTS } from '../core/GameEvents.js';
import { Sparkles } from '../fx/Sparkles.js';
import { WET } from '../tools/PolishBrush3D/WetCure.js';

export const order = 60;

// Not in the plan's catalogue (requested by WP5, which plays the dryer sound):
// emitted when the dryer starts and stops blowing. Payload (reused object):
// { hand, finger, cured } — cured is true when it stopped because the nail cured.
export const DRYER_START = 'dryer:start';
export const DRYER_STOP = 'dryer:stop';

const DRYER_SHOW_COVERAGE = 0.5;
const GLOW_COLOR = 0xa64dff;
const GLOW_IN = 8;    // 1/s
const GLOW_OUT = 3;   // 1/s

const DRYER_SVG = `
<svg viewBox="0 0 84 84" aria-hidden="true">
  <circle cx="42" cy="42" r="38" fill="none" stroke="rgba(157,78,221,0.18)" stroke-width="5"/>
  <circle class="lamp-ring" cx="42" cy="42" r="38" fill="none" stroke="#c77dff" stroke-width="5"
          stroke-linecap="round" transform="rotate(-90 42 42)"/>
  <g class="lamp-body">
    <g class="lamp-rays" stroke="#b15cff" stroke-width="3" stroke-linecap="round">
      <line x1="30" y1="47" x2="26" y2="56"/>
      <line x1="42" y1="48" x2="42" y2="58"/>
      <line x1="54" y1="47" x2="58" y2="56"/>
    </g>
    <path d="M20 44 C20 27 30 19 42 19 C54 19 64 27 64 44 Z" fill="#9d4edd"/>
    <path d="M27 38 C28 29 34 24 41 23" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="3.5" stroke-linecap="round"/>
    <rect x="17" y="42" width="50" height="6" rx="3" fill="#7b2cbf"/>
    <circle cx="42" cy="64" r="4" fill="#ff6bd6"/>
  </g>
</svg>`;

// Radial alpha stops of the glow ring: [radius 0..1, alpha].
const GLOW_STOPS = [[0, 0], [0.45, 0.05], [0.7, 0.85], [0.85, 0.3], [1, 0]];

/**
 * Soft ring (transparent centre, so the nail stays visible), built straight
 * into a typed array: a 2D canvas at startup stalls the first GL sync.
 */
function makeGlowTexture() {
  const N = 64;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N * 2 - 1;
      const dy = (y + 0.5) / N * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      for (let k = 1; k < GLOW_STOPS.length; k++) {
        const s0 = GLOW_STOPS[k - 1], s1 = GLOW_STOPS[k];
        if (r <= s1[0]) {
          const t = (r - s0[0]) / (s1[0] - s0[0]);
          a = s0[1] + (s1[1] - s0[1]) * t;
          break;
        }
      }
      const o = (y * N + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  const tex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.name = 'DryerGlow';
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function install(app) {
  const brush = app.polishBrush3D;
  const hm = app.nail;
  const events = app.events;
  const renderer = app.scene.renderer;
  const camera = app.scene.camera;
  const scene = app.scene.scene;
  if (!brush || !hm || !events) return;
  const wet = brush.wetCure;

  // ------------------------------------------------------------ sparkles --
  const sparkles = new Sparkles(scene, camera, app.quality.settings);
  app.sparkles = sparkles;

  // ----------------------------------------------------- decoration tools --
  const invalidate = app.invalidate;
  app.stickerTool?.connect?.({ events, sparkles, invalidate });
  app.gemTool?.connect?.({ events, sparkles, invalidate });
  app.brushTool?.connect?.({ invalidate });

  // --------------------------------------------------------- dryer glow --
  const glowTex = makeGlowTexture();
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: GLOW_COLOR,
    transparent: true,
    opacity: 0,
    // normal blending: an additive glow turns white on the light salon backdrop
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.name = 'DryerGlow';
  glow.renderOrder = 15;
  glow.visible = true;
  scene.add(glow);
  glow.visible = false;

  // Every juice program (sparkles, droplets, dryer glow, gems) is compiled at
  // idle time right after load, not before the first paintable frame: shader
  // compiles are slow on weak GPUs, and none of these can appear in the first
  // second (droplets need a fast stroke, sparkles need 90% coverage).
  const warm = () => {
    sparkles.prewarm(renderer, camera);
    brush.brushEffects.prewarm(renderer, camera);
    glow.visible = true;
    try {
      renderer.compile(glow, camera, scene);
    } catch (err) {
      // optimisation only
    }
    glow.visible = false;
    app.gemTool?.prewarm?.(renderer, camera);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 1500 });
  else setTimeout(warm, 1000);
  let glowAlpha = 0;
  let glowTime = 0;
  const nailPos = new THREE.Vector3();
  const glowPos = new THREE.Vector3();

  function activeNailCenter(target) {
    return nailCenter(hm.getNail(hm.getCurrentHand(), hm.getActiveNail()), target);
  }

  /** World centre of a nail (bounding sphere); returns its world radius or null. */
  function nailCenter(rec, target) {
    if (!rec || !rec.mesh) return null;
    const mesh = rec.mesh;
    const geo = mesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    mesh.updateWorldMatrix(true, false);
    target.copy(geo.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
    return geo.boundingSphere.radius * mesh.matrixWorld.getMaxScaleOnAxis();
  }

  // -------------------------------------------------------------- dryer --
  const dryer = document.createElement('button');
  dryer.type = 'button';
  dryer.className = 'juice-dryer';
  dryer.setAttribute('aria-label', 'Dry');
  dryer.innerHTML = DRYER_SVG;
  document.body.appendChild(dryer);

  let dryerShown = false;
  let holding = false;
  let dryerDirty = true;
  let meterDirty = false;
  const dryerPayload = { hand: 'left', finger: 'index', cured: false };

  function emitDryer(name, hand, finger, cured) {
    dryerPayload.hand = hand;
    dryerPayload.finger = finger;
    dryerPayload.cured = cured;
    events.emit(name, dryerPayload);
  }

  function setShown(show) {
    if (show === dryerShown) return;
    dryerShown = show;
    dryer.classList.toggle('is-shown', show);
    if (!show) stopHold();
  }

  function refreshDryer() {
    dryerDirty = false;
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    const show = (wet.isWet(hand, finger) && brush.getCoverage(hand, finger) >= DRYER_SHOW_COVERAGE) || holding;
    setShown(show);
  }

  function startHold(e) {
    if (!dryerShown || holding) return;
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    if (!wet.isWet(hand, finger)) return;
    holding = true;
    if (e && e.pointerId !== undefined && dryer.setPointerCapture) {
      try { dryer.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    const ms = Math.round(WET.DRYER_TIME * Math.max(0.25, wet.get(hand, finger)) * 1000);
    dryer.style.setProperty('--juice-dry-ms', `${ms}ms`);
    dryer.classList.add('is-holding');
    wet.cure(hand, finger, WET.DRYER_TIME);
    glow.visible = true;
    emitDryer(DRYER_START, hand, finger, false);
    invalidate();
  }

  function stopHold() {
    if (!holding) return;
    holding = false;
    dryer.classList.remove('is-holding');
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    if (wet.isDrying(hand, finger)) wet.stopCure(hand, finger);
    emitDryer(DRYER_STOP, hand, finger, false);
    dryerDirty = true;
    invalidate();
  }

  dryer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startHold(e);
  });
  dryer.addEventListener('pointerup', stopHold);
  dryer.addEventListener('pointercancel', stopHold);
  dryer.addEventListener('lostpointercapture', stopHold);
  dryer.addEventListener('contextmenu', (e) => e.preventDefault());

  // The panel's legacy "Dry!" button cures the active nail too.
  const panel = document.getElementById('options-panel');
  if (panel) {
    panel.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest || !t.closest('#dry-btn')) return;
      wet.cure(hm.getCurrentHand(), hm.getActiveNail(), WET.DRYER_TIME * 0.5);
      invalidate();
    });
  }

  // ------------------------------------------------------------- events --
  events.on(EVENTS.NAIL_COVERED, (p) => {
    if (p.hand !== hm.getCurrentHand()) return;
    const rec = hm.getNail(p.hand, p.finger);
    if (nailCenter(rec, nailPos) === null) return;
    sparkles.burst(nailPos, 34, brush.color);
    sparkles.sweep(rec.mesh, 22, 0xffffff, 0.45);
    invalidate();
  });

  events.on(EVENTS.NAIL_CURED, (p) => {
    const rec = p.hand === hm.getCurrentHand() ? hm.getNail(p.hand, p.finger) : null;
    if (rec && nailCenter(rec, nailPos) !== null) {
      // the "ting": a glint sweeps the cured nail, then a small pop
      sparkles.sweep(rec.mesh, 26, 0xffffff, 0.35);
      sparkles.burst(nailPos, 22, 0xf3d9ff);
    }
    if (holding && p.hand === hm.getCurrentHand() && p.finger === hm.getActiveNail()) {
      holding = false;
      dryer.classList.remove('is-holding');
      emitDryer(DRYER_STOP, p.hand, p.finger, true);
    }
    dryerDirty = true;
    invalidate();
  });

  const markDryer = () => { dryerDirty = true; };
  events.on(EVENTS.NAIL_COVERAGE, markDryer);
  events.on(EVENTS.BRUSH_STROKE_START, markDryer);
  // flicked droplets land on the desk (its height is known once the scene is laid out)
  events.on(EVENTS.BRUSH_STROKE_START, () => {
    const desk = app.scene.backdrop && app.scene.backdrop.desk;
    if (desk) brush.brushEffects.setFloor(desk.position.y);
  });
  events.on(EVENTS.NAIL_SELECT, () => {
    stopHold();
    dryerDirty = true;
    meterDirty = true;
    app.gemTool?.refreshVisibility?.();
  });
  events.on(EVENTS.TOOL_CHANGE, () => {
    meterDirty = true;
  });
  events.on(EVENTS.QUALITY_CHANGE, () => {
    sparkles.setQuality(app.quality.settings);
  });

  // --------------------------------------------------------------- loop --
  const tick = (dt) => {
    let changed = false;
    if (wet.update(dt)) changed = true;

    // dryer glow: in while holding, out after
    const target = holding ? 1 : 0;
    if (glowAlpha !== target || holding) {
      const rate = holding ? GLOW_IN : GLOW_OUT;
      glowAlpha += (target - glowAlpha) * Math.min(1, dt * rate);
      if (!holding && glowAlpha < 0.01) glowAlpha = 0;
      glowTime += dt;
      const r = activeNailCenter(glowPos);
      if (r !== null && glowAlpha > 0) {
        glow.position.copy(glowPos);
        const pulse = 1 + 0.06 * Math.sin(glowTime * 7.5); // ~1.2 Hz
        glow.scale.setScalar(r * 2.6 * pulse);
        glowMat.opacity = 0.6 * glowAlpha;
        glow.visible = true;
      } else {
        glow.visible = false;
      }
      changed = true;
    }

    if (sparkles.update(dt)) changed = true;
    const gems = app.gemTool;
    if (gems && gems.update && gems.update(dt)) changed = true;
    const pen = app.brushTool;
    if (pen && pen.flush && pen.flush()) changed = true;

    if (dryerDirty) refreshDryer();
    if (meterDirty) {
      meterDirty = false;
      if (app.currentTool === 'polish' && app.updateCoverageUI) app.updateCoverageUI(brush.getCoverage() * 100);
    }
    if (changed) invalidate();
  };
  app.loop.add(tick, 50);

  // ------------------------------------------------------------ service --
  app.brushJuice = {
    sparkles,
    wet,
    cure(hand = hm.getCurrentHand(), finger = hm.getActiveNail(), seconds = WET.DRYER_TIME) {
      wet.cure(hand, finger, seconds);
      invalidate();
    },
    cureAll(hand = hm.getCurrentHand(), seconds = 0.6) {
      wet.cureAll(hand, seconds);
      invalidate();
    },
  };
}
