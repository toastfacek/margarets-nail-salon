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
    'thumb':  dict(yc=6.8, yh=19.9, wfrac=0.80, arc=92.0),
    'index':  dict(yc=6.0, yh=16.2, wfrac=0.80, arc=92.0),
    'middle': dict(yc=6.2, yh=17.2, wfrac=0.80, arc=92.0),
    'ring':   dict(yc=6.1, yh=17.0, wfrac=0.79, arc=90.0),
    'pinky':  dict(yc=5.5, yh=14.6, wfrac=0.78, arc=86.0),
}
T = 0.5            # plate thickness
SINK = 0.22        # (v1 of the plate: a fixed C-curve below the skin; unused since fix 2)
SINK_CUT = 0.20    # the plate's top under the skin's own surface at the cuticle (mm) ...
SINK_MID = 0.05    # ... at the middle of the bed ...
SINK_TIP = -0.03   # ... and at the hyponychium (a touch proud): the nail sits nearly flush
C_EXTRA = 0.12     # a little more C-curve than the finger's own (mm drop at the plate's edge)
ACROSS_FREEZE = 2.5  # the across-profile is the skin's up to this far before the hyponychium
TAPER = 0.05       # the sides converge this much (fraction of the half width) toward the tip
CUT_ARC = 0.50     # cuticle sagitta, x half width
CUT_N = 2.6        # the cuticle's superellipse exponent
TUCK_PROX = 0.0    # the plate runs this far under the proximal fold (hidden)
TUCK_SIDE = 0.08  # ... and under the side folds
FREE = 2.6         # free edge past the hyponychium (mm), the render default
FREE_SLOPE = 0.15  # past the hyponychium the plate keeps this much of the bed's downward slope
TIP_ROUND = 0.95   # free edge outline: 0 square .. 1 full half-ellipse
GROOVE_K = 0.42    # blend radius of the groove walls
ARCH = 0.010       # longitudinal convexity of the plate: mm drop per mm^2 from the bed's middle
LIP_PROX = 0.12    # the proximal fold's lip above the original skin (mm)
LIP_SIDE = 0.06    # the lateral folds' rise
LIP_W = 0.90       # their width (mm, outside the outline)
FREE_INSET = 0.45  # mm: the free edge's sides step in by the folds' overlap
FREE_NARROW = 0.20 # past the hyponychium the plate narrows by this fraction over 3 mm
SKIN_CAP = 0.90    # plate half width <= this x the finger's half width (toward the tip)


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
        # the skin's own dorsal surface over the whole plate (x across, y along):
        # the plate follows it, nearly flush, instead of a fixed arc sunk in a pit
        self.gx = np.linspace(-1.35, 1.35, 19) * self.hw0
        self.gy = np.linspace(self.yc - 4.0, self.yh, 26)
        X, Y = np.meshgrid(self.gx, self.gy)
        self.gz = self._surf_grid(X.ravel(), Y.ravel()).reshape(X.shape)
        # the finger's half width toward the tip: the plate never runs wider
        # than the skin under it (else its free-edge corners poke out as ears)
        self.ys_w = np.linspace(ymid, self.yh + 6.0, 16)
        self.side_w = np.array([self._side(y) for y in self.ys_w])

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

    def _surf_grid(self, x, y):
        lo = np.full(len(x), -6.0)
        hi = np.full(len(x), 14.0)
        for _ in range(36):
            m = 0.5 * (lo + hi)
            d = self.tube(self._pt(x[:, None], y[:, None], m[:, None]).reshape(-1, 3) if False else
                          self.o + self.F * y[:, None] + self.U * x[:, None] + self.W * m[:, None])
            inside = d < 0
            lo = np.where(inside, m, lo)
            hi = np.where(inside, hi, m)
        return 0.5 * (lo + hi)

    def skin_z(self, x, y):
        """The skin's dorsal height (bilinear in the grid; clamped to it)."""
        x = np.clip(np.asarray(x, dtype=np.float64), self.gx[0], self.gx[-1])
        y = np.clip(np.asarray(y, dtype=np.float64), self.gy[0], self.gy[-1])
        fx = (x - self.gx[0]) / (self.gx[1] - self.gx[0])
        fy = (y - self.gy[0]) / (self.gy[1] - self.gy[0])
        i = np.clip(np.floor(fx).astype(int), 0, len(self.gx) - 2)
        j = np.clip(np.floor(fy).astype(int), 0, len(self.gy) - 2)
        tx, ty = fx - i, fy - j
        G = self.gz
        return (G[j, i] * (1 - tx) * (1 - ty) + G[j, i + 1] * tx * (1 - ty)
                + G[j + 1, i] * (1 - tx) * ty + G[j + 1, i + 1] * tx * ty)

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
        base = self.hw0 * (1 - TAPER * t)
        cap = SKIN_CAP * np.interp(np.minimum(y, self.yh), self.ys_w, self.side_w, left=1e9)
        hw = np.minimum(base, cap)
        # past the hyponychium the free edge narrows gently over 3 mm (its
        # corners stay inside the pulp's silhouette at the default length),
        # then runs on straight: no neck on a long nail
        past = np.clip(np.asarray(y, dtype=np.float64) - self.yh, 0.0, None)
        # (and steps in by the side folds' overlap, so its edge continues the
        # visible bed's edge instead of stepping out past the folds)
        return hw * (1.0 - FREE_NARROW * smoothstep(0.0, 3.0, past)) - FREE_INSET * smoothstep(0.0, 1.2, past)

    def z_centre(self, y):
        ym = 0.5 * (self.yc + self.yh)
        yy = np.minimum(y, self.yh)
        zb = np.interp(yy, self.ys, self.zc) - SINK - ARCH * ((yy - ym) ** 2 - (0.5 * (self.yh - self.yc)) ** 2 * 0.35)
        past = np.maximum(y - self.yh, 0)
        return zb + FREE_SLOPE * self.slope_h * past

    def sink(self, y):
        t = np.clip((np.asarray(y, dtype=np.float64) - self.yc) / (self.yh - self.yc), 0, 1)
        return np.where(t < 0.5, SINK_CUT + (SINK_MID - SINK_CUT) * smoothstep(0.0, 0.5, t),
                        SINK_MID + (SINK_TIP - SINK_MID) * smoothstep(0.5, 1.0, t))

    def z_top(self, x, y):
        """The plate's top: the skin's own surface (its across-curve frozen
        just before the hyponychium), a little under it at the cuticle, flush
        toward the tip; past the hyponychium the free edge runs on with a
        share of the bed's slope."""
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        yy = np.minimum(y, self.yh)
        yf = np.minimum(yy, self.yh - ACROSS_FREEZE)
        across = self.skin_z(x, yf) - self.skin_z(np.zeros_like(x), yf)
        zc = self.skin_z(np.zeros_like(x), yy)
        u = np.clip(np.abs(x) / self.hw0, 0, 1.4)
        past = np.maximum(y - self.yh, 0)
        return zc + across - self.sink(yy) - C_EXTRA * u * u + FREE_SLOPE * self.slope_h * past

    def cuticle_y(self, x):
        """The proximal outline: a superellipse cap (n = CUT_N), its corners
        well rounded."""
        hw = self.hw0
        u = np.clip(np.abs(x) / hw, 0, 1.0)
        return self.yc + CUT_ARC * hw * (1 - (1 - u ** CUT_N) ** (1 / CUT_N)) + 0.6 * np.clip(np.abs(x) / hw - 1, 0, None) * hw

    def free_y(self, x, free):
        """The free edge outline: y at which the plate ends, per x."""
        hw = float(self.hw(self.yh))
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
        # the groove fades out over the last 2 mm of the bed (no notch at the tip)
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
        h *= smoothstep(self.yh - 0.5, self.yh - 5.0, y)
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
