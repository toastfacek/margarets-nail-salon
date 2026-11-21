/**
 * brushJuice.feature.js (WP4)
 * Makes every stroke answer back:
 *   - sparkle burst + glitter sweep the first time a nail crosses 90% coverage
 *   - wet shine that sets to tacky (PolishBrush3D.wetCure), cured by the dryer
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

const DRYER_SHOW_COVERAGE = 0.5;
const GLOW_COLOR = 0xb98cff;
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

/** Soft violet ring (transparent centre, so the nail stays visible). */
function makeGlowTexture() {
  const N = 64;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.3)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'DryerGlow';
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
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
  sparkles.prewarm(renderer, camera);
  app.sparkles = sparkles;

  // ----------------------------------------------------- decoration tools --
  const invalidate = app.invalidate;
  app.stickerTool?.connect?.({ events, sparkles, invalidate });
  app.gemTool?.connect?.({ events, sparkles, invalidate });
  app.gemTool?.prewarm?.(renderer, camera);
  app.brushTool?.connect?.({ invalidate });

  // --------------------------------------------------------- dryer glow --
  const glowTex = makeGlowTexture();
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: GLOW_COLOR,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.name = 'DryerGlow';
  glow.renderOrder = 15;
  glow.visible = true;
  scene.add(glow);
  try {
    renderer.compile(glow, camera, scene);
  } catch (err) {
    // optimisation only
  }
  glow.visible = false;
  let glowAlpha = 0;
  let glowTime = 0;
  const nailPos = new THREE.Vector3();
  const glowPos = new THREE.Vector3();

  function activeNailCenter(target) {
    const rec = hm.getNail(hm.getCurrentHand(), hm.getActiveNail());
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
  dryer.title = 'Dry';
  dryer.setAttribute('aria-label', 'Dry');
  dryer.innerHTML = DRYER_SVG;
  document.body.appendChild(dryer);

  let dryerShown = false;
  let holding = false;
  let dryerDirty = true;
  let meterDirty = false;

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
    invalidate();
  }

  function stopHold() {
    if (!holding) return;
    holding = false;
    dryer.classList.remove('is-holding');
    const hand = hm.getCurrentHand();
    const finger = hm.getActiveNail();
    if (wet.isDrying(hand, finger)) wet.stopCure(hand, finger);
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
    if (!rec) return;
    if (!hm.getNailWorldPosition(p.finger, nailPos)) return;
    sparkles.burst(nailPos, 34, brush.color);
    sparkles.sweep(rec.mesh, 22, 0xffffff, 0.45);
    invalidate();
  });

  events.on(EVENTS.NAIL_CURED, (p) => {
    if (p.hand === hm.getCurrentHand() && hm.getNailWorldPosition(p.finger, nailPos)) {
      sparkles.burst(nailPos, 28, 0xfff4ff);
    }
    if (p.hand === hm.getCurrentHand() && p.finger === hm.getActiveNail()) {
      holding = false;
      dryer.classList.remove('is-holding');
    }
    dryerDirty = true;
    invalidate();
  });

  const markDryer = () => { dryerDirty = true; };
  events.on(EVENTS.NAIL_COVERAGE, markDryer);
  events.on(EVENTS.BRUSH_STROKE_START, markDryer);
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
        glowMat.opacity = 0.85 * glowAlpha;
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
