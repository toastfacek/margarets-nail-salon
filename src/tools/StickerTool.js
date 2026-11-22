/**
 * StickerTool.js
 * Sticker placement on nail surface using canvas-based drawing
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';
import { EVENTS } from '../core/GameEvents.js';

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
        this._hits = [];

        // Juice hooks (wired by the brushJuice feature)
        this.events = null;
        this.sparkles = null;
        this.invalidate = null;
        this._decoPayload = { type: 'sticker', id: null };

        this.setupEventListeners();
    }

    /** Wire events, sparkles and redraw requests (brushJuice feature). */
    connect({ events = null, sparkles = null, invalidate = null } = {}) {
        this.events = events;
        this.sparkles = sparkles;
        this.invalidate = invalidate;
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

    /** The nail hit under the pointer (with uv), or null. */
    getIntersection() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return null;

        const hits = this._hits;
        hits.length = 0;
        this.raycaster.intersectObject(nailMesh, false, hits);
        const hit = hits.length > 0 && hits[0].uv ? hits[0] : null;
        hits.length = 0;
        return hit;
    }

    getUVIntersection() {
        const hit = this.getIntersection();
        return hit ? hit.uv : null;
    }

    onClick(event) {
        if (!this.isActive || !this.selectedSticker) return;

        this.updateMousePosition(event);

        const hit = this.getIntersection();
        if (hit) {
            this.placeSticker(hit.uv, hit.point);
        }
    }

    onTouchStart(event) {
        if (!this.isActive || !this.selectedSticker) return;

        event.preventDefault();
        this.updateMousePosition(event);

        const hit = this.getIntersection();
        if (hit) {
            this.placeSticker(hit.uv, hit.point);
        }
    }

    /**
     * Draw a sticker into the decoration layer (it lands on top of the polish).
     * @param {THREE.Vector2} uv
     * @param {THREE.Vector3} [point] world hit point for the sparkle pop
     */
    placeSticker(uv, point = null) {
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

        // Pop: sparkles at the hit point, and tell everyone (WP5 plays the sound
        // from deco:placed; the direct call stays until it does).
        if (this.sparkles && point) this.sparkles.burst(point, 14, stickerData.color);
        if (this.events) {
            this._decoPayload.id = stickerData.id;
            this.events.emit(EVENTS.DECO_PLACED, this._decoPayload);
        }
        if (!this.events || this.events.listenerCount(EVENTS.DECO_PLACED) === 0) soundManager.playStickerPop();
        if (this.invalidate) this.invalidate();
    }

    selectSticker(stickerId) {
        this.selectedSticker = stickerId;
        if (stickerId) {
            soundManager.playClick();
        }
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
