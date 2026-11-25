"""Signed distance primitives for the hv3 hand (numpy, millimetres).

All functions take P as an (N, 3) float array and return (N,) distances
(negative inside). Shapes are blended with a polynomial smooth minimum. The
generalized cylinder ("Tube") is the workhorse: a smooth spine with a frame
per sample and a cross-section profile (half width, dorsal and volar half
heights, superellipse exponents) given as control points along the spine.
"""
import numpy as np


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def smin(a, b, k):
    """Polynomial smooth minimum (blend radius k, mm)."""
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---- ellipsoid --------------------------------------------------------------------
class Ellipsoid:
    def __init__(self, c, radii, R=None):
        self.c = np.asarray(c, dtype=np.float64)
        self.r = np.asarray(radii, dtype=np.float64)
        self.R = np.eye(3) if R is None else np.asarray(R, dtype=np.float64)  # columns: local axes

    def __call__(self, P):
        q = (P - self.c) @ self.R
        k0 = np.linalg.norm(q / self.r, axis=1)
        k1 = np.linalg.norm(q / (self.r * self.r), axis=1)
        return np.where(k1 > 1e-9, k0 * (k0 - 1.0) / np.maximum(k1, 1e-9), -self.r.min())

    def bound(self):
        return self.c, float(self.r.max())


def frame_R(fwd, up):
    """Columns (side, fwd, up): an orthonormal frame from a forward and an up hint."""
    f = unit(fwd)
    u = unit(np.asarray(up, dtype=np.float64) - f * np.dot(up, f))
    s = np.cross(f, u)
    return np.stack([s, f, u], axis=1)


# ---- capsule with a varying radius ---------------------------------------------------
class Capsule:
    def __init__(self, a, b, ra, rb=None):
        self.a = np.asarray(a, dtype=np.float64)
        self.b = np.asarray(b, dtype=np.float64)
        self.ra, self.rb = ra, ra if rb is None else rb

    def __call__(self, P):
        ab = self.b - self.a
        t = np.clip(((P - self.a) @ ab) / np.dot(ab, ab), 0, 1)
        d = np.linalg.norm(P - (self.a + t[:, None] * ab), axis=1)
        return d - (self.ra + (self.rb - self.ra) * t)


# ---- triangle slab ----------------------------------------------------------------------
class TriSlab:
    """A triangle thickened by a half thickness that varies linearly over its
    corners (barycentric of the closest point)."""

    def __init__(self, a, b, c, ta, tb, tc):
        self.v = [np.asarray(x, dtype=np.float64) for x in (a, b, c)]
        self.t = np.array([ta, tb, tc], dtype=np.float64)

    def __call__(self, P):
        a, b, c = self.v
        ab, ac = b - a, c - a
        n = np.cross(ab, ac)
        nn = np.dot(n, n)
        ap = P - a
        # barycentric of the projection onto the plane
        v = (np.cross(ap, ac) @ n) / nn
        w = (np.cross(ab, ap) @ n) / nn
        bc = np.stack([1 - v - w, v, w], axis=1)
        inside = (bc >= 0).all(axis=1)
        proj = a + v[:, None] * ab + w[:, None] * ac
        d_in = np.abs(ap @ (n / np.sqrt(nn)))
        # edges
        best = np.full(len(P), np.inf)
        bbest = np.zeros((len(P), 3))
        for i, (p0, p1) in enumerate(((a, b), (b, c), (c, a))):
            e = p1 - p0
            t = np.clip(((P - p0) @ e) / np.dot(e, e), 0, 1)
            d = np.linalg.norm(P - (p0 + t[:, None] * e), axis=1)
            m = d < best
            best = np.where(m, d, best)
            bb = np.zeros((len(P), 3))
            bb[:, i] = 1 - t
            bb[:, (i + 1) % 3] = t
            bbest = np.where(m[:, None], bb, bbest)
        dist = np.where(inside, d_in, best)
        bcu = np.where(inside[:, None], bc, bbest)
        return dist - bcu @ self.t


# ---- 2D polygon -------------------------------------------------------------------------
def poly_sdf(xy, V):
    """Signed distance to a closed polygon V (M,2); negative inside."""
    V = np.asarray(V, dtype=np.float64)
    d = np.sum((xy - V[0]) ** 2, axis=1)
    s = np.ones(len(xy))
    n = len(V)
    for i in range(n):
        j = i - 1
        e = V[j] - V[i]
        w = xy - V[i]
        t = np.clip((w @ e) / np.dot(e, e), 0, 1)
        b = w - t[:, None] * e
        d = np.minimum(d, np.sum(b * b, axis=1))
        c1 = xy[:, 1] >= V[i][1]
        c2 = xy[:, 1] < V[j][1]
        c3 = e[0] * w[:, 1] > e[1] * w[:, 0]
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
    return s * np.sqrt(d)


# ---- smooth 1D interpolation (Catmull-Rom on non-uniform knots) -----------------------------
def cr_interp(x, xs, ys):
    """Piecewise cubic Hermite through (xs, ys) with Catmull-Rom tangents;
    flat outside the range. ys may be (K,) or (K, M)."""
    xs = np.asarray(xs, dtype=np.float64)
    ys = np.asarray(ys, dtype=np.float64)
    K = len(xs)
    m = np.zeros_like(ys)
    for i in range(K):
        if 0 < i < K - 1:
            m[i] = (ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1])
    x = np.clip(x, xs[0], xs[-1])
    i = np.clip(np.searchsorted(xs, x, side='right') - 1, 0, K - 2)
    h = xs[i + 1] - xs[i]
    t = (x - xs[i]) / h
    t2, t3 = t * t, t * t * t
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    if ys.ndim == 2:
        h00, h10, h01, h11, h = (a[:, None] for a in (h00, h10, h01, h11, h))
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]


# ---- generalized cylinder ------------------------------------------------------------------
class Tube:
    """A tube round a spine.

    pts (K,3) spine samples, W (K,3) dorsal axis per sample (orthogonalised
    here), prof: dict of control arrays over arc length s: 's', 'a' half
    width, 'bd' dorsal, 'bv' volar half height, 'nd', 'nv' superellipse
    exponents (dorsal / volar half), 'ox' sideways offset of the section
    centre, 'oz' dorsal offset. Ends: 'cap0' / 'cap1' True for a flat cap,
    else the spine just stops (the profile should reach zero there)."""

    def __init__(self, pts, W, prof, cap0=True, cap1=True):
        self.p = np.asarray(pts, dtype=np.float64)
        seg = np.diff(self.p, axis=0)
        self.L = np.linalg.norm(seg, axis=1)
        self.D = seg / self.L[:, None]
        self.s = np.concatenate([[0.0], np.cumsum(self.L)])
        T = np.zeros_like(self.p)
        T[:-1] += self.D
        T[1:] += self.D
        T = unit(T)
        W = np.asarray(W, dtype=np.float64)
        W = unit(W - T * np.sum(W * T, axis=1, keepdims=True))
        self.T, self.W = T, W
        self.U = np.cross(T, W)
        self.prof = prof
        keys = ['a', 'bd', 'bv', 'nd', 'nv', 'ox', 'oz']
        for k in ('nd', 'nv', 'ox', 'oz'):
            if k not in prof:
                prof[k] = np.full(len(prof['s']), {'nd': 2.0, 'nv': 2.0}.get(k, 0.0))
        self.Y = np.stack([np.asarray(prof[k], dtype=np.float64) for k in keys], axis=1)
        self.cap0, self.cap1 = cap0, cap1
        self.bmax = float(np.max(np.abs(self.Y[:, :3])) + np.max(np.abs(self.Y[:, 5:7])))

    def project(self, P, win=14, step=6):
        """Closest spine parameter: returns (s, k, t) with s unclamped past the ends.
        A coarse pass over every step-th sample picks a window of segments;
        the exact pass runs only there."""
        K = len(self.L)
        if K <= 2 * win:
            return self.project_all(P)
        cidx = np.arange(0, K + 1, step)
        if cidx[-1] != K:
            cidx = np.append(cidx, K)
        cp = self.p[cidx]
        best = np.full(len(P), np.inf)
        bc = np.zeros(len(P), dtype=np.int64)
        for i in range(len(cp) - 1):
            ab = cp[i + 1] - cp[i]
            t = np.clip(((P - cp[i]) @ ab) / np.dot(ab, ab), 0, 1)
            d = np.sum((P - (cp[i] + t[:, None] * ab)) ** 2, axis=1)
            m = d < best
            best = np.where(m, d, best)
            bc = np.where(m, i, bc)
        k0 = np.clip(cidx[bc] - (win - step) // 2, 0, K - win)
        ks = k0[:, None] + np.arange(win)[None, :]
        p0 = self.p[ks]
        D = self.D[ks]
        L = self.L[ks]
        v = P[:, None, :] - p0
        t = np.einsum('nkj,nkj->nk', v, D) / L
        lo = np.where(ks == 0, -np.inf, 0.0)
        hi = np.where(ks == K - 1, np.inf, 1.0)
        t = np.clip(t, lo, hi)
        q = v - (t * L)[..., None] * D
        d = np.einsum('nkj,nkj->nk', q, q)
        j = np.argmin(d, axis=1)
        r = np.arange(len(P))
        bk = ks[r, j]
        bt = t[r, j]
        s = self.s[bk] + bt * self.L[bk]
        return s, bk, bt

    def project_all(self, P):
        n = len(P)
        best = np.full(n, np.inf)
        bk = np.zeros(n, dtype=np.int64)
        bt = np.zeros(n)
        K = len(self.L)
        for k in range(K):
            v = P - self.p[k]
            t = v @ self.D[k] / self.L[k]
            lo = -np.inf if k == 0 else 0.0
            hi = np.inf if k == K - 1 else 1.0
            t = np.clip(t, lo, hi)
            q = v - (t * self.L[k])[:, None] * self.D[k]
            d = np.einsum('ij,ij->i', q, q)
            m = d < best
            best = np.where(m, d, best)
            bk = np.where(m, k, bk)
            bt = np.where(m, t, bt)
        s = self.s[bk] + bt * self.L[bk]
        return s, bk, bt

    def __call__(self, P, local=False):
        s, k, t = self.project(P)
        tc = np.clip(t, 0, 1)[:, None]
        c = self.p[k] + tc * (self.p[k + 1] - self.p[k])
        W = unit(self.W[k] * (1 - tc) + self.W[k + 1] * tc)
        Tn = unit(self.T[k] * (1 - tc) + self.T[k + 1] * tc)
        W = unit(W - Tn * np.sum(W * Tn, axis=1, keepdims=True))
        U = np.cross(Tn, W)
        S = self.s[-1]
        sc = np.clip(s, 0, S)
        pr = cr_interp(sc, self.prof['s'], self.Y)
        a, bd, bv, nd, nv, ox, oz = (pr[:, i] for i in range(7))
        q = P - c
        x = np.einsum('ij,ij->i', q, U) - ox
        z = np.einsum('ij,ij->i', q, W) - oz
        ax = np.einsum('ij,ij->i', q, Tn)
        up = z > 0
        b = np.where(up, bd, bv)
        n = np.where(up, nd, nv)
        a = np.maximum(a, 1e-3)
        b = np.maximum(b, 1e-3)
        r = np.sqrt(x * x + z * z)
        xa, zb = np.abs(x) / a, np.abs(z) / b
        m = np.maximum(np.maximum(xa, zb), 1e-12)
        qq = m * ((xa / m) ** n + (zb / m) ** n) ** (1.0 / n)
        R = np.where(qq > 1e-9, r / np.maximum(qq, 1e-9), np.minimum(a, b))
        d2 = r - R
        # axial excess past a capped end
        e = np.where(s < 0, -s, np.where(s > S, s - S, 0.0))
        out = np.where(e > 0, np.where(d2 > 0, np.sqrt(d2 * d2 + e * e), e), d2)
        if local:
            return out, dict(s=s, x=x, z=z, a=a, b=b)
        return out

    def coarse_lower_bound(self, P, step=6):
        idx = list(range(0, len(self.p), step))
        if idx[-1] != len(self.p) - 1:
            idx.append(len(self.p) - 1)
        pts = self.p[idx]
        best = np.full(len(P), np.inf)
        for i in range(len(pts) - 1):
            ab = pts[i + 1] - pts[i]
            t = np.clip(((P - pts[i]) @ ab) / np.dot(ab, ab), 0, 1)
            best = np.minimum(best, np.linalg.norm(P - (pts[i] + t[:, None] * ab), axis=1))
        # chord error of the coarse polyline is tiny next to bmax
        return best - self.bmax - 2.0


def densify(ctrl, per_mm=1.0, smooth=3):
    """A dense, lightly smoothed polyline through control points; returns the
    points and, for each control point, its arc length on the result."""
    ctrl = np.asarray(ctrl, dtype=np.float64)
    pts = [ctrl[0]]
    for i in range(len(ctrl) - 1):
        L = np.linalg.norm(ctrl[i + 1] - ctrl[i])
        n = max(2, int(np.ceil(L * per_mm)))
        for j in range(1, n + 1):
            pts.append(ctrl[i] + (ctrl[i + 1] - ctrl[i]) * j / n)
    pts = np.array(pts)
    for _ in range(smooth):
        q = pts.copy()
        q[1:-1] = 0.25 * pts[:-2] + 0.5 * pts[1:-1] + 0.25 * pts[2:]
        pts = q
    s = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    cs = []
    for c in ctrl:
        i = int(np.argmin(np.linalg.norm(pts - c, axis=1)))
        cs.append(s[i])
    return pts, s, np.array(cs)
