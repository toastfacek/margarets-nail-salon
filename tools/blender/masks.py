"""Skin colour masks (one FLOAT_COLOR attribute 'Col' on the points), re-tuned
for the v2 mesh (the v1 recipe, hand-plan.md 3.3):

  R blush     fingertips, the knuckles, the nail folds, the thumb's base
  G palm      palm and finger pads (lighter, pinker than the back)
  B cavity    between the fingers, joint creases, the groove around the nail
  A thinness  fingertips, finger sides, webbing (where light passes through)

Painted analytically from finger-chain coordinates and the mesh's own
concavity, then softened over the mesh.
"""
import numpy as np

import params as P
from base import BI, FINGERS
from rig import mesh_weights, world_points


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def closest_on_chain(p, chain):
    """t (arc length), axis point and tangent of the closest point on a polyline."""
    s0 = 0.0
    out_t = np.zeros(len(p))
    out_c = np.zeros_like(p)
    out_d = np.zeros_like(p)
    best = np.full(len(p), np.inf)
    for i in range(len(chain) - 1):
        a, b = chain[i], chain[i + 1]
        ab = b - a
        L = np.linalg.norm(ab)
        u = ((p - a) @ ab) / (L * L)
        u = np.maximum(u, 0.0) if i == len(chain) - 2 else np.clip(u, 0.0, 1.0)
        c = a + u[:, None] * ab
        d2 = ((p - c) ** 2).sum(1)
        m = d2 < best
        best[m] = d2[m]
        out_t[m] = s0 + u[m] * L
        out_c[m] = c[m]
        out_d[m] = ab / L
        s0 += L
    return out_t, out_c, out_d


def build(scene, report, check):
    hand, cage = scene['hand'], scene['cage']
    me = hand.data
    me.update()
    mm = cage.scale
    W = mesh_weights(hand)
    Pw = world_points(hand)
    mw = np.array(hand.matrix_world)
    Nw = np.array([tuple(v.normal) for v in me.vertices]) @ mw[:3, :3].T
    n = len(Pw)
    E = np.array([e.vertices[:] for e in me.edges])
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    acc = np.zeros((n, 3))
    np.add.at(acc, E[:, 0], Pw[E[:, 1]])
    np.add.at(acc, E[:, 1], Pw[E[:, 0]])
    elen = np.linalg.norm(Pw[E[:, 0]] - Pw[E[:, 1]], axis=1)
    el = np.zeros(n)
    np.add.at(el, E[:, 0], elen)
    np.add.at(el, E[:, 1], elen)
    el /= np.maximum(cnt, 1)
    # concavity: mean curvature (1/mm, + concave) from the umbrella Laplacian, softened
    lap = acc / np.maximum(cnt, 1)[:, None] - Pw
    conc = 2.0 * (lap * Nw).sum(1) / np.maximum(el, 1e-9) ** 2 * mm
    for _ in range(2):
        a2 = np.zeros(n)
        np.add.at(a2, E[:, 0], conc[E[:, 1]])
        np.add.at(a2, E[:, 1], conc[E[:, 0]])
        conc = 0.5 * conc + 0.5 * a2 / np.maximum(cnt, 1)
    R = np.zeros(n)
    G = smoothstep(0.0, 0.6, -Nw[:, 2])          # palm side: the hand's back is world +Z
    B = smoothstep(P.CAVITY_CURV[0], P.CAVITY_CURV[1], conc) * 0.8
    A = np.zeros(n)
    plates = scene.get('plates', {})
    J = cage.joints
    for f in FINGERS:
        wf = W[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1)
        sel = wf > 0.05
        chain = np.array([J[f + '.%d' % k] for k in (1, 2, 3, 4)])
        seg = np.linalg.norm(np.diff(chain, axis=0), axis=1)
        tj = np.cumsum(np.r_[0.0, seg])
        p = Pw[sel]
        t, c, dirn = closest_on_chain(p, chain)
        back = np.asarray(scene['nail_normal'][f])
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
        r_f = 0.7 * tipz + 0.4 * g * back_w + 0.3 * gk * back_w
        b_f = 0.5 * g * pad_w ** 2
        a_f = 0.9 * tipz + 0.45 * side_w * (1 - tipz)
        i = np.nonzero(sel)[0]
        R[i] = np.maximum(R[i], r_f * fade)
        G[i] = G[i] + (pad_w - G[i]) * fade
        B[i] = np.maximum(B[i], b_f * fade)
        A[i] = np.maximum(A[i], a_f * fade)
        if f in plates:
            pl = plates[f]
            L3 = pl.g.local(Pw[i])
            x, y, z = L3[:, 0], L3[:, 1], L3[:, 2]
            d = np.maximum.reduce([np.abs(x) - pl.W(y), y - pl.y_c(x), pl.y_h - y])
            near = (z > pl.z(x, y) - 4 * mm) & (y > pl.y_h - 2 * mm)
            fold = np.exp(-(np.maximum(d, 0) / (2.5 * mm)) ** 2) * near
            groove = np.exp(-(np.maximum(d, 0) / (0.7 * mm)) ** 2) * near * (d > -1.0 * mm)
            R[i] = np.maximum(R[i], 0.6 * fold)
            B[i] = np.maximum(B[i], 0.55 * groove)
    for f in ('index', 'middle', 'ring', 'pinky'):
        head = J[f + '.1']
        d = np.linalg.norm(Pw - head, axis=1) / mm
        R = np.maximum(R, 0.3 * np.exp(-(d / 12.0) ** 2) * smoothstep(0.2, 0.6, Nw[:, 2]))
        web = np.exp(-(d / 18.0) ** 2) * smoothstep(0.0, P.CAVITY_CURV[1] * 0.6, conc) * (1 - smoothstep(0.3, 0.8, Nw[:, 2]))
        A = np.maximum(A, 0.6 * web)
        B = np.maximum(B, 0.45 * web)
    d = np.linalg.norm(Pw - J['thumb.1'], axis=1) / mm
    R = np.maximum(R, 0.35 * np.exp(-(d / 24.0) ** 2) * smoothstep(-0.2, 0.4, -Nw[:, 2]))
    col = np.clip(np.stack([R, G, B, A], 1), 0, 1)
    for _ in range(P.MASK_SMOOTH_PASSES):
        a2 = np.zeros_like(col)
        np.add.at(a2, E[:, 0], col[E[:, 1]])
        np.add.at(a2, E[:, 1], col[E[:, 0]])
        col = 0.5 * col + 0.5 * a2 / np.maximum(cnt, 1)[:, None]
    if P.MASK_ATTR in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[P.MASK_ATTR])
    attr = me.color_attributes.new(P.MASK_ATTR, 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', col.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(P.MASK_ATTR)
    report['masks'] = {k: [round(float(np.percentile(col[:, j], q)), 3) for q in (5, 50, 95)] for j, k in enumerate('RGBA')}
    check('masks: four channels in [0, 1], not flat', all(col[:, j].std() > 0.02 for j in range(4)),
          [round(float(col[:, j].std()), 3) for j in range(4)])
    # the forearm notch is gone with the old mesh: no forearm vertex reads as a cavity
    arm = W[:, BI['wrist']] > 0.5
    worst = float(col[arm, 2].max()) if arm.any() else 0.0
    check('masks: no notch on the forearm (cavity mask <= %.1f)' % P.NOTCH_CAVITY, worst <= P.NOTCH_CAVITY,
          round(worst, 3), P.NOTCH_CAVITY)
