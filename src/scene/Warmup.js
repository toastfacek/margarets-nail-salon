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

/** Run `fn` once the page is idle, no sooner than `delayMs` from now. */
export function whenIdle(fn, delayMs = 0) {
  const run = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 1000 });
    else setTimeout(fn, 0);
  };
  if (delayMs > 0) setTimeout(run, delayMs);
  else run();
}

/** Draw the scene into one pixel of the default framebuffer. */
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
