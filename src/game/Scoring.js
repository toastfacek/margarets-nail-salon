/**
 * Scoring.js (WP6): never fail.
 *   stars = 1 + (avg >= 0.6) + (avg >= 0.85 && colorMatch), always 1..3.
 * colorMatch is generous: the colour used most on the requested nails is
 * within 40 degrees of hue of the request (or both are near-grey).
 * No timer anywhere; a sticker request only ever adds a bonus.
 */

/** [hue degrees, saturation 0..1] of '#rrggbb'. */
export function hueSat(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16 & 255) / 255, g = (v >> 8 & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max > 0 ? d / max : 0];
}

export function colorsMatch(a, b) {
  if (!a || !b) return false;
  const [ha, sa] = hueSat(a);
  const [hb, sb] = hueSat(b);
  if (sa < 0.2 || sb < 0.2) return sa < 0.2 && sb < 0.2;
  const dh = Math.abs(ha - hb) % 360;
  return Math.min(dh, 360 - dh) <= 40;
}

/**
 * @param {number[]} coverages 0..1 per requested nail
 * @param {string|null} mainColor the colour painted most on those nails
 * @param {string} wanted the requested colour
 */
export function score(coverages, mainColor, wanted) {
  let sum = 0;
  for (let i = 0; i < coverages.length; i++) sum += coverages[i];
  const avg = coverages.length ? sum / coverages.length : 0;
  const match = colorsMatch(mainColor, wanted);
  const stars = 1 + (avg >= 0.6 ? 1 : 0) + (avg >= 0.85 && match ? 1 : 0);
  return { stars, avg, match };
}
