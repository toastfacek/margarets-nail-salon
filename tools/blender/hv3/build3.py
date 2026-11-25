"""Build the hv3 hand GLB from the anatomical SDF (tools/blender/hv3/).

Run (Blender 5.3 as a Python module, headless, no network):
    /home/claude/bpyenv/bin/python tools/blender/hv3/build3.py [--game] [--out=path.glb]

Pipeline:
  SDF (hand.py) -> surface nets at 0.67 mm (cached) -> Blender collapse
  decimation to the skin budget -> every vertex projected back onto the
  SDF's zero set -> smart UV islands -> the detail map (per texel: the
  creases' and folds' normal from the full SDF, relative to the game mesh's
  smooth normal, in the game shader's tangent convention; B = cavity) ->
  weights and masks (rig3.py) -> placement in the game's world (place.py) ->
  17 bones on the anatomical joints -> five rigid nail plates on the .03 bones
  (canonical frame, extras, UVs; with --viewer default: free-edge morph stops
  in mm) -> GLB -> checks (the hv2 rig checks at every limit pose included).
Exit code 1 when a check fails.
"""
import hashlib
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.dirname(HERE))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import hand as H  # noqa: E402
import mesher  # noqa: E402
import nails3  # noqa: E402
import place  # noqa: E402
import rig3  # noqa: E402
import skeleton as SK  # noqa: E402

FINGERS = SK.FINGERS
BONES = rig3.BONES
PARENT = {'wrist': None, 'palm': 'wrist'}
for _f in FINGERS:
    PARENT[_f + '.01'] = 'palm'
    PARENT[_f + '.02'] = _f + '.01'
    PARENT[_f + '.03'] = _f + '.02'

TARGET_VERTS = 11000          # after decimation; UV seams add the rest (cap 14,000)
CAP_SKIN_VERTS = 14000
CAP_GLB_BYTES = 1_300_000     # the game variant, before quantisation
MAP_SIZE = 1024
MAP_SCALE = 2.5               # the shader's uDetailScale (stored slope x this)
MAP_CAVITY_MM = 0.40          # a groove this deep is full cavity (B)
FREE_STOPS_MM = (0.5, 1.5, 2.5, 4.0, 6.0, 9.0)
FREE_DEFAULT_MM = 2.5
PLATE_COLS, PLATE_ROWS = 13, 22


def parse_args(argv):
    flags = {}
    for a in argv:
        if a.startswith('--'):
            k, _, v = a[2:].partition('=')
            flags[k] = v if v else True
    return flags


# ---- geometry ------------------------------------------------------------------------
def mid_mesh(hand, cache):
    if cache and os.path.exists(cache):
        d = np.load(cache)
        return d['V'].astype(np.float64), d['Q']
    import make_mesh
    lo, hi = make_mesh.bbox(hand)
    V, Q = mesher.surface_nets(hand.eval, lo, hi, h0=2.0, r=3)
    if cache:
        np.savez_compressed(cache, V=V.astype(np.float32), Q=Q.astype(np.int32))
    return V, Q


def clamp_under_plates(hand, V, margin=0.15):
    """The decimated skin can cut through the nail plate where its triangles
    span the groove: every skin vertex inside a plate's visible outline is
    pushed down to just under the plate's underside (no skin poking through
    the plate, no z-fighting)."""
    V = V.copy()
    total = 0
    for f in FINGERS:
        nu = hand.nails[f]
        q = V - nu.o
        x, y, z = q @ nu.U, q @ nu.F, q @ nu.W
        o = np.maximum(np.abs(x) - nu.hw(y), nu.cuticle_y(x) - y)
        floor = nu.z_top(x, y) - nails3.T - margin
        # past the hyponychium the pulp's sides, just outside the outline,
        # also stay under the plate's edge (no skin sliver over a long free edge)
        reach = 0.05 + 1.2 * nails3.smoothstep(nu.yh - 1.0, nu.yh + 0.5, y)
        sel = (o < reach) & (y < nu.yh + FREE_STOPS_MM[-1]) & (z > floor) & (z < floor + 4.0)
        V[sel] -= nu.W * (z[sel] - floor[sel])[:, None]
        total += int(sel.sum())
    return V, total


def make_mesh_obj(name, V, F):
    me = bpy.data.meshes.new(name)
    me.from_pydata(V.tolist(), [], F.tolist())
    me.update()
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def activate(ob):
    for o in bpy.context.view_layer.objects:
        o.select_set(o == ob)
    bpy.context.view_layer.objects.active = ob


def mesh_arrays(me):
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', V)
    tris = []
    for p in me.polygons:
        vs = list(p.vertices)
        for k in range(1, len(vs) - 1):
            tris.append((vs[0], vs[k], vs[k + 1]))
    return V.reshape(-1, 3), np.array(tris, dtype=np.int64)


def decimate(ob, target, hand=None):
    me = ob.data
    ratio = target / len(me.vertices)
    activate(ob)
    m = ob.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = True
    if hand is not None:
        # spend the budget where it shows: the nail folds and fingertips keep
        # more vertices, the long forearm (out of shot, under the desk) fewer
        V = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get('co', V)
        V = V.reshape(-1, 3)
        w0 = hand.info['forearm']['wrist_s']
        _, loc = hand.forearm(V, local=True)
        near = np.zeros(len(V))
        for f in FINGERS:
            nu = hand.nails[f]
            dd = np.linalg.norm(V - (nu.o + nu.F * 0.5 * (nu.yc + nu.yh)), axis=1)
            near = np.maximum(near, np.clip((16.0 - dd) / 8.0, 0, 1))
        arm = np.clip((loc['s'] - (w0 + 15.0)) / 30.0, 0, 1)
        dw = np.clip(0.5 - 0.45 * near + 0.45 * arm, 0, 1)
        g = ob.vertex_groups.new(name='decimate')
        for i in range(len(V)):
            g.add([i], float(dw[i]), 'REPLACE')
        m.vertex_group = 'decimate'
        m.vertex_group_factor = 1.0
    bpy.ops.object.modifier_apply(modifier='dec')
    if hand is not None:
        ob.vertex_groups.remove(ob.vertex_groups['decimate'])


def smart_uv(ob):
    activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(72.0), island_margin=0.006, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def loop_uvs(me):
    U = np.empty(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', U)
    return U.reshape(-1, 2)


# ---- the detail map ----------------------------------------------------------------------
def detail_map(me, V, Nv, hand_full, hand_plain, out_dir, report, check):
    import maps as MP
    U = loop_uvs(me)
    pix, Pw, N, _, dPdu, dPdv = MP._rasterise(me, U, V, Nv, np.zeros(len(V)), MAP_SIZE)
    # the full surface (creases, folds) near each texel: Newton steps along the gradient
    Ph = mesher.project(hand_full.eval, Pw.copy(), 0.25, iters=3)
    g = mesher.gradient(hand_full.eval, Ph, 0.05)
    nh = g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-12)
    # perturbation in the tangent plane: Nd = normalize(N + p), p = nh / (nh.N) - N
    dn = np.sum(nh * N, 1)
    p = nh / np.maximum(dn, 0.2)[:, None] - N
    T = dPdu / np.maximum(np.linalg.norm(dPdu, axis=1, keepdims=True), 1e-12)
    B = dPdv / np.maximum(np.linalg.norm(dPdv, axis=1, keepdims=True), 1e-12)
    T = T - N * np.sum(T * N, 1)[:, None]
    B = B - N * np.sum(B * N, 1)[:, None]
    T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    B /= np.maximum(np.linalg.norm(B, axis=1, keepdims=True), 1e-12)
    tb = np.sum(T * B, 1)
    pt, pb = np.sum(p * T, 1), np.sum(p * B, 1)
    det = np.maximum(1 - tb * tb, 1e-4)
    cT = (pt - tb * pb) / det
    cB = (pb - tb * pt) / det
    # cavity: how far the creases and folds sink the full surface under the plain one
    depth = mesher._eval(hand_plain.eval, Ph)
    cav = np.clip(-depth / MAP_CAVITY_MM, 0, 1)
    img = np.zeros((MAP_SIZE, MAP_SIZE, 4))
    img[..., 0] = 0.5
    img[..., 1] = 0.5
    img[..., 3] = 1.0
    vals = np.stack([np.clip(cT * MAP_SCALE * 0.5 + 0.5, 0, 1), np.clip(cB * MAP_SCALE * 0.5 + 0.5, 0, 1), cav, np.ones(len(cav))], 1)
    img[pix[:, 1], pix[:, 0]] = vals
    valid = np.zeros((MAP_SIZE, MAP_SIZE), dtype=bool)
    valid[pix[:, 1], pix[:, 0]] = True
    img, valid = MP._dilate(img, valid, 8)
    img[~valid] = (0.5, 0.5, 0.0, 1.0)
    paths = {}
    for fmt, ext in (('PNG', 'png'), ('WEBP', 'webp')):
        im = bpy.data.images.new('skin-detail-' + ext, MAP_SIZE, MAP_SIZE, alpha=False, float_buffer=False)
        im.colorspace_settings.name = 'Non-Color'
        im.pixels.foreach_set(img.astype(np.float32).ravel())
        path = os.path.join(out_dir, 'skin-detail-v3.' + ext)
        im.filepath_raw = path
        im.file_format = fmt
        if fmt == 'WEBP':
            st = bpy.context.scene.render.image_settings
            st.file_format = 'WEBP'
            st.quality = 90
            st.color_mode = 'RGB'
            im.save_render(path)
        else:
            im.save()
        paths[ext] = path
        bpy.data.images.remove(im)
    tilt = np.degrees(np.arctan(np.hypot(cT, cB)))
    report['detail_map'] = {'texels': int(len(pix)), 'bytes': {k: os.path.getsize(v) for k, v in paths.items()},
                            'tilt_deg_p50_p99_max': [round(float(np.percentile(tilt, q)), 1) for q in (50, 99)] + [round(float(tilt.max()), 1)],
                            'cavity_p99': round(float(np.percentile(cav, 99)), 3)}
    check('maps: the skin covers its UV square (texels set)', len(pix) > 0.3 * MAP_SIZE * MAP_SIZE, round(len(pix) / MAP_SIZE ** 2, 3))
    check('maps: detail map (WebP) <= 260 KB', os.path.getsize(paths['webp']) <= 260 * 1024, os.path.getsize(paths['webp']))
    return paths


# ---- the rig ------------------------------------------------------------------------------
def bone_points(hand):
    """(head, tail) per bone, hand frame mm."""
    sk = hand.sk
    out = {}
    fa = hand.forearm
    w0 = hand.info['forearm']['wrist_s']
    k = int(np.searchsorted(fa.s, w0 + 60.0))
    palm_head = np.array([0.0, 8.0, -1.0])        # the capitate's head: the hand's flexion centre
    out['wrist'] = (fa.p[k], palm_head)
    out['palm'] = (palm_head, sk['middle']['joints'][0])
    for f in FINGERS:
        J = sk[f]['joints']
        tip = J[3] + sk[f]['frames'][2][0] * SK.TIP_EXT[f]
        heads = [J[0], J[1], J[2]]
        tails = [J[1], J[2], tip]
        for i in range(3):
            out[f'{f}.0{i + 1}'] = (heads[i], tails[i])
    return out


def make_rig(bp_game, nail_n_game):
    arm = bpy.data.armatures.new('Hand_Rig')
    rig = bpy.data.objects.new('Hand_Rig', arm)
    bpy.context.scene.collection.objects.link(rig)
    activate(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    made = {}
    for b in BONES:
        h, t = bp_game[b]
        e = eb.new(b)
        e.head, e.tail = Vector(h), Vector(t)
        if PARENT[b]:
            e.parent = made[PARENT[b]]
            e.use_connect = b.endswith('.02') or b.endswith('.03')
        n = np.asarray(nail_n_game['middle' if b in ('wrist', 'palm') else b.split('.')[0]])
        d = np.array(e.tail - e.head)
        d /= np.linalg.norm(d)
        palm_side = -(n - d * (n @ d))
        e.align_roll(Vector(palm_side / np.linalg.norm(palm_side)))
        made[b] = e
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# ---- nails -----------------------------------------------------------------------------------
def plate_geometry(nu, free, cols=PLATE_COLS, rows=PLATE_ROWS):
    """A closed plate in the nail's own coordinates (x across, y along the
    bone from the joint, z out): top grid, underside grid, and a rim of its
    own vertices (flat shaded). Returns V, faces, smooth flags, uv, the top's
    visible extent."""
    hw_t = lambda y: nu.hw(y) + nails3.TUCK_SIDE * (1 - nails3.smoothstep(nu.yh - 2.5, nu.yh, y))  # noqa: E731
    us = np.linspace(-1, 1, cols)
    vs = np.linspace(0, 1, rows)
    top = np.zeros((rows, cols, 3))
    for j, v in enumerate(vs):
        for i, u in enumerate(us):
            xg = u * nu.hw0
            y0 = nu.cuticle_y(xg) - nails3.TUCK_PROX
            y1 = nu.free_y(xg, free)
            y = y0 + (y1 - y0) * v
            x = u * hw_t(y)
            top[j, i] = (x, y, nu.z_top(x, y))
    bot = top.copy()
    bot[..., 2] -= nails3.T
    # thin the free edge's underside a little toward the tip (a real plate thins)
    past = np.clip((bot[..., 1] - nu.yh) / max(free, 0.5), 0, 1)
    bot[..., 2] += 0.15 * past
    n = rows * cols
    idx = np.arange(n).reshape(rows, cols)
    ring = [idx[0, i] for i in range(cols)] + [idx[j, -1] for j in range(1, rows)] + \
           [idx[-1, i] for i in range(cols - 2, -1, -1)] + [idx[j, 0] for j in range(rows - 2, 0, -1)]
    TV, BV = top.reshape(-1, 3), bot.reshape(-1, 3)
    RV = np.concatenate([TV[ring], BV[ring]])
    V = np.concatenate([TV, BV, RV])
    F, smooth = [], []
    for j in range(rows - 1):
        for i in range(cols - 1):
            a, b, c, d = idx[j, i], idx[j, i + 1], idx[j + 1, i + 1], idx[j + 1, i]
            F.append((a, d, c, b))
            smooth.append(True)
            F.append((a + n, b + n, c + n, d + n))
            smooth.append(True)
    m = len(ring)
    r0 = 2 * n
    for k in range(m):
        a, b = r0 + k, r0 + (k + 1) % m
        F.append((a, b, b + m, a + m))
        smooth.append(False)
    # UV: the visible top in [0, 1]; u across, v = 1 at the cuticle .. 0 at the free tip
    y_tip = nu.yh + free
    def uv_of(P):
        u = np.clip((P[:, 0] / nu.hw0 + 1) * 0.5, 0, 1)
        v = np.clip((y_tip - P[:, 1]) / (y_tip - nu.yc), 0, 1)
        return np.stack([u, v], 1)
    UV = uv_of(V)
    return V, F, smooth, UV, y_tip


def nail_frame(nu, free):
    """Canonical frame (hand frame mm): origin at the visible plate's centre
    on its surface; +Y toward the cuticle, +Z out, +X = Y x Z."""
    y_tip = nu.yh + free
    cy = 0.5 * (nu.yc + y_tip)
    cz = float(nu.z_top(0.0, cy))
    o = nu.o + nu.F * cy + nu.W * cz
    Y = -nu.F
    Z = nu.W
    X = np.cross(Y, Z)
    half = 0.5 * (y_tip - nu.yc)
    return o, X, Y, Z, cy, cz, half


def to_frame(nu, Vn, frame):
    o, X, Y, Z = frame[:4]
    Ph = nu.o + Vn[:, 0:1] * nu.U + Vn[:, 1:2] * nu.F + Vn[:, 2:3] * nu.W
    q = Ph - o
    return np.stack([q @ X, q @ Y, q @ Z], 1)


def build_nail(f, nu, T, rig, morph):
    s = T['s']
    fr = nail_frame(nu, FREE_DEFAULT_MM)
    o, X, Y, Z, cy, cz, half = fr
    stops = FREE_STOPS_MM if morph else (FREE_DEFAULT_MM,)
    built = [plate_geometry(nu, L) for L in stops]
    F, smooth = built[0][1], built[0][2]
    loc = [to_frame(nu, b[0], fr) * s for b in built]
    base = loc[0]
    UV = built[0][3]
    if not morph:
        UV = built[0][3]
    mesh = bpy.data.meshes.new('Nail_' + f.capitalize())
    # Blender local (x, -z, y): the exporter's Y-up turns it into three's +X across, +Y to the cuticle, +Z out
    mesh.from_pydata([(v[0], -v[2], v[1]) for v in base], [], F)
    mesh.update()
    mesh.polygons.foreach_set('use_smooth', np.array(smooth, dtype=bool))
    uvl = mesh.uv_layers.new(name='UVMap')
    lv = np.empty(len(mesh.loops), dtype=np.int64)
    mesh.loops.foreach_get('vertex_index', lv)
    uvl.data.foreach_set('uv', UV[lv].astype(np.float32).ravel())
    obj = bpy.data.objects.new('Nail_' + f.capitalize(), mesh)
    bpy.context.scene.collection.objects.link(obj)
    if morph:
        obj.shape_key_add(name='Basis')
        for L, kv in zip(stops[1:], loc[1:]):
            sk = obj.shape_key_add(name='L%03d' % round(L * 10))
            sk.data.foreach_set('co', np.array([(v[0], -v[2], v[1]) for v in kv], dtype=np.float32).ravel())
    Rg = T['R']
    og = place.apply(T, o[None])[0]
    Xg, Yg, Zg = Rg @ X, Rg @ Y, Rg @ Z
    M = Matrix(((Xg[0], -Zg[0], Yg[0], og[0]), (Xg[1], -Zg[1], Yg[1], og[1]), (Xg[2], -Zg[2], Yg[2], og[2]), (0, 0, 0, 1)))
    obj.parent = rig
    obj.parent_type = 'BONE'
    obj.parent_bone = f + '.03'
    bpy.context.view_layer.update()
    obj.matrix_world = M
    bpy.context.view_layer.update()
    sag = nails3.CUT_ARC * nu.hw0
    def d_tip(L):
        return min(L + 0.8, nu.hw(nu.yh + L) * 0.75)
    obj['nailFrame'] = 1
    obj['nailHalf'] = [float(half * s), float(nu.hw0 * s)]
    obj['nailAnat'] = [float((cy - nu.yh) / half), float(sag / half), float(d_tip(FREE_DEFAULT_MM) / half), 0.0]
    if morph:
        # frame-centre and half length of each stop, in this frame (Y toward the cuticle)
        cys = [((cy - 0.5 * (nu.yc + nu.yh + L))) * s for L in stops]
        halves = [0.5 * (nu.yh + L - nu.yc) * s for L in stops]
        obj['nailVar'] = {'L': [float(L) for L in stops], 'def': float(FREE_DEFAULT_MM), 'mm': [float(L) for L in stops],
                          'cy': [float(c) for c in cys], 'half': [float(h) for h in halves],
                          'freeArc': [float(d_tip(L) * s) for L in stops],
                          'hypoY': float((cy - nu.yh) * s), 'cutArc': float(sag * s)}
    return obj, Zg, UV


def export(objs, rig, path, morph):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [rig] + objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=False, export_extras=True, export_draco_mesh_compression_enable=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=True, export_attributes=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='NONE', export_image_format='NONE', export_skins=True,
        export_morph=morph, export_morph_normal=True, export_def_bones=False,
        export_hierarchy_flatten_bones=False, export_apply=False)


def glb_counts(path):
    import struct
    with open(path, 'rb') as fh:
        b = fh.read()
    jlen = struct.unpack_from('<I', b, 12)[0]
    J = json.loads(b[20:20 + jlen])
    out = {}
    for m in J['meshes']:
        pr = m['primitives'][0]
        out[m['name']] = J['accessors'][pr['attributes']['POSITION']]['count']
    return out


def main():
    flags = parse_args(sys.argv[1:])
    morph = not flags.get('game')
    out_dir = os.path.join(os.path.dirname(HERE), 'out')
    os.makedirs(out_dir, exist_ok=True)
    out_glb = flags.get('out') or os.path.join(out_dir, 'hand-v3-game.glb' if not morph else 'hand-v3-viewer.glb')
    t0 = time.time()
    report = {'checks': [], 'counts': {}}

    def check(name, ok, value=None, gate=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'value': value, 'gate': gate})
        print(('PASS ' if ok else 'FAIL ') + name + ('' if value is None else f'  value={value}') + ('' if gate is None else f'  gate={gate}'))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    hand_plain = H.Hand(detail=False)            # the game mesh's surface (forms, nail grooves, folds)
    hand_full = H.Hand(detail=True)              # + creases (the detail map)
    T = place.solve(hand_plain)
    report['placement'] = {'mm_per_unit': round(T['mm_per_unit'], 2), 'resid_mm': {k: round(v * T['mm_per_unit'], 1) for k, v in T['resid'].items()}}
    drop, _ = place.forearm_drop(T)
    report['placement']['forearm_drop_v1_deg'] = round(drop, 1)
    report['placement']['forearm_drop_hv3_deg'] = SK.FOREARM_DROP

    # 1. the game mesh
    Vm, Qm = mid_mesh(hand_plain, flags.get('cache') or os.path.join(out_dir, 'hv3-mid.npz'))
    ob = make_mesh_obj('Hand', Vm, Qm)
    decimate(ob, TARGET_VERTS, hand_plain)
    V, F = mesh_arrays(ob.data)
    V = mesher.project(hand_plain.eval, V, 0.6, iters=3)
    V, n_clamped = clamp_under_plates(hand_plain, V)
    report['counts']['skin_verts_pushed_under_plates'] = n_clamped
    ob.data.vertices.foreach_set('co', V.ravel())
    ob.data.update()
    ob.data.shade_smooth()
    report['counts']['decimated_verts'] = len(V)
    report['counts']['tris'] = len(F)
    # 2. UVs and the detail map (hand frame, mm)
    smart_uv(ob)
    Nv = rig3.vertex_normals(V, F)
    if not flags.get('nomap'):
        detail_map(ob.data, V, Nv, hand_full, hand_plain, out_dir, report, check)
    # 3. weights and masks
    W = rig3.weights(hand_plain, V, F)
    col = rig3.masks(hand_plain, V, F, Nv)
    # 4. into the game's world
    Vg = place.apply(T, V)
    ob.data.vertices.foreach_set('co', Vg.ravel())
    ob.data.update()
    for b in BONES:
        g = ob.vertex_groups.new(name=b)
        c = W[:, rig3.BI[b]]
        for i in np.nonzero(c > 0)[0]:
            g.add([int(i)], float(c[i]), 'REPLACE')
    me = ob.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    attr.data.foreach_set('color', col.astype(np.float32).ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find('Col')
    nail_n = {f: T['R'] @ hand_plain.nails[f].W for f in FINGERS}
    bp = {b: (place.apply(T, h[None])[0], place.apply(T, t[None])[0]) for b, (h, t) in bone_points(hand_plain).items()}
    rig = make_rig(bp, nail_n)
    ob.parent = rig
    md = ob.modifiers.new('Armature', 'ARMATURE')
    md.object = rig
    # 5. nails
    nails = {}
    for f in FINGERS:
        o, Zg, UVn = build_nail(f, hand_plain.nails[f], T, rig, morph)
        nails[f] = o
        check(f'{f}: nail UVs inside [0, 1]', UVn.min() >= 0 and UVn.max() <= 1)
    # 6. checks: the hv2 rig checks (limit poses, flips, joint sections, thenar web)
    import rig as RG
    scene = {'hand': ob, 'rig': rig, 'nails': nails, 'nail_normal': nail_n}
    RG.checks(scene, report, check)
    # 7. export
    export([ob] + list(nails.values()), rig, out_glb, morph)
    size = os.path.getsize(out_glb)
    with open(out_glb, 'rb') as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    counts = glb_counts(out_glb)
    report['output'] = {'path': os.path.relpath(out_glb, ROOT), 'bytes': size, 'sha256': sha, 'glb_vertex_counts': counts}
    skin_v = counts.get('Hand', 0)
    check('skin vertices after UV seams <= %d' % CAP_SKIN_VERTS, 0 < skin_v <= CAP_SKIN_VERTS, skin_v, CAP_SKIN_VERTS)
    if not morph:
        check('game GLB <= %d bytes' % CAP_GLB_BYTES, size <= CAP_GLB_BYTES, size, CAP_GLB_BYTES)
    report['seconds'] = round(time.time() - t0, 1)
    with open(os.path.join(out_dir, 'report-v3%s.json' % ('' if morph else '-game')), 'w') as fh:
        json.dump(report, fh, indent=1, default=float)
    failed = [c for c in report['checks'] if not c['pass']]
    print(f'{len(report["checks"]) - len(failed)}/{len(report["checks"])} checks pass; {size} bytes; skin {skin_v} verts; {report["seconds"]} s')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
