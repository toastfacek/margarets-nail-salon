"""Skin UVs (hand-v2-plan.md 6.1, its fallback): the base mesh's own UVs,
carried through the subdivision, repacked into [0, 1].

The CC0 base mesh unwraps the hand as one island (its first metacarpal to its
fingertips, back and palm), the forearm as a second, and the forearm cap
(added by fit.cap_forearm) has none. Here: the hand island is scaled up to
fill most of the square, the forearm island goes into the free strip at a
lower density, the cap is given a small planar projection in a corner. One
uniform scale per island (no stretch added), a gutter of UV_GUTTER_PX.
Checks: no texel covered twice, the hand's density, the vertex count after
the seams split the skin's vertices in the export.
"""
import numpy as np

import params as P


def _islands(lv, U):
    parent = list(range(len(lv)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    key = {}
    for i, v in enumerate(lv):
        k = (int(v), round(float(U[i, 0]), 6), round(float(U[i, 1]), 6))
        if k in key:
            parent[find(i)] = find(key[k])
        else:
            key[k] = i
    return parent, find


def build(scene, report, check):
    hand = scene['hand']
    me = hand.data
    uvl = me.uv_layers['MHUV']
    nl = len(me.loops)
    U = np.empty(nl * 2)
    uvl.data.foreach_get('uv', U)
    U = U.reshape(-1, 2)
    lv = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get('vertex_index', lv)
    parent, find = _islands(lv, U)
    for p in me.polygons:
        li = list(p.loop_indices)
        for a in li[1:]:
            pa, pb = find(a), find(li[0])
            if pa != pb:
                parent[pa] = pb
    roots = np.array([find(i) for i in range(nl)])
    isl = sorted(np.unique(roots), key=lambda r: -(roots == r).sum())
    gut = P.UV_GUTTER_PX / P.MAP_SIZE
    out = U.copy()
    info = []
    co = np.array([tuple(v.co) for v in me.vertices])
    # the hand: the largest island, scaled to fill [gut, HAND_FRAC]
    for rank, r in enumerate(isl):
        m = roots == r
        lo, hi = U[m].min(0), U[m].max(0)
        size = hi - lo
        if rank == 0:
            box = (np.array([gut, gut]), np.array([P.UV_HAND_FRAC, P.UV_HAND_FRAC]))
        elif rank == 1:
            box = (np.array([P.UV_HAND_FRAC + 2 * gut, gut]), np.array([1 - gut, 1 - P.UV_HAND_FRAC - 2 * gut]))
        else:
            box = None
        if box is not None and size.max() > 1e-6:
            s = float(np.min((box[1] - box[0]) / size))
            out[m] = box[0] + (U[m] - lo) * s
            info.append({'loops': int(m.sum()), 'scale': round(s, 2)})
        else:
            # a degenerate island (the forearm cap): a planar projection of its
            # vertices into a small corner square
            vv = co[lv[m]]
            c = vv - vv.mean(0)
            ax = np.linalg.svd(c, full_matrices=False)[2][:2]
            q = c @ ax.T
            q = (q - q.min(0)) / max(float(np.ptp(q, 0).max()), 1e-9)
            k = 0.06
            out[m] = np.array([1 - gut - k, 1 - gut - k]) + q * k
            info.append({'loops': int(m.sum()), 'planar': True})
    # the export's UV map
    new = me.uv_layers.new(name='UVMap')
    new.data.foreach_set('uv', out.astype(np.float32).ravel())
    me.uv_layers.remove(me.uv_layers['MHUV'])
    me.uv_layers.active = me.uv_layers['UVMap']
    # checks
    N = 512
    cnt = np.zeros((N, N), np.int16)
    tris = []
    for p in me.polygons:
        li = list(p.loop_indices)
        for k in range(1, len(li) - 1):
            tris.append((li[0], li[k], li[k + 1]))
    tris = np.array(tris)
    S = out * (N - 1)
    for t in tris:
        Pt = S[t]
        x0, y0 = np.floor(Pt.min(0)).astype(int)
        x1, y1 = np.ceil(Pt.max(0)).astype(int)
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        q = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], 1)
        a, b, c = Pt
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (q[:, 0] - c[0]) + (c[0] - b[0]) * (q[:, 1] - c[1])) / d
        l2 = ((c[1] - a[1]) * (q[:, 0] - c[0]) + (a[0] - c[0]) * (q[:, 1] - c[1])) / d
        m = (l1 > 0.02) & (l2 > 0.02) & (l1 + l2 < 0.98)
        np.add.at(cnt, (q[m, 1].astype(int).clip(0, N - 1), q[m, 0].astype(int).clip(0, N - 1)), 1)
    over = int((cnt > 1).sum())
    keys = set()
    for i, v in enumerate(lv):
        keys.add((int(v), round(float(out[i, 0]), 6), round(float(out[i, 1]), 6)))
    nsplit = len(keys)
    report['uv'] = {'islands': info, 'overlap_texels_512': over, 'coverage': round(float((cnt > 0).mean()), 3),
                    'verts_after_seams': nsplit}
    check('uv: no texel covered by two skin triangles', over == 0, over, 0)
    check('uv: skin verts after the UV seams <= %d' % P.CAP_SKIN_VERTS, nsplit <= P.CAP_SKIN_VERTS, nsplit, P.CAP_SKIN_VERTS)
    return out
