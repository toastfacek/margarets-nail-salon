/**
 * BrushTool.js
 * Freehand drawing on the nail using the shared canvas texture from NailModel
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

export class BrushTool {
    constructor(scene, camera, nail) {
        this.scene = scene;
        this.camera = camera;
        this.nail = nail;
        this.isActive = false;
        this.isDrawing = false;

        this.color = '#FFFFFF';
        this.size = 5;
        this.dim = 1024; // Canvas dimension (matches NailModel)

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

        this.isDrawing = true;
        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            this.lastDrawPos = { x: uv.x * this.dim, y: uv.y * this.dim };
            this.drawPoint(this.lastDrawPos.x, this.lastDrawPos.y);
            soundManager.init();
        }
    }

    onPointerMove(event) {
        if (!this.isActive || !this.isDrawing) return;
        event.preventDefault?.();

        this.updateMousePosition(event);

        const uv = this.getUVIntersection();
        if (uv) {
            const currentPos = { x: uv.x * this.dim, y: uv.y * this.dim };

            if (this.lastDrawPos) {
                this.drawLine(this.lastDrawPos.x, this.lastDrawPos.y, currentPos.x, currentPos.y);
            } else {
                this.drawPoint(currentPos.x, currentPos.y);
            }

            this.lastDrawPos = currentPos;
        } else {
            this.lastDrawPos = null;
        }
    }

    onPointerUp() {
        this.isDrawing = false;
        this.lastDrawPos = null;
    }

    drawPoint(x, y) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        ctx.beginPath();
        ctx.arc(x, y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        this.nail.updateDrawingTexture();
    }

    drawLine(x1, y1, x2, y2) {
        const ctx = this.nail.getDrawingContext();
        if (!ctx) return;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = this.color;
        ctx.lineWidth = this.size * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        this.nail.updateDrawingTexture();
    }

    setColor(color) {
        this.color = color;
    }

    setSize(size) {
        this.size = size;
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;
        this.isDrawing = false;
    }

    clear() {
        this.nail.clearDrawing();
    }
}
