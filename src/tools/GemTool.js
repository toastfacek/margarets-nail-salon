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
    { id: 'star', emoji: '⭐', color: '#FFD700', shape: 'star' },
    { id: 'flower', emoji: '🌸', color: '#FF69B4', shape: 'flower' },
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

    createHeartGeometry(size) {
        const x = 0, y = 0;
        const heartShape = new THREE.Shape();

        // Scale factor for the heart
        const s = size * 2;

        heartShape.moveTo(x, y + s * 0.35);
        heartShape.bezierCurveTo(x, y + s * 0.35, x - s * 0.05, y, x - s * 0.25, y);
        heartShape.bezierCurveTo(x - s * 0.55, y, x - s * 0.55, y + s * 0.35, x - s * 0.55, y + s * 0.35);
        heartShape.bezierCurveTo(x - s * 0.55, y + s * 0.55, x - s * 0.35, y + s * 0.77, x, y + s);
        heartShape.bezierCurveTo(x + s * 0.35, y + s * 0.77, x + s * 0.55, y + s * 0.55, x + s * 0.55, y + s * 0.35);
        heartShape.bezierCurveTo(x + s * 0.55, y + s * 0.35, x + s * 0.55, y, x + s * 0.25, y);
        heartShape.bezierCurveTo(x + s * 0.05, y, x, y + s * 0.35, x, y + s * 0.35);

        const extrudeSettings = {
            depth: size * 0.5,
            bevelEnabled: true,
            bevelThickness: size * 0.15,
            bevelSize: size * 0.1,
            bevelSegments: 3
        };

        const geometry = new THREE.ExtrudeGeometry(heartShape, extrudeSettings);
        geometry.center();
        geometry.rotateX(Math.PI); // Flip so point faces down

        return geometry;
    }

    createStarGeometry(size) {
        const starShape = new THREE.Shape();
        const s = size * 1.5;
        const points = 5;
        const outerRadius = s;
        const innerRadius = s * 0.4;

        for (let i = 0; i < points * 2; i++) {
            const radius = i % 2 === 0 ? outerRadius : innerRadius;
            const angle = (i * Math.PI) / points - Math.PI / 2;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;

            if (i === 0) {
                starShape.moveTo(x, y);
            } else {
                starShape.lineTo(x, y);
            }
        }
        starShape.closePath();

        const extrudeSettings = {
            depth: size * 0.4,
            bevelEnabled: true,
            bevelThickness: size * 0.1,
            bevelSize: size * 0.08,
            bevelSegments: 2
        };

        const geometry = new THREE.ExtrudeGeometry(starShape, extrudeSettings);
        geometry.center();

        return geometry;
    }

    createFlowerGeometry(size) {
        // Create a flower with 5 distinct rounded petals + center circle
        const petals = 5;
        const petalRadius = size * 0.5;
        const centerDist = size * 0.55;

        // Create each petal as a squashed sphere (ellipsoid)
        for (let i = 0; i < petals; i++) {
            const angle = (i * Math.PI * 2) / petals - Math.PI / 2;
            const petalGeom = new THREE.SphereGeometry(petalRadius, 12, 8);

            // Squash the petal to make it flat but round
            petalGeom.scale(0.75, 0.75, 0.3);

            // Position petal around center
            petalGeom.translate(
                Math.cos(angle) * centerDist,
                Math.sin(angle) * centerDist,
                0
            );

            // Merge into a single geometry
            if (i === 0) {
                this._flowerGeom = petalGeom;
            } else {
                this._flowerGeom = this.mergeGeometries(this._flowerGeom, petalGeom);
            }
        }

        // Add center circle (more prominent)
        const centerGeom = new THREE.SphereGeometry(size * 0.3, 16, 12);
        centerGeom.scale(1, 1, 0.6);
        centerGeom.translate(0, 0, size * 0.05); // Raise it slightly
        const finalGeom = this.mergeGeometries(this._flowerGeom, centerGeom);
        finalGeom.center();

        return finalGeom;
    }

    mergeGeometries(geom1, geom2) {
        // Simple merge by combining position attributes
        const pos1 = geom1.attributes.position.array;
        const pos2 = geom2.attributes.position.array;
        const norm1 = geom1.attributes.normal.array;
        const norm2 = geom2.attributes.normal.array;
        const idx1 = geom1.index ? Array.from(geom1.index.array) : [];
        const idx2 = geom2.index ? Array.from(geom2.index.array) : [];

        const newPos = new Float32Array(pos1.length + pos2.length);
        newPos.set(pos1);
        newPos.set(pos2, pos1.length);

        const newNorm = new Float32Array(norm1.length + norm2.length);
        newNorm.set(norm1);
        newNorm.set(norm2, norm1.length);

        const vertexOffset = pos1.length / 3;
        const newIdx = idx1.concat(idx2.map(i => i + vertexOffset));

        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
        merged.setAttribute('normal', new THREE.BufferAttribute(newNorm, 3));
        merged.setIndex(newIdx);

        return merged;
    }

    createGemMesh(gemId, size = 0.008) {
        const gemData = GEM_TYPES.find(g => g.id === gemId) || GEM_TYPES[0];

        let geometry;
        switch (gemData.shape) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(size, 16, 16);
                break;
            case 'heart':
                geometry = this.createHeartGeometry(size);
                break;
            case 'star':
                geometry = this.createStarGeometry(size);
                break;
            case 'flower':
                geometry = this.createFlowerGeometry(size);
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
            const offset = worldNormal.clone().multiplyScalar(0.005);
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
        const offset = worldNormal.clone().multiplyScalar(0.005);
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

        // Clean up existing preview
        if (this.previewGem) {
            this.scene.remove(this.previewGem);
            this.previewGem.geometry.dispose();
            this.previewGem.material.dispose();
            this.previewGem = null;
        }

        // Create preview only if a gem is selected
        if (gemId) {
            this.previewGem = this.createGemMesh(gemId, 0.007);
            this.previewGem.material.opacity = 0.5;
            this.previewGem.visible = false;
            this.scene.add(this.previewGem);
            soundManager.playClick();
        }
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
