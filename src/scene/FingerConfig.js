/**
 * FingerConfig.js
 * Proportions and configuration for each finger type
 */

export const FINGER_CONFIGS = {
    thumb: {
        id: 'thumb',
        name: 'Thumb',
        label: '1',
        // Geometry proportions - thumb is shorter and wider
        length: 0.9,
        baseRadius: 0.44,
        tipRadius: 0.32,  // ~73% of base (was 86%)
        // Nail proportions - narrower to fit within finger profile
        nailWidth: 0.62,
        nailLength: 0.65,
        nailCurve: 0.09,  // Curved to match rounded fingertip
    },
    index: {
        id: 'index',
        name: 'Index',
        label: '2',
        length: 1.15,
        baseRadius: 0.36,
        tipRadius: 0.25,  // ~69% of base (was 88%)
        nailWidth: 0.56,
        nailLength: 0.82,
        nailCurve: 0.08,  // Curved to match rounded fingertip
    },
    middle: {
        id: 'middle',
        name: 'Middle',
        label: '3',
        // Middle finger is the longest
        length: 1.30,
        baseRadius: 0.38,
        tipRadius: 0.26,  // ~68% of base (was 89%)
        nailWidth: 0.58,
        nailLength: 0.85,
        nailCurve: 0.08,  // Curved to match rounded fingertip
    },
    ring: {
        id: 'ring',
        name: 'Ring',
        label: '4',
        length: 1.20,
        baseRadius: 0.35,
        tipRadius: 0.24,  // ~69% of base (was 88%)
        nailWidth: 0.54,
        nailLength: 0.80,
        nailCurve: 0.08,  // Curved to match rounded fingertip
    },
    pinky: {
        id: 'pinky',
        name: 'Pinky',
        label: '5',
        // Pinky is the smallest
        length: 0.90,
        baseRadius: 0.30,
        tipRadius: 0.20,  // ~67% of base (was 86%)
        nailWidth: 0.44,
        nailLength: 0.60,
        nailCurve: 0.07,  // Curved to match rounded fingertip
    },
};

// Hand configuration
export const HANDS = {
    left: { id: 'left', name: 'Left Hand' },
    right: { id: 'right', name: 'Right Hand' },
};

// Finger order for UI display
export const FINGER_ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];

// Default finger to show on load
export const DEFAULT_FINGER = 'middle';
export const DEFAULT_HAND = 'left';
