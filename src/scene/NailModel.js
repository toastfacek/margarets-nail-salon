/**
 * NailModel.js
 * Realistic finger and nail geometry with anatomical details
 * Creates a proper 3D nail with lunula texture and nail bed
 *
 * =============================================================================
 * COORDINATE SYSTEM DOCUMENTATION
 * =============================================================================
 *
 * LOCAL GEOMETRY COORDINATES (before group rotation):
 * - X-axis: Width of finger (left/right)
 * - Y-axis: Length of finger (0 = fingertip end, increasing toward knuckle)
 * - Z-axis: Depth (+Z = top surface where nail sits, -Z = palm side)
 *
 * FINGER GEOMETRY (createFingerGeometry):
 * - Parameter t ranges from 0 to 1
 * - t=0: Fingertip (dome)
 * - t=1: Knuckle/base (where finger connects to hand)
 * - Geometry Y coordinate: y = t * config.length
 * - Finger mesh positioned at y = -config.length * 0.40 to center it
 * - Top surface (nail bed) is at +Z, created when theta=0 (cos(0)=1)
 *
 * NAIL GEOMETRY (createNailGeometry):
 * - Parameter v ranges from 0 to 1
 * - v=0: Nail TIP (toward fingertip, low Y)
 * - v=1: Nail CUTICLE/base (toward knuckle, high Y)
 * - Geometry Y coordinate: y = v * nailLength
 * - Nail positioned at nailBedY = -config.length * 0.52 (toward fingertip)
 * - Curved surface bulges in +Z direction
 *
 * LUNULA:
 * - Rendered as texture on nail surface (not a separate mesh)
 * - Drawn as wide ellipse on canvas texture at cuticle end
 * - UV mapping: v=0 maps to canvas Y=0 (tip), v=1 maps to canvas Y=512 (cuticle)
 * - Ellipse positioned at canvas Y=500, radiusX=220, radiusY=100
 *
 * GROUP ROTATION (setHorizontalOrientation):
 * - rotation.x = -Math.PI / 2 transforms local to world:
 *   - Local +Y → World -Z (finger length points away from camera)
 *   - Local +Z → World +Y (nail surface faces UP toward camera)
 *   - Local +X → World +X (unchanged)
 * - Result: Finger lays horizontally, nail visible from above
 *   - Fingertip at top of screen (far from camera)
 *   - Knuckle at bottom of screen (closer to camera)
 *
 * CAMERA (in NailScene.js):
 * - Position: (0, 2.0, 1.2) - above and in front
 * - Looking at origin (0, 0, 0)
 * - Creates 3/4 top-down view of the nail
 *
 * =============================================================================
 * NAIL POSITIONING GUIDE
 * =============================================================================
 *
 * To ensure the nail is properly visible and anatomically correct:
 *
 * 1. NAIL Z POSITION (getNailBaseZ):
 *    - Controls how high nail sits above finger surface
 *    - Value: config.tipRadius * 0.62
 *    - Too low: nail buried inside finger
 *    - Too high: nail floats above finger
 *
 * 2. NAIL Y POSITION (nailBedY in createNail):
 *    - Controls nail placement along finger length
 *    - Value: -config.length * 0.52 (toward fingertip)
 *    - More negative: nail moves toward fingertip
 *    - Less negative: nail moves toward knuckle
 *
 * 3. FINGER TOP FLATTENING (topFlatten):
 *    - Controls how rounded vs flat the top of finger is
 *    - Value: 1.0 - topFactor * 0.25 (25% flattening)
 *    - More flattening: flatter nail bed, nail sits lower
 *    - Less flattening: rounder finger, nail sits higher
 *
 * 4. NAIL BED DEPRESSION (in createFingerGeometry):
 *    - Lowers finger skin where nail sits to expose more nail
 *    - Applied at t=0.05 to t=0.55 (fingertip area)
 *    - Creates U-shaped groove for nail visibility
 *    - Depression depth: 12% of surface height
 *
 * 5. NAIL CURVATURE (nailCurve in FingerConfig):
 *    - Controls lateral curve of nail (side-to-side)
 *    - Values: 0.07-0.09 for realistic curve
 *    - Higher: more curved/domed nail
 *    - Lower: flatter nail
 *
 * 6. NAIL WIDTH (nailWidth in FingerConfig):
 *    - Must fit within finger profile
 *    - Values: 0.44-0.62 depending on finger
 *    - Too wide: nail edges extend past finger
 *
 * =============================================================================
 * RENDERING & MATERIAL NOTES
 * =============================================================================
 *
 * FINGER MATERIAL - DOUBLE-SIDED RENDERING:
 * The finger material MUST use `side: THREE.DoubleSide`. Here's why:
 *
 * Problem: The finger geometry is a procedurally-generated tube with complex
 * surface modifications (nail bed depression, knuckle creases).
 * These deformations can cause face normals to point in unexpected directions.
 * With default FrontSide rendering, faces whose normals point away from the
 * camera are culled (invisible), making the finger appear transparent from
 * certain viewing angles.
 *
 * Solution: DoubleSide renders both sides of each triangle, ensuring the finger
 * is always opaque regardless of camera angle or face winding order.
 *
 * NAIL MATERIAL - TRANSMISSION:
 * The nail uses `transmission: 0.15` for subtle translucency showing the nail
 * bed underneath. This is reduced to 0.05 when polish is applied.
 *
 * LUNULA AS TEXTURE:
 * The lunula (white half-moon) is rendered as a canvas texture on the nail
 * material rather than a separate mesh. This avoids z-fighting and occlusion
 * issues. The texture is a 512x512 canvas with:
 * - Base fill: nail color (#FFDDD2)
 * - Lunula: wide ellipse at cuticle end (canvas Y=500)
 * - Hidden when polish is applied, restored when cleared
 *
 * RENDER ORDER:
 * - Finger: renderOrder = 0 (rendered first, opaque base layer)
 * - Nail: renderOrder = 1 (rendered on top of finger)
 * - Overlay: renderOrder = 3 (brush strokes, decorations)
 *
 * =============================================================================
 */
import * as THREE from 'three';
import { FINGER_CONFIGS, DEFAULT_FINGER } from './FingerConfig.js';

// Nail shape definitions
export const NAIL_SHAPES = {
    ROUND: 'round',
    SQUARE: 'square',
    ALMOND: 'almond',
    STILETTO: 'stiletto',
    COFFIN: 'coffin'
};

export class NailModel {
    constructor(fingerType = DEFAULT_FINGER) {
        this.fingerConfig = FINGER_CONFIGS[fingerType];
        this.currentShape = NAIL_SHAPES.ROUND;
        this.baseColor = new THREE.Color('#FFDDD2'); // Natural nail base
        this.polishColor = null;
        this.finishType = 'glossy';

        this.group = new THREE.Group();

        // Create components in order (bottom to top)
        this.createFingerBase();
        this.createNail();
        // Cuticle geometry removed - nail now embeds into finger naturally
        // this.createCuticle();
        // this.createLateralFolds(); // TODO: fix positioning
        this.createOverlay();

        // Set horizontal orientation (finger laying flat, nail facing up)
        this.setHorizontalOrientation();
    }

    setHorizontalOrientation() {
        // Finger lays flat, nail surface faces up (+Y)
        // Fingertip at top of screen, knuckle at bottom
        this.group.rotation.x = -Math.PI / 2;
        this.group.rotation.z = 0;
    }

    /**
     * Create realistic finger with elliptical cross-section
     * Real fingers are wider than they are deep
     */
    createFingerBase() {
        const config = this.fingerConfig;
        const geometry = this.createFingerGeometry(config);

        // Opaque skin material - must fully occlude nail at cuticle
        this.fingerMaterial = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color('#F5C9B8'), // Warm skin tone
            roughness: 0.55,
            metalness: 0.0,
            clearcoat: 0.05,
            clearcoatRoughness: 0.9,
            // Sheen for skin softness
            sheen: 0.3,
            sheenRoughness: 0.8,
            sheenColor: new THREE.Color('#FFCDB8'),
            // Ensure fully opaque and render both sides
            transparent: false,
            opacity: 1.0,
            side: THREE.DoubleSide,
        });

        this.fingerMesh = new THREE.Mesh(geometry, this.fingerMaterial);
        this.fingerMesh.position.set(0, -config.length * 0.40, 0);
        this.fingerMesh.castShadow = true;
        this.fingerMesh.receiveShadow = true;
        this.fingerMesh.name = 'finger';
        this.fingerMesh.renderOrder = 0;

        this.group.add(this.fingerMesh);
    }

    /**
     * Create elliptical finger geometry instead of circular LatheGeometry
     * This creates a more realistic finger shape
     */
    createFingerGeometry(config) {
        const segmentsY = 48; // Segments along length
        const segmentsRadial = 32; // Segments around circumference

        const vertices = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        // Ellipse ratio: width vs depth (real fingers are about 1.3x wider than deep)
        const ellipseRatio = 1.25;

        for (let iy = 0; iy <= segmentsY; iy++) {
            const t = iy / segmentsY;
            const y = t * config.length;

            // Calculate radius at this height
            let radius = this.getFingerRadius(t, config);

            // Add subtle anatomical details
            const creaseIntensity = this.getCreaseIntensity(t);

            for (let ir = 0; ir <= segmentsRadial; ir++) {
                const theta = (ir / segmentsRadial) * Math.PI * 2;

                // Elliptical cross-section: wider (X) than deep (Z)
                let rx = radius * ellipseRatio;
                let rz = radius;

                // Top surface curvature (+Z in local coords)
                // Uniform gentle flattening for nail bed
                const topFactor = Math.max(0, Math.cos(theta));
                const topFlatten = 1.0 - topFactor * 0.25;  // 25% flattening - balanced

                // Round the bottom (pad side) slightly less
                const bottomFactor = Math.max(0, -Math.cos(theta));
                const bottomFlatten = 1.0 - bottomFactor * 0.08;

                rz *= topFlatten * bottomFlatten;

                // Nail bed depression - lower the skin where nail sits to expose more nail
                // Creates U-shaped groove for nail visibility
                if (t > 0.05 && t < 0.55 && topFactor > 0.5) {
                    // How far along the nail bed (0 at start, 1 at end)
                    const nailBedT = (t - 0.05) / 0.50;
                    // Depression is deeper in middle, tapers at edges
                    const depthCurve = Math.sin(nailBedT * Math.PI);
                    // Lateral taper - depression is wider at center of top
                    const lateralTaper = Math.pow(topFactor, 0.8);
                    // Apply depression (lower the Z)
                    const depression = depthCurve * lateralTaper * 0.12;
                    rz *= (1.0 - depression);
                }

                // Simple nail bed offset
                let nailBedOffset = 0;

                // Apply subtle creases at knuckle areas
                const creaseEffect = 1.0 - creaseIntensity * 0.03 * Math.abs(Math.sin(theta * 2));

                const x = Math.sin(theta) * rx * creaseEffect;
                const z = Math.cos(theta) * rz * creaseEffect + nailBedOffset;

                vertices.push(x, y, z);

                // Calculate normal
                const nx = Math.sin(theta) * ellipseRatio;
                const nz = Math.cos(theta);
                const len = Math.sqrt(nx * nx + nz * nz);
                normals.push(nx / len, 0, nz / len);

                // UV coordinates
                uvs.push(ir / segmentsRadial, t);
            }
        }

        // Create faces
        for (let iy = 0; iy < segmentsY; iy++) {
            for (let ir = 0; ir < segmentsRadial; ir++) {
                const a = iy * (segmentsRadial + 1) + ir;
                const b = a + segmentsRadial + 1;
                const c = b + 1;
                const d = a + 1;

                indices.push(a, b, d);
                indices.push(b, c, d);
            }
        }

        // Create fingertip cap - slightly flatter, less dome-like
        const tipCenterIndex = vertices.length / 3;
        // Tip center slightly recessed for more natural look
        vertices.push(0, config.length, -0.01);
        normals.push(0, 1, 0);
        uvs.push(0.5, 1);

        const lastRingStart = segmentsY * (segmentsRadial + 1);
        for (let ir = 0; ir < segmentsRadial; ir++) {
            indices.push(
                lastRingStart + ir,
                lastRingStart + ir + 1,
                tipCenterIndex
            );
        }

        // Create base cap (knuckle end) - closes the tube to prevent see-through
        const baseCenterIndex = vertices.length / 3;
        // Base center slightly recessed inward for natural look
        vertices.push(0, 0, -0.02);
        normals.push(0, -1, 0);
        uvs.push(0.5, 0);

        // Connect first ring (y=0) to base center - wind faces opposite direction
        const firstRingStart = 0;
        for (let ir = 0; ir < segmentsRadial; ir++) {
            indices.push(
                firstRingStart + ir + 1,
                firstRingStart + ir,
                baseCenterIndex
            );
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    /**
     * Get finger radius at a given position along the length
     * t=0 is fingertip, t=1 is base
     */
    getFingerRadius(t, config) {
        if (t < 0.04) {
            // Fingertip - gentler dome, less bulbous than before
            const tipT = t / 0.04;
            const curve = Math.pow(tipT, 0.6);
            return config.tipRadius * curve * 0.80;
        } else if (t < 0.10) {
            // Transition from tip
            const transT = (t - 0.04) / 0.06;
            return THREE.MathUtils.lerp(config.tipRadius * 0.80, config.tipRadius * 0.95, transT);
        } else if (t < 0.45) {
            // Nail bed area - gradual expansion toward base
            const nailT = (t - 0.10) / 0.35;
            return THREE.MathUtils.lerp(config.tipRadius * 0.95, config.baseRadius * 0.90, nailT);
        } else if (t < 0.65) {
            // First knuckle area - subtle bulge
            const knuckleT = (t - 0.45) / 0.20;
            const knuckleBulge = Math.sin(knuckleT * Math.PI) * 0.015;
            return config.baseRadius * 0.90 + knuckleBulge;
        } else {
            // Main body to base
            const bodyT = (t - 0.65) / 0.35;
            return THREE.MathUtils.lerp(config.baseRadius * 0.90, config.baseRadius, bodyT);
        }
    }

    /**
     * Get crease intensity for skin wrinkles at knuckles
     */
    getCreaseIntensity(t) {
        // Creases at knuckle areas
        const knuckle1 = Math.exp(-Math.pow((t - 0.55) * 15, 2)) * 1.5;
        const knuckle2 = Math.exp(-Math.pow((t - 0.75) * 12, 2)) * 1.0;
        return knuckle1 + knuckle2;
    }

    /**
     * Create the nail with proper thickness and translucency
     */
    createNail() {
        const geometry = this.createNailGeometry(this.currentShape);
        const config = this.fingerConfig;
        const nailBaseZ = this.getNailBaseZ(config);

        // Semi-transparent nail material showing nail bed underneath
        this.nailMaterial = new THREE.MeshPhysicalMaterial({
            color: this.baseColor,
            roughness: 0.25,
            metalness: 0.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.1,
            reflectivity: 0.6,
            envMapIntensity: 1.0,
            // Translucency to show nail bed
            transmission: 0.15,
            thickness: 0.5,
            ior: 1.5,
            side: THREE.FrontSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
        });

        this.nailMesh = new THREE.Mesh(geometry, this.nailMaterial);
        this.nailMesh.castShadow = true;
        this.nailMesh.receiveShadow = true;
        this.nailMesh.name = 'nail';
        this.nailMesh.renderOrder = 1;

        // Position nail on top surface of finger (+Z is top)
        // Y position: nail tip should be near fingertip, cuticle extends toward knuckle
        // Finger geometry: fingertip at y = -config.length * 0.40 (t=0)
        // Nail tip (v=0, y=0 in geometry) placed at nailBedY, extends to nailBedY + nailLength
        const nailBedY = -config.length * 0.52; // Moved toward fingertip
        this.nailMesh.position.set(0, nailBedY, nailBaseZ);
        // Minimal tilt - nail sits naturally in the nail bed depression
        this.nailMesh.rotation.x = -0.02;

        this.group.add(this.nailMesh);

        // Create lunula (white half-moon at base)
        this.createLunula();
    }

    /**
     * Create the lunula (white half-moon at nail base) as a texture on the nail
     * Draws directly onto nail's base texture for perfect alignment
     */
    createLunula() {
        // Create a canvas texture for the nail with lunula
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        // Fill with nail base color (not transparent)
        ctx.fillStyle = '#FFDDD2';  // Match baseColor
        ctx.fillRect(0, 0, 512, 512);

        // Draw lunula as wide ellipse at the cuticle end
        // UV mapping: v=0 is nail tip (canvas Y=0), v=1 is cuticle (canvas Y=512)
        const centerX = 256;
        const centerY = 500;  // Moved up so more is visible
        const radiusX = 220;  // Wide horizontally
        const radiusY = 100;  // Taller vertically

        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, Math.PI, 0, false);  // Top half of ellipse
        ctx.closePath();

        // Soft off-white lunula
        ctx.fillStyle = 'rgba(255, 253, 250, 0.85)';
        ctx.fill();

        // Create texture from canvas
        this.lunulaTexture = new THREE.CanvasTexture(canvas);
        this.lunulaTexture.flipY = false;

        // Apply as the nail's color map
        this.nailMaterial.map = this.lunulaTexture;
        this.nailMaterial.needsUpdate = true;

        // No separate mesh needed
        this.lunulaMesh = null;
    }

    /**
     * Create the proximal nail fold (cuticle) - raised skin ridge at nail base
     * This wraps over the curved nail base edge
     */
    createCuticle() {
        const config = this.fingerConfig;
        const geometry = this.createCuticleGeometry(config);

        this.cuticleMesh = new THREE.Mesh(geometry, this.fingerMaterial);
        this.cuticleMesh.castShadow = true;
        this.cuticleMesh.receiveShadow = true;
        this.cuticleMesh.name = 'cuticle';

        // Match nail positioning exactly - geometry is in nail's coordinate space
        this.cuticleMesh.position.copy(this.nailMesh.position);
        this.cuticleMesh.rotation.copy(this.nailMesh.rotation);

        this.group.add(this.cuticleMesh);
    }

    /**
     * Generate geometry for the proximal nail fold
     * Creates a curved ridge with rounded cross-section
     * Uses same coordinate system as nail: Y from 0 (tip) to nailLength (cuticle)
     */
    createCuticleGeometry(config) {
        const nailLength = config.nailLength;
        const nailCurve = config.nailCurve;
        const nailThickness = 0.025;
        const cuticleWidth = config.nailWidth * 1.08;
        const cuticleDepth = 0.04; // How far it extends beyond nail
        const cuticleHeight = 0.02; // How tall the ridge is

        const segmentsAlong = 20;
        const segmentsAcross = 5;

        const vertices = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        for (let ia = 0; ia <= segmentsAlong; ia++) {
            const t = ia / segmentsAlong;
            const x = (t - 0.5) * cuticleWidth;

            // Match the nail base curve - center dips toward fingertip (lower Y)
            const centeredness = 1 - Math.abs(t - 0.5) * 2;
            const curveOffset = nailLength * 0.08 * centeredness * centeredness;

            // Taper height at the edges
            const edgeTaper = Math.sin(t * Math.PI);

            // Z at this X position (nail edge is flatter than center)
            const normalizedX = Math.abs(t - 0.5) * 2;
            const nailZAtEdge = (1 - normalizedX * normalizedX) * nailCurve + nailThickness;

            for (let ic = 0; ic <= segmentsAcross; ic++) {
                const s = ic / segmentsAcross;

                // Y: starts at nail cuticle edge, extends beyond (higher Y)
                const y = nailLength - curveOffset + cuticleDepth * s;

                // Z: rounded ridge profile sitting on/above nail surface
                const ridgeZ = cuticleHeight * Math.sin(s * Math.PI) * edgeTaper;
                const z = nailZAtEdge * 0.5 + ridgeZ;

                vertices.push(x, y, z);

                // Normal pointing outward from ridge
                const ny = Math.sin(s * Math.PI);
                const nz = Math.cos(s * Math.PI);
                const len = Math.sqrt(ny * ny + nz * nz) || 1;
                normals.push(0, ny / len, nz / len);

                uvs.push(t, s);
            }
        }

        for (let ia = 0; ia < segmentsAlong; ia++) {
            for (let ic = 0; ic < segmentsAcross; ic++) {
                const a = ia * (segmentsAcross + 1) + ic;
                const b = a + 1;
                const c = (ia + 1) * (segmentsAcross + 1) + ic;
                const d = c + 1;

                indices.push(a, c, b);
                indices.push(b, c, d);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    /**
     * Create lateral nail folds - skin ridges along both sides of the nail
     */
    createLateralFolds() {
        const config = this.fingerConfig;

        this.leftFoldMesh = this.createSingleLateralFold(config, -1);
        this.rightFoldMesh = this.createSingleLateralFold(config, 1);

        this.group.add(this.leftFoldMesh);
        this.group.add(this.rightFoldMesh);
    }

    createSingleLateralFold(config, side) {
        const geometry = this.createLateralFoldGeometry(config, side);

        const mesh = new THREE.Mesh(geometry, this.fingerMaterial);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = side > 0 ? 'lateral_fold_right' : 'lateral_fold_left';

        // Match nail positioning exactly
        mesh.position.copy(this.nailMesh.position);
        mesh.rotation.copy(this.nailMesh.rotation);

        return mesh;
    }

    /**
     * Generate geometry for a lateral nail fold
     * Half-cylinder profile that runs along the nail edge
     * Uses same coordinate system as nail: Y=length (flipped), X=width, Z=curve
     */
    createLateralFoldGeometry(config, side) {
        const nailLength = config.nailLength;
        const nailWidth = config.nailWidth;
        const foldWidth = 0.025;
        const foldHeight = 0.018;

        const segmentsLength = 16;
        const segmentsProfile = 5;

        const vertices = [];
        const normals = [];
        const uvs = [];
        const indices = [];

        // Position at nail edge
        const baseX = (nailWidth / 2 + foldWidth * 0.3) * side;

        for (let il = 0; il <= segmentsLength; il++) {
            const t = il / segmentsLength;
            // Y coordinate: runs from cuticle (nailLength) toward tip
            // Start slightly below cuticle, end partway down nail
            const y = nailLength * (0.95 - t * 0.7);

            // Taper toward nail tip
            const tipTaper = 1 - t * t * 0.5;
            // Taper at cuticle end to blend with proximal fold
            const cuticleTaper = Math.min(1, t * 5);

            const effectiveHeight = foldHeight * tipTaper * cuticleTaper;
            const effectiveWidth = foldWidth * tipTaper;

            for (let ip = 0; ip <= segmentsProfile; ip++) {
                const s = ip / segmentsProfile;
                const angle = s * Math.PI;

                // Half-cylinder profile extending outward from nail
                const profileX = baseX + Math.sin(angle) * effectiveWidth * side;
                // Z matches nail curve height plus ridge
                const baseZ = config.nailCurve * 0.3; // Sit on nail surface
                const profileZ = baseZ + Math.cos(angle) * effectiveHeight;

                vertices.push(profileX, y, profileZ);

                const nx = Math.sin(angle) * side;
                const nz = Math.cos(angle);
                normals.push(nx, 0, nz);

                uvs.push(s, t);
            }
        }

        for (let il = 0; il < segmentsLength; il++) {
            for (let ip = 0; ip < segmentsProfile; ip++) {
                const a = il * (segmentsProfile + 1) + ip;
                const b = a + 1;
                const c = (il + 1) * (segmentsProfile + 1) + ip;
                const d = c + 1;

                if (side > 0) {
                    indices.push(a, b, c);
                    indices.push(b, d, c);
                } else {
                    indices.push(a, c, b);
                    indices.push(b, c, d);
                }
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    createOverlay() {
        // Create a duplicate mesh for drawing overlay
        const geometry = this.nailMesh.geometry.clone();

        this.overlayMaterial = new THREE.MeshBasicMaterial({
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

        this.overlayMesh = new THREE.Mesh(geometry, this.overlayMaterial);
        this.overlayMesh.name = 'nail_overlay';
        this.overlayMesh.visible = false;

        this.overlayMesh.position.copy(this.nailMesh.position);
        this.overlayMesh.rotation.copy(this.nailMesh.rotation);

        this.group.add(this.overlayMesh);

        this.createDrawingCanvas();
    }

    createDrawingCanvas() {
        this.drawingCanvas = document.createElement('canvas');
        this.drawingCanvas.width = 1024;
        this.drawingCanvas.height = 1024;
        this.drawingCtx = this.drawingCanvas.getContext('2d');

        this.drawingTexture = new THREE.CanvasTexture(this.drawingCanvas);
        this.drawingTexture.flipY = false; // Natural UV mapping, no flip needed

        this.overlayMaterial.map = this.drawingTexture;
        this.overlayMaterial.needsUpdate = true;
        this.overlayMesh.visible = true;
    }

    getDrawingContext() {
        return this.drawingCtx;
    }

    getDrawingTexture() {
        return this.drawingTexture;
    }

    updateDrawingTexture() {
        if (this.drawingTexture) {
            this.drawingTexture.needsUpdate = true;
        }
    }

    clearDrawing() {
        if (this.drawingCtx) {
            this.drawingCtx.clearRect(0, 0, 1024, 1024);
            this.updateDrawingTexture();
        }
    }

    setOverlayTexture(texture) {
        if (this.overlayMaterial) {
            this.overlayMaterial.map = texture;
            this.overlayMaterial.needsUpdate = true;
        }
    }

    setOverlayVisible(visible) {
        if (this.overlayMesh) {
            this.overlayMesh.visible = visible;
        }
    }

    createNailGeometry(shape) {
        const config = this.fingerConfig;
        const nailWidth = config.nailWidth;
        const nailLength = config.nailLength;
        const nailThickness = 0.025;
        const nailCurve = config.nailCurve;

        const segmentsX = 24;
        const segmentsY = 32;

        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const uvs = [];
        const indices = [];

        // Create single outer surface only
        // With transmission material, the thickness parameter simulates solid depth
        // Inner surfaces cause rendering artifacts with transmission
        // Y coordinate: tip at Y=0 (v=0), cuticle at Y=nailLength (v=1)
        for (let iy = 0; iy <= segmentsY; iy++) {
            const v = iy / segmentsY;
            let baseY = v * nailLength;

            for (let ix = 0; ix <= segmentsX; ix++) {
                const u = ix / segmentsX;
                const baseX = (u - 0.5) * nailWidth;

                // Apply shape modifications to the tip (at low v values, v < 0.4)
                let tipScale = 1.0;
                let tipExtend = 0;

                // Tip shaping at v < 0.4 (tip is at low Y = low v)
                if (v < 0.4) {
                    const tipProgress = (0.4 - v) / 0.4;  // 0 at v=0.4, 1 at v=0
                    tipScale = this.getShapeWidth(shape, tipProgress);
                    tipExtend = -this.getShapeExtension(shape, tipProgress); // Negative to extend toward low Y
                }

                // Cuticle curve: create concave arc at nail base (v > 0.85 = high Y = cuticle)
                // Center of base dips toward fingertip for natural look
                let cuticleCurveOffset = 0;
                let cuticleZDip = 0;

                if (v > 0.85) {
                    const cuticleProgress = (v - 0.85) / 0.15; // 0 at v=0.85, 1 at v=1
                    const centeredness = 1 - Math.abs(u - 0.5) * 2; // 0 at edges, 1 at center
                    const curveDepth = nailLength * 0.08;
                    // Parabolic curve - center dips toward fingertip (lower Y)
                    cuticleCurveOffset = curveDepth * centeredness * centeredness * cuticleProgress;

                    // Curve nail downward into finger at cuticle (more at edges, less at center)
                    const edgeFactor = 1 - centeredness * 0.5; // Center dips less than edges
                    cuticleZDip = -cuticleProgress * cuticleProgress * 0.06 * edgeFactor;
                }

                const x = baseX * tipScale;
                const y = baseY + tipExtend + cuticleCurveOffset;

                // Curved surface - nail follows rounded fingertip contour
                const normalizedX = (u - 0.5) * 2;
                // Simple parabolic curve: 1 at center, 0 at edges
                const curveFactor = 1 - Math.pow(normalizedX, 2);

                // Longitudinal curve - nail droops toward tip following finger arc
                // v=0 is tip, v=1 is cuticle; droop increases toward tip
                let longitudinalDroop = 0;
                if (v < 0.5) {
                    const droopProgress = (0.5 - v) / 0.5;  // 0 at middle, 1 at tip
                    longitudinalDroop = -Math.pow(droopProgress, 1.5) * 0.06;  // Gentle downward curve
                }

                const z = curveFactor * nailCurve + nailThickness + cuticleZDip + longitudinalDroop;

                vertices.push(x, y, z);
                uvs.push(u, v); // Natural UV mapping
            }
        }

        // Single surface faces
        for (let iy = 0; iy < segmentsY; iy++) {
            for (let ix = 0; ix < segmentsX; ix++) {
                const a = ix + (segmentsX + 1) * iy;
                const b = ix + (segmentsX + 1) * (iy + 1);
                const c = (ix + 1) + (segmentsX + 1) * (iy + 1);
                const d = (ix + 1) + (segmentsX + 1) * iy;

                indices.push(a, d, b);
                indices.push(b, d, c);
            }
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    getShapeWidth(shape, progress) {
        switch (shape) {
            case NAIL_SHAPES.ROUND:
                // Gentle rounded taper - not too pointy
                // Use a smoother curve that maintains width longer
                const roundCurve = 1 - Math.pow(progress, 1.8) * 0.6;
                return Math.max(0.4, roundCurve);

            case NAIL_SHAPES.SQUARE:
                // Maintain full width, slight rounding at very end
                if (progress > 0.9) {
                    return 1 - (progress - 0.9) * 0.5;
                }
                return 1.0;

            case NAIL_SHAPES.ALMOND:
                // Smooth almond taper
                return 1 - progress * 0.55;

            case NAIL_SHAPES.STILETTO:
                // Sharp point
                return Math.pow(1 - progress, 1.3);

            case NAIL_SHAPES.COFFIN:
                // Taper then flat tip
                if (progress < 0.6) {
                    return 1 - progress * 0.35;
                }
                return 0.79;

            default:
                return 1.0;
        }
    }

    getShapeExtension(shape, progress) {
        const maxExtension = 0.2;

        switch (shape) {
            case NAIL_SHAPES.STILETTO:
                return progress * maxExtension * 1.2;

            case NAIL_SHAPES.COFFIN:
                return progress * maxExtension * 0.6;

            case NAIL_SHAPES.ALMOND:
                return progress * maxExtension * 0.4;

            case NAIL_SHAPES.ROUND:
                // Slight extension for natural look
                return progress * maxExtension * 0.2;

            case NAIL_SHAPES.SQUARE:
                return progress * maxExtension * 0.1;

            default:
                return progress * maxExtension * 0.2;
        }
    }

    setShape(shape) {
        if (this.currentShape === shape) return;

        this.currentShape = shape;

        const newGeometry = this.createNailGeometry(shape);
        this.nailMesh.geometry.dispose();
        this.nailMesh.geometry = newGeometry;

        if (this.overlayMesh) {
            this.overlayMesh.geometry.dispose();
            this.overlayMesh.geometry = newGeometry.clone();
        }
    }

    setFingerType(fingerType) {
        const newConfig = FINGER_CONFIGS[fingerType];
        if (!newConfig || newConfig.id === this.fingerConfig.id) return;

        this.fingerConfig = newConfig;

        // Rebuild all components for new finger
        if (this.fingerMesh) {
            this.fingerMesh.geometry.dispose();
            this.fingerMesh.geometry = this.createFingerGeometry(newConfig);
            this.fingerMesh.position.set(0, -newConfig.length * 0.40, 0);
        }

        this.updateNailForFinger();
        this.updateCuticleForFinger();
    }

    updateNailForFinger() {
        const config = this.fingerConfig;
        const nailBaseZ = this.getNailBaseZ(config);

        // Update nail
        const newGeometry = this.createNailGeometry(this.currentShape);
        if (this.nailMesh) {
            this.nailMesh.geometry.dispose();
            this.nailMesh.geometry = newGeometry;
            // Use same positioning as in createNail()
            const nailBedY = -config.length * 0.52;
            this.nailMesh.position.set(0, nailBedY, nailBaseZ);
        }

        // Update overlay
        if (this.overlayMesh) {
            this.overlayMesh.geometry.dispose();
            this.overlayMesh.geometry = newGeometry.clone();
            this.overlayMesh.position.copy(this.nailMesh.position);
        }

        // Recreate lunula texture for new finger proportions
        this.createLunula();
    }

    updateCuticleForFinger() {
        // Cuticle mesh removed - nail now embeds into finger naturally
        // No separate cuticle geometry to update
    }

    setPolishColor(color) {
        this.polishColor = new THREE.Color(color);
        this.nailMaterial.color = this.polishColor;

        // Reduce transmission when polish is applied
        this.nailMaterial.transmission = 0.05;
        this.nailMaterial.roughness = 0.1;
        this.nailMaterial.clearcoat = 1.0;
        this.nailMaterial.clearcoatRoughness = 0.05;

        // Hide lunula texture when polish is applied
        this.nailMaterial.map = null;
        this.nailMaterial.needsUpdate = true;
    }

    setFinish(type) {
        this.finishType = type;

        switch (type) {
            case 'matte':
                this.nailMaterial.roughness = 0.8;
                this.nailMaterial.clearcoat = 0.0;
                this.nailMaterial.metalness = 0.0;
                this.nailMaterial.transmission = 0.0;
                break;

            case 'shimmer':
                this.nailMaterial.roughness = 0.2;
                this.nailMaterial.clearcoat = 1.0;
                this.nailMaterial.metalness = 0.3;
                this.nailMaterial.transmission = 0.0;
                break;

            case 'chrome':
                this.nailMaterial.roughness = 0.05;
                this.nailMaterial.clearcoat = 1.0;
                this.nailMaterial.metalness = 0.9;
                this.nailMaterial.transmission = 0.0;
                break;

            case 'holographic':
                this.nailMaterial.roughness = 0.1;
                this.nailMaterial.clearcoat = 1.0;
                this.nailMaterial.metalness = 0.4;
                this.nailMaterial.iridescence = 1.0;
                this.nailMaterial.iridescenceIOR = 1.5;
                this.nailMaterial.transmission = 0.0;
                break;

            case 'glossy':
            default:
                this.nailMaterial.roughness = 0.1;
                this.nailMaterial.clearcoat = 1.0;
                this.nailMaterial.clearcoatRoughness = 0.05;
                this.nailMaterial.metalness = 0.0;
                if (!this.polishColor) {
                    this.nailMaterial.transmission = 0.15;
                }
                break;
        }

        this.nailMaterial.needsUpdate = true;
    }

    clearPolish() {
        this.polishColor = null;
        this.nailMaterial.color = this.baseColor;
        this.nailMaterial.roughness = 0.25;
        this.nailMaterial.clearcoat = 1.0;
        this.nailMaterial.metalness = 0.0;
        this.nailMaterial.transmission = 0.15;

        // Restore lunula texture
        if (this.lunulaTexture) {
            this.nailMaterial.map = this.lunulaTexture;
            this.nailMaterial.needsUpdate = true;
        }
    }

    getMesh() {
        return this.group;
    }

    getNailBaseZ(config) {
        // Position nail above the finger surface
        // Raised so nail is fully visible from all angles
        return config.tipRadius * 0.62;
    }

    getNailMesh() {
        return this.nailMesh;
    }
}
