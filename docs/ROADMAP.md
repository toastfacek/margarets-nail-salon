# Development Roadmap

## Phase 1: Project Setup & 3D Foundation ⬅️ CURRENT

### Goals
- Vite + Three.js project scaffolding
- Basic 3D scene with lighting
- Stylized nail model
- Camera controls (orbit/pan)

### Files to Create
- `package.json` - Dependencies
- `index.html` - App shell
- `src/main.js` - Entry point
- `src/scene/NailScene.js` - Three.js scene setup
- `src/scene/NailModel.js` - Nail geometry
- `src/scene/Lighting.js` - Studio lighting
- `styles/main.css` - Base styles

### Success Criteria
- [ ] Nail renders on screen
- [ ] Can rotate view around nail
- [ ] Works on tablet viewport

---

## Phase 2: Filing & Shaping System

### Goals
- Satisfying filing mechanic with sound + particles
- Nail shape morphing
- Shape selection UI

### Features
- 5 nail shapes: round, square, almond, stiletto, coffin
- Drag-to-file interaction
- Filing progress indicator
- Particle dust effects
- Sound that varies with filing speed

### Files to Create
- `src/tools/FileTool.js`
- `src/ui/ShapePicker.js`
- `src/audio/SoundManager.js`
- `public/audio/file-*.mp3`

---

## Phase 3: Polish & Color System

### Goals
- Polish application with swipe mechanic
- Color picker with curated palette
- Multiple finish types

### Features
- Swipe-to-paint interaction
- Color gradually fills nail
- Finishes: glossy, matte, shimmer, chrome, holographic
- Base coat / top coat system

### Files to Create
- `src/tools/PolishTool.js`
- `src/ui/ColorPicker.js`

---

## Phase 4: Decorations

### Goals
- Stickers, glitter, 3D gems

### Stickers
- Catalog of cute designs (hearts, stars, flowers, butterflies)
- Drag & drop placement
- Resize & rotate

### Glitter
- Spray-can style application
- Particle system
- Multiple colors & density control

### Gems
- 3D models (diamond, heart, star, pearl)
- Tap to place
- Satisfying click sound

### Files to Create
- `src/tools/StickerTool.js`
- `src/tools/GlitterTool.js`
- `src/tools/GemTool.js`
- `public/textures/stickers/`
- `public/models/gems/`

---

## Phase 5: Art Tools

### Goals
- Freehand drawing on nail surface
- Pattern tools

### Features
- Brush tool with size options
- Eraser
- Undo/redo
- Pattern stamps (stripes, dots, ombre)

### Files to Create
- `src/tools/BrushTool.js`
- `src/tools/PatternTool.js`

---

## Phase 6: UI & Experience Polish

### Goals
- Final UI design
- All sound effects
- Background music
- Animations & juice

### Features
- Large icon toolbar
- Tool-specific option panels
- Cute hover/tap animations
- Spa music (toggleable)
- Sound effects for all interactions

### Files to Create/Update
- `src/ui/Toolbar.js`
- Complete `SoundManager.js`
- All audio assets

---

## Phase 7: Gallery & Export

### Goals
- Save designs to gallery
- Screenshot functionality
- Optional hand preview

### Features
- Capture current nail as image
- LocalStorage gallery
- Grid view of saved designs
- Delete/rename designs
- Download as PNG
- Full hand view mode

### Files to Create
- `src/ui/Gallery.js`
- `src/utils/Screenshot.js`
- `src/utils/Storage.js`
