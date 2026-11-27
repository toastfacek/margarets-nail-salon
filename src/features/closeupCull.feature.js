/**
 * closeupCull.feature.js (g-hv3e): the settled close-up draws only what it
 * can show (src/scene/CloseupCull.js). Runs just before the main render.
 * `?cull=0` turns it off. Exposes `app.closeupCull` (enabled, stats, reset()).
 */
import { CloseupCull } from '../scene/CloseupCull.js';

export const order = 74;

export function install(app) {
  const cull = new CloseupCull(app);
  try {
    if (new URLSearchParams(window.location.search).get('cull') === '0') cull.enabled = false;
  } catch (e) { /* on */ }
  app.closeupCull = cull;
  app.loop.add(() => cull.update(), 88);
}
