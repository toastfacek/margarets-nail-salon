/**
 * HandModel.js
 * Adapter for the loaded hand GLBs: five independent nails per hand, each with
 * its own NailMaterial, a lazily created decoration canvas (stickers, drawing)
 * and a lazily created baked paint render target.
 *
 * Public API: build plan section 0.6.
 */
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { modelLoader } from './ModelLoader.js';
import { createNailMaterial, createNailLighting, applyNailFinish, nailVariantKey } from './NailMaterial.js';
import { createSkinMaterials, createSkinShared, setSkinTone } from './SkinMaterial.js';
import { computeSettings } from '../core/Quality.js';
import { whenIdle, warmRender } from './Warmup.js';

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

const FINGER_LIST = Object.freeze([FINGERS.THUMB, FINGERS.INDEX, FINGERS.MIDDLE, FINGERS.RING, FINGERS.PINKY]);
const HAND_LIST = Object.freeze(['left', 'right']);

// Map finger names to mesh names in the GLB
const NAIL_MESH_NAMES = {
    [FINGERS.THUMB]: 'Nail_Thumb',
    [FINGERS.INDEX]: 'Nail_Index',
    [FINGERS.MIDDLE]: 'Nail_Middle',
    [FINGERS.RING]: 'Nail_Ring',
    [FINGERS.PINKY]: 'Nail_Pinky'
};

const DECO_DESIGN_RES = 1024; // tools draw in 1024x1024 coordinates on every tier
const MASK_RES = 32;

const DEFAULT_SETTINGS = Object.freeze({ decoCanvasRes: 1024, bakedPaintRes: 512 });

function modelUrl(hand) {
    return `${import.meta.env.BASE_URL}models/hand-${hand}.glb`;
}

/**
 * One nail. `canvas`, `ctx` and `texture` are lazy: the decoration canvas is
 * only created the first time a tool asks for it.
 */
class NailRecord {
    constructor(owner, hand, finger, mesh, material) {
        this._owner = owner;
        this.hand = hand;
        this.finger = finger;
        this.mesh = mesh;
        this.material = material;
        this.variants = {};          // tier define key -> material (all share material.uniforms)
        this.finish = 'glossy';
        this.polishColor = null;
        this.paintTarget = null;
        this.coverage = 0;
        this.uvAspect = 1;
        this._nailMask = null;
        this._canvas = null;
        this._ctx = null;
        this._texture = null;
        this._decoScale = 1;
    }

    get canvas() { this._owner._ensureDeco(this); return this._canvas; }
    get ctx() { this._owner._ensureDeco(this); return this._ctx; }
    get texture() { this._owner._ensureDeco(this); return this._texture; }
    get hasDeco() { return this._canvas !== null; }
}

export class HandModel {
    /**
     * @param {{ settings?: object, renderer?: THREE.WebGLRenderer, lighting?: object }} [opts]
     */
    constructor({ settings = null, renderer = null, lighting = null } = {}) {
        this.group = new THREE.Group();
        this.settings = settings || DEFAULT_SETTINGS;
        this.renderer = renderer;
        this.lighting = lighting || createNailLighting();

        // Dual-hand support
        this.currentHand = 'left';
        this.hands = {
            left: { model: null, nails: {}, skins: [] },
            right: { model: null, nails: {}, skins: [] }
        };
        this._loading = { left: null, right: null };

        this.activeNail = FINGERS.INDEX;  // Default to index finger
        this.currentShape = NAIL_SHAPES.ROUND;  // Default shape

        this.baseColor = new THREE.Color('#FFDDD2');

        // Called whenever something visible changes (wired to app.loop.invalidate).
        this.onChange = null;
        // Called when a different hand becomes visible (NailScene re-bakes the
        // contact shadow).
        this.onHandShown = null;

        // Skin colour and glow, shared by both hands and every tier variant.
        this.skinShared = createSkinShared();

        this._clearColor = new THREE.Color();
    }

    /**
     * Get nails object for current hand (convenience getter)
     */
    get nails() {
        return this.hands[this.currentHand].nails;
    }

    _invalidate() {
        if (this.onChange) this.onChange();
    }

    setRenderer(renderer) {
        this.renderer = renderer;
    }

    /**
     * New settings apply to resources created from now on; the skin and nail
     * material variants switch immediately (pre-compiled, see precompileVariants).
     */
    setQuality(settings) {
        this.settings = settings || this.settings;
        this._applySkinVariant();
        this._applyNailVariant();
        // The next tier down may follow: warm its variants at idle.
        if (this._warmArgs) this.precompileVariants(this._warmArgs[0], this._warmArgs[1], this._warmArgs[2], 1500);
    }

    // =========================================
    // Skin (SkinMaterial: per-pixel 'full', per-vertex 'lite' on low)
    // =========================================

    _setupSkin(hand, model) {
        const skins = this.hands[hand].skins;
        const nails = this.hands[hand].nails;
        const isNail = (m) => {
            for (const f in nails) if (nails[f].mesh === m) return true;
            return false;
        };
        model.traverse((child) => {
            if (!child.isMesh || child.material === undefined) return;
            if (isNail(child)) return;
            const source = child.material;
            if (!source || Array.isArray(source)) return;
            const { full, lite } = createSkinMaterials(this.skinShared);
            skins.push({ mesh: child, full, lite });
            source.dispose();
        });
        this._applySkinVariant();
    }

    _skinVariant(settings = this.settings) {
        return settings.skin === 'lambert' ? 'lite' : 'full';
    }

    _applySkinVariant() {
        const variant = this._skinVariant();
        for (let h = 0; h < HAND_LIST.length; h++) {
            const skins = this.hands[HAND_LIST[h]].skins;
            for (let i = 0; i < skins.length; i++) {
                const s = skins[i];
                s.mesh.material = s[variant];
            }
        }
        this._invalidate();
    }

    /** Skin tone for every hand (uniform/colour writes only). */
    setSkinTone(color) {
        setSkinTone(this.skinShared, color);
        this._invalidate();
    }

    // =========================================
    // Nail material variants (one per tier define set, shared uniforms)
    // =========================================

    _nailVariant(rec, settings) {
        const key = nailVariantKey(settings);
        let m = rec.variants[key];
        if (!m) {
            m = createNailMaterial(settings, this.lighting, rec.material ? rec.material.uniforms : null);
            rec.variants[key] = m;
        }
        return m;
    }

    _applyNailVariant() {
        for (let h = 0; h < HAND_LIST.length; h++) {
            const nails = this.hands[HAND_LIST[h]].nails;
            for (let f = 0; f < FINGER_LIST.length; f++) {
                const rec = nails[FINGER_LIST[f]];
                if (!rec) continue;
                const m = this._nailVariant(rec, this.settings);
                rec.material = m;
                rec.mesh.material = m;
            }
        }
        this._invalidate();
    }

    _nextTierDown() {
        const t = this.settings.tier;
        if (t === 'high') return 'medium';
        if (t === 'medium') return 'low';
        return null;
    }

    /**
     * Warm the skin and nail variants of the next tier down at idle (the
     * current ones are compiled by the normal pre-warm), so an auto-downgrade
     * never compiles a shader and the first frames never wait for it.
     * Called once after load (main.js) and again after every tier change.
     */
    precompileVariants(renderer, scene, camera, delayMs = 3500) {
        this._warmArgs = [renderer, scene, camera];
        if (this._warmQueued) return;
        this._warmQueued = true;
        whenIdle(() => {
            this._warmQueued = false;
            const down = this._nextTierDown();
            if (!down) return;
            const s = this.settings;
            const next = computeSettings(down, 1.0, s.pixelRatio || 1, { halfFloat: true });
            const skinNext = this._skinVariant(next);
            // Programs are shared by every nail and both hands: the shown hand is enough.
            const h = this.hands[this.currentHand];
            for (const sk of h.skins) sk.mesh.material = sk[skinNext];
            for (const f of FINGER_LIST) {
                const rec = h.nails[f];
                if (rec) rec.mesh.material = this._nailVariant(rec, next);
            }
            // Nail and skin shaders do not use the scene's lights: the hand alone is enough.
            warmRender(renderer, this.group, camera);
            this._applySkinVariant();
            this._applyNailVariant();
        }, delayMs);
    }

    // =========================================
    // Loading
    // =========================================

    /**
     * Load the current hand (the other hand loads on demand, see ensureHandLoaded).
     * @param {string} shape - Nail shape to load (default: round)
     * @returns {Promise<void>}
     */
    async load(shape = NAIL_SHAPES.ROUND) {
        this.currentShape = shape;
        try {
            await this.ensureHandLoaded(this.currentHand);
            this.setupOrientation();
        } catch (error) {
            console.error('Failed to load hand model:', error);
        }
    }

    /**
     * Load a hand if it is not loaded yet. Resolves once its nails are set up.
     * @param {'left'|'right'} hand
     * @returns {Promise<void>}
     */
    ensureHandLoaded(hand) {
        if (hand !== 'left' && hand !== 'right') return Promise.resolve();
        if (this.hands[hand].model) return Promise.resolve();
        if (this._loading[hand]) return this._loading[hand];

        this._loading[hand] = modelLoader.load(modelUrl(hand)).then((model) => {
            this.hands[hand].model = model;
            model.visible = hand === this.currentHand;
            this.group.add(model);
            this.setupHandNails(hand, model);
            this._setupSkin(hand, model);
            this._computeNailFrames(hand, model);
            if (hand === this.currentHand) {
                this.setNailHighlight(this.activeNail, true);
                if (this.onHandShown) this.onHandShown(hand);
            }
            this._invalidate();
        }).catch((error) => {
            this._loading[hand] = null;
            throw error;
        });
        return this._loading[hand];
    }

    isHandLoaded(hand) {
        return !!(this.hands[hand] && this.hands[hand].model);
    }

    /**
     * Set up all nails for a specific hand
     */
    setupHandNails(hand, model) {
        for (const [finger, meshName] of Object.entries(NAIL_MESH_NAMES)) {
            const nailMesh = this.findMeshByName(model, meshName, hand);
            if (nailMesh) {
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
        if (object.name === name && object.isMesh) {
            return object;
        }
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
     * (local x -> u, local y -> v). Kept identical to the original mapping so
     * raycast UVs, canvas tools and paint agree.
     */
    generateNailUVs(geometry) {
        if (!geometry.boundingBox) {
            geometry.computeBoundingBox();
        }
        const bbox = geometry.boundingBox;
        const positions = geometry.attributes.position;
        const uvs = new Float32Array(positions.count * 2);
        const sizeX = (bbox.max.x - bbox.min.x) || 1;
        const sizeY = (bbox.max.y - bbox.min.y) || 1;
        for (let i = 0; i < positions.count; i++) {
            uvs[i * 2] = (positions.getX(i) - bbox.min.x) / sizeX;
            uvs[i * 2 + 1] = (positions.getY(i) - bbox.min.y) / sizeY;
        }
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }

    /**
     * Set up a single nail for a specific hand.
     */
    setupNailForHand(hand, finger, nailMesh) {
        const geometry = nailMesh.geometry;
        if (!geometry.attributes.uv) {
            this.generateNailUVs(geometry);
        }
        if (!geometry.boundsTree) {
            geometry.boundsTree = new MeshBVH(geometry);
        }
        if (!geometry.boundingBox) geometry.computeBoundingBox();

        const oldMaterial = nailMesh.material;
        const material = createNailMaterial(this.settings, this.lighting);
        nailMesh.material = material;
        if (oldMaterial && oldMaterial !== material) {
            if (Array.isArray(oldMaterial)) oldMaterial.forEach((m) => m.dispose());
            else oldMaterial.dispose();
        }

        const rec = new NailRecord(this, hand, finger, nailMesh, material);
        rec.variants[nailVariantKey(this.settings)] = material;
        rec.uvAspect = this._computeUVAspect(geometry);
        material.uniforms.uAspect.value = rec.uvAspect;

        this.hands[hand].nails[finger] = rec;
    }

    /**
     * Natural-nail frame in the nail's object space: centre, the axis toward
     * the cuticle, the axis across, and half extents. The UV projection is
     * not aligned with the finger on every nail, so the cuticle direction is
     * found from the skin: the finger continues past the cuticle, not past
     * the free edge.
     */
    _computeNailFrames(hand, model) {
        const nails = this.hands[hand].nails;
        let skin = null;
        model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
        model.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        const centreW = new THREE.Vector3();
        const normalW = new THREE.Vector3();
        const toBase = new THREE.Vector3();
        const inv = new THREE.Matrix4();
        const skinPts = [];
        if (skin) {
            skin.skeleton.update();
            const pos = skin.geometry.attributes.position;
            for (let i = 0; i < pos.count; i += 2) {
                skin.getVertexPosition(i, v);
                v.applyMatrix4(skin.matrixWorld);
                skinPts.push(v.x, v.y, v.z);
            }
        }
        for (const f of FINGER_LIST) {
            const rec = nails[f];
            if (!rec) continue;
            const mesh = rec.mesh;
            const geo = mesh.geometry;
            const pos = geo.attributes.position;
            const nrm = geo.attributes.normal;
            mesh.updateWorldMatrix(true, false);
            // world centre and mean normal
            centreW.set(0, 0, 0);
            normalW.set(0, 0, 0);
            const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
            const n = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
                centreW.add(v);
                if (nrm) {
                    n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
                    // nails are a thin shell: count the outer side only
                    if (n.y > 0) normalW.add(n);
                }
            }
            centreW.multiplyScalar(1 / Math.max(1, pos.count));
            if (normalW.lengthSq() < 1e-8) normalW.set(0, 1, 0);
            normalW.normalize();
            // skin within reach of the nail, projected onto the nail plane
            toBase.set(0, 0, 0);
            const R2 = 0.3 * 0.3;
            for (let i = 0; i < skinPts.length; i += 3) {
                const dx = skinPts[i] - centreW.x, dy = skinPts[i + 1] - centreW.y, dz = skinPts[i + 2] - centreW.z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > R2) continue;
                toBase.x += dx; toBase.y += dy; toBase.z += dz;
            }
            toBase.addScaledVector(normalW, -toBase.dot(normalW));
            if (toBase.lengthSq() < 1e-10) toBase.set(1, 0, 0).addScaledVector(normalW, -normalW.x);
            toBase.normalize();
            // into object space
            inv.copy(mesh.matrixWorld).invert();
            const axis = toBase.clone().transformDirection(inv);
            const cLocal = centreW.clone().applyMatrix4(inv);
            const nLocal = normalW.clone().transformDirection(inv);
            const side = new THREE.Vector3().crossVectors(nLocal, axis).normalize();
            let halfL = 0, halfW = 0;
            for (let i = 0; i < pos.count; i++) {
                v.fromBufferAttribute(pos, i).sub(cLocal);
                halfL = Math.max(halfL, Math.abs(v.dot(axis)));
                halfW = Math.max(halfW, Math.abs(v.dot(side)));
            }
            const u = rec.material.uniforms;
            u.uNailCentre.value.copy(cLocal);
            u.uNailAxis.value.copy(axis);
            u.uNailSide.value.copy(side);
            u.uNailHalf.value.set(halfL || 1, halfW || 1);
        }
    }

    /**
     * World length of one unit of u over one unit of v, as the area-weighted
     * mean of |dP/du| / |dP/dv| over the nail's triangles. (The bounding-box
     * ratio is wrong on curved nails: the thumb read 1.62 instead of ~1.2,
     * which made dabs visibly oval.) Uniform mesh scale cancels out.
     */
    _computeUVAspect(geometry) {
        const pos = geometry.attributes.position;
        const uv = geometry.attributes.uv;
        if (!pos || !uv) return 1;
        const index = geometry.index;
        const triCount = Math.floor((index ? index.count : pos.count) / 3);
        let weight = 0;
        let sum = 0;
        for (let t = 0; t < triCount; t++) {
            const a = index ? index.getX(t * 3) : t * 3;
            const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
            const e1x = pos.getX(b) - pos.getX(a), e1y = pos.getY(b) - pos.getY(a), e1z = pos.getZ(b) - pos.getZ(a);
            const e2x = pos.getX(c) - pos.getX(a), e2y = pos.getY(c) - pos.getY(a), e2z = pos.getZ(c) - pos.getZ(a);
            const du1 = uv.getX(b) - uv.getX(a), dv1 = uv.getY(b) - uv.getY(a);
            const du2 = uv.getX(c) - uv.getX(a), dv2 = uv.getY(c) - uv.getY(a);
            const det = du1 * dv2 - du2 * dv1;
            if (Math.abs(det) < 1e-12) continue;
            const pux = (e1x * dv2 - e2x * dv1) / det, puy = (e1y * dv2 - e2y * dv1) / det, puz = (e1z * dv2 - e2z * dv1) / det;
            const pvx = (e2x * du1 - e1x * du2) / det, pvy = (e2y * du1 - e1y * du2) / det, pvz = (e2z * du1 - e1z * du2) / det;
            const lu = Math.sqrt(pux * pux + puy * puy + puz * puz);
            const lv = Math.sqrt(pvx * pvx + pvy * pvy + pvz * pvz);
            if (lv < 1e-12) continue;
            const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
            const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
            weight += area;
            sum += area * (lu / lv);
        }
        return weight > 0 ? sum / weight : 1;
    }

    /**
     * Set up hand orientation and position
     */
    setupOrientation() {
        // Looking down at the back of the hand (nail side up), fingers pointing away
        this.group.rotation.set(0, Math.PI, 0);
        this.group.position.set(0, -1, 0);
        this.group.scale.setScalar(1.0);
    }

    // =========================================
    // Lazy per-nail resources
    // =========================================

    _ensureDeco(rec) {
        if (rec._canvas) return;
        const res = this.settings.decoCanvasRes || DECO_DESIGN_RES;
        const canvas = document.createElement('canvas');
        canvas.width = res;
        canvas.height = res;
        const ctx = canvas.getContext('2d');
        const scale = res / DECO_DESIGN_RES;
        // Tools hard-code 1024 coordinates; pre-scale smaller canvases.
        if (scale !== 1) ctx.setTransform(scale, 0, 0, scale, 0, 0);

        const texture = new THREE.CanvasTexture(canvas);
        texture.name = 'NailDeco';
        texture.flipY = false;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.premultiplyAlpha = true;

        rec._canvas = canvas;
        rec._ctx = ctx;
        rec._texture = texture;
        rec._decoScale = scale;
        rec.material.uniforms.uDecoMap.value = texture;
        rec.material.uniforms.uHasDeco.value = 1;
        this._invalidate();
    }

    _clearTarget(target) {
        const renderer = this.renderer;
        if (!renderer || !target) return;
        const prevTarget = renderer.getRenderTarget();
        const prevAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this._clearColor);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.setClearColor(this._clearColor, prevAlpha);
        renderer.setRenderTarget(prevTarget);
    }

    _createPaintTarget(res) {
        const target = new THREE.WebGLRenderTarget(res, res, {
            type: THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false,
        });
        target.texture.name = 'BakedPaint';
        this._clearTarget(target);
        return target;
    }

    /**
     * The nail's baked paint render target (lazy).
     */
    getPaintTarget(hand, finger, create = true) {
        const rec = this.getNail(hand, finger);
        if (!rec) return null;
        if (!rec.paintTarget && create) {
            rec.paintTarget = this._createPaintTarget(this.settings.bakedPaintRes || 512);
        }
        return rec.paintTarget;
    }

    /**
     * Re-create baked targets at a new resolution, preserving their content.
     * @param {number} res
     * @param {(src: THREE.Texture, dst: THREE.WebGLRenderTarget) => void} blit
     */
    resizePaintTargets(res, blit) {
        for (let h = 0; h < HAND_LIST.length; h++) {
            const nails = this.hands[HAND_LIST[h]].nails;
            for (let f = 0; f < FINGER_LIST.length; f++) {
                const rec = nails[FINGER_LIST[f]];
                if (!rec || !rec.paintTarget || rec.paintTarget.width === res) continue;
                const old = rec.paintTarget;
                const next = this._createPaintTarget(res);
                if (blit) blit(old.texture, next);
                rec.paintTarget = next;
                if (rec.material.uniforms.uPaintMap.value === old.texture) {
                    rec.material.uniforms.uPaintMap.value = next.texture;
                }
                old.dispose();
            }
        }
        this._invalidate();
    }

    /**
     * Point the nail shader's uPaintMap at a texture (null hides paint).
     */
    setPaintTexture(hand, finger, texture) {
        const rec = this.getNail(hand, finger);
        if (!rec) return;
        const u = rec.material.uniforms;
        if (u.uPaintMap.value === texture) return;
        u.uPaintMap.value = texture;
        u.uHasPaint.value = texture ? 1 : 0;
        const img = texture && texture.image;
        if (img && img.width) u.uPaintTexel.value = 1 / img.width;
        this._invalidate();
    }

    /**
     * Clear the baked paint and reset coverage. Never touches decorations.
     */
    clearPaint(hand, finger) {
        const rec = this.getNail(hand, finger);
        if (!rec) return;
        if (rec.paintTarget) this._clearTarget(rec.paintTarget);
        rec.coverage = 0;
        this._invalidate();
    }

    /** 0 = cured, 1 = wet. */
    setWetness(hand, finger, w) {
        const rec = this.getNail(hand, finger);
        if (!rec) return;
        rec.material.uniforms.uWet.value = w;
        this._invalidate();
    }

    /** 0..1 sparkle sweep used by the reveal. */
    setRevealPulse(hand, finger, x) {
        const rec = this.getNail(hand, finger);
        if (!rec) return;
        rec.material.uniforms.uRevealPulse.value = x;
        this._invalidate();
    }

    /** Nail width / length in world units (u extent / v extent), for round splats. */
    getUVAspect(hand, finger) {
        const rec = this.getNail(hand, finger);
        return rec ? rec.uvAspect : 1;
    }

    /**
     * 32x32 Uint8Array: 1 where the UV cell has nail geometry. Built once from
     * the triangles (rasterised on the CPU), then cached.
     */
    getNailMask(hand, finger) {
        const rec = this.getNail(hand, finger);
        if (!rec) return null;
        if (!rec._nailMask) rec._nailMask = this._buildNailMask(rec.mesh.geometry);
        return rec._nailMask;
    }

    _buildNailMask(geometry) {
        const N = MASK_RES;
        const mask = new Uint8Array(N * N);
        const uv = geometry.attributes.uv;
        if (!uv) return mask;
        const index = geometry.index;
        const triCount = Math.floor((index ? index.count : uv.count) / 3);
        const cell = (v) => Math.min(N - 1, Math.max(0, Math.floor(v)));
        for (let t = 0; t < triCount; t++) {
            const ia = index ? index.getX(t * 3) : t * 3;
            const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
            const ax = uv.getX(ia) * N, ay = uv.getY(ia) * N;
            const bx = uv.getX(ib) * N, by = uv.getY(ib) * N;
            const cx = uv.getX(ic) * N, cy = uv.getY(ic) * N;
            // Vertices always mark their own cell, so tiny triangles count.
            mask[cell(ay) * N + cell(ax)] = 1;
            mask[cell(by) * N + cell(bx)] = 1;
            mask[cell(cy) * N + cell(cx)] = 1;
            const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            if (Math.abs(area) < 1e-12) continue;
            const x0 = cell(Math.min(ax, bx, cx)), x1 = cell(Math.max(ax, bx, cx));
            const y0 = cell(Math.min(ay, by, cy)), y1 = cell(Math.max(ay, by, cy));
            for (let y = y0; y <= y1; y++) {
                const py = y + 0.5;
                for (let x = x0; x <= x1; x++) {
                    const px = x + 0.5;
                    const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
                    const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
                    if (w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0) mask[y * N + x] = 1;
                }
            }
        }
        return mask;
    }

    /** The nail record for a hand/finger. */
    getNail(hand, finger) {
        const h = this.hands[hand];
        return h ? (h.nails[finger] || null) : null;
    }

    /** Iterate the loaded nails of one hand: fn(record, finger). */
    forEachNail(hand, fn) {
        const h = this.hands[hand];
        if (!h) return;
        for (let i = 0; i < FINGER_LIST.length; i++) {
            const rec = h.nails[FINGER_LIST[i]];
            if (rec) fn(rec, FINGER_LIST[i]);
        }
    }

    // =========================================
    // Hand Switching Methods
    // =========================================

    /**
     * Switch between left and right hand (loads the hand first if needed).
     * @param {string} hand - 'left' or 'right'
     * @returns {Promise<boolean>} whether the hand changed
     */
    switchHand(hand) {
        if (hand !== 'left' && hand !== 'right') {
            console.warn(`Invalid hand: ${hand}`);
            return Promise.resolve(false);
        }
        if (hand === this.currentHand) return Promise.resolve(false);
        if (!this.hands[hand].model) {
            return this.ensureHandLoaded(hand).then(() => this._swapHand(hand));
        }
        return Promise.resolve(this._swapHand(hand));
    }

    _swapHand(hand) {
        if (hand === this.currentHand) return false;
        const prev = this.hands[this.currentHand];
        this.setNailHighlight(this.activeNail, false);
        if (prev.model) prev.model.visible = false;
        if (this.hands[hand].model) this.hands[hand].model.visible = true;
        this.currentHand = hand;
        this.setNailHighlight(this.activeNail, true);
        if (this.onHandShown) this.onHandShown(hand);
        this._invalidate();
        return true;
    }

    getCurrentHand() {
        return this.currentHand;
    }

    // =========================================
    // NailModel Interface Methods
    // =========================================

    getMesh() {
        return this.group;
    }

    /** The currently active nail mesh (for tools raycasting) */
    getNailMesh() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.mesh : null;
    }

    /** All nail meshes of the current hand (for selection raycasting) */
    getNailMeshes() {
        return Object.values(this.nails).map(n => n.mesh);
    }

    /** Drawing context for the active nail (created on first use) */
    getDrawingContext() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.ctx : null;
    }

    /** Drawing texture for the active nail (created on first use) */
    getDrawingTexture() {
        const nail = this.nails[this.activeNail];
        return nail ? nail.texture : null;
    }

    /** Upload the active nail's drawing canvas on the next frame */
    updateDrawingTexture() {
        const nail = this.nails[this.activeNail];
        if (nail && nail._texture) {
            nail._texture.needsUpdate = true;
            this._invalidate();
        }
    }

    _clearDeco(nail) {
        if (!nail || !nail._ctx) return;
        const ctx = nail._ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, nail._canvas.width, nail._canvas.height);
        ctx.restore();
        nail._texture.needsUpdate = true;
    }

    /** Clear drawing on the active nail (decorations only, never paint) */
    clearDrawing() {
        this._clearDeco(this.nails[this.activeNail]);
        this._invalidate();
    }

    /** Clear drawing on all nails of the current hand */
    clearAllDrawings() {
        for (const nail of Object.values(this.nails)) this._clearDeco(nail);
        this._invalidate();
    }

    // =========================================
    // Nail Selection Methods
    // =========================================

    setActiveNail(finger) {
        if (!this.nails[finger]) {
            console.warn(`Unknown finger: ${finger}`);
            return;
        }
        this.setNailHighlight(this.activeNail, false);
        this.activeNail = finger;
        this.setNailHighlight(finger, true);
        this._invalidate();
    }

    getActiveNail() {
        return this.activeNail;
    }

    getFingerFromMesh(mesh) {
        for (const [finger, nail] of Object.entries(this.nails)) {
            if (nail.mesh === mesh) return finger;
        }
        return null;
    }

    /**
     * World position of a nail's visible surface centre.
     * @param {string} finger
     * @param {THREE.Vector3} [target]
     * @returns {THREE.Vector3|null}
     */
    getNailWorldPosition(finger, target = new THREE.Vector3()) {
        const nail = this.nails[finger];
        if (!nail || !nail.mesh) return null;
        const mesh = nail.mesh;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bbox = mesh.geometry.boundingBox;
        target.set(
            (bbox.min.x + bbox.max.x) / 2,
            bbox.max.y,
            (bbox.min.z + bbox.max.z) / 2
        );
        mesh.updateWorldMatrix(true, false);
        return target.applyMatrix4(mesh.matrixWorld);
    }

    getActiveNailWorldPosition() {
        return this.getNailWorldPosition(this.activeNail);
    }

    /** Selection highlight (uniform only, no recompile) */
    setNailHighlight(finger, highlighted) {
        const nail = this.nails[finger];
        if (!nail || !nail.material) return;
        nail.material.uniforms.uHighlight.value = highlighted ? 1 : 0;
    }

    // =========================================
    // Polish & Finish Methods
    // =========================================

    /** Legacy solid colour under the paint, on the active nail */
    setPolishColor(color) {
        const nail = this.nails[this.activeNail];
        if (!nail) return;
        const u = nail.material.uniforms;
        u.uUnderColor.value.set(color);
        u.uUnderAmount.value = 1;
        nail.polishColor = u.uUnderColor.value;
        this._invalidate();
    }

    /** Remove the legacy solid colour from the active nail */
    clearPolish() {
        const nail = this.nails[this.activeNail];
        if (!nail) return;
        nail.material.uniforms.uUnderAmount.value = 0;
        nail.polishColor = null;
        this._invalidate();
    }

    /**
     * Set finish type.
     * @param {'glossy'|'matte'|'shimmer'|'chrome'|'holographic'} type
     * @param {string} [hand] defaults to the current hand
     * @param {string} [finger] defaults to the active nail
     */
    setFinish(type, hand = this.currentHand, finger = this.activeNail) {
        const nail = this.getNail(hand, finger);
        if (!nail) return;
        nail.finish = type;
        applyNailFinish(nail.material, type);
        this._invalidate();
    }

    // =========================================
    // Shape Methods
    // =========================================

    /**
     * Save nail state (legacy polish, finish, drawings) for all loaded nails.
     * Drawings are copied canvas-to-canvas (no readback). Only used by setShape.
     */
    saveNailState() {
        const state = { left: {}, right: {} };
        for (const hand of HAND_LIST) {
            for (const [finger, nail] of Object.entries(this.hands[hand].nails)) {
                state[hand][finger] = {
                    polishColor: nail.polishColor ? nail.polishColor.clone() : null,
                    finish: nail.finish,
                    canvasData: nail.hasDeco ? this._copyCanvas(nail._canvas) : null
                };
            }
        }
        return state;
    }

    _copyCanvas(src) {
        const c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        c.getContext('2d').drawImage(src, 0, 0);
        return c;
    }

    _drawSaved(nail, image) {
        const ctx = nail.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(image, 0, 0, nail._canvas.width, nail._canvas.height);
        ctx.restore();
        nail._texture.needsUpdate = true;
        this._invalidate();
    }

    restoreNailState(state) {
        const originalHand = this.currentHand;
        const originalNail = this.activeNail;

        for (const hand of HAND_LIST) {
            for (const [finger, saved] of Object.entries(state[hand] || {})) {
                const nail = this.hands[hand].nails[finger];
                if (!nail) continue;
                this.currentHand = hand;
                this.activeNail = finger;
                if (saved.polishColor) this.setPolishColor(saved.polishColor);
                if (saved.finish) this.setFinish(saved.finish, hand, finger);
                const data = saved.canvasData;
                if (data && typeof data === 'object' && data.getContext) {
                    this._drawSaved(nail, data);
                } else if (typeof data === 'string' && data !== 'data:,') {
                    // Older saves stored a data URL.
                    const img = new Image();
                    img.onload = () => this._drawSaved(nail, img);
                    img.src = data;
                }
            }
        }

        this.currentHand = originalHand;
        this.activeNail = originalNail;
    }

    /**
     * Set nail shape. Only 'round' has a model today, so this only reports
     * availability; the reload path is kept for when shape GLBs exist.
     * @param {string} shape - One of NAIL_SHAPES values
     * @returns {Promise<boolean>} Whether shape was changed
     */
    async setShape(shape) {
        if (shape === this.currentShape) return false;
        if (!Object.values(NAIL_SHAPES).includes(shape)) {
            console.warn(`Invalid shape: ${shape}`);
            return false;
        }
        if (!this.isShapeAvailable(shape)) return false;

        const savedState = this.saveNailState();
        const hand = this.currentHand;
        for (const h of HAND_LIST) {
            const model = this.hands[h].model;
            for (const nail of Object.values(this.hands[h].nails)) {
                if (nail.paintTarget) nail.paintTarget.dispose();
                if (nail._texture) nail._texture.dispose();
            }
            if (model) {
                this.group.remove(model);
                this.disposeModel(model);
            }
            for (const sk of this.hands[h].skins) { sk.lite.dispose(); sk.full.dispose(); }
            for (const nail of Object.values(this.hands[h].nails)) {
                for (const k in nail.variants) if (nail.variants[k] !== nail.material) nail.variants[k].dispose();
            }
            this.hands[h].model = null;
            this.hands[h].nails = {};
            this.hands[h].skins = [];
            this._loading[h] = null;
        }
        this.currentShape = shape;
        await this.ensureHandLoaded(hand);
        this.restoreNailState(savedState);
        this.setNailHighlight(this.activeNail, true);
        this._invalidate();
        return true;
    }

    isShapeAvailable(shape) {
        return shape === NAIL_SHAPES.ROUND;
    }

    /** Dispose of a model's geometry and materials */
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

    getShape() {
        return this.currentShape;
    }

    /** Not applicable for HandModel */
    setFingerType() {}

    // =========================================
    // Overlay Methods: no-ops. The overlay mesh is gone; paint and deco are
    // layers inside the nail shader.
    // =========================================

    setOverlayTexture() {}

    setOverlayVisible() {}
}
