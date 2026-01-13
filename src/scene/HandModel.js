/**
 * HandModel.js
 * Adapter for loaded hand.glb model, providing the same interface as NailModel
 * Supports 5 independent nails with click-to-select functionality
 */
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { modelLoader } from './ModelLoader.js';

// Enable BVH-accelerated raycasting globally for all meshes
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Nail shape options
export const NAIL_SHAPES = {
    ROUND: 'round',
    SQUARE: 'square',
    ALMOND: 'almond',
    STILETTO: 'stiletto',
    COFFIN: 'coffin'
};

// Finger identifiers
export const FINGERS = {
    THUMB: 'thumb',
    INDEX: 'index',
    MIDDLE: 'middle',
    RING: 'ring',
    PINKY: 'pinky'
};

// Map finger names to mesh names in the GLB
const NAIL_MESH_NAMES = {
    [FINGERS.THUMB]: 'Nail_Thumb',
    [FINGERS.INDEX]: 'Nail_Index',
    [FINGERS.MIDDLE]: 'Nail_Middle',
    [FINGERS.RING]: 'Nail_Ring',
    [FINGERS.PINKY]: 'Nail_Pinky'
};

export class HandModel {
    constructor() {
        this.group = new THREE.Group();

        // Dual-hand support
        this.currentHand = 'left';
        this.hands = {
            left: { model: null, nails: {} },
            right: { model: null, nails: {} }
        };

        this.activeNail = FINGERS.INDEX;  // Default to index finger
        this.currentShape = NAIL_SHAPES.ROUND;  // Default shape

        // Shared materials
        this.baseColor = new THREE.Color('#FFDDD2');
    }

    /**
     * Get nails object for current hand (convenience getter)
     */
    get nails() {
        return this.hands[this.currentHand].nails;
    }

    /**
     * Load both hand models and set up nail overlays
     * @param {string} shape - Nail shape to load (default: round)
     * @returns {Promise<void>}
     */
    async load(shape = NAIL_SHAPES.ROUND) {
        this.currentShape = shape;
        console.log(`Loading hand models with shape: ${shape}...`);

        try {
            // Load both hand models in parallel
            // TODO: When shape-specific GLB files are available, use:
            // modelLoader.load(`/models/hand-left-${shape}.glb`)
            const [leftModel, rightModel] = await Promise.all([
                modelLoader.load('/models/hand-left.glb'),
                modelLoader.load('/models/hand-right.glb')
            ]);

            console.log('Left hand model loaded:', leftModel);
            console.log('Right hand model loaded:', rightModel);

            // Store models
            this.hands.left.model = leftModel;
            this.hands.right.model = rightModel;

            // Add both to group
            this.group.add(leftModel);
            this.group.add(rightModel);

            // Hide right hand initially
            rightModel.visible = false;

            // Set up nails for both hands
            this.setupHandNails('left', leftModel);
            this.setupHandNails('right', rightModel);

            // Position and orient the hand model
            this.setupOrientation();

            console.log('Hand models setup complete. Group:', this.group);
        } catch (error) {
            console.error('Failed to load hand models:', error);
        }
    }

    /**
     * Set up all nails for a specific hand
     */
    setupHandNails(hand, model) {
        // Debug: Log all objects in the model
        model.traverse((child) => {
            if (child.isMesh) {
                console.log(`[${hand}] Found mesh:`, child.name);
            }
        });

        // Find and set up each nail mesh
        for (const [finger, meshName] of Object.entries(NAIL_MESH_NAMES)) {
            const nailMesh = this.findMeshByName(model, meshName, hand);

            if (nailMesh) {
                console.log(`[${hand}] Setting up nail: ${finger} -> ${meshName}`);
                this.setupNailForHand(hand, finger, nailMesh);
            } else {
                console.warn(`[${hand}] Nail mesh not found: ${meshName}`);
            }
        }
    }

    /**
     * Recursively find a mesh by name in the model hierarchy
     * Also tries with _Left suffix for left hand models
     */
    findMeshByName(object, name, hand = null) {
        // Try exact match first
        if (object.name === name && object.isMesh) {
            return object;
        }

        // Try with _Left suffix for left hand
        if (hand === 'left' && object.name === `${name}_Left` && object.isMesh) {
            return object;
        }

        for (const child of object.children) {
            const found = this.findMeshByName(child, name, hand);
            if (found) return found;
        }

        return null;
    }

    /**
     * Generate UV coordinates for a nail geometry based on bounding box projection
     * This allows canvas-based tools (stickers, glitter, brush) to work on GLB models
     */
    generateNailUVs(geometry) {
        // Compute bounding box if not already computed
        if (!geometry.boundingBox) {
            geometry.computeBoundingBox();
        }

        const bbox = geometry.boundingBox;
        const positions = geometry.attributes.position;
        const uvs = new Float32Array(positions.count * 2);

        // Get extent of the nail in local space
        const size = new THREE.Vector3();
        bbox.getSize(size);

        // Avoid division by zero
        const sizeX = size.x || 1;
        const sizeY = size.y || 1;

        // Map each vertex position to UV coordinates (0-1 range)
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const y = positions.getY(i);

            // Normalize to 0-1 based on bounding box
            uvs[i * 2] = (x - bbox.min.x) / sizeX;
            uvs[i * 2 + 1] = (y - bbox.min.y) / sizeY;
        }

        // Add UV attribute to geometry
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        console.log(`Generated UVs for nail geometry (${positions.count} vertices)`);
    }

    /**
     * Set up a single nail with overlay and canvas texture for a specific hand
     */
    setupNailForHand(hand, finger, nailMesh) {
        // Ensure nail mesh has UV coordinates for canvas-based tools
        if (!nailMesh.geometry.attributes.uv) {
            console.log(`[${hand}] Generating UVs for ${finger} nail`);
            this.generateNailUVs(nailMesh.geometry);
        }

        // Add BVH for fast raycasting
        if (!nailMesh.geometry.boundsTree) {
            nailMesh.geometry.boundsTree = new MeshBVH(nailMesh.geometry);
            console.log(`[${hand}] BVH generated for ${finger} nail`);
        }

        // Create overlay mesh for drawing
        const overlayGeometry = nailMesh.geometry.clone();
        const overlayMaterial = new THREE.MeshBasicMaterial({
            map: null,
            transparent: true,
            opacity: 1,
            side: THREE.DoubleSide,
            depthWrite: false,
            depthTest: true,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        });

        const overlayMesh = new THREE.Mesh(overlayGeometry, overlayMaterial);
        overlayMesh.name = `${hand}_${finger}_overlay`;
        overlayMesh.visible = true;
        overlayMesh.renderOrder = 10;  // Render after nail mesh

        // Copy local transforms from nail mesh
        overlayMesh.position.copy(nailMesh.position);
        overlayMesh.rotation.copy(nailMesh.rotation);
        overlayMesh.scale.copy(nailMesh.scale);

        // Copy the world matrix to ensure proper positioning
        overlayMesh.matrixAutoUpdate = true;

        // Parent the overlay to the same parent as the nail
        // so it follows any armature/bone transforms
        if (nailMesh.parent) {
            nailMesh.parent.add(overlayMesh);
        } else {
            this.group.add(overlayMesh);
        }

        // Create drawing canvas
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 1024;
        const ctx = canvas.getContext('2d');

        // Create texture
        const texture = new THREE.CanvasTexture(canvas);
        texture.flipY = false;
        overlayMaterial.map = texture;

        // Store nail state for this hand
        this.hands[hand].nails[finger] = {
            mesh: nailMesh,
            overlay: overlayMesh,
            canvas,
            ctx,
            texture,
            polishColor: null,
            finish: 'glossy',
            originalMaterial: nailMesh.material.clone()
        };

        // Create proper nail material if needed
        this.setupNailMaterialForHand(hand, finger);
    }

    /**
     * Set up nail material with proper physical properties for a specific hand
     */
    setupNailMaterialForHand(hand, finger) {
        const nail = this.hands[hand].nails[finger];
        if (!nail) return;

        // Create physical material for glossy nail finish
        const nailMaterial = new THREE.MeshPhysicalMaterial({
            color: this.baseColor,
            roughness: 0.25,
            metalness: 0.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.1,
            reflectivity: 0.6,
            envMapIntensity: 1.0,
            side: THREE.FrontSide,
        });

        nail.mesh.material = nailMaterial;
        nail.material = nailMaterial;
    }

    /**
     * Set up hand orientation and position
     */
    setupOrientation() {
        // We want: looking down at the back of the hand (nail side up)
        // Fingers pointing away from camera, palm down

        // Rotate hand so nails face up toward camera
        this.group.rotation.x = 0;
        this.group.rotation.y = Math.PI;  // Rotate 180 so fingers point away
        this.group.rotation.z = 0;

        // Position to center in view (adjust based on model bounds)
        this.group.position.set(0, -1, 0);

        // Scale if needed
        this.group.scale.setScalar(1.0);
    }

    // =========================================
    // Hand Switching Methods
    // =========================================

    /**
     * Switch between left and right hand
     * @param {string} hand - 'left' or 'right'
     */
    switchHand(hand) {
        if (hand !== 'left' && hand !== 'right') {
            console.warn(`Invalid hand: ${hand}`);
            return;
        }
        if (hand === this.currentHand) return;

        // Hide current hand model
        if (this.hands[this.currentHand].model) {
            this.hands[this.currentHand].model.visible = false;
        }

        // Show new hand model
        if (this.hands[hand].model) {
            this.hands[hand].model.visible = true;
        }

        // Update current hand
        this.currentHand = hand;

        // Re-apply highlight to active nail on new hand
        this.setNailHighlight(this.activeNail, true);

        console.log(`Switched to ${hand} hand`);
    }

    /**
     * Get the currently active hand
     * @returns {string} 'left' or 'right'
     */
    getCurrentHand() {
        return this.currentHand;
    }

    // =========================================
    // NailModel Interface Methods
    // =========================================

    /**
     * Get the root group for scene addition
     */
    getMesh() {
        return this.group;
    }

    /**
     * Get the currently active nail mesh (for tools raycasting)
     */
    getNailMesh() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.mesh : null;
    }

    /**
     * Get all nail meshes (for selection raycasting)
     */
    getNailMeshes() {
        return Object.values(this.nails).map(n => n.mesh);
    }

    /**
     * Get the drawing context for the active nail
     */
    getDrawingContext() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.ctx : null;
    }

    /**
     * Get the drawing texture for the active nail
     */
    getDrawingTexture() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.texture : null;
    }

    /**
     * Update the drawing texture after canvas modifications
     */
    updateDrawingTexture() {
        const nail = this.nails[this.activeNail];
        if (nail && nail.texture) {
            nail.texture.needsUpdate = true;
        }
    }

    /**
     * Clear drawing on the active nail
     */
    clearDrawing() {
        const nail = this.nails[this.activeNail];
        if (nail && nail.ctx) {
            nail.ctx.clearRect(0, 0, 1024, 1024);
            this.updateDrawingTexture();
        }
    }

    /**
     * Clear drawing on all nails
     */
    clearAllDrawings() {
        for (const nail of Object.values(this.nails)) {
            if (nail.ctx) {
                nail.ctx.clearRect(0, 0, 1024, 1024);
                nail.texture.needsUpdate = true;
            }
        }
    }

    // =========================================
    // Nail Selection Methods
    // =========================================

    /**
     * Set the active nail by finger name
     * @param {string} finger - One of FINGERS values
     */
    setActiveNail(finger) {
        if (!this.nails[finger]) {
            console.warn(`Unknown finger: ${finger}`);
            return;
        }

        // Remove highlight from previous
        this.setNailHighlight(this.activeNail, false);

        // Set new active
        this.activeNail = finger;

        // Add highlight to new active
        this.setNailHighlight(finger, true);
    }

    /**
     * Get the currently active nail finger name
     */
    getActiveNail() {
        return this.activeNail;
    }

    /**
     * Get the finger name from a nail mesh
     * @param {THREE.Mesh} mesh - A nail mesh
     * @returns {string|null} Finger name or null if not a nail
     */
    getFingerFromMesh(mesh) {
        for (const [finger, nail] of Object.entries(this.nails)) {
            if (nail.mesh === mesh) {
                return finger;
            }
        }
        return null;
    }

    /**
     * Get the world position of a nail's visible surface center
     * @param {string} finger - Finger identifier
     * @returns {THREE.Vector3|null} World position or null if finger not found
     */
    getNailWorldPosition(finger) {
        const nail = this.nails[finger];
        if (!nail || !nail.mesh) return null;

        const mesh = nail.mesh;

        // Ensure geometry has bounding box computed
        if (!mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox();
        }

        const bbox = mesh.geometry.boundingBox;

        // Get the TOP surface center of the nail (not volumetric center)
        // Use center X/Z for horizontal centering, but max Y for the visible surface
        const surfaceCenter = new THREE.Vector3(
            (bbox.min.x + bbox.max.x) / 2,  // center X
            bbox.max.y,                      // top surface Y
            (bbox.min.z + bbox.max.z) / 2   // center Z
        );

        // Transform to world space
        mesh.updateWorldMatrix(true, false);
        surfaceCenter.applyMatrix4(mesh.matrixWorld);

        return surfaceCenter;
    }

    /**
     * Get the world position of the currently active nail
     * @returns {THREE.Vector3|null} World position or null
     */
    getActiveNailWorldPosition() {
        return this.getNailWorldPosition(this.activeNail);
    }

    /**
     * Set visual highlight on a nail (selection indicator)
     */
    setNailHighlight(finger, highlighted) {
        const nail = this.nails[finger];
        if (!nail || !nail.material) return;

        if (highlighted) {
            // Add subtle emissive glow
            nail.material.emissive = new THREE.Color(0xffaacc);
            nail.material.emissiveIntensity = 0.3;
        } else {
            // Remove glow
            nail.material.emissive = new THREE.Color(0x000000);
            nail.material.emissiveIntensity = 0;
        }
        nail.material.needsUpdate = true;
    }

    // =========================================
    // Polish & Finish Methods
    // =========================================

    /**
     * Set polish color on the active nail
     */
    setPolishColor(color) {
        const nail = this.nails[this.activeNail];
        if (!nail || !nail.material) return;

        nail.polishColor = new THREE.Color(color);
        nail.material.color = nail.polishColor;
        nail.material.roughness = 0.1;
        nail.material.clearcoat = 1.0;
        nail.material.clearcoatRoughness = 0.05;
        nail.material.needsUpdate = true;
    }

    /**
     * Clear polish from the active nail
     */
    clearPolish() {
        const nail = this.nails[this.activeNail];
        if (!nail || !nail.material) return;

        nail.polishColor = null;
        nail.material.color = this.baseColor;
        nail.material.roughness = 0.25;
        nail.material.clearcoat = 1.0;
        nail.material.metalness = 0.0;
        nail.material.needsUpdate = true;
    }

    /**
     * Set finish type on the active nail
     */
    setFinish(type) {
        const nail = this.nails[this.activeNail];
        if (!nail || !nail.material) return;

        nail.finish = type;

        switch (type) {
            case 'matte':
                nail.material.roughness = 0.8;
                nail.material.clearcoat = 0.0;
                nail.material.metalness = 0.0;
                break;

            case 'shimmer':
                nail.material.roughness = 0.2;
                nail.material.clearcoat = 1.0;
                nail.material.metalness = 0.3;
                break;

            case 'chrome':
                nail.material.roughness = 0.05;
                nail.material.clearcoat = 1.0;
                nail.material.metalness = 0.9;
                break;

            case 'holographic':
                nail.material.roughness = 0.1;
                nail.material.clearcoat = 1.0;
                nail.material.metalness = 0.4;
                nail.material.iridescence = 1.0;
                nail.material.iridescenceIOR = 1.5;
                break;

            case 'glossy':
            default:
                nail.material.roughness = 0.1;
                nail.material.clearcoat = 1.0;
                nail.material.clearcoatRoughness = 0.05;
                nail.material.metalness = 0.0;
                break;
        }

        nail.material.needsUpdate = true;
    }

    // =========================================
    // Shape Methods
    // =========================================

    /**
     * Save current nail state (polish, finish, drawings) for all nails
     * @returns {Object} State object with left/right hand nail states
     */
    saveNailState() {
        const state = { left: {}, right: {} };
        for (const hand of ['left', 'right']) {
            for (const [finger, nail] of Object.entries(this.hands[hand].nails)) {
                state[hand][finger] = {
                    polishColor: nail.polishColor?.clone(),
                    finish: nail.finish,
                    canvasData: nail.canvas.toDataURL()
                };
            }
        }
        return state;
    }

    /**
     * Restore nail state (polish, finish, drawings) to all nails
     * @param {Object} state - State object from saveNailState()
     */
    restoreNailState(state) {
        const originalHand = this.currentHand;
        const originalNail = this.activeNail;

        for (const hand of ['left', 'right']) {
            for (const [finger, saved] of Object.entries(state[hand])) {
                const nail = this.hands[hand].nails[finger];
                if (!nail) continue;

                // Restore polish color
                if (saved.polishColor) {
                    this.currentHand = hand;
                    this.activeNail = finger;
                    this.setPolishColor(saved.polishColor);
                }

                // Restore finish
                if (saved.finish) {
                    this.setFinish(saved.finish);
                }

                // Restore canvas drawing
                if (saved.canvasData && saved.canvasData !== 'data:,') {
                    const img = new Image();
                    img.onload = () => {
                        nail.ctx.drawImage(img, 0, 0);
                        nail.texture.needsUpdate = true;
                    };
                    img.src = saved.canvasData;
                }
            }
        }

        // Restore original selection
        this.currentHand = originalHand;
        this.activeNail = originalNail;
    }

    /**
     * Set nail shape by loading different GLB models
     * Preserves polish colors and drawings across shape changes
     * @param {string} shape - One of NAIL_SHAPES values
     * @returns {boolean} Whether shape was changed
     */
    async setShape(shape) {
        if (shape === this.currentShape) return false;
        if (!Object.values(NAIL_SHAPES).includes(shape)) {
            console.warn(`Invalid shape: ${shape}`);
            return false;
        }

        // TODO: Enable when shape-specific GLB files are available
        // For now, only 'round' shape is available (current model)
        if (shape !== NAIL_SHAPES.ROUND) {
            console.info(`Shape '${shape}' not yet available - needs GLB model`);
            return false;
        }

        console.log(`Switching nail shape from ${this.currentShape} to ${shape}`);

        // Save current state (polish colors, drawings)
        const savedState = this.saveNailState();
        const wasRightHand = this.currentHand === 'right';

        // Clean up current models
        if (this.hands.left.model) {
            this.group.remove(this.hands.left.model);
            this.disposeModel(this.hands.left.model);
        }
        if (this.hands.right.model) {
            this.group.remove(this.hands.right.model);
            this.disposeModel(this.hands.right.model);
        }

        // Reset nail references
        this.hands.left.nails = {};
        this.hands.right.nails = {};

        // Load new shape models
        await this.load(shape);

        // Restore which hand was visible
        if (wasRightHand) {
            this.hands.left.model.visible = false;
            this.hands.right.model.visible = true;
            this.currentHand = 'right';
        }

        // Restore state to new nails
        this.restoreNailState(savedState);

        // Re-apply highlight to active nail
        this.setNailHighlight(this.activeNail, true);

        console.log(`Shape changed to ${shape}`);
        return true;
    }

    /**
     * Check if a shape is available (has GLB model)
     * @param {string} shape - Shape to check
     * @returns {boolean} Whether shape is available
     */
    isShapeAvailable(shape) {
        // TODO: Update this list as shape GLB files become available
        const availableShapes = [NAIL_SHAPES.ROUND];
        return availableShapes.includes(shape);
    }

    /**
     * Dispose of a model and its resources
     */
    disposeModel(model) {
        model.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            }
        });
    }

    /**
     * Get current nail shape
     * @returns {string} Current shape
     */
    getShape() {
        return this.currentShape;
    }

    /**
     * Set finger type - not applicable for HandModel
     */
    setFingerType(fingerType) {
        console.info('setFingerType not applicable for HandModel - use setActiveNail instead');
    }

    // =========================================
    // Overlay Methods
    // =========================================

    setOverlayTexture(texture) {
        const nail = this.nails[this.activeNail];
        if (nail && nail.overlay) {
            nail.overlay.material.map = texture;
            nail.overlay.material.needsUpdate = true;
        }
    }

    setOverlayVisible(visible) {
        const nail = this.nails[this.activeNail];
        if (nail && nail.overlay) {
            nail.overlay.visible = visible;
        }
    }
}
