/**
 * audio.feature.js (WP5)
 * Wires the sound manager to the event spine (build plan 0.4). Every sound in
 * the game follows from an event here, or from a legacy direct call that the
 * manager de-duplicates.
 *
 * Per-frame path: only `brush:stroke`, which forwards two numbers to the one
 * live BrushVoice. Nothing here allocates per frame.
 */

import { EVENTS } from '../core/GameEvents.js';
import { soundManager } from '../audio/SoundManager.js';

export const order = 20;

const TOOL_TAP = { shape: 2, bling: 5, sticker: 5, gem: 6, brush: 3, file: 1 };

export function install(app) {
  const sm = soundManager;
  const ev = app.events;
  sm.init();
  if (!ev) return;

  // ---------------------------------------------------------- brush --
  ev.on(EVENTS.BRUSH_STROKE_START, () => sm.brushStart(0.5));
  ev.on(EVENTS.BRUSH_STROKE, (p) => {
    sm.brushUpdate(p.speed, p.pressure);
  });
  ev.on(EVENTS.BRUSH_STROKE_END, () => {
    sm.brushEnd();
  });

  // ------------------------------------------------------- coverage --
  // Per nail: the last tenth of coverage that played a note.
  const steps = Object.create(null);
  ev.on(EVENTS.NAIL_COVERAGE, (p) => {
    let byFinger = steps[p.hand];
    if (byFinger === undefined) byFinger = steps[p.hand] = Object.create(null);
    const last = byFinger[p.finger] || 0;
    const step = Math.floor(p.coverage * 10 + 1e-6);
    if (step > last) {
      byFinger[p.finger] = step;
      if (step >= 1 && step <= 9) sm.coverageRise(p.coverage);
    } else if (step < last) {
      byFinger[p.finger] = step; // cleared: let it climb again
    }
  });
  ev.on(EVENTS.NAIL_COVERED, () => sm.covered());
  ev.on(EVENTS.NAIL_CURED, () => {
    sm.dryerStop();
    sm.cureTing();
  });
  ev.on(EVENTS.DRYER_START, () => sm.dryerStart());
  ev.on(EVENTS.DRYER_STOP, () => sm.dryerStop());

  // ----------------------------------------------------- decoration --
  ev.on(EVENTS.DECO_PLACED, (p) => {
    const type = p && p.type ? String(p.type) : '';
    if (type.indexOf('gem') !== -1) sm.gemClink();
    else sm.stickerPop();
  });

  // ------------------------------------------------------------- UI --
  ev.on(EVENTS.TOOL_CHANGE, (p) => {
    const tool = p && p.tool;
    if (tool === 'polish') sm.bottlePop();
    else sm.uiTap(TOOL_TAP[tool] !== undefined ? TOOL_TAP[tool] : 4);
    sm.holdTaps(); // main.js follows with playClick() for the same click
  });
  ev.on(EVENTS.NAIL_SELECT, () => sm.swish(0.5));
  ev.on(EVENTS.UI_MUTE, (p) => {
    if (p && typeof p.muted === 'boolean') sm.setMuted(p.muted, 'user');
    else sm.toggleMute();
  });

  // ---------------------------------------------------- round / reveal --
  ev.on(EVENTS.ROUND_START, () => sm.doorBell());
  ev.on(EVENTS.REVEAL_START, () => {
    sm.duck(0.85, 5);
    sm.brushEnd();
    sm.dryerStop();
    sm.flashWhoosh();
  });
  ev.on(EVENTS.REVEAL_FLASH, (p) => {
    sm.shutter();
    sm.play('confettiPop', 0, 0.06);
    sm.play('revealJingle', p && p.stars ? p.stars : 1, 0.18);
  });
  ev.on(EVENTS.REVEAL_DONE, () => sm.clientYay());
}
