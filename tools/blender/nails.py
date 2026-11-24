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
        self.d_tip = min(P.NAIL_TIP_ROUND * W0, 0.6 * (y_cut - self.y_tip))
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
        z = z + dzdy * past - P.NAIL_DROOP * (past / mm) ** 2 * mm
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
        Xv = s[None, :] * self.W(Yv)
        # the outline's x at the free-edge corners follows the ellipse
        Zv = self.z(Xv, Yv)
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
            bed_w = float(smoothstep(-1.5 * mm, 0.5 * mm, Yv[j, 0] - self.y_h))
            add(*side_cols(Xv[j], Yv[j], Zv[j], Nv[j], u[j], v[j], bed_w))
        # lip: the free edge's thickness, then the underside back to the bed end
        e = nv - 1
        ln = unit(np.stack([np.zeros(NI), -np.ones(NI), -0.2 * np.ones(NI)], -1))
        add(*side_cols(Xv[e] * 0.99, Yv[e] + 0.05 * T, Zv[e] - 0.5 * T, ln, u[e], v[e], 0.0))
        for j in range(nv - 1, NB - 2, -1):
            n = Nv[j]
            add(*side_cols(Xv[j] - n[:, 0] * T, Yv[j] - n[:, 1] * T, Zv[j] - n[:, 2] * T, -n, u[j], v[j], 0.0))
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
        out[f] = g
    return out


def build(scene, report, check, free_len=None, sculpted=False):
    hand, rig, cage = scene['hand'], scene['rig'], scene['cage']
    mm = cage.scale
    free_len = P.NAIL_FREE_LEN if free_len is None else free_len
    G = grooves(scene)
    info, plates = {}, {}
    co_skin = None
    for fi, f in enumerate(FINGERS):
        g = G[f]
        if sculpted:
            W0, lift = P.NAIL_WIDTH_FRAC * g.finger_half_w, 0.0
        else:
            W0, lift = g.bed_half_w, P.NAIL_LIFT * mm
        # recentre the frame across on the groove
        g.O = g.O + g.X * g.x0
        g.c[0] += g.c[1] * g.x0 + g.c[3] * g.x0 ** 2
        g.c[1] += 2 * g.c[3] * g.x0
        g.c[2] += g.c[5] * g.x0
        pl = Plate(g, W0, g.y_cut, g.y_h, free_len, lift)
        verts, uv, nrm, faces = pl.build()
        # the frame origin: the visible plate's centre (on its surface)
        cy = (pl.y_cut + pl.y_tip) / 2
        cz = float(pl.z(0.0, cy))
        half = (pl.y_cut - pl.y_tip) / 2
        verts = verts - np.array([0.0, cy, cz])
        origin = g.O + g.Y * cy + g.Z * cz
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
        M = Matrix(((g.X[0], -g.Z[0], g.Y[0], origin[0]),
                    (g.X[1], -g.Z[1], g.Y[1], origin[1]),
                    (g.X[2], -g.Z[2], g.Y[2], origin[2]), (0, 0, 0, 1)))
        obj.parent = rig
        obj.parent_type = 'BONE'
        obj.parent_bone = f + '.03'
        bpy.context.view_layer.update()
        obj.matrix_world = M
        bpy.context.view_layer.update()
        chord = float(pl.W(cy))
        obj['nailFrame'] = 1
        obj['nailHalf'] = [float(half), chord]
        obj['nailAnat'] = pl.anat(cy, half)
        pl.obj, pl.cy, pl.cz, pl.half = obj, cy, cz, half
        plates[f] = pl
        scene['nails'][f] = obj
        nv = len(mesh.vertices)
        aspect = (2 * half) / (2 * chord)
        info[f] = {'verts': nv, 'half_len_mm': round(half / mm, 2), 'half_w_mm': round(chord / mm, 2),
                   'bed_mm': round(pl.bed / mm, 2), 'free_mm': round(pl.free / mm, 2),
                   'width_frac': round(W0 / g.finger_half_w, 3), 'groove_frac': round(g.bed_half_w / g.finger_half_w, 3),
                   'aspect': round(aspect, 3)}
        check(f'{f}: plate verts <= {P.CAP_NAIL_VERTS}', nv <= P.CAP_NAIL_VERTS, nv, P.CAP_NAIL_VERTS)
        err = float(np.abs(np.array(obj.matrix_world) - np.array(M)).max())
        R = np.array(M)[:3, :3]
        check(f'{f}: frame orthonormal, unit scale, placed', err < 1e-5 and np.abs(R.T @ R - np.eye(3)).max() < 1e-6,
              float('%.1e' % err))
        check(f'{f}: UVs inside [0, 1]', uv.min() >= -1e-6 and uv.max() <= 1 + 1e-6,
              [round(float(uv.min()), 4), round(float(uv.max()), 4)])
    report['nails'] = info
    scene['plates'] = plates
    scene['nail_normal'] = {f: G[f].Z for f in FINGERS}
    # the plate sits on the skin: no visible plate vertex under the skin
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
        for i in np.nonzero(vis)[0]:
            p = Vector(Q[i])
            tested += 1
            if bvh.ray_cast(p + n * 0.05, -n, 0.05 - 1e-5)[0] is not None:
                bad += 1
            hit = bvh.ray_cast(p, -n, 0.05)
            if hit[0] is not None:
                gaps.append(hit[3])
        info[f]['under_skin'] = f'{bad}/{tested}'
        info[f]['min_gap_mm'] = round(float(min(gaps) / mm), 3) if gaps else None
        check(f'{f}: no visible plate vertex under the skin', bad == 0, f'{bad}/{tested}')
    return plates
