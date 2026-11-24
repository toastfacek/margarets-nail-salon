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
 * Events: brush:strokeStart / strokeEnd damp the idle; brush:stroke drives
 * the press-give; reveal:start fans the fingers, reveal:flash wiggles them,
 * reveal:done hands the pose back to the camera.
 * Render-on-demand tiers: idle motion asks for a frame at most every 33 ms
 * (medium) or 50 ms (low); pose changes, the press-give and one-shots ask
 * every frame while they run, then stop.
 */
import { EVENTS } from '../core/GameEvents.js';
import { HandAnimator } from '../scene/HandRig.js';

export const order = 71;

export function install(app) {
  const hand = new HandAnimator(app.nail, app.scene);
  app.hand = hand;
  app.scene.handPose = (pose, fn) => hand.withPose(pose, fn);
  // a close-up framed before the rig existed was framed on the rest pose:
  // re-frame once, as soon as the shown hand's rig is there
  let framed = false;

  let reduced = false;
  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduced = false; }
  hand.setIdle(reduced ? 0 : 1);

  app.loop.add((dt, time) => {
    if (!framed && hand.rig) {
      framed = true;
      app.scene.reframe();
    }
    if (!hand.update(dt)) return;
    const s = app.quality.settings;
    if (!hand.settled || !hand.idleRunning || !s || !s.renderOnDemand) {
      app.invalidate();
      return;
    }
    // only the idle layer moved: a throttled frame on render-on-demand tiers
    if (hand.idleWantsRender(time, app.quality.tier === 'low' ? 50 : 33)) app.invalidate();
  }, 6);
  // any rendered frame (the 250 ms safety net, the UI) also shows the idle pose
  app.loop.add((dt, time, loop) => { if (loop.renderedThisFrame) hand.noteRendered(time); }, 98);

  const ev = app.events;
  ev.on(EVENTS.BRUSH_STROKE_START, () => hand.setStroke(true));
  ev.on(EVENTS.BRUSH_STROKE, (p) => hand.setPress(Math.min(1, 0.35 + 0.65 * (p.pressure || 0)), p.u));
  ev.on(EVENTS.BRUSH_STROKE_END, () => { hand.setStroke(false); hand.setPress(0); });
  ev.on(EVENTS.REVEAL_START, () => hand.setPose('fan'));
  ev.on(EVENTS.REVEAL_FLASH, () => hand.play('wiggle'));
  ev.on(EVENTS.REVEAL_DONE, () => hand.setPose('auto'));
}
