/**
 * PolishLayerState.js
 * Manages polish layer state for realistic nail painting.
 * Tracks base coat, color coats, and top coat with coverage and drying state.
 */

import { CoverageMap } from '../utils/CoverageMap.js';

// Layer types in order of application
export const POLISH_LAYERS = {
  BASE_COAT: 'baseCoat',
  COLOR_1: 'colorCoat1',
  COLOR_2: 'colorCoat2',
  TOP_COAT: 'topCoat',
};

export const LAYER_ORDER = [
  POLISH_LAYERS.BASE_COAT,
  POLISH_LAYERS.COLOR_1,
  POLISH_LAYERS.COLOR_2,
  POLISH_LAYERS.TOP_COAT,
];

// Auto-dry time in milliseconds
export const DRY_TIME = 4000;

/**
 * State for a single polish layer
 */
export class LayerState {
  constructor(layerType) {
    this.type = layerType;
    this.applied = false;
    this.color = null; // Only for color coats
    this.isDry = true;
    this.dryStartTime = null;
    this.coverage = new CoverageMap(64);
  }

  /**
   * Start applying this layer
   * @param {string|null} color - Color for color coats, null for base/top coat
   */
  startApplying(color = null) {
    this.applied = true;
    this.color = color;
    this.isDry = false;
    this.dryStartTime = null;
  }

  /**
   * Start the drying process
   */
  startDrying() {
    if (!this.isDry && this.applied) {
      this.dryStartTime = Date.now();
    }
  }

  /**
   * Check if layer has finished drying (auto-dry)
   * @returns {boolean}
   */
  checkDry() {
    if (this.isDry) return true;
    if (!this.dryStartTime) return false;

    if (Date.now() - this.dryStartTime >= DRY_TIME) {
      this.isDry = true;
      return true;
    }
    return false;
  }

  /**
   * Instantly dry this layer
   */
  instantDry() {
    this.isDry = true;
    this.dryStartTime = null;
  }

  /**
   * Get drying progress (0-1)
   * @returns {number}
   */
  getDryProgress() {
    if (this.isDry) return 1;
    if (!this.dryStartTime) return 0;
    return Math.min(1, (Date.now() - this.dryStartTime) / DRY_TIME);
  }

  /**
   * Get coverage percentage
   * @returns {number} 0-100
   */
  getCoveragePercent() {
    return this.coverage.getCoveragePercentage();
  }

  /**
   * Reset this layer
   */
  reset() {
    this.applied = false;
    this.color = null;
    this.isDry = true;
    this.dryStartTime = null;
    this.coverage.clear();
  }

  /**
   * Clone this layer state
   * @returns {LayerState}
   */
  clone() {
    const copy = new LayerState(this.type);
    copy.applied = this.applied;
    copy.color = this.color;
    copy.isDry = this.isDry;
    copy.dryStartTime = this.dryStartTime;
    copy.coverage = this.coverage.clone();
    return copy;
  }
}

/**
 * Complete polish state for a single nail
 */
export class PolishLayerState {
  constructor() {
    this.layers = {};
    for (const layerType of LAYER_ORDER) {
      this.layers[layerType] = new LayerState(layerType);
    }

    this.activeLayer = POLISH_LAYERS.COLOR_1; // Default to first color coat
    this.selectedColor = '#ff2a6d'; // Default color
    this.finish = 'glossy';

    // Undo stack - stores canvas data URLs per layer
    this.undoStack = [];
    this.maxUndoSteps = 10;
  }

  /**
   * Get the currently active layer
   * @returns {LayerState}
   */
  getActiveLayer() {
    return this.layers[this.activeLayer];
  }

  /**
   * Set the active layer
   * @param {string} layerType - One of POLISH_LAYERS values
   */
  setActiveLayer(layerType) {
    if (LAYER_ORDER.includes(layerType)) {
      this.activeLayer = layerType;
    }
  }

  /**
   * Get the next layer in sequence
   * @returns {string|null} Next layer type or null if at end
   */
  getNextLayer() {
    const currentIndex = LAYER_ORDER.indexOf(this.activeLayer);
    if (currentIndex < LAYER_ORDER.length - 1) {
      return LAYER_ORDER[currentIndex + 1];
    }
    return null;
  }

  /**
   * Check if a layer can be painted on
   * A layer can be painted if all previous layers are dry
   * @param {string} layerType
   * @returns {boolean}
   */
  canPaintLayer(layerType) {
    const targetIndex = LAYER_ORDER.indexOf(layerType);

    // Check all previous layers are dry
    for (let i = 0; i < targetIndex; i++) {
      const prevLayer = this.layers[LAYER_ORDER[i]];
      if (prevLayer.applied && !prevLayer.isDry) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if previous layer is wet (for smear effect)
   * @param {string} layerType
   * @returns {boolean}
   */
  isPreviousLayerWet(layerType) {
    const targetIndex = LAYER_ORDER.indexOf(layerType);
    if (targetIndex <= 0) return false;

    const prevLayer = this.layers[LAYER_ORDER[targetIndex - 1]];
    return prevLayer.applied && !prevLayer.isDry;
  }

  /**
   * Update drying state for all layers
   */
  updateDrying() {
    for (const layer of Object.values(this.layers)) {
      layer.checkDry();
    }
  }

  /**
   * Save current state to undo stack
   * @param {Object} canvasData - Map of layer type to canvas data URL
   */
  saveUndoState(canvasData) {
    this.undoStack.push({
      activeLayer: this.activeLayer,
      canvasData: { ...canvasData },
      timestamp: Date.now(),
    });

    // Trim stack
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
  }

  /**
   * Pop last undo state
   * @returns {Object|null}
   */
  popUndo() {
    return this.undoStack.pop() || null;
  }

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * Get overall polish completion status
   * @returns {Object} Status summary
   */
  getStatus() {
    const baseCoat = this.layers[POLISH_LAYERS.BASE_COAT];
    const color1 = this.layers[POLISH_LAYERS.COLOR_1];
    const color2 = this.layers[POLISH_LAYERS.COLOR_2];
    const topCoat = this.layers[POLISH_LAYERS.TOP_COAT];

    return {
      hasBaseCoat: baseCoat.applied && baseCoat.getCoveragePercent() > 50,
      hasColor: color1.applied && color1.getCoveragePercent() > 50,
      hasSecondCoat: color2.applied && color2.getCoveragePercent() > 50,
      hasTopCoat: topCoat.applied && topCoat.getCoveragePercent() > 50,
      allDry: Object.values(this.layers).every(l => !l.applied || l.isDry),
      color: color1.color || color2.color,
    };
  }

  /**
   * Clear all layers
   */
  clearAll() {
    for (const layer of Object.values(this.layers)) {
      layer.reset();
    }
    this.undoStack = [];
    this.activeLayer = POLISH_LAYERS.COLOR_1;
  }

  /**
   * Quick fill a layer
   * @param {string} layerType
   * @param {string|null} color
   */
  quickFill(layerType, color = null) {
    const layer = this.layers[layerType];
    layer.startApplying(color);
    layer.coverage.fill(0.9);
    layer.startDrying();
  }
}
