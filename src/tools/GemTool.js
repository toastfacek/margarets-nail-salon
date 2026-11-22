/**
 * GemTool.js
 * 3D gem/rhinestone placement on nail.
 *
 * - One InstancedMesh per gem type (shared geometry + material), so all gems
 *   cost at most six draw calls (plus one for the hover preview), whatever
 *   their number. At most 12 gems per nail.
 * - Gem materials read `scene.environment` (envMapIntensity), so they pick up
 *   the salon's reflections once WP3 provides an environment.
 * - Placing a gem pops it in with overshoot (instance matrix animated for a
 *   few frames), fires a sparkle burst and emits `deco:placed`.
 * - Hover moves of the preview request a render (render-on-demand tiers).
 * - No allocation in pointer-move handlers.
 */
import * as THREE from 'three';
import { soundManager } from '../audio/SoundManager.js';
import { EVENTS } from '../core/GameEvents.js';

const GEM_SIZE = 0.008;
const PREVIEW_SIZE = 0.007;
const MAX_PER_NAIL = 12;
const CAPACITY = MAX_PER_NAIL * 10; // per type: every nail of both hands
const SURFACE_OFFSET = 0.005;
const POP_TIME = 0.32;

function easeOutBack(t) {
    const c1 = 2.2;
    const c3 = c1 + 1;
    const x = t - 1;
    return 1 + c3 * x * x * x + c1 * x * x;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _look = new THREE.Object3D();
const ZERO_SCALE = Object.freeze(new THREE.Vector3(0, 0, 0));

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
        this.placedGems = [];   // records: { type, slot, hand, finger, position, quaternion, born }
        this.previewGem = null;

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this._hits = [];
        this._time = 0;
        this._popping = 0;      // gems still animating their pop

        // Juice hooks (wired by the brushJuice feature)
        this.events = null;
        this.sparkles = null;
        this.invalidate = null;
        this._decoPayload = { type: 'gem', id: null };

        this.group = new THREE.Group();
        this.group.name = 'Gems';
        this.scene.add(this.group);
        this._types = new Map();
        this._buildTypes();

        this.setupEventListeners();
    }

    /** Wire events, sparkles and redraw requests (brushJuice feature). */
    connect({ events = null, sparkles = null, invalidate = null } = {}) {
        this.events = events;
        this.sparkles = sparkles;
        this.invalidate = invalidate;
    }

    _requestRender() {
        if (this.invalidate) this.invalidate();
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

    _createGeometry(shape, size) {
        switch (shape) {
            case 'sphere':
                return new THREE.SphereGeometry(size, 16, 16);
            case 'heart':
                return this.createHeartGeometry(size);
            case 'star':
                return this.createStarGeometry(size);
            case 'flower':
                return this.createFlowerGeometry(size);
            case 'octahedron':
            default:
                return new THREE.OctahedronGeometry(size);
        }
    }

    _createMaterial(color, opacity) {
        return new THREE.MeshPhysicalMaterial({
            color,
            metalness: 0.0,
            roughness: 0.04,
            clearcoat: 1.0,
            clearcoatRoughness: 0.0,
            reflectivity: 1.0,
            envMapIntensity: 1.6, // reflections come from scene.environment
            transparent: true,
            opacity,
            ior: 2.4, // diamond-like
        });
    }

    /** One shared geometry + material + InstancedMesh per gem type (built once). */
    _buildTypes() {
        for (const gemData of GEM_TYPES) {
            const geometry = this._createGeometry(gemData.shape, GEM_SIZE);
            geometry.computeBoundingSphere();
            const material = this._createMaterial(gemData.color, 0.92);
            const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
            mesh.name = `Gems_${gemData.id}`;
            mesh.count = 0;
            mesh.visible = false;
            mesh.frustumCulled = false;
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            this.group.add(mesh);
            this._types.set(gemData.id, { data: gemData, geometry, material, mesh, entries: [] });
        }
        // Hover preview: one mesh; geometry and colour follow the selection.
        const first = this._types.get(GEM_TYPES[0].id);
        this._previewMaterial = this._createMaterial(GEM_TYPES[0].color, 0.5);
        this.previewGem = new THREE.Mesh(first.geometry, this._previewMaterial);
        this.previewGem.name = 'GemPreview';
        this.previewGem.visible = false;
        this.previewGem.scale.setScalar(PREVIEW_SIZE / GEM_SIZE);
        this.group.add(this.previewGem);
    }

    /** Compile the gem programs now (all hidden at startup). */
    prewarm(renderer, camera) {
        if (!renderer || !camera) return;
        const restore = [];
        this._types.forEach((t) => {
            restore.push(t.mesh.count, t.mesh.visible);
            t.mesh.count = Math.max(1, t.mesh.count);
            t.mesh.visible = true;
        });
        const pv = this.previewGem.visible;
        this.previewGem.visible = true;
        try {
            renderer.compile(this.group, camera, this.scene);
        } catch (err) {
            // optimisation only
        }
        let i = 0;
        this._types.forEach((t) => {
            t.mesh.count = restore[i++];
            t.mesh.visible = restore[i++];
        });
        this.previewGem.visible = pv;
    }

    /** Legacy: a standalone gem mesh (not added to the scene). */
    createGemMesh(gemId, size = GEM_SIZE) {
        const t = this._types.get(gemId) || this._types.get(GEM_TYPES[0].id);
        const mesh = new THREE.Mesh(t.geometry, t.material);
        mesh.scale.setScalar(size / GEM_SIZE);
        mesh.userData = { gemId: t.data.id, type: 'gem' };
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
        this._canvas = canvas;
    }

    updateMousePosition(event) {
        const canvas = this._canvas || document.querySelector('#canvas-container canvas');
        if (!canvas) return;

        // Only re-read the rect when the canvas size may have changed.
        if (!this._rect || event.type !== 'mousemove') this._rect = canvas.getBoundingClientRect();
        const rect = this._rect;
        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    }

    /** The nail hit under the pointer, or null. The hit object is reused. */
    getNailIntersection() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const nailMesh = this.nail.getNailMesh();
        if (!nailMesh) return null;

        const hits = this._hits;
        hits.length = 0;
        this.raycaster.intersectObject(nailMesh, false, hits);
        const hit = hits.length > 0 ? hits[0] : null;
        hits.length = 0;
        return hit;
    }

    /**
     * World-space face normal of a hit, written into `target` (no allocation).
     */
    getWorldNormal(intersection, target = new THREE.Vector3()) {
        const nailMesh = this.nail.getNailMesh();
        if (!intersection.face) return target.set(0, 1, 0);
        target.copy(intersection.face.normal);
        if (!nailMesh) return target;
        _nm.getNormalMatrix(nailMesh.matrixWorld);
        return target.applyMatrix3(_nm).normalize();
    }

    /** Position + outward orientation of a gem at a hit (into _p / _q). */
    _surfaceTransform(intersection) {
        this.getWorldNormal(intersection, _n);
        _p.copy(intersection.point).addScaledVector(_n, SURFACE_OFFSET);
        _look.position.copy(_p);
        _look.lookAt(_p.x + _n.x, _p.y + _n.y, _p.z + _n.z);
        _q.copy(_look.quaternion);
    }

    onMouseMove(event) {
        if (!this.isActive || !this.selectedGem || !this.previewGem) return;

        this.updateMousePosition(event);

        const intersection = this.getNailIntersection();
        if (intersection) {
            this._surfaceTransform(intersection);
            this.previewGem.position.copy(_p);
            this.previewGem.quaternion.copy(_q);
            this.previewGem.visible = true;
            this._requestRender();
        } else if (this.previewGem.visible) {
            this.previewGem.visible = false;
            this._requestRender();
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

    _countOn(hand, finger) {
        let n = 0;
        for (let i = 0; i < this.placedGems.length; i++) {
            const g = this.placedGems[i];
            if (g.hand === hand && g.finger === finger) n++;
        }
        return n;
    }

    _writeMatrix(t, g) {
        const shown = g.hand === this.nail.getCurrentHand();
        let k = 0;
        if (shown) {
            const age = this._time - g.born;
            k = age >= POP_TIME ? 1 : easeOutBack(Math.max(0, age) / POP_TIME);
        }
        if (k <= 0) _m.compose(g.position, g.quaternion, ZERO_SCALE);
        else _m.compose(g.position, g.quaternion, _s.setScalar(k));
        t.mesh.setMatrixAt(g.slot, _m);
        t.mesh.instanceMatrix.needsUpdate = true;
    }

    placeGem(intersection) {
        const hand = this.nail.getCurrentHand();
        const finger = this.nail.getActiveNail();
        if (this._countOn(hand, finger) >= MAX_PER_NAIL) return false;
        const t = this._types.get(this.selectedGem);
        if (!t || t.entries.length >= CAPACITY) return false;

        this._surfaceTransform(intersection);
        const g = {
            type: t.data.id,
            slot: t.entries.length,
            hand,
            finger,
            position: _p.clone(),
            quaternion: _q.clone(),
            born: this._time,
        };
        t.entries.push(g);
        this.placedGems.push(g);
        t.mesh.count = t.entries.length;
        t.mesh.visible = true;
        this._writeMatrix(t, g);
        this._popping++;

        if (this.sparkles) this.sparkles.burst(intersection.point, 16, t.data.color);
        if (this.events) {
            this._decoPayload.id = t.data.id;
            this.events.emit(EVENTS.DECO_PLACED, this._decoPayload);
        }
        // WP5 plays the sound from deco:placed; the direct call stays until it does.
        if (!this.events || this.events.listenerCount(EVENTS.DECO_PLACED) === 0) soundManager.playGemClink();
        this._requestRender();
        return true;
    }

    /**
     * Advance pop animations (loop dt). Returns true while something animates.
     */
    update(dt) {
        this._time += dt;
        if (this._popping === 0) return false;
        let still = 0;
        for (let i = this.placedGems.length - 1; i >= 0; i--) {
            const g = this.placedGems[i];
            const age = this._time - g.born;
            if (age - dt >= POP_TIME) break; // older gems finished earlier
            this._writeMatrix(this._types.get(g.type), g);
            if (age < POP_TIME) still++;
        }
        this._popping = still;
        return true;
    }

    /** Show only the gems of the current hand (call after a hand switch). */
    refreshVisibility() {
        this._types.forEach((t) => {
            for (let i = 0; i < t.entries.length; i++) this._writeMatrix(t, t.entries[i]);
        });
        this._requestRender();
    }

    selectGem(gemId) {
        this.selectedGem = gemId;
        const t = gemId ? this._types.get(gemId) : null;
        if (t) {
            this.previewGem.geometry = t.geometry;
            this._previewMaterial.color.set(t.data.color);
            soundManager.playClick();
        }
        if (this.previewGem.visible) {
            this.previewGem.visible = false;
            this._requestRender();
        }
    }

    activate() {
        this.isActive = true;
    }

    deactivate() {
        this.isActive = false;

        if (this.previewGem && this.previewGem.visible) {
            this.previewGem.visible = false;
            this._requestRender();
        }
    }

    _removeAt(index) {
        const g = this.placedGems[index];
        this.placedGems.splice(index, 1);
        const t = this._types.get(g.type);
        const last = t.entries.pop();
        if (last !== g) {
            // move the type's last instance into the freed slot
            last.slot = g.slot;
            t.entries[g.slot] = last;
            this._writeMatrix(t, last);
        }
        t.mesh.count = t.entries.length;
        t.mesh.visible = t.entries.length > 0;
    }

    clearAll() {
        this._types.forEach((t) => {
            t.entries.length = 0;
            t.mesh.count = 0;
            t.mesh.visible = false;
        });
        this.placedGems = [];
        this._popping = 0;
        this._requestRender();
    }

    /** Remove the gems of one nail (current hand by default). */
    clearNail(hand = this.nail.getCurrentHand(), finger = this.nail.getActiveNail()) {
        for (let i = this.placedGems.length - 1; i >= 0; i--) {
            const g = this.placedGems[i];
            if (g.hand === hand && g.finger === finger) this._removeAt(i);
        }
        this._requestRender();
    }

    removeLastGem() {
        if (this.placedGems.length > 0) {
            this._removeAt(this.placedGems.length - 1);
            this._requestRender();
        }
    }

    dispose() {
        this.scene.remove(this.group);
        this._types.forEach((t) => {
            t.mesh.dispose();
            t.geometry.dispose();
            t.material.dispose();
        });
        this._previewMaterial.dispose();
        this._types.clear();
    }
}
