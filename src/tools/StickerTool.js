/**
 * StickerTool.js
 * Sticker placement on nail surface using canvas-based drawing
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

// Available sticker designs
export const STICKERS = [
    { id: 'star', emoji: '⭐', color: '#FFD700' },
    { id: 'heart', emoji: '❤️', color: '#FF6B6B' },
    { id: 'flower', emoji: '🌸', color: '#FFB6C1' },
    { id: 'butterfly', emoji: '🦋', color: '#87CEEB' },
    { id: 'rainbow', emoji: '🌈', color: '#FF69B4' },
    { id: 'bow', emoji: '🎀', color: '#FF69B4' },
    { id: 'diamond', emoji: '💎', color: '#00CED1' },
    { id: 'sparkle', emoji: '🌟', color: '#FFD700' },
    { id: 'hibiscus', emoji: '🌺', color: '#FF6B6B' },
    { id: 'hearts', emoji: '💕', color: '#FFB6C1' },
    { id: 'sparkles', emoji: '✨', color: '#FFD700' },
    { id: 'clover', emoji: '🍀', color: '#98FF98' },
];

export class StickerTool {
    constructor(scene, camera, nail) {
        this.scene = scene;
        this.camera = camera;
        this.nail = nail;
        this.isActive = false;

        this.selectedSticker = null;
        this.stickerSize = 64; // Size of sticker in canvas pixels
        this.dim = 1024; // Canvas dimension (matches NailModel)

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

        canvas.addEventListener('click', (e) => this.onClick(e));
        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
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

    onClick(event) {
        if (!this.isActive || !this.selectedSticker) return;

        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            this.placeSticker(uv);
        }
    }

    onTouchStart(event) {
        if (!this.isActive || !this.selectedSticker) return;

        event.preventDefault();
        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            this.placeSticker(uv);
        }
    }

    placeSticker(uv) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        // Find sticker data
        const stickerData = STICKERS.find(s => s.id === this.selectedSticker) || STICKERS[0];

        // Convert UV to canvas coordinates
        const x = uv.x * this.dim;
        const y = uv.y * this.dim;

        // Draw sticker emoji on canvas
        ctx.font = `${this.stickerSize}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(stickerData.emoji, x, y);

        this.nail.updateDrawingTexture();

        // Play pop sound
        soundManager.playStickerPop();

        console.log(`Placed sticker: ${this.selectedSticker} at UV(${uv.x.toFixed(2)}, ${uv.y.toFixed(2)})`);
    }

    selectSticker(stickerId) {
        this.selectedSticker = stickerId;
        soundManager.playClick();
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;
    }

    clearAll() {
        // Clearing is now handled by NailModel.clearDrawing()
        // This method is kept for API compatibility
    }
}
