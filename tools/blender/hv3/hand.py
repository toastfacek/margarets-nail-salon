"""The hv3 hand as one signed distance field, built from the skeleton.

Layers (all smooth-unioned):
  forearm and wrist tube (oval, ulnar head, radial styloid)
  palm core (an outline extruded between a dorsal and a volar height field,
    edges rounded)
  four finger tubes and the thumb tube (profiles keyed to the joints:
    knuckle caps, joint creases, pads, the pulp)
  thenar and hypothenar masses, the distal palm pads, the first web and the
    first dorsal interosseous, the interdigital webs
Fine features (creases, nail grooves) are added in hand_detail().
"""
import numpy as np

import skeleton as SK
from sdf import (Capsule, Ellipsoid, TriSlab, Tube, cr_interp, densify, frame_R,
                 poly_sdf, smax, smin, smoothstep, unit)

FINGERS = SK.FINGERS

# finger cross-sections, index finger, mm. Control points along the finger:
# (where, half width, dorsal, volar, n dorsal, n volar, dorsal offset)
# 'where' is a joint index plus a fraction of the next phalanx (0 = MCP,
# 1 = PIP, 2 = DIP, 3 = bone tip, 3+ = past it, toward the pulp's end).
FINGER_PROFILE = [
    (-0.45, 5.5, 3.8, 5.5, 2.2, 2.3, 0.0),
    (-0.22, 7.6, 6.6, 7.8, 2.2, 2.3, 0.0),
    (-0.07, 8.2, 7.2, 8.2, 2.2, 2.3, 0.0),
    (0.00, 8.4, 7.0, 8.8, 2.3, 2.5, 0.0),    # MCP: the knuckle (soft)
    (0.22, 8.0, 6.2, 8.5, 2.4, 2.7, 0.0),    # base of the proximal phalanx (web level): no thickening
    (0.38, 7.7, 6.0, 7.8, 2.45, 2.8, 0.0),   # the palmar digital crease
    (0.62, 7.4, 5.8, 7.8, 2.5, 2.8, 0.0),    # mid proximal phalanx, its pad
    (0.85, 7.1, 5.8, 7.0, 2.5, 2.7, 0.0),
    (1.00, 7.1, 5.8, 6.6, 2.45, 2.5, 0.0),   # PIP: no knob
    (1.15, 6.9, 5.6, 6.6, 2.45, 2.6, 0.0),
    (1.50, 6.5, 5.1, 6.9, 2.5, 2.7, 0.0),    # middle phalanx pad
    (1.85, 6.25, 5.0, 6.2, 2.5, 2.6, 0.0),
    (2.00, 6.25, 5.0, 5.9, 2.45, 2.45, 0.0), # DIP
    (2.20, 6.1, 4.7, 6.0, 2.7, 2.5, 0.0),
    (2.55, 5.85, 4.4, 5.7, 2.9, 2.4, 0.0),    # under the nail: flat back, a slim pulp
    (2.85, 5.5, 4.1, 5.3, 2.9, 2.3, 0.0),
    (3.00, 5.1, 3.9, 4.8, 2.8, 2.2, 0.0),    # bone tip
]
FINGER_SCALE = {'index': (1.0, 1.0), 'middle': (1.04, 1.03), 'ring': (0.97, 0.98), 'pinky': (0.85, 0.9)}
# (width scale, height scale)

THUMB_PROFILE = [
    (-0.22, 4.95, 4.14, 4.14, 2.2, 2.2, 0.0),
    (0.0, 8.1, 7.36, 7.36, 2.2, 2.2, 0.0),
    (0.2, 8.55, 7.36, 7.82, 2.2, 2.2, 0.0),
    (0.4, 9.0, 7.36, 8.28, 2.2, 2.2, 0.0),
    (0.75, 8.46, 6.99, 8.65, 2.3, 2.3, 0.0),
    (1.0, 9.54, 7.91, 8.1, 2.3, 2.4, 0.0),
    (1.2, 9.0, 6.99, 7.54, 2.35, 2.5, 0.0),
    (1.55, 8.64, 6.44, 7.36, 2.4, 2.5, 0.0),
    (1.85, 8.73, 6.62, 6.99, 2.4, 2.4, 0.0),
    (2.0, 8.8, 6.9, 6.81, 2.35, 2.4, 0.0),
    (2.2, 8.82, 6.26, 7.36, 2.6, 2.4, 0.0),
    (2.55, 8.0, 5.6, 7.0, 2.8, 2.3, 0.0),
    (2.85, 7.3, 5.2, 6.5, 2.8, 2.25, 0.0),
    (3.0, 6.6, 4.8, 5.8, 2.7, 2.2, 0.0),
]


def _tip_falloff(prof, s_tip, ext, starts):
    """Append points past the bone tip so each radius falls to zero at the
    spine's end along a quarter ellipse; starts: (a, bd, bv) fall start before the end."""
    S = s_tip + ext
    rows = [list(r) for r in prof]
    last = rows[-1]
    s_fall = S - max(starts)
    out = [r for r in rows if r[0] < s_fall - 0.75]
    samples = s_fall + (S - s_fall) * np.sin(np.linspace(0, np.pi / 2, 16))
    base = {k: last[i] for k, i in (('a', 1), ('bd', 2), ('bv', 3))}
    # value at each sample: constant until its start, then the quarter ellipse
    for sv in samples:
        r = [sv]
        for key, i, st in (('a', 1, starts[0]), ('bd', 2, starts[1]), ('bv', 3, starts[2])):
            s0 = S - st
            if sv <= s0:
                # before the fall: the profile's own value at sv (from the original rows)
                xs = [q[0] for q in rows]
                ys = [q[i] for q in rows]
                v = float(np.interp(sv, xs, ys))
            else:
                v0 = float(np.interp(s0, [q[0] for q in rows], [q[i] for q in rows]))
                tt = min(1.0, (sv - s0) / st)
                v = v0 * np.sqrt(max(0.0, 1 - tt * tt))
            r.append(max(v, 0.05))
        r += [last[4], last[5], last[6]]
        out.append(r)
    return out


def finger_tube(sk, f):
    ch = sk[f]
    J = ch['joints']
    frames = ch['frames']
    ext = SK.TIP_EXT[f]
    f3, u3, w3 = frames[-1]
    # the pulp's end sits a little palmward of the bone axis
    tip_end = J[-1] + f3 * ext - w3 * 1.8
    back = J[0] - frames[0][0] * 18.0 - np.array([0.0, 0.0, 4.0])
    ctrl = np.vstack([back, J, tip_end])
    pts, s, cs = densify(ctrl, per_mm=1.2, smooth=10)
    # joint arc lengths: cs[1]=MCP, cs[2]=PIP, cs[3]=DIP, cs[4]=bone tip
    jx = cs[1:5]

    def s_of(where):
        if where < 0:
            return jx[0] + where * (jx[1] - jx[0])
        k = int(np.floor(where))
        k = min(k, 2)
        return jx[k] + (where - k) * (jx[k + 1] - jx[k])

    ws, hs = FINGER_SCALE.get(f, (1.0, 1.0))
    prof = [(s_of(r[0]), r[1] * ws, r[2] * hs, r[3] * hs, r[4], r[5], r[6]) for r in FINGER_PROFILE]
    prof = _tip_falloff(prof, jx[3], s[-1] - jx[3], (13.0 * ws, 6.0 * hs, 8.5 * hs))
    prof = np.array(prof)
    # dorsal axis per sample: each phalanx's w, blended over +-4 mm at the joints
    W = np.zeros_like(pts)
    for i, sv in enumerate(s):
        acc = frames[0][2].copy()
        for j in (1, 2):  # PIP, DIP
            tj = smoothstep(jx[j] - 4, jx[j] + 4, sv)
            acc = acc * (1 - tj) + frames[j][2] * tj
        W[i] = acc
    P = dict(s=prof[:, 0], a=prof[:, 1], bd=prof[:, 2], bv=prof[:, 3], nd=prof[:, 4], nv=prof[:, 5], oz=prof[:, 6])
    return Tube(pts, W, P), dict(jx=jx, pts=pts, s=s)


def thumb_tube(sk):
    ch = sk['thumb']
    J = ch['joints']
    frames = ch['frames']
    ext = SK.TIP_EXT['thumb']
    f3, u3, w3 = frames[-1]
    tip_end = J[-1] + f3 * ext - w3 * 1.5
    back = J[0] - frames[0][0] * 9.0 - np.array([0.0, 0.0, 1.5])
    ctrl = np.vstack([back, J, tip_end])
    pts, s, cs = densify(ctrl, per_mm=1.2, smooth=4)
    jx = cs[1:5]

    def s_of(where):
        if where < 0:
            return jx[0] + where * (jx[1] - jx[0])
        k = min(int(np.floor(where)), 2)
        return jx[k] + (where - k) * (jx[k + 1] - jx[k])

    prof = [(s_of(r[0]), r[1], r[2], r[3], r[4], r[5], r[6]) for r in THUMB_PROFILE]
    prof = np.array(_tip_falloff(prof, jx[3], s[-1] - jx[3], (13.0, 7.0, 10.0)))
    W = np.zeros_like(pts)
    for i, sv in enumerate(s):
        acc = frames[0][2].copy()
        t1 = smoothstep(jx[1] - 5, jx[1] + 5, sv)
        acc = acc * (1 - t1) + frames[1][2] * t1
        t2 = smoothstep(jx[2] - 4, jx[2] + 4, sv)
        acc = acc * (1 - t2) + frames[2][2] * t2
        W[i] = acc
    P = dict(s=prof[:, 0], a=prof[:, 1], bd=prof[:, 2], bv=prof[:, 3], nd=prof[:, 4], nv=prof[:, 5], oz=prof[:, 6])
    return Tube(pts, W, P, cap0=True), dict(jx=jx, pts=pts, s=s)


def forearm_tube():
    drop = np.radians(SK.FOREARM_DROP)
    # spine from inside the palm back to the cut; behind the wrist it bends
    # down by the wrist extension (the hand stays put)
    # straight from inside the palm to the wrist, then a gentle arc (radius
    # BEND_R: the back of the wrist must not fold), then straight to the cut
    BEND_R = 38.0
    pts = [np.array([0.0, 14.0 - 0.5 * i, -1.0]) for i in range(29)]      # Y 14 .. 0
    W = [np.array([0.0, 0.0, 1.0])] * 29
    c = np.array([0.0, 0.0, -1.0 - BEND_R])      # centre of the bend, below the axis
    n_arc = max(4, int(BEND_R * drop / 0.5))
    for i in range(1, n_arc + 1):
        a = drop * i / n_arc
        pts.append(c + BEND_R * np.array([0.0, -np.sin(a), np.cos(a)]))
        W.append(np.array([0.0, -np.sin(a), np.cos(a)]))
    d = np.array([0.0, -np.cos(drop), -np.sin(drop)])
    L_arc = BEND_R * drop
    rest = SK.FOREARM_LEN - L_arc
    for i in range(1, int(rest / 0.5) + 1):
        pts.append(pts[28 + n_arc] + d * 0.5 * i)
        W.append(W[28 + n_arc])
    pts = np.array(pts)
    W = np.array(W)
    s = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    w0 = s[28]   # the wrist
    S = s[-1]
    prof = np.array([
        # s, a, bd, bv, nd, nv
        (0.0, 17.0, 6.0, 9.0, 2.3, 2.6),
        (w0 - 6, 24.6, 11.0, 17.0, 2.4, 2.6),
        (w0, 23.4, 11.8, 19.6, 2.4, 2.5),       # the wrist: a slim oval, about 50 x 36
        (w0 + 12, 23.8, 13.4, 20.0, 2.35, 2.4),
        (w0 + 30, 25.2, 15.4, 20.6, 2.25, 2.3),
        (w0 + 55, 27.0, 17.4, 21.4, 2.2, 2.2),
        (S - 22, 27.6, 17.8, 21.6, 2.2, 2.2),
        (S, 23.0, 14.6, 17.6, 2.2, 2.2),       # a soft taper into the rounded end

    ])
    P = dict(s=prof[:, 0], a=prof[:, 1], bd=prof[:, 2], bv=prof[:, 3], nd=prof[:, 4], nv=prof[:, 5])
    t = Tube(pts, W, P)
    t.end_round = 10.0
    return t, dict(wrist_s=w0)


# ---- the palm core ---------------------------------------------------------------------------
PALM_OUTLINE = [(-21.5, -7.0), (0.0, -9.0), (21.5, -7.0), (29.0, 22.0), (34.6, 46.0), (34.8, 62.0), (34.1, 74.0), (28.4, 83.0), (12.6, 90.0), (-5.2, 96.0), (-23.9, 94.0), (-29.0, 78.0), (-27.0, 50.0), (-25.5, 22.0)]
PALM_ROUND = 7.5          # the back's edge
PALM_ROUND_V = 4.0        # the underside's edge (the heel and pads carry the volume)


def _closed_spline(pts, n=12):
    """A closed Catmull-Rom curve through the outline points (a smooth
    outline: a polygon's straight edges and corners show through the
    rounding as facets)."""
    P_ = np.asarray(pts, dtype=np.float64)
    m = len(P_)
    out = []
    for k in range(m):
        p0, p1, p2, p3 = P_[(k - 1) % m], P_[k], P_[(k + 1) % m], P_[(k + 2) % m]
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return np.array(out)


def _rint(a, b, R):
    v = np.stack([a + R, b + R], axis=1)
    return np.linalg.norm(np.maximum(v, 0), axis=1) + np.minimum(v.max(axis=1), 0) - R


_OUTLINE = _closed_spline(PALM_OUTLINE)


def mcp_line(X):
    """Y of the knuckle line (MCP centres) across the hand."""
    xs = [SK.MC[f][1][0] for f in ('index', 'middle', 'ring', 'pinky')]
    ys = [SK.MC[f][1][1] for f in ('index', 'middle', 'ring', 'pinky')]
    return np.interp(X, xs, ys)


def mcp_z(X):
    xs = [SK.MC[f][1][0] for f in ('index', 'middle', 'ring', 'pinky')]
    zs = [SK.MC[f][1][2] for f in ('index', 'middle', 'ring', 'pinky')]
    return np.interp(X, xs, zs)


def palm_dorsal(X, Y):
    # along the middle metacarpal: high at the wrist, lower at the knuckles
    z = cr_interp(Y, [0, 12, 30, 50, 70], [10.6, 11.6, 12.5, 11.6, 10.2])
    xc = -4.0
    curv = 0.0036 + 0.0026 * smoothstep(5.0, 32.0, Y)    # flatter across at the wrist
    z = z - curv * (X - xc) ** 2 - 0.10 * 3.0 * np.logaddexp(0.0, (X - 12.0) / 3.0) * smoothstep(5.0, 32.0, Y)
    # shallow valleys between the metacarpals over the distal half
    heads = [SK.MC[f][1] for f in ('index', 'middle', 'ring', 'pinky')]
    bases = [SK.MC[f][0] for f in ('index', 'middle', 'ring', 'pinky')]
    for i in range(3):
        t = np.clip((Y - 22.0) / 60.0, 0, 1)
        xm = 0.5 * ((bases[i][0] + (heads[i][0] - bases[i][0]) * t) + (bases[i + 1][0] + (heads[i + 1][0] - bases[i + 1][0]) * t))
        z = z - 0.2 * np.exp(-((X - xm) / 3.6) ** 2) * smoothstep(38.0, 62.0, Y) * (1 - smoothstep(80.0, 90.0, Y))
    # past the knuckle line the core thins to nothing (the knuckle caps and
    # fingers take over): it closes onto the knuckles' mid plane
    t = smoothstep(-10.0, 9.0, Y - mcp_line(X))
    return z * (1 - t) + (mcp_z(X) + 1.0) * t


def _g(X, Y, cx, cy, sx, sy, ang=0.0):
    c, s_ = np.cos(np.radians(ang)), np.sin(np.radians(ang))
    u = (X - cx) * c + (Y - cy) * s_
    v = -(X - cx) * s_ + (Y - cy) * c
    return np.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))


def palm_volar(X, Y):
    """The palm's underside as a height field: it rests on the towel at the
    heel (thenar, hypothenar) and under the knuckles; the middle is hollow."""
    z = np.full_like(X, SK.DESK_Z + 0.4)
    z = z + 2.8 * _g(X, Y, -1.0, 49.0, 15.0, 20.0, -10.0)          # the hollow of the palm
    # the distal palm: no flat strip; it lifts gently off the towel toward the
    # finger roots (the interdigital pads are mounds, added in Hand)
    z = z + 2.6 * smoothstep(-26.0, -4.0, Y - mcp_line(X))
    z = z + 2.0 * _g(X, Y, 0.0, 12.0, 9.0, 7.0)                    # between the heels, at the wrist
    # behind the heel the wrist rises toward the forearm
    z = z + np.clip((8.0 - Y) * 0.22, 0, None)
    # past the knuckle line the pads give way to the finger bases
    t = smoothstep(-3.0, 14.0, Y - mcp_line(X))
    return z * (1 - t) + (mcp_z(X) - 1.0) * t


def palm_core(P):
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    o = poly_sdf(P[:, :2], _OUTLINE)
    top = Z - palm_dorsal(X, Y)
    bot = palm_volar(X, Y) - Z
    return np.maximum(_rint(o, top, PALM_ROUND), _rint(o, bot, PALM_ROUND_V))


class Hand:
    def __init__(self, sk=None, nails=True, detail=True):
        self.nails = None
        self.detail = detail
        self.sk = sk or SK.build()
        sk = self.sk
        self.fingers = {}
        self.info = {}
        for f in FINGERS[1:]:
            self.fingers[f], self.info[f] = finger_tube(sk, f)
        self.fingers['thumb'], self.info['thumb'] = thumb_tube(sk)
        self.forearm, self.info['forearm'] = forearm_tube()
        T = sk['thumb']['joints']
        cmc, mcp1 = T[0], T[1]
        mc1 = mcp1 - cmc
        # thenar: the main mound along the first metacarpal's palm side, a
        # second toward the palm's middle (short flexor, adductor)
        self.thenar = [
            Ellipsoid(0.5 * (np.array([-17.0, 13.0, -8.0]) + mcp1) + np.array([3.5, -2.0, -2.4]), (13.0, 0.5 * np.linalg.norm(mcp1[:2] - np.array([-17.0, 13.0])) + 4.0, 9.0),
                      frame_R((mcp1 - np.array([-17.0, 13.0, -8.0])) * [1, 1, 0], [0.15, 0, 1])),
            Ellipsoid(np.array([-11.0, 33.0, -8.4]), (10.0, 17.0, 8.0), frame_R([-0.3, 1, 0], [0, 0, 1])),
        ]
        self.hypothenar = Ellipsoid(np.array([24.0, 34.0, -8.6]), (10.4, 30.0, 7.4), frame_R([0.12, 1, 0], [-0.2, 0, 1]))
        self.pisiform = Ellipsoid(np.array([18.0, 6.0, -13.0]), (4.6, 5.5, 4.0))
        # distal palm pads, under and just past each knuckle
        self.pads = []
        for f in FINGERS[1:]:
            mcp = sk[f]['joints'][0]
            fw = sk[f]['frames'][0][0]
            c = mcp + np.array([0.0, 1.0, 0.0])
            c[2] = SK.DESK_Z + 3.5 + 0.6
            self.pads.append(Ellipsoid(c, (7.5 * FINGER_SCALE[f][0], 8.0, 3.5), frame_R(fw * [1, 1, 0], [0, 0, 1])))
        # interdigital pads: soft mounds between the finger roots, under the webs
        self.mounds = []
        for a, b in (('index', 'middle'), ('middle', 'ring'), ('ring', 'pinky')):
            ma, mb = sk[a]['joints'][0], sk[b]['joints'][0]
            x = 0.5 * (ma[0] + mb[0])
            y = 0.5 * (ma[1] + mb[1]) + 1.0
            zs = float(palm_volar(np.array([x]), np.array([y]))[0])
            self.mounds.append(Ellipsoid(np.array([x, y - 1.0, zs + 2.5 - 0.5]), (8.0, 10.0, 2.5), frame_R([0, 1, 0], [0, 0, 1])))
        # knuckle caps: the metacarpal heads under the dorsal skin
        self.knuckles = []
        for f in FINGERS[1:]:
            b_, h_ = (np.array(p) for p in SK.MC[f])
            ax = unit(h_ - b_)
            sc = FINGER_SCALE[f][0]
            self.knuckles.append(Ellipsoid(h_ - ax * 1.5 + np.array([0, 0, 1.6]), (6.0 * sc, 11.0, 4.6 * sc), frame_R(ax, [0, 0, 1])))
        # interdigital webs
        self.webs = []
        for a, b in (('index', 'middle'), ('middle', 'ring'), ('ring', 'pinky')):
            ja, jb = sk[a]['joints'], sk[b]['joints']
            m0 = 0.5 * (ja[0] + jb[0]) + np.array([0, 1.0, -1.0])
            m1 = 0.5 * (ja[0] + 0.36 * (ja[1] - ja[0]) + jb[0] + 0.36 * (jb[1] - jb[0])) + np.array([0, 0, -4.5])
            self.webs.append(Capsule(m0, m1, 6.0, 4.2))
        # first web and the first dorsal interosseous
        idx = sk['index']['joints']
        p1 = T[1] + 0.50 * (T[2] - T[1])
        self.web1 = TriSlab(cmc + 0.30 * mc1 + np.array([8, 0, 1]), idx[0] + np.array([-5.0, -4.0, -2.5]), p1 + np.array([3.0, 0.5, 0.5]), 3.5, 3.0, 2.6)
        mc2b, mc2h = np.array(SK.MC['index'][0]), np.array(SK.MC['index'][1])
        mid = 0.5 * (cmc + 0.55 * mc1 + mc2b + 0.55 * (mc2h - mc2b))
        self.fdi = Ellipsoid(mid + np.array([3.0, 2.0, 2.5]), (9.0, 17.0, 7.5), frame_R(mc2h - mc2b, [0, 0, 1]))
        self.ulnar_head = Ellipsoid(np.array([16.5, -9.0, 4.5]), (7.0, 8.0, 3.0))
        self._tendons(sk)
        self.styloid = Ellipsoid(np.array([-24.5, -1.0, -3.0]), (3.5, 6.0, 4.5))
        if nails:
            self.build_nails()

    def eval(self, P, cull=True):
        d = palm_core(P)
        for e in self.thenar:
            d = smin(d, e(P), 7.0)
        d = smin(d, self.hypothenar(P), 7.0)
        d = smin(d, self.pisiform(P), 5.0)
        for e in self.knuckles:
            d = smin(d, e(P), 2.5)
        d = smin(d, self.fdi(P), 6.0)
        d = smin(d, self.web1(P), 5.0)
        d = smin(d, self._tube(self.forearm, P, d, cull), 7.0)
        d = smin(d, self.ulnar_head(P), 8.0)
        for e in self.mounds:
            d = smin(d, e(P), 8.0)
        for w in self.webs:
            d = smin(d, w(P), 3.0)
        df = None
        for f in FINGERS[1:]:
            t = self._carve(f, P, self._tube(self.fingers[f], P, d, cull, self._cr(f)))
            df = t if df is None else np.minimum(df, t)
        d = smin(d, df, 4.5)
        d = smin(d, self._carve('thumb', P, self._tube(self.fingers['thumb'], P, d, cull, self._cr('thumb'))), 7.0)
        near = np.abs(d) < 3.0
        if near.any():
            d = d.copy()
            d[near] -= self.ridge_field(P[near])
        if self.detail:
            import detail
            near = np.abs(d) < 2.0
            if near.any():
                d = d.copy()
                d[near] += detail.palm_creases(P[near])
        return d

    def _tendons(self, sk):
        """Tendons that show under the skin, as soft ridges added to the
        distance field (a young hand: a few tenths of a millimetre): the four
        extensors over the back of the hand, the thumb's two extensors with the
        snuffbox hollow between them, the two wrist flexors on the volar
        wrist. Each is a polyline lying on the surface: (points, height mm,
        width mm)."""
        R = []
        T = sk['thumb']['joints']
        fr = sk['thumb']['frames']

        def on_dorsum(x, y, lift=0.0):
            return (x, y, float(palm_dorsal(np.array([x]), np.array([y]))[0]) + lift)

        for f, x0 in zip(('index', 'middle', 'ring', 'pinky'), (-9.0, -3.5, 3.0, 9.5)):
            hd = np.array(SK.MC[f][1])
            pts = [on_dorsum(x0 + (hd[0] - x0) * t, 2.0 + (hd[1] - 10.0 - 2.0) * t) for t in np.linspace(0, 0.55, 5)]
            R.append((np.array(pts), 0.06 if f != 'pinky' else 0.04, 3.0))
        mcp_d = T[1] + fr[1][2] * 8.0
        epl = [(-10.0, -8.0, 13.5), (-15.0, 2.0, 11.0), (-22.0, 14.0, 7.5), tuple(mcp_d - fr[0][0] * 5.0)]
        epb = [(-26.5, -6.0, 3.5), (-31.0, 8.0, 2.0), (-35.0, 24.0, 0.5), tuple(mcp_d - fr[0][0] * 8.0 - fr[0][2] * 1.0)]
        R.append((np.array(epl), 0.1, 3.0))
        R.append((np.array(epb), 0.08, 3.0))
        R.append((np.array([(-25.0, 0.0, 5.5), (-29.0, 9.0, 4.0), (-32.0, 17.0, 3.0)]), -0.2, 3.5))   # the snuffbox, a whisper
        fa = self.forearm
        w0 = self.info['forearm']['wrist_s']
        for x0, hgt in ((-1.0, 0.12), (-10.0, 0.12)):
            pts = []
            for sv in (w0 - 4, w0 + 4, w0 + 12, w0 + 21):
                k = int(np.searchsorted(fa.s, sv))
                bv = float(np.interp(sv, fa.prof['s'], fa.prof['bv']))
                pts.append(fa.p[k] + fa.U[k] * x0 - fa.W[k] * (bv * (1 - 0.06 * (x0 / 10.0) ** 2)))
            R.append((np.array(pts), hgt, 1.5))
        self.ridges = R

    def ridge_field(self, P):
        out = np.zeros(len(P))
        for pts, hgt, w in self.ridges:
            best = np.full(len(P), np.inf)
            tt = np.zeros(len(P))
            L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                ab = b - a
                t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
                d = np.linalg.norm(P - (a + t[:, None] * ab), axis=1)
                m = d < best
                best = np.where(m, d, best)
                tt = np.where(m, (L[i] + t * np.linalg.norm(ab)) / L[-1], tt)
            ends = smoothstep(0.0, 0.25, tt) * smoothstep(1.0, 0.75, tt)
            out += hgt * np.exp(-(best / w) ** 2) * ends
        return out

    def _cr(self, f):
        if not self.detail:
            return None
        return (self.info[f]['jx'], f == 'thumb')

    def _carve(self, f, P, t):
        if not self.nails:
            return t
        nu = self.nails[f]
        near = np.linalg.norm(P - nu.o, axis=1) < 32
        if near.any():
            t = t.copy()
            import nails3
            g, lip = nu.groove(P[near], lips=True)
            t[near] = smax(t[near], -g, nails3.GROOVE_K) - lip
        return t

    def build_nails(self):
        import nails3
        self.nails = {f: nails3.NailUnit(self, f) for f in FINGERS}
        return self.nails

    def _tube(self, tube, P, d, cull, creases=None):
        lb = tube.coarse_lower_bound(P)
        need = lb < d + 12.0
        out = lb.copy()
        if need.any():
            if creases is None:
                out[need] = tube(P[need])
            else:
                v, loc = tube(P[need], local=True)
                near = np.abs(v) < 2.0
                if near.any():
                    import detail
                    sub = {k: a[near] for k, a in loc.items()}
                    v[near] += detail.finger_creases(sub, creases[0], creases[1])
                out[need] = v
        return out
