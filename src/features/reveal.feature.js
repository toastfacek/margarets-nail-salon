/**
 * reveal.feature.js (WP7): the Slay reveal and the polaroid wall.
 *
 * Listens for `reveal:request { stars, hand, fingers }` (WP6's Done) and
 * plays the 4.5 s show (src/reveal/RevealDirector.js), which ends with
 * `reveal:done`. Sounds come from WP5's wiring of reveal:start / reveal:flash
 * / reveal:done; the director adds one soft shimmer per nail glint.
 * The polaroid wall takes over `ui:gallery`.
 *
 * Exposes app.reveal (the director) and app.polaroids (the wall).
 */
import '../../styles/reveal.css';
import { EVENTS } from '../core/GameEvents.js';
import { Confetti } from '../reveal/Confetti.js';
import { PolaroidCamera } from '../reveal/PolaroidCamera.js';
import { PolaroidWall } from '../reveal/PolaroidWall.js';
import { RevealDirector } from '../reveal/RevealDirector.js';

export const order = 75;

export function install(app) {
  const scene = app.scene;
  const confetti = new Confetti(scene.scene);
  confetti.prewarm(scene.renderer, scene.camera);
  const wall = new PolaroidWall(app.storage, app.sound);
  const reveal = new RevealDirector(app, { confetti, camera: new PolaroidCamera(), wall });

  // the confetti tail outlives the reveal by a moment; free while idle
  app.loop.add((dt) => { if (confetti.update(dt)) app.invalidate(); }, 52);

  app.events.on(EVENTS.REVEAL_REQUEST, (p) => reveal.play(p));
  app.events.on(EVENTS.UI_GALLERY, () => wall.open());
  // read the stored photos when the game is idle, not during load
  setTimeout(() => wall.load(), 1500);

  app.reveal = reveal;
  app.polaroids = wall;
}
