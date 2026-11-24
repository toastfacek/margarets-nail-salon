"""Build the v2 hand (hand-v2-plan.md) from the committed MakeHuman cage.

Run (Blender 5.3 as a Python module, headless; no network):
    /home/claude/bpyenv/bin/python tools/blender/build_hand.py [--viewer] [--qa] [--out=path.glb]

Pipeline: base -> fit -> rig weights -> objects -> dense -> nails -> rig checks
-> masks -> export -> checks (-> --qa renders). Every number is in params.py;
no randomness, so two runs give the same file (report.json carries the sha256).
Until step G1 the game keeps loading v1 (public/models/hand.glb, built by
v1/build_hand.py); this writes tools/blender/out/hand-v2-viewer.glb (the
viewer's variant; with --viewer the nails carry the free-edge length morph).
Exit code 1 when a check fails.
"""
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import base  # noqa: E402
import params as P  # noqa: E402
from base import BI, FINGERS  # noqa: E402


def parse_args(argv):
    flags = {}
    for a in argv:
        if a.startswith('--'):
            k, _, v = a[2:].partition('=')
            flags[k] = v if v else True
    return flags


def export(scene, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [scene['rig'], scene['hand']] + list(scene['nails'].values()):
        o.select_set(True)
    bpy.context.view_layer.objects.active = scene['rig']
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=False, export_extras=True, export_draco_mesh_compression_enable=False,
        export_vertex_color='ACTIVE', export_all_vertex_colors=True, export_attributes=True,
        export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='NONE', export_image_format='NONE', export_skins=True,
        export_morph=bool(scene.get('morph')), export_morph_normal=True, export_def_bones=False,
        export_hierarchy_flatten_bones=False, export_apply=False)


def verify(path, scene, report, check):
    from mathutils.kdtree import KDTree
    from rig import world_points
    want = {'Hand': world_points(scene['hand'])}
    for f, o in scene['nails'].items():
        want[o.name] = world_points(o)
    me = scene['hand'].data
    a = me.color_attributes[P.MASK_ATTR]
    wc = np.empty(len(a.data) * 4, dtype=np.float32)
    a.data.foreach_get('color', wc)
    wc = wc.reshape(-1, 4)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    rig = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
    names = sorted(b.name for b in rig.data.bones) if rig else []
    check('export: 17 bones by name', names == sorted(base.BONES), len(names), 17)
    bad = []
    for f in FINGERS:
        o = bpy.data.objects.get('Nail_' + f.capitalize())
        if not o or o.parent != rig or o.parent_type != 'BONE' or o.parent_bone != f + '.03':
            bad.append(f)
    check('export: nails are rigid children of the .03 bones', not bad, bad or 'ok')
    worst = 0.0
    for name, pts in want.items():
        o = bpy.data.objects.get(name)
        if o is None:
            worst = float('inf')
            continue
        got = world_points(o)
        kd = KDTree(len(got))
        for i, p in enumerate(got):
            kd.insert(p, i)
        kd.balance()
        worst = max(worst, max(kd.find(p)[2] for p in pts))
    check('export: round trip, every vertex where we put it', worst < 1e-4, float('%.2e' % worst), 1e-4)
    hand = bpy.data.objects.get('Hand')
    attr = hand.data.color_attributes[0]
    got = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get('color', got)
    got = got.reshape(-1, 4)
    if attr.domain == 'CORNER':
        lv = np.empty(len(hand.data.loops), dtype=np.int64)
        hand.data.loops.foreach_get('vertex_index', lv)
        per = np.zeros((len(hand.data.vertices), 4), dtype=np.float32)
        per[lv] = got
        got = per
    gp = world_points(hand)
    kd = KDTree(len(gp))
    for i, p in enumerate(gp):
        kd.insert(p, i)
    kd.balance()
    err = max(float(np.abs(got[kd.find(p)[1]] - wc[i]).max()) for i, p in enumerate(want['Hand']))
    check('export: masks survive the round trip', err < 2 / 255, round(err, 5), '< 2/255')
    nail = bpy.data.objects.get('Nail_Index')
    check('export: nail extras (nailFrame, nailHalf, nailAnat)', nail is not None and all(k in nail.keys() for k in ('nailFrame', 'nailHalf', 'nailAnat')),
          sorted(nail.keys()) if nail else None)


def main():
    flags = parse_args(sys.argv[1:])
    out_dir = os.path.join(HERE, 'out')
    os.makedirs(out_dir, exist_ok=True)
    out_glb = flags.get('out') or os.path.join(out_dir, 'hand-v2-viewer.glb')
    t0 = time.time()
    report = {'checks': [], 'counts': {}}

    def check(name, ok, value=None, gate=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'value': value, 'gate': gate})
        print(('PASS ' if ok else 'FAIL ') + name + ('' if value is None else f'  value={value}') + ('' if gate is None else f'  gate={gate}'))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    import dense
    import fit
    import masks
    import nails
    import rig as RG
    cage = base.load(report)
    fit.build(cage, report, check)
    fit.cap_forearm(cage, report)
    RG.clean_weights(cage, report, check)
    if not flags.get('placeholder'):
        nails.widen_grooves(cage, report, check)
    hand, rig = base.make_objects(cage, {f: cage.nail_normal(f) for f in FINGERS})
    # mark the nail beds and their fold rings (material indices survive subdivision)
    me = hand.data
    for i in range(1 + 2 * len(FINGERS)):
        me.materials.append(bpy.data.materials.new(f'mark{i}'))
    mi = np.zeros(len(me.polygons), dtype=np.int32)
    for fi, f in enumerate(FINGERS):
        for r in cage.folds[f]:
            mi[r] = 6 + fi
        mi[cage.nails[f]] = 1 + fi
    me.polygons.foreach_set('material_index', mi)
    scene = {'cage': cage, 'hand': hand, 'rig': rig, 'nails': {}, 'morph': not flags.get('game')}
    dense.build(scene, report, check)
    Wd = RG.mesh_weights(hand)
    scene['W_dense'] = {f: Wd[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) for f in FINGERS}
    nails.build(scene, report, check, sculpted=not flags.get('placeholder'), morph=not flags.get('game'))
    RG.checks(scene, report, check)
    masks.build(scene, report, check)
    if flags.get('blend'):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, 'hand-v2.blend'))
    # export: no skin UVs yet (V3), no materials
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    me.materials.clear()
    nv = len(me.vertices) + sum(len(o.data.vertices) for o in scene['nails'].values())
    report['counts']['total_verts'] = nv
    report['counts']['nail_verts'] = {f: len(o.data.vertices) for f, o in scene['nails'].items()}
    export(scene, out_glb)
    size = os.path.getsize(out_glb)
    with open(out_glb, 'rb') as fh:
        sha = hashlib.sha256(fh.read()).hexdigest()
    report['output'] = {'path': os.path.relpath(out_glb, ROOT), 'bytes': size, 'sha256': sha}
    verify(out_glb, scene, report, check)
    report['seconds'] = round(time.time() - t0, 1)
    with open(os.path.join(out_dir, 'report.json'), 'w') as fh:
        json.dump(report, fh, indent=1, default=float)
    failed = [c for c in report['checks'] if not c['pass']]
    print(f'{len(report["checks"]) - len(failed)}/{len(report["checks"])} checks pass; {size} bytes; sha256 {sha[:16]}; {report["seconds"]} s')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
