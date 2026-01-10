/**
 * NailDesignStore.js
 * Manages nail designs for all 10 fingers (5 per hand)
 */

import { FINGER_ORDER, DEFAULT_FINGER, DEFAULT_HAND } from '../scene/FingerConfig.js';

export class NailDesignStore {
    constructor() {
        this.currentHand = DEFAULT_HAND;
        this.currentFinger = DEFAULT_FINGER;

        // Initialize designs for all fingers
        this.designs = this.createEmptyDesigns();

        // Try to load from localStorage
        this.loadFromLocalStorage();
    }

    createEmptyDesigns() {
        const designs = {
            left: {},
            right: {},
        };

        for (const finger of FINGER_ORDER) {
            designs.left[finger] = this.createEmptyDesign();
            designs.right[finger] = this.createEmptyDesign();
        }

        return designs;
    }

    createEmptyDesign() {
        return {
            shape: 'round',
            polishColor: null,
            finishType: 'glossy',
            canvasDataUrl: null,
            timestamp: null,
        };
    }

    getCurrentDesign() {
        return this.designs[this.currentHand][this.currentFinger];
    }

    getCurrentFinger() {
        return this.currentFinger;
    }

    getCurrentHand() {
        return this.currentHand;
    }

    setCurrentFinger(hand, finger) {
        this.currentHand = hand;
        this.currentFinger = finger;
    }

    saveCurrentDesign(designData) {
        const design = this.getCurrentDesign();
        Object.assign(design, designData, { timestamp: Date.now() });
    }

    // Save canvas state as data URL before switching fingers
    saveCanvasState(canvas) {
        const design = this.getCurrentDesign();
        if (canvas) {
            // Use JPEG with moderate quality to save space
            design.canvasDataUrl = canvas.toDataURL('image/png');
            design.timestamp = Date.now();
        }
    }

    // Get canvas data URL for current finger
    getCanvasDataUrl() {
        return this.getCurrentDesign().canvasDataUrl;
    }

    // Restore canvas from data URL
    async restoreCanvas(canvas, ctx) {
        const dataUrl = this.getCanvasDataUrl();
        if (!dataUrl || !canvas || !ctx) return false;

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                resolve(true);
            };
            img.onerror = () => {
                resolve(false);
            };
            img.src = dataUrl;
        });
    }

    // Check if any finger has been designed
    hasAnyDesign() {
        for (const hand of ['left', 'right']) {
            for (const finger of FINGER_ORDER) {
                if (this.designs[hand][finger].timestamp !== null) {
                    return true;
                }
            }
        }
        return false;
    }

    // Clear design for current finger
    clearCurrentDesign() {
        const design = this.getCurrentDesign();
        design.shape = 'round';
        design.polishColor = null;
        design.finishType = 'glossy';
        design.canvasDataUrl = null;
        design.timestamp = null;
    }

    // Clear all designs
    clearAll() {
        this.designs = this.createEmptyDesigns();
        this.saveToLocalStorage();
    }

    // Export all designs
    exportAllDesigns() {
        return JSON.parse(JSON.stringify(this.designs));
    }

    // Import designs
    importDesigns(designs) {
        this.designs = designs;
        this.saveToLocalStorage();
    }

    // LocalStorage persistence
    saveToLocalStorage() {
        try {
            localStorage.setItem('nailDesigns', JSON.stringify(this.designs));
            localStorage.setItem('nailDesignsHand', this.currentHand);
            localStorage.setItem('nailDesignsFinger', this.currentFinger);
        } catch (e) {
            console.warn('Failed to save designs to localStorage:', e);
        }
    }

    loadFromLocalStorage() {
        try {
            const saved = localStorage.getItem('nailDesigns');
            if (saved) {
                const parsed = JSON.parse(saved);
                // Validate structure
                if (parsed.left && parsed.right) {
                    this.designs = parsed;
                }
            }

            const savedHand = localStorage.getItem('nailDesignsHand');
            const savedFinger = localStorage.getItem('nailDesignsFinger');
            if (savedHand && (savedHand === 'left' || savedHand === 'right')) {
                this.currentHand = savedHand;
            }
            if (savedFinger && FINGER_ORDER.includes(savedFinger)) {
                this.currentFinger = savedFinger;
            }
        } catch (e) {
            console.warn('Failed to load designs from localStorage:', e);
        }
    }
}

// Singleton instance
export const nailDesignStore = new NailDesignStore();
