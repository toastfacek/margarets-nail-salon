/**
 * BrushTool.js
 * Pen-like drawing tool with different materials and effects
 * Feels like a real art pen with smooth strokes and various finishes
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
        this.lastDrawPos = null;

        this.setupEventListeners();
    }

    setupEventListeners() {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) {
            setTimeout(() => this.setupEventListeners(), 100);
            return;
        }

        // Mouse events
        canvas.addEventListener('mousedown', (e) => this.onPointerDown(e));
        canvas.addEventListener('mousemove', (e) => this.onPointerMove(e));
        canvas.addEventListener('mouseup', () => this.onPointerUp());
        canvas.addEventListener('mouseleave', () => this.onPointerUp());

        // Touch events
        canvas.addEventListener('touchstart', (e) => this.onPointerDown(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this.onPointerMove(e), { passive: false });
        canvas.addEventListener('touchend', () => this.onPointerUp());
    }

    updateMousePosition(event) {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    }

    getUVIntersection() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return null;

        const intersects = this.raycaster.intersectObject(nailMesh, true);
        if (intersects.length > 0 && intersects[0].uv) {
            return intersects[0].uv;
        }
        return null;
    }

    onPointerDown(event) {
        if (!this.isActive) return;
        event.preventDefault?.();

        this.isDrawing = true;
        this.points = []; // Reset points for new stroke
        this.lastTime = performance.now();
        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            const pos = { x: uv.x * this.dim, y: uv.y * this.dim };
            this.points.push(pos);
            this.lastDrawPos = pos;
            this.drawStrokeStart(pos.x, pos.y);
            soundManager.init();
        }
    }

    onPointerMove(event) {
        if (!this.isActive || !this.isDrawing) return;
        event.preventDefault?.();

        this.updateMousePosition(event);

        // Calculate velocity for pressure simulation
        const now = performance.now();
        const deltaTime = now - this.lastTime;
        this.lastTime = now;

        const uv = this.getUVIntersection();
        if (uv) {
            const currentPos = { x: uv.x * this.dim, y: uv.y * this.dim };

            if (this.lastDrawPos) {
                // Calculate velocity-based size variation
                const dx = currentPos.x - this.lastDrawPos.x;
                const dy = currentPos.y - this.lastDrawPos.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                this.velocity = deltaTime > 0 ? distance / deltaTime : 0;

                // Add point for smooth curve
                this.points.push(currentPos);

                // Draw the stroke segment
                this.drawStrokeSegment(this.lastDrawPos, currentPos);
            }

            this.lastDrawPos = currentPos;
        } else {
            // Lifted off nail surface
            this.lastDrawPos = null;
            this.points = [];
        }
    }

    onPointerUp() {
        if (this.isDrawing && this.points.length > 0) {
            // Final stroke completion
            this.finalizeStroke();
        }
        this.isDrawing = false;
        this.lastDrawPos = null;
        this.points = [];
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

        this.nail.updateDrawingTexture();
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

        this.nail.updateDrawingTexture();
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
        this.points = [];
    }

    clear() {
        this.nail.clearDrawing();
    }
}
