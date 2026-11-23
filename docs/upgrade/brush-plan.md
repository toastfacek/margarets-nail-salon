# Brush fix plan: make the polish brush feel like a real brush

Owner feedback after playing `immersive-upgrade`: "the brush is really unintuitive. it is messed up. doesn't feel like using a real brush. Make it 100x more realistic."

He is right. I played the build (headless Chrome, SwiftShader, 1280x720, `?tier=high` and `?tier=low`, mouse and real touch events, 15 stroke types each) and measured it. Summary in one line: **the paint does not come out of the bristles, the stripe is a thin marker line, and the brush never behaves like a brush.**

Reference numbers used below: the focused index nail is 200 x 152 px on screen (152 px is its width, cuticle is on the right, tip on the left).

---

## 1. What feels wrong (worst first)

| # | In plain words | Measured |
|---|---|---|
| 1 | **The paint does not come out of the bristles.** Paint appears at the neck of the handle. The bristle tips hang about 50 px lower, so you are "painting with the stick". | Bristle tips sit 48 px below and 12 px right of the paint point (a third of the nail's width). Same in every direction, both tiers. |
| 2 | **On a touch screen the paint lands far from the finger, and the gap keeps changing.** The game pushes the paint up so the finger does not hide it, but by a lot, and by less near the top of the nail, so the paint speeds up and slows down under the finger. | Paint lands 40 px above the finger (26% of the nail), shrinking to 0 px near the top edge. Three evenly spaced finger strokes left the bottom third of the nail bare. 12 strokes only reached 72% coverage. |
| 3 | **It does not look or move like a brush.** It lies flat, pointing straight down the screen, in the same pose whichever way you move. Bristles never drag behind. The handle is a big purple cone that covers the paint you just made. | Brush angle is identical in all 15 stroke types (rotation never changes). Handle is about 150 px tall, the size of the nail. |
| 4 | **The stripe is far too thin.** It is a marker line, not a brush stroke. A real brush covers a nail in 3 strokes. | Stripe is 22 px wide on a 152 px nail (14%, a real brush is about a third). One stroke covers 14% of the nail, three strokes 39%, twelve strokes 87%, and it never reaches the edges. |
| 5 | **The bristles and the paint disagree about width.** Press down and the bristles fan out wide, but the stripe stays thin. | Bristle fan is 41 px wide when pressed, stripe is 22 px. |
| 6 | **The paint is a flat sticker.** No thickness, no brush marks, no wet pool, nothing melts smooth. Fast strokes get blurry edges; borders of a filled nail look lumpy. | Wet vs 2.5 s later: under 0.6% pixel change (nothing levels). Edge blur is 6 px on a slow stroke, 22 px on a fast one. |
| 7 | **The brush never runs out.** The little bead on the tip shrinks, but the paint looks identical forever. There is no dip. | Bead goes 1.0 -> 0.3 after about 5 strokes; stripe width and opacity unchanged. |
| 8 | **A tap makes a tiny dot, and holding does nothing.** A real brush leaves a brush-shaped print and a growing bead. | Tap covers 1.3% of the nail. Holding 0.9 s: still 1.3%. |
| 9 | **Fast curvy strokes turn into straight lines.** The game only looks at where the finger is once per picture, and throws away the in-between points the browser gives it. | 1 pointer sample used per frame. On a slow device (20 fps) the paint jumps up to 98 px in one step; a zig-zag gets 11 points. |
| 10 | Small things: drops of polish float in mid-air off the nail; a second finger on the screen makes the brush jump to it; a stroke dies if the finger slides off the nail and comes back; nothing shows where the brush will land before you press. | From code and screenshots. |

**What is already fine (keep it):** no gaps or dots in lines at any speed (0 empty columns); with a mouse the paint is exactly under the pointer (0 px) in the same frame; the camera does not move while painting (0.0002 units); low tier paints at +6.7 ms over scene-only (23.2 -> 29.9 ms on the harness, budget is +8).

---

## 2. Root causes (code)

| # | Cause | Where |
|---|---|---|
| 1, 3 | The brush group is placed with its **ferrule** at the hit point and rotated only about world Z (`group.rotation.set(0, 0, tilt)`). Bristles run along local +Z, which is world +Z, which is "down the screen" for our top-down camera. So the brush lies parallel to the desk, never leans, never turns, and its tips are one bristle length away from the deposit point. | `BristleSystem.setBrushTransform()`, `BrushInputHandler.getBrushTransform()` (`TIP_OFFSET`, `out.position`) |
| 3 | Bristle physics runs in the group's local space, so moving the brush gives the joints no inertia. Friction acts on local tip velocity, which is zero. Nothing can trail. | `BristleSystem.stepPhysics()`, `handleCollision()` |
| 2 | `touchLiftPx()` lifts by up to 40 px / 20% of the nail and tapers to 0 at the top edge, with a 3-step fallback. The bristles then sit under the finger and the handle over the paint. | `BrushInputHandler.js` (`TOUCH_LIFT`, `getBrushTransform`) |
| 4, 5 | The splat is a round capsule, radius 0.085 (v units), fully opaque only to 62% of that, with no link to the bristle fan width. Pressure changes it by 30%. | `PolishBrush3D._splat()`, `BRUSH_RADIUS`, `dyeSplatFragment` |
| 6 | The dye is colour + coverage only; there is no thickness. The "fluid" is a smoke-style velocity field that smears the coverage edge (the lumps) and does nothing a viscous lacquer does. The edge fade is a fixed 38% of the radius, and velocity splats blur it more at speed. The shader turns coverage into a hard on/off (`smoothstep(0.03, 0.45, a)`) so streaks can never show. | `FluidSimulator.js`, `NailMaterial.js` |
| 7 | `load` only drives the bead mesh size. It floors at 0.3 and is never read by the splat. | `PolishBrush3D.update()` (`LOAD_*`), `BristleSystem.updateBead()` |
| 8 | A zero-length splat is one small disc, and `update()` only splats again after the pointer has moved more than a texel. | `PolishBrush3D.update()` |
| 9 | `onPointerMove` overwrites one position; `update()` reads it once per frame. `getCoalescedEvents()` is not used. | `BrushInputHandler.js` |
| 10 | `pointerleave` ends the stroke and there is no pointer capture; any pointer id drives the brush; an invalid hit ends the stroke (`_endStroke()`), a new one needs the next frame's hit. Droplets spawn from every contact point at speed, with free-flying velocity. | `BrushInputHandler.attach()`, `PolishBrush3D.update()`, `BrushEffects.emitFromStroke()` |

---

## 3. The target: how it should feel

One rule above all: **the paint comes out of the bristle tips, and the bristle tips are where the finger (or cursor) is.**

The model, in order of what the player notices:

1. **A flat brush that presses into a paddle.** At rest the head is a narrow flat tab with a bead of polish on the tip. Press and the bristles fan into a paddle about a third of the nail wide. The paddle's front edge is the line where paint is laid.
2. **A band, not a line.** Paint is laid as a smooth band exactly as wide as the fanned bristles, with soft, slightly irregular edges. Three strokes (centre, one side, other side) give the nail its first, sheer coat; going over it again makes it solid.
3. **The brush leans and drags.** The handle leans back at about 45 degrees and rises toward the top of the screen (clear of a finger). The flat side turns to face across the stroke. Bristles bend and trail behind the motion and flip smoothly when you reverse.
4. **Wet paint has body.** Fresh strokes are mirror-wet, with thin bright highlight streaks along the stroke from fine bristle ridges, and a thicker rounded rim; a bead pools where the brush lands or rests. Within about a second the ridges melt away and the coat is smooth and glossy.
5. **The brush runs dry, gently.** After about 3 nail-lengths of stroke the band gets streaky and narrower. Lifting the brush re-dips it by itself (bead grows back, soft "plop"). It never stops painting completely, so a toddler scrubbing without lifting still makes progress.
6. **Touch is finger painting.** Paint lands at the fingertip (a small, constant nudge toward the tip of the finger, never a moving offset). The band is wider than the fingertip, so paint shows on both sides of the finger, and the handle sticks out above it.

### 3.1 The owner's visual reference

The owner said "I want it to look and feel like this" and pointed at a YouTube close-up of a real flat polish brush on a real nail ("How To Actually Paint Perfect Nails", NailKnowHow). **The video itself could not be viewed** (YouTube put a bot check in front of the player). What we have is one frame he sent, `reference-brush-1.png` in this folder, and notes from the transcript in `brush-reference.md`. The owner was clear that the point is how it **looks**, not the technique in the transcript, so `brush-reference.md` is background only (we do not teach "free edge first"). More frames may follow; B4 and B3 should re-check against them.

What the frame shows, and what each thing means for us:

| In the frame | So the game must |
|---|---|
| The nail fills most of the picture; it is a real close-up. | Frame the nail bigger while painting (B6). |
| A **first coat that is sheer**: lavender you can see the nail plate through. | Lay sheer coats that build: one pass is about 60% opaque, a second pass over it is solid (B2, B4, B5). |
| The fresh patch is **wet and glossy, with bright thin highlight streaks running along the stroke** and fine brush lines. | Fine bristle ridges in the wet relief, lit as thin specular streaks along the stroke, that melt flat as it levels (B2, B4). |
| The patch edge is **soft and slightly irregular**, not a stamped shape. | Band edges and stroke ends wobble a little with the bristle tips (B2). |
| The brush is a **flat fan that widens to a squared-off tip, with individual strands visible, darker and wetter toward the tip**, held at an angle, trailing. | Rig shape, strand shading and pose (B3). |
| The fan is roughly 35 to 40% of the nail's width. | Band 34 to 38% at full pressure (B5 constant). |

Design decisions already made (do not re-litigate in the WPs):

- **Touch offset: constant 12 CSS px up, everywhere.** Browsers report the centre of the contact patch; people feel they point with the pad just above it. 12 px puts the band centre there. If the nudged point misses the nail but the raw point hits, use the raw point. No taper, no 40 px lift.
- **No predicted events for paint or brush.** Predicted points overshoot on direction changes and would paint where the finger never went. Tip and paint both use the newest real sample in the same frame, so they can never disagree. Smoothness comes from coalesced samples.
- **Sizes are fractions of the active nail's width** (same game feel on thumb and pinky): band 34% at full pressure, 20% at the lightest touch; the brush mesh scales with it.
- **The smoke-style fluid sim is removed from the brush** (the swirl bowl keeps `FluidSimulator`). It is replaced by direct band deposit plus a cheap levelling pass. This is both more real and cheaper.
- **Coats are sheer and build.** One pass lays `COAT_ALPHA = 0.62`; passes add up with the normal "over" blend (two passes 0.86, three 0.95). Segments of one stroke tile without overlap (B2), so a single stroke is one even sheer coat, not a string of darker blobs. Coverage for stars and `nail:covered` still counts the first coat, so a kid is never punished for a sheer nail. `COAT_ALPHA` is one constant in B5; if the owner finds one-coat nails too pale at the reveal, raise it there.
- **Low tier gets the same feel** (band, pose, load, touch) and skips only the relief/levelling look.

---

## 4. Shared contracts (read before starting any WP)

These let the WPs run in parallel. Names without a leading underscore, because the build mangles `_lower` members (`vite.config.js`, `mangleProps`).

**4.1 Units.** "Nail plane units" = UV scaled by `(aspect, 1)` exactly as today's splat radius ("v units"). `nailWidthV` = the nail's width expressed in those units (derive once per bind from the nail's `uNailHalf`/`uNailSide` and UV extent; do not assume which of u or v runs along the finger, check it).

**4.2 Input -> engine** (`BrushInputHandler`, B1):

```
input.beginFrame(nailMesh)        // resolve queued pointer samples for this frame
input.sampleCount                 // 0..8 new on-nail samples this frame, oldest first
input.samples                     // Float32Array, stride 8: u, v, wx, wy, wz, tMs, edge(0/1), pad
input.down                        // tracked pointer is pressed
input.strokeStart / strokeEnd     // true for the frame the press / release was seen
input.tip                         // reused object for the newest sample: surfacePoint, surfaceNormal, uv,
                                  //   hasUV, isValid (on the nail), isTouch, pressure (0..1), hover (bool)
```

**4.3 Engine -> film** (`PolishFilm`, new file, B2). Same dye I/O names as `FluidSimulator` so the swap in `PolishBrush3D` is mechanical:

```
getTexture() loadDye(tex|null) saveDye(target) fill(color, a) clear() blit(src, dst, uvT)
setQuality({ dyeRes, dyeType, filmRes }) -> bool   prewarm()   onContextRestored()   dispose()
getFilmTexture()                  // relief map, null when filmRes === 0 (low)
beginStroke(colorSRGB, seed)
addSegment(ax, ay, bx, by, axisX, axisY, hw, hl, seamX, seamY, flags, dryA, dryB, bead, coat)
flush()                           // one draw call per target for everything queued this frame
tick(dt) -> bool                  // levelling; true while it still needs frames
isAwake()
```

`axis` = unit vector of the brush's width direction in nail plane units. `hw`/`hl` = half width / half contact length. `seam` = direction of the previous segment (for the start clip). `flags`: bit0 clip at start seam, bit1 clip at end, bit2 start cap (landing), bit3 end cap (lift). `dry` 0 (loaded) .. 1 (dry). `bead` 0..1 extra relief (landing / pooling). `coat` = alpha of one pass.

**4.4 Engine -> rig** (`BristleSystem`, B3):

```
bristles.setPose(pose)   // reused object, fields:
  point, normal          // world contact point on the nail, surface normal
  axis                   // world unit vector, brush width direction (in the tangent plane)
  velocity               // world tangent-plane velocity of the contact point (units/s)
  halfWidth              // world half width of the paint band right now (tips must span exactly this)
  pressure, load         // 0..1
  contact                // bool: touching the nail (false = hovering above `point`)
  isTouch                // bool
  scale                  // active nail width in world units
```

Kept as today: `group`, `setVisible`, `setColor`, `setLoad`/`load`, `configure`, `update(dt)`, `isAtRest()`, `contactPoints`/`contactCount`, `dispose`. New read-only for the harness: `tipCenter` (world Vector3, centroid of the tip line).

**4.5 Shader** (`NailMaterial`, B4): new uniforms `uFilmMap` (sampler), `uHasFilm` (0/1). Film texture: R = relief height 0..1 (0 = flat), G = local freshness 0..1. `HandModel.setFilmTexture(hand, finger, texture|null)`.

**4.6 Quality keys** (B4 adds to `Quality.computeSettings`; everyone else reads with a default): `filmRes` high 256, medium 192, low 0; `strokeSamplesMax` high 8, medium 6, low 4. `fluidSimRes`, `pressureIterations`, `noFlow` stay (the bowl reads them).

**4.7 Debug hook for the harness** (B5): `app.polishBrush3D.debug` = `{ tipScreen:[x,y], depositScreen:[x,y], halfWidthPx, axisAngle, load, dry }`, refreshed each frame only when `?perf=1` or `window.__brushDebug` is set.

---

## 5. Work packages

### B0. Feel harness (measure what the player feels)

**Files owned:** `scripts/brush-feel.mjs` (new), `docs/upgrade/brush-baseline.md` (new, the numbers).

Port my scratch scripts (`/tmp/claude-0/-home-user/31320adc-44b8-5899-aa49-8d697a898d91/scratchpad/brush/lib.mjs`, `play.mjs`, `analyze.mjs`; the scratchpad can be wiped, so do this first) into one script in the style of `scripts/perf.mjs`:

- Boots `?tier=high|low`, mouse and touch (`hasTouch` context + CDP `Input.dispatchTouchEvent`), finds the nail box by raycast scan.
- Stroke set: cuticle-to-tip slow (1600 ms) / medium (450) / fast (110), tip-to-cuticle, side-to-side both ways, tap (60 ms), hold (900 ms), start off the nail, end off the nail, leave-and-return, diagonal through, fast zig-zag (8 turns in 600 ms), three strokes (centre, +28%, -28% of nail width), 12-stroke scrub, 20 nail-lengths without lifting.
- Per frame records pointer position, deposit point and bristle-tip centroid (screen px), band half width, axis angle, load, camera position. Reads through `app.polishBrush3D.debug` (4.7); until B5 lands it falls back to the current fields (note: `_private` names are mangled in the build).
- Reads the dye back through an 8-bit blit (`film.blit` into a 256 target, `readRenderTargetPixels`) and maps it to the screen by raycast grid: band width, centre offset, gap columns, edge width (10-90%), coverage, wet-vs-settled difference. Reads the film texture the same way for relief RMS.
- Prints one JSON line per stroke and a pass/fail table against section 6. Saves cropped screenshots (wet, +2.5 s, mid-stroke pose in 4 directions).

**Done when:** it reproduces the baseline numbers in section 1 on the current branch (within 10%), and exits non-zero when a section 6 line fails.

### B1. Input: every sample, one finger, never drop the stroke

**Files owned:** `src/tools/PolishBrush3D/BrushInputHandler.js`.

- **Capture and identity.** `setPointerCapture` on `pointerdown`; track that `pointerId` only until its `pointerup`/`pointercancel` (other pointers are ignored: palm and second-finger rejection). Remove the `pointerleave` listener. `lostpointercapture` ends the stroke.
- **Every sample.** Queue raw samples into a preallocated ring (`Float32Array`, 64 x [clientX, clientY, timeStamp]). Use `pointerrawupdate` where `'onpointerrawupdate' in window`, otherwise `pointermove` + `getCoalescedEvents()` (the browser's own array is the one allowed allocation). No smoothing, no averaging.
- **`beginFrame(nailMesh)`.** Drain the ring. If more than `strokeSamplesMax` are queued, keep the newest and an even subsample of the rest. Raycast each kept sample to the nail (brute force, as now) and fill `samples`/`tip` (4.2). The newest sample is always raycast. No allocation: reuse `this._hits`, the result object, the typed array.
- **Touch nudge.** Replace `TOUCH_LIFT`/`touchLiftPx` by `TOUCH_NUDGE_PX = 12` (constant, CSS px, up). If the nudged ray misses and the raw ray hits, use the raw hit. Keep exporting `touchLiftPx` as a function returning the constant nudge clamped to 0 above the nail top, so `game.feature.js` keeps compiling until B5 updates it.
- **Edges.** When a sample is off the nail and the previous one was on it, bisect on screen between the two (4 raycasts) and emit the exit point with `edge = 1`. The stroke stays alive while the pointer is down: when a later sample is on the nail again, bisect the entry point, emit it with `edge = 1` (the engine starts a fresh segment chain there, same stroke). A press that starts off the nail starts painting at the entry point the same way.
- **Pressure.** Keep the ramp (0.35 on down, to 1.0 in about 65 ms), use real `event.pressure` only for `pointerType === 'pen'`.
- **Hover.** For mouse, `tip.hover = true` with a valid surface point when over the nail and not pressed (the rig floats there).

**Acceptance (B0):** samples used per frame >= 2 at 60 Hz with 120 Hz input, and all of them at 20 fps up to the cap; touch deposit is 12 +/- 1 px above the touch point everywhere on the nail; a leave-and-return stroke paints both parts with one `strokeStart`; a second touch does not move the brush; zero allocations of ours in `beginFrame` and the handlers; raycasts per frame <= cap + 4.

### B2. Paint film: band deposit, tiling segments, relief, levelling

**Files owned:** `src/tools/PolishBrush3D/PolishFilm.js` (new). Does not touch `FluidSimulator.js` (the bowl uses it).

- **Targets.** Dye double-free single target at `dyeRes` (same contract as today: premultiplied sRGB colour, alpha = coverage, "over"). Film ping-pong pair at `filmRes` (`RG8`/`RGBA8`, `UnsignedByteType`), not allocated when `filmRes === 0`. Reuse the fullscreen-triangle / rect-quad pattern and the save/restore-renderer-state discipline from `FluidSimulator`. All materials built once in the constructor; `prewarm()` compiles them.
- **Batched segments.** One preallocated geometry with room for 16 segment quads; segment parameters are per-vertex attributes (A, B, axis, hw/hl, seam, flags, dry, bead); the vertex shader places each quad on the segment's bounding box (swept box + rounding + 2 texels). `addSegment` writes floats; `flush()` uploads the whole small buffer and issues **one draw into the dye and one into the film** (film skipped on low). If 16 are queued, flush early.
- **Shape = a rounded box swept along the segment** (exact, cheap). In the brush frame (`ex` = axis, `ey` = perpendicular), with `q` = point relative to A, `dq` = B - A, half sizes `hx = hw - r`, `hy = hl - r`, rounding `r = min(hl, 0.35 * hw)`:

  ```
  m1 = abs(q.x - dq.x*0.5) - (hx + abs(dq.x)*0.5)
  m2 = abs(q.y - dq.y*0.5) - (hy + abs(dq.y)*0.5)
  nd = perp(dq)/|dq|;  m3 = abs(dot(q - dq*0.5, nd)) - (hx*abs(nd.x) + hy*abs(nd.y))   // skipped when |dq| ~ 0
  sd = max(m1, m2, m3) - r
  mask = 1 - smoothstep(-aa, aa, sd)          // aa = 1.25 dye texels: crisp but soft
  ```

- **Segments tile, they do not overlap.** Hard clips (no anti-aliasing, so the two sides partition pixels exactly): with flag bit0, discard where `dot(p - A, seam) < 0`; with bit1, discard where `dot(p - B, dir) > 0`. Consecutive segments share the same clip line (through the shared sample, perpendicular to the earlier segment's direction), so a half-transparent (dry) stroke shows no bead-on-a-string dots at the samples. Caps (bit2 landing, bit3 lift) are unclipped zero-length segments: the overlap there is the real "more polish where the brush lands" look. The engine sends a cap pair instead of clips when the direction reverses (dot of directions < -0.3).
- **Across-band coordinate** `s = (q - dq*tau).x / hw` with `tau = clamp(dot(q, dq)/dot(dq, dq), 0, 1)`: drives bristle streaks (two sines + a hashed 1-D noise, about 14 ridges, phase from the stroke seed) and the rim (`smoothstep(0.72, 1.0, abs(s))`).
- **Soft, irregular edge.** Before the mask, wobble the half width by the bristle tips: `hx *= 1.0 + 0.05 * n(s_edge, along)` using a low-frequency hashed noise along the stroke (a few percent, period about one band width), and push the cap ends in and out per bristle by up to `0.25 * hl` (`sd += 0.25 * hl * (bristleHash(s) - 0.5)` on caps). The band must not read as a stamped rounded rectangle.
- **Dye output.** `alpha = mask * mix(1.0, streakGate(s, dry), dry) * coat` (`coat` = per-segment attribute, `COAT_ALPHA` from the engine; caps pass `0.5 * coat` so a landing does not double the coat), with a faint along-stroke streak in alpha (`* (0.94 + 0.06 * ridge(s))`), where `streakGate` opens gaps between bristles as `dry` rises (floor: at `dry = 1` the band still averages about 50% coverage). Colour = stroke colour. Blend exactly as today's dye splat.
- **Film output** (medium/high). Ridges are fine and run along the stroke (constant in `s`, so they are lines along the motion): at least 12 ridges across the band, each at least 4 film texels wide (raise `filmRes` before dropping ridges). `R = mix(R, 0.30 + 0.40*ridge(s) + 0.30*rim + 0.5*bead, mask)`, `G = mix(G, 1.0, mask)` (mask as source alpha).
- **Levelling pass** (`tick`, only while awake): one fullscreen pass at `filmRes`: `R' = mix(R, blur5(R), 0.55) * exp(-dt/0.45)`, `G' = G * exp(-dt/1.6)`. Awake = less than 6 s since the last deposit (a timer, never a readback). Asleep = zero passes.
- **Dye I/O** (`loadDye`, `saveDye`, `fill`, `clear`, `blit`, `setQuality` preserving the dye by blit): port from `FluidSimulator`. `clear()`/`loadDye()` also clear the film.

**Acceptance (B0 + unit page):** a 0.34-wide stroke has edge 10-90% <= 3 screen px at any speed; a `dry = 0.6` stroke drawn as 40 short segments shows no periodic dots (alpha variance along the centreline within 3% of a single long segment); 2 draw calls per painting frame on medium/high, 1 on low, plus at most 1 level pass; zero allocations in `addSegment`/`flush`/`tick`; film relief RMS falls >= 80% within 1.2 s of the last deposit and passes stop within 6 s.

### B3. Brush rig: leans, turns, fans into a paddle, drags

**Files owned:** `src/tools/PolishBrush3D/BristleSystem.js`.

- **Pose from the contact point, not the ferrule.** Build the frame from `pose` (4.4): `N` = normal, `X` = axis, `Y = N x X`. Handle direction `a = normalize(cos(tilt)*N + sin(tilt)*lean)`, where `lean` = the camera's up vector projected into the tangent plane, turned 15 degrees toward screen-right, plus up to 8 degrees toward the smoothed motion direction. `tilt` = 45 degrees (mouse), 35 degrees (touch, clears the finger). Remove `setBrushTransform`'s fixed Z rotation (keep the method as a thin wrapper that fills a pose, for `activate()`).
- **Analytic bristles (replace the Verlet chains).** Each bristle is a quadratic curve from its root on the ferrule to its tip **on the surface**. Tips are laid on the line through `point` along `X`, spanning exactly `2 * halfWidth` (so the fan is always the paint band's width), in 2 to 6 rows offset along the trail direction by up to the contact length. The ferrule sits at `point + a * L * (1 - 0.45*pressure) + N * clearance`. Write joints 0..3 by sampling the curve, then reuse the existing ribbon writer (`updateGeometry`) and its single draw call. Bristle length `L = 0.55 * scale`, rest head width `0.21 * scale`.
- **Drag.** A 2-D "trail" state in the tangent plane follows `-velocity` (direction; magnitude saturates at a walking-pace stroke) with a critically damped spring, about 60 ms. Tips shift along the trail by up to `0.35 * L * pressure`; the curve's control point lags further, so the paddle visibly bends away from the motion and flips through flat on a reversal. On lift, a single under-damped wobble (about 8 Hz, 2 cycles) and the fan closes to the rest width.
- **Looks like the reference brush** (`reference-brush-1.png`): a flat fan that **widens from the ferrule to a squared-off tip** (all rows end on one straight tip line; drop the rounded `tipCurveRadius` profile), with **individual strands visible**. Per-bristle shade varies (hashed, about +/-18%) so strands read as light and dark lines; the wet ramp is reversed from today: **darker, more saturated and glossier toward the tip** where the polish sits, lighter and drier at the ferrule. Under the ribbons add one flat core strip (same mesh, a few extra quads, dark polish colour) so gaps between strands show wet polish, not the nail; this also keeps 32 bristles on low reading as a full fan. Ribbon width on low stays wide enough that strands touch at the tip.
- **Hover.** `contact = false`: tips float `0.25 * L` above `point`, straight, bead hanging. Add a soft dark landing blob on the nail under the tip (one small alpha disc, depth-test on, no new shader: reuse a basic material, prewarmed).
- **Handle.** Replace the cone: flat oval ferrule (polish-cap colour) -> thin stem `0.9 * L` -> the purple cap. With the lean it must not cover the paint point: the cap's nearest screen distance to the tip centroid is >= 60 px at 1280x720.
- **Bead** stays (size from `load`), sits on the tip line centre, squashes on contact, hidden when `load < 0.05`.
- **Kept:** tier bristle counts, `contactPoints` pool (fill from the tips while `contact`), `isAtRest()` (true when hovering/absent pose is unchanged and the spring energy is under a threshold), no allocation in `update`.

**Acceptance (B0):** tip centroid to deposit point: mean <= 3 px, max <= 6 px, in all four directions, mouse and touch; tip span = band width +/- 10%; brush width axis within 15 degrees of perpendicular to the motion 120 ms after a 90 degree turn; trail points against the motion in all four directions; CPU for `update` <= 0.5 ms on low (32 bristles), mesh + rig inside the 2 ms slice; draw calls: bristles 1, bead 1, handle 1, landing blob 1.

### B4. Wet look: thickness, ridges that melt, sheer streaks, fresh gloss

**Files owned:** `src/scene/NailMaterial.js`, `src/scene/HandModel.js` (film uniform plumbing only), `src/core/Quality.js` (keys in 4.6).

- `HandModel.setFilmTexture(hand, finger, tex|null)` sets `uFilmMap`/`uHasFilm`; cleared with the paint.
- **Relief normal from the film** (medium/high). High (`WET_NORMAL_TAPS`): take the 4 taps from `uFilmMap.r` instead of the paint alpha, and add the paint-alpha edge gradient from 2 cheaper taps. Medium (`WET_NORMAL_DERIV`): `dFdx/dFdy` of `film.r + 0.5 * p.a`. Relief strength no longer scales only with `uWet`: `relief = k * (0.35 + 0.65 * max(uWet, film.g))`, so a cured coat keeps a soft rounded edge and a fresh stroke stands proud.
- **Fresh gloss is local.** `wetLocal = max(uWet, film.g)` replaces `uWet` in the top-coat roughness and ring-light terms: the stroke you just made is mirror-wet even while the rest of the nail is tacky.
- **Thickness colour.** `pc *= 1.0 - 0.10 * film.r` (thicker = deeper).
- **Sheer coats.** Coverage is no longer snapped to on/off: `k = p.a` with a light ease (`k = p.a * (1.15 - 0.15 * p.a)`), instead of `smoothstep(0.03, 0.45, p.a)`. One coat (alpha about 0.62) shows the nail plate, its lunula and ridges through the colour like the reference; two coats are solid. Top-coat gloss (`cov`) still reaches full strength by `a = 0.5`, so a sheer coat is as shiny as a solid one.
- **Specular streaks along the stroke.** With the relief normal from fine film ridges, the ring light and key light break into thin bright lines running along the stroke while wet (this is the sparkle in the reference frame). Tune relief gain so the streaks are clearly visible at the default zoom on medium and high, and gone when the film has levelled. On medium, if derivative normals are too coarse to show them, take 2 film taps along the across-stroke direction instead.
- **Let dry streaks show.** The same continuous `k` makes a dry-brush stroke thin where bristles skipped. Check a swirl-bowl print and a filled nail look unchanged (screenshots).
- **Low tier:** only the coverage curve changes (sheer coats work on low; wet streaks do not). No new sampler is read on low (guard with the existing defines so the low program does not grow).
- Prewarm: the tier variants already compile at idle; make sure the new uniforms do not trigger a late compile.

**Acceptance:** low-tier nail shader cost unchanged on the harness (scene-only within +0.3 ms); zero shader compiles after the first interactive frame; side-by-side screenshots: fresh stroke shows ridges + bright rim, same stroke 1.5 s later is smooth; bowl print and `fillNail` unchanged by eye.

### B5. Stroke engine and integration (lands last)

**Files owned:** `src/tools/PolishBrush3D/PolishBrush3D.js`, `src/tools/PolishBrush3D/BrushEffects.js`, `src/tools/PolishBrush3D/WetCure.js`, `src/tools/PolishBrush3D/index.js`, `src/utils/CoverageMap.js`, `src/features/brushJuice.feature.js`, `src/features/game.feature.js` (ghost and intro parts), `src/ui/GhostFinger.js`.

Can start on day one against the contracts in section 4 (stubs), merges after B1 to B4.

- **Swap the sim.** `this.fluidSim` becomes a `PolishFilm` (keep the property name `fluidSim` if anything outside reads it; nothing does today). Remove the velocity splat, `sim.step`, `simEveryNFrames`. Bind/unbind also sets/clears the film texture on the nail. Idle = zero passes.
- **Per frame:** `input.beginFrame()`; walk the new samples; for each consecutive pair update the pose state and call `film.addSegment`; `film.flush()`; `bristles.setPose()` from the newest sample; `film.tick(dt)`.
- **Pose state (no allocation):**
  - Direction: from sample deltas in nail plane units, updated only after 2% of the nail width of travel.
  - Axis: critically damped spring (70 ms) toward perpendicular-to-direction, shortest way modulo 180 degrees. At stroke start the axis is across the nail (the canonical stroke is cuticle to tip).
  - Coat: every segment passes `coat = COAT_ALPHA` (0.62). `fillNail` and the bowl stay fully opaque.
  - Width: `2*hw = nailWidthV * (0.20 + 0.14 * pressure) * (1 - 0.25 * dry)`; `hl = 0.30 * hw`; effective width across the motion never under 60% of `2*hw` (widen `hl` when edge-on).
  - Load: 1 at a dip; minus `travel / (3.2 * nailLength)`; `dry = 1 - smoothstep(0.0, 0.35, load)`.
- **Landing, resting, lifting.** Stroke start: one landing cap (`bead = 0.6`). Pointer down and still: every 100 ms one cap with `hw` +4% (max +25%) and `bead` rising to 1 (the pool), small load cost. Stroke end: one lift cap.
- **Re-dip.** 150 ms after lift the load eases to 1 over 350 ms; emit `brush:dip` (add to `GameEvents`' catalogue comment; the audio feature may hook a soft plop later, do not edit audio files). Picking a colour still dips at once.
- **Coverage.** `CoverageMap.addSegment` with radius = half the effective width across the motion, scaled by `(1 - 0.5*dry)`.
- **`autoStroke`** goes through the same segment path (pressure 0.8, loaded). `game.feature.js` intro: one neat cuticle-side stroke instead of the 8-point zig-zag (a 34% band makes the zig-zag a blob); ghost finger `tipY` uses the constant nudge.
- **Droplets.** `BrushEffects.emitFromStroke`: only on a fast flick off the nail's free edge or a hard reversal, from the tip line, and they fall onto the desk plane instead of hanging in the air. At most 3 per stroke.
- **Debug hook** (4.7).

**Acceptance:** every line of section 6 on `brush-feel.mjs`, plus `perf.mjs` (`?perf=1`, auto, `tier=low`, `tier=high`).

### B6. Close-up framing (small, last)

**Files owned:** `src/scene/NailScene.js` (focus distance only), `styles/game.css` if a layout needs a nudge.

The reference is a close-up; our nail is about 30% of the screen's short side, and on touch the fingertip covers a third of it. Raise `FOCUS_FILL` from 0.34 to 0.46 on coarse pointers and to 0.42 elsewhere, check the bubble, stars, tray and dryer do not overlap the nail at 1280x720, 390x844, 844x390 and 640x360. More nail pixels cost fill rate: the low-tier harness lines (A14) and the mid-phone target (medium, 60 fps) must still hold; if they do not, keep the bigger framing on medium/high and coarse pointers only and say so in the hand-off.

---

## 6. Acceptance criteria (the whole fix)

Measured by `scripts/brush-feel.mjs` at 1280x720 unless noted. "Now" = this branch.

| # | Measure | Now | Target |
|---|---|---|---|
| A1 | Bristle-tip centroid to paint point, same frame | 50 px | mean <= 3 px, max <= 6 px, all directions, mouse and touch |
| A2 | Paint point to pointer | mouse 0 px; touch 0..40 px, varying | mouse 0 px; touch 12 +/- 1 px, constant |
| A3 | Frames between a pointer sample and its paint being in the texture and the brush drawn there | 0 | 0 (dye alpha at the newest deposit point > 0.5 in the frame it is consumed) |
| A4 | Fast zig-zag (3000 px/s) at 20 fps and 60 fps | no gaps, but 1 sample/frame, corners cut | no gap columns; painted centreline within 4 px of the true pointer path |
| A5 | Band width at full pressure / nail width | 14.5% | 34% +/- 3%; bristle fan = band +/- 10% |
| A6 | Coverage (area with any coat): one centre stroke / three strokes | 14% / 39% | >= 30% / >= 90% and `nail:covered` fires |
| A7 | Tap print / hold 1 s | 1.3% dot / no change | >= 3% brush-shaped / grows >= 25% |
| A8 | Edge width (10-90% alpha), slow and fast | 6 px / 22 px | <= 3 px both, with a visible small wobble (not a ruler-straight or stamped edge) |
| A9 | Relief after lift (medium/high) | none | ridges visible at lift; RMS down >= 80% in 1.2 s; 0 passes after 6 s |
| A10 | Load | no effect | full band for the first 2.2 nail-lengths, visibly streaky by 3.2, back to full <= 0.5 s after lift; a dry stroke still covers >= 50% of a loaded one |
| A11 | Brush pose | fixed | width axis within 15 degrees of across-the-stroke 120 ms after a turn; bristles trail in all 4 directions |
| A12 | Leave the nail and come back in one press | stroke ends | both parts painted, paint reaches the edge at exit and entry |
| A13 | Other motion | camera 0; second finger steals the brush | camera 0; second finger ignored |
| A14 | Perf, harness `?perf=1&tier=low` painting vs scene-only | +6.7 ms (23.2 -> 29.9) | <= +8 ms, aim <= +6; p95 <= 1.6x avg |
| A15 | Perf, `tier=high` painting | 90-97 ms | <= 85 ms |
| A16 | Allocations / compiles | flat heap | heap growth <= +2 MB over 6 s painting; zero of our allocations per frame in input, engine, film, rig; zero shader compiles after the first interactive frame |
| A17 | Off-screen work | 2 quads + 2 to 12 sim passes | painting: low 1 draw; medium/high 2 draws + 1 level pass. Idle: 0 |
| A18 | Sheer coats: dye alpha in the band core after one pass / two passes | 1.0 / 1.0 | 0.55 to 0.70 / >= 0.85; no darker dots along a single stroke (alpha along the centreline within +/-4%) |
| A19 | Wet streaks (medium/high) | none | fresh stroke shows >= 8 thin highlight lines along the stroke in a screenshot; none 1.5 s later |
| A20 | Eyes | marker line, flat brush | Fable reviews the screenshot set next to `reference-brush-1.png` (and any later frames): brush fan with visible strands and wet tip, pose in 4 directions, sheer first coat vs second coat, fresh vs settled stroke, three-stroke nail, dry stroke, tap, touch three-stroke |

---

## 7. Order and parallelism

File ownership is disjoint, so these run at the same time:

```
wave 1 (parallel):  B0 harness   B1 input   B2 film   B3 rig   B4 shader + quality keys
                    B5 starts against the section 4 contracts (stubs), no merge yet
wave 2:             B5 integrates B1-B4, runs B0 + perf.mjs, tunes constants
wave 3:             B6 close-up framing
then:               Fable review (A20) with the B0 report
```

Merge order: B0, B4, B2, B1, B3, B5, B6. B1 and B3 each keep a thin compatibility wrapper (`getBrushTransform` / `touchLiftPx`, `setBrushTransform`) so the branch still runs after each merge and before B5 lands.

Rules carried over from `docs/upgrade/build-plan.md`: no per-frame allocations in hot paths, all shaders prewarmed, every off-screen pass restores renderer state, `npm run build` clean, harness output pasted into each hand-off, budget misses listed.

## 8. Not in this plan

Dragging one wet colour into another, a visible bottle to dip into, nail-shape changes, real-device testing (still the next check after this lands).
