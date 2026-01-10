/**
 * GlitterTool.js
 * Glitter spray effect drawn on the shared canvas texture
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

// Glitter color options
export const GLITTER_COLORS = [
    { id: 'gold', name: 'Gold', color: '#FFD700' },
    { id: 'silver', name: 'Silver', color: '#C0C0C0' },
    { id: 'pink', name: 'Pink', color: '#FF69B4' },
    { id: 'teal', name: 'Teal', color: '#00CED1' },
    { id: 'purple', name: 'Purple', color: '#BA55D3' },
    { id: 'red', name: 'Red', color: '#FF6B6B' },
    { id: 'rainbow', name: 'Rainbow', color: null }, // Special multi-color
];

export class GlitterTool {
    constructor(scene, camera, nail) {
        this.scene = scene;
        this.camera = camera;
        this.nail = nail;
        this.isActive = false;
        this.isSpraying = false;

        this.selectedColor = GLITTER_COLORS[0];
        this.dim = 1024; // Canvas dimension (matches NailModel)
        this.sprayRadius = 30; // Radius of glitter spray in canvas pixels

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.setupEventListeners();
    }

    setupEventListeners() {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) {
            setTimeout(() => this.setupEventListeners(), 100);
            return;
        }

        canvas.addEventListener('mousedown', (e) => this.onPointerDown(e));
        canvas.addEventListener('mousemove', (e) => this.onPointerMove(e));
        canvas.addEventListener('mouseup', () => this.onPointerUp());
        canvas.addEventListener('mouseleave', () => this.onPointerUp());

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

        soundManager.init();
        this.isSpraying = true;
        this.updateMousePosition(event);

        // Spray on first click
        const uv = this.getUVIntersection();
        if (uv) {
            this.sprayGlitter(uv);
        }
    }

    onPointerMove(event) {
        if (!this.isActive || !this.isSpraying) return;
        event.preventDefault?.();

        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            this.sprayGlitter(uv);
        }
    }

    onPointerUp() {
        this.isSpraying = false;
    }

    sprayGlitter(uv) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        // Base position in canvas coordinates
        const baseX = uv.x * this.dim;
        const baseY = uv.y * this.dim;

        // Spray multiple glitter particles
        const numToSpray = 8 + Math.floor(Math.random() * 8);

        for (let i = 0; i < numToSpray; i++) {
            // Random position within spray radius
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * this.sprayRadius;
            const x = baseX + Math.cos(angle) * dist;
            const y = baseY + Math.sin(angle) * dist;

            // Random size for sparkle variation
            const size = 1 + Math.random() * 3;

            // Determine color
            let color;
            if (this.selectedColor.id === 'rainbow') {
                // Random rainbow color
                const hue = Math.random() * 360;
                color = `hsl(${hue}, 100%, 60%)`;
            } else {
                color = this.selectedColor.color;
            }

            // Draw glitter dot
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }

        this.nail.updateDrawingTexture();

        // Play sparkle sound occasionally
        if (Math.random() < 0.15) {
            soundManager.playSparkle();
        }
    }

    selectColor(colorId) {
        const color = GLITTER_COLORS.find(c => c.id === colorId);
        if (color) {
            this.selectedColor = color;
            soundManager.playClick();
        }
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;
        this.isSpraying = false;
    }

    clearAll() {
        // Clearing is now handled by NailModel.clearDrawing()
        // This method is kept for API compatibility
    }
}
