/**
 * BristlePaintApplicator.js
 * Draws paint continuously as you drag with distance-based throttling
 */

// Paint configuration
const PAINT_CONFIG = {
  strokeWidth: 70,              // Fixed brush width
  baseOpacity: 0.95,            // Solid coverage
  edgeDarkeningAmount: 15,      // Darker edges
  glossIntensity: 0.3,          // Gloss highlight brightness
  glossWidth: 0.15,             // Gloss line width ratio
  minDistance: 15,              // Minimum pixels between paint points
};

export class BristlePaintApplicator {
  constructor(canvasDim = 1024) {
    this.dim = canvasDim;

    // Track last painted position
    this.lastPaintedPos = null;

    // Coverage tracking
    this.paintedCells = new Set();
    this.cellSize = canvasDim / 64;
  }

  /**
   * Reset stroke state (call on mouse up)
   */
  resetStroke() {
    this.lastPaintedPos = null;
  }

  /**
   * Paint continuously while dragging (with distance throttling)
   * Returns 1 if painted, 0 if skipped (too close to last point)
   */
  paint(ctx, contacts, color, opacity = 1) {
    if (!ctx || !contacts || contacts.length === 0) return 0;

    const pos = this.getPositionFromContacts(contacts);

    // First point of stroke - just record, don't draw yet
    if (!this.lastPaintedPos) {
      this.lastPaintedPos = pos;
      return 0;
    }

    // Check distance from last painted point
    const dx = pos.x - this.lastPaintedPos.x;
    const dy = pos.y - this.lastPaintedPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Only paint if moved enough
    if (dist < PAINT_CONFIG.minDistance) {
      return 0;
    }

    // Draw line segment from last position to current
    this.drawSegment(ctx, this.lastPaintedPos, pos, color, opacity);

    // Update last position
    this.lastPaintedPos = pos;
    return 1;
  }

  /**
   * Get brush position from bristle contacts
   */
  getPositionFromContacts(contacts) {
    let totalX = 0, totalY = 0, totalWeight = 0;

    for (const contact of contacts) {
      const weight = contact.pressure || 0.5;
      totalX += contact.uv.x * this.dim * weight;
      totalY += contact.uv.y * this.dim * weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) totalWeight = 1;

    return {
      x: totalX / totalWeight,
      y: totalY / totalWeight,
    };
  }

  /**
   * Draw a line segment between two points
   */
  drawSegment(ctx, from, to, color, opacity) {
    ctx.save();

    const rgba = this.parseColor(color);
    const { r, g, b } = rgba;
    const width = PAINT_CONFIG.strokeWidth;
    const finalOpacity = PAINT_CONFIG.baseOpacity * opacity;

    // Darker edge color
    const darkR = Math.max(0, r - PAINT_CONFIG.edgeDarkeningAmount);
    const darkG = Math.max(0, g - PAINT_CONFIG.edgeDarkeningAmount);
    const darkB = Math.max(0, b - PAINT_CONFIG.edgeDarkeningAmount);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Layer 1: Darker edge
    ctx.lineWidth = width + 4;
    ctx.strokeStyle = `rgba(${darkR}, ${darkG}, ${darkB}, ${finalOpacity * 0.5})`;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Layer 2: Main stroke
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${finalOpacity})`;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    // Layer 3: Gloss highlight
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const glossOffset = width * 0.25;

    ctx.lineWidth = width * PAINT_CONFIG.glossWidth;
    ctx.strokeStyle = `rgba(255, 255, 255, ${finalOpacity * PAINT_CONFIG.glossIntensity})`;
    ctx.beginPath();
    ctx.moveTo(from.x + perpX * glossOffset, from.y + perpY * glossOffset);
    ctx.lineTo(to.x + perpX * glossOffset, to.y + perpY * glossOffset);
    ctx.stroke();

    ctx.restore();

    // Mark painted area
    this.markPaintedArea(from.x, from.y, width / 2);
    this.markPaintedArea(to.x, to.y, width / 2);
  }

  /**
   * Mark area as painted for coverage tracking
   */
  markPaintedArea(cx, cy, radius) {
    const radiusCells = Math.ceil(radius / this.cellSize) + 1;
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const x = cx + dx * this.cellSize;
        const y = cy + dy * this.cellSize;
        const cellX = Math.floor(x / this.cellSize);
        const cellY = Math.floor(y / this.cellSize);
        if (cellX >= 0 && cellX < 64 && cellY >= 0 && cellY < 64) {
          this.paintedCells.add(`${cellX}_${cellY}`);
        }
      }
    }
  }

  /**
   * Parse color string to RGB
   */
  parseColor(color) {
    if (color.startsWith('#')) {
      return {
        r: parseInt(color.slice(1, 3), 16),
        g: parseInt(color.slice(3, 5), 16),
        b: parseInt(color.slice(5, 7), 16),
      };
    }

    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3]),
      };
    }

    return { r: 255, g: 42, b: 109 };
  }

  /**
   * Get coverage percentage
   */
  getCoverage() {
    return this.paintedCells.size / (64 * 64);
  }
}
