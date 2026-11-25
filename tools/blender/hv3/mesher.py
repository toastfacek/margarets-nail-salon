"""Polygonise a signed distance function: sparse two-level grid, naive
surface nets (one vertex per sign-change cell, one quad per sign-change
edge), then Newton projection of every vertex onto the zero level set.
Pure numpy; our own code."""
import time

import numpy as np


_FN = None


def _work(P):
    return _FN(P)


def _eval(fn, P, chunk=60000, procs=4):
    """Evaluate fn over P in chunks, on 4 forked worker processes."""
    global _FN
    if len(P) < 2 * chunk or procs <= 1:
        out = np.empty(len(P))
        for i in range(0, len(P), chunk):
            out[i:i + chunk] = fn(P[i:i + chunk])
        return out
    import multiprocessing as mp
    _FN = fn
    parts = [P[i:i + chunk] for i in range(0, len(P), chunk)]
    with mp.get_context('fork').Pool(procs) as pool:
        res = pool.map(_work, parts)
    return np.concatenate(res)


def surface_nets(fn, lo, hi, h0=2.0, r=4, project_iters=3, log=print):
    t0 = time.time()
    lo = np.asarray(lo, dtype=np.float64)
    hi = np.asarray(hi, dtype=np.float64)
    nc = np.ceil((hi - lo) / h0).astype(int)
    g = [lo[a] + h0 * np.arange(nc[a] + 1) for a in range(3)]
    X, Y, Z = np.meshgrid(*g, indexing='ij')
    Pc = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)
    f0 = _eval(fn, Pc).reshape(nc + 1)
    log('coarse %s pts in %.1fs' % (Pc.shape[0], time.time() - t0))
    # active coarse cells: the corners' range straddles a band round zero
    c = [f0[i:i + nc[0], j:j + nc[1], k:k + nc[2]] for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    cmin = np.minimum.reduce(c)
    cmax = np.maximum.reduce(c)
    band = 1.3 * h0
    act = (cmin < band) & (cmax > -band)
    # dilate by one cell
    a2 = act.copy()
    a2[1:] |= act[:-1]
    a2[:-1] |= act[1:]
    a2[:, 1:] |= act[:, :-1]
    a2[:, :-1] |= act[:, 1:]
    a2[:, :, 1:] |= act[:, :, :-1]
    a2[:, :, :-1] |= act[:, :, 1:]
    act = a2
    ci = np.argwhere(act)
    log('active coarse cells %d' % len(ci))
    h = h0 / r
    nf = nc * r + 1
    # fine points of the active cells
    off = np.stack(np.meshgrid(*(np.arange(r + 1),) * 3, indexing='ij'), axis=-1).reshape(-1, 3)
    fp = (ci[:, None, :] * r + off[None, :, :]).reshape(-1, 3)
    key = (fp[:, 0].astype(np.int64) * nf[1] + fp[:, 1]) * nf[2] + fp[:, 2]
    key = np.unique(key)
    ii = key // (nf[1] * nf[2])
    jj = (key // nf[2]) % nf[1]
    kk = key % nf[2]
    Pf = lo + h * np.stack([ii, jj, kk], axis=1)
    t1 = time.time()
    ff = _eval(fn, Pf)
    log('fine %d pts in %.1fs (h=%.3f)' % (len(Pf), time.time() - t1, h))

    def look(i, j, k):
        kq = (i.astype(np.int64) * nf[1] + j) * nf[2] + k
        pos = np.searchsorted(key, kq)
        pos = np.clip(pos, 0, len(key) - 1)
        ok = key[pos] == kq
        v = np.where(ok, ff[pos], np.nan)
        return v

    # fine cells inside active coarse cells
    offc = np.stack(np.meshgrid(*(np.arange(r),) * 3, indexing='ij'), axis=-1).reshape(-1, 3)
    cells = (ci[:, None, :] * r + offc[None, :, :]).reshape(-1, 3)
    corners = [(a, b, c_) for a in (0, 1) for b in (0, 1) for c_ in (0, 1)]
    cv = np.stack([look(cells[:, 0] + a, cells[:, 1] + b, cells[:, 2] + c_) for a, b, c_ in corners], axis=1)
    valid = ~np.isnan(cv).any(axis=1)
    sgn = cv < 0
    mixed = valid & sgn.any(axis=1) & ~sgn.all(axis=1)
    cells = cells[mixed]
    cv = cv[mixed]
    # vertex: mean of the edge crossings
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    cor = np.array(corners, dtype=np.float64)
    acc = np.zeros((len(cells), 3))
    cnt = np.zeros(len(cells))
    for a, b in edges:
        va, vb = cv[:, a], cv[:, b]
        m = (va < 0) != (vb < 0)
        t = np.where(m, va / np.where(m, va - vb, 1.0), 0.0)
        p = cor[a][None, :] + t[:, None] * (cor[b] - cor[a])[None, :]
        acc += np.where(m[:, None], p, 0.0)
        cnt += m
    V = lo + h * (cells + acc / cnt[:, None])
    ckey = (cells[:, 0].astype(np.int64) * nf[1] + cells[:, 1]) * nf[2] + cells[:, 2]
    order = np.argsort(ckey)
    ckey = ckey[order]
    V = V[order]
    cells = cells[order]
    cv = cv[order]

    def cell_index(i, j, k):
        inr = (i >= 0) & (j >= 0) & (k >= 0) & (i < nf[0] - 1) & (j < nf[1] - 1) & (k < nf[2] - 1)
        kq = (i.astype(np.int64) * nf[1] + j) * nf[2] + k
        pos = np.clip(np.searchsorted(ckey, kq), 0, len(ckey) - 1)
        return np.where((ckey[pos] == kq) & inr, pos, -1)

    # quads: each sign-change edge from a cell's min corner, along x, y, z
    quads = []
    c0 = cv[:, 0]
    for ax, cb in ((0, 4), (1, 2), (2, 1)):
        # corner index of +ax neighbour: corners are (a,b,c) -> a*4+b*2+c
        v1 = cv[:, cb]
        m = (c0 < 0) != (v1 < 0)
        base = cells[m]
        inside_first = c0[m] < 0
        o1, o2 = [a for a in range(3) if a != ax]
        ring = []
        for d1, d2 in ((0, 0), (-1, 0), (-1, -1), (0, -1)):
            q = base.copy()
            q[:, o1] += d1
            q[:, o2] += d2
            ring.append(cell_index(q[:, 0], q[:, 1], q[:, 2]))
        ring = np.stack(ring, axis=1)
        ok = (ring >= 0).all(axis=1)
        ring, inside_first = ring[ok], inside_first[ok]
        # orientation: outward normal
        flip = inside_first if ax != 1 else ~inside_first
        ring = np.where(flip[:, None], ring[:, ::-1], ring)
        quads.append(ring)
    Q = np.vstack(quads)
    # keep used vertices only
    used = np.unique(Q)
    remap = -np.ones(len(V), dtype=np.int64)
    remap[used] = np.arange(len(used))
    V = V[used]
    Q = remap[Q]
    log('surface nets: %d verts, %d quads' % (len(V), len(Q)))
    V = project(fn, V, h, project_iters)
    log('total %.1fs' % (time.time() - t0))
    return V, Q


def gradient(fn, V, eps):
    e = np.eye(3) * eps
    g = np.stack([(_eval(fn, V + e[a]) - _eval(fn, V - e[a])) / (2 * eps) for a in range(3)], axis=1)
    return g


def project(fn, V, h, iters=3):
    for _ in range(iters):
        f = _eval(fn, V)
        g = gradient(fn, V, h * 0.25)
        gg = np.maximum(np.sum(g * g, axis=1), 1e-6)
        step = (f / gg)[:, None] * g
        # never move a vertex more than one cell
        n = np.linalg.norm(step, axis=1, keepdims=True)
        step = step * np.minimum(1.0, h / np.maximum(n, 1e-12))
        V = V - step
    return V


def write_obj(path, V, Q):
    with open(path, 'w') as fh:
        np.savetxt(fh, V, fmt='v %.4f %.4f %.4f')
        np.savetxt(fh, Q + 1, fmt='f %d %d %d %d')


def save_npz(path, V, Q):
    np.savez_compressed(path, V=V.astype(np.float32), Q=Q.astype(np.int32))
