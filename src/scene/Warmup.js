/**
 * Warmup.js
 * Deferred shader warm-up. Programs that are not needed for the first frame
 * (the next tier down, rarely seen views) are compiled later, at idle, by
 * drawing them once into a 1x1 scissor of the default framebuffer: that
 * compiles, links and JITs exactly the program the real frame will use
 * (same tone mapping and output colour space), at the cost of the vertex work
 * of one draw. The caller swaps materials in before and out after, in the
 * same task, and invalidates so the next frame repaints the pixel.
 */
import * as THREE from 'three';

const _scissor = new THREE.Vector4();

// Nothing runs until salon.feature.js says the app is ready.
let readyCheck = () => false;
let busyCheck = () => false;

/**
 * Gate every deferred warm-up on the app being ready (salon.feature.js sets
 * this to `() => app.__ready`), so none of it ever lands in the load, and
 * hold it back while the player is busy (pointer down, painting, camera
 * moving), so it never lands on a stroke.
 */
export function setReadyCheck(fn) {
  readyCheck = fn;
}
export function setBusyCheck(fn) {
  busyCheck = fn;
}

/**
 * Run `fn` once the app is ready, no sooner than `delayMs` after that, at an
 * idle moment when the player is not busy. Each call is its own task: split
 * big warm-ups into several calls.
 */
export function whenIdle(fn, delayMs = 0) {
  const attempt = () => {
    if (busyCheck()) {
      setTimeout(attempt, 400);
      return;
    }
    fn();
  };
  const run = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(attempt, { timeout: 1000 });
    else setTimeout(attempt, 0);
  };
  const wait = () => {
    if (!readyCheck()) {
      setTimeout(wait, 250);
      return;
    }
    if (delayMs > 0) setTimeout(run, delayMs);
    else run();
  };
  wait();
}

/**
 * Draw `scene` (or a single object: only for ShaderMaterials, which do not
 * depend on the scene's lights) into one pixel of the default framebuffer.
 */
export function warmRender(renderer, scene, camera) {
  const prevTarget = renderer.getRenderTarget();
  const prevTest = renderer.getScissorTest();
  renderer.getScissor(_scissor);
  renderer.setRenderTarget(null);
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, 1, 1);
  try {
    renderer.render(scene, camera);
  } catch (err) {
    // a warm-up is an optimisation only
  }
  renderer.setScissor(_scissor);
  renderer.setScissorTest(prevTest);
  renderer.setRenderTarget(prevTarget);
}
