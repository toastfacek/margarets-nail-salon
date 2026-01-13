/**
 * FluidSimulator.js
 * GPU-accelerated Navier-Stokes fluid simulation in UV space
 * Based on Jos Stam's "Stable Fluids" algorithm
 */
import * as THREE from 'three';

// Vertex shader - simple fullscreen quad
const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// Advection shader - moves quantities along velocity field
const advectShader = `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform float uDt;
  uniform float uDissipation;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    vec2 vel = texture2D(uVelocity, vUv).xy;
    // Velocity is in UV space - scale by dt for frame-independent movement
    vec2 pos = vUv - vel * uDt * 0.5;
    gl_FragColor = uDissipation * texture2D(uSource, pos);
  }
`;

// Splat shader - blends paint at brush position (like real paint layering)
const splatShader = `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uPoint;
  uniform vec3 uColor;
  uniform float uRadius;
  uniform float uStrength;
  varying vec2 vUv;

  void main() {
    vec4 base = texture2D(uSource, vUv);
    float d = distance(vUv, uPoint);
    // Gaussian splat for soft-edged brush stroke
    float splat = uStrength * exp(-d * d / uRadius);
    // Blend new paint over existing with alpha
    vec3 newColor = mix(base.rgb, uColor, splat);
    float newAlpha = max(base.a, splat);
    gl_FragColor = vec4(newColor, newAlpha);
  }
`;

// Velocity splat shader - adds velocity at brush position
const velocitySplatShader = `
  precision highp float;
  uniform sampler2D uSource;
  uniform vec2 uPoint;
  uniform vec2 uVelocity;
  uniform float uRadius;
  uniform float uStrength;
  varying vec2 vUv;

  void main() {
    vec4 base = texture2D(uSource, vUv);
    float d = distance(vUv, uPoint);
    float splat = uStrength * exp(-d * d / uRadius);
    vec2 vel = splat * uVelocity;
    gl_FragColor = vec4(base.xy + vel, base.zw);
  }
`;

// Divergence shader - computes velocity divergence
const divergenceShader = `
  precision highp float;
  uniform sampler2D uVelocity;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    float L = texture2D(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).x;
    float R = texture2D(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).x;
    float T = texture2D(uVelocity, vUv + vec2(0.0, uTexelSize.y)).y;
    float B = texture2D(uVelocity, vUv - vec2(0.0, uTexelSize.y)).y;
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

// Pressure solver (Jacobi iteration)
const pressureShader = `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
    float div = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + T + B - div) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

// Gradient subtraction shader - makes velocity divergence-free
const gradientSubtractShader = `
  precision highp float;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  uniform vec2 uTexelSize;
  varying vec2 vUv;

  void main() {
    float L = texture2D(uPressure, vUv - vec2(uTexelSize.x, 0.0)).x;
    float R = texture2D(uPressure, vUv + vec2(uTexelSize.x, 0.0)).x;
    float T = texture2D(uPressure, vUv + vec2(0.0, uTexelSize.y)).x;
    float B = texture2D(uPressure, vUv - vec2(0.0, uTexelSize.y)).x;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vel -= 0.5 * vec2(R - L, T - B);
    gl_FragColor = vec4(vel, 0.0, 1.0);
  }
`;

// Copy shader - for reading back to canvas
const copyShader = `
  precision highp float;
  uniform sampler2D uSource;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(uSource, vUv);
  }
`;

export class FluidSimulator {
  constructor(renderer, size = 512) {
    this.renderer = renderer;
    this.size = size;
    this.texelSize = new THREE.Vector2(1.0 / size, 1.0 / size);

    // Simulation parameters
    this.config = {
      velocityDissipation: 0.85,   // Velocity fades quickly to prevent excessive spreading
      paintDissipation: 1.0,       // Paint doesn't fade at all
      pressureIterations: 10,
      splatRadius: 0.006,          // Balanced brush strokes (Gaussian exp(-d²/r))
      splatStrength: 1.0,          // Normal strength
    };

    // Create render targets (double-buffered)
    this.velocity = this.createDoubleFBO();
    this.paint = this.createDoubleFBO();
    this.pressure = this.createDoubleFBO();
    this.divergence = this.createFBO();

    // Create shader materials
    this.materials = this.createMaterials();

    // Fullscreen quad for rendering
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      null
    );
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene.add(this.quad);

    // Track last UV for velocity calculation
    this.lastUV = null;

    // Initialize all render targets to clear state
    this.clear();
  }

  /**
   * Create a single framebuffer object
   */
  createFBO() {
    const rt = new THREE.WebGLRenderTarget(this.size, this.size, {
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    // Match the flipY setting used by the nail overlay texture
    rt.texture.flipY = false;
    return rt;
  }

  /**
   * Create double-buffered FBO pair for ping-pong rendering
   */
  createDoubleFBO() {
    return {
      read: this.createFBO(),
      write: this.createFBO(),
      swap() {
        const temp = this.read;
        this.read = this.write;
        this.write = temp;
      }
    };
  }

  /**
   * Create all shader materials
   */
  createMaterials() {
    return {
      advect: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: advectShader,
        uniforms: {
          uVelocity: { value: null },
          uSource: { value: null },
          uDt: { value: 0.016 },
          uDissipation: { value: 0.98 },
          uTexelSize: { value: this.texelSize },
        }
      }),

      splat: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: splatShader,
        uniforms: {
          uSource: { value: null },
          uPoint: { value: new THREE.Vector2() },
          uColor: { value: new THREE.Vector3() },
          uRadius: { value: 0.01 },
          uStrength: { value: 0.8 },
        }
      }),

      velocitySplat: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: velocitySplatShader,
        uniforms: {
          uSource: { value: null },
          uPoint: { value: new THREE.Vector2() },
          uVelocity: { value: new THREE.Vector2() },
          uRadius: { value: 0.01 },
          uStrength: { value: 1.0 },
        }
      }),

      divergence: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: divergenceShader,
        uniforms: {
          uVelocity: { value: null },
          uTexelSize: { value: this.texelSize },
        }
      }),

      pressure: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: pressureShader,
        uniforms: {
          uPressure: { value: null },
          uDivergence: { value: null },
          uTexelSize: { value: this.texelSize },
        }
      }),

      gradientSubtract: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: gradientSubtractShader,
        uniforms: {
          uPressure: { value: null },
          uVelocity: { value: null },
          uTexelSize: { value: this.texelSize },
        }
      }),

      copy: new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader: copyShader,
        uniforms: {
          uSource: { value: null },
        }
      }),
    };
  }

  /**
   * Render a pass with given material to target
   */
  renderPass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    // console.log('renderPass completed to target:', target.texture.uuid);
  }

  /**
   * Add paint splat at UV position with velocity
   */
  splat(u, v, velocityX, velocityY, color) {
    const point = new THREE.Vector2(u, v);

    // Parse color to RGB values (0-1 range)
    const c = new THREE.Color(color);
    const colorVec = new THREE.Vector3(c.r, c.g, c.b);

    // Add velocity splat from brush movement only
    const velMat = this.materials.velocitySplat;
    velMat.uniforms.uSource.value = this.velocity.read.texture;
    velMat.uniforms.uPoint.value = point;
    velMat.uniforms.uVelocity.value.set(velocityX, velocityY);
    velMat.uniforms.uRadius.value = this.config.splatRadius;
    velMat.uniforms.uStrength.value = this.config.splatStrength;
    this.renderPass(velMat, this.velocity.write);
    this.velocity.swap();

    // Add paint splat with soft Gaussian edges
    const tempSplatMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uSource;
        uniform vec2 uPoint;
        uniform vec3 uColor;
        uniform float uRadius;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(uSource, vUv);
          float d = distance(vUv, uPoint);
          // Soft Gaussian splat
          float splat = uStrength * exp(-d * d / uRadius);
          // Blend colors - new paint covers old
          vec3 blended = mix(base.rgb, uColor, min(1.0, splat));
          float newAlpha = max(base.a, min(1.0, splat));
          gl_FragColor = vec4(blended, newAlpha);
        }
      `,
      uniforms: {
        uSource: { value: this.paint.read.texture },
        uPoint: { value: point },
        uColor: { value: colorVec },
        uRadius: { value: this.config.splatRadius },
        uStrength: { value: this.config.splatStrength }
      }
    });
    this.renderPass(tempSplatMat, this.paint.write);
    tempSplatMat.dispose();
    this.paint.swap();
  }

  /**
   * Step the simulation forward
   */
  step(dt) {
    // Clamp dt to avoid instability
    dt = Math.min(dt, 0.033);

    // Advect velocity
    const advect = this.materials.advect;
    advect.uniforms.uVelocity.value = this.velocity.read.texture;
    advect.uniforms.uSource.value = this.velocity.read.texture;
    advect.uniforms.uDt.value = dt;
    advect.uniforms.uDissipation.value = this.config.velocityDissipation;
    this.renderPass(advect, this.velocity.write);
    this.velocity.swap();

    // Advect paint
    advect.uniforms.uVelocity.value = this.velocity.read.texture;
    advect.uniforms.uSource.value = this.paint.read.texture;
    advect.uniforms.uDissipation.value = this.config.paintDissipation;
    this.renderPass(advect, this.paint.write);
    this.paint.swap();

    // Compute divergence
    const divergence = this.materials.divergence;
    divergence.uniforms.uVelocity.value = this.velocity.read.texture;
    this.renderPass(divergence, this.divergence);

    // Clear pressure
    this.renderer.setRenderTarget(this.pressure.read);
    this.renderer.clearColor();
    this.renderer.setRenderTarget(null);

    // Pressure solve (Jacobi iteration)
    const pressure = this.materials.pressure;
    pressure.uniforms.uDivergence.value = this.divergence.texture;
    for (let i = 0; i < this.config.pressureIterations; i++) {
      pressure.uniforms.uPressure.value = this.pressure.read.texture;
      this.renderPass(pressure, this.pressure.write);
      this.pressure.swap();
    }

    // Subtract pressure gradient from velocity
    const gradient = this.materials.gradientSubtract;
    gradient.uniforms.uPressure.value = this.pressure.read.texture;
    gradient.uniforms.uVelocity.value = this.velocity.read.texture;
    this.renderPass(gradient, this.velocity.write);
    this.velocity.swap();
  }

  /**
   * Get the paint texture for rendering to nail
   */
  getTexture() {
    return this.paint.read.texture;
  }

  /**
   * Copy fluid simulation output to a 2D canvas
   */
  copyToCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Read pixels from the paint texture
    const pixels = new Float32Array(this.size * this.size * 4);
    this.renderer.setRenderTarget(this.paint.read);
    this.renderer.readRenderTargetPixels(
      this.paint.read,
      0, 0,
      this.size, this.size,
      pixels
    );
    this.renderer.setRenderTarget(null);

    // Convert to ImageData
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    // Scale factor if sizes differ
    const scaleX = this.size / width;
    const scaleY = this.size / height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Sample from fluid sim (with scaling)
        const sx = Math.floor(x * scaleX);
        const sy = Math.floor(y * scaleY);
        const srcIdx = (sy * this.size + sx) * 4;

        const dstIdx = (y * width + x) * 4;
        data[dstIdx] = Math.min(255, pixels[srcIdx] * 255);
        data[dstIdx + 1] = Math.min(255, pixels[srcIdx + 1] * 255);
        data[dstIdx + 2] = Math.min(255, pixels[srcIdx + 2] * 255);
        data[dstIdx + 3] = Math.min(255, pixels[srcIdx + 3] * 255);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Clear the simulation
   */
  clear() {
    this.renderer.setRenderTarget(this.velocity.read);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.velocity.write);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.paint.read);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.paint.write);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.pressure.read);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.pressure.write);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);
    this.lastUV = null;
  }

  /**
   * Set simulation parameters
   */
  setConfig(config) {
    Object.assign(this.config, config);
  }

  /**
   * Debug: Fill paint texture with a solid color
   */
  debugFill(color = '#ff0000') {
    const c = new THREE.Color(color);
    const debugMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform vec3 uColor;
        void main() {
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
      uniforms: {
        uColor: { value: new THREE.Vector3(c.r, c.g, c.b) }
      }
    });
    this.renderPass(debugMat, this.paint.write);
    this.paint.swap();
    debugMat.dispose();
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this.velocity.read.dispose();
    this.velocity.write.dispose();
    this.paint.read.dispose();
    this.paint.write.dispose();
    this.pressure.read.dispose();
    this.pressure.write.dispose();
    this.divergence.dispose();

    Object.values(this.materials).forEach(mat => mat.dispose());
    this.quad.geometry.dispose();
  }
}
