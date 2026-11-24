"""The nail unit v2 (hand-v2-plan.md section 4): the plate, built from the
finger's own nail groove.

Per finger (the bed patch = the cage's committed nail faces, carried through
subdivision as material index 1 + finger):
  frame   +Z = the patch's area-weighted normal; +Y = the finger axis (.03)
          projected into the patch plane, toward the cuticle; +X = Y x Z;
          origin = the centre of the visible plate (at the default length)
  surface the bed's own surface (a quadric fitted to the patch on the limit
          surface), C-curve scaled by NAIL_C_CURVE; past the hyponychium it
          continues tangent, the C-curve tightening, curving down a little
  outline straight, slightly converging sides; a U-shaped cuticle; the free
          edge an ellipse blended by NAIL_TIP_ROUND
  grid    NAIL_COLS visible columns + 2 side tuck columns; a cuticle tuck row;
          NAIL_BED_ROWS rows over the bed, NAIL_FREE_ROWS past it; the free
          edge has real thickness: a lip row and an underside back to the
          hyponychium. Tucked, lip and underside vertices copy their rim's UV
          (zero UV area), the visible top fills [0, 1].
  extras  nailFrame: 1, nailHalf: [half length, half width] of the visible
          plate, nailAnat: [s of the hyponychium line, cuticle arc, free-edge
          arc, 0] (s = y / half length, arcs in s per w^2)
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import params as P
from base import FINGERS


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


class Groove:
    """One finger's nail bed, measured in its frame (game units)."""

    def __init__(self, finger, O, X, Y, Z, mm):
        self.finger, self.O, self.X, self.Y, self.Z, self.mm = finger, O, X, Y, Z, mm

    def local(self, p):
        S = np.asarray(p) - self.O
        return np.stack([S @ self.X, S @ self.Y, S @ self.Z], -1)

    def fit(self, Q):
        """Quadric z(x, y) through the bed points Q (local)."""
        x, y, z = Q[:, 0], Q[:, 1], Q[:, 2]
        M = np.stack([np.ones_like(x), x, y, x * x, y * y, x * y], 1)
        self.c = np.linalg.lstsq(M, z, rcond=None)[0]

    def zbed(self, x, y):
        c = self.c
        return c[0] + c[1] * x + c[2] * y + c[3] * x * x / P.NAIL_C_CURVE + c[4] * y * y + c[5] * x * y


class Plate:
    """The plate of one finger at one free-edge length (local frame, game units)."""

    def __init__(self, g, W0, y_cut, y_h, free_len, lift):
        self.g, self.W0, self.y_cut, self.y_h, self.lift = g, W0, y_cut, y_h, lift
        self.bed = y_cut - y_h
        self.free = free_len * self.bed
        self.y_tip = y_h - self.free
        # the free edge's oval reaches back at most NAIL_CORNER past the hyponychium,
        # so the plate's outline over the bed is the same at every length (the skin
        # round it is baked once)
        self.d_tip = min(P.NAIL_TIP_ROUND * W0, self.free + P.NAIL_CORNER * g.mm)
        self.sag = P.NAIL_CUTICLE_ARC * W0

    def W(self, y):
        return self.W0 * (1.0 - P.NAIL_SIDE_TAPER * np.clip((self.y_cut - y) / (self.y_cut - self.y_tip), 0, 1))

    def y_c(self, x):
        return self.y_cut - self.sag * (x / self.W0) ** 2

    def y_e(self, x):
        Wt = self.W(self.y_tip)
        return self.y_tip + self.d_tip * (1.0 - np.sqrt(np.clip(1.0 - (x / Wt) ** 2, 0, 1)))

    def z(self, x, y):
        """Top surface."""
        g, mm = self.g, self.g.mm
        yh = self.y_h
        past = np.minimum(y - yh, 0.0)              # <= 0 past the hyponychium
        yb = np.maximum(y, yh)
        z = g.zbed(x, yb)
        eps = 1e-4
        dzdy = (g.zbed(x, yh + eps) - g.zbed(x, yh - eps)) / (2 * eps)
        z = z + P.NAIL_FREE_SLOPE * dzdy * past - P.NAIL_DROOP * (past / mm) ** 2 * mm
        z = z + g.c[3] / P.NAIL_C_CURVE * P.NAIL_C_TIGHTEN * x * x * smoothstep(0, 2.0 * mm, -past)
        return z + self.lift

    def normal(self, x, y):
        e = 1e-4
        dx = (self.z(x + e, y) - self.z(x - e, y)) / (2 * e)
        dy = (self.z(x, y + e) - self.z(x, y - e)) / (2 * e)
        return unit(np.stack([-dx, -dy, np.ones_like(dx)], -1))

    def build(self):
        """verts (local x, y, z), uv, normals, faces, grid shape."""
        NI = P.NAIL_COLS
        NB, NF = P.NAIL_BED_ROWS, P.NAIL_FREE_ROWS
        mm = self.g.mm
        T = P.NAIL_THICKNESS * mm
        s = np.linspace(-1.0, 1.0, NI)
        # visible rows: per column from the cuticle to the bed end, then to the edge
        xs = s * self.W0
        yc = self.y_c(xs)
        ye = self.y_e(xs)
        yb = np.maximum(self.y_h, ye)
        rb = np.linspace(0, 1, NB)[:, None]
        rf = np.linspace(0, 1, NF + 1)[1:, None]
        Yv = np.vstack([yc + (yb - yc) * rb, yb + (ye - yb) * rf])          # (NB + NF, NI)
        # the cuticle's corners round in a little (the U meets the sides softly)
        rc = np.clip(1.0 - (yc[None, :] - Yv) / (P.NAIL_CUTICLE_ROWS * self.bed), 0, 1) ** 1.5
        Xv = s[None, :] * self.W(Yv) * (1.0 - P.NAIL_CUTICLE_ROUND * rc ** 2)
        # the outline's x at the free-edge corners follows the ellipse
        Zv = self.z(Xv, Yv)
        self.Xv, self.Yv = Xv, Yv
        Nv = self.normal(Xv, Yv)
        nv = NB + NF
        rows_x, rows_y, rows_z, rows_n, rows_uv = [], [], [], [], []
        u = (Xv / self.W0 + 1.0) * 0.5
        v = (Yv - self.y_tip) / (self.y_cut - self.y_tip)

        def side_cols(x, y, z, n, uu, vv, bed_w):
            """Add the two tuck columns to a row of visible points."""
            out_x = np.concatenate([[x[0]], x, [x[-1]]])
            out_y = np.concatenate([[y[0]], y, [y[-1]]])
            out_z = np.concatenate([[z[0]], z, [z[-1]]])
            out_n = np.concatenate([n[:1], n, n[-1:]])
            for k, sg in ((0, -1), (-1, 1)):
                # under the side fold over the bed; straight down by the thickness past it
                out_x[k] = x[k] + sg * P.FOLD_TUCK_SIDE * mm * bed_w * 0.6
                out_z[k] = z[k] - (P.FOLD_TUCK_SIDE * mm * 1.2) * bed_w - T * (1 - bed_w)
            out_uv = np.stack([np.concatenate([[uu[0]], uu, [uu[-1]]]), np.concatenate([[vv[0]], vv, [vv[-1]]])], -1)
            return out_x, out_y, out_z, out_n, out_uv

        def add(x, y, z, n, uv):
            rows_x.append(x)
            rows_y.append(y)
            rows_z.append(z)
            rows_n.append(n)
            rows_uv.append(uv)

        # cuticle tuck row: past the cuticle, under the proximal fold
        tx = Xv[0]
        ty = Yv[0] + P.FOLD_TUCK_PROX * mm
        tz = self.z(tx, ty) - 0.8 * P.FOLD_TUCK_PROX * mm
        bw = np.ones(1)
        add(*side_cols(tx, ty, tz, Nv[0], u[0], v[0], 1.0))
        for j in range(nv):
            # under the side fold where there is one; past it the side is the plate's thickness
            bed_w = float(smoothstep(P.FOLD_SIDE_END[0] * 0.33 * mm, P.FOLD_SIDE_END[1] * mm, Yv[j, 0] - self.y_h))
            add(*side_cols(Xv[j], Yv[j], Zv[j], Nv[j], u[j], v[j], bed_w))
        # lip: the free edge's thickness, then the underside back to the bed end
        e = nv - 1
        ln = unit(np.stack([np.zeros(NI), -np.ones(NI), -0.2 * np.ones(NI)], -1))
        add(*side_cols(Xv[e] * 0.99, Yv[e] + 0.05 * T, Zv[e] - 0.5 * T, ln, u[e], v[e], 0.0))
        for j in range(nv - 1, NB - 2, -1):
            n = Nv[j]
            r = side_cols(Xv[j] - n[:, 0] * T, Yv[j] - n[:, 1] * T, Zv[j] - n[:, 2] * T, -n, u[j], v[j], 0.0)
            # the underside's side columns close onto the foot of the plate's side wall
            for k in (0, -1):
                r[0][k], r[1][k], r[2][k] = Xv[j, k], Yv[j, k], Zv[j, k] - T
            add(*r)
        del bw
        X = np.array(rows_x)
        Y = np.array(rows_y)
        Z = np.array(rows_z)
        N = np.array(rows_n)
        UV = np.array(rows_uv)
        NJ, NC = X.shape
        faces = []
        mid = (NC - 1) / 2.0
        idx = lambda j, i: j * NC + i  # noqa: E731
        for j in range(NJ - 1):
            for i in range(NC - 1):
                a, b, c, d = idx(j, i), idx(j + 1, i), idx(j + 1, i + 1), idx(j, i + 1)
                faces += [(a, b, c), (a, c, d)] if i < mid else [(a, b, d), (b, c, d)]
        self.shape = (NJ, NC)
        self.visible_rows = (1, nv)        # rows 1 .. nv are the visible top
        return (np.stack([X, Y, Z], -1).reshape(-1, 3), UV.reshape(-1, 2), N.reshape(-1, 3), faces)

    def visible_mask(self):
        NJ, NC = self.shape
        m = np.zeros((NJ, NC), dtype=bool)
        m[1:1 + P.NAIL_BED_ROWS + P.NAIL_FREE_ROWS, 1:NC - 1] = True
        return m.ravel()

    def anat(self, cy, half):
        """nailAnat for a frame centred at y = cy with half length `half`."""
        return [float((self.y_h - cy) / half), float(self.sag / half), float(self.d_tip / half), 0.0]


def _patch(hand, fi):
    me = hand.data
    mw = np.array(hand.matrix_world)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    polys = [p for p in me.polygons if p.material_index == 1 + fi]
    vi = sorted({v for p in polys for v in p.vertices})
    n = sum((Vector(p.normal) * p.area for p in polys), Vector())
    return co, co[vi], unit(np.array(mw[:3, :3]) @ np.array(n))


def grooves(scene):
    """Each finger's groove frame and measurements (on the dense skin)."""
    hand, cage = scene['hand'], scene['cage']
    mm = cage.scale
    out = {}
    W = scene['W_dense']
    for fi, f in enumerate(FINGERS):
        co, Q, Z = _patch(hand, fi)
        a, b = cage.joints[f + '.3'], cage.joints[f + '.4']
        Y = -(b - a)
        Y = unit(Y - Z * (Y @ Z))
        X = np.cross(Y, Z)
        O = Q.mean(0)
        g = Groove(f, O, X, Y, Z, mm)
        L = g.local(Q)
        g.fit(L)
        # cuticle and hyponychium on the centre line; half width at mid-bed
        hw = (L[:, 0].max() - L[:, 0].min()) / 2
        x0 = (L[:, 0].max() + L[:, 0].min()) / 2
        cen = np.abs(L[:, 0] - x0) < 0.4 * hw
        g.y_cut = float(L[cen, 1].max())
        g.y_h = float(L[cen, 1].min())
        mid = (g.y_cut + g.y_h) / 2
        band = np.abs(L[:, 1] - mid) < 0.2 * (g.y_cut - g.y_h)
        g.bed_half_w = float((L[band, 0].max() - L[band, 0].min()) / 2)
        g.x0 = float(x0)
        # finger width at mid-nail: this finger's skin in a thin slab across the bed's middle
        Sk = g.local(co)
        fw = W[f] > 0.5
        sl = fw & (np.abs(Sk[:, 1] - mid) < 0.6 * mm) & (Sk[:, 2] > -8 * mm)
        g.finger_half_w = float((Sk[sl, 0].max() - Sk[sl, 0].min()) / 2)
        if getattr(cage, 'finger_half_w', None):
            g.finger_half_w = float(cage.finger_half_w[f])      # measured before the widening (limit surface)
        out[f] = g
    return out


def signed_distance(poly, x, y):
    """Distance to a closed polygon (N, 2) in the plane, negative inside."""
    p = np.stack([x, y], -1)
    keep = np.r_[True, np.linalg.norm(np.diff(poly, axis=0), axis=1) > 1e-12]
    poly = poly[keep]
    q0, q1 = poly, np.roll(poly, -1, axis=0)
    d = q1 - q0
    L2 = np.maximum((d ** 2).sum(1), 1e-30)
    t = np.clip(((p[:, None, :] - q0[None]) * d[None]).sum(-1) / L2[None], 0, 1)
    proj = q0[None] + t[..., None] * d[None]
    dist = np.sqrt(((p[:, None, :] - proj) ** 2).sum(-1)).min(1)
    xx, yy = p[:, 0][:, None], p[:, 1][:, None]
    cond = (q0[None, :, 1] > yy) != (q1[None, :, 1] > yy)
    xi = q0[None, :, 0] + (yy - q0[None, :, 1]) * d[None, :, 0] / np.where(d[None, :, 1] == 0, 1e-12, d[None, :, 1])
    inside = (cond & (xx < xi)).sum(1) % 2 == 1
    return np.where(inside, -dist, dist)


def hypo_line(g, co, fw, W0, y_cut):
    """y of the hyponychium line: where the dorsal surface along the nail's
    centre line turns HYPO_TILT away from the bed."""
    mm = g.mm
    L = g.local(co)
    sel = fw & (np.abs(L[:, 0]) < 0.25 * W0) & (L[:, 1] < y_cut - 3 * mm) & (L[:, 2] > g.zbed(L[:, 0], L[:, 1]) - 3 * mm)
    ys = np.sort(L[sel, 1])[::-1]
    zs = g.zbed(0.0, ys)
    # the profile z(y) of the skin on the centre line: slope against the bed's own
    yy, zz = L[sel, 1], L[sel, 2]
    o = np.argsort(-yy)
    yy, zz = yy[o], zz[o]
    best = None
    for i in range(2, len(yy) - 2):
        j = slice(max(0, i - 3), i + 4)
        A = np.stack([np.ones_like(yy[j]), yy[j]], 1)
        slope = np.linalg.lstsq(A, zz[j], rcond=None)[0][1]
        e = 1e-4
        bs = (g.zbed(0.0, yy[i] + e) - g.zbed(0.0, yy[i] - e)) / (2 * e)
        ang = math.degrees(math.atan(slope) - math.atan(bs))
        if ang > P.HYPO_TILT:
            best = yy[i]
            break
    del ys, zs
    return best


def _write_plate(f, g, rig, verts, uv, nrm, faces, origin, keys=None):
    mesh = bpy.data.meshes.new('Nail_' + f.capitalize())
    # Blender local axes (x across, -out, toward the cuticle): the exporter's Y-up
    # conversion makes them three's +X across, +Y toward the cuticle, +Z out
    mesh.from_pydata([(v[0], -v[2], v[1]) for v in verts], [], faces)
    mesh.update()
    uvl = mesh.uv_layers.new(name='UVMap')
    loop_v = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get('vertex_index', loop_v)
    uvl.data.foreach_set('uv', uv[loop_v].astype(np.float32).ravel())
    mesh.shade_smooth()
    mesh.normals_split_custom_set_from_vertices([(n[0], -n[2], n[1]) for n in nrm])
    obj = bpy.data.objects.new('Nail_' + f.capitalize(), mesh)
    bpy.context.scene.collection.objects.link(obj)
    if keys:
        obj.shape_key_add(name='Basis')
        for name, kv in keys.items():
            sk = obj.shape_key_add(name=name)
            sk.data.foreach_set('co', np.array([(v[0], -v[2], v[1]) for v in kv], dtype=np.float32).ravel())
    M = Matrix(((g.X[0], -g.Z[0], g.Y[0], origin[0]),
                (g.X[1], -g.Z[1], g.Y[1], origin[1]),
                (g.X[2], -g.Z[2], g.Y[2], origin[2]), (0, 0, 0, 1)))
    obj.parent = rig
    obj.parent_type = 'BONE'
    obj.parent_bone = f + '.03'
    bpy.context.view_layer.update()
    obj.matrix_world = M
    bpy.context.view_layer.update()
    return obj, M


def build(scene, report, check, free_len=None, sculpted=False, morph=False):
    hand, rig, cage = scene['hand'], scene['rig'], scene['cage']
    mm = cage.scale
    free_len = P.NAIL_FREE_LEN if free_len is None else free_len
    G = grooves(scene)
    info, plates = {}, {}
    me = hand.data
    mw = np.array(hand.matrix_world)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    for fi, f in enumerate(FINGERS):
        g = G[f]
        # recentre the frame across on the groove
        g.O = g.O + g.X * g.x0
        g.c[0] += g.c[1] * g.x0 + g.c[3] * g.x0 ** 2
        g.c[1] += 2 * g.c[3] * g.x0
        g.c[2] += g.c[5] * g.x0
        if sculpted:
            W0 = P.NAIL_WIDTH_FRAC * g.finger_half_w
            lift = 0.0
            g.y_h_patch = g.y_h
            if g.y_cut - g.y_h < P.BED_MIN * 2 * g.finger_half_w:
                # a short bed patch (the pinky): out to the hyponychium line
                yt = hypo_line(g, co, scene['W_dense'][f] > 0.5, W0, g.y_cut)
                if yt is not None and yt < g.y_h:
                    g.y_h = float(yt)
            # never a nail shorter than wide (the pinky's patch is short): bed >= BED_FLOOR x the finger width
            g.y_h = min(g.y_h, g.y_cut - P.BED_FLOOR * 2 * g.finger_half_w)
            # a nail's arch along the finger is gentle: never tighter than NAIL_ARCH_MIN
            g.c[4] = max(g.c[4], -1.0 / (2.0 * P.NAIL_ARCH_MIN * mm))
        else:
            W0, lift = g.bed_half_w, P.NAIL_LIFT * mm
        pl = Plate(g, W0, g.y_cut, g.y_h, free_len, lift)
        verts, uv, nrm, faces = pl.build()
        # the frame origin: the visible plate's centre (on its surface), at the default length
        cy = (pl.y_cut + pl.y_tip) / 2
        cz = float(pl.z(0.0, cy))
        half = (pl.y_cut - pl.y_tip) / 2
        off = np.array([0.0, cy, cz])
        origin = g.O + g.Y * cy + g.Z * cz
        keys = None
        var = None
        if morph:
            L0, L1 = P.NAIL_FREE_RANGE
            ps, plg = Plate(g, W0, g.y_cut, g.y_h, L0, lift), Plate(g, W0, g.y_cut, g.y_h, L1, lift)
            vs, uvs, ns, fs = ps.build()
            vl, _, _, fl = plg.build()
            assert fs == fl and fs == faces
            verts, uv, nrm = vs, uvs, ns
            keys = {'long': vl - off}
            var = {'L': [L0, L1], 'def': free_len, 'mm': [ps.free / mm, plg.free / mm],
                   'cy': [(ps.y_cut + ps.y_tip) / 2 - cy, (plg.y_cut + plg.y_tip) / 2 - cy],
                   'half': [(ps.y_cut - ps.y_tip) / 2, (plg.y_cut - plg.y_tip) / 2],
                   'hypoY': pl.y_h - cy, 'cutArc': pl.sag, 'freeArc': pl.d_tip}
        obj, M = _write_plate(f, g, rig, verts - off, uv, nrm, faces, origin, keys)
        chord = float(pl.W(cy))
        obj['nailFrame'] = 1
        obj['nailHalf'] = [float(half), chord]
        obj['nailAnat'] = pl.anat(cy, half)
        if var:
            obj['nailVar'] = {k: ([float(x) for x in v] if isinstance(v, list) else float(v)) for k, v in var.items()}
        pl.obj, pl.cy, pl.cz, pl.half = obj, cy, cz, half
        plates[f] = pl
        scene['nails'][f] = obj
        nv = len(obj.data.vertices)
        info[f] = {'verts': nv, 'half_len_mm': round(half / mm, 2), 'half_w_mm': round(chord / mm, 2),
                   'bed_mm': round(pl.bed / mm, 2), 'free_mm': round(pl.free / mm, 2),
                   'width_frac': round(W0 / g.finger_half_w, 3), 'finger_w_mm': round(2 * g.finger_half_w / mm, 2),
                   'aspect': round(half / chord, 3), 'corner_r_over_half_w': round(pl.d_tip / W0, 3),
                   'hypo_moved_mm': round((getattr(g, 'y_h_patch', g.y_h) - g.y_h) / mm, 2)}
        check(f'{f}: plate verts <= {P.CAP_NAIL_VERTS}', nv <= P.CAP_NAIL_VERTS, nv, P.CAP_NAIL_VERTS)
        err = float(np.abs(np.array(obj.matrix_world) - np.array(M)).max())
        R = np.array(M)[:3, :3]
        check(f'{f}: frame orthonormal, right-handed, unit scale, placed',
              err < 1e-5 and np.abs(R.T @ R - np.eye(3)).max() < 1e-6 and np.linalg.det(np.stack([g.X, g.Y, g.Z], 1)) > 0,
              float('%.1e' % err))
        check(f'{f}: UVs inside [0, 1]', uv.min() >= -1e-6 and uv.max() <= 1 + 1e-6,
              [round(float(uv.min()), 4), round(float(uv.max()), 4)])
        if sculpted:
            check(f'{f}: plate width / finger width = {P.NAIL_WIDTH_FRAC} +- 0.02',
                  abs(W0 / g.finger_half_w - P.NAIL_WIDTH_FRAC) <= 0.02, round(W0 / g.finger_half_w, 3))
            check(f'{f}: free-edge corners rounded (radius > 25% of the half width)', pl.d_tip / W0 > 0.25,
                  round(pl.d_tip / W0, 3))
    report['nails'] = info
    scene['plates'] = plates
    scene['nail_normal'] = {f: G[f].Z for f in FINGERS}
    if sculpted:
        sculpt_skin(scene, plates, report, check)
        asp = {f: info[f]['aspect'] * 1.0 for f in FINGERS}
        check('nails: length / width between 1.05 and 1.6 at the default length',
              all(1.05 <= 2 * v / 2 <= 1.6 for v in asp.values()), asp, [1.05, 1.6])
    nail_checks(scene, plates, info, check)
    return plates


def outline(pl):
    """The visible plate's outline in its frame (x, y), counter-clockwise."""
    X, Y = pl.Xv, pl.Yv
    ring = [(X[0, i], Y[0, i]) for i in range(X.shape[1] - 1, -1, -1)]
    ring += [(X[j, 0], Y[j, 0]) for j in range(1, X.shape[0])]
    ring += [(X[-1, i], Y[-1, i]) for i in range(1, X.shape[1])]
    ring += [(X[j, -1], Y[j, -1]) for j in range(X.shape[0] - 2, 0, -1)]
    return np.array(ring)


def sculpt_skin(scene, plates, report, check):
    """The skin round each plate (on the dense mesh, in the nail frame): the bed
    under the plate (its thickness + BED_GAP below the top), the proximal and
    side folds standing FOLD_H above the plate and dropping onto it just inside
    its outline (so they overlap the rim), the fingertip rounding away under the
    free edge. One extra cut along the outline first (a crisp fold line)."""
    import bmesh
    hand, cage = scene['hand'], scene['cage']
    mm = cage.scale
    me = hand.data
    mw = np.array(hand.matrix_world)
    mwi = np.linalg.inv(mw)
    T = P.NAIL_THICKNESS * mm
    polys = {f: outline(pl) for f, pl in plates.items()}
    Wd = scene['W_dense']
    # one cut through the band round each outline
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    co = np.array([tuple(v.co) for v in bm.verts]) @ mw[:3, :3].T + mw[:3, 3]
    cut = set()
    for f, pl in plates.items():
        g = pl.g
        L = g.local(co)
        near = (Wd[f] > 0.5) & (L[:, 2] > pl.z(L[:, 0], L[:, 1]) - 3 * mm) & (L[:, 1] > pl.y_h - 1.0 * mm)
        idx = np.nonzero(near)[0]
        d = np.full(len(co), 1e9)
        d[idx] = signed_distance(polys[f], L[idx, 0], L[idx, 1]) / mm
        lo, hi = P.FOLD_BAND or (0, 0)
        for e in bm.edges:
            i, j = e.verts[0].index, e.verts[1].index
            if near[i] and near[j] and min(d[i], d[j]) < hi and max(d[i], d[j]) > lo:
                cut.add(e)
    n0 = len(bm.verts)
    if cut and P.FOLD_BAND:
        bmesh.ops.subdivide_edges(bm, edges=list(cut), cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[fc for fc in bm.faces if len(fc.verts) > 4])
    bm.to_mesh(me)
    bm.free()
    me.update()
    added = len(me.vertices) - n0
    # the weights of the new vertices for the rest of the build
    from rig import mesh_weights
    from base import BI
    Wm = mesh_weights(hand)
    scene['W_dense'] = Wd = {f: Wm[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) for f in FINGERS}
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    new = co.copy()
    for f, pl in plates.items():
        g = pl.g
        fw = Wd[f] > 0.5
        L = g.local(co)
        x, y, lz = L[:, 0], L[:, 1], L[:, 2]
        zp = pl.z(x, y)
        top = 1.0 - smoothstep(1.5 * mm, 3.5 * mm, zp - lz)
        cand = fw & (top > 0)
        i = np.nonzero(cand)[0]
        x, y, lz, zp, top = x[i], y[i], lz[i], zp[i], top[i]
        # the profile is laid out from just outside the rim: the skin crosses the
        # plate's level FOLD_MEET outside the outline (the whole visible plate shows,
        # the steep tuck goes under the fold)
        d = signed_distance(polys[f], x, y) - (P.FOLD_COVER + P.FOLD_MEET) * mm
        prox = smoothstep((pl.y_cut + pl.y_h) / 2, pl.y_cut - 1.0 * mm, y)
        h = (P.FOLD_H_PROX * prox + P.FOLD_H_SIDE * (1 - prox)) * mm
        fold_on = smoothstep(pl.y_h - P.FOLD_SIDE_END[0] * mm, pl.y_h + P.FOLD_SIDE_END[1] * mm, y)
        over = np.clip(pl.y_h - y, 0, None)
        floor = -(T + P.BED_GAP * mm) - P.HYPO_GAP * over
        edge = h * P.FOLD_EDGE
        slope = edge / (P.FOLD_COVER * mm)
        t = np.clip(d / (P.FOLD_WIDTH * mm), 0, 1)
        f_out = h * (P.FOLD_EDGE + (1 - P.FOLD_EDGE) * smoothstep(0.0, 0.35, t)) * fold_on
        f_in = np.maximum(fold_on * (edge + slope * d) + (1 - fold_on) * floor, floor)
        z_in = np.where(f_in > floor + 1e-12, zp + f_in, np.minimum(lz, zp + floor))
        wb = (1.0 - smoothstep(0.35, 1.0, t)) * fold_on
        z_out = lz + (zp + f_out - lz) * wb
        z_new = np.where(d < 0, z_in, z_out)
        z_new = lz + (z_new - lz) * top
        # no skin above the plate inside its visible outline (plan 4.7)
        inside = signed_distance(polys[f], x, y) < 0
        z_new = np.where(inside, np.minimum(z_new, zp - P.SKIN_UNDER * mm), z_new)
        new[i] = co[i] + np.outer(z_new - lz, g.Z)
    loc = new @ mwi[:3, :3].T + mwi[:3, 3]
    me.vertices.foreach_set('co', loc.ravel())
    me.update()
    report['counts']['fold_band_verts'] = added


def pl_normal(pl, i):
    """The plate's analytic top normal at grid vertex i (frame coordinates)."""
    NJ, NC = pl.shape
    j, c = divmod(int(i), NC)
    return pl.normal(pl.Xv[j - 1, c - 1], pl.Yv[j - 1, c - 1])


def nail_checks(scene, plates, info, check):
    hand = scene['hand']
    mm = scene['cage'].scale
    me = hand.data
    mw = np.array(hand.matrix_world)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
    bvh = BVHTree.FromPolygons([tuple(p) for p in co], [tuple(p.vertices) for p in me.polygons])
    for f, pl in plates.items():
        m = np.array(pl.obj.matrix_world)
        lv = np.empty(len(pl.obj.data.vertices) * 3)
        pl.obj.data.vertices.foreach_get('co', lv)
        Q = lv.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
        vis = pl.visible_mask()
        n = Vector(pl.g.Z)
        bad = tested = 0
        gaps = []
        T = P.NAIL_THICKNESS * mm
        nl = np.empty(len(pl.obj.data.vertices) * 3)
        pl.obj.data.vertices.foreach_get('normal', nl)
        nl = nl.reshape(-1, 3)
        nl = np.stack([nl[:, 0], nl[:, 2], -nl[:, 1]], 1)  # Blender local -> frame (x, y, z)
        R = np.stack([pl.g.X, pl.g.Y, pl.g.Z], 1)
        reach = 1.5 * mm
        for i in np.nonzero(vis)[0]:
            p = Vector(Q[i])
            tested += 1
            nv = Vector(R @ pl_normal(pl, i))
            if bvh.ray_cast(p + nv * reach, -nv, reach - P.UNDER_TOL * mm)[0] is not None:
                bad += 1
                NJ, NC = pl.shape
                info[f].setdefault('under_at_row_col', []).append([int(i // NC), int(i % NC)])
            hit = bvh.ray_cast(p, -n, 0.05)
            if hit[0] is not None:
                gaps.append(hit[3] - T)
        info[f]['under_skin'] = f'{bad}/{tested}'
        info[f]['min_gap_under_mm'] = round(float(min(gaps) / mm), 3) if gaps else None
        check(f'{f}: no visible plate vertex under the skin', bad == 0, f'{bad}/{tested}')
        rg = getattr(scene['W_dense'], 'get', None)
        del rg
    return info


# ---- the groove sculpt (plan 4.3) ----------------------------------------------------------
def _limit(cage, level=2):
    """The cage's subdivided surface: points and which finger's bed each lies on."""
    me = bpy.data.meshes.new('lim')
    me.from_pydata(cage.V.tolist(), [], cage.F.tolist())
    mi = np.zeros(len(cage.F), dtype=np.int32)
    for fi, f in enumerate(FINGERS):
        mi[cage.nails[f]] = 1 + fi
    me.polygons.foreach_set('material_index', mi)
    ob = bpy.data.objects.new('lim', me)
    bpy.context.scene.collection.objects.link(ob)
    m = ob.modifiers.new('s', 'SUBSURF')
    m.levels = level
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    em = ev.to_mesh()
    co = np.empty(len(em.vertices) * 3)
    em.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    bed = np.full(len(co), -1)
    for p in em.polygons:
        if p.material_index:
            bed[list(p.vertices)] = p.material_index - 1
    ev.to_mesh_clear()
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(me)
    return co, bed


def cage_frame(cage, f):
    Z = cage.nail_normal(f)
    d = unit(cage.joints[f + '.4'] - cage.joints[f + '.3'])
    Y = unit(-(d - Z * (d @ Z)))
    X = np.cross(Y, Z)
    return cage.nail_centre(f), X, Y, Z, d


def measure(cage, mm):
    """Groove and finger half widths at mid-bed (mm), on the limit surface."""
    co, bed = _limit(cage)
    out = {}
    for fi, f in enumerate(FINGERS):
        O, X, Y, Z, d = cage_frame(cage, f)
        L = np.stack([(co - O) @ X, (co - O) @ Y, (co - O) @ Z], 1)
        b = L[bed == fi]
        mid = (b[:, 1].max() + b[:, 1].min()) / 2
        band = np.abs(b[:, 1] - mid) < 0.2 * (b[:, 1].max() - b[:, 1].min())
        g = (b[band, 0].max() - b[band, 0].min()) / 2
        h3 = cage.joints[f + '.3']
        rel = co - h3
        r = np.linalg.norm(rel - np.outer(rel @ d, d), axis=1)
        sl = (np.abs(L[:, 1] - mid) < 0.8 * mm) & (r < 10 * mm)
        w = (L[sl, 0].max() - L[sl, 0].min()) / 2
        out[f] = (g / mm, w / mm)
    return out


def widen_grooves(cage, report, check):
    """Widen each nail groove to NAIL_WIDTH_FRAC of the finger (plan 4.3).

    In the nail frame, the cage vertices of the last joint slide across (x only)
    along the cage's own original surface (projected along the nail normal):
    the bed scales by k, the fold rings between the groove edge and the
    finger's flank compress (a narrower, crisper fold), the flank stays put.
    The finger's width is measured once, before (on the limit surface); the
    groove's after, on the limit surface again, and k is solved for it."""
    from mathutils.bvhtree import BVHTree
    mm = cage.scale
    V0 = cage.V.copy()
    m0 = measure(cage, mm)
    bvh = BVHTree.FromPolygons([tuple(p) for p in V0], [tuple(q) for q in cage.F])
    prep = {}
    for f in FINGERS:
        O, X, Y, Z, d = cage_frame(cage, f)
        L = np.stack([(V0 - O) @ X, (V0 - O) @ Y, (V0 - O) @ Z], 1)
        pv = np.unique(cage.F[cage.nails[f]])
        fw = cage.W[:, [cage_bi(f, kk) for kk in (1, 2, 3)]].sum(1) > 0.5
        y0, y1 = L[pv, 1].min(), L[pv, 1].max()
        wy = smoothstep(y1 + 4 * mm, y1 + 1.5 * mm, L[:, 1])           # fades out behind the cuticle
        top = (L[:, 2] > -4.0 * mm) & fw
        x0 = (L[pv, 0].max() + L[pv, 0].min()) / 2
        xa = (L[pv, 0].max() - L[pv, 0].min()) / 2
        xb = 0.97 * m0[f][1] * mm
        prep[f] = (O, X, Y, Z, L, wy * top, x0, xa, xb)
    k = {f: P.NAIL_WIDTH_FRAC * m0[f][1] / m0[f][0] for f in FINGERS}
    hist = {f: [round(m0[f][0] / m0[f][1], 3)] for f in FINGERS}
    for it in range(P.WIDEN_ITERS):
        cage.V = V0.copy()
        for f in FINGERS:
            O, X, Y, Z, L, w, x0, xa, xb = prep[f]
            kk = k[f]
            xr = L[:, 0] - x0
            a = np.abs(xr)
            if kk * xa >= xb:
                kk = 0.98 * xb / xa
            m = np.where(a <= xa, kk * a, np.where(a < xb, xb - (xb - a) * (xb - kk * xa) / (xb - xa), a))
            xn = x0 + np.sign(xr) * m
            xn = L[:, 0] + (xn - L[:, 0]) * w
            for i in np.nonzero(np.abs(xn - L[:, 0]) > 1e-9)[0]:
                p = O + X * xn[i] + Y * L[i, 1] + Z * (L[i, 2] + 6 * mm)
                hit = bvh.ray_cast(Vector(p), Vector(-Z), 12 * mm)
                if hit[0] is not None:
                    cage.V[i] = np.array(hit[0])
        m1 = measure(cage, mm)
        for f in FINGERS:
            g = m1[f][0]
            hist[f].append(round(g / m0[f][1], 3))
            k[f] *= 1.0 + 0.9 * (P.NAIL_WIDTH_FRAC * m0[f][1] / g - 1.0)
    report['nail_groove'] = {f: {'k': round(k[f], 3), 'finger_w_mm': round(2 * m0[f][1], 2),
                                 'groove_over_finger': hist[f]} for f in FINGERS}
    cage.finger_half_w = {f: m0[f][1] * mm for f in FINGERS}
    return cage


def cage_bi(f, k):
    from base import BI
    return BI[f + '.0%d' % k]
