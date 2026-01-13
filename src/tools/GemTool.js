/**
 * GemTool.js
 * 3D gem/rhinestone placement on nail
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';

// Gem types with geometry and colors
export const GEM_TYPES = [
    { id: 'diamond', emoji: '💎', color: '#00CED1', shape: 'octahedron' },
    { id: 'crystal', emoji: '💠', color: '#87CEEB', shape: 'octahedron' },
    { id: 'ruby', emoji: '🔶', color: '#FF6B6B', shape: 'octahedron' },
    { id: 'sapphire', emoji: '🔷', color: '#4169E1', shape: 'octahedron' },
    { id: 'pearl', emoji: '⚪', color: '#FFFAFA', shape: 'sphere' },
    { id: 'heart', emoji: '❤️', color: '#FF69B4', shape: 'heart' },
];

export class GemTool {
    constructor(scene, camera, nail) {
        this.scene = scene;
        this.camera = camera;
        this.nail = nail;
        this.isActive = false;

        this.selectedGem = null;
        this.placedGems = [];
        this.previewGem = null;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.setupEventListeners();
    }

    createGemMesh(gemId, size = 0.06) {
        const gemData = GEM_TYPES.find(g => g.id === gemId) || GEM_TYPES[0];

        let geometry;
        switch (gemData.shape) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(size, 16, 16);
                break;
            case 'heart':
                // Approximate heart with scaled sphere
                geometry = new THREE.SphereGeometry(size, 16, 16);
                break;
            case 'octahedron':
            default:
                geometry = new THREE.OctahedronGeometry(size);
                break;
        }

        // Gem material with refraction-like properties
        const material = new THREE.MeshPhysicalMaterial({
            color: gemData.color,
            metalness: 0.0,
            roughness: 0.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.0,
            reflectivity: 1.0,
            envMapIntensity: 1.5,
            transparent: true,
            opacity: 0.9,
            ior: 2.4, // Diamond-like refraction
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.userData = { gemId, type: 'gem' };

        return mesh;
    }

    setupEventListeners() {
        const canvas = document.querySelector('#canvas-container canvas');
        if (!canvas) {
            setTimeout(() => this.setupEventListeners(), 100);
            return;
        }

        canvas.addEventListener('click', (e) => this.onClick(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
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

    getNailIntersection() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return null;

        const intersects = this.raycaster.intersectObject(nailMesh, true);
        return intersects.length > 0 ? intersects[0] : null;
    }

    /**
     * Transform a face normal from object space to world space
     */
    getWorldNormal(intersection) {
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return intersection.face.normal.clone();

        // Create normal matrix from the mesh's world matrix
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(nailMesh.matrixWorld);

        // Transform the face normal to world space
        return intersection.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    }

    onMouseMove(event) {
        if (!this.isActive || !this.selectedGem) return;

        this.updateMousePosition(event);

        const intersection = this.getNailIntersection();
        if (intersection && this.previewGem) {
            // Get world-space normal for proper positioning
            const worldNormal = this.getWorldNormal(intersection);

            // Position gem on nail surface
            const offset = worldNormal.clone().multiplyScalar(0.04);
            this.previewGem.position.copy(intersection.point).add(offset);
            this.previewGem.visible = true;

            // Rotate to face outward
            this.previewGem.lookAt(
                intersection.point.x + worldNormal.x,
                intersection.point.y + worldNormal.y,
                intersection.point.z + worldNormal.z
            );
        } else if (this.previewGem) {
            this.previewGem.visible = false;
        }
    }

    onClick(event) {
        if (!this.isActive || !this.selectedGem) return;

        this.updateMousePosition(event);

        const intersection = this.getNailIntersection();
        if (intersection) {
            this.placeGem(intersection);
        }
    }

    onTouchStart(event) {
        if (!this.isActive || !this.selectedGem) return;

        event.preventDefault();
        this.updateMousePosition(event);

        const intersection = this.getNailIntersection();
        if (intersection) {
            this.placeGem(intersection);
        }
    }

    placeGem(intersection) {
        // Create gem mesh
        const gem = this.createGemMesh(this.selectedGem);

        // Get world-space normal for proper positioning
        const worldNormal = this.getWorldNormal(intersection);

        // Position on nail
        const offset = worldNormal.clone().multiplyScalar(0.04);
        gem.position.copy(intersection.point).add(offset);

        // Rotate to face outward
        gem.lookAt(
            intersection.point.x + worldNormal.x,
            intersection.point.y + worldNormal.y,
            intersection.point.z + worldNormal.z
        );

        // Add to scene
        this.scene.add(gem);
        this.placedGems.push(gem);

        // Play clink sound
        soundManager.playGemClink();

        console.log(`Placed gem: ${this.selectedGem}`);
    }

    selectGem(gemId) {
        this.selectedGem = gemId;

        // Create or update preview
        if (this.previewGem) {
            this.scene.remove(this.previewGem);
            this.previewGem.geometry.dispose();
            this.previewGem.material.dispose();
        }

        this.previewGem = this.createGemMesh(gemId, 0.05);
        this.previewGem.material.opacity = 0.5;
        this.previewGem.visible = false;
        this.scene.add(this.previewGem);

        soundManager.playClick();
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;

        if (this.previewGem) {
            this.previewGem.visible = false;
        }
    }

    clearAll() {
        this.placedGems.forEach(gem => {
            this.scene.remove(gem);
            gem.geometry.dispose();
            gem.material.dispose();
        });
        this.placedGems = [];
    }

    removeLastGem() {
        if (this.placedGems.length > 0) {
            const lastGem = this.placedGems.pop();
            this.scene.remove(lastGem);
            lastGem.geometry.dispose();
            lastGem.material.dispose();
        }
    }

    dispose() {
        this.clearAll();
        if (this.previewGem) {
            this.scene.remove(this.previewGem);
            this.previewGem.geometry.dispose();
            this.previewGem.material.dispose();
        }
    }
}
