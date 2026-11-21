/**
 * BrushInputHandler.js
 * Maps pointer input to a 3D brush position on the nail surface.
 *
 * No allocations per frame: `getBrushTransform()` writes into one reused
 * result object (vectors included). Callers must copy what they keep.
 */
import * as THREE from 'three';

const BRUSH_CONFIG = Object.freeze({
  defaultDistance: 0.6,   // distance from camera when not over the nail
  hoverHeight: 0.02,      // height above the surface when hovering
  pressHeight: 0.005,     // height above the surface when pressed
});
// Offset to put the brush tip at the cursor (diagonal brush), camera space.
const TIP_OFFSET = Object.freeze(new THREE.Vector3(0.005, -0.005, 0));
const UP = Object.freeze(new THREE.Vector3(0, 1, 0));
// On touch the paint point sits this far above the fingertip (CSS px), so the
// bristle tip stays visible instead of hiding under the finger.
const TOUCH_LIFT_PX = 40;

export class BrushInputHandler {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true; // three-mesh-bvh: stop at the first hit
    this.mouse = new THREE.Vector2();

    this.isPointerDown = false;
    this.pointerPosition = new THREE.Vector2();
    this.hasPointer = false;
    this.moved = false;            // set by pointer events, cleared by consumeMoved()
    this.isTouch = false;          // last pointer was a finger

    this.simulatedPressure = 0;
    this.pressureVelocity = 0;

    // Reused scratch and result.
    this._hits = [];
    this._toCamera = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this.result = {
      position: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),        // brush axis (towards camera)
      surfacePoint: new THREE.Vector3(),
      surfaceNormal: new THREE.Vector3(0, 1, 0), // world-space face normal
      uv: new THREE.Vector2(),
      hasUV: false,
      pressure: 0,
      isValid: false,
      isTouch: false,
    };
    this.lastValidHit = null;

    // Canvas rect, cached: getBoundingClientRect allocates, so it is only
    // re-read on attach, pointerdown and window resize.
    this._rectLeft = 0;
    this._rectTop = 0;
    this._rectWidth = 1;
    this._rectHeight = 1;
    this._refreshRect = this._refreshRect.bind(this);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
  }

  _refreshRect() {
    const rect = this.domElement.getBoundingClientRect();
    this._rectLeft = rect.left;
    this._rectTop = rect.top;
    this._rectWidth = rect.width || 1;
    this._rectHeight = rect.height || 1;
  }

  attach() {
    this._refreshRect();
    window.addEventListener('resize', this._refreshRect);
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointerleave', this.onPointerUp);
    this.domElement.addEventListener('pointercancel', this.onPointerUp);
  }

  detach() {
    window.removeEventListener('resize', this._refreshRect);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointerleave', this.onPointerUp);
    this.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.isPointerDown = false;
    this.simulatedPressure = 0;
  }

  updateMousePosition(event) {
    this.isTouch = event.pointerType === 'touch';
    const y = this.isTouch ? event.clientY - TOUCH_LIFT_PX : event.clientY;
    this.mouse.x = ((event.clientX - this._rectLeft) / this._rectWidth) * 2 - 1;
    this.mouse.y = -((y - this._rectTop) / this._rectHeight) * 2 + 1;
    this.pointerPosition.set(event.clientX, event.clientY);
    this.hasPointer = true;
    this.moved = true;
  }

  onPointerDown(event) {
    this._refreshRect();
    this.isPointerDown = true;
    this.updateMousePosition(event);
    this.simulatedPressure = 0.35;  // immediate pressure for a responsive feel
  }

  onPointerMove(event) {
    this.updateMousePosition(event);
    if (event.pressure && event.pressure > 0 && event.pressure < 1) {
      this.simulatedPressure = event.pressure;
    }
  }

  onPointerUp() {
    if (this.isPointerDown) this.moved = true;
    this.isPointerDown = false;
    this.simulatedPressure = 0;
  }

  /** True once per pointer change. */
  consumeMoved() {
    const m = this.moved;
    this.moved = false;
    return m;
  }

  /**
   * Ramp simulated pressure. Returns true while it is still changing.
   */
  updatePressure(deltaTime) {
    const before = this.simulatedPressure;
    if (this.isPointerDown) {
      this.simulatedPressure = Math.min(1, this.simulatedPressure + deltaTime * 10);
    } else {
      this.simulatedPressure = Math.max(0, this.simulatedPressure - deltaTime * 8);
    }
    return this.simulatedPressure !== before;
  }

  /**
   * Brush transform: on the nail surface when the pointer is over the nail,
   * otherwise at a fixed distance in front of the camera.
   * @param {THREE.Mesh} nailMesh
   * @returns {object} the reused result object
   */
  getBrushTransform(nailMesh) {
    const out = this.result;
    const cam = this.camera;
    out.isTouch = this.isTouch;
    this.raycaster.setFromCamera(this.mouse, cam);

    if (nailMesh && this.hasPointer) {
      const hits = this._hits;
      hits.length = 0;
      this.raycaster.intersectObject(nailMesh, false, hits);
      if (hits.length > 0) {
        const hit = hits[0];
        const height = this.isPointerDown
          ? BRUSH_CONFIG.pressHeight + (BRUSH_CONFIG.hoverHeight - BRUSH_CONFIG.pressHeight) * (1 - this.simulatedPressure)
          : BRUSH_CONFIG.hoverHeight;

        const toCamera = this._toCamera.copy(cam.position).sub(hit.point).normalize();
        out.surfacePoint.copy(hit.point);
        out.position.copy(hit.point).addScaledVector(toCamera, height);
        out.position.add(this._tip.copy(TIP_OFFSET).applyQuaternion(cam.quaternion));
        out.normal.copy(toCamera);
        if (hit.face) {
          out.surfaceNormal.copy(hit.face.normal).transformDirection(nailMesh.matrixWorld);
          if (out.surfaceNormal.dot(toCamera) < 0) out.surfaceNormal.negate();
        } else {
          out.surfaceNormal.copy(toCamera);
        }
        if (hit.uv) {
          out.uv.copy(hit.uv);
          out.hasUV = true;
        } else {
          out.hasUV = false;
        }
        out.pressure = this.isPointerDown ? this.simulatedPressure : 0;
        out.isValid = true;
        hits.length = 0;
        this.lastValidHit = out;
        return out;
      }
    }

    // Not over the nail: fixed distance in front of the camera.
    out.position.copy(cam.position).addScaledVector(this.raycaster.ray.direction, BRUSH_CONFIG.defaultDistance);
    out.position.add(this._tip.copy(TIP_OFFSET).applyQuaternion(cam.quaternion));
    out.normal.copy(UP);
    out.surfacePoint.copy(out.position);
    out.surfaceNormal.copy(UP);
    out.hasUV = false;
    out.pressure = 0;
    out.isValid = false;
    return out;
  }

  isPainting() {
    return this.isPointerDown;
  }

  getPressure() {
    return this.simulatedPressure;
  }
}
