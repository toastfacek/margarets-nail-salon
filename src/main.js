/**
 * main.js
 * Application entry point - initializes scene, nail, and UI
 */
import { NailScene } from './scene/NailScene.js';
import { HandModel, FINGERS, NAIL_SHAPES } from './scene/HandModel.js';
import { nailDesignStore } from './state/NailDesignStore.js';
import { FileTool } from './tools/FileTool.js';
import { StickerTool, STICKERS } from './tools/StickerTool.js';
import { GemTool, GEM_TYPES } from './tools/GemTool.js';
import { BrushTool, PEN_MATERIALS, PEN_COLORS } from './tools/BrushTool.js';
import { soundManager } from './audio/SoundManager.js';
import * as THREE from 'three';

class NailArtistApp {
  constructor() {
    this.currentTool = 'shape';
    this.selectedShape = NAIL_SHAPES.ROUND;
    this.selectedColor = '#ff2a6d'; // Default neon demon pink

    // Track time for animation
    this.lastTime = 0;

    // Initialize asynchronously
    this.init();
  }

  async init() {
    // Get container
    const container = document.getElementById('canvas-container');

    // Create scene
    this.scene = new NailScene(container);

    // Create hand model (async load)
    this.nail = new HandModel();
    await this.nail.load();
    this.scene.add(this.nail.getMesh());

    // Set up nail selection click handling
    this.setupNailSelection();

    // Set initial active nail (index finger) and zoom to it
    this.nail.setActiveNail(FINGERS.INDEX);
    this.zoomToFinger(FINGERS.INDEX);

    // Continue setup after model loads
    this.setupUI();
    this.setupTools();
    this.renderPolishOptions(); // Start with polish instead of shape
    this.startAnimationLoop();

    console.log('💅 NAIL ICON initialized // Glam Studio ready!');
  }

  /**
   * Set up click-to-select nail functionality with zoom
   */
  setupNailSelection() {
    const canvas = this.scene.renderer.domElement;

    canvas.addEventListener('click', (event) => {
      // Don't select nails while using decoration tools
      if (this.currentTool === 'brush' || this.currentTool === 'bling') {
        return;
      }

      const raycaster = this.scene.getRaycaster(event);
      const nailMeshes = this.nail.getNailMeshes();
      const intersects = raycaster.intersectObjects(nailMeshes, false);

      if (intersects.length > 0) {
        const clickedMesh = intersects[0].object;
        const finger = this.nail.getFingerFromMesh(clickedMesh);

        if (finger) {
          // Set active nail
          this.nail.setActiveNail(finger);
          soundManager.playClick();

          // Zoom to the clicked nail
          this.zoomToFinger(finger);

          // Update UI to reflect new selection
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

    // Create filing tool
    // this.fileTool = new FileTool(this.scene.scene, this.nail);
    // this.fileTool.activate(); // Start with filing active when shape tool selected

    // Create sticker tool
    this.stickerTool = new StickerTool(this.scene.scene, this.scene.camera, this.nail);

    // Create gem tool
    this.gemTool = new GemTool(this.scene.scene, this.scene.camera, this.nail);

    // Create brush tool
    this.brushTool = new BrushTool(this.scene.scene, this.scene.camera, this.nail);
  }

  startAnimationLoop() {
    const animate = (time) => {
      const deltaTime = (time - this.lastTime) / 1000; // Convert to seconds
      this.lastTime = time;

      // Update file tool particles
      if (this.fileTool) {
        this.fileTool.update(deltaTime);
      }

      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  setupUI() {
    // Tool selection
    const toolButtons = document.querySelectorAll('.tool-btn');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Remove active from all
        toolButtons.forEach(b => b.classList.remove('active'));
        // Add active to clicked
        btn.classList.add('active');

        this.currentTool = btn.dataset.tool;
        this.updateOptionsPanel();

        // Play click sound
        soundManager.playClick();

        // Deactivate all tools first
        this.fileTool?.deactivate();
        this.stickerTool?.deactivate();
        this.gemTool?.deactivate();
        this.brushTool?.deactivate();

        // Activate the selected tool
        switch (this.currentTool) {
          case 'shape':
            this.fileTool?.activate();
            break;
          case 'bling':
            // Both sticker and gem tools listen, UI determines which is active
            this.stickerTool?.activate();
            this.gemTool?.activate();
            break;
          case 'brush':
            this.brushTool?.activate();
            break;
        }

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
      // TODO: Implement undo
      console.log('Undo clicked');
    });

    document.getElementById('btn-done')?.addEventListener('click', () => {
      // TODO: Screenshot functionality
      console.log('Done clicked - screenshot!');
      this.showCelebration();
    });

    document.getElementById('btn-gallery')?.addEventListener('click', () => {
      this.toggleGallery(true);
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

  switchHand(newHand) {
    if (newHand !== 'left' && newHand !== 'right') return;
    if (newHand === this.nail.getCurrentHand()) return;

    // Switch the hand model
    this.nail.switchHand(newHand);

    // Play feedback sound
    soundManager.playClick();

    // Update UI
    this.updateFingerSelectorUI();
    this.updateHandToggleUI();

    // Zoom to the active nail on the new hand
    this.zoomToFinger(this.nail.activeNail);
  }

  async switchToFinger(newFinger) {
    // Set the active nail on the hand model
    this.nail.setActiveNail(newFinger);

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

    panel.innerHTML = `
      <h3>Polish</h3>
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
            class="shape-btn"
            data-finish="${f.id}"
            style="flex: 1; min-width: 80px; font-size: 0.7rem;"
          >
            ${f.name}
          </button>
        `).join('')}
      </div>
    `;

    // Color selection
    panel.querySelectorAll('.color-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.selectedColor = btn.dataset.color;
        this.nail.setPolishColor(this.selectedColor);

        // Play polish sound
        soundManager.playPolish();

        // Pop animation
        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });

    // Finish selection
    panel.querySelectorAll('[data-finish]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.nail.setFinish(btn.dataset.finish);
        soundManager.playClick();
      });
    });
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
    // Clear polish on active nail
    this.nail.clearPolish();

    // Clear all decorations on active nail
    this.nail.clearDrawing();

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
