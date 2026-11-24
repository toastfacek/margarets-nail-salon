/**
 * handPose.feature.js (B9.4 / B9.5): the hand you can pose.
 *
 * Creates app.hand (src/scene/HandRig.js HandAnimator) and runs it at loop
 * order 6: after the camera (5), before input and the brush (10), so the
 * nail's matrixWorld is current when the pointer is raycast.
 *
 * In the close-up the hand presents the finger on screen (a pure function of
 * the camera rail position, NailScene.railS, so hand and camera cannot drift
 * apart); zoomed out it rests in the file's pose. The camera rail, focusPose
 * and the contact shadow measure the hand through app.hand.withPose
 * (NailScene.handPose).
 *
 * Events: brush:strokeStart / strokeEnd damp the idle (the press-give is
 * available as app.hand.setPress, not driven by the brush); reveal:start fans
 * the fingers, reveal:flash wiggles them, reveal:done hands the pose back to
 * the camera at once (no spring: the camera cuts back too).
 * Render-on-demand tiers: idle motion, and the other fingers' trailing wobble
 * once the presented finger is still, ask for a frame at most every 33 ms
 * (medium) or 50 ms (low); pose changes of the presented finger, the palm and
 * the wrist, the press-give and one-shots ask every frame while they run,
 * then stop.
 */
import { EVENTS } from '../core/GameEvents.js';
import { HandAnimator } from '../scene/HandRig.js';

export const order = 71;

export function install(app) {
  const hand = new HandAnimator(app.nail, app.scene);
  app.hand = hand;
  app.scene.handPose = (pose, fn) => hand.withPose(pose, fn);
  // a close-up framed before the rig existed was framed on the file's rest
  // pose, and the contact shadow baked on it (the thumb sticking out): bake
  // and re-frame once, as soon as the shown hand's rig is there (switching
  // hands re-bakes through HandModel.onHandShown, by then through withPose)
  let framed = false;

  let reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduced = false; }
  hand.setIdle(reduced ? 0 : 1);
  // A/B the animation styles: ?handfeel=softpop|snappyjelly|cartoon|jelly
  try {
    const feel = new URLSearchParams(window.location.search).get('handfeel');
    if (feel && hand.motion.presets[feel]) hand.motion.preset = feel;
  } catch (e) { /* default feel */ }

  app.loop.add((dt, time) => {
    if (!framed && hand.rig) {
      framed = true;
      app.scene.rebakeHand();
      app.scene.reframe();
    }
    if (!hand.update(dt)) return;
    const s = app.quality.settings;
    if (!hand.settled || (!hand.idleRunning && !hand.trailing) || !s || !s.renderOnDemand) {
      app.invalidate();
      return;
    }
    // only the idle layer moved, or the other fingers trailing after a finger
    // change (the presented one is still): a throttled frame on
    // render-on-demand tiers
    if (hand.idleWantsRender(time, app.quality.tier === 'low' ? 50 : 33)) app.invalidate();
  }, 6);
  // any rendered frame (the 250 ms safety net, the UI) also shows the idle pose
  app.loop.add((dt, time, loop) => { if (loop.renderedThisFrame) hand.noteRendered(time); }, 98);

  const ev = app.events;
  // The press-give (app.hand.setPress) is not driven by the brush by default:
  // any motion of the active nail under a stroke shifts the pointer samples
  // that are cast at the next frame (brush-feel A3 / A6 regress with it).
  // Game code can still call setPress; the brush damps the idle.
  ev.on(EVENTS.BRUSH_STROKE_START, () => hand.setStroke(true));
  ev.on(EVENTS.BRUSH_STROKE_END, () => { hand.setStroke(false); hand.setPress(0); });
  ev.on(EVENTS.REVEAL_START, () => hand.setPose('fan'));
  ev.on(EVENTS.REVEAL_FLASH, () => hand.play('wiggle'));
  // the camera cuts straight back to the close-up: the hand jumps to the
  // presented pose with it (springing there from the fan would leave the nail
  // drifting under a still camera for a second or more)
  ev.on(EVENTS.REVEAL_DONE, () => { hand.setPose('auto'); hand.snapToTarget(); });
}
