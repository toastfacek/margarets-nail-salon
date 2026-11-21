/**
 * ModelLoader.js
 * Utility for loading GLTF/GLB 3D models into the scene
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Root-absolute asset paths ('/models/x.glb') would break when the build is
 * served from a sub-path (Poki), so rebase them on Vite's BASE_URL ('./').
 */
function resolveAssetUrl(url) {
  if (url.charAt(0) === '/' && url.charAt(1) !== '/') {
    return import.meta.env.BASE_URL + url.slice(1);
  }
  return url;
}

class ModelLoader {
  constructor() {
    // The hand GLBs are not Draco-compressed, so no decoder is needed (and none
    // may be fetched from another host).
    this.gltfLoader = new GLTFLoader();
  }

  /**
   * Load a GLTF/GLB model
   * @param {string} url - Path to the model file
   * @param {Object} options - Loading options
   * @param {Function} options.onProgress - Progress callback
   * @returns {Promise<THREE.Group>} The loaded model
   */
  async load(url, options = {}) {
    const { onProgress } = options;

    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        resolveAssetUrl(url),
        (gltf) => {
          const model = gltf.scene;

          // Store animations if present (not the full gltf: circular refs)
          model.userData.animations = gltf.animations;
          resolve(model);
        },
        (progress) => {
          if (onProgress && progress.total) {
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
   * Kept for API compatibility; there is no cache any more.
   */
  clearCache() {}

  /**
   * Kept for API compatibility; nothing to free.
   */
  dispose() {}
}

// Export singleton instance
export const modelLoader = new ModelLoader();

// Also export the class for custom instances
export { ModelLoader };
