"""The thumb chain's anatomy (Jesse, after V2: "the bones connecting the whole
thumb to the wrist"), on the cage, in the source pose, before the fit.

The base mesh's thumb joints put the MCP close to the wrist: a short first
metacarpal (about 28 mm, real about 44) and long phalanges, so from the back
the thumb read as a thin stalk leaving the side of the wrist, too long and
finger-like. Here, with the rig's own weights (diffused, so the thenar and
the web stretch smoothly):

- the first metacarpal is stretched along its axis about the CMC joint (which
  stays where it is, about 19 mm past the wrist joint on the radial side) to
  THUMB_MC_FRAC of the wrist-to-index-MCP distance, and thickened round its axis
  (the thenar and the dorsal first web come with it);
- the proximal and distal phalanges are shortened (THUMB_PP_SCALE,
  THUMB_DP_SCALE) and made a little stockier (THUMB_DIGIT_THICK);
- the thumb's joints move with their bones.

`volume` (after the re-pose bake) fills the thenar eminence on the palm side
and rounds the first metacarpal on the back: a displacement along the
normals, faded by weight and smoothed, never on the nail unit.

All of it is this project's own code, driven by params.py.
"""
import numpy as np

import params as P
from base import BI


def _unit(v):
    return v / np.linalg.norm(v)


def proportions(cage, report, bake_weights, E):
    J = cage.joints
    j1, j2, j3, j4 = (J['thumb.%d' % k].copy() for k in (1, 2, 3, 4))
    L = [np.linalg.norm(j2 - j1), np.linalg.norm(j3 - j2), np.linalg.norm(j4 - j3)]
    d = [_unit(j2 - j1), _unit(j3 - j2), _unit(j4 - j3)]
    index_reach = np.linalg.norm(J['index.1'] - J['wrist'])
    L1 = P.THUMB_MC_FRAC * index_reach
    s = [L1 / L[0], P.THUMB_PP_SCALE, P.THUMB_DP_SCALE]
    q = [P.THUMB_MC_THICK, P.THUMB_DIGIT_THICK, P.THUMB_DIGIT_THICK]
    n1 = j1
    n2 = n1 + d[0] * L[0] * s[0]
    n3 = n2 + d[1] * L[1] * s[1]
    n4 = n3 + d[2] * L[2] * s[2]
    heads_old, heads_new = [j1, j2, j3], [n1, n2, n3]
    W = bake_weights(cage, E)
    V = cage.V
    out = V.copy()
    wsum = np.zeros(len(V))
    acc = np.zeros_like(V)
    for k, b in enumerate(('thumb.01', 'thumb.02', 'thumb.03')):
        w = W[:, BI[b]]
        sel = w > 1e-6
        p = V[sel] - heads_old[k]
        a = p @ d[k]
        r = p - np.outer(a, d[k])
        # a vertex behind its bone's head (a < 0, the joint's own bulge) keeps
        # its axial offset; the rest scales along the bone
        a2 = np.where(a > 0, a * s[k], a)
        moved = heads_new[k] + np.outer(a2, d[k]) + r * q[k]
        acc[sel] += w[sel, None] * moved
        wsum[sel] += w[sel]
    keep = 1.0 - wsum
    out = acc + keep[:, None] * V
    cage.V = out
    J['thumb.2'], J['thumb.3'], J['thumb.4'] = n2, n3, n4
    report['thumb_proportions_mm'] = {
        'before': {'mc': round(float(L[0]), 1), 'pp': round(float(L[1]), 1), 'dp': round(float(L[2]), 1)},
        'after': {'mc': round(float(L[0] * s[0]), 1), 'pp': round(float(L[1] * s[1]), 1), 'dp': round(float(L[2] * s[2]), 1)},
        'wrist_to_index_mcp': round(float(index_reach), 1)}


def volume(cage, report, E, up):
    """Fill the thenar (palm side) and round the first metacarpal (back),
    after the bake: displacement along the vertex normals."""
    W = cage.W
    t1 = W[:, BI['thumb.01']]
    t23 = W[:, BI['thumb.02']] + W[:, BI['thumb.03']]
    # the first metacarpal's skin, fading out into the palm and the thumb
    a = np.clip(t1 * 1.4, 0, 1) * (1.0 - np.clip(t23 * 1.5, 0, 1))
    n = cage.vertex_normals()
    palm_side = np.clip(-(n @ up) * 1.5 + 0.2, 0, 1)
    amt = a * (P.THENAR_FILL_MM * palm_side + P.THUMB_MC_ROUND_MM * (1.0 - palm_side))
    cnt = np.zeros(len(amt))
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    for _ in range(P.THENAR_FILL_SMOOTH):
        accum = np.zeros_like(amt)
        np.add.at(accum, E[:, 0], amt[E[:, 1]])
        np.add.at(accum, E[:, 1], amt[E[:, 0]])
        amt = 0.5 * amt + 0.5 * accum / np.maximum(cnt, 1)
    cage.V = cage.V + n * amt[:, None]
    report['thenar_fill_max_mm'] = round(float(amt.max()), 2)
