# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Margaret's Nail Salon is a browser-based nail salon game for kids (ages 2-11) built with Three.js. Players can shape nails, apply polish, add decorations (stickers, glitter, gems), and draw freehand designs.

## Commands

```bash
npm run dev      # Start Vite dev server with HMR
npm run build    # Production build to dist/
npm run preview  # Preview production build locally
```

## Architecture

### Core Application Flow

`src/main.js` contains `NailArtistApp`, the main controller that:
- Initializes the 3D scene and nail model
- Manages tool state and switching between tools
- Renders tool-specific option panels dynamically
- Handles UI events (toolbar, action buttons, gallery modal)

### Scene Layer (`src/scene/`)

- **NailScene.js**: Three.js scene setup with gradient background, studio lighting (key, fill, rim, bounce lights), OrbitControls with constrained rotation/zoom, and raycaster helper for click detection
- **NailModel.js**: Procedural nail geometry with shape morphing (round, square, almond, stiletto, coffin), MeshPhysicalMaterial for polish effects (glossy, matte, shimmer, chrome, holographic), and overlay mesh for brush tool textures
- **ModelLoader.js**: GLTF/GLB model loader utility with Draco compression support, caching, and progress callbacks. Singleton `modelLoader` for loading external 3D models (e.g., hand models, decorations). Place model files in `public/models/`

### Tools Layer (`src/tools/`)

Each tool follows a consistent pattern:
- Constructor takes `(scene, camera, nail)`
- `activate()`/`deactivate()` methods for tool switching
- Event handlers for pointer interaction
- Uses raycasting to detect nail surface hits

Currently implemented:
- **BrushTool.js**: Freehand drawing using a 1024x1024 canvas texture mapped to nail overlay

Partially implemented (constructors exist, commented out in main.js):
- FileTool, StickerTool, GlitterTool, GemTool

### Audio (`src/audio/SoundManager.js`)

Singleton `soundManager` uses Web Audio API oscillators for synthetic sound effects (no audio files needed). Methods: `playClick()`, `playPolish()`, `playFileSound()`, `playStickerPop()`, `playSparkle()`, `playGemClink()`, `playSuccess()`.

### UI Structure

HTML overlay (`index.html`) with:
- Left sidebar toolbar for tool selection
- Right options panel (content injected dynamically per tool)
- Bottom action bar (clear, undo, done, gallery)
- Modal for gallery view

CSS in `styles/main.css` with CSS custom properties for theme colors.

## Design System

See `docs/DESIGN.md` for:
- Color palette (bubblegum pink `#FF69B4` primary, pastels, gradients)
- Typography (Baloo 2 font family)
- 48px minimum touch targets
- Animation keyframes (bounce, sparkle, float)

Primary target: tablet in landscape orientation.
