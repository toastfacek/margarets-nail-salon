/**
 * NailScene.js
 * Three.js scene, camera, renderer, the salon (environment map, lights,
 * backdrop, desk, contact shadow) and orbit controls.
 *
 * NailScene no longer owns a requestAnimationFrame: the app's FrameLoop calls
 * `update(dt)` (camera animation, controls, room visibility) and `render()`.
 *
 * The salon is built in the constructor; `attachHand(handModel)` (called by
 * src/features/salon.feature.js once the hand is loaded) places the desk under
 * the hand and bakes its contact shadow.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createNailLighting } from './NailMaterial.js';
import { CONTEXT_ATTRIBUTES } from '../core/Quality.js';
import { SalonEnvironment, RIG } from './SalonEnvironment.js';
import { Backdrop } from './Backdrop.js';
import { ContactShadow } from './ContactShadow.js';
import { whenIdle, warmRender } from './Warmup.js';

const DEFAULT_SETTINGS = Object.freeze({
    antialias: true, pixelRatio: 1, rimLight: false, tier: 'medium',
    envCubeRes: 128, envCubeType: THREE.HalfFloatType,
});

// Light intensities at dim = 1 (setDim lerps toward a darker room).
const HEMI_INTENSITY = 0.85;
const KEY_INTENSITY = 1.2;
const RIM_INTENSITY = 0.55;
// Focused nail: its larger side fills this share of the viewport's short side.
// A close-up, like the owner's reference (brush plan B6): bigger on touch
// screens, where the fingertip covers part of the nail.
const FOCUS_FILL = 0.42;
const FOCUS_FILL_COARSE = 0.46;
const COARSE = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
// The idle warm-up of other-tier variants starts this long after load.
const WARM_DELAY_MS = 3500;

export class NailScene {
    /**
     * @param {HTMLElement} container
     * @param {{ settings?: object, invalidate?: () => void, probeContext?: {canvas: HTMLCanvasElement, context: WebGL2RenderingContext} }} [opts]
     */
    constructor(container, { settings = null, invalidate = null, probeContext = null } = {}) {
        this.container = container;
        this.width = container.clientWidth;
        this.height = container.clientHeight;
        this.settings = settings || DEFAULT_SETTINGS;
        this.invalidate = invalidate || (() => {});
        this.probeContext = probeContext;

        // Camera animation state
        this.isAnimating = false;
        this.animationProgress = 0;
        this.animationDuration = 0.5; // seconds
        this.startCameraPos = new THREE.Vector3();
        this.targetCameraPos = new THREE.Vector3();
        this.startTarget = new THREE.Vector3();
        this.targetTarget = new THREE.Vector3();

        // Default camera state - frontal view looking down at nail
        this.defaultCameraPos = new THREE.Vector3(0, 1.5, 0.3);
        this.defaultTarget = new THREE.Vector3(0, 0, 0);

        // Zoom state
        this.isZoomedIn = false;
        this.zoomedFinger = null;
        this.isCameraLocked = false;
        this.contextLost = false;
        this.onContextRestored = null;

        // Lighting uniforms shared by every nail material.
        this.nailLighting = createNailLighting();

        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();
        this._camDir = new THREE.Vector3();

        this.dim = 1;
        this.handModel = null;
        this.contactShadow = null;
        this._focusPos = new THREE.Vector3();
        this._box = new THREE.Box3();
        this._warmQueued = false;
        this.cameraHeld = false;

        this.init();
        this.setupLighting();
        this.setupSalon();
        this.setupControls();

        this._onResize = () => this.onResize();
        window.addEventListener('resize', this._onResize);
    }

    init() {
        this.scene = new THREE.Scene();

        // The backdrop is a far-plane triangle (Backdrop.js); the clear colour
        // only shows for a frame before the salon exists.
        this.scene.background = null;
        this.clearColor = new THREE.Color(0xDCD0E4);

        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
        this.camera.position.set(0, 1.5, 0.3);
        this.camera.lookAt(0, 0, 0);

        const s = this.settings;
        // Reuse the quality probe's context when it fits (no antialias), else
        // create one with the same opaque attributes.
        let canvas = null;
        let context = null;
        const probe = this.probeContext;
        if (probe && !s.antialias) {
            canvas = probe.canvas;
            context = probe.context;
        } else {
            canvas = document.createElement('canvas');
            context = canvas.getContext('webgl2', Object.assign({}, CONTEXT_ATTRIBUTES, { antialias: !!s.antialias }));
            if (!context) canvas = null; // let three.js report the failure its own way
        }
        this.renderer = new THREE.WebGLRenderer({
            antialias: !!s.antialias,
            alpha: false,
            powerPreference: 'high-performance',
            canvas: canvas || undefined,
            context,
        });
        this.renderer.setPixelRatio(s.pixelRatio || 1);
        this.renderer.setSize(this.width, this.height);
        this.renderer.shadowMap.enabled = false;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.renderer.setClearColor(this.clearColor, 1);

        // SwiftShader (and some drivers) lack KHR_parallel_shader_compile, so
        // compileAsync resolves before anything is really compiled and the
        // GPU process compiles each program at its first draw, after __ready
        // (stalling the intro stroke). Finish the job inside it: draw every
        // object of the scene once, hidden and off-screen ones included, into
        // one pixel, then wait for the GPU. With the extension this is cheap.
        const renderer = this.renderer;
        const compileAsync = renderer.compileAsync.bind(renderer);
        renderer.compileAsync = (scene, camera, targetScene) => compileAsync(scene, camera, targetScene).then((res) => {
            if (scene === this.scene && !this.contextLost) {
                this._warmEverything();
            }
            return res;
        });

        const el = this.renderer.domElement;
        // Deferred warm-ups wait while a finger or the mouse is down.
        this.pointerDown = false;
        el.addEventListener('pointerdown', () => { this.pointerDown = true; });
        window.addEventListener('pointerup', () => { this.pointerDown = false; });
        window.addEventListener('pointercancel', () => { this.pointerDown = false; });
        el.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            this.contextLost = true;
        });
        el.addEventListener('webglcontextrestored', () => {
            this.contextLost = false;
            // three.js rebuilds its GL state on restore; put our clear colour back.
            this.renderer.setClearColor(this.clearColor, 1);
            // Baked render targets lost their pixels with the context: re-bake.
            try { this._rebakeSalon(); } catch (err) { /* the salon stays plain; never crash */ }
            if (this.onContextRestored) this.onContextRestored();
            this.invalidate();
        });

        this.container.appendChild(el);
    }

    setupLighting() {
        // Budget (plan 1.3): 1 hemisphere + 1 directional (+1 rim on high), no shadows.
        // Cream sky, rose ground; a warm key aligned with the env ring light.
        this.hemiLight = new THREE.HemisphereLight(0xfff1e6, 0xf2b3c4, HEMI_INTENSITY);
        this.scene.add(this.hemiLight);

        this.keyLight = new THREE.DirectionalLight(0xfff0e0, KEY_INTENSITY);
        this.keyLight.position.copy(RIG.keyDir).multiplyScalar(5);
        this.scene.add(this.keyLight);

        // The rim light only exists when the session starts on high. Lower
        // tiers never add it, and a downgrade sets its intensity to 0 so the
        // skin program never recompiles.
        this.rimLight = null;
        if (this.settings.rimLight) {
            this.rimLight = new THREE.DirectionalLight(0xbfd4ff, RIM_INTENSITY);
            this.rimLight.position.copy(RIG.rimDir).multiplyScalar(5);
            this.scene.add(this.rimLight);
        }

        // The nail shader uses the same key direction (and the rim on high).
        this.nailLighting.uLightDir.value.copy(RIG.keyDir);
        this._applyRim();
    }

    _applyRim() {
        const on = !!(this.rimLight && this.settings.rimLight);
        if (this.rimLight) this.rimLight.intensity = on ? RIM_INTENSITY * this.dim : 0;
        this.nailLighting.uRimColor.value.setRGB(0.55, 0.62, 0.8).multiplyScalar(on ? 0.35 : 0);
        const skin = this.handModel && this.handModel.skinShared;
        if (skin) {
            skin.uRimColor.value.setRGB(0.55, 0.62, 0.8).multiplyScalar(on ? 0.22 * this.dim : 0);
            skin.uDim.value = 0.25 + 0.75 * this.dim;
        }
    }

    /**
     * Environment map, backdrop and desk. One-time cost, before the pre-warm.
     */
    setupSalon() {
        const s = this.settings;
        this.environment = new SalonEnvironment(this.renderer, s);
        const L = this.nailLighting;
        L.uEnvMap.value = this.environment.texture;
        L.uHasEnv.value = this.environment.texture ? 1 : 0;
        L.uEnvScale.value = this.environment.envScale;
        L.uEnvMaxLod.value = Math.log2(s.envCubeRes || 128);

        this.backdrop = new Backdrop(this.renderer, s);
        this.scene.add(this.backdrop.mesh);
        this.scene.add(this.backdrop.desk);
        this.scene.add(this.backdrop.roll);
        // The desk is baked (and shown) once a hand is attached.
        this.renderer.setRenderTarget(null);
    }

    _rebakeSalon() {
        if (!this.environment) return;
        this.environment.dispose();
        this.environment = new SalonEnvironment(this.renderer, this.settings);
        this.nailLighting.uEnvMap.value = this.environment.texture;
        this.nailLighting.uHasEnv.value = this.environment.texture ? 1 : 0;
        this.nailLighting.uEnvScale.value = this.environment.envScale;
        this.backdrop.rebake();
    }

    /**
     * Where the forearm dips under the desk, lay a rolled towel across it, so
     * the arm rests on the roll instead of ending in the towel.
     */
    _findWristRoll(pts, deskY, hm) {
        // submerged forearm centroid
        let sx = 0, sz = 0, sn = 0;
        for (let i = 0; i < pts.length; i += 3) {
            if (pts[i + 1] < deskY - 0.02) { sx += pts[i]; sz += pts[i + 2]; sn++; }
        }
        if (sn < 20) return null;
        sx /= sn; sz /= sn;
        // nail centroid
        let nx = 0, nz = 0, nn = 0;
        const p = new THREE.Vector3();
        hm.forEachNail(hm.getCurrentHand(), (rec, finger) => {
            if (hm.getNailWorldPosition(finger, p)) { nx += p.x; nz += p.z; nn++; }
        });
        if (!nn) return null;
        nx /= nn; nz /= nn;
        let ax = nx - sx, az = nz - sz;
        const len = Math.hypot(ax, az) || 1;
        ax /= len; az /= len;
        // Slice the arm along its axis; the cut is where the whole slice
        // (its top too) is under the desk. Lay the roll over that line.
        const BINS = 64;
        let t0 = Infinity, t1 = -Infinity;
        for (let i = 0; i < pts.length; i += 3) {
            const t = (pts[i] - sx) * ax + (pts[i + 2] - sz) * az;
            if (t < t0) t0 = t;
            if (t > t1) t1 = t;
        }
        const maxY = new Float32Array(BINS).fill(-Infinity);
        const binOf = (t) => Math.min(BINS - 1, Math.max(0, Math.floor((t - t0) / (t1 - t0) * BINS)));
        for (let i = 0; i < pts.length; i += 3) {
            const t = (pts[i] - sx) * ax + (pts[i + 2] - sz) * az;
            const b = binOf(t);
            if (pts[i + 1] > maxY[b]) maxY[b] = pts[i + 1];
        }
        let cutBin = -1;
        for (let b = 0; b < BINS; b++) {
            if (maxY[b] > -Infinity && maxY[b] < deskY) cutBin = b;
        }
        if (cutBin < 0) return null;
        const tCut = t0 + (cutBin + 1) / BINS * (t1 - t0);
        let wMin = Infinity, wMax = -Infinity;
        for (let i = 0; i < pts.length; i += 3) {
            const dx = pts[i] - sx, dz = pts[i + 2] - sz;
            const tt = dx * ax + dz * az;
            if (Math.abs(tt - tCut) < 0.15 && pts[i + 1] > deskY - 0.3) {
                const w = -dx * az + dz * ax;
                wMin = Math.min(wMin, w);
                wMax = Math.max(wMax, w);
            }
        }
        const t = tCut + 0.02;
        const wc = isFinite(wMin) ? (wMin + wMax) / 2 : 0;
        const halfLength = Math.max(0.45, (isFinite(wMin) ? (wMax - wMin) / 2 : 0.3) + 0.45);
        return {
            x: sx + ax * t - az * wc,
            z: sz + az * t + ax * wc,
            dirX: -az, dirZ: ax,
            halfLength,
            radius: 0.15,
        };
    }

    /**
     * Put the desk under a loaded hand, bake its contact shadow, frame the
     * zoomed-out view on it, and re-bake whenever the shown hand changes.
     * @param {import('./HandModel.js').HandModel} handModel
     */
    attachHand(handModel) {
        this.handModel = handModel;
        this._applyRim();
        if (!this.contactShadow) this.contactShadow = new ContactShadow();
        this._bakeHand();
        handModel.onHandShown = () => this._bakeHand();
    }

    _bakeHand() {
        const hm = this.handModel;
        if (!hm) return;
        const hand = hm.hands[hm.getCurrentHand()];
        if (!hand || !hand.model) return;
        const sample = ContactShadow.sampleHand(hand.model, 2);
        const b = sample.bounds;
        if (b.isEmpty()) return;

        // Desk just under the lowest nail: the palm and thumb rest on it, the
        // fingers float a little above, the forearm dips under the towel.
        let minNailY = Infinity;
        const p = this._camDir;
        hm.forEachNail(hm.getCurrentHand(), (rec, finger) => {
            const wp = hm.getNailWorldPosition(finger, p);
            if (wp && wp.y < minNailY) minNailY = wp.y;
        });
        if (!isFinite(minNailY)) minNailY = b.max.y - 0.3;
        const deskY = minNailY - 0.1;

        // Footprint of what is above the desk.
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        const pts = sample.points;
        for (let i = 0; i < pts.length; i += 3) {
            if (pts[i + 1] < deskY - 0.02) continue;
            const x = pts[i], z = pts[i + 2];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (z < z0) z0 = z;
            if (z > z1) z1 = z;
        }
        if (!isFinite(x0)) { x0 = b.min.x; x1 = b.max.x; z0 = b.min.z; z1 = b.max.z; }
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;

        this.contactShadow.bake({ deskY, sample });
        this.backdrop.bakeDesk({
            deskY, centreX: cx, centreZ: cz,
            towelHalfX: Math.max(1.2, (x1 - x0) / 2 + 0.75),
            towelHalfZ: Math.max(0.9, (z1 - z0) / 2 + 0.55),
            roll: this._findWristRoll(pts, deskY, hm),
        }, this.contactShadow, RIG.keyDir);

        // The zoomed-out view frames the hand from above.
        this.defaultTarget.set(cx, deskY + 0.15, cz);
        this.defaultCameraPos.set(cx, deskY + 2.4, cz + 0.55);
        this.invalidate();
    }

    setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;
        this.controls.minPolarAngle = 0;
        // Never orbit under the desk.
        this.controls.maxPolarAngle = Math.PI * 0.47;
        this.controls.minAzimuthAngle = -Infinity;
        this.controls.maxAzimuthAngle = Infinity;
        this.controls.enablePan = false;
        this.controls.touches = {
            ONE: THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_ROTATE
        };
        this.controls.addEventListener('change', () => this.invalidate());
    }

    /**
     * React to a quality change (pixel ratio, rim light). Antialias is fixed at
     * context creation and does not change.
     */
    setQuality(settings) {
        this.settings = settings;
        this.renderer.setPixelRatio(settings.pixelRatio || 1);
        this.renderer.setSize(this.width, this.height);
        this._applyRim();
        // The environment cube keeps what it baked at load; the desk switches
        // between its per-pixel and per-vertex variants.
        if (this.backdrop) this.backdrop.setQuality(settings);
        this.invalidate();
        // The next tier down may come later: warm its variants at idle.
        this.precompileVariants(1500);
    }

    /**
     * At idle (never during a stroke or a camera move), bake the room and
     * compile what the current view does not use, one small task each:
     *   - the room dome (orbit views),
     *   - the wrist roll (zoomed-out views),
     *   - the lite desk, only when the next tier down is low.
     * Each task draws just its object into one pixel.
     */
    precompileVariants(delayMs = WARM_DELAY_MS) {
        if (!this.backdrop || this._warmQueued) return;
        this._warmQueued = true;
        const bd = this.backdrop;
        const r = this.renderer;
        whenIdle(() => {
            this._warmQueued = false;
            if (this.contextLost || bd.roomReady) return;
            bd.bakeRoom();
            const vis = bd.mesh.visible;
            bd.mesh.visible = true;
            warmRender(r, bd.mesh, this.camera);
            bd.mesh.visible = vis;
            this.invalidate();
        }, delayMs);
        whenIdle(() => {
            if (this.contextLost || bd.rollReady || !bd.roll.geometry.attributes.position) return;
            bd.roll.visible = true;
            bd.rollReady = true;
            // Lambert needs the scene's lights, so the whole scene; the roll is
            // usually off screen, so skip its culling for this one draw.
            bd.roll.frustumCulled = false;
            warmRender(r, this.scene, this.camera);
            bd.roll.frustumCulled = true;
            this.invalidate();
        }, delayMs + 600);
        if (this.settings.tier === 'medium') {
            whenIdle(() => {
                if (this.contextLost || bd.deskLite.visible) return;
                bd.deskLite.visible = true;
                warmRender(r, bd.deskLite, this.camera);
                bd.deskLite.visible = false;
                this.invalidate();
            }, delayMs + 1200);
        }
    }

    _warmEverything() {
        const saved = [];
        // The starting tier's visible scene only: hidden variants (the other
        // desk, the room dome, the roll) are left to the idle warm-ups.
        this.scene.traverse((o) => {
            saved.push(o, o.visible, o.frustumCulled);
            o.frustumCulled = false;
        });
        try {
            warmRender(this.renderer, this.scene, this.camera);
        } catch (err) {
            // a warm-up only
        }
        for (let i = 0; i < saved.length; i += 3) {
            saved[i].visible = saved[i + 1];
            saved[i].frustumCulled = saved[i + 2];
        }
        this.invalidate();
    }

    /**
     * The camera belongs to someone else (the Slay reveal): while held, a
     * resize no longer snaps the camera back to the focused nail.
     * @param {boolean} hold
     */
    holdCamera(hold) {
        this.cameraHeld = !!hold;
    }

    /**
     * Dim the salon for the reveal: 1 = normal, 0 = dark. The nails keep their
     * own light, so the polish stays the brightest thing on screen.
     * Uniform and intensity writes only.
     */
    setDim(x) {
        const d = Math.max(0, Math.min(1, x));
        this.dim = d;
        const k = 0.25 + 0.75 * d;
        this.hemiLight.intensity = HEMI_INTENSITY * k;
        this.keyLight.intensity = KEY_INTENSITY * k;
        this._applyRim();
        if (this.backdrop) this.backdrop.setDim(0.3 + 0.7 * d);
        this.invalidate();
    }

    /** Texture memory held by the salon (bytes), for budgets and the hand-off. */
    getSalonGpuBytes() {
        return (this.environment ? this.environment.gpuBytes : 0)
            + (this.backdrop ? this.backdrop.gpuBytes : 0)
            + (this.contactShadow ? this.contactShadow.gpuBytes : 0);
    }

    add(object) {
        this.scene.add(object);
    }

    remove(object) {
        this.scene.remove(object);
    }

    onResize() {
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;
        this.camera.aspect = this.width / this.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.width, this.height);
        if (this.isZoomedIn && this.zoomedFinger && !this.cameraHeld) {
            // Re-frame the focused nail for the new aspect (no animation).
            this._focusTargets(this._focusPos, this.zoomedFinger);
            if (!this.isAnimating) {
                this.camera.position.copy(this.targetCameraPos);
                this.controls.target.copy(this.targetTarget);
            }
        }
        this.invalidate();
    }

    /**
     * Per-frame update: camera animation and controls damping.
     * @param {number} dt seconds
     */
    update(dt) {
        if (this.isAnimating) {
            this.updateCameraAnimation(dt);
            this.invalidate();
        }
        // update() returns true while damping is still moving the camera.
        if (this.controls.update(dt)) this.invalidate();

        // The room dome only exists for views that can see above the desk.
        const bd = this.backdrop;
        if (bd) {
            this.camera.getWorldDirection(this._camDir);
            // Top edge of the view (vertical fov, plus margin for the wide aspect's corners).
            const topElevation = Math.asin(Math.max(-1, Math.min(1, this._camDir.y))) + THREE.MathUtils.degToRad(this.camera.fov * 0.5) * 1.6;
            const roomVisible = topElevation > -0.1;
            if (roomVisible && !bd.roomReady) bd.bakeRoom();
            // Pulled back before the idle warm-up: show the wrist roll now.
            if (!bd.rollReady && !this.isZoomedIn && bd.roll.geometry.attributes.position) {
                bd.rollReady = true;
                bd.roll.visible = true;
            }
            if (bd.mesh.visible !== roomVisible) {
                bd.mesh.visible = roomVisible;
                this.invalidate();
            }
        }
    }

    render() {
        if (this.contextLost) return;
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Update camera animation using smooth easing
     * @param {number} dt seconds
     */
    updateCameraAnimation(dt) {
        this.animationProgress += dt / this.animationDuration;
        if (this.animationProgress >= 1) {
            this.animationProgress = 1;
            this.isAnimating = false;
        }
        // ease-out cubic
        const t = 1 - Math.pow(1 - this.animationProgress, 3);
        this.camera.position.lerpVectors(this.startCameraPos, this.targetCameraPos, t);
        this.controls.target.lerpVectors(this.startTarget, this.targetTarget, t);
    }

    /**
     * Focus camera on a specific world position with close-up frontal view
     * @param {THREE.Vector3} position - World position to focus on
     * @param {string} finger - Finger identifier for tracking
     */
    focusOnPosition(position, finger) {
        this.startCameraPos.copy(this.camera.position);
        this.startTarget.copy(this.controls.target);
        this._focusPos.copy(position);
        this._focusTargets(position, finger);

        this.animationProgress = 0;
        this.isAnimating = true;
        this.isZoomedIn = true;
        this.zoomedFinger = finger;
        this.controls.maxDistance = 1.5;
        this.invalidate();
    }

    /**
     * Camera distance from the nail's size and the viewport's aspect, so the
     * focused nail fills FOCUS_FILL of the short side in landscape and
     * portrait alike. The nail stays centred, clear of the top-left bubble.
     */
    _focusTargets(position, finger) {
        let size = 0.1;
        const hm = this.handModel;
        const rec = hm && finger ? hm.getNail(hm.getCurrentHand(), finger) : null;
        if (rec) {
            rec.mesh.updateWorldMatrix(true, false);
            if (!rec.mesh.geometry.boundingBox) rec.mesh.geometry.computeBoundingBox();
            this._box.copy(rec.mesh.geometry.boundingBox).applyMatrix4(rec.mesh.matrixWorld);
            size = Math.max(this._box.max.x - this._box.min.x, this._box.max.z - this._box.min.z) || size;
        }
        const aspect = this.width / Math.max(1, this.height);
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
        const fill = COARSE ? FOCUS_FILL_COARSE : FOCUS_FILL;
        const d = THREE.MathUtils.clamp(size / (fill * 2 * tanHalf * Math.min(1, aspect)), 0.18, 1.2);
        // Same viewing direction as always (from above, slightly toward +z).
        const k = d / 0.541;
        this.targetTarget.set(position.x, position.y - 0.03 * k, position.z - 0.03 * k);
        this.targetCameraPos.set(position.x, position.y + 0.5 * k, position.z + 0.08 * k);
        this.controls.minDistance = Math.min(0.2, d * 0.7);
    }

    /**
     * Zoom out to show the full hand
     */
    zoomOut() {
        if (!this.isZoomedIn) return;
        this.startCameraPos.copy(this.camera.position);
        this.startTarget.copy(this.controls.target);
        this.targetCameraPos.copy(this.defaultCameraPos);
        this.targetTarget.copy(this.defaultTarget);
        this.animationProgress = 0;
        this.isAnimating = true;
        this.isZoomedIn = false;
        this.zoomedFinger = null;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;
        this.invalidate();
    }

    getIsZoomedIn() {
        return this.isZoomedIn;
    }

    /**
     * Lock or unlock camera controls
     * @param {boolean} locked
     */
    setCameraLocked(locked) {
        this.controls.enabled = !locked;
        this.isCameraLocked = locked;
    }

    isCameraLockedState() {
        return this.isCameraLocked || false;
    }

    /** Rotation on/off without touching the lock (painting never orbits). */
    setRotateEnabled(enabled) {
        this.controls.enableRotate = enabled;
    }

    getZoomedFinger() {
        return this.zoomedFinger;
    }

    /**
     * Raycaster set from a pointer event (reused instance).
     */
    getRaycaster(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;
        this._mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this.camera);
        return this._raycaster;
    }
}
