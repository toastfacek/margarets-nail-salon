/**
 * main.js
 * Application entry point - initializes scene, nail, and UI
 */
import { NailScene } from './scene/NailScene.js';
import { HandModel, FINGERS, NAIL_SHAPES } from './scene/HandModel.js';
import { StickerTool, STICKERS } from './tools/StickerTool.js';
import { GemTool, GEM_TYPES } from './tools/GemTool.js';
import { BrushTool, PEN_MATERIALS, PEN_COLORS } from './tools/BrushTool.js';
import { PolishTool } from './tools/PolishTool.js';
import { PolishBrush3D } from './tools/PolishBrush3D/index.js';
import { POLISH_LAYERS, LAYER_ORDER } from './state/PolishLayerState.js';
import { soundManager } from './audio/SoundManager.js';
import { GameEvents, EVENTS } from './core/GameEvents.js';
import { storage } from './core/Storage.js';
import { Quality } from './core/Quality.js';
import { FrameLoop } from './core/FrameLoop.js';

class NailArtistApp {
  constructor() {
    this.__ready = false;

    this.currentTool = null;
    this.selectedShape = NAIL_SHAPES.ROUND;
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

    // Set initial active nail (index finger) and zoom to it
    this.nail.setActiveNail(FINGERS.INDEX);
    this.zoomToFinger(FINGERS.INDEX);

    this.setupUI();
    this.setupTools();

    // Start on the polish tool, for real (brush live).
    this.selectTool('polish');

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

    // Pre-warm: compile every program now so nothing compiles on the first stroke.
    this.polishBrush3D.prewarm();
    this.nail.precompileVariants(this.scene.renderer, this.scene.scene, this.scene.camera);
    try {
      await this.scene.renderer.compileAsync(this.scene.scene, this.scene.camera);
    } catch (err) {
      // compileAsync is an optimisation; rendering compiles anyway.
    }
    this.invalidate();
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

  /**
   * Set up click-to-select nail functionality with zoom
   */
  setupNailSelection() {
    const canvas = this.scene.renderer.domElement;

    // Any tap may change what is on screen (gems, stickers): redraw.
    canvas.addEventListener('pointerdown', this.invalidate);
    canvas.addEventListener('pointerup', this.invalidate);

    canvas.addEventListener('click', (event) => {
      // Don't select nails while using decoration/painting tools
      if (this.currentTool === 'brush' || this.currentTool === 'bling' || this.currentTool === 'polish') {
        return;
      }

      const raycaster = this.scene.getRaycaster(event);
      const nailMeshes = this.nail.getNailMeshes();
      const intersects = raycaster.intersectObjects(nailMeshes, false);

      if (intersects.length > 0) {
        const clickedMesh = intersects[0].object;
        const finger = this.nail.getFingerFromMesh(clickedMesh);

        if (finger) {
          this.selectNail(finger);
          soundManager.playClick();
          this.zoomToFinger(finger);
          this.updateFingerSelectorUI();
        }
      }
    });

    // Double-click to zoom out
    canvas.addEventListener('dblclick', (event) => {
      if (this.scene.getIsZoomedIn()) {
        this.zoomOut();
        soundManager.playClick();
      }
    });
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

  /**
   * Zoom out to show the full hand
   */
  zoomOut() {
    this.scene.zoomOut();
  }

  setupTools() {
    // Initialize sound manager
    soundManager.init();

    // Create sticker tool
    this.stickerTool = new StickerTool(this.scene.scene, this.scene.camera, this.nail);

    // Create gem tool
    this.gemTool = new GemTool(this.scene.scene, this.scene.camera, this.nail);

    // Create brush tool
    this.brushTool = new BrushTool(this.scene.scene, this.scene.camera, this.nail);

    // Create polish tool (realistic painting)
    this.polishTool = new PolishTool(this.scene.scene, this.scene.camera, this.nail);

    // Create 3D brush for polish (bristle physics + fluid simulation)
    this.polishBrush3D = new PolishBrush3D(
      this.scene.scene,
      this.scene.camera,
      this.nail,
      this.scene.renderer,
      { events: this.events, settings: this.quality.settings, invalidate: this.invalidate }
    );

    // Set up polish tool callbacks
    this.polishTool.onCoverageChange = (coverage) => {
      this.updateCoverageUI(coverage);
    };
    this.polishTool.onDryStateChange = (isDry) => {
      this.updateDryButtonUI(isDry);
    };

    // Set up 3D brush callbacks
    this.polishBrush3D.onCoverageChange = (coverage) => {
      this.updateCoverageUI(coverage);
    };
  }

  setupUI() {
    // Tool selection
    const toolButtons = document.querySelectorAll('.tool-btn');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Clicking the live tool again is harmless (perf harness relies on it).
        if (btn.dataset.tool === this.currentTool) return;
        this.selectTool(btn.dataset.tool);
        soundManager.playClick();

        // Satisfying click animation
        btn.style.animation = 'none';
        btn.offsetHeight; // Trigger reflow
        btn.style.animation = 'pop-in 0.3s ease';
      });
    });

    // Action buttons
    document.getElementById('btn-clear')?.addEventListener('click', () => {
      this.clearNail();
    });

    document.getElementById('btn-undo')?.addEventListener('click', () => {
      // Undo arrives with WP8.
    });

    document.getElementById('btn-done')?.addEventListener('click', () => {
      if (this.events.listenerCount(EVENTS.UI_DONE) > 0) this.events.emit(EVENTS.UI_DONE);
      else this.showCelebration();
    });

    document.getElementById('btn-gallery')?.addEventListener('click', () => {
      if (this.events.listenerCount(EVENTS.UI_GALLERY) > 0) this.events.emit(EVENTS.UI_GALLERY);
      else this.toggleGallery(true);
    });

    document.getElementById('gallery-close')?.addEventListener('click', () => {
      this.toggleGallery(false);
    });

    // Finger selector
    this.setupFingerSelector();

    // Initial options panel
    this.updateOptionsPanel();
  }

  /**
   * Switch tools. Painting tools never orbit the camera.
   * @param {'shape'|'polish'|'bling'|'brush'} tool
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
    this.polishTool?.deactivate();
    this.polishBrush3D?.deactivate();

    switch (tool) {
      case 'polish':
        this.polishBrush3D?.activate();
        break;
      case 'bling':
        // Both sticker and gem tools listen, UI determines which is active
        this.stickerTool?.activate();
        this.gemTool?.activate();
        break;
      case 'brush':
        this.brushTool?.activate();
        break;
      default:
        break;
    }

    this.scene.setRotateEnabled(tool === 'shape');
    this.updateOptionsPanel();
    this.events.emit(EVENTS.TOOL_CHANGE, { tool });
    this.invalidate();
  }

  /** Make a finger active on the current hand and tell everyone. */
  selectNail(finger) {
    this.nail.setActiveNail(finger);
    this.events.emit(EVENTS.NAIL_SELECT, { hand: this.nail.getCurrentHand(), finger: this.nail.getActiveNail() });
  }

  /**
   * Toggle camera lock state
   */
  toggleCameraLock() {
    const isLocked = this.scene.isCameraLockedState();
    this.scene.setCameraLocked(!isLocked);

    // Update button UI
    const btn = document.getElementById('btn-lock');
    if (btn) {
      const icon = btn.querySelector('span:first-child');
      const label = btn.querySelector('span:last-child');
      if (icon) icon.textContent = !isLocked ? '🔒' : '🔓';
      if (label) label.textContent = !isLocked ? 'Unlock' : 'Lock';
      btn.classList.toggle('active', !isLocked);
    }

    soundManager.playClick();
  }

  setupFingerSelector() {
    // Camera lock button
    document.getElementById('btn-lock')?.addEventListener('click', () => {
      this.toggleCameraLock();
    });

    // Hand toggle button
    const handToggleBtn = document.getElementById('hand-toggle');
    handToggleBtn?.addEventListener('click', () => {
      const currentHand = this.nail.getCurrentHand();
      const newHand = currentHand === 'left' ? 'right' : 'left';
      this.switchHand(newHand);
    });

    // Finger buttons
    const fingerButtons = document.querySelectorAll('.finger-btn');
    fingerButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const finger = btn.dataset.finger;
        if (finger) {
          this.switchToFinger(finger);
          soundManager.playClick();
        }
      });
    });

    // Update UI to match current state
    this.updateFingerSelectorUI();
  }

  updateFingerSelectorUI() {
    const currentFinger = this.nail.getActiveNail();

    // Update finger button active states
    const fingerButtons = document.querySelectorAll('.finger-btn');
    fingerButtons.forEach(btn => {
      if (btn.dataset.finger === currentFinger) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  updateHandToggleUI() {
    const currentHand = this.nail.getCurrentHand();
    const handLabel = document.querySelector('.hand-label');
    const handEmoji = document.querySelector('.hand-emoji');

    if (handLabel) {
      handLabel.textContent = currentHand === 'left' ? 'Left' : 'Right';
    }
    if (handEmoji) {
      // Use different emoji for left vs right hand
      handEmoji.textContent = currentHand === 'left' ? '✋' : '🤚';
    }
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

    // Update UI
    this.updateFingerSelectorUI();
    this.updateHandToggleUI();

    // Zoom to the active nail on the new hand
    this.zoomToFinger(this.nail.activeNail);
  }

  switchToFinger(newFinger) {
    this.selectNail(newFinger);

    // Always zoom to the finger (even if same finger - allows re-centering)
    this.zoomToFinger(newFinger);

    // Update UI
    this.updateFingerSelectorUI();
    this.updateOptionsPanel();
  }

  saveCurrentFingerDesign() {
    // Design state is now per-nail in HandModel, no need to save externally
  }

  async restoreCurrentFingerDesign() {
    // Design state is now per-nail in HandModel, no need to restore
  }

  updateOptionsPanel() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    switch (this.currentTool) {
      case 'shape':
        this.renderShapeOptions();
        break;
      case 'polish':
        this.renderPolishOptions();
        break;
      case 'bling':
        this.renderBlingOptions();
        break;
      case 'brush':
        this.renderBrushOptions();
        break;
      default:
        panel.innerHTML = '<p>Select a tool to begin!</p>';
    }
  }

  renderShapeOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    const shapes = [
      { id: 'round', label: 'Round', icon: '⭕' },
      { id: 'square', label: 'Square', icon: '⬜' },
      { id: 'almond', label: 'Almond', icon: '🥜' },
      { id: 'stiletto', label: 'Stiletto', icon: '📍' },
      { id: 'coffin', label: 'Coffin', icon: '⬡' }
    ];

    const currentShape = this.nail.getShape();

    panel.innerHTML = `
      <h3>Shape</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Choose your nail shape!
      </p>
      <div class="shape-grid">
        ${shapes.map(s => {
          const isAvailable = this.nail.isShapeAvailable(s.id);
          const isActive = s.id === currentShape;
          return `
            <button class="shape-btn shape-select-btn ${isActive ? 'active' : ''} ${!isAvailable ? 'unavailable' : ''}"
                    data-shape="${s.id}"
                    ${!isAvailable ? 'disabled' : ''}>
              <span class="shape-icon">${s.icon}</span>
              <span class="shape-label">${s.label}</span>
              ${!isAvailable ? '<span class="coming-soon">Coming Soon</span>' : ''}
            </button>
          `;
        }).join('')}
      </div>
    `;

    // Add click handlers for available shapes
    panel.querySelectorAll('.shape-select-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', async () => {
        const shape = btn.dataset.shape;
        if (shape === currentShape) return;

        // Show loading state
        btn.classList.add('loading');

        try {
          const changed = await this.nail.setShape(shape);
          if (changed) {
            soundManager.playClick();
          }
          // Re-render to update active state
          this.renderShapeOptions();
        } catch (error) {
          console.error('Failed to change shape:', error);
          btn.classList.remove('loading');
        }
      });
    });
  }

  renderPolishOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    // Glam color palette - bright, fun, K-pop vibes
    const colors = [
      // Hot Pinks & Reds
      '#ff2a6d', '#ff6b9d', '#ff1493', '#ff6b6b',
      // Pretty Purples
      '#9d4edd', '#c77dff', '#e0aaff', '#dda0dd',
      // Sky Blues
      '#00b4d8', '#48cae4', '#90e0ef', '#7b68ee',
      // Fresh Greens & Teals
      '#00f5d4', '#00cec9', '#55efc4', '#81ecec',
      // Sunset & Gold
      '#ffd700', '#ffb347', '#ff9ff3', '#fd79a8',
      // Basics
      '#ffffff', '#ffeef8', '#2d1f3d', '#000000',
    ];

    const finishes = [
      { id: 'glossy', name: 'Glossy' },
      { id: 'matte', name: 'Matte' },
      { id: 'shimmer', name: 'Shimmer' },
      { id: 'chrome', name: 'Chrome' },
    ];

    // Get polish tool state
    const polishState = this.polishTool?.getState();
    const activeLayer = polishState?.activeLayer || POLISH_LAYERS.COLOR_1;
    const coverage = this.polishTool?.getCoverage() || 0;
    const isLayerDry = this.polishTool?.isLayerDry() ?? true;

    // Layer display names
    const layerNames = {
      [POLISH_LAYERS.BASE_COAT]: 'Base Coat',
      [POLISH_LAYERS.COLOR_1]: 'Color 1',
      [POLISH_LAYERS.COLOR_2]: 'Color 2',
      [POLISH_LAYERS.TOP_COAT]: 'Top Coat',
    };

    panel.innerHTML = `
      <h3>Polish</h3>

      <!-- Layer Tabs -->
      <div class="polish-layer-tabs">
        ${LAYER_ORDER.map(layer => `
          <button
            class="layer-tab ${activeLayer === layer ? 'active' : ''}"
            data-layer="${layer}"
          >
            ${layerNames[layer]}
          </button>
        `).join('')}
      </div>

      <!-- Coverage Progress -->
      <div class="polish-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.min(100, coverage)}%"></div>
        </div>
        <span class="coverage-text">${Math.round(coverage)}%</span>
      </div>

      <!-- Action Buttons -->
      <div class="polish-actions">
        <button class="polish-action-btn fill-btn" id="quick-fill-btn">
          <span>Fill</span>
        </button>
        <button class="polish-action-btn dry-btn ${isLayerDry ? 'dried' : 'pulse'}" id="dry-btn">
          <span>${isLayerDry ? 'Dry!' : 'Dry!'}</span>
        </button>
        <button class="polish-action-btn undo-btn" id="polish-undo-btn">
          <span>Undo</span>
        </button>
      </div>

      <!-- Color Palette (only show for color layers) -->
      <h4 style="margin-top: 12px;">Color</h4>
      <div class="color-grid">
        ${colors.map(c => `
          <button
            class="color-swatch ${this.selectedColor === c ? 'active' : ''}"
            data-color="${c}"
            style="background-color: ${c}"
            title="${c}"
          ></button>
        `).join('')}
      </div>

      <h4 style="margin-top: 16px;">Finish</h4>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        ${finishes.map(f => `
          <button
            class="shape-btn finish-btn"
            data-finish="${f.id}"
            style="flex: 1; min-width: 80px; font-size: 0.7rem;"
          >
            ${f.name}
          </button>
        `).join('')}
      </div>

      <p style="font-size: 0.7rem; color: var(--text-muted); margin-top: 12px; text-align: center;">
        Paint on the nail to apply polish!
      </p>
    `;

    // Layer tab selection
    panel.querySelectorAll('.layer-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.layer-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.polishTool?.setActiveLayer(btn.dataset.layer);
        soundManager.playClick();

        // Update coverage display for new layer
        this.updateCoverageUI(this.polishTool?.getCoverage() || 0);
      });
    });

    // Quick fill button
    document.getElementById('quick-fill-btn')?.addEventListener('click', () => {
      this.polishBrush3D?.fillNail(this.selectedColor);
      soundManager.playClick();
    });

    // Dry button
    document.getElementById('dry-btn')?.addEventListener('click', () => {
      this.polishTool?.instantDry();
      this.updateDryButtonUI(true);
    });

    // Undo button
    document.getElementById('polish-undo-btn')?.addEventListener('click', () => {
      // Undo arrives with WP8.
    });

    // Color selection
    panel.querySelectorAll('.color-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.selectedColor = btn.dataset.color;
        this.polishTool?.setColor(this.selectedColor);
        this.polishBrush3D?.setColor(this.selectedColor);

        // Play polish sound
        soundManager.playClick();

        // Pop animation
        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });

    // Finish selection
    panel.querySelectorAll('.finish-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.finish-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // The brush applies the finish to the nail shader (uniforms only).
        this.polishBrush3D?.setFinish(btn.dataset.finish);
        soundManager.playClick();
      });
    });
  }

  /**
   * Update the coverage progress UI
   */
  updateCoverageUI(coverage) {
    const progressFill = document.querySelector('.polish-progress .progress-fill');
    const coverageText = document.querySelector('.polish-progress .coverage-text');

    if (progressFill) {
      progressFill.style.width = `${Math.min(100, coverage)}%`;
    }
    if (coverageText) {
      coverageText.textContent = `${Math.round(coverage)}%`;
    }
  }

  /**
   * Update the dry button UI state
   */
  updateDryButtonUI(isDry) {
    const dryBtn = document.getElementById('dry-btn');
    if (dryBtn) {
      if (isDry) {
        dryBtn.classList.add('dried');
        dryBtn.classList.remove('pulse');
      } else {
        dryBtn.classList.remove('dried');
        dryBtn.classList.add('pulse');
      }
    }
  }

  renderBlingOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    // Track which category is selected (stickers or gems)
    const activeCategory = this.blingCategory || 'stickers';

    panel.innerHTML = `
      <h3>Bling</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Tap to place decorations on your nail!
      </p>

      <div class="bling-tabs">
        <button class="bling-tab ${activeCategory === 'stickers' ? 'active' : ''}" data-category="stickers">
          ⭐ Stickers
        </button>
        <button class="bling-tab ${activeCategory === 'gems' ? 'active' : ''}" data-category="gems">
          💎 Gems
        </button>
      </div>

      <div class="bling-items">
        ${activeCategory === 'stickers' ? `
          <div class="bling-grid">
            ${STICKERS.map(s => `
              <button class="shape-btn bling-btn" data-type="sticker" data-id="${s.id}">
                ${s.emoji}
              </button>
            `).join('')}
          </div>
        ` : `
          <div class="bling-grid">
            ${GEM_TYPES.map(g => `
              <button class="shape-btn bling-btn" data-type="gem" data-id="${g.id}">
                ${g.emoji}
              </button>
            `).join('')}
          </div>
        `}
      </div>
    `;

    // Tab switching
    panel.querySelectorAll('.bling-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.blingCategory = tab.dataset.category;
        // Deselect items when switching tabs
        this.stickerTool?.selectSticker(null);
        this.gemTool?.selectGem(null);
        this.renderBlingOptions();
        soundManager.playClick();
      });
    });

    // Item selection
    panel.querySelectorAll('.bling-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Update active state
        panel.querySelectorAll('.bling-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const type = btn.dataset.type;
        const id = btn.dataset.id;

        if (type === 'sticker') {
          this.stickerTool?.selectSticker(id);
          this.gemTool?.selectGem(null); // Deselect gem
        } else {
          this.gemTool?.selectGem(id);
          this.stickerTool?.selectSticker(null); // Deselect sticker
        }

        // Animation
        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });
  }

  renderBrushOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    const currentMaterial = this.brushTool?.getMaterial() || 'solid';
    const currentColor = this.brushTool?.getColor() || '#FFFFFF';
    const currentSize = this.brushTool?.getSize() || 6;

    // Get materials as array
    const materials = Object.values(PEN_MATERIALS);

    panel.innerHTML = `
      <h3>Draw</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Draw designs with different pen styles!
      </p>

      <h4>Pen Style</h4>
      <div class="material-grid">
        ${materials.map(m => `
          <button
            class="material-btn ${currentMaterial === m.id ? 'active' : ''}"
            data-material="${m.id}"
            title="${m.description}"
          >
            <span class="material-icon">${m.icon}</span>
            <span class="material-name">${m.name}</span>
          </button>
        `).join('')}
      </div>

      <h4 style="margin-top: 16px;">Color</h4>
      <div class="color-grid pen-colors">
        ${PEN_COLORS.map(c => `
          <button
            class="color-swatch brush-color-btn ${currentColor === c.color ? 'active' : ''}"
            data-color="${c.color}"
            style="background-color: ${c.color}"
            title="${c.name}"
          ></button>
        `).join('')}
      </div>

      <h4 style="margin-top: 16px;">Size</h4>
      <div class="size-preview-container">
        <div class="size-preview" style="width: ${currentSize * 2}px; height: ${currentSize * 2}px; background: ${currentColor};"></div>
      </div>
      <input type="range" id="brush-size" min="1" max="20" value="${currentSize}" style="width: 100%;">
    `;

    // Material selection
    panel.querySelectorAll('.material-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.material-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.brushTool?.setMaterial(btn.dataset.material);
        soundManager.playClick();

        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });

    // Color selection
    panel.querySelectorAll('.brush-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.brush-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const color = btn.dataset.color;
        this.brushTool?.setColor(color);
        soundManager.playClick();

        // Update size preview color
        const preview = panel.querySelector('.size-preview');
        if (preview) {
          preview.style.background = color;
        }

        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });

    // Size slider
    const slider = document.getElementById('brush-size');
    const sizePreview = panel.querySelector('.size-preview');

    slider?.addEventListener('input', (e) => {
      const size = parseInt(e.target.value);
      this.brushTool?.setSize(size);

      // Update preview
      if (sizePreview) {
        sizePreview.style.width = `${size * 2}px`;
        sizePreview.style.height = `${size * 2}px`;
      }
    });
  }

  clearNail() {
    // Paint first (sim + baked), then the legacy colour, then decorations.
    this.polishBrush3D?.clearNail();
    this.nail.clearPolish();
    this.nail.clearDrawing();
    this.updateCoverageUI(0);

    // Play sound
    soundManager.playClick();

    this.updateOptionsPanel();
  }

  toggleGallery(show) {
    const modal = document.getElementById('gallery-modal');
    if (!modal) return;

    if (show) {
      modal.classList.add('open');
      this.loadGallery();
    } else {
      modal.classList.remove('open');
    }
  }

  loadGallery() {
    const grid = document.getElementById('gallery-grid');
    if (!grid) return;

    // TODO: Load from localStorage
    grid.innerHTML = `
      <div class="gallery-empty">
        <p style="font-size: 2rem">📸</p>
        <p>No looks saved yet!</p>
        <p style="font-size: 0.8rem">Create your first masterpiece!</p>
      </div>
    `;
  }

  showCelebration() {
    // Play success fanfare
    soundManager.playSuccess();

    // Fun celebration with bounce effect
    const title = document.querySelector('.title');
    if (title) {
      title.textContent = 'ICONIC!';
      title.classList.add('celebrate');

      setTimeout(() => {
        title.textContent = 'NAIL ICON';
        title.classList.remove('celebrate');
      }, 2000);
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new NailArtistApp();
});
