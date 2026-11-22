/**
 * main.js
 * Application entry point: the app spine (events, storage, quality, frame
 * loop), the scene and hand, the tools, the free-mode chrome, and the
 * feature glob (src/features/*.feature.js) that adds everything else.
 */
import { NailScene } from './scene/NailScene.js';
import { HandModel, FINGERS } from './scene/HandModel.js';
import { StickerTool } from './tools/StickerTool.js';
import { GemTool } from './tools/GemTool.js';
import { BrushTool } from './tools/BrushTool.js';
import { PolishBrush3D } from './tools/PolishBrush3D/index.js';
import { soundManager } from './audio/SoundManager.js';
import { GameEvents, EVENTS } from './core/GameEvents.js';
import { storage } from './core/Storage.js';
import { Quality } from './core/Quality.js';
import { FrameLoop } from './core/FrameLoop.js';
import { PolishPanel, pop } from './ui/panels/PolishPanel.js';
import { BlingPanel } from './ui/panels/BlingPanel.js';
import { DrawPanel } from './ui/panels/DrawPanel.js';
import { FingerMap } from './ui/panels/FingerMap.js';

class NailArtistApp {
  constructor() {
    this.__ready = false;

    this.currentTool = null;
    this.selectedColor = '#ff2a6d'; // Default neon demon pink

    // App spine (build plan 0.4)
    this.params = new URLSearchParams(window.location.search);
    this.perf = this.params.get('perf') === '1';
    this.events = new GameEvents();
    this.storage = storage;
    this.quality = new Quality({ storage: this.storage, events: this.events, params: this.params });
    this.loop = new FrameLoop({ quality: this.quality, perf: this.perf });
    this.sound = soundManager;
    this.invalidate = () => this.loop.invalidate();
    // 'round' (the game: clients, stars) or 'free' (the sandbox). WP6.
    this.mode = this.params.get('mode') === 'free' ? 'free' : 'round';

    // Initialize asynchronously
    this.init().catch((err) => console.error('Failed to start', err));
  }

  async init() {
    const container = document.getElementById('canvas-container');

    this.events.on(EVENTS.QUALITY_CHANGE, () => this.applyQuality());

    // Scene + renderer (antialias is fixed here from the starting tier)
    this.scene = new NailScene(container, {
      settings: this.quality.settings,
      invalidate: this.invalidate,
      probeContext: this.quality.takeProbeContext(),
    });
    this.quality.setRendererCaps(this.scene.renderer);
    this.scene.onContextRestored = () => this.polishBrush3D?.onContextRestored();

    // Hand model (left hand now, right hand on demand)
    this.nail = new HandModel({
      settings: this.quality.settings,
      renderer: this.scene.renderer,
      lighting: this.scene.nailLighting,
    });
    this.nail.onChange = this.invalidate;
    await this.nail.load();
    this.scene.add(this.nail.getMesh());

    this.setupNailSelection();

    // Initial active nail (index finger); nail:select is emitted once the
    // listeners exist (end of init).
    this.nail.setActiveNail(FINGERS.INDEX);
    this.zoomToFinger(FINGERS.INDEX);

    this.setupUI();
    this.setupTools();

    // Start on the polish tool, for real (brush live).
    this.selectTool('polish');
    this.setMode(this.mode);

    // The one frame loop: scene/camera (5), brush (10), features (50), render (90).
    this._updateScene = (dt) => this.scene.update(dt);
    this._updateBrush = (dt) => {
      if (this.polishBrush3D && this.polishBrush3D.isActive) this.polishBrush3D.update(dt);
    };
    this._render = () => this.scene.render();
    this.loop.add(this._updateScene, 5);
    this.loop.add(this._updateBrush, 10);
    this.loop.add(this._render, 90, { render: true });
    this.loop.start();

    // Features (each WP adds its own src/features/<name>.feature.js)
    const mods = import.meta.glob('./features/*.feature.js', { eager: true });
    Object.values(mods)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .forEach((m) => m.install(this));
    this.syncMute();
    this.events.emit(EVENTS.NAIL_SELECT, { hand: this.nail.getCurrentHand(), finger: this.nail.getActiveNail() });

    // Pre-warm: compile every program now so nothing compiles on the first stroke.
    this.polishBrush3D.prewarm();
    this.nail.precompileVariants(this.scene.renderer, this.scene.scene, this.scene.camera);
    try {
      await this.scene.renderer.compileAsync(this.scene.scene, this.scene.camera);
    } catch (err) {
      // compileAsync is an optimisation; rendering compiles anyway.
    }
    this.invalidate();
    this.quality.markLoaded();
    this.__ready = true;
  }

  /** Push the current quality settings into every module. */
  applyQuality() {
    const s = this.quality.settings;
    this.scene?.setQuality(s);
    this.nail?.setQuality(s);
    this.polishBrush3D?.setQuality(s);
    this.invalidate();
  }

  /** Any tap may change what is on screen (gems, stickers): redraw. */
  setupNailSelection() {
    const canvas = this.scene.renderer.domElement;
    canvas.addEventListener('pointerdown', this.invalidate);
    canvas.addEventListener('pointerup', this.invalidate);
  }

  /**
   * Zoom camera to focus on a specific finger's nail
   * @param {string} finger - Finger identifier
   */
  zoomToFinger(finger) {
    const nailPosition = this.nail.getNailWorldPosition(finger);
    if (nailPosition) {
      this.scene.focusOnPosition(nailPosition, finger);
    }
  }

  setupTools() {
    soundManager.init();

    // Decorations (free mode, and the round's sticker requests)
    this.stickerTool = new StickerTool(this.scene.scene, this.scene.camera, this.nail);
    this.gemTool = new GemTool(this.scene.scene, this.scene.camera, this.nail);
    this.brushTool = new BrushTool(this.scene.scene, this.scene.camera, this.nail);

    // The polish brush: bristle physics + fluid simulation
    this.polishBrush3D = new PolishBrush3D(
      this.scene.scene,
      this.scene.camera,
      this.nail,
      this.scene.renderer,
      { events: this.events, settings: this.quality.settings, invalidate: this.invalidate }
    );
    this.polishBrush3D.onCoverageChange = (coverage) => this.updateCoverageUI(coverage);
  }

  /**
   * Free-mode chrome (hidden in round mode by styles/game.css): tool rail,
   * option panels (src/ui/panels), finger map and actions. Icons only. The
   * mute button shows in both modes.
   */
  setupUI() {
    document.getElementById('toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-btn');
      // Clicking the live tool again is harmless (perf harness relies on it).
      if (!btn || btn.dataset.tool === this.currentTool) return;
      this.selectTool(btn.dataset.tool);
      soundManager.playClick();
      pop(btn);
    });

    document.getElementById('btn-clear')?.addEventListener('click', () => this.clearNail());

    document.getElementById('btn-done')?.addEventListener('click', () => {
      if (this.mode !== 'free' && this.events.listenerCount(EVENTS.UI_DONE) > 0) this.events.emit(EVENTS.UI_DONE);
      else soundManager.playSuccess();
    });

    document.getElementById('btn-gallery')?.addEventListener('click', () => {
      if (this.events.listenerCount(EVENTS.UI_GALLERY) > 0) this.events.emit(EVENTS.UI_GALLERY);
      else this.toggleGallery(true);
    });
    document.getElementById('gallery-close')?.addEventListener('click', () => this.toggleGallery(false));

    const mute = document.getElementById('btn-mute');
    mute?.addEventListener('click', () => {
      this.toggleMute();
      pop(mute);
    });

    this.fingerMap = new FingerMap(this, document.getElementById('finger-selector'));
    this.fingerMap.sync();

    const panel = document.getElementById('options-panel');
    this.panels = { polish: new PolishPanel(this), bling: new BlingPanel(this), brush: new DrawPanel(this) };
    for (const p of Object.values(this.panels)) {
      p.el.hidden = true;
      panel.appendChild(p.el);
    }
    dragScroll(panel);

    // Rotation and phone toolbars: settle, then re-fit the renderer once.
    let relayout = 0;
    const onLayout = () => {
      clearTimeout(relayout);
      relayout = setTimeout(() => {
        this.scene.onResize();
        this.invalidate();
      }, 120);
    };
    window.addEventListener('resize', onLayout);
    window.addEventListener('orientationchange', onLayout);
  }

  /**
   * Switch tools. Painting tools never orbit the camera.
   * @param {'polish'|'bling'|'brush'} tool
   */
  selectTool(tool) {
    if (tool === this.currentTool) return;
    this.currentTool = tool;

    document.querySelectorAll('.tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });

    this.stickerTool?.deactivate();
    this.gemTool?.deactivate();
    this.brushTool?.deactivate();
    this.polishBrush3D?.deactivate();

    if (tool === 'polish') this.polishBrush3D?.activate();
    else if (tool === 'bling') {
      // Both decoration tools listen; the bling panel picks which one places.
      this.stickerTool?.activate();
      this.gemTool?.activate();
    } else if (tool === 'brush') this.brushTool?.activate();

    this.scene.setRotateEnabled(false);
    this.updateOptionsPanel();
    this.events.emit(EVENTS.TOOL_CHANGE, { tool });
    this.invalidate();
  }

  /**
   * Round mode hides the sandbox chrome (styles/game.css) and scripts the
   * camera; free mode is the sandbox. The chrome stays in the DOM (the perf
   * harness clicks [data-tool="polish"]). Emits mode:change { mode }.
   * @param {'round'|'free'} mode
   */
  setMode(mode) {
    this.mode = mode === 'free' ? 'free' : 'round';
    const round = this.mode === 'round';
    document.body.classList.toggle('mode-round', round);
    document.body.classList.toggle('mode-free', !round);
    this.scene.controls.enabled = !round && !this.scene.isCameraLockedState();
    if (round) this.selectTool('polish');
    else this.updateOptionsPanel();
    this.events.emit(EVENTS.MODE_CHANGE, { mode: this.mode });
    this.invalidate();
  }

  /** Flip the player's mute and tell everyone (the audio feature applies it). */
  toggleMute() {
    const muted = !this.sound.isMuted('user');
    if (this.events.listenerCount(EVENTS.UI_MUTE) > 0) this.events.emit(EVENTS.UI_MUTE, { muted });
    else this.sound.setMuted(muted, 'user');
    this.syncMute();
    return muted;
  }

  /** The mute icon follows the sound manager (the user's choice persists). */
  syncMute() {
    document.body.classList.toggle('muted', this.sound.isMuted('user'));
  }

  /** Make a finger active on the current hand and tell everyone. */
  selectNail(finger) {
    this.nail.setActiveNail(finger);
    this.events.emit(EVENTS.NAIL_SELECT, { hand: this.nail.getCurrentHand(), finger: this.nail.getActiveNail() });
  }

  updateFingerSelectorUI() {
    this.fingerMap?.sync();
  }

  async switchHand(newHand) {
    if (newHand !== 'left' && newHand !== 'right') return;
    if (newHand === this.nail.getCurrentHand()) return;

    // Feedback right away; the right hand may still be loading.
    soundManager.playClick();
    try {
      await this.nail.switchHand(newHand);
    } catch (err) {
      console.error('Failed to switch hand', err);
      return;
    }
    if (!this.nail.nails[this.nail.activeNail]) return;
    this.events.emit(EVENTS.NAIL_SELECT, { hand: this.nail.getCurrentHand(), finger: this.nail.getActiveNail() });
    this.updateFingerSelectorUI();
    this.zoomToFinger(this.nail.activeNail);
  }

  switchToFinger(newFinger) {
    this.selectNail(newFinger);
    // Always zoom (even to the same finger: re-centres it)
    this.zoomToFinger(newFinger);
    this.updateFingerSelectorUI();
    this.updateOptionsPanel();
  }

  /** Show the active tool's panel (built once) and sync it to the tools. */
  updateOptionsPanel() {
    if (!this.panels) return;
    for (const [tool, p] of Object.entries(this.panels)) {
      const on = tool === this.currentTool;
      p.el.hidden = !on;
      if (on) p.sync();
    }
    if (this.currentTool === 'polish') this.updateCoverageUI(this.polishBrush3D.getCoverage() * 100);
  }

  /** @param {number} coverage 0..100 */
  updateCoverageUI(coverage) {
    this.panels?.polish.setCoverage(coverage);
  }

  clearNail() {
    // Paint first (sim + baked), then the legacy colour, then decorations.
    this.polishBrush3D?.clearNail();
    this.nail.clearPolish();
    this.nail.clearDrawing();
    this.updateCoverageUI(0);
    soundManager.playClick();
  }

  /** Fallback wall (the polaroid feature takes over ui:gallery). */
  toggleGallery(show) {
    document.getElementById('gallery-modal')?.classList.toggle('open', !!show);
  }
}

/**
 * Make a scrolling tray usable with a mouse: the wheel scrolls it sideways
 * when it scrolls sideways, and a mouse/pen drag scrolls it (past a 6 px
 * threshold, after which the click is swallowed so taps still select).
 * Touch keeps the browser's native pan.
 * @param {HTMLElement} el
 */
function dragScroll(el) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth + 1 || e.ctrlKey) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    el.scrollLeft += e.deltaMode === 1 ? d * 32 : d;
    e.preventDefault();
  }, { passive: false });

  let id = -1, x0 = 0, y0 = 0, l0 = 0, t0 = 0, dragging = false, swallow = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    id = e.pointerId;
    x0 = e.clientX; y0 = e.clientY; l0 = el.scrollLeft; t0 = el.scrollTop;
    dragging = false;
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!dragging && Math.hypot(dx, dy) > 6) {
      dragging = true;
      el.classList.add('dragging');
      try { el.setPointerCapture(id); } catch (err) { /* ignore */ }
    }
    if (dragging) {
      el.scrollLeft = l0 - dx;
      el.scrollTop = t0 - dy;
    }
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = -1;
    if (dragging) {
      swallow = true;
      setTimeout(() => { swallow = false; }, 0);
      el.classList.remove('dragging');
    }
    dragging = false;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new NailArtistApp();
});
