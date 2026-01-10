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

        // Camera - positioned above looking down at horizontal finger
        this.camera = new THREE.PerspectiveCamera(
            45,
            this.width / this.height,
            0.1,
            1000
        );
        // Camera above and slightly in front, looking down at nail
        this.camera.position.set(0, 2.0, 1.2);
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

        // Set orbit target to center where finger lays
        this.controls.target.set(0, 0, 0);

        // Limit controls for a pleasant experience
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        // Limit zoom for top-down view
        this.controls.minDistance = 1.5;
        this.controls.maxDistance = 4.0;

        // Limit rotation angles for top-down viewing
        this.controls.minPolarAngle = Math.PI * 0.1;  // Almost directly above
        this.controls.maxPolarAngle = Math.PI * 0.45; // Can tilt to side view

        // Allow more horizontal rotation to see finger from different angles
        this.controls.minAzimuthAngle = -Math.PI * 0.5;
        this.controls.maxAzimuthAngle = Math.PI * 0.5;

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

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
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
