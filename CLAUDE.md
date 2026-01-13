# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NAIL ICON is a browser-based nail salon game for kids (ages 2-11) built with Three.js. Players can shape nails, apply polish, add decorations (stickers, gems), and draw freehand designs on a 3D hand model.

## Commands

```bash
npm run dev      # Start Vite dev server with HMR
npm run build    # Production build to dist/
npm run preview  # Preview production build locally
```

## Architecture

### Core Application Flow

`src/main.js` contains `NailArtistApp`, the main controller that:
- Initializes the 3D scene and hand model
- Manages tool state and switching between tools
- Renders tool-specific option panels dynamically
- Handles finger selection with click-to-zoom camera animations
- Handles UI events (toolbar, action buttons, gallery modal)

### Scene Layer (`src/scene/`)

- **HandModel.js**: Primary 3D model adapter that loads GLB hand models with 5 independent nails per hand. Supports dual-hand (left/right) switching, nail shape morphing, polish materials (glossy, matte, shimmer, chrome), and per-nail canvas overlay textures for drawing. Exports `FINGERS` and `NAIL_SHAPES` constants.
- **NailScene.js**: Three.js scene setup with gradient background, studio lighting (key, fill, rim, bounce lights), OrbitControls with constrained rotation/zoom, camera focus animations for nail zoom, and raycaster helper for click detection.
- **ModelLoader.js**: GLTF/GLB model loader utility with Draco compression support and caching. Singleton `modelLoader` instance. Place model files in `public/models/`.
- **FingerConfig.js**: Shared constants for finger order and defaults.

### Tools Layer (`src/tools/`)

Each tool follows a consistent pattern:
- Constructor takes `(scene, camera, nail)` where `nail` is HandModel instance
- `activate()`/`deactivate()` methods for tool switching
- Event handlers for pointer interaction (mouse + touch)
- Uses raycasting to detect nail surface hits and convert to UV coordinates

Active tools:
- **PolishTool.js**: Realistic nail polish painting with layer support (base coat, color coats, top coat). Tracks coverage percentage and drying state per layer.
- **PolishBrush3D/**: 3D nail polish brush with bristle physics. Subsystem includes:
  - `PolishBrush3D.js`: Main controller coordinating bristle system, input handling, and paint application
  - `BristleSystem.js`: Instanced mesh bristles with CPU Verlet physics for realistic bending/splaying
  - `BrushInputHandler.js`: Maps pointer input to 3D brush position via raycasting against nail mesh
  - `BristlePaintApplicator.js`: Applies paint to canvas from bristle contact points
  - `BrushEffects.js`: Particle effects and audio feedback for brush strokes
  - `WetPaintMaterial.js`: Wet paint highlight overlay effect
- **BrushTool.js**: Freehand drawing on a 1024x1024 canvas texture. Multiple pen types: solid, dotted, metallic, rainbow, glitter (sparkle spray), marker. Size slider and color palette.
- **StickerTool.js**: Places emoji stickers on nail surface at tap position.
- **GemTool.js**: Places 3D gems/rhinestones on nail surface.

### State Layer (`src/state/`)

- **NailDesignStore.js**: Manages nail designs for all 10 fingers (5 per hand). Stores shape, polish color, finish type, and canvas data URL. Persists to localStorage.
- **PolishLayerState.js**: Manages multi-layer polish state per nail. Tracks 4 layers (base coat, color 1, color 2, top coat) with coverage maps, drying timers, and undo history. Exports `POLISH_LAYERS` and `LAYER_ORDER` constants.

### Audio (`src/audio/SoundManager.js`)

Singleton `soundManager` uses Web Audio API oscillators for synthetic sound effects (no audio files needed). Key methods: `playClick()`, `playPolish()`, `playStickerPop()`, `playSparkle()`, `playGemClink()`, `playSuccess()`, and pen-specific sounds (`playDrawSolid()`, `playDrawMetallic()`, etc.).

### UI Structure

HTML overlay (`index.html`) with:
- Top header with title
- Finger selector bar (hand toggle + 5 finger buttons)
- Left sidebar toolbar for tool selection
- Right options panel (content injected dynamically per tool)
- Bottom action bar (lock, clear, undo, done, gallery)

CSS in `styles/main.css` with CSS custom properties for theme colors.

## Design System

See `docs/DESIGN.md` for color palette, typography (Fredoka/Bungee fonts), and 48px minimum touch targets.

Primary target: tablet in landscape orientation.
