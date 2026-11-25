"""hv3 nail units: the groove each nail plate sits in (an SDF carve of the
skin) and the plate itself (a mesh), both in the finger's distal frame.

Distal frame (per finger): origin at the last joint's centre (DIP; thumb: IP),
f along the last bone, u across (toward the ulnar side for the long fingers),
w dorsal (out of the nail). y = along f from the joint, x = along u, z = along w.

Plate: top surface z_top(x, y) = z_c(y) - (R - sqrt(R^2 - x^2)) (the C-curve),
thickness T, outline: a U-shaped cuticle, straight slightly converging sides,
a rounded free edge NAIL_FREE mm past the hyponychium (where the fingertip
skin starts to fall away under the plate).
"""
import numpy as np

import skeleton as SK
from sdf import smax, smoothstep, unit

# per finger: cuticle and hyponychium (mm from the joint centre along the bone),
# visible plate width / finger width, C-curve arc across the visible plate (deg)
NAIL = {
    'thumb':  dict(yc=6.0, yh=19.0, wfrac=0.74, arc=95.0),
    'index':  dict(yc=5.4, yh=15.9, wfrac=0.78, arc=92.0),
    'middle': dict(yc=5.7, yh=16.9, wfrac=0.78, arc=92.0),
    'ring':   dict(yc=5.6, yh=16.7, wfrac=0.77, arc=90.0),
    'pinky':  dict(yc=5.0, yh=14.3, wfrac=0.76, arc=86.0),
}
T = 0.5            # plate thickness
SINK = 0.22        # plate top below the skin's original surface on the centre line
TAPER = 0.05       # the sides converge this much (fraction of the half width) toward the tip
CUT_ARC = 0.52     # cuticle sagitta, x half width
TUCK_PROX = 1.2    # the plate runs this far under the proximal fold (hidden)
TUCK_SIDE = 0.45   # ... and under the side folds
FREE = 2.6         # free edge past the hyponychium (mm), the render default
FREE_SLOPE = 0.45  # past the hyponychium the plate keeps this much of the bed's downward slope
TIP_ROUND = 0.95   # free edge outline: 0 square .. 1 full half-ellipse
GROOVE_K = 0.42    # blend radius of the groove walls
ARCH = 0.010       # longitudinal convexity of the plate: mm drop per mm^2 from the bed's middle
LIP_PROX = 0.28    # the proximal fold's lip above the original skin (mm)
LIP_SIDE = 0.38    # the lateral folds' rise
LIP_W = 1.10       # their width (mm, outside the outline)


class NailUnit:
    def __init__(self, hand, f):
        sk = hand.sk
        self.f = f
        J = sk[f]['joints']
        fr = sk[f]['frames'][-1]
        self.o = J[2].copy() if f != 'thumb' else J[2].copy()
        self.F, self.U, self.W = (np.array(v) for v in fr)
        p = NAIL[f]
        self.yc, self.yh = p['yc'], p['yh']
        tube = hand.fingers[f]
        self.tube = tube
        # the skin's original dorsal height over the nail (centre line and across)
        ys = np.linspace(self.yc - 4, self.yh + 3, 30)
        self.ys = ys
        self.zc = np.array([self._surf(y, 0.0) for y in ys])
        ymid = 0.5 * (self.yc + self.yh)
        # finger half width at mid nail: march sideways
        self.half_finger = self._side(ymid)
        self.hw0 = p['wfrac'] * self.half_finger
        a = np.radians(p['arc']) / 2
        self.R = self.hw0 / np.sin(a)
        # the bed's downward slope at the hyponychium, for the free edge
        i = np.searchsorted(ys, self.yh)
        self.slope_h = (self.zc[i] - self.zc[i - 3]) / (ys[i] - ys[i - 3])

    # ---- probing the skin -------------------------------------------------------
    def _pt(self, x, y, z):
        return self.o + self.F * y + self.U * x + self.W * z

    def _surf(self, y, x):
        lo, hi = -2.0, 14.0
        for _ in range(40):
            m = 0.5 * (lo + hi)
            d = self.tube(self._pt(x, y, m)[None])[0]
            lo, hi = (m, hi) if d < 0 else (lo, m)
        return 0.5 * (lo + hi)

    def _side(self, y):
        lo, hi = 0.0, 16.0
        zc = float(np.interp(y, self.ys, self.zc)) - 4.0
        for _ in range(40):
            m = 0.5 * (lo + hi)
            d = self.tube(self._pt(m, y, zc)[None])[0]
            lo, hi = (m, hi) if d < 0 else (lo, m)
        return 0.5 * (lo + hi)

    # ---- plate geometry -----------------------------------------------------------
    def hw(self, y):
        t = np.clip((y - self.yc) / (self.yh - self.yc), 0, 1.4)
        return self.hw0 * (1 - TAPER * t)

    def z_centre(self, y):
        ym = 0.5 * (self.yc + self.yh)
        yy = np.minimum(y, self.yh)
        zb = np.interp(yy, self.ys, self.zc) - SINK - ARCH * ((yy - ym) ** 2 - (0.5 * (self.yh - self.yc)) ** 2 * 0.35)
        past = np.maximum(y - self.yh, 0)
        return zb + FREE_SLOPE * self.slope_h * past - 0.004 * past ** 2

    def z_top(self, x, y):
        R = self.R
        xx = np.minimum(np.abs(x), R * 0.999)
        return self.z_centre(y) - (R - np.sqrt(R * R - xx * xx))

    def cuticle_y(self, x):
        hw = self.hw0
        return self.yc + CUT_ARC * hw * (np.clip(np.abs(x) / hw, 0, 1.2)) ** 2

    def free_y(self, x, free):
        """The free edge outline: y at which the plate ends, per x."""
        hw = self.hw(self.yh + free)
        u = np.clip(np.abs(x) / hw, 0, 1)
        e = 2.0 + 6.0 * (1 - TIP_ROUND)        # superellipse exponent
        depth = min(free + 0.8, hw * 0.75)       # how far the rounding reaches back
        return self.yh + free - depth * (1 - (1 - u ** e) ** (1 / e))

    # ---- the groove (SDF) ------------------------------------------------------------
    def local(self, P):
        q = P - self.o
        return q @ self.U, q @ self.F, q @ self.W

    def groove(self, P, lips=False):
        """Positive outside the open groove: the region above the plate's
        underside, inside the visible outline, over the bed only (past the
        hyponychium the fingertip already falls away under the plate).
        Skin = smax(skin, -groove). With lips: also the folds' rise (mm, to
        subtract from the skin's distance) just outside the outline."""
        x, y, z = self.local(P)
        hw = self.hw(y)
        side = np.abs(x) - hw
        prox = self.cuticle_y(x) - y
        o = smax(side, prox, 1.1)
        zb = self.z_top(x, y) - T
        g = np.maximum(o, zb - z)
        far = np.linalg.norm(P - self.o, axis=1) > 40
        g = np.where(far, 50.0, g)
        if not lips:
            return g
        # folds: a soft ridge outside the outline, on the dorsal side only,
        # proximal and lateral, fading out round the hyponychium
        dorsal = smoothstep(-3.0, -1.0, z - self.z_top(x, y))
        ring = np.exp(-((o - 0.55 * LIP_W) / (0.55 * LIP_W)) ** 2) * (o > -0.2)
        sidew = smoothstep(0.2, -1.2, prox)            # 1 along the sides, 0 at the cuticle
        h = (LIP_PROX * (1 - sidew) + LIP_SIDE * sidew) * ring * dorsal
        h *= smoothstep(self.yh + 2.5, self.yh - 1.5, y)
        h = np.where(far, 0.0, h)
        return g, h

    # ---- the plate (mesh) -------------------------------------------------------------
    def pulp_end(self):
        """How far past the hyponychium the fingertip reaches (its spine's end)."""
        return float((self.tube.p[-1] - self.o) @ self.F) - self.yh

    def plate(self, free=None, cols=17, rows=26):
        if free is None:
            free = min(FREE, self.pulp_end() - 0.5)
        """A closed plate: top grid, underside grid, rim. Returns V (hand
        frame mm), F (quads), and the visible plate's UV for the top."""
        hw_t = lambda y: self.hw(y) + TUCK_SIDE * (1 - smoothstep(self.yh - 2.5, self.yh, y))
        us = np.linspace(-1, 1, cols)
        vs = np.linspace(0, 1, rows)
        top = np.zeros((rows, cols, 3))
        for j, v in enumerate(vs):
            for i, u in enumerate(us):
                # y from below the cuticle (tucked) to the free edge, per column
                xg = u * self.hw0
                y0 = self.cuticle_y(xg) - TUCK_PROX
                y1 = self.free_y(xg, free)
                y = y0 + (y1 - y0) * v
                x = u * hw_t(y)
                top[j, i] = (x, y, self.z_top(x, y))
        bot = top.copy()
        bot[..., 2] -= T
        # thin the free edge's rim a little toward the tip
        V = np.concatenate([top.reshape(-1, 3), bot.reshape(-1, 3)])
        n = rows * cols
        idx = np.arange(n).reshape(rows, cols)
        F = []
        for j in range(rows - 1):
            for i in range(cols - 1):
                a, b, c, d = idx[j, i], idx[j, i + 1], idx[j + 1, i + 1], idx[j + 1, i]
                F.append((a, d, c, b))                    # top (outward +z)
                F.append((a + n, b + n, c + n, d + n))    # underside
        ring = [idx[0, i] for i in range(cols)] + [idx[j, -1] for j in range(1, rows)] + \
               [idx[-1, i] for i in range(cols - 2, -1, -1)] + [idx[j, 0] for j in range(rows - 2, 0, -1)]
        for k in range(len(ring)):
            a, b = ring[k], ring[(k + 1) % len(ring)]
            F.append((a, b, b + n, a + n))
        Vh = self.o + V[:, 0:1] * self.U + V[:, 1:2] * self.F + V[:, 2:3] * self.W
        return Vh, np.array(F), V
