/**
 * PolishBrush3D.js
 * Main controller for 3D nail polish brush with bristle physics
 * Coordinates bristle system, input handling, and fluid paint simulation
 */
import * as THREE from 'three';
import { BristleSystem } from './BristleSystem.js';
import { BrushInputHandler } from './BrushInputHandler.js';
import { BristlePaintApplicator } from './BristlePaintApplicator.js';
import { BrushEffects } from './BrushEffects.js';
import { WetPaintOverlay } from './WetPaintMaterial.js';
import { FluidSimulator } from './FluidSimulator.js';
import { soundManager } from '../../audio/SoundManager.js';

export class PolishBrush3D {
  constructor(scene, camera, handModel, renderer = null) {
    this.scene = scene;
    this.camera = camera;
    this.handModel = handModel;
    this.renderer = renderer;

    this.isActive = false;
    this.isPainting = false;

    // Current polish settings
    this.color = '#ff2a6d';
    this.finish = 'glossy';

    // Canvas dimension (matches HandModel)
    this.dim = 1024;

    // Fluid simulation size (power of 2 for GPU efficiency)
    this.fluidSize = 512;

    // Subsystems - 128 bristles for delicate nail polish brush
    this.bristleSystem = new BristleSystem(128);
    this.inputHandler = null; // Created on activate
    this.paintApplicator = new BristlePaintApplicator(this.dim);
    this.brushEffects = new BrushEffects(scene);
    this.wetOverlay = new WetPaintOverlay(this.dim);

    // Fluid simulator - created when renderer is available
    this.fluidSim = null;
    this.useFluidSim = true; // Toggle for fluid vs traditional painting

    // Track UV position for velocity calculation
    this.lastUV = null;

    // Shared raycaster
    this.raycaster = new THREE.Raycaster();

    // UI callbacks
    this.onCoverageChange = null;
    this.onPaintStart = null;
    this.onPaintEnd = null;

    // Sound throttling
    this.lastSoundTime = 0;
    this.soundInterval = 80; // ms between sounds

    // Sound control - play once per stroke
    this.hasPlayedStrokeStartSound = false;

    // Animation state
    this.lastTime = performance.now();

    // Add bristle system to scene (hidden initially)
    this.bristleSystem.setVisible(false);
    this.scene.add(this.bristleSystem.group);
  }

  /**
   * Set the WebGL renderer (required for fluid simulation)
   */
  setRenderer(renderer) {
    this.renderer = renderer;
    if (this.renderer && !this.fluidSim) {
      this.initFluidSim();
    }
  }

  /**
   * Initialize the fluid simulator
   */
  initFluidSim() {
    if (!this.renderer) {
      console.warn('Cannot init fluid sim without renderer');
      return;
    }
    this.fluidSim = new FluidSimulator(this.renderer, this.fluidSize);
    console.log('FluidSimulator initialized');
  }

  /**
   * Activate the 3D brush
   */
  activate() {
    if (this.isActive) return;

    this.isActive = true;

    // Initialize fluid sim if renderer is available
    if (this.renderer && !this.fluidSim) {
      this.initFluidSim();
    }

    // Create input handler
    const canvas = document.querySelector('#canvas-container canvas');
    const canvasContainer = document.querySelector('#canvas-container');
    if (canvas) {
      this.inputHandler = new BrushInputHandler(this.camera, canvas);
      this.inputHandler.attach();
    }

    // Hide system cursor over canvas - brush IS the cursor
    if (canvasContainer) {
      canvasContainer.classList.add('polish-brush-active');
    }

    // Show brush
    this.bristleSystem.setVisible(true);
    this.bristleSystem.setColor(this.color);

    // Set initial brush position near the camera's look-at point
    // so it's visible when first activated
    const initialPosition = new THREE.Vector3(0, 0.2, 0);
    const initialNormal = new THREE.Vector3(0, 1, 0);
    this.bristleSystem.setBrushTransform(initialPosition, initialNormal);

    // Initialize sound
    soundManager.init();

    console.log('PolishBrush3D activated');
  }

  /**
   * Deactivate the 3D brush
   */
  deactivate() {
    if (!this.isActive) return;

    this.isActive = false;
    this.isPainting = false;

    // Detach input
    if (this.inputHandler) {
      this.inputHandler.detach();
      this.inputHandler = null;
    }

    // Restore system cursor
    const canvasContainer = document.querySelector('#canvas-container');
    if (canvasContainer) {
      canvasContainer.classList.remove('polish-brush-active');
    }

    // Hide brush
    this.bristleSystem.setVisible(false);

    console.log('PolishBrush3D deactivated');
  }

  /**
   * Set polish color
   */
  setColor(color) {
    this.color = color;
    this.bristleSystem.setColor(color);
    this.brushEffects.setColor(color);
  }

  /**
   * Set polish finish type
   */
  setFinish(finish) {
    this.finish = finish;
  }

  /**
   * Get the active nail mesh
   */
  getNailMesh() {
    return this.handModel?.getNailMesh?.();
  }

  /**
   * Get the active nail's canvas context
   */
  getNailCanvas() {
    const hand = this.handModel.getCurrentHand();
    const finger = this.handModel.getActiveNail();
    const nail = this.handModel.hands[hand]?.nails[finger];
    return nail ? { canvas: nail.canvas, ctx: nail.ctx, texture: nail.texture } : null;
  }

  /**
   * Main update loop - call this from animation frame
   * @param {number} time - Current time in ms
   */
  update(time) {
    if (!this.isActive) return;

    const deltaTime = Math.min((time - this.lastTime) / 1000, 0.05); // Cap at 50ms
    this.lastTime = time;

    // Update input pressure simulation
    if (this.inputHandler) {
      this.inputHandler.updatePressure(deltaTime);
    }

    // Get nail mesh for this frame
    const nailMesh = this.getNailMesh();

    // Get brush transform from input
    const transform = this.inputHandler?.getBrushTransform(nailMesh);

    if (transform) {
      // Always update brush position (visible even when not over nail)
      this.bristleSystem.setBrushTransform(transform.position, transform.normal);

      if (transform.isValid) {
        // Over the nail - can paint
        this.bristleSystem.pressure = transform.pressure;
        this.bristleSystem.isContacting = transform.pressure > 0;

        // Track painting state
        const wasPainting = this.isPainting;
        this.isPainting = this.inputHandler.isPainting();

        if (this.isPainting && !wasPainting) {
          // Started painting
          this.lastUV = null;  // Reset UV tracking for new stroke
          this.paintApplicator.resetStroke();
          this.onPaintStart?.();
        } else if (!this.isPainting && wasPainting) {
          // Stopped painting
          this.lastUV = null;
          this.paintApplicator.resetStroke();
          this.onPaintEnd?.();
        }

        // Add paint to fluid simulation
        if (this.isPainting && this.fluidSim && this.useFluidSim) {
          const uv = transform.uv;

          if (uv) {
            // Calculate velocity from UV movement
            let velX = 0, velY = 0;
            if (this.lastUV) {
              velX = (uv.x - this.lastUV.x) * 10;  // Subtle flow effect
              velY = (uv.y - this.lastUV.y) * 10;
            }

            // Add splat at current UV position
            this.fluidSim.splat(uv.x, uv.y, velX, velY, this.color);
            this.lastUV = uv.clone();
          }
        }
      } else {
        // Not over nail - just show brush, no painting
        this.bristleSystem.pressure = 0;
        this.bristleSystem.isContacting = false;

        if (this.isPainting) {
          this.lastUV = null;
          this.paintApplicator.resetStroke();
          this.isPainting = false;
          this.onPaintEnd?.();
        }
      }
    }

    // Update bristle physics and collision
    const contacts = this.bristleSystem.update(deltaTime, nailMesh, this.raycaster);

    // Step fluid simulation (paint continues to flow/settle)
    if (this.fluidSim && this.useFluidSim) {
      this.fluidSim.step(deltaTime);

      // Copy fluid sim to canvas texture (slower but compatible)
      const hand = this.handModel.getCurrentHand();
      const finger = this.handModel.getActiveNail();
      const nail = this.handModel.hands[hand]?.nails[finger];
      if (nail && nail.canvas) {
        this.fluidSim.copyToCanvas(nail.canvas);
        nail.texture.needsUpdate = true;
      }
    } else if (this.isPainting && contacts.length > 0) {
      // Fallback to traditional painting if fluid sim is disabled
      const nailCanvas = this.getNailCanvas();
      if (nailCanvas) {
        const painted = this.paintApplicator.paint(
          nailCanvas.ctx,
          contacts,
          this.color,
          1.0
        );
        if (painted) {
          nailCanvas.texture.needsUpdate = true;
        }
      }
    }

    // Update particle effects
    this.brushEffects.update(deltaTime);

    // Update wet overlay
    this.wetOverlay.update();
  }

  /**
   * Play paint sound with throttling
   */
  playPaintSound() {
    const now = performance.now();
    if (now - this.lastSoundTime < this.soundInterval) return;
    this.lastSoundTime = now;

    // Use existing polish sound or fallback
    soundManager.playPolish?.() || soundManager.playDrawSolid?.();
  }

  /**
   * Clear the current nail's canvas
   */
  clearNail() {
    const nailCanvas = this.getNailCanvas();
    if (!nailCanvas) return;

    const { ctx, texture, canvas } = nailCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;

    // Clear fluid simulation as well
    if (this.fluidSim) {
      this.fluidSim.clear();
    }

    this.paintApplicator.resetStroke();
    this.lastUV = null;
    this.onCoverageChange?.(0);
  }

  /**
   * Toggle fluid simulation on/off
   */
  setUseFluidSim(enabled) {
    this.useFluidSim = enabled;
    console.log(`Fluid simulation ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Dispose of resources
   */
  dispose() {
    this.deactivate();
    this.bristleSystem.dispose();
    this.brushEffects.dispose();
    this.wetOverlay.dispose();
    if (this.fluidSim) {
      this.fluidSim.dispose();
    }
    this.scene.remove(this.bristleSystem.group);
  }
}

// Export for module bundling
export { BristleSystem } from './BristleSystem.js';
export { BrushInputHandler } from './BrushInputHandler.js';
export { BristlePaintApplicator } from './BristlePaintApplicator.js';
