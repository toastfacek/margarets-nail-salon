/**
 * bowl.feature.js (WP9): the swirl bowl (water marbling). Everything lives in
 * src/bowl/SwirlBowl.js; this file only plugs it into the feature spine and
 * brings its stylesheet.
 */
import '../../styles/bowl.css';

export { installBowl as install } from '../bowl/SwirlBowl.js';
// Before the reveal (75), so the bowl hands the camera back before it snapshots.
export const order = 72;
