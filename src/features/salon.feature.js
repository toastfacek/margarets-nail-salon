/**
 * salon.feature.js (WP3)
 * Wires the salon to the loaded hand: desk placement, contact shadow bake,
 * and pre-compiles the scene-level variants of the next tier down.
 * The salon itself (environment, lights, backdrop, desk) lives in NailScene.
 */
import { setReadyCheck, setBusyCheck } from '../scene/Warmup.js';

export const order = 10;

export function install(app) {
  const scene = app.scene;
  if (!scene || !app.nail) return;
  // Deferred shader warm-ups start only once the app is ready.
  setReadyCheck(() => app.__ready === true);
  // ...and never while the player is painting or the camera is moving.
  setBusyCheck(() => !!(scene.pointerDown || scene.isAnimating || (app.polishBrush3D && app.polishBrush3D.isPainting)));
  scene.attachHand(app.nail);
  scene.precompileVariants();
  app.invalidate();
}
