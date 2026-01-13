/**
 * BrushEffects.js
 * Visual effects and sounds for the 3D polish brush
 * Includes particle system for paint splatter and enhanced audio
 */
import * as THREE from 'three';
import { soundManager } from '../../audio/SoundManager.js';

// Particle configuration
const PARTICLE_CONFIG = {
  maxParticles: 50,         // Maximum particles in pool
  particlesPerContact: 2,   // Particles spawned per bristle contact
  particleSize: 0.003,      // Base particle size
  particleLife: 0.5,        // Seconds before particle fades
  spreadVelocity: 0.02,     // How fast particles spread
  gravity: -0.05,           // Downward acceleration
};

// Sound configuration
const SOUND_CONFIG = {
  brushInterval: 200,       // ms between brush sounds (longer for smoother feel)
  minPitch: 0.8,           // Minimum pitch variation
  maxPitch: 1.2,           // Maximum pitch variation
};

/**
 * Particle class for paint droplets
 */
class Particle {
  constructor() {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.color = new THREE.Color();
    this.life = 0;
    this.maxLife = PARTICLE_CONFIG.particleLife;
    this.size = PARTICLE_CONFIG.particleSize;
    this.active = false;
  }

  spawn(position, color, velocity) {
    this.position.copy(position);
    this.color.copy(color);
    this.velocity.copy(velocity);
    this.life = this.maxLife;
    this.size = PARTICLE_CONFIG.particleSize * (0.5 + Math.random() * 0.5);
    this.active = true;
  }

  update(deltaTime) {
    if (!this.active) return;

    // Apply velocity
    this.position.addScaledVector(this.velocity, deltaTime);

    // Apply gravity
    this.velocity.y += PARTICLE_CONFIG.gravity * deltaTime;

    // Decay life
    this.life -= deltaTime;

    if (this.life <= 0) {
      this.active = false;
    }
  }

  getOpacity() {
    return this.active ? this.life / this.maxLife : 0;
  }
}

/**
 * BrushEffects manages particles and audio for the polish brush
 */
export class BrushEffects {
  constructor(scene) {
    this.scene = scene;

    // Temporary vectors (initialize first, needed by createParticleMesh)
    this._tempVec = new THREE.Vector3();
    this._tempColor = new THREE.Color();
    this._tempMatrix = new THREE.Matrix4();

    // Particle pool
    this.particles = [];
    for (let i = 0; i < PARTICLE_CONFIG.maxParticles; i++) {
      this.particles.push(new Particle());
    }
    this.nextParticle = 0;

    // Particle mesh (instanced spheres)
    this.particleMesh = null;
    this.createParticleMesh();

    // Current color
    this.color = new THREE.Color('#ff2a6d');

    // Sound state
    this.lastSoundTime = 0;
    this.audioInitialized = false;
  }

  /**
   * Create instanced mesh for particles
   */
  createParticleMesh() {
    const geometry = new THREE.SphereGeometry(1, 6, 4);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });

    this.particleMesh = new THREE.InstancedMesh(
      geometry,
      material,
      PARTICLE_CONFIG.maxParticles
    );
    this.particleMesh.name = 'PaintParticles';
    this.particleMesh.frustumCulled = false;

    // Initialize all instances as invisible (scale 0)
    for (let i = 0; i < PARTICLE_CONFIG.maxParticles; i++) {
      this._tempMatrix.makeScale(0, 0, 0);
      this.particleMesh.setMatrixAt(i, this._tempMatrix);
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;

    this.scene.add(this.particleMesh);
  }

  /**
   * Set the particle color
   */
  setColor(color) {
    this.color.set(color);
    if (this.particleMesh?.material) {
      this.particleMesh.material.color.copy(this.color);
    }
  }

  /**
   * Emit particles at contact points
   * @param {Array} contacts - Contact points from BristleSystem
   */
  emitAtContacts(contacts) {
    if (!contacts || contacts.length === 0) return;

    // Limit particles per frame
    const particlesToEmit = Math.min(
      contacts.length * PARTICLE_CONFIG.particlesPerContact,
      5 // Max per frame
    );

    for (let i = 0; i < particlesToEmit; i++) {
      const contact = contacts[i % contacts.length];
      this.emitParticle(contact.position, contact.normal);
    }
  }

  /**
   * Emit a single particle
   */
  emitParticle(position, normal) {
    const particle = this.particles[this.nextParticle];
    this.nextParticle = (this.nextParticle + 1) % PARTICLE_CONFIG.maxParticles;

    // Random velocity perpendicular to normal
    this._tempVec.set(
      (Math.random() - 0.5) * PARTICLE_CONFIG.spreadVelocity,
      (Math.random() - 0.5) * PARTICLE_CONFIG.spreadVelocity,
      (Math.random() - 0.5) * PARTICLE_CONFIG.spreadVelocity
    );

    // Add some velocity along normal (away from surface)
    this._tempVec.addScaledVector(normal, PARTICLE_CONFIG.spreadVelocity * 0.5);

    particle.spawn(position, this.color, this._tempVec);
  }

  /**
   * Update all particles
   */
  update(deltaTime) {
    let needsUpdate = false;

    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];

      if (particle.active) {
        particle.update(deltaTime);
        needsUpdate = true;

        // Update instance matrix
        const scale = particle.size * particle.getOpacity();
        this._tempMatrix.makeTranslation(
          particle.position.x,
          particle.position.y,
          particle.position.z
        );
        this._tempMatrix.scale(this._tempVec.set(scale, scale, scale));
        this.particleMesh.setMatrixAt(i, this._tempMatrix);
      } else {
        // Hide inactive particles
        this._tempMatrix.makeScale(0, 0, 0);
        this.particleMesh.setMatrixAt(i, this._tempMatrix);
      }
    }

    if (needsUpdate) {
      this.particleMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Play brush sound with throttling
   * Uses squishy wet paint sound instead of beeps
   * @param {number} pressure - Current brush pressure (0-1)
   */
  playBrushSound(pressure = 0.5) {
    const now = performance.now();
    if (now - this.lastSoundTime < SOUND_CONFIG.brushInterval) return;
    this.lastSoundTime = now;

    // Initialize audio on first sound
    if (!this.audioInitialized) {
      soundManager.init();
      this.audioInitialized = true;
    }

    // Play squishy polish brush sound
    soundManager.playPolishBrush(pressure);
  }

  /**
   * Clear all particles
   */
  clear() {
    for (const particle of this.particles) {
      particle.active = false;
    }

    // Reset all instance matrices to invisible
    for (let i = 0; i < PARTICLE_CONFIG.maxParticles; i++) {
      this._tempMatrix.makeScale(0, 0, 0);
      this.particleMesh.setMatrixAt(i, this._tempMatrix);
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Set visibility
   */
  setVisible(visible) {
    if (this.particleMesh) {
      this.particleMesh.visible = visible;
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.particleMesh) {
      this.particleMesh.geometry.dispose();
      this.particleMesh.material.dispose();
      this.scene.remove(this.particleMesh);
    }
  }
}
