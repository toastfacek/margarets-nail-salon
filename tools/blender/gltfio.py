"""glTF import / export for the hand pipeline, and the round-trip checks."""
import bpy
import mathutils
import numpy as np

import params as P

FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']
NAIL_NAMES = {f: 'Nail_' + f.capitalize() for f in FINGERS}
BONES = ['wrist', 'palm'] + [f'{f}.0{i}' for f in FINGERS for i in (1, 2, 3)]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(path):
    """Import the source GLB. Returns {'hand', 'rig', 'nails': {finger: obj}}."""
    reset()
    bpy.ops.import_scene.gltf(filepath=path)
    # The importer leaves a stray bone-shape object: drop it.
    for o in list(bpy.data.objects):
        if o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o, do_unlink=True)
    hand = bpy.data.objects['Hand']
    rig = bpy.data.objects['Hand_Rig']
    nails = {f: bpy.data.objects[NAIL_NAMES[f]] for f in FINGERS}
    return {'hand': hand, 'rig': rig, 'nails': nails}


def counts(hand, nails):
    sv = len(hand.data.vertices)
    st = sum(len(p.vertices) - 2 for p in hand.data.polygons)
    nv = sum(len(n.data.vertices) for n in nails.values())
    nt = sum(sum(len(p.vertices) - 2 for p in n.data.polygons) for n in nails.values())
    return {'skin_verts': sv, 'skin_tris': st, 'nail_verts': nv, 'nail_tris': nt,
            'total_verts': sv + nv, 'total_tris': st + nt}


def world_points(obj):
    mw = obj.matrix_world
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    m = np.array(mw)
    return co @ m[:3, :3].T + m[:3, 3]


def export(scene, path):
    bpy.ops.object.select_all(action='DESELECT')
    objs = [scene['rig'], scene['hand']] + list(scene['nails'].values())
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = scene['rig']
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_animations=False,
        export_extras=True,
        export_draco_mesh_compression_enable=False,
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=True,
        export_attributes=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials='EXPORT',
        export_image_format='NONE',
        export_skins=True,
        export_morph=False,
        export_def_bones=False,
        export_hierarchy_flatten_bones=False,
        export_apply=False,
    )


def verify_export(path, scene, report, check):
    """Re-import the written file and compare it with what we meant to write."""
    want = {'hand': world_points(scene['hand'])}
    for f, o in scene['nails'].items():
        want[f] = world_points(o)
    want_colors = None
    me = scene['hand'].data
    if P.MASK_ATTR in me.color_attributes:
        a = me.color_attributes[P.MASK_ATTR]
        want_colors = np.empty(len(a.data) * 4, dtype=np.float32)
        a.data.foreach_get('color', want_colors)
        want_colors = want_colors.reshape(-1, 4)
        want_domain = a.domain

    reset()
    bpy.ops.import_scene.gltf(filepath=path)
    names = {o.name for o in bpy.data.objects}
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    bone_names = [b.name for b in rig.data.bones] if rig else []
    check('17 bones present by name', sorted(bone_names) == sorted(BONES), len(bone_names), 17)
    missing = [n for n in NAIL_NAMES.values() if n not in names]
    check('five nails present by name', not missing, missing or 5)
    bad_parent = []
    for f, n in NAIL_NAMES.items():
        o = bpy.data.objects.get(n)
        if not o or o.parent != rig or o.parent_type != 'BONE' or o.parent_bone != f + '.03':
            bad_parent.append(n)
    check('nails are rigid children of the .03 bones', not bad_parent, bad_parent or 'ok')

    worst = 0.0
    from mathutils.kdtree import KDTree
    pairs = [('hand', bpy.data.objects.get('Hand'))] + [(f, bpy.data.objects.get(NAIL_NAMES[f])) for f in NAIL_NAMES]
    for key, o in pairs:
        if o is None:
            continue
        got = world_points(o)
        kd = KDTree(len(got))
        for i, p in enumerate(got):
            kd.insert(p, i)
        kd.balance()
        for p in want[key]:
            _, _, d = kd.find(p)
            worst = max(worst, d)
    check('round trip: every vertex where we put it (world, rest pose)', worst < 1e-4, float('%.2e' % worst), 1e-4)

    hand = bpy.data.objects.get('Hand')
    if want_colors is not None and hand is not None:
        me = hand.data
        attr = me.color_attributes[0] if len(me.color_attributes) else None
        ok = attr is not None
        err = None
        if ok:
            got = np.empty(len(attr.data) * 4, dtype=np.float32)
            attr.data.foreach_get('color', got)
            got = got.reshape(-1, 4)
            # compare per position (the exporter may reorder / split verts)
            gp = world_points(hand)
            kd = KDTree(len(gp))
            for i, p in enumerate(gp):
                kd.insert(p, i)
            kd.balance()
            if attr.domain == 'POINT' and want_domain == 'POINT':
                err = 0.0
                for i, p in enumerate(want['hand']):
                    _, j, _ = kd.find(p)
                    err = max(err, float(np.abs(got[j] - want_colors[i]).max()))
                ok = err < 2.0 / 255.0
        check('vertex colour masks survive the round trip', ok, err, '< 2/255')
    report['reimport'] = {'objects': sorted(names)}


def bone_world(rig, name):
    """(head, tail) of a bone in world space, rest pose."""
    b = rig.data.bones[name]
    m = np.array(rig.matrix_world)
    h = m[:3, :3] @ np.array(b.head_local) + m[:3, 3]
    t = m[:3, :3] @ np.array(b.tail_local) + m[:3, 3]
    return h, t


def pca_frame(points, rig, finger):
    """Frame of a nail from its vertices: centre, x across, y toward the
    cuticle, z out of the nail (away from the finger's bone axis)."""
    c = points.mean(0)
    X = points - c
    _, evec = np.linalg.eigh(X.T @ X)
    n = evec[:, 0]
    head, tail = bone_world(rig, finger + '.03')
    d = (tail - head) / np.linalg.norm(tail - head)
    foot = head + d * np.dot(c - head, d)
    if np.dot(n, c - foot) < 0:
        n = -n
    y = -(d - n * np.dot(n, d))
    y /= np.linalg.norm(y)
    x = np.cross(y, n)
    return c, x, y, n
