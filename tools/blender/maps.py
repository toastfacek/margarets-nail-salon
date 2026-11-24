"""The skin's detail map (hand-v2-plan.md 6.2): a tangent-space normal map and a
cavity term, painted in numpy from analytic shapes. Nothing is sampled from
any image: every crease is a function of the built mesh's own geometry.

1. Rasterise the skin into its UV square (MAP_SIZE): per texel the rest
   position, the smooth normal, the palm mask and the UV tangent frame.
2. A height field in millimetres (negative = a groove), all amplitudes x
   DETAIL_AGE (a young hand):
   - back of each finger: three arcs over the middle joint (the middle one the
     deepest, bowed toward the knuckle, a little wavy), two fine lines over the
     last joint, a soft dimple and two faint arcs over the knuckle;
   - palm side: one groove at the last joint, two at the middle joint, two at
     the finger's base; the thumb's alike;
   - the palm: the thenar crease and the two transverse creases (soft curves,
     faint), one faint wrist crease;
   - everywhere: a very low, broad unevenness (this module's own value noise).
3. The normal from the height's slope along the texel's tangent frame (the
   same frame the shader builds from screen derivatives); B = cavity.
4. Islands dilated by MAP_GUTTER_PX; saved as PNG (lossless) and WebP.
"""
import math
import os

import bpy
import numpy as np

import params as P
from base import FINGERS


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def _hash3(i, j, k):
    h = (i * 73856093) ^ (j * 19349663) ^ (k * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFF) / 65535.0


def _value_noise(p):
    """Smooth 3D value noise in [0, 1] (this project's own hash and fade)."""
    f = np.floor(p).astype(np.int64)
    t = p - f
    t = t * t * (3 - 2 * t)
    out = np.zeros(len(p))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) * (t[:, 2] if dz else 1 - t[:, 2])
                out += w * _hash3(f[:, 0] + dx, f[:, 1] + dy, f[:, 2] + dz)
    return out


def _groove(x, depth, sigma):
    return -depth * np.exp(-0.5 * (x / sigma) ** 2)


class Field:
    """The height field (mm) as a function of rest positions (game units)."""

    def __init__(self, scene):
        rig = scene['rig']
        self.mm = scene['cage'].scale
        J = {}
        for b in rig.data.bones:
            J[b.name] = (np.array(rig.matrix_world @ b.head_local), np.array(rig.matrix_world @ b.tail_local))
        self.J = J
        self.rf = {}
        self.nail_n = {f: _unit(np.asarray(scene['nail_normal'][f], dtype=float)) for f in FINGERS}
        self.up = np.array([0.0, 0.0, 1.0])
        # the palm frame: origin at the wrist joint, X toward the middle knuckle, Y toward the index side
        o = J['palm'][0]
        x = _unit(J['middle.01'][0] - o)
        x = _unit(x - self.up * (x @ self.up))
        y = np.cross(self.up, x)
        if (J['index.01'][0] - o) @ y < 0:
            y = -y
        self.palm = (o, x, y, np.linalg.norm(J['middle.01'][0] - o) / self.mm)

    def finger_coords(self, Pw, f):
        """Distance (mm) to the finger's bone chain, and the chain's parameter."""
        best = np.full(len(Pw), np.inf)
        for k in (1, 2, 3):
            h, t = self.J['%s.0%d' % (f, k)]
            d = t - h
            u = np.clip(((Pw - h) @ d) / (d @ d), 0, 1)
            dist = np.linalg.norm(Pw - (h + u[:, None] * d), axis=1) / self.mm
            best = np.minimum(best, dist)
        return best

    def joint_frame(self, Pw, f, k):
        """Coordinates round the joint at the head of bone f.0k: a along the
        finger (mm, + toward the tip), back-ness b (+1 the nail side), lateral
        x (mm), radius (mm)."""
        h = self.J['%s.0%d' % (f, k)][0]
        d1 = _unit(self.J['%s.0%d' % (f, k)][1] - h)
        if k > 1:
            p = self.J['%s.0%d' % (f, k - 1)]
            d1 = _unit(d1 + _unit(p[1] - p[0]))
        n = self.nail_n[f]
        n = _unit(n - d1 * (n @ d1))
        s = np.cross(d1, n)
        q = Pw - h
        a = (q @ d1) / self.mm
        r = q - np.outer(q @ d1, d1)
        rho = np.linalg.norm(r, axis=1) / self.mm
        b = (r @ n) / np.maximum(np.linalg.norm(r, axis=1), 1e-12)
        x = (r @ s) / self.mm
        return a, b, x, rho, n

    def height(self, Pw, N):
        A = P.DETAIL_AGE
        h = np.zeros(len(Pw))
        dist = np.stack([self.finger_coords(Pw, f) for f in FINGERS], 1)
        owner = np.argmin(dist, 1)
        for fi, f in enumerate(FINGERS):
            mine = (owner == fi) & (dist[:, fi] < 14.0)
            if not mine.any():
                continue
            idx = np.nonzero(mine)[0]
            pw = Pw[idx]
            Nn = N[idx]
            hh = np.zeros(len(idx))
            # (joint, kind): the thumb's middle joint is its MCP (thumb.02 head)
            joints = ((2, 'mid'), (3, 'last'), (1, 'base'))
            for k, kind in joints:
                a, b, x, rho, nj = self.joint_frame(pw, f, k)
                # back / palm side by the surface normal against the joint's back
                # direction (the rig's joints sit near the back of the finger, so
                # the direction from the axis is no guide); lateral extent by the
                # finger's own half-width at the joint, not the distance to the axis
                nb = Nn @ nj
                back = np.clip((nb - 0.15) / 0.5, 0, 1) ** 1.5
                palm = np.clip((-nb - 0.15) / 0.5, 0, 1) ** 1.5
                # the wrinkles on the back reach round to the sides of the joint
                wide = np.clip((nb + 0.1) / 0.5, 0, 1) ** 1.5
                # (cached from the first, full call: the slope's offset calls must see the same)
                if (f, k) not in self.rf:
                    ring = np.abs(a) < 2.0
                    self.rf[(f, k)] = float(np.percentile(np.abs(x[ring]), 95)) if ring.sum() > 8 else 8.0
                Rf = self.rf[(f, k)]
                side = np.clip(1.0 - (np.abs(x) / Rf) ** 4, 0, 1)
                near = np.clip(1.0 - np.abs(a) / 9.0, 0, 1)
                if kind == 'mid':
                    # the back of the middle joint: a patch of five transverse
                    # wrinkles about 1.4 mm apart, deepest in the middle, the outer
                    # ones shorter (an elliptical patch); texel density ~4 px/mm
                    for c, dep, half in ((-2.8, 0.09, 0.8), (-1.4, 0.16, 1.05), (0.0, 0.20, 1.2),
                                         (1.4, 0.16, 1.05), (2.8, 0.09, 0.8)):
                        bow = 0.03 * x * x + 0.18 * np.sin(x * 0.9 + 2.0 * c)
                        ln = np.clip(1.0 - (np.abs(x) / (half * Rf)) ** 2, 0, 1)
                        hh += wide * ln * near * _groove(a - c - bow, dep * A * 1.6, 0.34)
                    for c, dep in ((-0.8, 0.10), (0.8, 0.10)):
                        hh += palm * side * near * _groove(a - c + 0.02 * x * x, dep * A * 1.4, 0.42)
                elif kind == 'last':
                    for c, dep, half in ((-1.1, 0.08, 0.9), (0.0, 0.12, 1.1), (1.1, 0.07, 0.85)):
                        bow = 0.03 * x * x + 0.12 * np.sin(x * 1.2 + 2.0 * c)
                        ln = np.clip(1.0 - (np.abs(x) / (half * Rf)) ** 2, 0, 1)
                        hh += wide * ln * near * _groove(a - c - bow, dep * A * 1.6, 0.3)
                    hh += palm * side * near * _groove(a - 0.3 + 0.025 * x * x, 0.11 * A * 1.4, 0.45)
                else:
                    # the knuckle: a soft dimple and two faint arcs on the back;
                    # the finger's base folds on the palm side, out past the web
                    off = 0.0 if f == 'thumb' else 0.38 * np.linalg.norm(self.J[f + '.01'][1] - self.J[f + '.01'][0]) / self.mm
                    hh += back * near * (-0.06 * A * np.exp(-0.5 * ((a / 2.5) ** 2 + (x / 3.0) ** 2)))
                    for c in (-1.5, 1.5):
                        hh += back * side * near * _groove(a - c - 0.03 * x * x, 0.05 * A * 1.6, 0.32)
                    near2 = np.clip(1.0 - np.abs(a - off) / 6.0, 0, 1)
                    for c in (-0.9, 0.9):
                        hh += palm * side * near2 * _groove(a - off - c, 0.09 * A * 1.4, 0.45)
            h[idx] += hh
        # the palm's creases, in the palm frame (mm); on the palm side only
        o, X, Y, L = self.palm
        q = Pw - o
        px, py = (q @ X) / self.mm, (q @ Y) / self.mm
        down = np.clip((-(N @ self.up) - 0.2) / 0.5, 0, 1)
        on_palm = down * (np.min(dist[:, 1:], 1) > 9.0) * (dist[:, 0] > 9.0)
        # quadratic curves through three points each (x along the palm, y toward the index side)
        curves = (
            ((0.04 * L, 0.05 * L), (0.45 * L, 0.32 * L), (0.78 * L, 0.38 * L), 0.12),     # thenar crease
            ((0.70 * L, -0.48 * L), (0.80 * L, -0.05 * L), (0.86 * L, 0.20 * L), 0.10),    # distal transverse
            ((0.80 * L, 0.42 * L), (0.66 * L, 0.10 * L), (0.62 * L, -0.25 * L), 0.09),     # proximal transverse
        )
        for p0, p1, p2, dep in curves:
            t = np.linspace(0, 1, 40)[:, None]
            pts = (1 - t) ** 2 * np.array(p0) + 2 * (1 - t) * t * np.array(p1) + t * t * np.array(p2)
            dmin = np.full(len(px), np.inf)
            for k in range(len(pts) - 1):
                a_, b_ = pts[k], pts[k + 1]
                ab = b_ - a_
                u = np.clip(((px - a_[0]) * ab[0] + (py - a_[1]) * ab[1]) / (ab @ ab), 0, 1)
                dd = np.hypot(px - (a_[0] + u * ab[0]), py - (a_[1] + u * ab[1]))
                dmin = np.minimum(dmin, dd)
            h += on_palm * _groove(dmin, dep * A * 1.3, 0.8)
        # the wrist crease (palm side, about the wrist joint)
        h += down * np.clip(1.0 - np.abs(py) / (0.45 * L), 0, 1) * _groove(px + 1.5, 0.06 * A * 1.4, 0.6)
        # broad unevenness
        h += (_value_noise(Pw / self.mm / 6.0) - 0.5) * 0.04 * A
        return h


def _rasterise(me, U, co, nrm, mask, size):
    """Per texel: triangle data (position, normal, palm mask, uv tangent frame)."""
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', lv)
    tri = []
    for p in me.polygons:
        li = list(p.loop_indices)
        for k in range(1, len(li) - 1):
            tri.append((li[0], li[k], li[k + 1]))
    tri = np.array(tri)
    S = U * size - 0.5
    pix, bary, tid = [], [], []
    for ti, t in enumerate(tri):
        Pt = S[t]
        x0, y0 = np.floor(Pt.min(0)).astype(int)
        x1, y1 = np.ceil(Pt.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        q = np.stack([xs.ravel(), ys.ravel()], 1).astype(float)
        a, b, c = Pt
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (q[:, 0] - c[0]) + (c[0] - b[0]) * (q[:, 1] - c[1])) / d
        l2 = ((c[1] - a[1]) * (q[:, 0] - c[0]) + (a[0] - c[0]) * (q[:, 1] - c[1])) / d
        l3 = 1 - l1 - l2
        m = (l1 >= -1e-4) & (l2 >= -1e-4) & (l3 >= -1e-4)
        if not m.any():
            continue
        pix.append(q[m].astype(int))
        bary.append(np.stack([l1[m], l2[m], l3[m]], 1))
        tid.append(np.full(int(m.sum()), ti))
    pix = np.vstack(pix)
    bary = np.vstack(bary)
    tid = np.concatenate(tid)
    vi = lv[tri[tid]]                                   # (n, 3) vertex ids
    Pw = np.einsum('nk,nkj->nj', bary, co[vi])
    N = _unit(np.einsum('nk,nkj->nj', bary, nrm[vi]))
    palm = np.einsum('nk,nk->n', bary, mask[vi])
    # the triangle's uv tangent frame: dP/du, dP/dv
    T3 = tri[tid]
    P0, P1, P2 = co[lv[T3[:, 0]]], co[lv[T3[:, 1]]], co[lv[T3[:, 2]]]
    u0, u1, u2 = U[T3[:, 0]], U[T3[:, 1]], U[T3[:, 2]]
    e1, e2 = P1 - P0, P2 - P0
    du1, du2 = u1 - u0, u2 - u0
    det = du1[:, 0] * du2[:, 1] - du2[:, 0] * du1[:, 1]
    det = np.where(np.abs(det) < 1e-14, 1e-14, det)
    dPdu = (e1 * du2[:, 1:2] - e2 * du1[:, 1:2]) / det[:, None]
    dPdv = (e2 * du1[:, 0:1] - e1 * du2[:, 0:1]) / det[:, None]
    return pix, Pw, N, palm, dPdu, dPdv


def _dilate(img, valid, passes):
    img = img.copy()
    valid = valid.copy()
    for _ in range(passes):
        acc = np.zeros_like(img)
        cnt = np.zeros(valid.shape)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
            sv = np.roll(np.roll(valid, dy, 0), dx, 1)
            si = np.roll(np.roll(img, dy, 0), dx, 1)
            acc += si * sv[..., None]
            cnt += sv
        grow = (~valid) & (cnt > 0)
        img[grow] = acc[grow] / cnt[grow][:, None]
        valid = valid | grow
    return img, valid


def build(scene, report, check, out_dir):
    hand = scene['hand']
    me = hand.data
    size = P.MAP_SIZE
    mw = np.array(hand.matrix_world)
    co = np.array([tuple(v.co) for v in me.vertices]) @ mw[:3, :3].T + mw[:3, 3]
    me.calc_normals() if hasattr(me, 'calc_normals') else None
    nrm = np.array([tuple(v.normal) for v in me.vertices]) @ mw[:3, :3].T
    U = np.empty(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', U)
    U = U.reshape(-1, 2)
    # the palm mask (G) per vertex
    a = me.color_attributes[P.MASK_ATTR]
    col = np.empty(len(a.data) * 4, dtype=np.float32)
    a.data.foreach_get('color', col)
    col = col.reshape(-1, 4)
    if a.domain == 'CORNER':
        lv = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get('vertex_index', lv)
        m = np.zeros(len(me.vertices))
        m[lv] = col[:, 1]
    else:
        m = col[:, 1].astype(float)
    pix, Pw, N, palm, dPdu, dPdv = _rasterise(me, U, co, nrm, m, size)
    field = Field(scene)
    # the texel's tangent frame (as the shader: dP/du and dP/dv with the normal projected out)
    Tn = _unit(dPdu - N * np.sum(dPdu * N, 1, keepdims=True))
    Bn = _unit(dPdv - N * np.sum(dPdv * N, 1, keepdims=True))
    eps = P.MAP_SLOPE_EPS_MM * field.mm
    h0 = field.height(Pw, N)
    gT = (field.height(Pw + Tn * eps, N) - field.height(Pw - Tn * eps, N)) / (2 * P.MAP_SLOPE_EPS_MM)
    gB = (field.height(Pw + Bn * eps, N) - field.height(Pw - Bn * eps, N)) / (2 * P.MAP_SLOPE_EPS_MM)
    # the tangential gradient g = gT* T + gB* B in the (non-orthogonal) T, B basis:
    # the perturbed normal is N - g; solve for its T, B components
    tt = np.ones(len(Tn))
    tb = np.sum(Tn * Bn, 1)
    det = tt * tt - tb * tb
    det = np.where(np.abs(det) < 1e-6, 1e-6, det)
    # dual basis: components c with c_T T + c_B B = grad, given grad.T = gT, grad.B = gB
    cT = (gT - tb * gB) / det
    cB = (gB - tb * gT) / det
    nx, ny = -cT, -cB
    k = P.MAP_NORMAL_SCALE
    img = np.zeros((size, size, 4))
    img[..., 0] = 0.5
    img[..., 1] = 0.5
    img[..., 3] = 1.0
    cav = np.clip(-h0 / P.MAP_CAVITY_MM, 0, 1)
    vals = np.stack([np.clip(nx * k * 0.5 + 0.5, 0, 1), np.clip(ny * k * 0.5 + 0.5, 0, 1), cav, np.ones(len(cav))], 1)
    img[pix[:, 1], pix[:, 0]] = vals
    valid = np.zeros((size, size), dtype=bool)
    valid[pix[:, 1], pix[:, 0]] = True
    img, valid = _dilate(img, valid, P.MAP_GUTTER_PX)
    img[~valid] = (0.5, 0.5, 0.0, 1.0)
    paths = {}
    for fmt, ext in (('PNG', 'png'), ('WEBP', 'webp')):
        im = bpy.data.images.new('skin-detail-' + ext, size, size, alpha=False, float_buffer=False)
        im.colorspace_settings.name = 'Non-Color'
        im.pixels.foreach_set(img.astype(np.float32).ravel())
        path = os.path.join(out_dir, 'skin-detail.' + ext)
        im.filepath_raw = path
        im.file_format = fmt
        if fmt == 'WEBP':
            scene_settings = bpy.context.scene.render.image_settings
            scene_settings.file_format = 'WEBP'
            scene_settings.quality = P.MAP_WEBP_QUALITY
            scene_settings.color_mode = 'RGB'
            im.save_render(path)
        else:
            im.save()
        paths[ext] = path
        bpy.data.images.remove(im)
    sizes = {k: os.path.getsize(v) for k, v in paths.items()}
    used = float(valid.mean())
    hm = h0 * 1.0
    report['detail_map'] = {'size': size, 'texels': int(len(pix)), 'bytes': sizes, 'height_mm': [round(float(hm.min()), 3), round(float(hm.max()), 3)],
                            'normal_tilt_max_deg': round(float(np.degrees(np.arctan(np.hypot(nx, ny).max()))), 1)}
    check('maps: detail map (WebP) <= %d KB' % P.MAP_CAP_KB, sizes['webp'] <= P.MAP_CAP_KB * 1024, sizes['webp'], P.MAP_CAP_KB * 1024)
    check('maps: the skin covers its UV square (texels set)', len(pix) > 0.25 * size * size, round(len(pix) / size / size, 3))
    del used
    return paths
