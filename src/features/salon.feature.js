/**
 * salon.feature.js (WP3)
 * Wires the salon to the loaded hand: desk placement, contact shadow bake,
 * and pre-compiles the scene-level variants of the next tier down.
 * The salon itself (environment, lights, backdrop, desk) lives in NailScene.
 */
export const order = 10;

export function install(app) {
  const scene = app.scene;
  if (!scene || !app.nail) return;
  scene.attachHand(app.nail);
  scene.precompileVariants();
  app.invalidate();
}
