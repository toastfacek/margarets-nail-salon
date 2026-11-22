/**
 * BrushTool.js
 * Pen-like drawing tool with different materials and effects
 * Feels like a real art pen with smooth strokes and various finishes
 *
 * Pointer events only (mouse, pen and touch). Strokes draw into the active
 * nail's decoration canvas; the texture upload is deferred to `flush()`, which
 * the brushJuice feature calls once per frame from the loop, so a fast stroke
 * uploads the canvas at most once per frame. Nothing is emitted per move.
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

// Available pen materials with their rendering properties
export const PEN_MATERIALS = {
    SOLID: {
        id: 'solid',
        name: 'Solid',
        icon: '✏️',
        description: 'Clean solid lines'
    },
    DOTTED: {
        id: 'dotted',
        name: 'Dotted',
        icon: '🔴',
        description: 'Fun polka dots'
    },
    METALLIC: {
        id: 'metallic',
        name: 'Metallic',
        icon: '🪙',
        description: 'Shiny metallic finish'
    },
    RAINBOW: {
        id: 'rainbow',
        name: 'Rainbow',
        icon: '🌈',
        description: 'Color-shifting rainbow'
    },
    GLITTER: {
        id: 'glitter',
        name: 'Glitter',
        icon: '✨',
        description: 'Sparkly glitter spray'
    },
    MARKER: {
        id: 'marker',
        name: 'Marker',
        icon: '🖊️',
        description: 'Semi-transparent marker'
    }
};

// Curated color palette for nail art
export const PEN_COLORS = [
    // Whites & Blacks
    { id: 'white', color: '#FFFFFF', name: 'White' },
    { id: 'black', color: '#1a1a2e', name: 'Black' },

    // Hot Pinks & Reds
    { id: 'hotpink', color: '#FF1493', name: 'Hot Pink' },
    { id: 'bubblegum', color: '#FF69B4', name: 'Bubblegum' },
    { id: 'coral', color: '#FF6B6B', name: 'Coral' },
    { id: 'red', color: '#FF2A2A', name: 'Red' },

    // Purples
    { id: 'purple', color: '#9B30FF', name: 'Purple' },
    { id: 'lavender', color: '#C77DFF', name: 'Lavender' },

    // Blues
    { id: 'cyan', color: '#00FFFF', name: 'Cyan' },
    { id: 'sky', color: '#00B4D8', name: 'Sky Blue' },

    // Greens & Teals
    { id: 'mint', color: '#00F5D4', name: 'Mint' },
    { id: 'lime', color: '#ADFF2F', name: 'Lime' },

    // Warm Colors
    { id: 'gold', color: '#FFD700', name: 'Gold' },
    { id: 'orange', color: '#FF6B35', name: 'Orange' },
    { id: 'peach', color: '#FFAB91', name: 'Peach' },

    // Neutrals
    { id: 'silver', color: '#C0C0C0', name: 'Silver' },
];

export class BrushTool {
    constructor(scene, camera, nail) {
        this.scene = scene;
        this.camera = camera;
        this.nail = nail;
        this.isActive = false;
        this.isDrawing = false;

        // Pen properties
        this.color = '#FFFFFF';
        this.size = 6;
        this.minSize = 1;
        this.maxSize = 30;
        this.material = PEN_MATERIALS.SOLID.id;
        this.dim = 1024; // Canvas dimension

        // Smoothing for pen-like feel
        this.points = []; // Store points for smooth curves
        this.smoothing = 0.3; // Bezier curve smoothing factor
        this.lastTime = 0;
        this.velocity = 0;

        // Rainbow state
        this.rainbowHue = 0;

        // Glitter particles cache
        this.glitterCache = [];

        // Sound throttling - don't play sounds too frequently
        this.lastSoundTime = 0;
        this.soundInterval = 80; // ms between sounds

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this._hits = [];
        this._rect = null;
        // Reused stroke points (no allocation per move)
        this._from = { x: 0, y: 0 };
        this._to = { x: 0, y: 0 };
        this._hasLast = false;
        this.lastDrawPos = null;
        this._pointCount = 0;

        // Deferred texture upload (see flush()); off until a loop calls flush.
        this._deferUpload = false;
        this._dirty = false;
        this.invalidate = null;

        this.setupEventListeners();
    }

    /**
     * Defer texture uploads to flush() (called once per frame by the loop).
     * @param {{ invalidate?: () => void }} [opts]
     */
    connect({ invalidate = null } = {}) {
        this.invalidate = invalidate;
        this._deferUpload = true;
    }

    /** Upload the decoration canvas if a stroke drew into it. At most once per frame. */
    flush() {
        if (!this._dirty) return false;
        this._dirty = false;
        this.nail.updateDrawingTexture();
        return true;
    }

    _markDirty() {
        if (!this._deferUpload) {
            this.nail.updateDrawingTexture();
            return;
        }
        this._dirty = true;
        if (this.invalidate) this.invalidate();
    }

    setupEventListeners() {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) {
            setTimeout(() => this.setupEventListeners(), 100);
            return;
        }
        this._canvas = canvas;

        // Pointer events cover mouse, pen and touch.
        canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
        canvas.addEventListener('pointerup', () => this.onPointerUp());
        canvas.addEventListener('pointerleave', () => this.onPointerUp());
        canvas.addEventListener('pointercancel', () => this.onPointerUp());
    }

    updateMousePosition(event) {
        const canvas = this._canvas;
        if (!canvas) return;
        // getBoundingClientRect allocates: read it on pointerdown only.
        if (!this._rect || event.type === 'pointerdown') this._rect = canvas.getBoundingClientRect();
        const rect = this._rect;
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    getUVIntersection() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return null;

        const hits = this._hits;
        hits.length = 0;
        this.raycaster.intersectObject(nailMesh, false, hits);
        const uv = hits.length > 0 && hits[0].uv ? hits[0].uv : null;
        hits.length = 0;
        return uv;
    }

    onPointerDown(event) {
        if (!this.isActive) return;
        if (event.button !== undefined && event.button > 0) return;
        if (event.cancelable) event.preventDefault();

        this.isDrawing = true;
        this._pointCount = 0;
        this.lastTime = event.timeStamp || performance.now();
        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            this._from.x = uv.x * this.dim;
            this._from.y = uv.y * this.dim;
            this._hasLast = true;
            this.lastDrawPos = this._from;
            this._pointCount = 1;
            this.drawStrokeStart(this._from.x, this._from.y);
            soundManager.init();
        }
    }

    onPointerMove(event) {
        if (!this.isActive || !this.isDrawing) return;

        this.updateMousePosition(event);

        // Calculate velocity for pressure simulation
        const now = event.timeStamp || performance.now();
        const deltaTime = now - this.lastTime;
        this.lastTime = now;

        const uv = this.getUVIntersection();
        if (uv) {
            const to = this._to;
            to.x = uv.x * this.dim;
            to.y = uv.y * this.dim;

            if (this._hasLast) {
                // Calculate velocity-based size variation
                const dx = to.x - this._from.x;
                const dy = to.y - this._from.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                this.velocity = deltaTime > 0 ? distance / deltaTime : 0;
                this._pointCount++;

                // Draw the stroke segment
                this.drawStrokeSegment(this._from, to);
            }

            this._from.x = to.x;
            this._from.y = to.y;
            this._hasLast = true;
            this.lastDrawPos = this._from;
        } else {
            // Lifted off nail surface
            this._hasLast = false;
            this.lastDrawPos = null;
            this._pointCount = 0;
        }
    }

    onPointerUp() {
        if (this.isDrawing && this._pointCount > 0) {
            // Final stroke completion
            this.finalizeStroke();
        }
        this.isDrawing = false;
        this._hasLast = false;
        this.lastDrawPos = null;
        this._pointCount = 0;
        this.velocity = 0;
    }

    /**
     * Get dynamic brush size based on velocity (pen pressure simulation)
     */
    getDynamicSize() {
        // Slower strokes = thicker lines (like pressing harder)
        // Faster strokes = thinner lines
        const velocityFactor = Math.min(this.velocity * 0.5, 1);
        const sizeVariation = this.size * 0.3; // 30% variation
        return this.size - (velocityFactor * sizeVariation);
    }

    /**
     * Draw the start of a stroke (initial dot)
     */
    drawStrokeStart(x, y) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        const size = this.size;

        switch (this.material) {
            case 'dotted':
                this.drawDottedPoint(ctx, x, y, size);
                break;
            case 'metallic':
                this.drawMetallicPoint(ctx, x, y, size);
                break;
            case 'rainbow':
                this.drawRainbowPoint(ctx, x, y, size);
                break;
            case 'glitter':
                this.drawGlitterPoint(ctx, x, y, size);
                break;
            case 'marker':
                this.drawMarkerPoint(ctx, x, y, size);
                break;
            default:
                this.drawSolidPoint(ctx, x, y, size);
        }

        this._markDirty();
    }

    /**
     * Draw a stroke segment between two points
     */
    drawStrokeSegment(from, to) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        const size = this.getDynamicSize();

        switch (this.material) {
            case 'dotted':
                this.drawDottedLine(ctx, from.x, from.y, to.x, to.y, size);
                break;
            case 'metallic':
                this.drawMetallicLine(ctx, from.x, from.y, to.x, to.y, size);
                break;
            case 'rainbow':
                this.drawRainbowLine(ctx, from.x, from.y, to.x, to.y, size);
                break;
            case 'glitter':
                this.drawGlitterLine(ctx, from.x, from.y, to.x, to.y, size);
                break;
            case 'marker':
                this.drawMarkerLine(ctx, from.x, from.y, to.x, to.y, size);
                break;
            default:
                this.drawSolidLine(ctx, from.x, from.y, to.x, to.y, size);
        }

        // Play material-specific sound (throttled)
        this.playDrawSound();

        this._markDirty();
    }

    /**
     * Play the appropriate sound for the current material (throttled)
     */
    playDrawSound() {
        const now = performance.now();
        if (now - this.lastSoundTime < this.soundInterval) return;
        this.lastSoundTime = now;

        switch (this.material) {
            case 'dotted':
                soundManager.playDrawDotted();
                break;
            case 'metallic':
                soundManager.playDrawMetallic();
                break;
            case 'rainbow':
                soundManager.playDrawRainbow();
                break;
            case 'glitter':
                soundManager.playSparkle();
                break;
            case 'marker':
                soundManager.playDrawMarker();
                break;
            default:
                soundManager.playDrawSolid();
        }
    }

    /**
     * Finalize the stroke (add any finishing effects)
     */
    finalizeStroke() {
        // Could add stroke-end effects here if needed
    }

    // =========================================
    // SOLID PEN
    // =========================================
    drawSolidPoint(ctx, x, y, size) {
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
    }

    drawSolidLine(ctx, x1, y1, x2, y2, size) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = this.color;
        ctx.lineWidth = size * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
    }

    // =========================================
    // DOTTED PEN (Polka dots)
    // =========================================
    drawDottedPoint(ctx, x, y, size) {
        // Draw a nice polka dot
        this.drawPolkaDot(ctx, x, y, size);
    }

    drawDottedLine(ctx, x1, y1, x2, y2, size) {
        // Calculate distance and spacing
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.sqrt(dx * dx + dy * dy);

        // Space dots based on size (larger dots = more spacing)
        const spacing = size * 2.5;
        const dotCount = Math.max(1, Math.floor(distance / spacing));

        // Draw dots along the line
        for (let i = 0; i <= dotCount; i++) {
            const t = dotCount > 0 ? i / dotCount : 0;
            const px = x1 + dx * t;
            const py = y1 + dy * t;
            this.drawPolkaDot(ctx, px, py, size);
        }
    }

    drawPolkaDot(ctx, x, y, size) {
        // Main dot with gradient for 3D effect
        const gradient = ctx.createRadialGradient(
            x - size * 0.3, y - size * 0.3, 0,
            x, y, size
        );

        const lightColor = this.lightenColor(this.color, 30);

        gradient.addColorStop(0, lightColor);
        gradient.addColorStop(0.7, this.color);
        gradient.addColorStop(1, this.darkenColor(this.color, 20));

        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Highlight shine
        ctx.beginPath();
        ctx.arc(x - size * 0.3, y - size * 0.3, size * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fill();
    }

    // =========================================
    // METALLIC PEN
    // =========================================
    drawMetallicPoint(ctx, x, y, size) {
        // Create metallic gradient
        const gradient = ctx.createRadialGradient(
            x - size * 0.3, y - size * 0.3, 0,
            x, y, size
        );

        const baseColor = this.color;
        const lightColor = this.lightenColor(baseColor, 60);
        const darkColor = this.darkenColor(baseColor, 30);

        gradient.addColorStop(0, lightColor);
        gradient.addColorStop(0.5, baseColor);
        gradient.addColorStop(1, darkColor);

        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Add highlight
        ctx.beginPath();
        ctx.arc(x - size * 0.3, y - size * 0.3, size * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fill();
    }

    drawMetallicLine(ctx, x1, y1, x2, y2, size) {
        // Base stroke
        const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        const lightColor = this.lightenColor(this.color, 40);
        const darkColor = this.darkenColor(this.color, 20);

        gradient.addColorStop(0, lightColor);
        gradient.addColorStop(0.5, this.color);
        gradient.addColorStop(1, darkColor);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = size * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Add edge highlight
        ctx.beginPath();
        ctx.moveTo(x1, y1 - size * 0.5);
        ctx.lineTo(x2, y2 - size * 0.5);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = size * 0.5;
        ctx.stroke();
    }

    // =========================================
    // RAINBOW PEN
    // =========================================
    drawRainbowPoint(ctx, x, y, size) {
        const color = this.getCurrentRainbowColor();
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        this.advanceRainbow();
    }

    drawRainbowLine(ctx, x1, y1, x2, y2, size) {
        const color = this.getCurrentRainbowColor();

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = color;
        ctx.lineWidth = size * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        this.advanceRainbow();
    }

    getCurrentRainbowColor() {
        return `hsl(${this.rainbowHue}, 100%, 50%)`;
    }

    advanceRainbow() {
        this.rainbowHue = (this.rainbowHue + 3) % 360;
    }

    // =========================================
    // GLITTER PEN (Sparkly glitter spray)
    // =========================================
    drawGlitterPoint(ctx, x, y, size) {
        // Spray glitter particles at click point
        this.sprayGlitterParticles(ctx, x, y, size * 3);
    }

    drawGlitterLine(ctx, x1, y1, x2, y2, size) {
        // Spray glitter particles along the line
        this.sprayGlitterParticles(ctx, x2, y2, size * 3);
    }

    sprayGlitterParticles(ctx, baseX, baseY, radius) {
        // Spray multiple glitter particles
        const numToSpray = 6 + Math.floor(Math.random() * 6);

        for (let i = 0; i < numToSpray; i++) {
            // Random position within spray radius
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * radius;
            const x = baseX + Math.cos(angle) * dist;
            const y = baseY + Math.sin(angle) * dist;

            // Random size for sparkle variation
            const particleSize = 1 + Math.random() * 3;

            // Draw glitter dot with the selected color
            ctx.beginPath();
            ctx.arc(x, y, particleSize, 0, Math.PI * 2);
            ctx.fillStyle = this.color;
            ctx.fill();
        }
    }

    // =========================================
    // MARKER PEN (Semi-transparent)
    // =========================================
    drawMarkerPoint(ctx, x, y, size) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    drawMarkerLine(ctx, x1, y1, x2, y2, size) {
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = this.color;
        ctx.lineWidth = size * 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    // =========================================
    // Color Utility Functions
    // =========================================
    lightenColor(hex, percent) {
        const num = parseInt(hex.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
    }

    darkenColor(hex, percent) {
        const num = parseInt(hex.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.max(0, (num >> 16) - amt);
        const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
        const B = Math.max(0, (num & 0x0000FF) - amt);
        return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
    }

    hexToRgba(hex, alpha) {
        const num = parseInt(hex.replace('#', ''), 16);
        const R = num >> 16;
        const G = (num >> 8) & 0x00FF;
        const B = num & 0x0000FF;
        return `rgba(${R}, ${G}, ${B}, ${alpha})`;
    }

    // =========================================
    // Public API
    // =========================================
    setColor(color) {
        this.color = color;
    }

    setSize(size) {
        this.size = Math.max(this.minSize, Math.min(this.maxSize, size));
    }

    setMaterial(materialId) {
        if (Object.values(PEN_MATERIALS).find(m => m.id === materialId)) {
            this.material = materialId;
            // Reset rainbow hue when switching to rainbow
            if (materialId === 'rainbow') {
                this.rainbowHue = 0;
            }
        }
    }

    getMaterial() {
        return this.material;
    }

    getColor() {
        return this.color;
    }

    getSize() {
        return this.size;
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;
        this.isDrawing = false;
        this._hasLast = false;
        this._pointCount = 0;
        this.flush();
    }

    clear() {
        this.nail.clearDrawing();
    }
}
