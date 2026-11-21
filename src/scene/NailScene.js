/**
 * NailScene.js
 * Three.js scene, camera, renderer, lights and orbit controls.
 *
 * NailScene no longer owns a requestAnimationFrame: the app's FrameLoop calls
 * `update(dt)` (camera animation + controls) and `render()`.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createNailLighting } from './NailMaterial.js';
import { CONTEXT_ATTRIBUTES } from '../core/Quality.js';

const DEFAULT_SETTINGS = Object.freeze({ antialias: true, pixelRatio: 1, rimLight: false });

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

        this.init();
        this.setupLighting();
        this.setupControls();

        this._onResize = () => this.onResize();
        window.addEventListener('resize', this._onResize);
    }

    init() {
        this.scene = new THREE.Scene();

        // Backdrop: a flat clear colour (the old gradient texture rendered as
        // this one colour after tone mapping, and cost a full-screen pass).
        // WP3 replaces this with the real backdrop.
        this.scene.background = null;
        this.clearColor = new THREE.Color(0xE7E5E6);

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

        const el = this.renderer.domElement;
        el.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            this.contextLost = true;
        });
        el.addEventListener('webglcontextrestored', () => {
            this.contextLost = false;
            // three.js rebuilds its GL state on restore; put our clear colour back.
            this.renderer.setClearColor(this.clearColor, 1);
            if (this.onContextRestored) this.onContextRestored();
            this.invalidate();
        });

        this.container.appendChild(el);
    }

    setupLighting() {
        // Budget (plan 1.3): 1 hemisphere + 1 directional (+1 rim on high), no shadows.
        this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xffd9e4, 1.2);
        this.scene.add(this.hemiLight);

        this.keyLight = new THREE.DirectionalLight(0xfffaf5, 1.6);
        this.keyLight.position.set(0.6, 5, 2.2);
        this.scene.add(this.keyLight);

        // The rim light only exists when the session starts on high. Lower
        // tiers never add it, and a downgrade sets its intensity to 0 so the
        // skin program never recompiles.
        this.rimLight = null;
        if (this.settings.rimLight) {
            this.rimLight = new THREE.DirectionalLight(0xffb6c1, 0.5);
            this.rimLight.position.set(0, 1, -3);
            this.scene.add(this.rimLight);
        }

        // Nail shader v1 uses the same key light direction.
        this.nailLighting.uLightDir.value.copy(this.keyLight.position).normalize();
    }

    setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = Math.PI;
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
        if (this.rimLight) this.rimLight.intensity = settings.rimLight ? 0.5 : 0;
        this.invalidate();
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

        this.targetTarget.set(
            position.x,
            position.y - 0.03,
            position.z - 0.03
        );
        this.targetCameraPos.set(
            position.x,
            position.y + 0.5,
            position.z + 0.08
        );

        this.animationProgress = 0;
        this.isAnimating = true;
        this.isZoomedIn = true;
        this.zoomedFinger = finger;

        this.controls.minDistance = 0.2;
        this.controls.maxDistance = 1.5;
        this.invalidate();
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
