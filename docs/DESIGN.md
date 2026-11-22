# Design guide

North star: one huge glossy nail under a ring light, a fat wet brush, and a
reveal that makes a five-year-old squeal. The nail is the brightest, sharpest,
most saturated thing on screen; the UI stays small, soft and out of its way.

## No words

The player never needs to read. Every control is an icon drawn in code
(inline SVG or CSS), every request is a picture, progress is stars and pips,
and feedback is motion and sound. Numerals are allowed. `aria-label` carries
the accessible name; it is never the only signal. Emoji are used only for
stickers (they are what lands on the nail), never as UI icons, because they
render differently on Chromebooks and iOS.

## Palette

| Role | Value |
|---|---|
| Ink (outlines, active marks) | `#5a2a82` |
| Hot pink (primary, Done heart, active nail) | `#ff2a6d` |
| Lilac (secondary icons) | `#c77dff`, `#9d4edd` |
| Gold (stars, sparkles) | `#ffd21f` |
| Panels | white at 85 to 90% opacity, `0 6px 18px rgba(90,42,130,.18)` shadow |
| Salon backdrop | code-built, plum to lilac (`Backdrop.js`) |

Polish colours: the eight client colours in `src/game/ClientRequests.js`
(`PALETTE`) plus eight more in the free-mode `PolishPanel`.

## Layout (`styles/main.css`)

| Screen | Round mode | Free mode |
|---|---|---|
| Landscape, taller than 420 px | bubble + stars top-left, door / mute / photo stack top-right, bottle tray bottom-centre, dryer and Done heart bottom-right | tool rail left, options right, actions bottom-left, finger map top-centre |
| Small landscape (<= 420 px tall, 640x360, phones) | the same, scaled down | one bottom tray: tools, scrolling options, actions |
| Portrait | bubble top-left, bottles in two rows at the bottom, heart and dryer above them | finger map under the top icons, two-row scrolling options, tools/actions row at the bottom |

- Touch targets: 48 px (up to 64 px on big screens); 40 px with 6 px gaps
  only at <= 370 px tall (640x360).
- Safe-area insets respected; no scrollbars (panels scroll inside themselves).
- Nothing covers the active nail; the camera frames it to about 34% of the
  short side in every aspect (`NailScene._focusTargets`).

## Motion

Pops and slides with overshoot (`cubic-bezier(0.34, 1.7, 0.6, 1)`), under
600 ms. Infinite animations only on `transform`/`opacity` and at most two at
once (the Done heart pulse and the ghost finger). No flashing faster than
3 Hz; the reveal has one flash. `prefers-reduced-motion` stops the loops.

## Sound

Web Audio only, soft and rounded, behind a master limiter. Mute is the
speaker icon (top-right, both modes) and persists. No sound before the first
tap.
