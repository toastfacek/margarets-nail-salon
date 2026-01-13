/**
 * main.js
 * Application entry point - initializes scene, nail, and UI
 */
import { NailScene } from './scene/NailScene.js';
import { HandModel, FINGERS } from './scene/HandModel.js';
import { nailDesignStore } from './state/NailDesignStore.js';
import { FileTool } from './tools/FileTool.js';
import { StickerTool, STICKERS } from './tools/StickerTool.js';
import { GlitterTool, GLITTER_COLORS } from './tools/GlitterTool.js';
import { GemTool, GEM_TYPES } from './tools/GemTool.js';
import { BrushTool } from './tools/BrushTool.js';
import { soundManager } from './audio/SoundManager.js';
import * as THREE from 'three';

// Map old shape names for compatibility (shapes are fixed in GLB)
const NAIL_SHAPES = {
    ROUND: 'round',
    SQUARE: 'square',
    ALMOND: 'almond',
    STILETTO: 'stiletto',
    COFFIN: 'coffin'
};

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
      if (this.currentTool === 'draw' || this.currentTool === 'glitter' ||
          this.currentTool === 'sticker' || this.currentTool === 'gems') {
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

    // Create glitter tool
    this.glitterTool = new GlitterTool(this.scene.scene, this.scene.camera, this.nail);

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
        this.glitterTool?.deactivate();
        this.gemTool?.deactivate();
        this.brushTool?.deactivate();

        // Activate the selected tool
        switch (this.currentTool) {
          case 'shape':
            this.fileTool?.activate();
            break;
          case 'sticker':
            this.stickerTool?.activate();
            break;
          case 'glitter':
            this.glitterTool?.activate();
            break;
          case 'gems':
            this.gemTool?.activate();
            break;
          case 'draw':
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
      case 'sticker':
        this.renderStickerOptions();
        break;
      case 'glitter':
        this.renderGlitterOptions();
        break;
      case 'gems':
        this.renderGemOptions();
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

    // Shape tool not available with hand model - shapes are fixed
    panel.innerHTML = `
      <h3>Shape</h3>
      <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 12px;">
        Shape options coming soon!
      </p>
      <p style="font-size: 0.75rem; color: var(--text-muted);">
        Tap a nail to select it, then use polish or draw to create your look!
      </p>
    `;
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

  renderStickerOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    panel.innerHTML = `
      <h3>Stickers</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Pick a sticker, then tap the nail to place it!
      </p>
      <div class="color-grid">
        ${STICKERS.map(s => `
          <button class="shape-btn sticker-btn" data-sticker="${s.id}" style="font-size: 1.5rem; padding: 8px;">
            ${s.emoji}
          </button>
        `).join('')}
      </div>
    `;

    // Add click handlers
    panel.querySelectorAll('.sticker-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Update active state
        panel.querySelectorAll('.sticker-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Select sticker
        this.stickerTool?.selectSticker(btn.dataset.sticker);

        // Animation
        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });
  }

  renderGlitterOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    panel.innerHTML = `
      <h3>Glitter</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Drag across the nail to add sparkle!
      </p>
      <div class="color-grid">
        ${GLITTER_COLORS.map(g => `
          <button
            class="color-swatch glitter-btn ${g.id === 'gold' ? 'active' : ''}"
            data-glitter="${g.id}"
            style="background: ${g.id === 'rainbow'
        ? 'linear-gradient(135deg, #ff2a6d, #c77dff, #00b4d8, #00f5d4, #ffd700)'
        : `linear-gradient(135deg, ${g.color}, white, ${g.color})`}"
            title="${g.name}"
          ></button>
        `).join('')}
      </div>
    `;

    // Select default gold
    this.glitterTool?.selectColor('gold');

    // Add click handlers
    panel.querySelectorAll('.glitter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.glitter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.glitterTool?.selectColor(btn.dataset.glitter);

        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });
  }

  renderGemOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    panel.innerHTML = `
      <h3>Gems</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Pick a gem, then tap the nail to place it!
      </p>
      <div class="color-grid">
        ${GEM_TYPES.map(g => `
          <button class="shape-btn gem-btn" data-gem="${g.id}" style="font-size: 1.5rem; padding: 8px;">
            ${g.emoji}
          </button>
        `).join('')}
      </div>
    `;

    // Add click handlers
    panel.querySelectorAll('.gem-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.gem-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.gemTool?.selectGem(btn.dataset.gem);

        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });
  }

  renderBrushOptions() {
    const panel = document.getElementById('options-panel');
    if (!panel) return;

    // Fun brush colors
    const colors = ['#ffffff', '#2d1f3d', '#ff2a6d', '#ffd700', '#00b4d8', '#00f5d4', '#c77dff', '#ff6b6b'];

    panel.innerHTML = `
      <h3>Draw</h3>
      <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">
        Draw freehand designs on your nail!
      </p>

      <h4>Color</h4>
      <div class="color-grid">
        ${colors.map(c => `
          <button
            class="color-swatch brush-color-btn ${this.brushTool?.color === c ? 'active' : ''}"
            data-color="${c}"
            style="background-color: ${c}"
          ></button>
        `).join('')}
      </div>

      <h4 style="margin-top: 16px;">Brush Size</h4>
      <input type="range" id="brush-size" min="1" max="20" value="${this.brushTool?.size || 5}" style="width: 100%;">
    `;

    // Color selection
    panel.querySelectorAll('.brush-color-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.brush-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        this.brushTool?.setColor(btn.dataset.color);
        soundManager.playClick();

        btn.style.animation = 'none';
        btn.offsetHeight;
        btn.style.animation = 'bounce 0.3s ease';
      });
    });

    // Size slider
    const slider = document.getElementById('brush-size');
    slider?.addEventListener('input', (e) => {
      this.brushTool?.setSize(parseInt(e.target.value));
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
