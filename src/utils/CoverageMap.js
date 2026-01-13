/**
 * CoverageMap.js
 * Tracks painted coverage on a nail surface using a low-resolution grid.
 * Used to calculate coverage percentage and determine when a coat is complete.
 */

export class CoverageMap {
  constructor(resolution = 64) {
    this.resolution = resolution;
    this.grid = new Float32Array(resolution * resolution);
    this.maxOpacity = 0.95; // Cap for realistic polish look
  }

  /**
   * Add coverage at a UV position with given radius and opacity
   * @param {number} u - UV x coordinate (0-1)
   * @param {number} v - UV y coordinate (0-1)
   * @param {number} radius - Brush radius in UV space (0-1)
   * @param {number} opacity - Opacity to add (0-1)
   */
  addCoverage(u, v, radius, opacity) {
    const gridX = Math.floor(u * this.resolution);
    const gridY = Math.floor(v * this.resolution);
    const gridRadius = Math.ceil(radius * this.resolution);

    // Paint a circular area in the grid
    for (let dy = -gridRadius; dy <= gridRadius; dy++) {
      for (let dx = -gridRadius; dx <= gridRadius; dx++) {
        const gx = gridX + dx;
        const gy = gridY + dy;

        // Bounds check
        if (gx < 0 || gx >= this.resolution || gy < 0 || gy >= this.resolution) {
          continue;
        }

        // Distance from center
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > gridRadius) continue;

        // Falloff based on distance from center
        const falloff = 1 - (dist / gridRadius);
        const addedOpacity = opacity * falloff;

        const idx = gy * this.resolution + gx;
        // Additive blending with cap
        this.grid[idx] = Math.min(this.maxOpacity, this.grid[idx] + addedOpacity);
      }
    }
  }

  /**
   * Add coverage along a line (for stroke interpolation)
   * @param {number} u1 - Start UV x
   * @param {number} v1 - Start UV y
   * @param {number} u2 - End UV x
   * @param {number} v2 - End UV y
   * @param {number} radius - Brush radius in UV space
   * @param {number} opacity - Opacity to add
   */
  addLineCoverage(u1, v1, u2, v2, radius, opacity) {
    const dist = Math.sqrt((u2 - u1) ** 2 + (v2 - v1) ** 2);
    const steps = Math.max(1, Math.ceil(dist * this.resolution));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = u1 + (u2 - u1) * t;
      const v = v1 + (v2 - v1) * t;
      this.addCoverage(u, v, radius, opacity * 0.5); // Reduce per-step to avoid oversaturation
    }
  }

  /**
   * Calculate total coverage percentage
   * @returns {number} Coverage percentage (0-100)
   */
  getCoveragePercentage() {
    let totalCoverage = 0;
    const totalCells = this.resolution * this.resolution;

    for (let i = 0; i < totalCells; i++) {
      totalCoverage += this.grid[i];
    }

    // Normalize by max possible coverage
    return (totalCoverage / (totalCells * this.maxOpacity)) * 100;
  }

  /**
   * Get coverage at a specific UV position
   * @param {number} u - UV x coordinate (0-1)
   * @param {number} v - UV y coordinate (0-1)
   * @returns {number} Coverage opacity at that position (0-1)
   */
  getCoverageAt(u, v) {
    const gridX = Math.floor(u * this.resolution);
    const gridY = Math.floor(v * this.resolution);

    if (gridX < 0 || gridX >= this.resolution || gridY < 0 || gridY >= this.resolution) {
      return 0;
    }

    return this.grid[gridY * this.resolution + gridX];
  }

  /**
   * Fill entire coverage map (for quick fill feature)
   * @param {number} opacity - Target opacity (0-1)
   */
  fill(opacity = 0.9) {
    this.grid.fill(Math.min(this.maxOpacity, opacity));
  }

  /**
   * Clear all coverage
   */
  clear() {
    this.grid.fill(0);
  }

  /**
   * Create a copy of this coverage map
   * @returns {CoverageMap}
   */
  clone() {
    const copy = new CoverageMap(this.resolution);
    copy.grid.set(this.grid);
    return copy;
  }

  /**
   * Restore from another coverage map
   * @param {CoverageMap} source
   */
  restoreFrom(source) {
    if (source.resolution !== this.resolution) {
      throw new Error('Cannot restore from coverage map with different resolution');
    }
    this.grid.set(source.grid);
  }
}
