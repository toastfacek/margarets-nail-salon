"""QA preview renders (Cycles CPU) of the built hand.glb, for the reviewer only.

They show shape: proportions, knuckles, the nail unit (plate curvature, folds,
free edge). The in-game look is judged from game screenshots, not from these.
"""
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector

import gltfio

SKIN_RGB = (0.87, 0.62, 0.53)
NAIL_RGB = (0.93, 0.70, 0.70)


def _material(name, rgb, rough, coat=0.0, sss=0.0, use_attr=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.05
    if sss:
        b.inputs['Subsurface Weight'].default_value = sss
        b.inputs['Subsurface Radius'].default_value = (0.02, 0.008, 0.005)
        b.inputs['Subsurface Scale'].default_value = 0.2
    if use_attr:
        a = nt.nodes.new('ShaderNodeVertexColor')
        a.layer_name = use_attr
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(a.outputs['Color'], sep.inputs['Color'])
        # R blush -> redder, G palm -> lighter, B cavity -> darker (same idea as the game shader)
        mix1 = nt.nodes.new('ShaderNodeMix')
        mix1.data_type = 'RGBA'
        mix1.inputs['A'].default_value = (*rgb, 1)
        mix1.inputs['B'].default_value = (rgb[0] * 1.02, rgb[1] * 0.78, rgb[2] * 0.76, 1)
        nt.links.new(sep.outputs['Red'], mix1.inputs['Factor'])
        mix2 = nt.nodes.new('ShaderNodeMix')
        mix2.data_type = 'RGBA'
        nt.links.new(mix1.outputs['Result'], mix2.inputs['A'])
        mix2.inputs['B'].default_value = (rgb[0] * 0.62, rgb[1] * 0.5, rgb[2] * 0.48, 1)
        nt.links.new(sep.outputs['Blue'], mix2.inputs['Factor'])
        nt.links.new(mix2.outputs['Result'], b.inputs['Base Color'])
    return m


def _setup_scene():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 16
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        sc.cycles.use_denoising = False
    sc.render.resolution_x = 800
    sc.render.resolution_y = 560
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('QA')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.82, 0.78, 0.84, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.55
    sc.world = w
    key = bpy.data.lights.new('Key', 'AREA')
    key.energy = 60
    key.size = 1.5
    ko = bpy.data.objects.new('Key', key)
    ko.location = (1.5, -1.2, 4.0)
    ko.rotation_euler = (math.radians(25), math.radians(15), 0)
    sc.collection.objects.link(ko)
    fill = bpy.data.lights.new('Fill', 'AREA')
    fill.energy = 25
    fill.size = 2.0
    fo = bpy.data.objects.new('Fill', fill)
    fo.location = (-2.5, 2.0, 2.5)
    fo.rotation_euler = (math.radians(-40), math.radians(-35), 0)
    sc.collection.objects.link(fo)
    cam = bpy.data.cameras.new('Cam')
    cam.lens = 50
    co = bpy.data.objects.new('Cam', cam)
    sc.collection.objects.link(co)
    sc.camera = co
    return co


def _look(cam, eye, target, up=(0, 0, 1)):
    eye, target, up = Vector(eye), Vector(target), Vector(up)
    f = (target - eye).normalized()
    r = f.cross(up)
    if r.length < 1e-6:
        r = f.cross(Vector((0, 1, 0)))
    r.normalize()
    u = r.cross(f)
    m = Matrix((r, u, -f)).transposed()
    cam.matrix_world = Matrix.Translation(eye) @ m.to_4x4()


def nail_frame(obj, rig, finger):
    """World frame of a nail: centre, x across, y to the cuticle, z out."""
    c, x, y, z = gltfio.pca_frame(gltfio.world_points(obj), rig, finger)
    return Vector(c), Vector(x), Vector(y), Vector(z)


def render_all(glb, out_dir, report, only=None):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    for o in list(bpy.data.objects):
        if o.name.startswith('Icosphere'):
            bpy.data.objects.remove(o, do_unlink=True)
    hand = bpy.data.objects['Hand']
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    attr = hand.data.color_attributes[0].name if len(hand.data.color_attributes) else None
    skin = _material('QASkin', SKIN_RGB, 0.48, sss=0.25, use_attr=attr)
    nailm = _material('QANail', NAIL_RGB, 0.25, coat=0.6)
    hand.data.materials.clear()
    hand.data.materials.append(skin)
    for f in gltfio.FINGERS:
        o = bpy.data.objects[gltfio.NAIL_NAMES[f]]
        o.data.materials.clear()
        o.data.materials.append(nailm)
    cam = _setup_scene()
    # desk
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0.93))
    desk = bpy.context.active_object
    desk.data.materials.append(_material('QADesk', (0.85, 0.82, 0.9), 0.8))
    pts = gltfio.world_points(hand)
    lo, hi = pts.min(0), pts.max(0)
    mid = (lo + hi) / 2
    renders = []

    def shot(name, eye, target, lens=50, up=(0, 0, 1)):
        if only and name not in only:
            return
        cam.data.lens = lens
        _look(cam, eye, target, up)
        p = os.path.join(out_dir, f'qa-{name}.png')
        bpy.context.scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        renders.append(os.path.basename(p))

    # whole hand from the top (fingers to the left, like the game's zoomed-out view)
    shot('rest-top', (mid[0] - 0.1, mid[1] - 0.6, mid[2] + 3.2), (mid[0] - 0.1, mid[1], mid[2]), lens=45, up=(0, 1, 0))
    # from the side (thumb side), low: finger profiles, knuckles, nail free edges
    palm = Vector(gltfio.bone_world(rig, 'palm')[0])
    shot('rest-side', palm + Vector((-0.35, -2.4, 0.25)), palm + Vector((-0.35, 0, -0.02)), lens=55)
    # index fingertip macro: face-on (the game's close-up) and oblique from the tip side
    c, x, y, z = nail_frame(bpy.data.objects['Nail_Index'], rig, 'index')
    shot('index-macro', c + z * 0.28 + y * 0.02, c, lens=60, up=y)
    shot('index-oblique', c + z * 0.16 - y * 0.16 + x * 0.10, c - y * 0.01, lens=60, up=z)
    c, x, y, z = nail_frame(bpy.data.objects['Nail_Thumb'], rig, 'thumb')
    shot('thumb-macro', c + z * 0.28 + y * 0.02, c, lens=60, up=y)
    # posed (the rig's local axes: X flex, Z spread, Y twist), from the side and from the top
    import rig as RG
    poses = RG.limit_poses()
    side_eye, side_at = palm + Vector((-0.35, -2.4, 0.25)), palm + Vector((-0.35, 0, -0.02))
    top_eye, top_at = (mid[0] - 0.1, mid[1] - 0.6, mid[2] + 3.2), (mid[0] - 0.1, mid[1], mid[2])
    for name, pose in (('natural-rest', poses['natural-rest']), ('relaxed', poses['relaxed']), ('limit', poses['curl']), ('thumb', poses['thumb-limit'])):
        if only and 'pose-' + name not in only:
            continue
        RG.set_pose(rig, pose)
        shot('pose-' + name, side_eye, side_at, lens=55)
        shot('pose-' + name + '-top', top_eye, top_at, lens=45, up=(0, 1, 0))
    RG.set_pose(rig, {})
    report['qa_renders'] = renders
