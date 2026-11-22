# 💅 Margaret's Nail Salon

A fun, bubbly browser-based nail salon game for kids! Built with Three.js.

![Status](https://img.shields.io/badge/status-in%20development-pink)
![Target Age](https://img.shields.io/badge/ages-2--11-purple)

## Features

- A client asks for a look in pictures (colour, finish, sticker, how many nails).
- A wet, glossy polish brush with bristles and flowing paint; a UV dryer to cure it.
- One to three stars, never a fail; a Slay reveal and a polaroid on the wall.
- Free mode (the door icon): any colour and finish, stickers, 3D gems, pens.
- No words anywhere: icons, colour, motion and sound. Works from 640x360 to
  phones in portrait, with mouse or touch.

## 🎯 Target Audience

Ages 2-11, designed for:
- Simple, forgiving controls for younger kids
- Deep creative options for older kids
- Satisfying tactile feedback on all interactions

## Tech

Vite, Three.js, Web Audio (all sounds synthesised), HTML/CSS overlays with
inline SVG icons, `localStorage` through `src/core/Storage.js`. No network
requests at runtime.

## 🚀 Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Project structure

```
src/
  main.js        app spine + free-mode chrome; installs src/features/*.feature.js
  core/          GameEvents, FrameLoop, Quality (tiers), Storage
  features/      salon, audio, brushJuice, game (round mode), reveal
  scene/         NailScene, HandModel, nail and skin shaders, salon, backdrop
  tools/         PolishBrush3D (brush + fluid sim), StickerTool, GemTool, BrushTool
  game/          client requests, scoring, round state machine
  reveal/        reveal director, confetti, polaroid camera and wall
  ui/            request bubble, star meter, ghost finger; panels/ (free mode)
  audio/         Web Audio sound manager and recipes
styles/          main.css (layout) + one CSS file per feature
scripts/perf.mjs frame-time harness (see CLAUDE.md)
docs/            DESIGN.md, ROADMAP.md, upgrade/build-plan.md
```

See [docs/ROADMAP.md](docs/ROADMAP.md) for status and
[CLAUDE.md](CLAUDE.md) for the architecture.

## 🎨 Design Guide

See [docs/DESIGN.md](docs/DESIGN.md) for the no-words rule, palette, layouts and motion.

## 📄 License

Private project - All rights reserved
