/**
 * PolishBrush3D module
 * The 3D nail polish brush: input samples -> stroke engine -> polish film on
 * the nail, with the brush rig posed on the same point. FluidSimulator stays
 * exported for the swirl bowl (the brush no longer uses it).
 */
export { PolishBrush3D, COAT_ALPHA } from './PolishBrush3D.js';
export { BristleSystem } from './BristleSystem.js';
export { BrushInputHandler, TOUCH_NUDGE_PX, touchLiftPx, TOUCH_LIFT } from './BrushInputHandler.js';
export { BrushEffects } from './BrushEffects.js';
export { PolishFilm } from './PolishFilm.js';
export { FluidSimulator } from './FluidSimulator.js';
export { WetCure, WET } from './WetCure.js';
