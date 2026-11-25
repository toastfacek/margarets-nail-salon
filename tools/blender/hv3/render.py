"""Cycles stills of an hv3 hand mesh from the review angles, plus a contact
sheet. Run: /home/claude/bpyenv/bin/python render.py mesh.npz outdir [views] [res] [samples]

views: comma list from top,palm,thumb,pinky,below,hero,tip,web (default the six).
The mesh is in millimetres in the hand frame (+Y distal, +X ulnar, +Z dorsal).
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

VIEWS = {
    # name: (direction from the target to the camera, up, lens mm, distance mm, target offset)
    'top':   ((0.0, -0.05, 1.0), (0, 1, 0), 100, 740, (0, 5, 0)),
    'palm':  ((0.0, -0.05, -1.0), (0, 1, 0), 100, 740, (0, 5, 0)),
    'thumb': ((-1.0, 0.0, 0.12), (0, 0, 1), 100, 700, (0, 10, 0)),
    'pinky': ((1.0, 0.0, 0.12), (0, 0, 1), 100, 700, (0, 10, 0)),
    'below': ((-0.10, 0.80, -0.42), (0, 0, 1), 100, 650, (0, -10, 0)),
    'hero':  ((-0.50, -0.30, 0.72), (0, 0, 1), 100, 700, (0, 0, 0)),
    'nail':  ((0, 0, 1), (0, 0, 1), 100, 140, (0, 0, 0)),
    'tnail': ((0, 0, 1), (0, 0, 1), 100, 110, (0, 0, 0)),
    'tip':   ((-0.25, 1.0, 0.45), (0, 0, 1), 85, 300, (-20, 60, -8)),
    'web':   ((-0.75, 0.25, 0.6), (0, 0, 1), 90, 470, (-15, 0, -5)),
}
DEFAULT = ['top', 'palm', 'thumb', 'pinky', 'below', 'hero']


def setup(mesh_path, clay=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    d = np.load(mesh_path)
    V, Q = d['V'].astype(np.float64), d['Q']
    me = bpy.data.meshes.new('hand')
    me.vertices.add(len(V))
    me.vertices.foreach_set('co', (V * 0.001).ravel())
    if Q.shape[1] == 4:
        me.loops.add(len(Q) * 4)
        me.loops.foreach_set('vertex_index', Q.ravel())
        me.polygons.add(len(Q))
        me.polygons.foreach_set('loop_start', np.arange(len(Q)) * 4)
        me.polygons.foreach_set('loop_total', np.full(len(Q), 4))
    else:
        me.loops.add(len(Q) * 3)
        me.loops.foreach_set('vertex_index', Q.ravel())
        me.polygons.add(len(Q))
        me.polygons.foreach_set('loop_start', np.arange(len(Q)) * 3)
        me.polygons.foreach_set('loop_total', np.full(len(Q), 3))
    me.update(calc_edges=True)
    me.validate()
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), dtype=bool))
    ob = bpy.data.objects.new('hand', me)
    bpy.context.scene.collection.objects.link(ob)
    extra = d['extra'] if 'extra' in d.files else None
    mat = bpy.data.materials.new('skin')
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes['Principled BSDF']
    if clay:
        b.inputs['Base Color'].default_value = (0.40, 0.36, 0.33, 1)
        b.inputs['Roughness'].default_value = 0.6
        b.inputs['Subsurface Weight'].default_value = 0.25
        b.inputs['Subsurface Radius'].default_value = (1.0, 0.5, 0.3)
        b.inputs['Subsurface Scale'].default_value = 0.0012
    else:
        b.inputs['Base Color'].default_value = (0.74, 0.52, 0.43, 1)
        b.inputs['Subsurface Weight'].default_value = 1.0
        b.inputs['Subsurface Radius'].default_value = (1.0, 0.42, 0.25)
        b.inputs['Subsurface Scale'].default_value = 0.0013
        b.inputs['Roughness'].default_value = 0.48
        b.inputs['Specular IOR Level'].default_value = 0.38
    ob.data.materials.append(mat)
    # nails, if present
    if 'NV' in d.files:
        nm = bpy.data.meshes.new('nails')
        NV, NF = d['NV'].astype(np.float64), d['NF']
        nm.from_pydata((NV * 0.001).tolist(), [], NF.tolist())
        nm.update()
        nm.polygons.foreach_set('use_smooth', np.ones(len(nm.polygons), dtype=bool))
        no = bpy.data.objects.new('nails', nm)
        bpy.context.scene.collection.objects.link(no)
        m2 = bpy.data.materials.new('nail')
        m2.use_nodes = True
        b2 = m2.node_tree.nodes['Principled BSDF']
        b2.inputs['Base Color'].default_value = (0.80, 0.50, 0.50, 1)
        b2.inputs['Roughness'].default_value = 0.18
        b2.inputs['Subsurface Weight'].default_value = 0.3
        b2.inputs['Subsurface Scale'].default_value = 0.001
        b2.inputs['Coat Weight'].default_value = 0.15
        b2.inputs['Specular IOR Level'].default_value = 0.6
        no.data.materials.append(m2)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.use_denoising = True
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Base Contrast'
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.055, 0.055, 0.06, 1)
    bg.inputs['Strength'].default_value = 1.0
    return ob, V


def add_light(name, loc, target, power, size, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = power
    ld.size = size
    ld.color = color
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    d = Vector(target) - Vector(loc)
    lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(lo)
    return lo


def place_camera(cam, target, direction, up, dist):
    t = Vector(target)
    d = Vector(direction).normalized()
    cam.location = t + d * dist
    fwd = -d
    upv = Vector(up)
    right = fwd.cross(upv).normalized()
    upv = right.cross(fwd).normalized()
    from mathutils import Matrix
    M = Matrix((right, upv, -fwd)).transposed()
    cam.rotation_euler = M.to_euler()


def render_views(mesh_path, outdir, views=None, res=(720, 540), samples=40, clay=False, prefix=''):
    os.makedirs(outdir, exist_ok=True)
    ob, V = setup(mesh_path, clay)
    # target: the hand without the forearm
    hv = V[V[:, 1] > -5]
    c = 0.5 * (hv.min(0) + hv.max(0)) * 0.001
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.cycles.samples = samples
    paths = []
    for v in views or DEFAULT:
        direction, up, lens, dist, off = VIEWS[v]
        tgt = Vector(c) + Vector(off) * 0.001
        dd = np.load(mesh_path)
        if 'T_' + v in dd.files:
            tgt = Vector(dd['T_' + v] * 0.001)
            direction = tuple(dd['D_' + v])
        cd.lens = lens
        place_camera(cam, tgt, direction, up, dist * 0.001)
        # lights follow the camera: key above-left of it, fill right, rim behind
        for o in [o for o in bpy.data.objects if o.type == 'LIGHT']:
            bpy.data.objects.remove(o)
        fwd = (tgt - cam.location).normalized()
        upv = Vector(up)
        right = fwd.cross(upv).normalized()
        upv = right.cross(fwd).normalized()
        L = dist * 0.001
        add_light('key', tgt - fwd * L * 0.45 + upv * L * 0.9 - right * L * 0.6, tgt, 9.0, 0.35)
        add_light('fill', tgt - fwd * L * 0.9 + right * L * 0.8 - upv * L * 0.1, tgt, 2.2, 0.6, (0.92, 0.95, 1.0))
        add_light('rim', tgt + fwd * L * 0.7 + upv * L * 0.6 + right * L * 0.3, tgt, 6.0, 0.3, (1.0, 0.95, 0.9))
        p = os.path.join(outdir, prefix + v + '.png')
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        paths.append(p)
    return paths


def contact_sheet(paths, out, cols=3, label=None):
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        w, h = im.size
        a = np.empty(w * h * 4, dtype=np.float32)
        im.pixels.foreach_get(a)
        imgs.append(a.reshape(h, w, 4))
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    sheet = np.zeros((rows * h, cols * w, 4), dtype=np.float32)
    sheet[..., 3] = 1
    for i, a in enumerate(imgs):
        r_, c_ = divmod(i, cols)
        # images are stored bottom-up: row 0 at the top of the sheet means the last block
        sheet[(rows - 1 - r_) * h:(rows - r_) * h, c_ * w:(c_ + 1) * w] = a
    im = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
    im.pixels.foreach_set(sheet.ravel())
    im.filepath_raw = out
    im.file_format = 'PNG'
    im.save()
    return out


if __name__ == '__main__':
    mesh, outdir = sys.argv[1], sys.argv[2]
    views = sys.argv[3].split(',') if len(sys.argv) > 3 and sys.argv[3] else DEFAULT
    res = tuple(int(x) for x in sys.argv[4].split('x')) if len(sys.argv) > 4 else (720, 540)
    samples = int(sys.argv[5]) if len(sys.argv) > 5 else 40
    clay = len(sys.argv) > 6 and sys.argv[6] == 'clay'
    paths = render_views(mesh, outdir, views, res, samples, clay)
    contact_sheet(paths, os.path.join(outdir, 'sheet.png'))
    print('sheet', os.path.join(outdir, 'sheet.png'))
