/**
 * NailScene.js
 * Main Three.js scene setup with lighting and camera
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class NailScene {
    constructor(container) {
        this.container = container;
        this.width = container.clientWidth;
        this.height = container.clientHeight;

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

        this.init();
        this.setupLighting();
        this.setupControls();
        this.animate();

        // Handle resize
        window.addEventListener('resize', () => this.onResize());
    }

    init() {
        // Scene with gradient background
        this.scene = new THREE.Scene();

        // Create gradient background
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, '#FFE5EC');
        gradient.addColorStop(1, '#FFF0F5');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 512);

        const texture = new THREE.CanvasTexture(canvas);
        this.scene.background = texture;

        // Camera - frontal view looking straight down at nail
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.width / this.height,
            0.1,
            1000
        );
        // Camera positioned above nail, looking down at surface
        this.camera.position.set(0, 1.5, 0.3);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;

        this.container.appendChild(this.renderer.domElement);
    }

    setupLighting() {
        // Soft ambient light for overall illumination
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);

        // Main key light from above (salon overhead light)
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
        keyLight.position.set(0, 5, 1);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.width = 1024;
        keyLight.shadow.mapSize.height = 1024;
        keyLight.shadow.camera.near = 0.5;
        keyLight.shadow.camera.far = 10;
        this.scene.add(keyLight);

        // Fill light from left side
        const fillLight = new THREE.DirectionalLight(0xfff0f5, 0.5);
        fillLight.position.set(-3, 3, 0);
        this.scene.add(fillLight);

        // Fill light from right side
        const fillLight2 = new THREE.DirectionalLight(0xfff0f5, 0.5);
        fillLight2.position.set(3, 3, 0);
        this.scene.add(fillLight2);

        // Front fill light for nail surface highlights
        const frontLight = new THREE.DirectionalLight(0xffffff, 0.4);
        frontLight.position.set(0, 2, 3);
        this.scene.add(frontLight);

        // Subtle rim light from behind finger
        const rimLight = new THREE.DirectionalLight(0xffb6c1, 0.3);
        rimLight.position.set(0, 1, -3);
        this.scene.add(rimLight);
    }

    setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        // Set orbit target to center of hand
        this.controls.target.set(0, 0, 0);

        // Limit controls for a pleasant experience
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        // Limit zoom for frontal view - allow close positioning
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;

        // Allow free rotation for debugging
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = Math.PI;

        // Allow full horizontal rotation
        this.controls.minAzimuthAngle = -Infinity;
        this.controls.maxAzimuthAngle = Infinity;

        // Disable pan for simplicity
        this.controls.enablePan = false;

        // Touch settings for mobile
        this.controls.touches = {
            ONE: THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_ROTATE
        };
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
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Update camera animation if active
        if (this.isAnimating) {
            this.updateCameraAnimation();
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Update camera animation using smooth easing
     */
    updateCameraAnimation() {
        // Calculate delta time (approximately 60fps)
        const deltaTime = 1 / 60;
        this.animationProgress += deltaTime / this.animationDuration;

        if (this.animationProgress >= 1) {
            // Animation complete
            this.animationProgress = 1;
            this.isAnimating = false;
        }

        // Smooth easing function (ease-out cubic)
        const t = 1 - Math.pow(1 - this.animationProgress, 3);

        // Interpolate camera position
        this.camera.position.lerpVectors(this.startCameraPos, this.targetCameraPos, t);

        // Interpolate orbit target
        this.controls.target.lerpVectors(this.startTarget, this.targetTarget, t);
    }

    /**
     * Focus camera on a specific world position with close-up frontal view
     * @param {THREE.Vector3} position - World position to focus on
     * @param {string} finger - Finger identifier for tracking
     * @param {number} distance - Distance from nail (default 0.4 for close-up)
     */
    focusOnPosition(position, finger, distance = 0.4) {
        // Store current camera state
        this.startCameraPos.copy(this.camera.position);
        this.startTarget.copy(this.controls.target);

        // Target is slightly into the finger for better centering
        this.targetTarget.set(
            position.x,
            position.y - 0.03,   // Slightly toward cuticle for centering
            position.z - 0.03    // Into finger body
        );

        // Camera position - more directly above for frontal view like Blender reference
        this.targetCameraPos.set(
            position.x,
            position.y + 0.5,    // Above nail surface
            position.z + 0.08    // Minimal Z offset for more top-down view
        );

        // Start animation
        this.animationProgress = 0;
        this.isAnimating = true;
        this.isZoomedIn = true;
        this.zoomedFinger = finger;

        // Tighten zoom limits while zoomed in - allow very close
        this.controls.minDistance = 0.2;
        this.controls.maxDistance = 1.5;
    }

    /**
     * Zoom out to show the full hand
     */
    zoomOut() {
        if (!this.isZoomedIn) return;

        // Store current camera state
        this.startCameraPos.copy(this.camera.position);
        this.startTarget.copy(this.controls.target);

        // Target default position
        this.targetCameraPos.copy(this.defaultCameraPos);
        this.targetTarget.copy(this.defaultTarget);

        // Start animation
        this.animationProgress = 0;
        this.isAnimating = true;
        this.isZoomedIn = false;
        this.zoomedFinger = null;

        // Restore zoom limits for frontal view
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 3.0;
    }

    /**
     * Check if camera is currently zoomed in on a finger
     */
    getIsZoomedIn() {
        return this.isZoomedIn;
    }

    /**
     * Get the currently zoomed finger
     */
    getZoomedFinger() {
        return this.zoomedFinger;
    }

    // For raycasting (click detection)
    getRaycaster(event) {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        // Get mouse/touch position
        const rect = this.renderer.domElement.getBoundingClientRect();
        const clientX = event.touches ? event.touches[0].clientX : event.clientX;
        const clientY = event.touches ? event.touches[0].clientY : event.clientY;

        mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, this.camera);

        return raycaster;
    }
}
