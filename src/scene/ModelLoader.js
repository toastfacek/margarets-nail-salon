/**
 * ModelLoader.js
 * Utility for loading GLTF/GLB 3D models into the scene
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

class ModelLoader {
  constructor() {
    this.gltfLoader = new GLTFLoader();

    // Optional: Set up Draco decoder for compressed models
    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    this.gltfLoader.setDRACOLoader(this.dracoLoader);

    // Cache for loaded models
    this.cache = new Map();
  }

  /**
   * Load a GLTF/GLB model
   * @param {string} url - Path to the model file
   * @param {Object} options - Loading options
   * @param {boolean} options.useCache - Whether to cache the model (default: true)
   * @param {Function} options.onProgress - Progress callback
   * @returns {Promise<THREE.Group>} The loaded model
   */
  async load(url, options = {}) {
    const { useCache = true, onProgress } = options;

    // Check cache first - disabled for now due to clone issues
    // if (useCache && this.cache.has(url)) {
    //   return this.cache.get(url).clone();
    // }

    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        url,
        (gltf) => {
          const model = gltf.scene;

          // Store animations if present (but not the full gltf to avoid circular refs)
          model.userData.animations = gltf.animations;
          // Don't store gltf itself - causes circular reference issues with clone()

          // Cache the model
          if (useCache) {
            this.cache.set(url, model);
          }

          // Return directly without clone for first load
          // Clone only from cache on subsequent loads
          resolve(model);
        },
        (progress) => {
          if (onProgress) {
            const percent = (progress.loaded / progress.total) * 100;
            onProgress(percent);
          }
        },
        (error) => {
          console.error(`Failed to load model: ${url}`, error);
          reject(error);
        }
      );
    });
  }

  /**
   * Load a model and add it directly to a scene
   * @param {string} url - Path to the model file
   * @param {THREE.Scene} scene - Scene to add the model to
   * @param {Object} options - Position, rotation, scale options
   * @returns {Promise<THREE.Group>} The loaded model
   */
  async loadAndAdd(url, scene, options = {}) {
    const {
      position = { x: 0, y: 0, z: 0 },
      rotation = { x: 0, y: 0, z: 0 },
      scale = 1,
      ...loadOptions
    } = options;

    const model = await this.load(url, loadOptions);

    model.position.set(position.x, position.y, position.z);
    model.rotation.set(rotation.x, rotation.y, rotation.z);

    if (typeof scale === 'number') {
      model.scale.setScalar(scale);
    } else {
      model.scale.set(scale.x, scale.y, scale.z);
    }

    scene.add(model);
    return model;
  }

  /**
   * Clear the model cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Dispose of the loader and free resources
   */
  dispose() {
    this.dracoLoader.dispose();
    this.cache.clear();
  }
}

// Export singleton instance
export const modelLoader = new ModelLoader();

// Also export the class for custom instances
export { ModelLoader };
