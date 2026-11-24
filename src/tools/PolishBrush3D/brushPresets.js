/**
 * brushPresets.js
 * Real nail polish brush shapes (docs: brush-shape-research.md, patent
 * US20060123576A1 worked examples, US4454622 concentric-ring dome). Every
 * size is a fraction of the active nail's width (an index nail is ~12.5 mm).
 *
 *   length            free bristle length (root at the stem -> centre tip)
 *   rootW, rootT      bundle width x thickness where it leaves the stem
 *   bellyW, bellyT    the widest part of the bundle (at `belly` along it)
 *   tipStart          where the tip region starts (only this part bends/splays)
 *   tipEndW, tipT     width / thickness the taper reaches at the very end
 *                     (thickness -> a near edge: a wedge seen from the side)
 *   tipW              unpressed tip width (the band is sized from it)
 *   dome, domeExp     tip trim: centre bristles longest. dome = trim depth in
 *                     tip half-widths, domeExp 2 = round dome, 4+ = rounded square
 *   stemD             round stem the bristles sit in
 *   bandMin/bandPress paint band / nail width at the lightest touch, plus this
 *                     at full pressure. The pressed footprint the rig renders
 *                     spans exactly this band (0.62x .. 1.6x tipW).
 *
 * Pick one with PolishBrush3D.setBrushType(name) (a bottle can do that later:
 * it is the one place). For testing: ?brush=prowide.
 */
export const BRUSH_PRESETS = Object.freeze({
  // Essie / OPI standard: narrow, round, a thick rounded bundle that fans.
  classic: Object.freeze({
    name: 'classic',
    length: 0.9,
    rootW: 0.24, rootT: 0.12,
    bellyW: 0.27, bellyT: 0.145, belly: 0.4,
    tipStart: 0.58,
    tipEndW: 0.19, tipT: 0.012,
    tipW: 0.2,
    dome: 1.0, domeExp: 2,
    stemD: 0.24,
    // B9: x1.07 for the B9 nail, whose UV now spans exactly the visible plate
    // (the old UV ran past it), so the pressed band is ~34% on screen again.
    bandMin: 0.133, bandPress: 0.212,   // 0.133 .. 0.345 (pressed ~34% on screen)
  }),
  // OPI ProWide / Sally Hansen wide: flat-ish, ~1.4x wider pressed,
  // rounded-square tip, still a third of its width thick at the root.
  prowide: Object.freeze({
    name: 'prowide',
    length: 0.88,
    rootW: 0.36, rootT: 0.14,
    bellyW: 0.38, bellyT: 0.155, belly: 0.38,
    tipStart: 0.56,
    tipEndW: 0.3, tipT: 0.016,
    tipW: 0.28,
    dome: 0.55, domeExp: 4,
    stemD: 0.28,
    bandMin: 0.186, bandPress: 0.296,   // 0.186 .. 0.482 (1.4x classic)
  }),
});

export const DEFAULT_BRUSH = 'classic';

export function brushPreset(name) {
  return BRUSH_PRESETS[name] || BRUSH_PRESETS[DEFAULT_BRUSH];
}

/** The brush to start with: ?brush=<name> (testing), else the default. */
export function initialBrushType() {
  try {
    const m = /[?&]brush=([a-z]+)/.exec(window.location.search);
    if (m && BRUSH_PRESETS[m[1]]) return m[1];
  } catch (e) { /* no window */ }
  return DEFAULT_BRUSH;
}
