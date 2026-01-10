/**
 * SoundManager.js
 * Handles all game audio - sound effects and background music
 * Uses Howler.js for cross-browser audio support
 */
import { Howl, Howler } from 'howler';

// Sound effect configurations
const SOUNDS = {
    // Filing sounds - multiple variations for variety
    file: {
        src: ['/audio/file.mp3'],
        volume: 0.6,
        rate: 1.0,
    },

    // Polish application
    polish: {
        src: ['/audio/polish.mp3'],
        volume: 0.5,
    },

    // Sticker placement
    stickerPlace: {
        src: ['/audio/pop.mp3'],
        volume: 0.7,
    },

    // Glitter spray
    glitter: {
        src: ['/audio/sparkle.mp3'],
        volume: 0.4,
    },

    // Gem placement
    gemPlace: {
        src: ['/audio/clink.mp3'],
        volume: 0.6,
    },

    // UI clicks
    click: {
        src: ['/audio/click.mp3'],
        volume: 0.4,
    },

    // Success/completion
    success: {
        src: ['/audio/success.mp3'],
        volume: 0.6,
    },
};

class SoundManager {
    constructor() {
        this.sounds = {};
        this.music = null;
        this.musicEnabled = true;
        this.sfxEnabled = true;
        this.initialized = false;

        // We'll use Web Audio API oscillators for immediate sound feedback
        // until we have proper audio files
        this.audioContext = null;
    }

    init() {
        if (this.initialized) return;

        // Create AudioContext for synthetic sounds
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio API not supported');
        }

        this.initialized = true;
        console.log('🔊 Sound Manager initialized');
    }

    // Ensure audio context is running (needed after user interaction)
    resume() {
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    // Generate a synthetic filing sound
    playFileSound(intensity = 0.5) {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        // Create a "scratchy" filing sound using noise + filter
        const duration = 0.08;
        const now = this.audioContext.currentTime;

        // Create noise buffer
        const bufferSize = this.audioContext.sampleRate * duration;
        const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3;
        }

        // Create source
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;

        // Filter to make it sound more like filing
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2000 + intensity * 3000; // Higher pitch when filing faster
        filter.Q.value = 1.5;

        // Gain envelope
        const gain = this.audioContext.createGain();
        gain.gain.setValueAtTime(0.15 * intensity, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

        // Connect nodes
        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.audioContext.destination);

        source.start(now);
        source.stop(now + duration);
    }

    // UI click sound
    playClick() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;

        // Simple "pop" sound
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start(now);
        osc.stop(now + 0.1);
    }

    // Polish swipe sound
    playPolish() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;
        const duration = 0.3;

        // Smooth "swish" sound
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        const filter = this.audioContext.createBiquadFilter();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(300, now);
        osc.frequency.exponentialRampToValueAtTime(150, now + duration);

        filter.type = 'lowpass';
        filter.frequency.value = 800;

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start(now);
        osc.stop(now + duration);
    }

    // Sticker pop sound
    playStickerPop() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;

        // Bubbly "pop" sound
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.15);

        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start(now);
        osc.stop(now + 0.15);
    }

    // Sparkle/glitter sound
    playSparkle() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;

        // High-pitched shimmer
        for (let i = 0; i < 3; i++) {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();

            osc.type = 'sine';
            const baseFreq = 2000 + Math.random() * 2000;
            osc.frequency.setValueAtTime(baseFreq, now + i * 0.03);

            gain.gain.setValueAtTime(0.08, now + i * 0.03);
            gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.03 + 0.1);

            osc.connect(gain);
            gain.connect(this.audioContext.destination);

            osc.start(now + i * 0.03);
            osc.stop(now + i * 0.03 + 0.1);
        }
    }

    // Gem placement clink
    playGemClink() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;

        // Crystal-like "clink"
        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(2500, now);
        osc.frequency.exponentialRampToValueAtTime(1800, now + 0.2);

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start(now);
        osc.stop(now + 0.2);
    }

    // Success fanfare
    playSuccess() {
        if (!this.sfxEnabled || !this.audioContext) return;

        this.resume();

        const now = this.audioContext.currentTime;

        // Happy arpeggio
        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6

        notes.forEach((freq, i) => {
            const osc = this.audioContext.createOscillator();
            const gain = this.audioContext.createGain();

            osc.type = 'sine';
            osc.frequency.value = freq;

            const startTime = now + i * 0.1;
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.2, startTime + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.3);

            osc.connect(gain);
            gain.connect(this.audioContext.destination);

            osc.start(startTime);
            osc.stop(startTime + 0.3);
        });
    }

    // Toggle sound effects
    toggleSFX() {
        this.sfxEnabled = !this.sfxEnabled;
        return this.sfxEnabled;
    }

    // Toggle music
    toggleMusic() {
        this.musicEnabled = !this.musicEnabled;
        if (this.music) {
            if (this.musicEnabled) {
                this.music.play();
            } else {
                this.music.pause();
            }
        }
        return this.musicEnabled;
    }

    // Set master volume
    setVolume(volume) {
        Howler.volume(volume);
    }
}

// Export singleton instance
export const soundManager = new SoundManager();
