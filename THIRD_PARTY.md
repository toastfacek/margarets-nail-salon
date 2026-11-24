# Third-party pieces and their licences

Everything in this repository that is not listed below is original to this project:
the game code, the shaders, the asset pipeline scripts in `tools/blender/` (written from
scratch for this project; no MakeHuman or MPFB2 code is copied, ported or adapted), the
generated textures and noise, and the hand model built from the base mesh below.

| Piece | Where it is used | Source | Licence |
|---|---|---|---|
| MakeHuman / MPFB2 base mesh, shape targets and rig weights (the right hand, extracted into `tools/blender/src/mh/hand-cage.json`) | the source of the v2 hand model | https://github.com/makehumancommunity/mpfb2 at commit `650c5c53bd6989a8ac264f31fa1d11d4a0c7bd8a`; `src/mpfb/data/3dobjs/base.obj` sha256 `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`, `rigs/standard/weights.default.json` sha256 `154b866774a8c2b055a8e86419f22a87b76c60440fdcb70bcb78345f00924e89`; every file and sha256 in `tools/blender/src/mh/SOURCE.md` | CC0 1.0 (the MPFB2 assets: `LICENSE.md` section C; text in `tools/blender/src/mh/LICENSE.ASSETS.md`). Only these CC0 assets are used. MakeHuman's and MPFB2's software (AGPL / GPL) is not used, copied or bundled. |
| three.js 0.170.0 | the game's renderer (bundled) | https://github.com/mrdoob/three.js (npm `three`) | MIT |
| Vite 6.4.1 | build tool (dev only, not shipped) | https://github.com/vitejs/vite (npm `vite`) | MIT |
| Fredoka (variable font) 5.3.0 | the game's UI font (bundled) | https://github.com/fontsource/font-files (npm `@fontsource-variable/fredoka`), font by the Fredoka project | SIL Open Font License 1.1 |

Notes

- `tools/blender/fetch_mh.py` downloads the CC0 files above at the pinned commit and checks
  their sha256; it parses them as data (OBJ text, gzip text, JSON). The CC0 nail-mask texture
  `mpfb_fingernails.jpg` is read once, as a cross-check of the nail faces; it is not shipped.
- The build pipeline runs Blender 5.3 as a Python module (GPL) as a tool; no Blender code is
  part of the game, and the files it writes are this project's own output.
- No CC-BY, non-commercial, share-alike or unknown-licence asset, texture or code is used.
- V3 skin: the skin's UV layout is the CC0 base mesh's own UVs, repacked by `tools/blender/uv.py`;
  the detail map (`skin-detail.webp`: knuckle and joint creases, palm creases, unevenness) is
  painted from this project's own analytic shapes and noise in `tools/blender/maps.py`, and the
  micro tile (pores, ridges) is generated at run time by `createSkinMicroTile` in
  `src/scene/SkinMaterial.js`. No photo, scan or third-party texture is used.
