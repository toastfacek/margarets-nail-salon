/**
 * notes.js
 * Every pitched sound in the game is taken from C major pentatonic
 * (C D E G A), so any two sounds that overlap are always in key.
 */

const PENTA_STEPS = [0, 2, 4, 7, 9];

/** MIDI note number to Hz. */
export function mtof(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * The i-th note of C major pentatonic counted up from `baseMidi`
 * (72 = C5). Negative indexes go down.
 */
export function penta(i, baseMidi = 72) {
  const oct = Math.floor(i / 5);
  const deg = i - oct * 5;
  return mtof(baseMidi + oct * 12 + PENTA_STEPS[deg]);
}

// Handy fixed pitches (Hz)
export const C4 = mtof(60);
export const G4 = mtof(67);
export const A4 = mtof(69);
export const C5 = mtof(72);
export const D5 = mtof(74);
export const E5 = mtof(76);
export const G5 = mtof(79);
export const A5 = mtof(81);
export const C6 = mtof(84);
export const D6 = mtof(86);
export const E6 = mtof(88);
export const G6 = mtof(91);
export const A6 = mtof(93);
export const C7 = mtof(96);
