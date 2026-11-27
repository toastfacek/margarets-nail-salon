# Source of the v2 hand: the MakeHuman / MPFB2 base mesh (CC0 1.0)

Hand model derived from the MakeHuman / MPFB2 base mesh (CC0 1.0).

- Repository: https://github.com/makehumancommunity/mpfb2
- Commit: `650c5c53bd6989a8ac264f31fa1d11d4a0c7bd8a`
- Fetched: 2026-11-24, by `tools/blender/fetch_mh.py` (raw URLs at the pinned commit; it falls back to a blobless clone and checks every sha256 below).
- `base.obj` is the same file as in the `makehuman` repository.

## Licence

`LICENSE.md` section C ("Concerning the assets"), quoted:

> The assets are defined as any data contributing to the output from MPFB.
> This includes: the base mesh and proxies; targets and modifiers; textures; clothes (any MHCLO-based asset);
> rigs, poses and expressions; JSON data with mesh information.
> These assets have been released under CC0 1.0 Universal. In summary this means
> that to the fullest extent possible, it is the intention of the MakeHuman
> team that anyone can do whatever they want with it.

`base.obj` carries its own header: "This asset was explicitly released as CC0 in september 2020."
The full legal text is copied here as `LICENSE.ASSETS.md`. CC0 asks for no credit; we record it anyway.

## Files (sha256)

| Path in the repository | sha256 |
|---|---|
| `LICENSE.md` | `5cefb60680cb9efd4550a2e65d719021cfbec9dad3658481d11d48ae863ce04d` |
| `LICENSE.ASSETS.md` | `f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c` |
| `src/mpfb/data/3dobjs/base.obj` | `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c` |
| `src/mpfb/data/rigs/standard/weights.default.json` | `154b866774a8c2b055a8e86419f22a87b76c60440fdcb70bcb78345f00924e89` |
| `src/mpfb/data/targets/macrodetails/caucasian-female-young.target.gz` | `e9d6212373ac5f1e2c596fa145e363385f4d169c3c6c88ede3bab93b681af041` |
| `src/mpfb/data/textures/mpfb_fingernails.jpg` | `0828222964a14c14a46e72445f549a2124de06f072daab71e5a6716324c37362` |
| `src/mpfb/data/targets/hands/r-hand-fingers-diameter-decr.target.gz` | `3d940e2194c3b46cffc866b99edaa2ca8b5c8c34bcf5eb64959524bfdfd28076` |
| `src/mpfb/data/targets/hands/r-hand-fingers-diameter-incr.target.gz` | `58beddaa9c8097ab7addfe2ae638c6c8c578eb8b7e5ac5ada542fce000d0f7da` |
| `src/mpfb/data/targets/hands/r-hand-fingers-distance-decr.target.gz` | `1de105e5e75d76a41279cd82f3c9f04633d89429906903da4bbc916ef5a7c608` |
| `src/mpfb/data/targets/hands/r-hand-fingers-distance-incr.target.gz` | `874ccc270155e561b5ae24d89e931f5c039b610fcddf572270b2a6c212341276` |
| `src/mpfb/data/targets/hands/r-hand-fingers-length-decr.target.gz` | `710b10a1883fede2bd4bbbe4647ea25ee2311db4190c74009bba3504d217b515` |
| `src/mpfb/data/targets/hands/r-hand-fingers-length-incr.target.gz` | `ac90a1e7b1776bb41f896b2b5308ab791b860a3fbf4f854f17d56234b3da48a9` |
| `src/mpfb/data/targets/hands/r-hand-scale-decr.target.gz` | `8a0a3e246efb9e3640fabd02c75085e3bc2bf57d20b736e0a98819302a72c83c` |
| `src/mpfb/data/targets/hands/r-hand-scale-incr.target.gz` | `33d4f09b9c7cf1559503dde7b4e40f882a2bb81ec9bc71324c9edbe3655cda34` |
| `src/mpfb/data/targets/hands/r-hand-trans-in.target.gz` | `11166b987bd9972fef9c99c7e7972a08bcb66a6d8bc977e3c2b3350bc9d37460` |
| `src/mpfb/data/targets/hands/r-hand-trans-out.target.gz` | `0ef3a147e798fb19ca8840364390f86399a2989c3e7910dd09ca31b4292dd617` |

## What `hand-cage.json` holds

Extracted by `fetch_mh.py` (no build touches the network; builds read this file):

- the right hand: the body faces whose four vertices are at least 50% weighted to the right
  `finger*`, `metacarpal*`, `wrist`, `lowerarm01/02` bones (1842 vertices, 1828 quads, all quads);
- the base UVs of those faces; the source weights of the kept vertices (every group that touches them);
- the joint helper centres (`joint-r-hand`, `-hand-2`, `-hand-3`, `-elbow`, `joint-r-finger-F-K`);
- the shape targets as sparse deltas on the kept vertices and on the joint centres: `caucasian-female-young`
  and the ten `r-hand-*` targets;
- `nailFaces`: the nail bed patch of each finger (the quads inside the tight double edge loop), found once
  by a heuristic (thresholds {'thumb': 0.7, 'index': 0.5, 'middle': 0.5, 'ring': 0.5, 'pinky': 0.5}) and committed; every patch lies inside the CC0 nail mask
  `mpfb_fingernails.jpg` in the base UVs (fraction inside: {'thumb': 1.0, 'index': 1.0, 'middle': 1.0, 'ring': 1.0, 'pinky': 1.0}); `foldRing`: two rings of
  faces around each patch. Debug still: `screens/hv2-v0-nail-patches.png`.
