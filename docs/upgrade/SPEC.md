# Margaret's Nail Salon: immersive upgrade spec

Nov 21 2026. Short version for skimming. The full engineering plan (written by Fable 5.2 for the Opus 5.5 builders) is `build-plan.md` in this folder.

## The goal in one line
One huge glossy nail under a ring light, a fat wet brush, and a reveal that makes a five-year-old squeal, running smoothly on a cheap school Chromebook.

## How the work is split
- **Fable 5.2** (planner and reviewer) wrote the plan, splits it into 9 work packages, and reviews every change for looks, speed, kid safety and Poki rules before it lands.
- **Opus 5.5** (builders) write the code, one work package each, on the branch `immersive-upgrade`. Never on `main`.
- **No Blender** is available here, so every new asset is made in code: shaders (small programs that run on the graphics chip and decide the colour of each pixel), textures drawn by code, 3D shapes built in Three.js, and sounds made with the browser's built-in synthesizer.

## What changes, in order
| Step | What the player notices |
|---|---|
| 1. Fast brush | Painting is smooth instead of choppy. Paint no longer wipes stickers. Each finger keeps its own paint. |
| 2. Poki clean-up | Loads faster. No calls to Google for fonts or tools (Poki blocks them). Unused 3D files removed. |
| 3. Gorgeous polish | Wet, glossy polish that reflects a ring light, then hardens to a shine. Shimmer, glitter and chrome finishes. A warm salon background with soft blurry lights. Soft shadow under the hand. |
| 4. Brush juice | Sparkles off the brush, a sparkle burst when the nail is nearly covered, a blow-dryer that turns wet to glossy. |
| 5. Sound | Satisfying brush swish, pops, clinks and a little jingle, all generated in the browser. |
| 6. The loop | Opens straight on a nail with a loaded brush and a ghost finger showing one swipe. A client shows a picture of the look she wants. Paint, then get 1 to 3 stars. Never fail. Next client. |
| 7. The Slay reveal | Lights dim, camera sweeps the fingers, confetti and a flash, then a polaroid drops onto the salon wall (saved on the device only). |
| 8. Icons and small screens | No words, only pictures. Works in portrait and on a 640x360 screen. |
| 9. Stretch: swirl bowl | Drop colours in a bowl, swirl with a finger, dunk the nail for a marble pattern. |

## Speed budget (the rules every change must pass)
Measured with a test that runs the game in a browser with a software graphics chip, which is slow like a cheap Chromebook.

| Measure | Today | Target |
|---|---|---|
| Frame time, no brush | 69 ms (14 fps) | 30 ms or less |
| Frame time, painting | 326 ms (3 fps) | No-brush time plus 8 ms or less |
| Memory growth while painting | +42 MB in 6 seconds | +2 MB or less |
| First download | about 2 MB | 2.2 MB or less (Poki's cap is 8 MB) |
| Requests to outside sites | 1 (Google Fonts) | 0 |

On a real low-end Chromebook the target is 60 fps on the default setting, never under 30 fps while painting.

**Quality tiers:** the game picks high, medium or low quality from the device, and steps down by itself if frames get slow. Low turns off the fancy extras but keeps the wet, glossy look.

## Hard rules
- No text for the player: icons, colour, motion and sound only.
- No outside network requests, no ads or analytics code yet (Poki's SDK comes later, and there is a hook ready for it).
- Nothing pushed to `main`, nothing deployed, nothing sent to Poki. Jesse decides those.
