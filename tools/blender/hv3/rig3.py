"""hv3 skinning weights and colour masks, computed in the hand frame (mm) from
the SDF hand's own structure: each vertex's distance to each finger tube and
its position along the tube's spine (s) decide which bones carry it; the joint
windows sit on the anatomical joint centres. Then Laplacian smoothing over
the mesh, the four largest kept, the nail unit rigid on .03.

Masks (vertex colour): R blush, G palm side, B cavity, A thinness.
"""
import numpy as np

import skeleton as SK
from sdf import smoothstep

FINGERS = SK.FINGERS

# v3's pose set: a mirror of POSE_SETS.v3 in src/scene/HandPoses.js (the
# thumb's game poses about v3's bind, and the joint limits the rig checks
# cover). Thumb poses: [base flex, base spread, base twist, middle, last].
POSE_SET_V3 = {
    'limits': {
        'finger.01': ((-15, 25), (-12, 12), (0, 0)),
        'finger.02': ((0, 45), (0, 0), (0, 0)),
        'finger.03': ((-5, 40), (0, 0), (0, 0)),
        'thumb.01': ((-12, 3), (-14, 2), (-8, 20)),
        'thumb.02': ((-16, 6), (0, 0), (0, 0)),
        'thumb.03': ((-12, 45), (0, 0), (0, 0)),
    },
    'thumb': {
        'relaxed': (0, -1, 0, 0, 5),
        'fan': (-2, -3, 4, -12, -10),
        'thumbActive': (-2, -1, 14, -10, -4),
        'thumbOther': (0, 0, 0, 0, 2),
    },
}
BONES = ['wrist', 'palm'] + [f'{f}.0{k}' for f in FINGERS for k in (1, 2, 3)]
BI = {b: i for i, b in enumerate(BONES)}

# joint windows (mm along the tube's spine, before / after the joint centre)
WIN = {
    'finger': [(6.0, 7.0), (3.4, 3.8), (2.8, 3.2)],     # MCP, PIP, DIP
    'thumb': [(-6.0, 18.0), (6.0, 7.5), (4.5, 5.0)],    # CMC (palm -> thumb.01 well past the CMC), MCP, IP
}
MEMBER = {'finger': (6.5, 1.0), 'thumb': (7.0, 1.0)}    # tube distance (mm): no share .. full share
WRIST_WIN = (-3.0, 12.0)                                # forearm spine, around the wrist joint
WEB_REACH = 9.0                                         # mm from both the thumb and the index
WEB_PASSES = 60
WEB_THUMB_KEEP = 1.0                                    # mm: the thumb's skin, held out of the web diffusion
DIGIT_SOFT = 0.8                                        # mm: the nearest digit's lead over the next
THUMB_DISTAL_LO = 7.0                                   # the thumb's membership reach past its MCP (mm)
SMOOTH_PASSES = 12
RIGID_MARGIN = 1.6                                      # mm round the nail outline that rides on .03 only


def adjacency(F, n):
    E = np.concatenate([F[:, [i, (i + 1) % F.shape[1]]] for i in range(F.shape[1])])
    E = np.unique(np.sort(E, 1), axis=0)
    return E


def smooth(X, E, n, passes, lam=0.5, fixed=None):
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    for _ in range(passes):
        acc = np.zeros_like(X)
        np.add.at(acc, E[:, 0], X[E[:, 1]])
        np.add.at(acc, E[:, 1], X[E[:, 0]])
        Y = X + lam * (acc / np.maximum(cnt, 1)[:, None] - X)
        if fixed is not None:
            Y[fixed] = X[fixed]
        X = Y
    return X


def chain_weights(s, jx, win):
    """Weights of [parent, .01, .02, .03] along a chain from the joint arcs."""
    c = [smoothstep(j - a, j + b, s) for j, (a, b) in zip(jx[:3], win)]
    w0 = 1 - c[0]
    w1 = c[0] * (1 - c[1])
    w2 = c[1] * (1 - c[2])
    w3 = c[2]
    return np.stack([w0, w1, w2, w3], 1)


def nail_local(nu, V):
    q = V - nu.o
    return q @ nu.U, q @ nu.F, q @ nu.W


def in_nail(nu, V, margin):
    x, y, z = nail_local(nu, V)
    hw = nu.hw(y)
    o = np.maximum(np.abs(x) - hw, nu.cuticle_y(x) - y)
    zt = nu.z_top(x, y)
    return (o < margin) & (z > zt - 3.5) & (y < nu.yh + 12)


def weights(hand, V, F):
    n = len(V)
    W = np.zeros((n, len(BONES)))
    # forearm vs hand
    fa = hand.forearm
    d_arm, loc = fa(V, local=True)
    w0 = hand.info['forearm']['wrist_s']
    a = smoothstep(w0 + WRIST_WIN[0], w0 + WRIST_WIN[1], loc['s'])
    W[:, BI['wrist']] = a
    rest = 1 - a
    # finger memberships
    mem, chains, dist = {}, {}, {}
    for f in FINGERS:
        t = hand.fingers[f]
        d, lf = t(V, local=True)
        dist[f] = d
        if f == 'thumb':
            thumb_s = lf['s']
        kind = 'thumb' if f == 'thumb' else 'finger'
        lo, hi = MEMBER[kind]
        if kind == 'thumb':
            # past the thumb's MCP the membership tightens: the first web's
            # skin (within a few mm of the proximal phalanx) stays on the
            # palm and the metacarpal, never on the phalanx alone
            jx = hand.info[f]['jx']
            tt = smoothstep(jx[1] - 4.0, jx[1] + 6.0, lf['s'])
            lo = lo * (1 - tt) + THUMB_DISTAL_LO * tt
            hi = hi * (1 - tt) + 0.4 * tt
        mem[f] = smoothstep(lo, hi, d)
        if kind == 'thumb':
            # the first web: shared between the thumb and the index side by
            # relative distance, so it stretches evenly instead of folding
            di = np.maximum(hand.fingers['index'](V), 0.0)
            dt = np.maximum(d, 0.0)
            ratio = di / np.maximum(di + dt, 1e-6)
            web = smoothstep(16.0, 9.0, dt) * smoothstep(20.0, 12.0, di)
            mem[f] = np.maximum(mem[f], web * smoothstep(0.15, 0.85, ratio))
        s_ch = lf['s']
        if kind == 'thumb':
            # skin off the thumb's own surface (the first web) rides on the
            # metacarpal: its chain position is held short of the MCP
            jx = hand.info[f]['jx']
            wd = smoothstep(0.3, 2.0, d)
            s_ch = s_ch * (1 - wd) + np.minimum(s_ch, jx[1] - 5.0) * wd
        chains[f] = chain_weights(s_ch, hand.info[f]['jx'], WIN[kind])
    # between neighbouring digits the nearest one wins (softly): skin on the
    # ring finger's side never rides partly on the middle finger
    dmin = np.minimum.reduce([dist[f] for f in FINGERS[1:]])
    for f in FINGERS[1:]:
        mem[f] = mem[f] * np.exp(-np.maximum(dist[f] - dmin, 0.0) / DIGIT_SOFT)
    tot = sum(mem.values())
    scale = np.where(tot > 1, 1 / np.maximum(tot, 1e-9), 1.0)
    palm = rest.copy()
    for f in FINGERS:
        m = mem[f] * scale * rest
        cw = chains[f]
        palm -= m * (1 - cw[:, 0])
        for k in (1, 2, 3):
            W[:, BI[f'{f}.0{k}']] += m * cw[:, k]
    W[:, BI['palm']] = np.maximum(palm, 0)
    # rigid nail units
    fixed = np.zeros(n, dtype=bool)
    for f in FINGERS:
        r = in_nail(hand.nails[f], V, RIGID_MARGIN)
        W[r] = 0
        W[r, BI[f + '.03']] = 1
        fixed |= r
    E = adjacency(F, n)
    W = smooth(W, E, n, SMOOTH_PASSES, fixed=fixed)
    # the first web between the thumb's proximal phalanx and the index root
    # is only a few mm wide at rest: diffuse its weights much further, so the
    # thumb's motion spreads over all of it instead of a 2 mm band
    jt = hand.info['thumb']['jx']
    st = thumb_s
    webr = (dist['thumb'] < WEB_REACH) & (dist['index'] < WEB_REACH) & (st > jt[0] + 8.0) & (st < jt[2] + 2.0)
    if webr.any():
        # the thumb's own surface keeps its weights (its skin turns with the
        # phalanx); only the web between thumb and index is diffused
        on_thumb = dist['thumb'] < WEB_THUMB_KEEP
        W = smooth(W, E, n, WEB_PASSES, fixed=fixed | ~webr | on_thumb)
    # keep the four largest
    idx = np.argsort(-W, 1)
    keep = np.zeros_like(W, dtype=bool)
    np.put_along_axis(keep, idx[:, :4], True, 1)
    W = np.where(keep & (W > 1e-3), W, 0)
    W /= W.sum(1, keepdims=True)
    return W


def vertex_normals(V, F):
    if F.shape[1] == 4:
        fn = np.cross(V[F[:, 2]] - V[F[:, 0]], V[F[:, 3]] - V[F[:, 1]])
    else:
        fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    vn = np.zeros_like(V)
    for i in range(F.shape[1]):
        np.add.at(vn, F[:, i], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def masks(hand, V, F, Nv):
    n = len(V)
    E = adjacency(F, n)
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    acc = np.zeros((n, 3))
    np.add.at(acc, E[:, 0], V[E[:, 1]])
    np.add.at(acc, E[:, 1], V[E[:, 0]])
    el = np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1)
    elv = np.zeros(n)
    np.add.at(elv, E[:, 0], el)
    np.add.at(elv, E[:, 1], el)
    elv /= np.maximum(cnt, 1)
    lap = acc / np.maximum(cnt, 1)[:, None] - V
    conc = 2.0 * (lap * Nv).sum(1) / np.maximum(elv, 1e-9) ** 2
    conc = smooth(conc[:, None], E, n, 2)[:, 0]
    R = np.zeros(n)
    G = smoothstep(0.0, 0.6, -Nv[:, 2])
    B = smoothstep(0.03, 0.15, conc) * 0.8
    A = np.zeros(n)
    for f in FINGERS:
        t = hand.fingers[f]
        d, lf = t(V, local=True)
        fade = smoothstep(4.0, 0.8, d)
        sel = fade > 0
        if not sel.any():
            continue
        jx = hand.info[f]['jx']
        s = lf['s']
        ang = np.arctan2(lf['z'] / np.maximum(lf['b'], 1e-3), lf['x'] / np.maximum(lf['a'], 1e-3))
        sn = np.sin(ang)
        back_w = np.clip(sn, 0, 1) ** 2
        side_w = 1 - sn ** 2
        pad_w = smoothstep(0.0, 0.55, -sn)
        tipz = smoothstep(jx[2] + 0.25 * (jx[3] - jx[2]), jx[3] + 2.0, s)
        g = np.zeros(n)
        for k in (1, 2):
            g = np.maximum(g, np.exp(-((s - jx[k]) / 6.0) ** 2))
        gk = np.exp(-((s - jx[0]) / 9.0) ** 2)
        r_f = 0.7 * tipz + 0.4 * g * back_w + 0.3 * gk * back_w
        b_f = 0.5 * g * pad_w ** 2
        a_f = 0.9 * tipz + 0.45 * side_w * (1 - tipz)
        R = np.maximum(R, r_f * fade)
        G = G + (pad_w - G) * fade
        B = np.maximum(B, b_f * fade)
        A = np.maximum(A, a_f * fade)
        nu = hand.nails[f]
        x, y, z = nail_local(nu, V)
        o = np.maximum.reduce([np.abs(x) - nu.hw(y), nu.cuticle_y(x) - y, y - (nu.yh + 1.0)])
        near = (z > nu.z_top(x, y) - 4.0) & (y > nu.yc - 8)
        fold = np.exp(-(np.maximum(o, 0) / 2.5) ** 2) * near
        groove = np.exp(-(np.maximum(o, 0) / 0.7) ** 2) * near * (o > -1.0)
        R = np.maximum(R, 0.6 * fold)
        B = np.maximum(B, 0.55 * groove)
    for f in FINGERS[1:]:
        head = hand.sk[f]['joints'][0]
        d = np.linalg.norm(V - head, axis=1)
        R = np.maximum(R, 0.3 * np.exp(-(d / 12.0) ** 2) * smoothstep(0.2, 0.6, Nv[:, 2]))
        web = np.exp(-(d / 18.0) ** 2) * smoothstep(0.0, 0.09, conc) * (1 - smoothstep(0.3, 0.8, Nv[:, 2]))
        A = np.maximum(A, 0.6 * web)
        B = np.maximum(B, 0.45 * web)
    d = np.linalg.norm(V - hand.sk['thumb']['joints'][1], axis=1)
    R = np.maximum(R, 0.35 * np.exp(-(d / 24.0) ** 2) * smoothstep(-0.2, 0.4, -Nv[:, 2]))
    col = np.clip(np.stack([R, G, B, A], 1), 0, 1)
    col = smooth(col, E, n, 3)
    # no cavity on the forearm (the old notch)
    arm = hand.forearm(V, local=True)[1]['s'] > hand.info['forearm']['wrist_s'] + 14
    col[arm, 2] = np.minimum(col[arm, 2], 0.25)
    return col
