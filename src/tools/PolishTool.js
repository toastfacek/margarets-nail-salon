/**
 * PolishTool.js
 * Realistic nail polish painting tool with layer support.
 * Allows painting base coat, color coats (1-2), and top coat.
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';
import { PolishLayerState, POLISH_LAYERS, LAYER_ORDER } from '../state/PolishLayerState.js';

// Polish brush configuration
const BRUSH_CONFIG = {
  width: 35,           // Brush width in canvas pixels
  length: 70,          // Brush length (direction of stroke)
  baseOpacity: 0.35,   // Per-stroke base opacity
  maxOpacity: 0.92,    // Cap for realistic polish look
  bristleCount: 8,     // Subtle bristle lines
  edgeSoftness: 0.4,   // Soft edges for blending
};

export class PolishTool {
  constructor(scene, camera, nail) {
    this.scene = scene;
    this.camera = camera;
    this.nail = nail;  // HandModel reference
    this.isActive = false;
    this.isPainting = false;

    // Current color and finish
    this.color = '#ff2a6d';
    this.finish = 'glossy';

    // Canvas dimension (matches HandModel)
    this.dim = 1024;

    // Raycasting for UV intersection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.lastPaintPos = null;
    this.lastUV = null;

    // Polish state per nail (keyed by hand_finger)
    this.polishStates = new Map();

    // Layer canvases per nail (keyed by hand_finger)
    this.layerCanvases = new Map();

    // UI callbacks
    this.onCoverageChange = null;
    this.onLayerChange = null;
    this.onDryStateChange = null;

    this.setupEventListeners();
  }

  /**
   * Get or create polish state for a nail
   */
  getPolishState(hand, finger) {
    const key = `${hand}_${finger}`;
    if (!this.polishStates.has(key)) {
      this.polishStates.set(key, new PolishLayerState());
    }
    return this.polishStates.get(key);
  }

  /**
   * Get polish state for currently active nail
   */
  getActivePolishState() {
    const hand = this.nail.getCurrentHand();
    const finger = this.nail.getActiveNail();
    return this.getPolishState(hand, finger);
  }

  /**
   * Get or create layer canvases for a nail
   */
  getLayerCanvases(hand, finger) {
    const key = `${hand}_${finger}`;
    if (!this.layerCanvases.has(key)) {
      const layers = {};
      for (const layerType of LAYER_ORDER) {
        const canvas = document.createElement('canvas');
        canvas.width = this.dim;
        canvas.height = this.dim;
        layers[layerType] = {
          canvas,
          ctx: canvas.getContext('2d', { willReadFrequently: true }),
          texture: new THREE.CanvasTexture(canvas),
        };
        layers[layerType].texture.flipY = false;
      }
      this.layerCanvases.set(key, layers);
    }
    return this.layerCanvases.get(key);
  }

  /**
   * Get layer canvases for currently active nail
   */
  getActiveLayerCanvases() {
    const hand = this.nail.getCurrentHand();
    const finger = this.nail.getActiveNail();
    return this.getLayerCanvases(hand, finger);
  }

  /**
   * Get the canvas context for the active layer
   */
  getActiveLayerContext() {
    const state = this.getActivePolishState();
    const layers = this.getActiveLayerCanvases();
    return layers[state.activeLayer]?.ctx;
  }

  setupEventListeners() {
    const canvas = document.querySelector('#canvas-container canvas');
    if (!canvas) {
      setTimeout(() => this.setupEventListeners(), 100);
      return;
    }

    canvas.addEventListener('mousedown', (e) => this.onPointerDown(e));
    canvas.addEventListener('mousemove', (e) => this.onPointerMove(e));
    canvas.addEventListener('mouseup', () => this.onPointerUp());
    canvas.addEventListener('mouseleave', () => this.onPointerUp());

    canvas.addEventListener('touchstart', (e) => this.onPointerDown(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this.onPointerMove(e), { passive: false });
    canvas.addEventListener('touchend', () => this.onPointerUp());
  }

  updateMousePosition(event) {
    const canvas = document.querySelector('#canvas-container canvas');
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;

    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  getUVIntersection() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const nailMesh = this.nail.getNailMesh();
    if (!nailMesh) return null;

    const intersects = this.raycaster.intersectObject(nailMesh, true);
    if (intersects.length > 0 && intersects[0].uv) {
      return intersects[0].uv;
    }
    return null;
  }

  onPointerDown(event) {
    if (!this.isActive) return;
    event.preventDefault?.();

    this.isPainting = true;
    this.updateMousePosition(event);

    const uv = this.getUVIntersection();
    if (uv) {
      const state = this.getActivePolishState();
      const layer = state.getActiveLayer();

      // Save undo state before painting
      this.saveUndoState();

      // Start applying if not already
      if (!layer.applied) {
        const color = this.isColorLayer(state.activeLayer) ? this.color : null;
        layer.startApplying(color);
      }

      this.lastUV = uv.clone();
      this.lastPaintPos = { x: uv.x * this.dim, y: uv.y * this.dim };

      // Draw initial point
      this.drawPolishStroke(uv.x, uv.y, uv.x, uv.y);

      soundManager.init();
    }
  }

  onPointerMove(event) {
    if (!this.isActive || !this.isPainting) return;
    event.preventDefault?.();

    this.updateMousePosition(event);

    const uv = this.getUVIntersection();
    if (uv) {
      const currentPos = { x: uv.x * this.dim, y: uv.y * this.dim };

      if (this.lastUV) {
        this.drawPolishStroke(this.lastUV.x, this.lastUV.y, uv.x, uv.y);
      } else {
        this.drawPolishStroke(uv.x, uv.y, uv.x, uv.y);
      }

      this.lastUV = uv.clone();
      this.lastPaintPos = currentPos;
    } else {
      this.lastUV = null;
      this.lastPaintPos = null;
    }
  }

  onPointerUp() {
    if (this.isPainting) {
      const state = this.getActivePolishState();
      const layer = state.getActiveLayer();

      // Start drying timer when stroke ends
      if (layer.applied && !layer.isDry) {
        layer.startDrying();
      }

      // Notify UI of coverage change
      this.notifyCoverageChange();
    }

    this.isPainting = false;
    this.lastPaintPos = null;
    this.lastUV = null;
  }

  /**
   * Draw a polish brush stroke from one UV to another
   */
  drawPolishStroke(u1, v1, u2, v2) {
    const ctx = this.getActiveLayerContext();
    if (!ctx) return;

    const state = this.getActivePolishState();
    const layer = state.getActiveLayer();

    // Convert UVs to canvas coords
    const x1 = u1 * this.dim;
    const y1 = v1 * this.dim;
    const x2 = u2 * this.dim;
    const y2 = v2 * this.dim;

    // Calculate stroke direction
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Determine color
    let strokeColor;
    if (this.isColorLayer(state.activeLayer)) {
      strokeColor = layer.color || this.color;
    } else if (state.activeLayer === POLISH_LAYERS.BASE_COAT) {
      strokeColor = 'rgba(255, 253, 250, 0.15)'; // Slight milky tint
    } else {
      strokeColor = 'rgba(255, 255, 255, 0.1)'; // Clear top coat
    }

    // Interpolate points along the stroke for smooth coverage
    const steps = Math.max(1, Math.ceil(dist / 8));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;

      this.drawBrushDab(ctx, x, y, angle, strokeColor, state.activeLayer);

      // Update coverage map
      const u = x / this.dim;
      const v = y / this.dim;
      layer.coverage.addCoverage(u, v, BRUSH_CONFIG.width / this.dim, BRUSH_CONFIG.baseOpacity);
    }

    // Update texture
    this.updateActiveTexture();

    // Composite layers onto nail
    this.compositeLayers();
  }

  /**
   * Draw a single brush dab (elongated ellipse with bristle texture)
   */
  drawBrushDab(ctx, x, y, angle, color, layerType) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Parse color for manipulation
    const isColorCoat = this.isColorLayer(layerType);
    const opacity = isColorCoat ? BRUSH_CONFIG.baseOpacity : BRUSH_CONFIG.baseOpacity * 0.5;

    // Main brush shape - elongated ellipse
    ctx.beginPath();
    ctx.ellipse(0, 0, BRUSH_CONFIG.length / 2, BRUSH_CONFIG.width / 2, 0, 0, Math.PI * 2);

    // Create gradient for soft edges
    if (isColorCoat) {
      const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, BRUSH_CONFIG.width / 2);
      gradient.addColorStop(0, this.hexToRgba(color, opacity * 1.2));
      gradient.addColorStop(0.6, this.hexToRgba(color, opacity));
      gradient.addColorStop(1, this.hexToRgba(color, opacity * 0.3));
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = color;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fill();

    // Add subtle bristle texture for realism
    if (isColorCoat) {
      this.drawBristleTexture(ctx, color, opacity);
    }

    ctx.restore();
  }

  /**
   * Draw subtle bristle lines within the brush shape
   */
  drawBristleTexture(ctx, color, baseOpacity) {
    const bristleSpacing = BRUSH_CONFIG.width / (BRUSH_CONFIG.bristleCount + 1);

    ctx.strokeStyle = this.hexToRgba(color, baseOpacity * 0.3);
    ctx.lineWidth = 1;

    for (let i = 1; i <= BRUSH_CONFIG.bristleCount; i++) {
      const offsetY = -BRUSH_CONFIG.width / 2 + bristleSpacing * i;

      ctx.beginPath();
      ctx.moveTo(-BRUSH_CONFIG.length / 2 * 0.8, offsetY);
      ctx.lineTo(BRUSH_CONFIG.length / 2 * 0.8, offsetY);
      ctx.stroke();
    }
  }

  /**
   * Check if layer type is a color layer
   */
  isColorLayer(layerType) {
    return layerType === POLISH_LAYERS.COLOR_1 || layerType === POLISH_LAYERS.COLOR_2;
  }

  /**
   * Convert hex color to rgba string
   */
  hexToRgba(hex, alpha) {
    if (hex.startsWith('rgba')) return hex;

    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      const r = parseInt(result[1], 16);
      const g = parseInt(result[2], 16);
      const b = parseInt(result[3], 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return hex;
  }

  /**
   * Update the texture for the active layer
   */
  updateActiveTexture() {
    const state = this.getActivePolishState();
    const layers = this.getActiveLayerCanvases();
    const layerData = layers[state.activeLayer];
    if (layerData) {
      layerData.texture.needsUpdate = true;
    }
  }

  /**
   * Composite all polish layers onto the nail's overlay texture
   */
  compositeLayers() {
    const nailData = this.nail.nails[this.nail.activeNail];
    if (!nailData) return;

    const layers = this.getActiveLayerCanvases();
    const state = this.getActivePolishState();

    // Get the nail's drawing canvas/context (used for final composite)
    const finalCtx = nailData.ctx;

    // Clear final canvas
    finalCtx.clearRect(0, 0, this.dim, this.dim);

    // Composite layers in order (base -> color1 -> color2 -> top)
    for (const layerType of LAYER_ORDER) {
      const layerState = state.layers[layerType];
      if (!layerState.applied) continue;

      const layerData = layers[layerType];
      if (!layerData) continue;

      // Draw layer onto final canvas
      finalCtx.globalCompositeOperation = 'source-over';
      finalCtx.drawImage(layerData.canvas, 0, 0);
    }

    // Update the nail's texture
    nailData.texture.needsUpdate = true;

    // Also update nail material based on layers applied
    this.updateNailMaterial();
  }

  /**
   * Update nail material properties based on polish layers
   */
  updateNailMaterial() {
    const state = this.getActivePolishState();
    const status = state.getStatus();

    // If color is applied, update material
    if (status.hasColor && status.color) {
      // Set a semi-transparent version of the color on the material
      // The full color comes from the canvas texture
      const nailData = this.nail.nails[this.nail.activeNail];
      if (nailData && nailData.material) {
        // Apply finish to material
        this.applyFinishToMaterial(nailData.material, this.finish);
      }
    }
  }

  /**
   * Apply finish properties to material
   */
  applyFinishToMaterial(material, finish) {
    switch (finish) {
      case 'matte':
        material.roughness = 0.7;
        material.clearcoat = 0.1;
        material.metalness = 0.0;
        break;
      case 'shimmer':
        material.roughness = 0.15;
        material.clearcoat = 1.0;
        material.metalness = 0.25;
        break;
      case 'chrome':
        material.roughness = 0.05;
        material.clearcoat = 1.0;
        material.metalness = 0.85;
        break;
      case 'glossy':
      default:
        material.roughness = 0.1;
        material.clearcoat = 1.0;
        material.clearcoatRoughness = 0.05;
        material.metalness = 0.0;
        break;
    }
    material.needsUpdate = true;
  }

  /**
   * Save current state for undo
   */
  saveUndoState() {
    const state = this.getActivePolishState();
    const layers = this.getActiveLayerCanvases();

    const canvasData = {};
    for (const [layerType, layerData] of Object.entries(layers)) {
      canvasData[layerType] = layerData.canvas.toDataURL('image/png');
    }

    state.saveUndoState(canvasData);
  }

  /**
   * Undo last stroke
   */
  undo() {
    const state = this.getActivePolishState();
    const undoState = state.popUndo();
    if (!undoState) return;

    const layers = this.getActiveLayerCanvases();

    // Restore each layer canvas
    for (const [layerType, dataUrl] of Object.entries(undoState.canvasData)) {
      const layerData = layers[layerType];
      if (!layerData) continue;

      const img = new Image();
      img.onload = () => {
        layerData.ctx.clearRect(0, 0, this.dim, this.dim);
        layerData.ctx.drawImage(img, 0, 0);
        layerData.texture.needsUpdate = true;
        this.compositeLayers();
      };
      img.src = dataUrl;
    }

    soundManager.playClick();
  }

  /**
   * Instant dry the current layer
   */
  instantDry() {
    const state = this.getActivePolishState();
    const layer = state.getActiveLayer();
    layer.instantDry();

    this.onDryStateChange?.(true);
    soundManager.playSparkle?.() || soundManager.playSuccess();
  }

  /**
   * Quick fill the current layer
   */
  quickFill() {
    const state = this.getActivePolishState();
    const layers = this.getActiveLayerCanvases();
    const layerData = layers[state.activeLayer];

    if (!layerData) return;

    // Save undo state
    this.saveUndoState();

    const ctx = layerData.ctx;
    const layer = state.getActiveLayer();

    // Determine fill color
    let fillColor;
    if (this.isColorLayer(state.activeLayer)) {
      fillColor = this.color;
      layer.startApplying(this.color);
    } else if (state.activeLayer === POLISH_LAYERS.BASE_COAT) {
      fillColor = 'rgba(255, 253, 250, 0.2)';
      layer.startApplying(null);
    } else {
      fillColor = 'rgba(255, 255, 255, 0.15)';
      layer.startApplying(null);
    }

    // Animate fill with radial wipe
    this.animateFill(ctx, fillColor, () => {
      layer.coverage.fill(0.9);
      layer.startDrying();
      layerData.texture.needsUpdate = true;
      this.compositeLayers();
      this.notifyCoverageChange();
    });

    soundManager.playPolish();
  }

  /**
   * Animate a radial fill
   */
  animateFill(ctx, color, onComplete) {
    let progress = 0;
    const centerX = this.dim / 2;
    const centerY = this.dim / 2;
    const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);

    const animate = () => {
      progress += 0.08;

      ctx.beginPath();
      ctx.ellipse(centerX, centerY, maxRadius * progress * 1.2, maxRadius * progress, 0, 0, Math.PI * 2);

      if (color.startsWith('rgba')) {
        ctx.fillStyle = color;
      } else {
        ctx.fillStyle = this.hexToRgba(color, 0.85);
      }
      ctx.fill();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        onComplete?.();
      }
    };

    animate();
  }

  /**
   * Set active layer
   */
  setActiveLayer(layerType) {
    const state = this.getActivePolishState();
    state.setActiveLayer(layerType);
    this.onLayerChange?.(layerType);
  }

  /**
   * Set polish color
   */
  setColor(color) {
    this.color = color;
  }

  /**
   * Set finish type
   */
  setFinish(finish) {
    this.finish = finish;
    this.updateNailMaterial();
  }

  /**
   * Get coverage percentage for active layer
   */
  getCoverage() {
    const state = this.getActivePolishState();
    return state.getActiveLayer().getCoveragePercent();
  }

  /**
   * Check if active layer is dry
   */
  isLayerDry() {
    const state = this.getActivePolishState();
    return state.getActiveLayer().isDry;
  }

  /**
   * Notify UI of coverage change
   */
  notifyCoverageChange() {
    const coverage = this.getCoverage();
    this.onCoverageChange?.(coverage);
  }

  /**
   * Clear all polish from active nail
   */
  clear() {
    const state = this.getActivePolishState();
    state.clearAll();

    const layers = this.getActiveLayerCanvases();
    for (const layerData of Object.values(layers)) {
      layerData.ctx.clearRect(0, 0, this.dim, this.dim);
      layerData.texture.needsUpdate = true;
    }

    // Clear the composite canvas too
    this.nail.clearDrawing();

    // Reset nail material
    this.nail.clearPolish();

    this.notifyCoverageChange();
    soundManager.playClick();
  }

  /**
   * Get the current polish state (for UI)
   */
  getState() {
    return this.getActivePolishState();
  }

  activate() {
    this.isActive = true;
  }

  deactivate() {
    this.isActive = false;
    this.isPainting = false;
  }
}
