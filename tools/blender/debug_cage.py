"""Debug still of the cage's committed nail faces (hand-v2-plan.md step V0).

    /home/claude/bpyenv/bin/python tools/blender/debug_cage.py [out.png]

Renders the cage (targets applied, hand frame, Cycles CPU) from above the
fingertips with each finger's nail bed patch in red, the first fold ring in
yellow and the second in orange, and the cage's edges drawn as wire. For the
reviewer: the patches must be the beds inside the tight double loop.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import base  # noqa: E402


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'hv2-v0-nail-patches.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cage = base.load()
    sc = bpy.context.scene
    me = bpy.data.meshes.new('cage')
    me.from_pydata((cage.V / 100.0).tolist(), [], cage.F.tolist())
    me.update()
    me.shade_smooth()
    ob = bpy.data.objects.new('cage', me)
    sc.collection.objects.link(ob)
    cols = [(0.82, 0.66, 0.58), (0.85, 0.08, 0.08), (0.95, 0.85, 0.1), (0.95, 0.5, 0.1), (0.02, 0.02, 0.05)]
    for i, c in enumerate(cols):
        m = bpy.data.materials.new(f'm{i}')
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (*c, 1)
        b.inputs['Roughness'].default_value = 0.6
        me.materials.append(m)
    for f in base.FINGERS:
        for fi in cage.folds[f][1]:
            me.polygons[int(fi)].material_index = 3
        for fi in cage.folds[f][0]:
            me.polygons[int(fi)].material_index = 2
        for fi in cage.nails[f]:
            me.polygons[int(fi)].material_index = 1
    ss = ob.modifiers.new('s', 'SUBSURF')
    ss.levels = ss.render_levels = 2
    wire = ob.copy()
    wire.data = me.copy()
    sc.collection.objects.link(wire)
    wire.modifiers.clear()
    wm = wire.modifiers.new('w', 'WIREFRAME')
    wm.thickness = 0.0025
    wm.use_replace = True
    wm.material_offset = 4
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 16
    sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 1280, 800
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[1].default_value = 3.0
    cam = bpy.data.cameras.new('c')
    co = bpy.data.objects.new('c', cam)
    sc.collection.objects.link(co)
    sc.camera = co
    cam.lens = 50
    tgt = Vector((1.15, 0.2, -0.15))
    co.location = tgt + Vector((-0.3, 1.5, 3.4))
    co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print('wrote', out)


if __name__ == '__main__':
    main()
