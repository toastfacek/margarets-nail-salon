"""Skin colour masks (hand-plan.md 3.3): one FLOAT_COLOR attribute on the points.

  R blush     fingertips, the knuckles, the nail folds, the thumb's base
  G palm      palm and finger pads (lighter, pinker than the back)
  B cavity    between the fingers, joint creases, the groove around the nail
  A thinness  fingertips, finger sides, webbing (where light passes through)

All painted analytically from bone-space coordinates (sculpt.py's finger
cylinder) and the mesh's own concavity, then softened over the mesh.
"""
import numpy as np

import gltfio
import params as P
from gltfio import FINGERS
from sculpt import _chain, _closest_on_chain, _weights, smoothstep


def build(scene, report, check):
    hand, rig = scene['hand'], scene['rig']
    me = hand.data
    me.update()
    W, gi = _weights(hand)
    Pw = gltfio.world_points(hand)
    mw = np.array(hand.matrix_world)
    Nw = np.array([tuple(v.normal) for v in me.vertices]) @ mw[:3, :3].T
    n = len(Pw)
    E = np.array([e.vertices[:] for e in me.edges])
    # concavity: neighbours' mean above the vertex along its normal
    acc = np.zeros((n, 3))
    cnt = np.zeros(n)
    np.add.at(acc, E[:, 0], Pw[E[:, 1]])
    np.add.at(acc, E[:, 1], Pw[E[:, 0]])
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    elen = np.linalg.norm(Pw[E[:, 0]] - Pw[E[:, 1]], axis=1)
    el = np.zeros(n)
    np.add.at(el, E[:, 0], elen)
    np.add.at(el, E[:, 1], elen)
    el /= np.maximum(cnt, 1)
    lap = acc / np.maximum(cnt, 1)[:, None] - Pw
    conc = (lap * Nw).sum(1) / np.maximum(el, 1e-6)
    R = np.zeros(n)
    G = smoothstep(0.0, 0.6, -Nw[:, 2])          # palm, by default from the world (hand back = +Z)
    B = smoothstep(P.CAVITY_CURV[0], P.CAVITY_CURV[1], conc) * 0.8
    A = np.zeros(n)
    plates = scene.get('plates', {})
    for f in FINGERS:
        wf = W[:, [gi[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1)
        sel = wf > 0.05
        chain = _chain(rig, f)
        seg = np.linalg.norm(np.diff(chain, axis=0), axis=1)
        tj = np.cumsum(np.r_[0.0, seg])
        p = Pw[sel]
        t, c, dirn = _closest_on_chain(p, chain)
        if f in plates:
            back = np.asarray(plates[f].z)
        else:
            back = np.array([0, 0, 1.0])
        bperp = back[None, :] - dirn * (dirn @ back)[:, None]
        bperp /= np.linalg.norm(bperp, axis=1, keepdims=True)
        r = p - c
        cos_th = (r * bperp).sum(1) / (np.linalg.norm(r, axis=1) + 1e-12)
        back_w = np.clip(cos_th, 0, 1) ** 2
        side_w = 1.0 - cos_th ** 2
        pad_w = smoothstep(0.0, 0.55, -cos_th)
        fade = smoothstep(0.35, 0.9, wf[sel])
        tipz = smoothstep(tj[2] + 0.25 * seg[2], tj[3] - 0.05 * seg[2], t)
        g = np.zeros_like(t)
        for jt, L in ((tj[1], seg[1]), (tj[2], seg[2])):
            g = np.maximum(g, np.exp(-((t - jt) / (0.28 * L)) ** 2))
        gk = np.exp(-((t - tj[0]) / (0.3 * seg[0])) ** 2)
        r_f = 0.75 * tipz + 0.45 * g * back_w + 0.35 * gk * back_w
        g_f = pad_w
        b_f = 0.55 * g * pad_w ** 2            # flexion creases on the palm side
        a_f = 0.9 * tipz + 0.45 * side_w * (1 - tipz)
        i = np.nonzero(sel)[0]
        R[i] = np.maximum(R[i], r_f * fade)
        G[i] = G[i] + (g_f - G[i]) * fade
        B[i] = np.maximum(B[i], b_f * fade)
        A[i] = np.maximum(A[i], a_f * fade)
        # nail folds: blush on the fold, cavity in the groove where it meets the plate
        if f in plates:
            pl = plates[f]
            S = Pw[i] - pl.centre
            lx, ly, lz = S @ pl.x, S @ pl.y, S @ pl.z
            a = pl.a_of_x(lx, ly)
            d = pl.signed_distance(a, ly)
            _, zp = pl.surf(a, ly)
            near = (lz > zp - 0.5 * pl.Wv) & (ly > pl.y_hypo - 0.2 * pl.Lv)
            fold = np.exp(-(np.maximum(d, 0) / (0.45 * pl.Wv)) ** 2) * near
            groove = np.exp(-(np.maximum(d, 0) / (0.12 * pl.Wv)) ** 2) * near * (d > -0.3 * pl.Wv)
            R[i] = np.maximum(R[i], 0.65 * fold)
            B[i] = np.maximum(B[i], 0.6 * groove)
    # knuckles on the back of the hand, thumb base, webbing
    for f in ('index', 'middle', 'ring', 'pinky'):
        head = gltfio.bone_world(rig, f + '.01')[0]
        d = np.linalg.norm(Pw - head, axis=1)
        R = np.maximum(R, 0.35 * np.exp(-(d / 0.07) ** 2) * smoothstep(0.2, 0.6, Nw[:, 2]))
        # webbing: low on the hand between the finger bases (concave, near a knuckle, not on top)
        web = np.exp(-(d / 0.12) ** 2) * smoothstep(0.0, 0.2, conc) * (1 - smoothstep(0.3, 0.8, Nw[:, 2]))
        A = np.maximum(A, 0.6 * web)
        B = np.maximum(B, 0.5 * web)
    th = gltfio.bone_world(rig, 'thumb.01')[0]
    d = np.linalg.norm(Pw - th, axis=1)
    R = np.maximum(R, 0.4 * np.exp(-(d / 0.14) ** 2) * smoothstep(-0.2, 0.4, -Nw[:, 2]))
    col = np.clip(np.stack([R, G, B, A], 1), 0, 1)
    # soften over the mesh
    for _ in range(P.MASK_SMOOTH_PASSES):
        acc = np.zeros_like(col)
        np.add.at(acc, E[:, 0], col[E[:, 1]])
        np.add.at(acc, E[:, 1], col[E[:, 0]])
        col = 0.5 * col + 0.5 * acc / np.maximum(cnt, 1)[:, None]
    if P.MASK_ATTR in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[P.MASK_ATTR])
    attr = me.color_attributes.new(P.MASK_ATTR, 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', col.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(P.MASK_ATTR)
    report['masks'] = {k: [round(float(np.percentile(col[:, j], q)), 3) for q in (5, 50, 95)] for j, k in enumerate('RGBA')}
    check('masks: four channels in [0, 1], not flat', all(col[:, j].std() > 0.02 for j in range(4)),
          [round(float(col[:, j].std()), 3) for j in range(4)])
