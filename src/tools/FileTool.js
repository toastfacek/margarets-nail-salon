/**
 * FileTool.js
 * Satisfying filing mechanic with particle effects and sound
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

export class FileTool {
    constructor(scene, nail) {
        this.scene = scene;
        this.nail = nail;
        this.isActive = false;
        this.isFiling = false;

        // Filing progress (0-1)
        this.progress = 0;
        this.targetShape = null;

        // Particle system for filing dust
        this.particles = null;
        this.particlePositions = [];
        this.particleVelocities = [];
        this.particleLifetimes = [];
        this.maxParticles = 100;

        // Track mouse/touch for velocity calculation
        this.lastPosition = null;
        this.velocity = 0;

        this.setupParticles();
        this.setupEventListeners();
    }

    setupParticles() {
        // Create particle geometry
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(this.maxParticles * 3);
        const colors = new Float32Array(this.maxParticles * 3);
        const sizes = new Float32Array(this.maxParticles);

        // Initialize all particles offscreen
        for (let i = 0; i < this.maxParticles; i++) {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = -100; // Hidden below
            positions[i * 3 + 2] = 0;

            // Nail dust color (pinkish)
            colors[i * 3] = 1.0;     // R
            colors[i * 3 + 1] = 0.85; // G
            colors[i * 3 + 2] = 0.9;  // B

            sizes[i] = 0.02 + Math.random() * 0.02;

            this.particlePositions.push(new THREE.Vector3(0, -100, 0));
            this.particleVelocities.push(new THREE.Vector3());
            this.particleLifetimes.push(0);
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        // Particle material
        const material = new THREE.PointsMaterial({
            size: 0.03,
            vertexColors: true,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        this.particles = new THREE.Points(geometry, material);
        this.scene.add(this.particles);
    }

    setupEventListeners() {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) {
            // Try again after a short delay if canvas not ready
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
        canvas.addEventListener('touchcancel', () => this.onPointerUp());
    }

    getPointerPosition(event) {
        if (event.touches && event.touches.length > 0) {
            return { x: event.touches[0].clientX, y: event.touches[0].clientY };
        }
        return { x: event.clientX, y: event.clientY };
    }

    onPointerDown(event) {
        if (!this.isActive) return;

        const pos = this.getPointerPosition(event);
        this.lastPosition = pos;
        this.isFiling = true;

        // Initialize sound manager on first interaction
        soundManager.init();
    }

    onPointerMove(event) {
        if (!this.isActive || !this.isFiling) return;

        event.preventDefault();

        const pos = this.getPointerPosition(event);

        if (this.lastPosition) {
            // Calculate movement velocity
            const dx = pos.x - this.lastPosition.x;
            const dy = pos.y - this.lastPosition.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            this.velocity = Math.min(distance / 10, 1); // Normalize to 0-1

            if (this.velocity > 0.1) {
                // We're filing!
                this.onFile(this.velocity);
            }
        }

        this.lastPosition = pos;
    }

    onPointerUp() {
        this.isFiling = false;
        this.lastPosition = null;
        this.velocity = 0;
    }

    onFile(intensity) {
        // Play filing sound
        soundManager.playFileSound(intensity);

        // Spawn particles
        this.spawnParticles(intensity);

        // If we have a target shape and haven't reached it yet
        if (this.targetShape && this.progress < 1) {
            this.progress += intensity * 0.02;

            if (this.progress >= 1) {
                this.progress = 1;
                // Shape complete!
                this.nail.setShape(this.targetShape);
                soundManager.playSuccess();
            }
        }
    }

    spawnParticles(intensity) {
        const numToSpawn = Math.floor(intensity * 5) + 1;

        // Get nail tip position (approximate)
        const nailPos = this.nail.getMesh().position;
        const spawnY = 0.6; // Near tip of nail

        for (let i = 0; i < numToSpawn; i++) {
            // Find an inactive particle
            const idx = this.particleLifetimes.findIndex(l => l <= 0);
            if (idx === -1) continue;

            // Spawn at nail tip with some randomness
            this.particlePositions[idx].set(
                nailPos.x + (Math.random() - 0.5) * 0.3,
                spawnY + Math.random() * 0.2,
                nailPos.z + 0.3 + Math.random() * 0.1
            );

            // Random velocity (mostly outward and down)
            this.particleVelocities[idx].set(
                (Math.random() - 0.5) * 0.02,
                -Math.random() * 0.01 - 0.005,
                Math.random() * 0.02
            );

            this.particleLifetimes[idx] = 0.5 + Math.random() * 0.5; // 0.5-1 second lifetime
        }
    }

    update(deltaTime) {
        if (!this.particles) return;

        const positions = this.particles.geometry.attributes.position.array;

        for (let i = 0; i < this.maxParticles; i++) {
            if (this.particleLifetimes[i] > 0) {
                // Update lifetime
                this.particleLifetimes[i] -= deltaTime;

                // Update position
                this.particlePositions[i].add(this.particleVelocities[i]);

                // Add gravity
                this.particleVelocities[i].y -= 0.0005;

                // Update buffer
                positions[i * 3] = this.particlePositions[i].x;
                positions[i * 3 + 1] = this.particlePositions[i].y;
                positions[i * 3 + 2] = this.particlePositions[i].z;
            } else {
                // Hide dead particles
                positions[i * 3 + 1] = -100;
            }
        }

        this.particles.geometry.attributes.position.needsUpdate = true;
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;
        this.isFiling = false;
    }

    setTargetShape(shape) {
        this.targetShape = shape;
        this.progress = 0;
    }

    // For immediate shape change (without filing animation)
    applyShapeImmediately(shape) {
        this.nail.setShape(shape);
        this.progress = 1;
        soundManager.playClick();
    }

    dispose() {
        if (this.particles) {
            this.particles.geometry.dispose();
            this.particles.material.dispose();
            this.scene.remove(this.particles);
        }
    }
}
