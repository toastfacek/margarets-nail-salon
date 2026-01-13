/**
 * WetPaintMaterial.js
 * TSL (Three.js Shading Language) material for wet nail polish effect
 * Creates animated specular highlights that fade as polish "dries"
 */
import * as THREE from 'three';
import {
  MeshPhysicalNodeMaterial,
  uniform,
  timerLocal,
  sin,
  cos,
  mix,
  smoothstep,
  vec3,
  float,
  uv,
  positionLocal,
  normalLocal,
  cameraPosition,
  normalize,
  dot,
  max,
  pow,
  add,
  mul,
  sub
} from 'three/tsl';

// Wet paint configuration for material
const WET_CONFIG = {
  wetClearcoat: 1.0,        // Clearcoat when fully wet
  dryClearcoat: 0.8,        // Clearcoat when dry
  wetRoughness: 0.02,       // Very smooth when wet
  dryRoughness: 0.1,        // Slightly rougher when dry
  shimmerSpeed: 2.0,        // Speed of shimmer animation
  shimmerStrength: 0.15,    // Intensity of shimmer
  specularBoost: 0.3,       // Extra specular when wet
};

// Multi-phase drying configuration for overlay
const DRYING_CONFIG = {
  // Phase durations (in milliseconds)
  wetPhase: 2000,           // Fresh wet paint (0-2s)
  tackyPhase: 4000,         // Tacky, starting to set (2-6s)
  dryPhase: 8000,           // Full dry time (6-14s)

  // Visual properties per phase
  wet: {
    glossiness: 1.0,
    thickness: 1.0,
    specularIntensity: 0.9,
    brushMarkVisibility: 0.8,
  },
  tacky: {
    glossiness: 0.85,
    thickness: 0.9,
    specularIntensity: 0.6,
    brushMarkVisibility: 0.4,
  },
  dry: {
    glossiness: 0.7,
    thickness: 0.8,
    specularIntensity: 0.3,
    brushMarkVisibility: 0.1,
  },

  // Self-leveling simulation
  levelingSpeed: 0.15,      // How fast brush marks smooth out
  levelingBlurRadius: 8,    // Blur radius for leveling effect
};

/**
 * Create a wet paint material using TSL
 * @param {Object} options - Material options
 * @returns {MeshPhysicalNodeMaterial} TSL-based material
 */
export function createWetPaintMaterial(options = {}) {
  const {
    color = '#ff2a6d',
    wetness = 1.0, // 0 = dry, 1 = wet
    finish = 'glossy'
  } = options;

  // Create uniforms that can be updated
  const wetnessUniform = uniform(wetness);
  const colorUniform = uniform(new THREE.Color(color));
  const timeUniform = timerLocal();

  // Create base material
  const material = new MeshPhysicalNodeMaterial();

  // Set base color
  material.colorNode = colorUniform;

  // Animate clearcoat based on wetness
  // Wet = high clearcoat, dry = lower clearcoat
  const clearcoatValue = mix(
    float(WET_CONFIG.dryClearcoat),
    float(WET_CONFIG.wetClearcoat),
    wetnessUniform
  );
  material.clearcoatNode = clearcoatValue;

  // Animate roughness based on wetness
  // Wet = smooth, dry = rougher
  const roughnessValue = mix(
    float(WET_CONFIG.dryRoughness),
    float(WET_CONFIG.wetRoughness),
    wetnessUniform
  );
  material.clearcoatRoughnessNode = roughnessValue;

  // Add animated shimmer effect when wet
  // Uses position and time to create moving highlights
  const shimmerPhase = add(
    mul(positionLocal.x, float(50)),
    mul(positionLocal.y, float(30)),
    mul(timeUniform, float(WET_CONFIG.shimmerSpeed))
  );

  const shimmerValue = mul(
    mul(
      add(sin(shimmerPhase), float(1)),
      float(0.5)
    ),
    mul(wetnessUniform, float(WET_CONFIG.shimmerStrength))
  );

  // Add shimmer to emissive for subtle glow effect
  material.emissiveNode = mul(colorUniform, shimmerValue);

  // Calculate view-dependent specular boost
  const viewDir = normalize(sub(cameraPosition, positionLocal));
  const fresnel = pow(
    sub(float(1), max(dot(normalLocal, viewDir), float(0))),
    float(3)
  );

  // Boost specular on edges when wet (fresnel effect)
  const specularBoost = mul(
    mul(fresnel, wetnessUniform),
    float(WET_CONFIG.specularBoost)
  );

  // Add to emissive for extra shine
  material.emissiveNode = add(
    material.emissiveNode,
    mul(vec3(1, 1, 1), specularBoost)
  );

  // Set other material properties
  material.metalness = 0;
  material.roughness = finish === 'matte' ? 0.6 : 0.1;
  material.side = THREE.FrontSide;
  material.transparent = false;

  // Store uniforms for external control
  material.userData = {
    wetnessUniform,
    colorUniform,
    setWetness: (value) => {
      wetnessUniform.value = Math.max(0, Math.min(1, value));
    },
    setColor: (newColor) => {
      colorUniform.value.set(newColor);
    }
  };

  return material;
}

/**
 * WetPaintOverlay class for managing wet effect on nail canvas
 * Multi-phase drying: wet → tacky → dry with texture changes
 */
export class WetPaintOverlay {
  constructor(canvasDim = 1024) {
    this.dim = canvasDim;

    // Main overlay canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = canvasDim;
    this.canvas.height = canvasDim;
    this.ctx = this.canvas.getContext('2d');

    // Secondary buffer for leveling effect
    this.levelingBuffer = document.createElement('canvas');
    this.levelingBuffer.width = canvasDim;
    this.levelingBuffer.height = canvasDim;
    this.levelingCtx = this.levelingBuffer.getContext('2d');

    // Track wet strokes with phase data
    this.wetStrokes = [];  // {x, y, width, timestamp, color}

    // Calculate total dry time
    this.totalDryTime = DRYING_CONFIG.wetPhase + DRYING_CONFIG.tackyPhase + DRYING_CONFIG.dryPhase;

    // Create texture
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.flipY = false;
  }

  /**
   * Add wet paint stroke
   */
  addWetStroke(x, y, width, color = '#ffffff') {
    this.wetStrokes.push({
      x,
      y,
      width: width || 20,
      timestamp: performance.now(),
      color,
    });
  }

  /**
   * Get drying phase for a stroke
   */
  getDryingPhase(stroke, now) {
    const age = now - stroke.timestamp;
    const { wetPhase, tackyPhase, dryPhase, wet, tacky, dry } = DRYING_CONFIG;

    if (age < wetPhase) {
      // Wet phase
      const progress = age / wetPhase;
      return {
        phase: 'wet',
        progress,
        ...wet,
      };
    } else if (age < wetPhase + tackyPhase) {
      // Tacky phase - interpolate from wet to tacky
      const tackyAge = age - wetPhase;
      const progress = tackyAge / tackyPhase;
      return {
        phase: 'tacky',
        progress,
        glossiness: this.lerp(wet.glossiness, tacky.glossiness, progress),
        thickness: this.lerp(wet.thickness, tacky.thickness, progress),
        specularIntensity: this.lerp(wet.specularIntensity, tacky.specularIntensity, progress),
        brushMarkVisibility: this.lerp(wet.brushMarkVisibility, tacky.brushMarkVisibility, progress),
      };
    } else if (age < wetPhase + tackyPhase + dryPhase) {
      // Dry phase - interpolate from tacky to dry
      const dryAge = age - wetPhase - tackyPhase;
      const progress = dryAge / dryPhase;
      return {
        phase: 'dry',
        progress,
        glossiness: this.lerp(tacky.glossiness, dry.glossiness, progress),
        thickness: this.lerp(tacky.thickness, dry.thickness, progress),
        specularIntensity: this.lerp(tacky.specularIntensity, dry.specularIntensity, progress),
        brushMarkVisibility: this.lerp(tacky.brushMarkVisibility, dry.brushMarkVisibility, progress),
      };
    }

    // Fully cured
    return { phase: 'cured', progress: 1, ...dry };
  }

  /**
   * Linear interpolation
   */
  lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Update wet overlay with phase-aware rendering
   */
  update() {
    const now = performance.now();

    // Clear canvas
    this.ctx.clearRect(0, 0, this.dim, this.dim);

    // Filter and render wet strokes
    this.wetStrokes = this.wetStrokes.filter(stroke => {
      const age = now - stroke.timestamp;
      if (age >= this.totalDryTime) return false;

      const phase = this.getDryingPhase(stroke, now);
      this.renderWetStroke(stroke, phase);

      return true;
    });

    // Apply self-leveling blur to simulate settling
    if (this.wetStrokes.length > 0) {
      this.applyLevelingEffect();
      this.texture.needsUpdate = true;
    }
  }

  /**
   * Render a single wet stroke based on drying phase
   */
  renderWetStroke(stroke, phase) {
    this.ctx.save();

    const { x, y, width } = stroke;

    // 1. Draw thickness/shadow (gives paint body)
    if (phase.thickness > 0.1) {
      const shadowOffset = phase.thickness * 2;
      this.ctx.shadowColor = `rgba(0, 0, 0, ${phase.thickness * 0.15})`;
      this.ctx.shadowBlur = phase.thickness * 4;
      this.ctx.shadowOffsetX = shadowOffset;
      this.ctx.shadowOffsetY = shadowOffset;

      this.ctx.beginPath();
      this.ctx.arc(x, y, width * 0.8, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(255, 255, 255, ${phase.thickness * 0.05})`;
      this.ctx.fill();

      this.ctx.shadowColor = 'transparent';
    }

    // 2. Draw specular highlight
    if (phase.specularIntensity > 0.1) {
      const gradient = this.ctx.createRadialGradient(
        x - width * 0.25, y - width * 0.25, 0,
        x, y, width
      );

      const highlightOpacity = phase.specularIntensity * 0.9;
      gradient.addColorStop(0, `rgba(255, 255, 255, ${highlightOpacity})`);
      gradient.addColorStop(0.2, `rgba(255, 255, 255, ${highlightOpacity * 0.6})`);
      gradient.addColorStop(0.5, `rgba(255, 255, 255, ${highlightOpacity * 0.2})`);
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

      this.ctx.beginPath();
      this.ctx.ellipse(x, y, width, width * 0.7, -Math.PI / 5, 0, Math.PI * 2);
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
    }

    // 3. Draw brush mark texture (fades as paint levels)
    if (phase.brushMarkVisibility > 0.1) {
      this.drawBrushMarkTexture(x, y, width, phase.brushMarkVisibility);
    }

    this.ctx.restore();
  }

  /**
   * Draw subtle brush mark texture
   */
  drawBrushMarkTexture(x, y, width, visibility) {
    this.ctx.save();
    this.ctx.globalAlpha = visibility * 0.3;

    // Draw thin parallel lines to simulate brush marks
    const lineCount = 5;
    const lineSpacing = width * 0.3;

    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    this.ctx.lineWidth = 1;

    for (let i = 0; i < lineCount; i++) {
      const offset = (i - lineCount / 2) * lineSpacing;
      this.ctx.beginPath();
      this.ctx.moveTo(x - width + offset, y - width);
      this.ctx.lineTo(x - width + offset, y + width);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  /**
   * Apply gaussian blur to simulate self-leveling
   */
  applyLevelingEffect() {
    if (this.wetStrokes.length === 0) return;

    // Copy current canvas to buffer with blur
    this.levelingCtx.clearRect(0, 0, this.dim, this.dim);
    this.levelingCtx.filter = `blur(${DRYING_CONFIG.levelingBlurRadius}px)`;
    this.levelingCtx.drawImage(this.canvas, 0, 0);
    this.levelingCtx.filter = 'none';

    // Blend blurred version back at low opacity (simulates settling)
    this.ctx.globalAlpha = DRYING_CONFIG.levelingSpeed;
    this.ctx.drawImage(this.levelingBuffer, 0, 0);
    this.ctx.globalAlpha = 1.0;
  }

  /**
   * Clear all wet strokes (instant dry)
   */
  clear() {
    this.wetStrokes = [];
    this.ctx.clearRect(0, 0, this.dim, this.dim);
    this.texture.needsUpdate = true;
  }

  /**
   * Check if any strokes are still wet
   */
  hasWetStrokes() {
    return this.wetStrokes.length > 0;
  }

  /**
   * Dispose resources
   */
  dispose() {
    this.texture.dispose();
  }
}
