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
// On touch the paint point sits above the fingertip so the bristle tip stays
// visible instead of hiding under the finger. The lift scales with the nail's
// on-screen height and tapers to 0 at the nail's top edge, so a poke anywhere
// on the nail still lands on the nail.
export const TOUCH_LIFT = Object.freeze({ maxPx: 40, fraction: 0.2 });

/**
 * Touch lift in CSS px for a finger at `touchY`, given the nail's on-screen
 * top and bottom (CSS px, top < bottom). Pure; WP6's ghost finger can use it.
 * @param {number} touchY
 * @param {number} nailTop
 * @param {number} nailBottom
 * @returns {number}
 */
export function touchLiftPx(touchY, nailTop, nailBottom) {
  const h = nailBottom - nailTop;
  if (!(h > 0)) return 0;
  const full = Math.min(TOUCH_LIFT.maxPx, TOUCH_LIFT.fraction * h);
  // 0 at the top edge, full lift once the finger is `full` px below it (and
  // anywhere lower, including below the nail).
  const below = touchY - nailTop;
  if (below <= 0) return 0;
  return below >= full ? full : below;
}

const _corner = new THREE.Vector3();

export class BrushInputHandler {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.isPointerDown = false;
    this.pointerPosition = new THREE.Vector2();
    this.hasPointer = false;
    this.moved = false;            // set by pointer events, cleared by consumeMoved()
    this.isTouch = false;          // last pointer was a finger
    this._clientX = 0;
    this._clientY = 0;
    this.touchLift = 0;            // CSS px applied to the last touch

    this.simulatedPressure = 0;
    this.pressureVelocity = 0;

    // Reused scratch and result.
    this._hits = [];
    this._toCamera = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._span = { top: 0, bottom: 0 };
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
    this._clientX = event.clientX;
    this._clientY = event.clientY;
    this._setMouse(event.clientX, event.clientY);
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

  _setMouse(x, y) {
    this.mouse.x = ((x - this._rectLeft) / this._rectWidth) * 2 - 1;
    this.mouse.y = -((y - this._rectTop) / this._rectHeight) * 2 + 1;
  }

  /**
   * The nail's on-screen vertical extent in CSS px (projected bounding box),
   * written into `out` as { top, bottom }. Returns false without a nail.
   */
  nailScreenSpan(nailMesh, out) {
    if (!nailMesh || !nailMesh.geometry) return false;
    const geo = nailMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(nailMesh.matrixWorld).project(this.camera);
      const y = this._rectTop + (1 - _corner.y) * 0.5 * this._rectHeight;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    out.top = top;
    out.bottom = bottom;
    return bottom > top;
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
    const hits = this._hits;
    hits.length = 0;
    let cast = false; // already raycast at the final pointer position
    if (this.isTouch) {
      // Lift from the projected nail box, then make sure a finger that is on
      // the nail still paints the nail: the box top can sit above the real
      // silhouette, so fall back to half the lift, then none (a few
      // thousand triangles per nail: cheap).
      const span = this._span;
      const full = this.nailScreenSpan(nailMesh, span) ? touchLiftPx(this._clientY, span.top, span.bottom) : 0;
      let lift = full;
      for (let k = 0; k < 3; k++) {
        lift = k === 0 ? full : k === 1 ? full * 0.5 : 0;
        this._setMouse(this._clientX, this._clientY - lift);
        this.raycaster.setFromCamera(this.mouse, cam);
        if (!nailMesh || !this.hasPointer || full <= 0) break;
        this.raycaster.intersectObject(nailMesh, false, hits);
        cast = true;
        if (hits.length > 0) break;
        if (k === 2) {
          // finger off the nail: keep the full lift for the hovering brush
          lift = full;
          this._setMouse(this._clientX, this._clientY - lift);
          this.raycaster.setFromCamera(this.mouse, cam);
        }
      }
      this.touchLift = lift;
    } else {
      this.touchLift = 0;
      this.raycaster.setFromCamera(this.mouse, cam);
    }

    if (nailMesh && this.hasPointer) {
      if (!cast) this.raycaster.intersectObject(nailMesh, false, hits);
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
