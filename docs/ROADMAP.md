# Roadmap

The original seven-phase sandbox plan (filing, layers, gallery export...) is
superseded by the immersive upgrade in `docs/upgrade/build-plan.md`. Status of
its work packages:

| WP | What | Status |
|---|---|---|
| WP1 | Brush and fluid performance core; app spine (`src/core`, features, events, tiers) | done |
| WP2 | Poki hygiene: no external hosts, relative URLs, lighter download | done |
| WP3 | Nail shader, skin, code-built salon light and environment | done |
| WP4 | Brush juice: sparkles, coverage, wet-to-cure, dryer, decoration pops | done |
| WP5 | Web Audio sound design, mute | done |
| WP6 | Round mode: clients, requests in pictures, stars, ghost finger | done |
| WP7 | Slay reveal and polaroid wall | done |
| WP8 | Icon-only UI, portrait and 640x360 layouts, dead-code sweep | done |
| WP9 | Swirl bowl water marbling (stretch) | in progress |

## Next

- Poki SDK: `gameplayStart` / `gameplayStop` + `commercialBreak` on
  `roundStart` / `roundEnd`; `soundManager.setMuted(true, 'ad')` and
  `app.loop` pause around ads.
- Nail shapes (square, almond, stiletto, coffin) need models; the shape tool
  is hidden until then (`HandModel.setShape` still works for round).
- Code-drawn stickers to replace emoji (they differ per platform).
- Undo for free mode (paint lives in per-nail render targets).
- A real low-end Chromebook measurement against the budgets in the build plan.
