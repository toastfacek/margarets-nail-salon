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
const FOCUS_FILL = 0.64;
const FOCUS_FILL_COARSE = 0.70;
const COARSE = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
// The focused nail is centred in the band the HUD leaves free (CSS px):
// [top, bottom] reserved at the top (bubble, stars, finger dots / finger map)
// and at the bottom (bottle tray, and the finger dots above it in portrait).
// Matches styles/game.css and styles/pan.css layouts.
function focusBand(w, h, out) {
    if (w < h) { out[0] = 150; out[1] = 230; }          // portrait
    else if (h <= 420) { out[0] = 58; out[1] = 70; }    // small landscape
    else { out[0] = 58; out[1] = 96; }                  // landscape
    // never more than a third of the screen each
    out[0] = Math.min(out[0], h / 3);
    out[1] = Math.min(out[1], h / 3);
    return out;
}
// Finger rail (smart pan): the hand order on the rail, and how far the camera
// backs off between two fingers (x focus distance) so the next one shows sooner.
const RAIL = Object.freeze(['thumb', 'index', 'middle', 'ring', 'pinky']);
const RAIL_BULGE = 0.22;
const WORLD_UP = Object.freeze(new THREE.Vector3(0, 1, 0));
/** A camera pose: position, look-at target, up (unit), focus distance. */
const makePose = () => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), d: 0.5, ok: false });
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
        // The camera's up vector is animated too (the close-up is rolled so
        // the nail points down the screen): eased around the view axis.
        this.startUp = new THREE.Vector3(0, 1, 0);
        this.targetUp = new THREE.Vector3(0, 1, 0);
        this._rollAxis = new THREE.Vector3();

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

        // Finger rail: one focus pose per finger of the shown hand, and the
        // path through them, pose to pose (src/features/fingerPan.feature.js drives it).
        this._railPoses = RAIL.map(() => makePose());
        this._railReady = false;
        this.railS = -1;              // where the camera sits on the rail (finger index, fractional), -1 = off
        this._railGlide = false;      // a rail glide is running (isAnimating too)
        this._glide = { s0: 0, s1: 0, v0: 0, t: 0, T: 0.35 };
        this._railBlend = { w: 0, t0: 0, T: 220, pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
        this._pose = makePose();
        this._band = [0, 0];
        this._poseB = makePose();
        this._fp = { c: new THREE.Vector3(), a: new THREE.Vector3(), s: new THREE.Vector3(), n: new THREE.Vector3(), v: new THREE.Vector3() };
        this.onRailSettle = null;     // (finger) => void, when a rail glide lands
        this.onRailGlide = null;      // () => void, when a rail glide starts
        this._flightFocus = false;    // the flight in progress ends on a nail's focus pose

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

        // near 0.04: the pinky's close-up sits ~0.14 from its nail, the brush handle closer
        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.04, 1000);
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
        // Focus distances depend on the aspect: rebuild the rail on next use.
        this._railReady = false;
        if (this.isZoomedIn && this.zoomedFinger && !this.cameraHeld) {
            // Re-frame the focused nail for the new aspect (no animation).
            this._focusTargets(this._focusPos, this.zoomedFinger);
            if (!this.isAnimating) {
                this.camera.position.copy(this.targetCameraPos);
                this.controls.target.copy(this.targetTarget);
                this.camera.up.copy(this.targetUp);
                this.camera.lookAt(this.controls.target);
            }
        }
        this.invalidate();
    }

    /**
     * Per-frame update: camera animation and controls damping.
     * @param {number} dt seconds
     */
    update(dt) {
        if (!this.isAnimating) this._railGlide = false;
        if (this.isAnimating) {
            if (this._railGlide) this._stepGlide(dt);
            else this.updateCameraAnimation(dt);
            this.invalidate();
        } else if (this._railBlend.w > 0 && !this.cameraHeld && this.railS >= 0) {
            // a drag that grabbed the camera off the rail: fade the offset out
            this._applyRail(this.railS);
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
     * Rotate unit `a` toward unit `b` by fraction t, about their common
     * normal (about the view axis when they are opposite): a roll, never a
     * flip through the screen. Writes `out` (may be `a`).
     */
    rollToward(a, b, t, out) {
        const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
        const ang = Math.acos(dot);
        if (ang < 1e-5 || t >= 1) return out.copy(b);
        const axis = this._rollAxis.crossVectors(a, b);
        if (axis.lengthSq() < 1e-10) this.camera.getWorldDirection(axis);
        axis.normalize();
        return out.copy(a).applyAxisAngle(axis, ang * t);
    }

    /**
     * The screen-up a plain lookAt (world +Y up) gives a camera at `pos`
     * looking at `target`, as a unit vector across the view. Writes `out`.
     */
    naturalUp(pos, target, out) {
        const v = this._camDir.subVectors(target, pos).normalize();
        out.copy(WORLD_UP).addScaledVector(v, -v.y);
        if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
        return out.normalize();
    }

    /**
     * Start a flight from the current camera to targetCameraPos /
     * targetTarget, rolling the up vector to `up` (default: the target's
     * natural up). Used by the nail focus, zoom-out and the swirl bowl.
     * @param {THREE.Vector3} [up]
     * @param {number} [duration] seconds
     */
    beginFlight(up = null, duration = 0.5, focus = false) {
        // only a flight to a nail's focus pose lands on the finger rail
        this._flightFocus = focus;
        this.railS = -1;
        this.startCameraPos.copy(this.camera.position);
        this.startTarget.copy(this.controls.target);
        this.startUp.copy(this.camera.up).normalize();
        if (up) this.targetUp.copy(up).normalize();
        else this.naturalUp(this.targetCameraPos, this.targetTarget, this.targetUp);
        this.animationDuration = duration;
        this.animationProgress = 0;
        this.isAnimating = true;
        this._railGlide = false;
        this._railBlend.w = 0;
        this.invalidate();
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
        this.rollToward(this.startUp, this.targetUp, t, this.camera.up);
        if (!this.isAnimating && this._flightFocus && this.isZoomedIn && this.zoomedFinger) this.railS = RAIL.indexOf(this.zoomedFinger);
    }

    /**
     * Focus camera on a specific world position with close-up frontal view
     * @param {THREE.Vector3} position - World position to focus on
     * @param {string} finger - Finger identifier for tracking
     */
    focusOnPosition(position, finger) {
        const from = this.zoomedFinger;
        const wasIn = this.isZoomedIn && !this.cameraHeld;
        this._focusPos.copy(position);
        this._focusTargets(position, finger);
        this.isZoomedIn = true;
        this.zoomedFinger = finger;
        this.controls.maxDistance = 1.5;
        // From one finger of this hand to another: glide along the fingertip
        // row (the same path a pan takes), else fly straight.
        const i1 = RAIL.indexOf(finger);
        const s0 = this.railS;
        this._railReady = false; // the hand may have moved since the last build
        if (wasIn && from && from !== finger && i1 >= 0 && s0 >= 0 && !this.isAnimating && this._buildRail()) {
            this.railGlideTo(i1, 0);
            return;
        }
        this.beginFlight(this.targetUp, 0.5, true);
    }

    /**
     * The close-up pose for one nail of the shown hand: looking at the nail
     * face-on (along its normal), rolled so the finger runs down the screen
     * (cuticle up, free edge down, like a manicurist's view), at the distance
     * where its long side fills FOCUS_FILL of the screen's short side.
     * @param {string} finger
     * @param {{pos, target, up, d, ok}} out
     * @param {number} [aspect]
     */
    focusPose(finger, out, aspect = this.width / Math.max(1, this.height)) {
        out.ok = false;
        const hm = this.handModel;
        const rec = hm && finger ? hm.getNail(hm.getCurrentHand(), finger) : null;
        if (!rec || !rec.mesh || !rec.material || !rec.material.uniforms.uNailAxis) return out;
        const f = this._fp;
        const mesh = rec.mesh;
        mesh.updateWorldMatrix(true, false);
        const u = rec.material.uniforms;
        const half = u.uNailHalf.value;
        // the nail's visual middle along its axis (the frame centre is the
        // vertex mean, which sits nearer the cuticle on most nails): cached
        if (rec.focusMid === undefined) {
            const pos = mesh.geometry.attributes.position;
            const ax = u.uNailAxis.value, c0 = u.uNailCentre.value;
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < pos.count; i++) {
                const t = (pos.getX(i) - c0.x) * ax.x + (pos.getY(i) - c0.y) * ax.y + (pos.getZ(i) - c0.z) * ax.z;
                if (t < lo) lo = t;
                if (t > hi) hi = t;
            }
            rec.focusMid = isFinite(lo) ? (lo + hi) * 0.5 : 0;
        }
        const C = f.c.copy(u.uNailAxis.value).multiplyScalar(rec.focusMid).add(u.uNailCentre.value).applyMatrix4(mesh.matrixWorld);
        // world half extents along the axis and across (mesh scale may be mirrored)
        const C0 = f.s.copy(u.uNailCentre.value).applyMatrix4(mesh.matrixWorld);
        const halfL = f.v.copy(u.uNailAxis.value).multiplyScalar(half.x).add(u.uNailCentre.value).applyMatrix4(mesh.matrixWorld).distanceTo(C0);
        const halfW = f.v.copy(u.uNailSide.value).multiplyScalar(half.y).add(u.uNailCentre.value).applyMatrix4(mesh.matrixWorld).distanceTo(C0);
        const A = f.a.copy(u.uNailAxis.value).transformDirection(mesh.matrixWorld);
        const S = f.s.copy(u.uNailSide.value).transformDirection(mesh.matrixWorld);
        const N = f.n.crossVectors(A, S);
        if (N.lengthSq() < 1e-10) N.set(0, 1, 0);
        N.normalize();
        if (N.y < 0) N.negate();
        // cuticle direction across the view = screen up
        A.addScaledVector(N, -A.dot(N));
        if (A.lengthSq() < 1e-10) A.set(1, 0, 0).addScaledVector(N, -N.x);
        A.normalize();
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
        const fill = COARSE ? FOCUS_FILL_COARSE : FOCUS_FILL;
        const size = 2 * Math.max(halfL, halfW) || 0.1;
        const d = THREE.MathUtils.clamp(size / (fill * 2 * tanHalf * Math.min(1, aspect)), 0.1, 1.2);
        // centre the nail in the band the HUD leaves free: look a little
        // below (or above) it by that band's offset from the screen centre
        const band = focusBand(this.width, this.height, this._band);
        const raise = (band[1] - band[0]) / (2 * Math.max(1, this.height));
        out.target.copy(C).addScaledVector(A, -raise * 2 * d * tanHalf);
        out.pos.copy(out.target).addScaledVector(N, d);
        out.up.copy(A);
        out.d = d;
        out.ok = true;
        return out;
    }

    /**
     * Camera targets for the focused nail (see focusPose). Falls back to the
     * old straight-down view when the nail has no frame.
     */
    _focusTargets(position, finger) {
        const pose = this.focusPose(finger, this._pose);
        if (pose.ok) {
            this.targetTarget.copy(pose.target);
            this.targetCameraPos.copy(pose.pos);
            this.targetUp.copy(pose.up);
            this.controls.minDistance = Math.min(0.2, pose.d * 0.7);
            return;
        }
        const aspect = this.width / Math.max(1, this.height);
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
        const fill = COARSE ? FOCUS_FILL_COARSE : FOCUS_FILL;
        const d = THREE.MathUtils.clamp(0.1 / (fill * 2 * tanHalf * Math.min(1, aspect)), 0.18, 1.2);
        const k = d / 0.541;
        this.targetTarget.set(position.x, position.y - 0.03 * k, position.z - 0.03 * k);
        this.targetCameraPos.set(position.x, position.y + 0.5 * k, position.z + 0.08 * k);
        this.naturalUp(this.targetCameraPos, this.targetTarget, this.targetUp);
        this.controls.minDistance = Math.min(0.2, d * 0.7);
    }

    // ------------------------------------------------------------ rail --

    /** The rail's finger order (thumb .. pinky). */
    get railFingers() {
        return RAIL;
    }

    /** Focus poses of every nail of the shown hand (at this aspect). */
    _buildRail() {
        if (this._railReady) return true;
        let n = 0;
        for (let i = 0; i < RAIL.length; i++) {
            const p = this.focusPose(RAIL[i], this._railPoses[i]);
            if (p.ok) n++;
        }
        // every finger must have a pose (the hand models have all five)
        this._railReady = n === RAIL.length;
        return this._railReady;
    }

    /** Forget the cached poses (the hand moved or changed). */
    invalidateRail() {
        this._railReady = false;
    }

    /**
     * Camera pose at rail position s (0 = thumb .. 4 = pinky; fractional
     * between fingers, past the ends extrapolated for the rubber band).
     * Between two neighbouring fingers the pose is blended from their focus
     * poses: the look-at point slides from one nail to the next (so the row
     * of fingertips is followed finger to finger, wherever the thumb sits),
     * the view direction and distance blend, the up vector rolls from one
     * finger's axis to the other's, and the camera backs off a little half
     * way so the next finger shows sooner. On a finger it is exactly that
     * finger's focus pose.
     */
    railPose(s, out) {
        out.ok = false;
        if (!this._buildRail()) return out;
        const P = this._railPoses;
        const last = P.length - 1;
        const sc = Math.max(0, Math.min(last, s));
        const i = Math.min(last - 1, Math.floor(sc));
        const t = sc - i;
        const b = P[i], c = P[i + 1];
        out.target.lerpVectors(b.target, c.target, t);
        this.rollToward(b.up, c.up, t, out.up);
        // view direction (pos - target) blended, distance blended, plus the bulge
        const v = this._fp.v;
        v.subVectors(b.pos, b.target).multiplyScalar(1 - t);
        out.pos.subVectors(c.pos, c.target).multiplyScalar(t).add(v);
        const dist = b.d + (c.d - b.d) * t;
        const bulge = 1 + RAIL_BULGE * Math.sin(Math.PI * t);
        out.pos.normalize().multiplyScalar(dist * bulge).add(out.target);
        out.d = dist * bulge;
        // past an end: slide on along the end segment (rubber band)
        if (s < 0 || s > last) {
            const e0 = s < 0 ? P[0] : P[last], e1 = s < 0 ? P[1] : P[last - 1];
            const k = s < 0 ? -s : s - last;
            v.subVectors(e0.target, e1.target);
            out.target.addScaledVector(v, k);
            out.pos.addScaledVector(v, k);
        }
        out.ok = true;
        return out;
    }

    /**
     * Where world point `P` would show on screen (CSS px, canvas-relative)
     * with the camera at rail position s. Writes [x, y] into `out`; returns
     * false when the rail is not ready or P is behind that camera.
     */
    railScreenOf(s, P, out) {
        const pose = this.railPose(s, this._poseB);
        if (!pose.ok) return false;
        let c = this._railCam;
        if (!c) c = this._railCam = this.camera.clone();
        c.projectionMatrix.copy(this.camera.projectionMatrix);
        c.position.copy(pose.pos);
        c.up.copy(pose.up);
        c.lookAt(pose.target);
        c.updateMatrixWorld(true);
        const v = this._fp.v.copy(P).project(c);
        if (v.z > 1) return false;
        out[0] = (v.x + 1) * 0.5 * this.width;
        out[1] = (1 - v.y) * 0.5 * this.height;
        return true;
    }

    /**
     * The world point under canvas pixel (x, y), on the plane through the
     * look-at target facing the camera: what a pan drag holds on to.
     */
    pickPanPoint(x, y, out) {
        this._mouse.set((x / Math.max(1, this.width)) * 2 - 1, -(y / Math.max(1, this.height)) * 2 + 1);
        this._raycaster.setFromCamera(this._mouse, this.camera);
        const r = this._raycaster.ray;
        const n = this.camera.getWorldDirection(this._camDir);
        const den = r.direction.dot(n);
        if (Math.abs(den) < 1e-6) return false;
        const t = this._fp.v.subVectors(this.controls.target, r.origin).dot(n) / den;
        out.copy(r.origin).addScaledVector(r.direction, t);
        return true;
    }

    /** Put the camera at rail position s now (a drag). */
    railSet(s) {
        if (!this._buildRail()) return false;
        this.isAnimating = false;
        this._railGlide = false;
        this.railS = s;
        this._applyRail(s);
        this.invalidate();
        return true;
    }

    /**
     * Start a drag on the rail at s from wherever the camera is: the gap to
     * the rail pose fades out over ~0.2 s, so nothing jumps.
     */
    railGrab(s) {
        if (!this._buildRail()) return false;
        this.isAnimating = false;
        this._railGlide = false;
        const pose = this.railPose(s, this._poseB);
        const bl = this._railBlend;
        bl.pos.subVectors(this.camera.position, pose.pos);
        bl.target.subVectors(this.controls.target, pose.target);
        bl.up.copy(this.camera.up).normalize();
        bl.w = bl.pos.lengthSq() + bl.target.lengthSq() > 1e-10 || bl.up.dot(pose.up) < 0.99999 ? 1 : 0;
        bl.t0 = performance.now();
        this.railS = s;
        this.controls.minDistance = 0.05;
        return true;
    }

    _applyRail(s) {
        const pose = this.railPose(s, this._poseB);
        if (!pose.ok) return;
        const cam = this.camera;
        cam.position.copy(pose.pos);
        this.controls.target.copy(pose.target);
        cam.up.copy(pose.up);
        const bl = this._railBlend;
        if (bl.w > 0) {
            const k = Math.max(0, 1 - (performance.now() - bl.t0) / bl.T);
            bl.w = k * k * (3 - 2 * k);
            cam.position.addScaledVector(bl.pos, bl.w);
            this.controls.target.addScaledVector(bl.target, bl.w);
            this.rollToward(pose.up, bl.up, bl.w, cam.up);
        }
        cam.lookAt(this.controls.target);
    }

    /**
     * Glide along the rail to finger index `to`, starting with rail speed
     * `v0` (fingers per second, a flick), landing still in about 0.35 s
     * (longer for a longer trip). Cubic Hermite: the flick carries on,
     * the landing is soft.
     */
    railGlideTo(to, v0 = 0) {
        if (!this._buildRail()) return false;
        const g = this._glide;
        const from = this.railS >= 0 ? this.railS : to;
        // whatever gap there is between the camera and the rail fades out
        this.railGrab(from);
        g.s0 = from;
        g.s1 = to;
        g.v0 = v0;
        g.t = 0;
        g.T = Math.min(0.7, 0.35 + 0.1 * Math.max(0, Math.abs(to - from) - 1));
        this._railGlide = true;
        this.isAnimating = true;
        this.controls.minDistance = 0.05;
        this.invalidate();
        if (this.onRailGlide) this.onRailGlide();
        return true;
    }

    _stepGlide(dt) {
        const g = this._glide;
        g.t = Math.min(g.T, g.t + dt);
        const x = g.t / g.T;
        const x2 = x * x, x3 = x2 * x;
        // Hermite: p0 = s0, m0 = v0 T, p1 = s1, m1 = 0
        const s = (2 * x3 - 3 * x2 + 1) * g.s0 + (x3 - 2 * x2 + x) * g.v0 * g.T + (-2 * x3 + 3 * x2) * g.s1;
        this.railS = s;
        this._applyRail(s);
        if (g.t >= g.T) this._settleRail(g.s1);
    }

    /** The glide landed on finger index i: exactly the focus framing. */
    _settleRail(i) {
        this._railGlide = false;
        this.isAnimating = false;
        this._railBlend.w = 0;
        this.railS = i;
        const finger = RAIL[i];
        const pose = this._railPoses[i];
        this.camera.position.copy(pose.pos);
        this.controls.target.copy(pose.target);
        this.camera.up.copy(pose.up);
        this.camera.lookAt(pose.target);
        this.targetCameraPos.copy(pose.pos);
        this.targetTarget.copy(pose.target);
        this.targetUp.copy(pose.up);
        this.controls.minDistance = Math.min(0.2, pose.d * 0.7);
        this.isZoomedIn = true;
        this.zoomedFinger = finger;
        const hm = this.handModel;
        if (hm) hm.getNailWorldPosition(finger, this._focusPos);
        this.invalidate();
        if (this.onRailSettle) this.onRailSettle(finger);
    }

    /** Stop a rail glide or drag where it is (the reveal, the bowl). */
    cancelRail() {
        if (this._railGlide) this.isAnimating = false;
        this._railGlide = false;
        this._railBlend.w = 0;
    }

    /** True while a rail glide runs. */
    isRailGliding() {
        return this._railGlide && this.isAnimating;
    }

    /**
     * Zoom out to show the full hand
     */
    zoomOut() {
        if (!this.isZoomedIn) return;
        this.targetCameraPos.copy(this.defaultCameraPos);
        this.targetTarget.copy(this.defaultTarget);
        this.isZoomedIn = false;
        this.zoomedFinger = null;
        this.railS = -1;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;
        this.beginFlight(null, 0.6);
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
