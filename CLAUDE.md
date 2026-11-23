# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Margaret's Nail Salon: a Three.js nail salon game for kids aged 2 to 11,
built for the Poki web portal. One huge glossy nail under a ring light, a fat
wet brush, clients who ask for a look in pictures, and a reveal that ends in a
polaroid on the wall. **No text for the player anywhere** (numerals only):
icons, colour, motion and sound. No network requests: every asset is made in
code (inline SVG, CSS, Web Audio, procedural textures) except the hand GLBs.

```bash
npm run dev      # Vite dev server
npm run build    # production build to dist/ (base './', relative URLs)
npm run preview  # serve dist/
```

## Architecture

### Spine (`src/core`, created in `src/main.js`)

`window.app` is the `NailArtistApp` in `src/main.js`. Services every module
uses (stable contract, see `docs/upgrade/build-plan.md` section 0.4):

| Service | What |
|---|---|
| `app.scene` | `NailScene` (scene, camera, renderer, OrbitControls, focus animation) |
| `app.nail` | `HandModel` (two hands, five nails each, per-nail paint targets, finishes, skin tone) |
| `app.polishBrush3D` | the polish brush: bristle physics + GPU fluid sim |
| `app.events` | `GameEvents` (`on`, `off`, `once`, `emit`, `listenerCount`); event names in `EVENTS` |
| `app.loop` | `FrameLoop`: the only `requestAnimationFrame`; `add(fn, order)`, `invalidate()` (render on demand) |
| `app.quality` | `Quality`: tier `high/medium/low`, `settings` table, auto-downgrade |
| `app.storage` | `Storage`: the only `localStorage` access (try/catch, in-memory fallback) |
| `app.sound` | `soundManager` (Web Audio only, master gain, `setMuted(m, 'user'|'ad')`) |
| `app.mode` | `'round'` (the game, default) or `'free'` (the sandbox, behind the door icon) |

Features: `src/main.js` ends `init()` by installing every
`src/features/*.feature.js` (sorted by `export const order`). New behaviour
goes in a new feature file that imports its own CSS; it talks to the rest
through `app.*` services and events, not by editing `main.js`.

| Feature | Order | Adds |
|---|---|---|
| `salon` | 10 | desk, contact shadow, deferred shader warm-ups |
| `audio` | 20 | wires every sound to events |
| `brushJuice` | 60 | sparkles, wet-to-cure, the dryer (UV lamp) button, gem/sticker pops |
| `game` | 70 | round mode: client requests (`src/game`), bubble, stars, bottle tray, Done heart, ghost finger, door |
| `fingerPan` | 72 | smart pan between the five fingers (drag off the nail, flick, tap a nail or a dot), on NailScene's finger rail |
| `reveal` | 75 | the Slay reveal and the polaroid wall (`src/reveal`) |

The close-up (`NailScene.focusPose`) looks at the nail face-on with the camera
rolled (its `up` vector) so the finger runs down the screen: cuticle up, free
edge down, the brush coming in from the lower right. Camera flights ease the
roll (`beginFlight`, `rollToward`); the reveal and the bowl roll back upright.
The finger rail (`railPose`, `railGlideTo`) blends the five
focus poses that pans and finger changes glide along.

Main events: `tool:change`, `nail:select`, `mode:change`, `brush:strokeStart`,
`brush:stroke` (per frame, reused payload), `brush:strokeEnd`, `nail:coverage`,
`nail:covered`, `nail:cured`, `deco:placed`, `ui:done`, `ui:gallery`, `ui:mute`,
`roundStart` / `roundEnd` (the future Poki gameplayStart/Stop hooks),
`reveal:request`, `reveal:start`, `reveal:flash`, `reveal:done`.

### Quality tiers

`src/core/Quality.js` picks `high`, `medium` or `low` (URL `?tier=`, then the
saved tier, then GPU/CPU heuristics) and steps down at runtime when the median
frame is slow. Every module reads `app.quality.settings` at init and on
`quality:change` (pixel ratio, sim resolutions, bristles, shader defines,
backdrop, particles...). Table: build plan section 2.

### Scene, tools, UI

- `src/scene`: `NailScene`, `HandModel` + `NailMaterial` (custom nail shader:
  paint map, wetness, finishes, reveal pulse), `SkinMaterial`,
  `SalonEnvironment` (code-built env map), `Backdrop`, `ContactShadow`,
  `ModelLoader`, `Warmup`.
- `src/tools`: `PolishBrush3D/` (brush, bristles, input, fluid sim, wet cure),
  `StickerTool`, `GemTool`, `BrushTool` (free-mode pen on the decoration canvas).
- `src/ui`: round mode `RequestBubble`, `StarMeter`, `GhostFinger`; free mode
  `panels/` (`PolishPanel`, `BlingPanel`, `DrawPanel`, `FingerMap`, `icons`),
  built once by `main.js` into `index.html`'s chrome.
- Styles: `styles/main.css` (base, free-mode chrome, layout system: landscape,
  small landscape <= 420 px tall, portrait; 48 px targets, 40 px only at
  640x360), plus each feature's own CSS (`game.css`, `juice.css`, `reveal.css`).

## Rules (from the build plan, section 0.3 and 4)

- No text for the player; `aria-label` for accessibility only.
- No per-frame allocations in hot paths; no `console.log` per frame.
- No shader compiles after `app.__ready` (pre-warm); no post-processing.
- Infinite CSS animations only on `transform`/`opacity`, at most two at once.
- `localStorage` only through `app.storage`; game playable with it blocked.
- No external hosts, no SDK/ads/analytics yet; caps: JS <= 900 KB raw /
  250 KB gzip, CSS <= 45 KB.

## Perf harness

`scripts/perf.mjs` (Playwright, headless Chrome on SwiftShader, 1280x720,
blocks and counts requests to other hosts):

```bash
npm run build && npx vite preview --port 4208 --strictPort &
cd scripts && node perf.mjs "http://localhost:4208/?perf=1" label
```

It needs `window.app`, `app.__ready`, `app.nail.getNailMesh()`,
`app.scene.camera`, `app.polishBrush3D.raycaster` and a `[data-tool="polish"]`
element (kept in the DOM even when hidden). URL flags: `?perf=1` (continuous
rendering, no ghost finger or auto-advance, short intro), `?tier=high|medium|low`
(forced tier), `?mode=free` (start in the sandbox). Standard runs: `?perf=1`,
`?perf=1&tier=low`, `?perf=1&tier=high`.

`scripts/brush-feel.mjs` (stroke feel, gates A1..A20 and B1; strokes laid out
in the nail's on-screen frame) and `scripts/pan.mjs` (the finger pan: drag,
flick, tap, rubber band, paint-never-pans, round rules, glide frame time) run
against the same preview server.
