/**
 * CoverageMap.js
 * Which parts of a nail have paint, without ever reading the GPU back.
 *
 * - A small grid (32x32 by default) of painted flags in UV space.
 * - An optional nail mask (HandModel.getNailMask()) says which cells have nail
 *   geometry; only those count, so 100% is reachable on every finger shape.
 * - Painting is incremental: each stroke segment visits only the cells under
 *   its capsule's bounding box and bumps a counter. Asking for coverage never
 *   loops over the grid.
 * - No allocation after construction.
 *
 * The legacy API (addCoverage, addLineCoverage, getCoveragePercentage,
 * getCoverageAt, fill, clear, clone, restoreFrom) keeps working for the old
 * 2D PolishTool / PolishLayerState.
 */

// A fully painted nail rarely touches every last edge cell; this much of the
// mask counts as "everything" so the meter reaches 100% for real strokes.
const COMPLETE_FRACTION = 0.96;
// The brush's solid core (the splat is fully opaque to 0.62 r and fades to r).
const CORE = 0.8;

export class CoverageMap {
  /**
   * @param {number} [resolution=32]
   * @param {Uint8Array|null} [mask] resolution^2 cells, 1 = nail geometry
   */
  constructor(resolution = 32, mask = null) {
    this.resolution = resolution;
    this.grid = new Uint8Array(resolution * resolution);
    this.mask = null;
    this.maskCount = resolution * resolution;
    this.painted = 0;
    this.coveredFired = false; // set by the owner once it announced the 0.9 crossing
    this.lastReported = 0;     // last coverage value the owner announced
    if (mask) this.setMask(mask);
  }

  /** Use a nail mask (recounts once; not for per-frame use). */
  setMask(mask) {
    const n = this.resolution * this.resolution;
    this.mask = null;
    this.maskCount = n;
    if (mask && mask.length === n) {
      let c = 0;
      for (let i = 0; i < n; i++) if (mask[i]) c++;
      if (c > 0) {
        this.mask = mask;
        this.maskCount = c;
      }
    }
    let p = 0;
    for (let i = 0; i < n; i++) if (this.grid[i] && (!this.mask || this.mask[i])) p++;
    this.painted = p;
  }

  /** 0..1, eased so a real full coat reads exactly 1. */
  get coverage() {
    const raw = this.painted / (this.maskCount * COMPLETE_FRACTION);
    return raw > 1 ? 1 : raw;
  }

  /**
   * Mark the cells under a stroke capsule from (u0,v0) to (u1,v1).
   * @param {number} radius in aspect-corrected UV units (v units), like the splat
   * @param {number} [aspect=1] nail u/v world aspect (HandModel.getUVAspect)
   * @returns {boolean} whether any new cell was painted
   */
  addSegment(u0, v0, u1, v1, radius, aspect = 1) {
    const N = this.resolution;
    const a = aspect > 1e-3 ? aspect : 1e-3;
    // A cell counts when the brush core reaches within half a cell of its centre.
    const r = radius * CORE + 0.5 / N;
    const r2 = r * r;
    const ru = r / a;
    const x0 = Math.max(0, Math.floor((Math.min(u0, u1) - ru) * N));
    const x1 = Math.min(N - 1, Math.floor((Math.max(u0, u1) + ru) * N));
    const y0 = Math.max(0, Math.floor((Math.min(v0, v1) - r) * N));
    const y1 = Math.min(N - 1, Math.floor((Math.max(v0, v1) + r) * N));
    if (x1 < x0 || y1 < y0) return false;

    // Segment in aspect-corrected space.
    const ax = u0 * a, ay = v0;
    const bx = u1 * a - ax, by = v1 - ay;
    const len2 = bx * bx + by * by;
    const grid = this.grid;
    const mask = this.mask;
    let added = 0;
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) / N - ay;
      const row = y * N;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        if (grid[i]) continue;
        const px = ((x + 0.5) / N) * a - ax;
        let h = len2 > 1e-12 ? (px * bx + py * by) / len2 : 0;
        if (h < 0) h = 0; else if (h > 1) h = 1;
        const dx = px - bx * h, dy = py - by * h;
        if (dx * dx + dy * dy > r2) continue;
        grid[i] = 1;
        if (!mask || mask[i]) added++;
      }
    }
    this.painted += added;
    return added > 0;
  }

  // ------------------------------------------------------------ legacy --

  /** Legacy: paint a disc (opacity is ignored; a cell is painted or not). */
  addCoverage(u, v, radius /* , opacity */) {
    return this.addSegment(u, v, u, v, radius, 1);
  }

  /** Legacy: paint a line. */
  addLineCoverage(u1, v1, u2, v2, radius /* , opacity */) {
    return this.addSegment(u1, v1, u2, v2, radius, 1);
  }

  /** @returns {number} 0..100 */
  getCoveragePercentage() {
    return this.coverage * 100;
  }

  /** @returns {number} 1 painted, 0 not */
  getCoverageAt(u, v) {
    const N = this.resolution;
    const x = Math.floor(u * N);
    const y = Math.floor(v * N);
    if (x < 0 || x >= N || y < 0 || y >= N) return 0;
    return this.grid[y * N + x];
  }

  /** Everything painted (quick fill). */
  fill() {
    this.grid.fill(1);
    this.painted = this.maskCount;
  }

  clear() {
    this.grid.fill(0);
    this.painted = 0;
    this.coveredFired = false;
    this.lastReported = 0;
  }

  clone() {
    const copy = new CoverageMap(this.resolution, null);
    copy.mask = this.mask;
    copy.maskCount = this.maskCount;
    copy.restoreFrom(this);
    return copy;
  }

  restoreFrom(source) {
    if (source.resolution !== this.resolution) {
      throw new Error('Cannot restore from coverage map with different resolution');
    }
    this.grid.set(source.grid);
    this.painted = source.painted;
    this.coveredFired = source.coveredFired;
    this.lastReported = source.lastReported;
  }
}
