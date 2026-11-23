# Brush feel baseline (B0) and B1 input results

Numbers from `scripts/brush-feel.mjs` (brush plan B0). "Base" is `immersive-upgrade` at
`8cdd623` (the plan commit), built and served with `npx vite preview`. "B1" is branch `b01`
with the new `BrushInputHandler.js` (engine, film and rig unchanged).

```
npm run build && npx vite preview --port 4411 --strictPort &
node scripts/brush-feel.mjs                      # all 4 runs: high/low x mouse/touch, ~12 min
node scripts/brush-feel.mjs --tiers=low --inputs=touch --quick --gate=B1   # ~2 min
```

Options: `[url]` (default `http://localhost:4411/`), `--tiers=high,low`, `--inputs=mouse,touch`,
`--out=dir` (default `$TMPDIR/brush-feel`: one JSON per run, `summary.json`, screenshots),
`--gate=A,B1` (which lines set the exit code), `--quick` (skips the 12-stroke scrub, the load
tests and perf), `--no-perf`, `--no-shots`. `CHROME_PATH` overrides the headless shell.
Every run boots with `?perf=1` (no ghost finger, no auto-advance, no camera sway), 1280x720.

**Machine caveat.** These runs shared 4 cores with the B2/B3/B4 harnesses (load average 5 to
10). Frame rates swing (native frames 17 to 160 ms), so frame-rate-dependent numbers
(samples per frame, points per zig-zag, perf) move from run to run. `scripts/perf.mjs` back to
back, low tier, `?perf=1`: base 30.6 / 27.3 ms painting, B1 30.5 / 29.3 ms (noise).

## How each measure is taken

- **Input**: CDP `Input.dispatchMouseEvent` / `dispatchTouchEvent` at 120 Hz, *pipelined* (not
  awaited one by one), so several events land between two frames and Chrome coalesces them like a
  real device. Awaiting each call (the scratch scripts) delivered about 1 event per frame.
- **Deposit point**: `polishBrush3D.debug.depositScreen` when B5 provides it, else
  `inputHandler.tip/result.surfacePoint` projected. **Tip**: `debug.tipScreen`, else
  `bristleSystem.tipCenter`, else the centroid of the bristle tip joints (local or world space is
  detected against `tipCenter`).
- **Fan width / axis**: principal axis of the projected bristle tips (extent along it = fan
  width; its angle = width axis). Engine-agnostic, so A11 does not depend on `debug.axisAngle`.
- **Dye**: 8-bit blit into a 256 target, mapped to the screen through a per-pixel raycast map of
  the nail (built once; the camera holds still). "Painted" = alpha > 128.
- **A3**: a single texel is read back in the same frame at `tip.uv` (costly, so only a few
  frames per run).
- **A4 corner error**: distance from each true zig-zag corner to the polyline of points the engine
  consumed (all `samples` once the B5 debug hook exists, else the newest deposit per frame).
- **A8**: per edge, 10 to 90% of the band's peak alpha, median over the stroke, skipping edges
  clipped by the nail outline. `softPx` (pixels between 8 and 92%, both edges together) is the
  scratch scripts' number and is what section 1 quotes.
- **A10**: dry out by scrubbing the centre line without lifting (1.4, 2.6 and 5 nail-lengths),
  clear the paint mid-press, lay one cuticle-to-tip pass and compare it with a loaded pass.
- **A11 trail**: (mid-joint centroid minus tip centroid) along the motion, minus the same at rest
  just after the press; negative = bristles behind the tip.
- **A17**: `renderer.render` calls into a render target per frame (the harness's own excluded).
- **A19**: row luminance across the band in a screenshot, detrended, peaks counted.

## Section 1 reproduced (base)

Nail on screen: 158 px wide (155 at the stroke columns), 211 px long. Plan figures in brackets.

| # | Measure | Base, harness | Plan section 1 |
|---|---|---|---|
| 1 | Bristle tips vs paint point (mouse, c2t) | 46.6 px below, 11.2 right (high); 46.1 / 12.5 (low) | 48 below, 12 right |
| 2 | Touch paint above the finger | 40 px, falling to 0 near the top edge | 40 -> 0 |
| 2 | Touch 12-stroke scrub coverage | 71.2% (high), 71.6% (low) | 72% |
| 3 | Brush pose / handle height | width axis fixed per run, does not follow the stroke; rig 152.9 px tall | fixed; ~150 px |
| 4 | Stripe width, mouse | 22 px of 155 = 14.2% (high), 24 px = 15.5% (low) | 22 of 152 = 14.5% |
| 4 | Coverage 1 / 3 / 12 strokes, mouse | 13.6% / 41.0% / 85.9% (high); 14.7 / 42.7 / 87.9 (low) | 14 / 39 / 87% |
| 5 | Bristle fan pressed vs stripe | 41.9 vs 22 px (high) | 41 vs 22 |
| 6 | Wet vs 2.5 s later | 0.0% mean change | < 0.6% |
| 6 | Soft edge (softPx) slow / fast | 6 / 20 px (high); 4 / 9 (low) | 6 / 22 |
| 7 | Load after 5 strokes | 1.0 -> 0.34; width and alpha unchanged (A10 ratios ~1.0) | 1.0 -> 0.3, unchanged |
| 8 | Tap / hold 1 s | 1.0% / 1.1% (high) | 1.3% / 1.3% |
| 9 | Samples used per frame; biggest step at 20 fps | 1; 86 px (zig-zag, high), 85 (low) | 1; 98 px |
| 9 | Points per fast zig-zag (consumed) | 9 to 43 of ~73 delivered (frame-rate dependent) | 11 |
| fine | Camera motion while painting | 0 | 0.0002 |
| fine | Low tier perf (harness, loaded box) | 19.6 -> 27.8 ms (+8.2) | 23.2 -> 29.9 (+6.7) |

All within 10% of the plan except where the plan's figure is itself frame-rate dependent
(steps and points per zig-zag; see the machine caveat) and the tap (1.0 vs 1.3%, a 1-2 texel dot).

## Section 6 on base ("Now")

`node scripts/brush-feel.mjs http://localhost:4415/` (base build), final harness:

| Line | high-mouse | high-touch | low-mouse | low-touch | Target |
|---|---|---|---|---|---|
| A1 tip to paint (px) | 46.4 mean, 53 max | 37.2 / 52.5 | 45.6 / 54.4 | 36.6 / 53.6 | <= 3 / <= 6 |
| A2 paint vs pointer | 0 | 0..40 | 0 | 0..40 | 0 / 12 +/- 1 |
| A3 dye < 0.5 at newest deposit | 0 of 2 | 0 of 6 | 0 of 12 | 0 of 17 | 0 |
| A4 gap cols / corner err px (native, 20 fps) | 0/37, 0/54 | 0/52, 0/55 | 0/20, 0/24 | 0/34, 0/52 | 0 / <= 4 |
| A5 band / nail; fan / band | 14.2%; 1.91 | 11.6%; 2.02 | 15.5%; 2.01 | 12.9%; 2.11 | 34 +/- 3%; 1 +/- 0.1 |
| A6 cover 1 / 3 strokes; covered | 13.6 / 41.0%; no | 11.7 / 33.7%; no | 14.7 / 42.7%; no | 11.9 / 35.0%; no | >= 30 / >= 90%; fires |
| A7 tap / hold growth | 1.0% / x1.1 | 0.8% / x1.25 | 1.0% / x1.0 | 0.8% / x1.13 | >= 3% / x1.25 |
| A8 edge 10-90 px slow / fast | 3 / 4 | 3 / 3 | 2 / 4 | 2 / 3 | <= 3, wobble |
| A9 relief | no film | no film | n/a | n/a | ridges, -80% in 1.2 s |
| A10 width 1.4 NL; width/alpha 2.6 NL; dry cov; refill 0.5 s | 1.05; 1.05/1.05; 0.98; 0.75 | 1.11; 1.06/1.01; 0.99; 0.75 | 0.96; 0.96/1.0; 0.97; 0.72 | 1.0; 1.0/1.0; 1.01; 0.79 | >= 0.97; <= 0.92; >= 0.5; 1 |
| A11 axis err 120 ms after turn; trail L/R/D/U px | 30; -0.3/-0.3/-7.3/-1.7 | 51; -1.8/-0.6/-1.5/-6.6 | 27; -0.2/0.4/-6.1/-3.1 | 2; -1.8/-0.1/-0.1/-8.3 | <= 15; all < -1 |
| A12 leave+return: painted parts; edge gap; engine strokes | 0.99/1; 1; 2 | 0.68/0.76; 0; 2 | 1/1; 0; 2 | 0.68/0.77; 0; 2 | >= 0.9; <= 4; 1 |
| A13 camera; second finger | 0; - | 0; 28 px jump | 0; - | 0; 28 px jump | 0; ignored |
| A14 low perf, painting vs idle | | | +8.2 ms (19.6 -> 27.8), p95/avg 1.80 | | <= +8; <= 1.6 |
| A15 high perf, painting | 70.8 ms | | | | <= 85 |
| A16 heap growth; programs | 0 MB; 29 -> 29 | | 0 MB; 28 -> 28 | | <= 2 MB; no new |
| A17 off-screen passes paint / idle | 14 / 0 | 14 / 0 | 2 / 0 | 4 / 0 | <= 3 (low 1) / 0 |
| A18 core alpha 1 / 2 passes; dev | 0.93 / 1.0; 12% | 0.94 / 1.0; 12% | 1.0 / 1.0; 0.7% | 1.0 / 1.0; 2.8% | 0.55-0.70 / >= 0.85; <= 4% |
| A19 highlight lines fresh / 1.5 s | 2 / 2 | 0 / 0 | n/a | n/a | >= 8 / 0 |

A3 passes on base because today's splat lands in the same frame. A12's mouse "painted" values
look fine on base because the old engine restarts a stroke on the first valid frame; the
engine-strokes count (2) is the failure. A13's second finger makes the brush jump 28 px.

## B1 results (branch `b01`)

Full run on the B1 build, then a touch rerun after the last input fix (`--tiers=high,low
--inputs=touch --quick`). Lines owned by B2 to B5 are unchanged from base, as expected.

| Line | high-mouse | high-touch | low-mouse | low-touch | Target |
|---|---|---|---|---|---|
| B1.samples: samples/frame at native fps (events/frame); used of expected at 20 fps | 6.1 (8.3) @83 ms; 1.02 | 4.1 (7.3) @117 ms; 1.02 | 5.4 (6.2) @50 ms; 1.02 | 3.3 (3.6) @33 ms; 1.02 | >= 2; all up to cap 8 |
| B1.nudge: touch paint above finger | - | 12..12 px | - | 12..12 px | 12 +/- 1 |
| B1.curves: samples off path / under-cap events missing / corner err (input's own), native; 20 fps | 0 / 0 (40) / 10.6 (6.0); 0 / 0.8 (25) / 6.1 (6.0) | - | 0 / 0 (31) / 13.6 (7.5); 0 / 0 (58) / 3.0 (3.0) | - | <= 2 / <= 1 |
| B1.leave: strokeStart / edge samples / edge err | 1 / 2 / 0.4 px | 1 / 2 / 0.5 px | 1 / 2 / 0.4 px | 1 / 2 / 0.5 px | 1 / 2 / <= 2 |
| B1.offstart: strokeStart / entry edges | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| B1.finger: deposit off finger-1 path | - | 0 px | - | 0 px | <= 1 |
| B1.raycasts: max per frame | 12 (cap 8) | 12 | 12 | 12 | <= cap + 4 |
| B1.hover: tip.hover over the nail | 39 of 39 | - | 45 of 45 | - | all |
| A2 | 0 | 12..12 | 0 | 12..12 | 0 / 12 +/- 1 |
| A13 | 0; - | 0; 0 | 0; - | 0; 0 | 0; ignored |

Reading B1.curves: every delivered event in a frame with at most `maxSamples` events is a sample
(0 px). Frames with more events are subsampled by design (plan B1), which is why the corner error
against the samples can exceed the input's own corner error when this box drops to 10 fps; at
120 Hz input the input itself already cuts a fast zig-zag's corners by 3 to 7.5 px, so A4's
<= 4 px is measured against the ideal path and may need B5 to judge it against the input's own.

Not yet measurable through B1 alone (the old engine still paints the newest point per frame and
ends a stroke off the nail): A4, A12's single engine stroke. B5 consumes `samples` and closes them.

## API for B5 (plan 4.2, as built)

```
input = new BrushInputHandler(camera, canvas, { maxSamples })   // or input.setMaxSamples(settings.strokeSamplesMax ?? 8)
input.beginFrame(nailMesh)       // once per frame, before reading anything below
input.sampleCount                // new on-nail samples, oldest first (<= maxSamples + edge crossings, <= SAMPLE_ROWS = 24)
input.samples                    // Float32Array, stride SAMPLE_STRIDE = 8:
                                 //   u, v, wx, wy, wz, tMs, edge, dir
                                 //   tMs: ms since this stroke's press; edge 1 at a nail-outline crossing;
                                 //   dir +1 entry (start a fresh chain here), -1 exit (end the chain here), 0 otherwise
input.down                       // tracked pointer pressed after this frame's samples
input.strokeStart / strokeEnd    // press / release seen this frame (one strokeStart per press, even off the nail)
input.onNail                     // newest pressed sample is on the nail
input.tip                        // === input.result: surfacePoint, surfaceNormal, uv, hasUV, isValid, isTouch,
                                 //   pressure (0.35 -> 1 in 65 ms, pen = real), hover (mouse/pen over the nail, not pressed)
input.touchLift                  // 12 (nudged) or 0 (raw point at the nail's top edge) for the newest touch sample
input.stats                      // counters: frames, events, samples, raycasts, lastRaycasts, maxRaycasts, strokes
TOUCH_NUDGE_PX = 12              // exported; touchLiftPx()/TOUCH_LIFT kept for game.feature.js until B5 updates it
```

`getBrushTransform(nailMesh)` still works (it runs `beginFrame` if nobody did this frame), so the
old engine keeps running until B5 swaps to `beginFrame`.
