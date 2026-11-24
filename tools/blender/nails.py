"""The nail unit (hand-plan.md 3.2): rebuilt plates and the skin around them.

Per finger, from the old plate's frame (centre, across, toward the cuticle, out):
  * a new plate: a clean NI x (1 + NV + 2) grid, a C-curve across (radius fitted
    to the old plate, a little tighter toward the free edge), a slight arch
    along, straight sides, an arc at the cuticle and at the free edge, a hidden
    skirt under the folds and a free edge turned under (its thickness);
  * a canonical local frame in the game (three, Y up): +X across, +Y toward
    the cuticle, +Z out, origin on the plate surface at its centre; node
    extras { nailFrame: 1, nailHalf, nailAnat };
  * real UVs: u across (arc length), v along, v = 0 at the cuticle (in the
    game: glTF flips v), the
    visible plate spans [0, 1]; skirt and lip copy the UV of their rim vertex
    (zero UV area: only what a kid can see counts);
  * the skin around it: subdivided locally, then displaced in the nail frame
    by the signed distance to the plate outline (proximal and lateral folds that
    rise above the plate and drop onto it, the nail bed below the plate, a gap
    under the free edge), and weighted 100% to the finger's .03 bone near the
    plate, so the folds can never slide on it.
"""
import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import gltfio
import params as P
from gltfio import FINGERS, NAIL_NAMES


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class Plate:
    """One nail plate in its own frame (a = arc length across, y along, z out)."""

    def __init__(self, finger, Wv, Lv, R0, Rlong, y_hypo):
        self.finger = finger
        self.Wv, self.Lv, self.R0, self.Rlong, self.y_hypo = Wv, Lv, R0, Rlong, y_hypo
        self._layout()

    def R(self, y):
        t = np.clip((self.Lv - np.asarray(y)) / (2 * self.Lv), 0.0, 1.0)
        return self.R0 * (1.0 - P.NAIL_RADIUS_FREE_TIGHTEN * t)

    def surf(self, a, y):
        """Local (x, z) of the surface at arc length a, along y (works outside the outline too)."""
        R = self.R(y)
        x = R * np.sin(a / R)
        z = -R * (1.0 - np.cos(a / R)) - np.asarray(y) ** 2 / (2.0 * self.Rlong)
        return x, z

    def normal(self, a, y):
        R = self.R(y)
        th = a / R
        n = np.stack([np.sin(th), -np.asarray(y) / self.Rlong * np.cos(th), np.cos(th)], -1)
        return n / np.linalg.norm(n, axis=-1, keepdims=True)

    def a_of_x(self, x, y):
        R = self.R(y)
        return R * np.arcsin(np.clip(x / R, -1.0, 1.0))

    def _layout(self):
        """Visible grid (rows top -> bottom, columns left -> right) in (a, y)."""
        NI, NV = P.NAIL_NI, P.NAIL_NV
        Wv, Lv = self.Wv, self.Lv
        bc = P.NAIL_CUTICLE_ARC * Wv
        bf = P.NAIL_FREE_ARC * Wv
        s = np.linspace(-1.0, 1.0, NI - 2)
        r = np.linspace(0.0, 1.0, NV)
        rc = np.clip(1.0 - r / P.NAIL_CUTICLE_ROWS, 0.0, 1.0) ** 1.5
        rf = np.clip((r - (1.0 - P.NAIL_FREE_ROWS)) / P.NAIL_FREE_ROWS, 0.0, 1.0) ** 1.5
        top, bot = Lv - bc, -(Lv - bf)
        ycore = top + (bot - top) * r
        S, Rr = np.meshgrid(s, r)
        RC = np.broadcast_to(rc[:, None], S.shape)
        RF = np.broadcast_to(rf[:, None], S.shape)
        A = S * Wv * (1.0 - P.NAIL_CUTICLE_ROUND * RC ** 2 - P.NAIL_FREE_ROUND * RF ** 2)
        Y = ycore[:, None] + bc * (1.0 - S ** 2) * RC - bf * (1.0 - S ** 2) * RF
        self.A, self.Y = A, Y
        # closed outline in (a, y), counter-clockwise
        ring = [(A[0, i], Y[0, i]) for i in range(NI - 3, -1, -1)]
        ring += [(A[j, 0], Y[j, 0]) for j in range(1, NV)]
        ring += [(A[NV - 1, i], Y[NV - 1, i]) for i in range(1, NI - 2)]
        ring += [(A[j, NI - 3], Y[j, NI - 3]) for j in range(NV - 2, 0, -1)]
        self.outline = np.array(ring)

    def signed_distance(self, a, y):
        """Distance to the visible outline in the (a, y) plane, negative inside."""
        p = np.stack([a, y], -1)
        q0 = self.outline
        q1 = np.roll(self.outline, -1, axis=0)
        d = q1 - q0
        L2 = (d ** 2).sum(1)
        t = np.clip(((p[:, None, :] - q0[None]) * d[None]).sum(-1) / L2[None], 0, 1)
        proj = q0[None] + t[..., None] * d[None]
        dist = np.sqrt(((p[:, None, :] - proj) ** 2).sum(-1)).min(1)
        # inside: even-odd crossing test
        x, yy = p[:, 0][:, None], p[:, 1][:, None]
        cond = (q0[None, :, 1] > yy) != (q1[None, :, 1] > yy)
        xint = q0[None, :, 0] + (yy - q0[None, :, 1]) * d[None, :, 0] / np.where(d[None, :, 1] == 0, 1e-12, d[None, :, 1])
        inside = (cond & (x < xint)).sum(1) % 2 == 1
        return np.where(inside, -dist, dist)

    def build_mesh(self):
        """Vertices (local), UVs, normals override mask, faces of the plate."""
        NI, NV = P.NAIL_NI, P.NAIL_NV
        Wv, Lv = self.Wv, self.Lv
        NJ = NV + 3
        A = np.zeros((NJ, NI))
        Yg = np.zeros((NJ, NI))
        A[1:NV + 1, 1:NI - 1] = self.A
        Yg[1:NV + 1, 1:NI - 1] = self.Y
        # rim UVs
        U = np.zeros((NJ, NI))
        V = np.zeros((NJ, NI))
        U[1:NV + 1, 1:NI - 1] = (self.A / Wv + 1.0) * 0.5
        # glTF flips v (v' = 1 - v): v' = 0 at the cuticle in the game
        V[1:NV + 1, 1:NI - 1] = (self.Y + Lv) / (2.0 * Lv)
        X = np.zeros((NJ, NI))
        Z = np.zeros((NJ, NI))
        Yo = np.zeros((NJ, NI))
        x, z = self.surf(A[1:NV + 1, 1:NI - 1], Yg[1:NV + 1, 1:NI - 1])
        X[1:NV + 1, 1:NI - 1], Z[1:NV + 1, 1:NI - 1], Yo[1:NV + 1, 1:NI - 1] = x, z, Yg[1:NV + 1, 1:NI - 1]
        T = P.NAIL_THICKNESS * Wv
        # folds cover the side skirt only up to the hyponychium; past it the
        # side skirt turns straight down into the free edge's thickness
        fold_w = smoothstep(self.y_hypo - P.FOLD_SIDE_END[0] * Lv, self.y_hypo + 0.2 * Lv, Yg[1:NV + 1, 1])
        ls = P.NAIL_SKIRT_SIDE * 2 * Wv
        for side, col, rim in ((-1, 0, 1), (1, NI - 1, NI - 2)):
            a_rim = A[1:NV + 1, rim]
            y_rim = Yg[1:NV + 1, rim]
            a_sk = a_rim + side * ls * fold_w * P.NAIL_SKIRT_OUT
            xs, zs = self.surf(a_sk, y_rim)
            zs = zs - P.NAIL_SKIRT_DROP * ls * fold_w - T * (1 - fold_w)
            X[1:NV + 1, col], Z[1:NV + 1, col], Yo[1:NV + 1, col] = xs, zs, y_rim
            A[1:NV + 1, col], Yg[1:NV + 1, col] = a_sk, y_rim
            U[1:NV + 1, col], V[1:NV + 1, col] = U[1:NV + 1, rim], V[1:NV + 1, rim]
        # cuticle skirt row: past the top row, along +y, dropping
        lc = P.NAIL_SKIRT_CUTICLE * 2 * Lv
        y_sk = Yg[1] + lc * P.NAIL_SKIRT_OUT
        xs, zs = self.surf(A[1], y_sk)
        X[0], Z[0], Yo[0] = xs, zs - P.NAIL_SKIRT_DROP * lc, y_sk
        A[0], Yg[0] = A[1], y_sk
        U[0], V[0] = U[1], V[1]
        # free edge: straight down by its thickness, then back under the plate
        for j, back, down in ((NV + 1, 0.25 * T, T), (NV + 2, P.NAIL_LIP_BACK * Lv, T * 1.15)):
            X[j], Yo[j], Z[j] = X[NV] * 0.985, Yo[NV] + back, Z[NV] - down
            A[j], Yg[j] = A[NV], Yg[NV]
            U[j], V[j] = U[NV], V[NV]
        # Blender local axes (x across, -out, toward the cuticle): the exporter's
        # Y-up conversion (x, y, z) -> (x, z, -y) makes them three's
        # (+X across, +Y toward the cuticle, +Z out).
        verts = np.stack([X, -Z, Yo], -1).reshape(-1, 3)
        uv = np.stack([U, V], -1).reshape(-1, 2)
        # analytic normals for the plate and its skirt; the free-edge row tilts out a little
        N = np.zeros((NJ, NI, 3))
        N[:NV + 1] = self.normal(A[:NV + 1], Yg[:NV + 1])
        N[NV] = N[NV] + np.array([0, -0.35, 0])
        N[NV] /= np.linalg.norm(N[NV], axis=-1, keepdims=True)
        N[NV + 1] = np.array([0, -1.0, -0.15])
        N[NV + 2] = np.array([0, 0.0, -1.0])
        N[NV + 1] = N[NV + 1] / np.linalg.norm(N[NV + 1], axis=-1, keepdims=True)
        faces = []
        idx = lambda j, i: j * NI + i  # noqa: E731
        mid = (NI - 1) / 2.0
        for j in range(NJ - 1):
            for i in range(NI - 1):
                a, b, c, d = idx(j, i), idx(j + 1, i), idx(j + 1, i + 1), idx(j, i + 1)
                # mirror the diagonal about the centre column (symmetric shading)
                if i < mid:
                    faces += [(a, b, c), (a, c, d)]
                else:
                    faces += [(a, b, d), (b, c, d)]
        self.grid_shape = (NJ, NI)
        N = N.reshape(-1, 3)
        return verts, uv, np.stack([N[:, 0], -N[:, 2], N[:, 1]], -1), faces


def _fit_old(points, frame):
    c, x, y, z = frame
    X = points - c
    lx, ly, lz = X @ x, X @ y, X @ z
    top = lz > np.median(lz)
    M = np.c_[np.ones(top.sum()), lx[top], ly[top], lx[top] ** 2, ly[top] ** 2]
    co = np.linalg.lstsq(M, lz[top], rcond=None)[0]
    return lx, ly, lz, co


def _skin_arrays(bm, mw, groups):
    deform = bm.verts.layers.deform.active
    n = len(bm.verts)
    co = np.array([tuple(mw @ v.co) for v in bm.verts])
    W = np.zeros((n, len(groups)))
    for v in bm.verts:
        for g, w in v[deform].items():
            if g < len(groups):
                W[v.index, g] = w
    return co, W


def build(scene, report, check):
    hand, rig = scene['hand'], scene['rig']
    mw = hand.matrix_world.copy()
    mwi = mw.inverted()
    groups = [g.name for g in hand.vertex_groups]
    gidx = {n: i for i, n in enumerate(groups)}
    skinP = gltfio.world_points(hand)
    me = hand.data
    Wsk = np.zeros((len(me.vertices), len(groups)))
    for v in me.vertices:
        for g in v.groups:
            Wsk[v.index, g.group] = g.weight

    plates = {}
    info = {}
    for f in FINGERS:
        old = scene['nails'][f]
        Q = gltfio.world_points(old)
        frame = gltfio.pca_frame(Q, rig, f)
        c, x, y, z = frame
        lx, ly, lz, co = _fit_old(Q, frame)
        length = ly.max() - ly.min()
        half_w = (lx.max() - lx.min()) / 2
        # fingertip: furthest skin of this finger along -y, on the top side, near the centre line
        fw = Wsk[:, [gidx[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) > 0.5
        S = skinP - c
        sx, sy, sz = S @ x, S @ y, S @ z
        sel = fw & (np.abs(sx - (lx.max() + lx.min()) / 2) < 0.35 * half_w) & (sz > -0.6 * half_w) & (sy < 0)
        y_tip = sy[sel].min() if sel.any() else ly.min()
        y_top_old = ly.max() - P.NAIL_CUTICLE_TRIM * length
        y_bot_old = y_tip - P.NAIL_FREE_EDGE_PAST_TIP * length  # a short, tidy free edge (the old plate overhung more)
        oy = (y_top_old + y_bot_old) / 2
        ox = (lx.max() + lx.min()) / 2
        Lv = (y_top_old - y_bot_old) / 2
        Wv = half_w * P.NAIL_WIDTH_SCALE
        # radius across from the fit (z = a + b x + c y + d x^2 + e y^2)
        R0 = -1.0 / (2.0 * co[3]) if co[3] < 0 else 0.1
        R0 = max(R0 * P.NAIL_RADIUS_SCALE, P.NAIL_RADIUS_MIN)
        # the plate sits on the finger (the old plate was a pillow above it):
        # skin height under the plate centre, plus the plate's own lift
        near = fw & (np.abs(sx - ox) < 0.3 * half_w) & (np.abs(sy - oy) < 0.3 * (ly.max() - ly.min()) / 2) & (sz > -0.6 * half_w)
        oz = (np.median(sz[near]) if near.sum() >= 3 else co[0]) + P.NAIL_LIFT * half_w
        centre = c + x * ox + y * oy + z * oz
        y_hypo = (y_tip - oy) + 0.08 * Lv
        plate = Plate(f, Wv, Lv, R0, P.NAIL_ARCH_RADIUS, y_hypo)
        plate.centre, plate.x, plate.y, plate.z = centre, x, y, z
        plates[f] = plate
        info[f] = {'half_len': round(Lv, 5), 'half_width_arc': round(Wv, 5), 'radius': round(R0, 4),
                   'overhang': round(y_hypo + Lv, 5), 'old_len': round(length, 5)}

    # ---- new plate objects -------------------------------------------------------
    for f, plate in plates.items():
        old = scene['nails'][f]
        verts, uv, normals, faces = plate.build_mesh()
        mesh = bpy.data.meshes.new('Nail_' + f.capitalize())
        mesh.from_pydata([tuple(v) for v in verts], [], faces)
        mesh.update()
        uvl = mesh.uv_layers.new(name='UVMap')
        loop_v = np.empty(len(mesh.loops), dtype=np.int64)
        mesh.loops.foreach_get('vertex_index', loop_v)
        uvl.data.foreach_set('uv', uv[loop_v].astype(np.float32).ravel())
        mesh.shade_smooth()
        mesh.normals_split_custom_set_from_vertices([tuple(n) for n in normals])
        if old.data.materials:
            mesh.materials.append(old.data.materials[0])
        name = old.name
        bpy.data.objects.remove(old, do_unlink=True)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = rig
        obj.parent_type = 'BONE'
        obj.parent_bone = f + '.03'
        bpy.context.view_layer.update()
        M = Matrix((
            (plate.x[0], -plate.z[0], plate.y[0], plate.centre[0]),
            (plate.x[1], -plate.z[1], plate.y[1], plate.centre[1]),
            (plate.x[2], -plate.z[2], plate.y[2], plate.centre[2]),
            (0, 0, 0, 1)))
        obj.matrix_world = M
        bpy.context.view_layer.update()
        chord = float(plate.R0 * np.sin(plate.Wv / plate.R0))
        obj['nailFrame'] = 1
        obj['nailHalf'] = [float(plate.Lv), chord]
        # natural-nail shader: [s of the hyponychium line, cuticle arc, free-edge arc, 0]
        # (s = y / half length, +1 at the cuticle; arcs in s per w^2)
        obj['nailAnat'] = [float(plate.y_hypo / plate.Lv), float(P.NAIL_CUTICLE_ARC * plate.Wv / plate.Lv),
                           float(P.NAIL_FREE_ARC * plate.Wv / plate.Lv), 0.0]
        scene['nails'][f] = obj
        plate.obj = obj
        nv = len(mesh.vertices)
        check(f'{f}: plate verts <= {P.CAP_NAIL_VERTS}', nv <= P.CAP_NAIL_VERTS, nv, P.CAP_NAIL_VERTS)
        err = (np.array(obj.matrix_world) - np.array(M)).max()
        check(f'{f}: plate frame placed (canonical, unit scale)', abs(err) < 1e-4, float('%.1e' % abs(err)))
        u_ok = uv.min() >= -1e-6 and uv.max() <= 1 + 1e-6
        check(f'{f}: UVs inside [0, 1]', u_ok, [round(float(uv.min()), 4), round(float(uv.max()), 4)])

    # ---- skin: subdivide around the outlines, then displace -----------------------
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    n0 = len(bm.verts)

    def local(co, plate):
        S = co - plate.centre
        lx, ly, lz = S @ plate.x, S @ plate.y, S @ plate.z
        a = plate.a_of_x(lx, ly)
        return a, ly, lz

    co, W = _skin_arrays(bm, mw, groups)
    # two passes of one cut: a wide band around the outline (where the folds
    # move the skin at all), then a narrow one right at it (where skin meets plate)
    for band in P.FOLD_BANDS:
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        co, W = _skin_arrays(bm, mw, groups)
        to_cut = set()
        for f, plate in plates.items():
            fw = W[:, [gidx[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) > 0.5
            a, ly, lz = local(co, plate)
            d = plate.signed_distance(a, ly) - P.FOLD_SHIFT * plate.Wv  # the fold profile is laid out from just outside the rim
            _, zp = plate.surf(a, ly)
            ok = fw & (lz > zp - P.FOLD_TOP_ONLY[1] * plate.Wv) & (ly > plate.y_hypo - 0.25 * plate.Lv)
            lo, hi = band[0] * plate.Wv, band[1] * plate.Wv
            # edges whose span of signed distance meets the band (the scan
            # mesh is coarse at the cuticle: whole faces would be too many)
            for e in bm.edges:
                i, j = e.verts[0].index, e.verts[1].index
                if not (fw[i] and fw[j]) or not (ok[i] or ok[j]):
                    continue
                if min(d[i], d[j]) < hi and max(d[i], d[j]) > lo:
                    to_cut.add(e)
        if to_cut:
            bmesh.ops.subdivide_edges(bm, edges=list(to_cut), cuts=1, use_grid_fill=True)
            bmesh.ops.triangulate(bm, faces=[fc for fc in bm.faces if len(fc.verts) > 3])
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    added = len(bm.verts) - n0

    co, W = _skin_arrays(bm, mw, groups)
    new = co.copy()
    rigid = np.zeros(len(co), dtype=bool)
    rigid_of = np.full(len(co), -1)
    for fi, (f, plate) in enumerate(plates.items()):
        fw = W[:, [gidx[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) > 0.5
        a, ly, lz = local(co, plate)
        d = plate.signed_distance(a, ly) - P.FOLD_SHIFT * plate.Wv  # the fold profile is laid out from just outside the rim
        xp, zp = plate.surf(a, ly)
        Wv, Lv = plate.Wv, plate.Lv
        top = 1.0 - smoothstep(P.FOLD_TOP_ONLY[0] * Wv, P.FOLD_TOP_ONLY[1] * Wv, zp - lz)
        top = np.where(fw, top, 0.0)
        # one continuous profile across the outline (so the line where skin
        # meets plate is interpolated, never a staircase of mesh edges):
        # outside it rises to the fold height; inside it drops below the plate
        # (the bed), and under the free edge into a growing gap.
        prox = smoothstep(0.35 * Lv, 0.85 * Lv, ly)
        h = (P.FOLD_HEIGHT_PROX * prox + P.FOLD_HEIGHT_SIDE * (1 - prox)) * Wv
        fold_on = smoothstep(plate.y_hypo - P.FOLD_SIDE_END[0] * Lv, plate.y_hypo + P.FOLD_SIDE_END[1] * Lv, ly)
        over = np.clip((plate.y_hypo - ly) / max(1e-6, plate.y_hypo + Lv), 0, None)
        floor = -P.BED_DEPTH * Wv - P.HYPO_GAP * over * 2 * Lv
        edge = h * P.FOLD_EDGE
        # inside the outline the skin drops through the plate a little way in
        # (FOLD_COVER): the fold always overlaps the plate's rim, never lets
        # the rim or the skirt show through between two skin vertices
        slope = edge / (P.FOLD_COVER * Wv)
        t = np.clip(d / (P.FOLD_WIDTH * Wv), 0, 1)
        f_out = h * (P.FOLD_EDGE + (1 - P.FOLD_EDGE) * smoothstep(0.0, 0.35, t)) * fold_on
        f_in = np.maximum(fold_on * (edge + slope * d) + (1 - fold_on) * floor, floor)
        inside = d < 0
        # near the outline the skin follows the profile both ways (the fold
        # wall is continuous even where the old skin sat far below the
        # plate); deeper inside it only ever sinks
        z_in = np.where(f_in > floor + 1e-9, zp + f_in, np.minimum(lz, zp + floor))
        wb = (1.0 - smoothstep(0.35, 1.0, t)) * fold_on
        z_out = lz + (zp + f_out - lz) * wb
        z_new = np.where(inside, z_in, z_out)
        z_new = lz + (z_new - lz) * top
        moved = fw & (np.abs(z_new - lz) > 0)
        new[moved] = co[moved] + np.outer(z_new[moved] - lz[moved], plate.z)
        # rigid region: within RIGID_REACH half lengths of the plate, this finger only
        dz = lz - zp
        reach = np.sqrt(np.maximum(d, 0) ** 2 + np.where(dz < 0, dz, 0) ** 2)
        r = fw & (reach <= P.RIGID_REACH * Lv) & (ly > -Lv - 0.5 * Lv) & (ly < Lv + P.RIGID_REACH * Lv)
        rigid |= r
        rigid_of[r] = fi

    deform = bm.verts.layers.deform.active
    for v in bm.verts:
        p = new[v.index]
        v.co = mwi @ Vector(p)
        if rigid[v.index]:
            f = list(plates.keys())[rigid_of[v.index]]
            dv = v[deform]
            dv.clear()
            dv[gidx[f + '.03']] = 1.0
    bm.to_mesh(me)
    bm.free()
    if 'custom_normal' in me.attributes:
        me.attributes.remove(me.attributes['custom_normal'])
    me.shade_smooth()
    me.update()

    # ---- checks -----------------------------------------------------------------
    skinP = gltfio.world_points(hand)
    polys = [tuple(p.vertices) for p in me.polygons]
    bvh = BVHTree.FromPolygons([tuple(p) for p in skinP], polys)
    W = np.zeros((len(me.vertices), len(groups)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    wsum = W.sum(1)
    check('skin weights sum to 1', np.abs(wsum - 1).max() < 1e-3, round(float(np.abs(wsum - 1).max()), 5), '< 1e-3')
    for f, plate in plates.items():
        NJ, NI = plate.grid_shape
        Q = gltfio.world_points(plate.obj)
        bad = 0
        tested = 0
        for j in range(2, P.NAIL_NV):
            for i in range(2, NI - 2):
                p = Vector(Q[j * NI + i])
                n = Vector(plate.z)
                tested += 1
                hit = bvh.ray_cast(p + n * 0.05, -n, 0.05 - 2e-4)
                if hit[0] is not None:
                    bad += 1
        check(f'{f}: no visible plate vert under the skin', bad == 0, f'{bad}/{tested}')
        fw = W[:, [gidx[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) > 0.5
        S = skinP - plate.centre
        lx, ly, lz = S @ plate.x, S @ plate.y, S @ plate.z
        a = plate.a_of_x(lx, ly)
        d = plate.signed_distance(a, ly)
        _, zp = plate.surf(a, ly)
        dz = lz - zp
        reach = np.sqrt(np.maximum(d, 0) ** 2 + np.where(dz < 0, dz, 0) ** 2)
        near = fw & (reach <= P.RIGID_REACH * plate.Lv) & (ly > -1.5 * plate.Lv) & (ly < (1 + P.RIGID_REACH) * plate.Lv)
        w3 = W[near, gidx[f + '.03']]
        check(f'{f}: skin near the plate rides on {f}.03 only', bool((w3 > 0.999).all()), f'{int((w3 > 0.999).sum())}/{int(near.sum())}')
    report['nails'] = info
    scene['plates'] = plates
    report['counts']['skin_subdiv_added'] = added
