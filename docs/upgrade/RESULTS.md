# Margaret's Nail Salon: immersive upgrade results

Nov 22 2026. Branch `immersive-upgrade` on GitHub (not merged into `main`, nothing deployed or sent to Poki).
Fable 5.2 planned every step and reviewed every change; Opus 5.5 built them. All 9 steps are merged on the branch.

## What changed for the player
| Step | Result |
|---|---|
| 1. Fast brush | Paint stays on the graphics card and is drawn straight onto the nail. Stickers survive polish, each finger keeps its own paint. Quality tiers step down on their own if frames get slow, with guards so a fast device is never wrongly downgraded. |
| 2. Poki clean-up | No outside requests (Google Fonts and the Draco decoder gone), unused 3D files and the howler library removed. |
| 3. Gorgeous polish | Ring-light gloss, wet ripple that cures to a crisp shine, matte, glitter shimmer, chrome and gold. Lilac spa towel on marble, soft shadow, warm skin shader. All drawn by shaders, no art files. |
| 4. Brush juice | Polish bead on the brush, droplets, sparkle burst near full coverage, blow-dryer that cures wet polish. |
| 5. Sound | 18 soft sounds synthesised in the browser (brush swish, pops, clinks, dryer, jingle, client "yay"), peaks kept low for kids' ears, mute hook ready for Poki ads. |
| 6. Client loop | Opens mid-stroke with a ghost hand, no words. A client shows the look she wants, you paint, tap the heart, get 1 to 3 stars (never fail), next client. Rounds grow 1, 3, 5 nails. `roundStart`/`roundEnd` events mark where Poki's SDK will go. |
| 7. Slay reveal | Room dims to a plum spotlight, camera sweeps the fingers, flash, confetti twice, stars, heart burst, client cheers, a polaroid drops onto the salon wall (saved on the device, last 20). |
| 8. No words, small screens | Zero letters on every screen at 1280x720, 640x360, 390x844 and 844x390. Mute button. Old dead code removed. |
| 9. Swirl bowl | Drip colours into water, swirl, dip a nail for a real water-marble print. Free mode only for now. |

## Speed and size (final A/B, same machine, 3 runs each)
Headless Chrome with a software graphics chip (SwiftShader) at 1280x720, a stand-in for a weak Chromebook.

| Measure | Before (main) | After (auto quality) |
|---|---|---|
| Painting | 337 to 368 ms per frame (about 3 fps) | 36 to 40 ms (about 26 fps) |
| Brush on, not painting | 308 to 325 ms | 25 to 27 ms |
| Scene only | 72 to 87 ms | 33 to 38 ms |
| Memory | 47 to 54 MB | 15 to 18 MB, flat while painting |
| Outside requests | Google Fonts | none |
| Whole build (`dist`) | 3.6 MB | 2.6 MB (Poki cap 8 MB) |
| JS bundle | 832 KB (218 KB gzip) | 856 KB (240 KB gzip) |

Forced high quality on the software GPU paints at about 90 to 97 ms per frame. That setting is meant for real graphics chips; the game picks it only on strong devices and steps down by itself.

## Not done yet / for later
- Not tested on a real Chromebook, iPad or phone. That is the next check.
- Poki SDK not added (hooks are ready: `roundStart`, `roundEnd`, `app.game.between`, ad mute).
- Swirl bowl is free mode only; a "marble" client request, bowl sounds through the sound system and a proper camera fly-to API are next.
- Shape tool (nail shapes) still hidden; it needs nail shape models.
- Buttons are 40 px (not 48) on the smallest 640x360 screen; the nail fills about 30% of the screen's short side (target 35%) to keep high quality fast.

Frame-time harness: `scripts/perf.mjs`. Plan: `docs/upgrade/build-plan.md`. Screenshots: `screens/` in this folder. Sounds: `sounds/`.
