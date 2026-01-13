/**
 * BrushInputHandler.js
 * Maps pointer input to 3D brush position on nail surface
 * Brush follows cursor in screen space for consistent feel
 */
import * as THREE from 'three';

// Screen-space brush positioning config
const BRUSH_CONFIG = {
  // Distance from camera for brush when not over nail
  defaultDistance: 0.6,
  // Height above nail surface when hovering
  hoverHeight: 0.02,
  // Height above nail surface when pressed
  pressHeight: 0.005,
  // Offset to position brush tip at cursor (diagonal brush)
  tipOffset: new THREE.Vector3(0.005, -0.005, 0),
};

export class BrushInputHandler {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Current state
    this.isPointerDown = false;
    this.pointerPosition = new THREE.Vector2();
    this.lastValidHit = null;

    // Pressure simulation (for devices without pressure support)
    this.simulatedPressure = 0;
    this.pressureVelocity = 0;

    // Bind methods
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  /**
   * Start listening for input events
   */
  attach() {
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointerleave', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Stop listening for input events
   */
  detach() {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointerleave', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Convert pointer event to normalized device coordinates
   */
  updateMousePosition(event) {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerPosition.set(event.clientX, event.clientY);
  }

  onPointerDown(event) {
    this.isPointerDown = true;
    this.updateMousePosition(event);
    this.simulatedPressure = 0.35;  // Start with immediate pressure for responsive feel
  }

  onPointerMove(event) {
    this.updateMousePosition(event);

    // Get actual pressure if available, otherwise simulate
    if (event.pressure && event.pressure > 0 && event.pressure < 1) {
      this.simulatedPressure = event.pressure;
    }
  }

  onPointerUp() {
    this.isPointerDown = false;
    this.simulatedPressure = 0;
  }

  /**
   * Update simulated pressure (ramps up while pressed)
   */
  updatePressure(deltaTime) {
    if (this.isPointerDown) {
      // Fast ramp up for immediate paint coverage
      this.simulatedPressure = Math.min(1, this.simulatedPressure + deltaTime * 10);
    } else {
      // Quickly release
      this.simulatedPressure = Math.max(0, this.simulatedPressure - deltaTime * 8);
    }
  }

  /**
   * Get brush transform - positions brush at nail surface when over nail,
   * or at screen-space position when not over nail
   * @param {THREE.Mesh} nailMesh - The nail mesh to raycast against
   * @returns {Object|null} Transform info or null if no hit
   */
  getBrushTransform(nailMesh) {
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Check if we're over the nail
    if (nailMesh) {
      const intersects = this.raycaster.intersectObject(nailMesh, true);

      if (intersects.length > 0) {
        const hit = intersects[0];

        // Calculate height above surface based on pressure
        const height = this.isPointerDown
          ? BRUSH_CONFIG.pressHeight +
            (BRUSH_CONFIG.hoverHeight - BRUSH_CONFIG.pressHeight) *
              (1 - this.simulatedPressure)
          : BRUSH_CONFIG.hoverHeight;

        // Position brush at hit point, offset towards camera
        const position = hit.point.clone();

        // Move towards camera (so brush is in front of nail, not behind)
        const toCamera = this.camera.position.clone().sub(hit.point).normalize();
        position.addScaledVector(toCamera, height);

        // Apply small tip offset in screen space
        const tipOffset = BRUSH_CONFIG.tipOffset.clone();
        tipOffset.applyQuaternion(this.camera.quaternion);
        position.add(tipOffset);

        this.lastValidHit = {
          position,
          normal: toCamera,
          surfacePoint: hit.point.clone(),
          uv: hit.uv?.clone(),
          pressure: this.isPointerDown ? this.simulatedPressure : 0,
          isValid: true,
        };

        return this.lastValidHit;
      }
    }

    // Not over nail - position brush at fixed distance from camera
    const screenPosition = new THREE.Vector3();
    screenPosition.copy(this.camera.position);
    screenPosition.addScaledVector(
      this.raycaster.ray.direction,
      BRUSH_CONFIG.defaultDistance
    );

    // Apply tip offset
    const tipOffset = BRUSH_CONFIG.tipOffset.clone();
    tipOffset.applyQuaternion(this.camera.quaternion);
    screenPosition.add(tipOffset);

    return {
      position: screenPosition,
      normal: new THREE.Vector3(0, 1, 0),
      surfacePoint: screenPosition.clone(),
      uv: null,
      pressure: 0,
      isValid: false,
    };
  }

  /**
   * Check if pointer is currently down
   */
  isPainting() {
    return this.isPointerDown;
  }

  /**
   * Get current pressure
   */
  getPressure() {
    return this.simulatedPressure;
  }
}
