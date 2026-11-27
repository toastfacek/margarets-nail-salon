"""Mixed-level subdivision of the skin (hand-v2-plan.md 3.4).

1. Catmull-Clark level 1 everywhere (Blender's subsurf, applied: it carries
   the vertex groups, the UVs and the material indices that mark the nail beds).
2. The five last finger joints (faces with .03 weight >= DENSE_TIP_W, grown by
   one ring) are split once more (bmesh subdivide_edges, grid fill); the
   transition ring becomes triangles and n-gons (triangulated), on the middle
   phalanx side of the last joint.
3. Every vertex is snapped to the limit surface (a level-LIMIT_LEVELS subsurf
   copy of the cage, BVH closest point): both levels agree, no level-1 shrinkage.
4. Smooth normals everywhere (no sharp edges on skin).
"""
import bmesh
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

import params as P
from base import BI, FINGERS


def build(scene, report, check):
    hand = scene['hand']
    me = hand.data
    # the limit surface proxy, from the cage as it is now
    cage_me = me.copy()
    proxy = bpy.data.objects.new('LimitProxy', cage_me)
    bpy.context.scene.collection.objects.link(proxy)
    pm = proxy.modifiers.new('s', 'SUBSURF')
    pm.levels = pm.render_levels = P.LIMIT_LEVELS
    for md in list(hand.modifiers):
        hand.modifiers.remove(md)
    ss = hand.modifiers.new('Subsurf', 'SUBSURF')
    ss.levels = ss.render_levels = 1
    ss.use_limit_surface = True
    bpy.context.view_layer.objects.active = hand
    for o in bpy.context.view_layer.objects:
        o.select_set(o == hand)
    bpy.ops.object.modifier_apply(modifier='Subsurf')
    n1 = len(me.vertices)

    # level 2 on the last joints
    bm = bmesh.new()
    bm.from_mesh(me)
    deform = bm.verts.layers.deform.active
    gi = {g.name: g.index for g in hand.vertex_groups}
    tip_g = [gi[f + '.03'] for f in FINGERS]
    w3 = np.array([max((v[deform].get(g, 0.0) for g in tip_g), default=0.0) for v in bm.verts])
    bm.faces.ensure_lookup_table()
    sel = np.array([w3[[v.index for v in f.verts]].mean() >= P.DENSE_TIP_W for f in bm.faces])
    vsel = np.zeros(len(bm.verts), dtype=bool)
    for f in np.nonzero(sel)[0]:
        for v in bm.faces[int(f)].verts:
            vsel[v.index] = True
    faces = [f for f in bm.faces if sel[f.index] or any(vsel[v.index] for v in f.verts)]
    # budget lever (plan 3.4): level 2 only on the back and the tip half of each
    # last joint; the pad side of its proximal half stays at level 1
    cage = scene['cage']
    keep = []
    for f in faces:
        c = np.array(f.calc_center_median())
        best = None
        for fn in FINGERS:
            h, t = cage.joints[fn + '.3'], cage.joints[fn + '.4']
            d = t - h
            L = np.linalg.norm(d)
            u = (c - h) @ d / (L * L)
            r = np.linalg.norm(c - (h + np.clip(u, 0, 1) * d))
            if best is None or r < best[0]:
                best = (r, fn, u, h + np.clip(u, 0, 1) * d)
        _, fn, u, axis = best
        back = (c - axis) @ cage.nail_normal(fn) > -P.DENSE_PAD_KEEP * best[0]
        if back or u > P.DENSE_TIP_HALF:
            keep.append(f)
    faces = keep
    edges = list({e for f in faces for e in f.edges})
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(me)
    bm.free()
    me.update()

    # snap to the limit surface
    dg = bpy.context.evaluated_depsgraph_get()
    ev = proxy.evaluated_get(dg)
    pme = ev.to_mesh()
    bvh = BVHTree.FromPolygons([tuple(v.co) for v in pme.vertices], [tuple(p.vertices) for p in pme.polygons])
    ev.to_mesh_clear()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    moved = np.zeros(len(co))
    for i, p in enumerate(co):
        q = bvh.find_nearest(p)[0]
        if q is not None:
            moved[i] = (q - __import__('mathutils').Vector(p)).length
            co[i] = tuple(q)
    me.vertices.foreach_set('co', co.ravel())
    me.update()
    me.shade_smooth()
    bpy.data.objects.remove(proxy, do_unlink=True)
    bpy.data.meshes.remove(cage_me)
    # subdivision blends weights: back to 4 influences, normalised
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_clean(group_select_mode='ALL', limit=1e-4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    # the rigid nail unit stays rigid: subdivision blends a 1-5% pull of .02
    # into its border, which flips the folds' squeezed triangles at a DIP flex.
    # The last bone's weight is eased to 1 over [RIGID_SNAP_W] (a smooth ramp,
    # not a step: a step flips its own triangles), the others scaled to match
    rig_n = 0
    lo, hi = P.RIGID_SNAP_W
    for f in FINGERS:
        g3 = hand.vertex_groups[f + '.03']
        for v in me.vertices:
            w = {gg.group: gg.weight for gg in v.groups}
            w3 = w.get(g3.index, 0.0)
            if w3 <= lo or w3 >= 1.0:
                continue
            t = min(max((w3 - lo) / (hi - lo), 0.0), 1.0)
            w3n = lo + (1.0 - lo) * t * t * (3 - 2 * t)
            k = (1.0 - w3n) / max(1.0 - w3, 1e-9)
            for gi_, wv in w.items():
                if gi_ == g3.index:
                    continue
                if wv * k < 1e-4:
                    hand.vertex_groups[gi_].remove([v.index])
                else:
                    hand.vertex_groups[gi_].add([v.index], wv * k, 'REPLACE')
            g3.add([v.index], w3n, 'REPLACE')
            rig_n += 1
    report['counts']['rigid_snapped_verts'] = rig_n
    md = hand.modifiers.new('Armature', 'ARMATURE')
    md.object = scene['rig']

    nv = len(me.vertices)
    nt = sum(len(p.vertices) - 2 for p in me.polygons)
    report['counts'].update({'skin_level1_verts': n1, 'skin_verts': nv, 'skin_tris': nt,
                             'snap_max_mm': round(float(moved.max() / scene['cage'].scale), 3)})
    check('dense: skin verts <= %d' % P.CAP_SKIN_VERTS, nv <= P.CAP_SKIN_VERTS, nv, P.CAP_SKIN_VERTS)
    check('dense: skin tris <= %d' % P.CAP_SKIN_TRIS, nt <= P.CAP_SKIN_TRIS, nt, P.CAP_SKIN_TRIS)
    # the index last joint's silhouette (plan 3.4): round the finger, the angle
    # between neighbouring faces across the edges that run along the finger,
    # from just past the DIP to before the tip's pole (the nail unit aside)
    cage = scene['cage']
    h, t = cage.joints['index.3'], cage.joints['index.4']
    d = t - h
    L2 = float(d @ d)
    mwv = np.array(hand.matrix_world)
    vco = np.array([tuple(v.co) for v in me.vertices]) @ mwv[:3, :3].T + mwv[:3, 3]
    u = (vco - h) @ d / L2
    W = np.zeros(nv)
    g = gi['index.03']
    for v in me.vertices:
        for gg in v.groups:
            if gg.group == g:
                W[v.index] = gg.weight
    pol = [p for p in me.polygons if p.material_index == 0 and W[list(p.vertices)].min() > 0.5]
    pid = {p.index: k for k, p in enumerate(pol)}
    nrm = np.array([tuple(p.normal) for p in pol])
    emap = {}
    for p in pol:
        for ek in p.edge_keys:
            emap.setdefault(ek, []).append(pid[p.index])
    dn = d / np.sqrt(L2)
    ang = []
    for (a_, b_), fs in emap.items():
        if len(fs) != 2:
            continue
        ev = vco[b_] - vco[a_]
        if abs(ev @ dn) < 0.8 * np.linalg.norm(ev):
            continue
        um = (u[a_] + u[b_]) / 2
        if not (0.15 < um < 0.85):
            continue
        ang.append(float(np.degrees(np.arccos(np.clip(nrm[fs[0]] @ nrm[fs[1]], -1, 1)))))
    ang = np.array(ang)
    report['counts']['index_tip_ring_facet_deg'] = {'median': round(float(np.median(ang)), 2), 'p95': round(float(np.percentile(ang, 95)), 2),
                                                     'max': round(float(ang.max()), 2), 'edges': len(ang)}
    check('dense: index last joint silhouette, no facet over %g deg round the finger' % P.FACET_MAX_DEG,
          ang.max() <= P.FACET_MAX_DEG, report['counts']['index_tip_ring_facet_deg'], P.FACET_MAX_DEG)
    return BI
