/**
 * ClientRequests.js (WP6)
 * Pure data + a seeded generator for what each client asks for.
 * A request = { index, skinTone, fingers: [...], color, finish, sticker? }.
 *
 * Ramp: client 1 = one nail (index), glossy, hot pink; client 2 = three nails;
 * client 3+ = five. Finishes unlock glossy -> shimmer -> chrome -> matte (each
 * new one is shown off by the client that unlocks it). Stickers from client 4.
 * All invented: no names, no people.
 */

export const PALETTE = Object.freeze([
  '#ff2a6d', '#ff9ff3', '#9d4edd', '#00b4d8', '#00f5d4', '#ffd700', '#ffb347', '#2d1f3d',
]);
export const SKINS = Object.freeze(['#f6d3c2', '#eebf9f', '#d9a07a', '#b97b56', '#8c5a3c', '#5e3b26']);
export const FINISHES = Object.freeze(['glossy', 'shimmer', 'chrome', 'matte']);
export const REQUEST_STICKERS = Object.freeze(['star', 'heart', 'flower', 'butterfly', 'bow', 'sparkle']);
// Painting order: start where the intro starts, then across the hand.
const ORDER = Object.freeze(['index', 'middle', 'ring', 'pinky', 'thumb']);

/** mulberry32: tiny seeded PRNG, returns () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Request for client `index` (0-based). */
export function makeRequest(index, rand) {
  const pick = (list) => list[Math.floor(rand() * list.length) % list.length];
  const n = index === 0 ? 1 : index === 1 ? 3 : 5;
  const unlocked = Math.min(FINISHES.length, index + 1);
  const finish = index < FINISHES.length ? FINISHES[index] : FINISHES[Math.floor(rand() * unlocked)];
  return {
    index,
    skinTone: index === 0 ? SKINS[1] : pick(SKINS),
    fingers: ORDER.slice(0, n),
    color: index === 0 ? PALETTE[0] : pick(PALETTE),
    finish,
    sticker: index === 3 || (index > 3 && rand() < 0.5) ? pick(REQUEST_STICKERS) : null,
  };
}
