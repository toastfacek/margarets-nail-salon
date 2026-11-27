"""The rig (hand-plan.md section 4): uniform bone axes, joint centres,
analytic finger weights, and the checks at the joint limits.

* Bone axes: every finger bone gets local Y along the bone (as before) and
  local Z toward the palm side (Blender's align_roll), so local X =
  cross(back normal, bone direction): +X rotation curls toward the palm on
  every finger. The thumb's frame comes from its own nail (its nail faces
  sideways). Palm and wrist use the back of the hand. The game computes the
  same axes from the file at load (src/scene/HandRig.js); this makes them
  readable in the file too, and lets the QA renders pose the hand.
* Joint centres: each middle and last joint (and the thumb's two outer
  joints) moves to the centroid of the skin's cross-section there, then
  JOINT_BACK x the local radius toward the back of the finger (the knuckle
  stays put, the pad side folds).
* Weights: inside a finger, a vertex blends between the two bones of its
  nearest joint only, over a smoothstep window centred on the joint, crisp
  on the back (JOINT_WIN_BACK x radius) and soft on the pad (JOINT_WIN_PAD).
  The finger's share of each vertex (against the palm, the wrist and the
  neighbours, i.e. the knuckle and webbing blend) is today's, smoothed;
  the nail unit stays rigid on .03 (nails.py's region).
* The thumb's bind (B9.8, _rebind_thumb): the source thumb sticks straight
  out, the game rests it beside the index. The rig poses it there, bakes the
  skinned shape into the mesh, makes that pose the rest, re-rolls the thumb
  bones from the moved nail and smooths the thenar web (Taubin), so the
  resting thumb is the modelled shape instead of a 27 degree linear blend
  skinning bend (which creased the web). Its weights to the palm get a wider,
  softer falloff first. The game's thumb poses are re-derived about the new
  bind (GAME_THUMB_POSES) and checked to put the thumb where they used to.
* Checks at every limit pose (the same table as src/scene/HandPoses.js):
  joint cross-sections keep >= VOLUME_MIN of their rest size, no triangle
  flips, weights sum to one, max 4 influences.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

import gltfio
import params as P
from gltfio import FINGERS
from sculpt import _closest_on_chain, _weights, smoothstep

# Joint limits in degrees, [min, max] for flex (X), spread (Z), twist (Y).
# Kept in step with src/scene/HandPoses.js (LIMITS). The plan's 60 / 70 for
# a finger's knuckle / middle joint flipped pad triangles from about 50 on
# (linear blend skinning, no correctives): tightened to 45 / 45 (plan 4:
# tighten the limits first). The game's deepest pose is a relaxed curl.
LIMITS = {
    'finger.01': ((-15, 45), (-12, 12), (0, 0)),
    'finger.02': ((0, 45), (0, 0), (0, 0)),
    'finger.03': ((-5, 45), (0, 0), (0, 0)),
    # the thumb's, about its bind (B9.8; before: (-15, 25), (-20, 36), (-15, 25) /
    # (-5, 45) / (-10, 55) about the old file's straight-out thumb)
    'thumb.01': ((-19, 21), (-47, 9), (-9, 21)),
    'thumb.02': ((-17, 33), (0, 0), (0, 0)),
    'thumb.03': ((-20, 45), (0, 0), (0, 0)),
    'palm': ((-10, 10), (-6, 6), (0, 0)),
    'wrist': ((-10, 10), (-8, 8), (0, 0)),
}


# The thumb's bind (B9.8): the source file's thumb sticks straight out; the
# game rests it beside the index (Jesse, B9 review), which it used to reach
# with a pose of 27 degrees of spread on the thumb base (THUMB_REST then):
# linear blend skinning folded the thenar web into a crease there. Now the
# rig re-poses the thumb to that rest here, bakes it into the mesh, smooths the
# web and makes it the bind pose (_rebind_thumb): the rest IS the model.
THUMB_BIND = {'thumb.01': (4, 27, 4), 'thumb.02': (12, 0, 0), 'thumb.03': (10, 0, 0)}
# The thumb's natural rest (src/scene/HandPoses.js THUMB_REST), now the bind pose.
THUMB_REST = {'thumb.01': (0, 0, 0), 'thumb.02': (0, 0, 0), 'thumb.03': (0, 0, 0)}

# The game's thumb poses (src/scene/HandPoses.js), [base flex, spread, twist,
# middle flex, last flex]: before the rebind (about the old file's thumb)
# and after it (about the new bind). The pipeline re-derives the second from
# the first and checks both the numbers and where the thumb ends up.
GAME_THUMB_POSES = {
    'rest': ((4, 27, 4, 12, 10), (0, 0, 0, 0, 0)),
    'present-thumb': ((2, 20, 18, 4, 5), (-1.2, -7.1, 14.9, -8, -5)),
    'present-other': ((6, 28, 4, 14, 12), (1.7, 1.2, -0.9, 2, 2)),
    'relaxed': ((8, 34, 4, 10, 12), (2.6, 7.3, -1.9, -2, 2)),
    'fan': ((0, 18, 10, 2, 2), (-2.9, -9.3, 7.8, -10, -8)),
    'qa-relaxed': ((8, 6, 0, 10, 12), (6.4, -20.4, -6.3, -2, 2)),
}


def with_thumb_rest(pose):
    out = dict(THUMB_REST)
    out.update(pose)
    return out


def limits_of(name):
    if name in LIMITS:
        return LIMITS[name]
    f, k = name.split('.')
    return LIMITS['thumb.' + k] if f == 'thumb' else LIMITS['finger.' + k]


def _nail_normal(scene, f):
    """Outward normal of a finger's nail (world): the plate's +Z."""
    pl = scene.get('plates', {}).get(f)
    if pl is not None:
        return np.asarray(pl.z, dtype=np.float64)
    _, _, _, n = gltfio.pca_frame(gltfio.world_points(scene['nails'][f]), scene['rig'], f)
    return n


def _section(Pw, sel, c, d, half):
    """Skin points of `sel` within `half` of the plane through c normal to d."""
    s = (Pw - c) @ d
    return sel & (np.abs(s) < half)


def _edit_bones(scene, report):
    """Joint centres and uniform rolls (edit mode on the armature)."""
    rig, hand = scene['rig'], scene['hand']
    W, gi = _weights(hand)
    Pw = gltfio.world_points(hand)
    mw = np.array(rig.matrix_world)
    mwi = np.linalg.inv(mw)
    to_arm = lambda p: (mwi[:3, :3] @ p) + mwi[:3, 3]  # noqa: E731
    back_hand = _nail_normal(scene, 'middle')
    moves = {}
    for f in FINGERS:
        bones = [f + '.0%d' % k for k in (1, 2, 3)]
        wf = W[:, [gi[b] for b in bones]].sum(1)
        n = _nail_normal(scene, f)
        # joints: the middle and last one (the thumb's two outer joints too)
        for k in (2, 3):
            if f == 'thumb' and k == 2:
                continue  # the thumb's base joint sits in the thenar mound: its section is not a ring
            head, tail = gltfio.bone_world(rig, bones[k - 1])
            ph, pt = gltfio.bone_world(rig, bones[k - 2])
            d = (tail - head) + (pt - ph)
            d /= np.linalg.norm(d)
            L = min(np.linalg.norm(tail - head), np.linalg.norm(pt - ph))
            sel = _section(Pw, wf > 0.5, head, d, 0.12 * L)
            if sel.sum() < 8:
                continue
            Q = Pw[sel]
            cen = Q.mean(0)
            # centroid of the ring, not of the vertices (the scan is uneven): mid of the extents
            nb = n - d * (n @ d)
            nb /= np.linalg.norm(nb)
            side = np.cross(d, nb)
            hb = (Q - cen) @ nb
            hs = (Q - cen) @ side
            cen = cen + nb * (hb.max() + hb.min()) / 2 + side * (hs.max() + hs.min()) / 2
            radius = (hb.max() - hb.min()) / 2
            cen = cen + nb * P.JOINT_BACK * radius
            # keep the joint on the bone line's plane through the old head (no sliding along the finger)
            cen = cen - d * ((cen - head) @ d)
            moves[bones[k - 1]] = cen
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    nails_mw = {f: o.matrix_world.copy() for f, o in scene['nails'].items()}
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    shift = []
    for name, cen in moves.items():
        b = eb[name]
        old = np.array(b.head)
        p = Vector(to_arm(cen))
        shift.append(float(np.linalg.norm(np.array(p) - old)))
        report.setdefault('rig', {}).setdefault('joint_shift', {})[name] = round(shift[-1], 4)
        b.head = p
        if b.parent is not None:
            b.parent.tail = p
    # rolls: local Z toward the palm side (X = flex axis)
    for b in eb:
        name = b.name
        if name in ('wrist', 'palm'):
            n = back_hand
        else:
            n = _nail_normal(scene, name.split('.')[0])
        nA = mwi[:3, :3] @ n
        d = np.array(b.tail - b.head)
        d /= np.linalg.norm(d)
        palm_side = -(nA - d * (nA @ d))
        b.align_roll(Vector(palm_side / np.linalg.norm(palm_side)))
    bpy.ops.object.mode_set(mode='OBJECT')
    # the nails ride on their .03 bone: keep them where they were
    for f, o in scene['nails'].items():
        o.matrix_world = nails_mw[f]
    bpy.context.view_layer.update()
    report.setdefault('rig', {})['joint_shift_max'] = round(max(shift) if shift else 0.0, 5)


def _finger_weights(scene, report):
    """Analytic joint windows inside each finger; the finger's share is today's, smoothed."""
    hand, rig = scene['hand'], scene['rig']
    me = hand.data
    W, gi = _weights(hand)
    Pw = gltfio.world_points(hand)
    n = len(Pw)
    E = np.array([e.vertices[:] for e in me.edges])
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    Wn = W.copy()
    plates = scene.get('plates', {})
    for f in FINGERS:
        idx = [gi[f + '.0%d' % k] for k in (1, 2, 3)]
        share = W[:, idx].sum(1)
        sel = share > 1e-4
        if not sel.any():
            continue
        chain = np.array([gltfio.bone_world(rig, f + '.01')[0]] + [gltfio.bone_world(rig, f + '.0%d' % k)[1] for k in (1, 2, 3)])
        seg = np.linalg.norm(np.diff(chain, axis=0), axis=1)
        tj = np.cumsum(np.r_[0.0, seg])
        p = Pw[sel]
        t, c, dirn = _closest_on_chain(p, chain)
        r = p - c
        rl = np.linalg.norm(r, axis=1) + 1e-12
        nb = _nail_normal(scene, f)
        bperp = nb[None, :] - dirn * (dirn @ nb)[:, None]
        bperp /= np.linalg.norm(bperp, axis=1, keepdims=True)
        cos_th = (r * bperp).sum(1) / rl
        back = (1.0 + cos_th) * 0.5  # 1 on the back, 0 on the pad
        # local radius: the finger's (median distance to the axis near t), not the vertex's own
        rad = np.median(rl[(t > tj[1] - 0.5 * seg[1]) & (t < tj[2] + 0.5 * seg[2])]) if (t > tj[1]).any() else np.median(rl)
        win = rad * (P.JOINT_WIN_BACK * back + P.JOINT_WIN_PAD * (1 - back))
        # fraction on the distal bone of each joint
        a12 = smoothstep(tj[1] - win / 2, tj[1] + win / 2, t)
        a23 = smoothstep(tj[2] - win / 2, tj[2] + win / 2, t)
        w1 = 1.0 - a12
        w2 = a12 * (1.0 - a23)
        w3 = a23
        # where today's finger share is mostly .01 near the knuckle, keep the .01 part as is
        s = share[sel]
        Wn[np.nonzero(sel)[0][:, None], np.array(idx)[None, :]] = np.stack([w1, w2, w3], 1) * s[:, None]
    # knuckles and webbing (the finger-to-palm blend, today's weights): a few
    # Laplacian passes over the vertices that blend a finger's .01 with the
    # palm, the wrist or a neighbour (a softer, wider knuckle; fewer slivers)
    first = [gi[f + '.01'] for f in FINGERS]
    hub = [gi['palm'], gi['wrist']]
    mixed = (Wn[:, first].max(1) > 0.01) & ((Wn[:, hub].sum(1) > 0.01) | ((Wn[:, first] > 0.01).sum(1) > 1))
    grow = mixed.copy()
    for _ in range(2):  # and their neighbours
        g2 = grow.copy()
        np.logical_or.at(g2, E[:, 0], grow[E[:, 1]])
        np.logical_or.at(g2, E[:, 1], grow[E[:, 0]])
        grow = g2
    for _ in range(P.KNUCKLE_SMOOTH_PASSES):
        acc = np.zeros_like(Wn)
        np.add.at(acc, E[:, 0], Wn[E[:, 1]])
        np.add.at(acc, E[:, 1], Wn[E[:, 0]])
        avg = acc / np.maximum(cnt, 1)[:, None]
        Wn[grow] = 0.5 * Wn[grow] + 0.5 * avg[grow]
    report.setdefault('rig', {})['knuckle_smoothed'] = int(grow.sum())
    # the thumb web (B9.8): thumb.01 (the metacarpal, inside the thenar) met
    # the palm over a narrow, noisy band, and that edge creased when the thumb
    # spread. More passes over a wider ring: a broad, soft falloff.
    t1 = gi['thumb.01']
    web = (Wn[:, t1] > 0.01) & (Wn[:, hub].sum(1) > 0.01)
    for _ in range(P.THUMB_WEB_GROW):
        g2 = web.copy()
        np.logical_or.at(g2, E[:, 0], web[E[:, 1]])
        np.logical_or.at(g2, E[:, 1], web[E[:, 0]])
        web = g2
    # not into the thumb's own shaft (its joints keep their crisp windows)
    web &= Wn[:, [gi['thumb.02'], gi['thumb.03']]].sum(1) < 0.5
    for _ in range(P.THUMB_WEB_SMOOTH_PASSES):
        acc = np.zeros_like(Wn)
        np.add.at(acc, E[:, 0], Wn[E[:, 1]])
        np.add.at(acc, E[:, 1], Wn[E[:, 0]])
        avg = acc / np.maximum(cnt, 1)[:, None]
        Wn[web] = 0.5 * Wn[web] + 0.5 * avg[web]
    report.setdefault('rig', {})['thumb_web_smoothed'] = int(web.sum())
    # rigid nail units (nails.py): skin within RIGID_REACH of a plate rides on .03 only
    rigid = np.full(n, -1)
    for f, pl in plates.items():
        fw = W[:, [gi[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1) > 0.5
        S = Pw - pl.centre
        lx, ly, lz = S @ pl.x, S @ pl.y, S @ pl.z
        a = pl.a_of_x(lx, ly)
        d = pl.signed_distance(a, ly)
        _, zp = pl.surf(a, ly)
        dz = lz - zp
        reach = np.sqrt(np.maximum(d, 0) ** 2 + np.where(dz < 0, dz, 0) ** 2)
        near = fw & (reach <= P.RIGID_REACH * pl.Lv) & (ly > -1.5 * pl.Lv) & (ly < (1 + P.RIGID_REACH) * pl.Lv)
        rigid[near] = gi[f + '.03']
    rw = rigid >= 0
    Wn[rw] = 0.0
    Wn[np.nonzero(rw)[0], rigid[rw]] = 1.0
    # keep max 4 influences, normalise
    for i in np.nonzero((Wn > 0).sum(1) > 4)[0]:
        o = np.argsort(Wn[i])[:-4]
        Wn[i, o] = 0.0
    Wn /= np.maximum(Wn.sum(1, keepdims=True), 1e-12)
    # write
    names = [g.name for g in hand.vertex_groups]
    for gidx_, name in enumerate(names):
        g = hand.vertex_groups[name]
        col = Wn[:, gidx_]
        old = W[:, gidx_]
        changed = np.nonzero(np.abs(col - old) > 1e-7)[0]
        zero = changed[col[changed] <= 0]
        nz = changed[col[changed] > 0]
        if len(zero):
            g.remove([int(i) for i in zero])
        for i in nz:
            g.add([int(i)], float(col[i]), 'REPLACE')
    report.setdefault('rig', {})['weights_changed'] = int((np.abs(Wn - W) > 1e-4).any(1).sum())
    return Wn


def _axes(rig):
    """Pose-space (armature) flex/spread/twist axes of each bone: local X, Z, Y."""
    out = {}
    for b in rig.data.bones:
        m = b.matrix_local.to_3x3()
        out[b.name] = (Vector(m.col[0]), Vector(m.col[2]), Vector(m.col[1]))
    return out


def _semantic_signs(rig):
    """The game's sign conventions (src/scene/HandRig.js computeRigAxes):
    spread + toward the pinky (fingers, palm, wrist); for the thumb, spread
    and twist + when they lift its local -X toward world up."""
    m = np.array(rig.matrix_world)[:3, :3]
    ph = gltfio.bone_world(rig, 'pinky.01')[0]
    ih = gltfio.bone_world(rig, 'index.01')[0]
    P = (ph - ih) / np.linalg.norm(ph - ih)
    up = np.array([0.0, 0.0, 1.0])
    out = {}
    for b in rig.data.bones:
        X = m @ np.array(b.matrix_local.to_3x3().col[0])
        if b.name.startswith('thumb'):
            sg = 1.0 if -X @ up > 0 else -1.0
            out[b.name] = (sg, sg)
        else:
            out[b.name] = (1.0 if -X @ P > 0 else -1.0, 1.0)
    return out


def set_pose(rig, pose):
    """pose: {bone: (flex, spread, twist) degrees} about each bone's local X, Z,
    Y, with the game's signs (spread + toward the pinky; thumb + inward)."""
    signs = _semantic_signs(rig)
    for pb in rig.pose.bones:
        fl, sp, tw = pose.get(pb.name, (0.0, 0.0, 0.0))
        ss, st = signs.get(pb.name, (1.0, 1.0))
        sp, tw = sp * ss, tw * st
        q = Quaternion((1, 0, 0), math.radians(fl)) @ Quaternion((0, 0, 1), math.radians(sp)) @ Quaternion((0, 1, 0), math.radians(tw))
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = q
    bpy.context.view_layer.update()


def limit_poses():
    """The QA poses: each joint at its own limits (one joint kind at a time,
    as the game moves them), the deepest curl the game asks for (HandRig
    setFingerPose(curl = 1): 35 / 45 / 25), spread, thumb and wrist limits.
    All three flex joints at their maximum at once is a fist, which linear
    blend skinning cannot do and the game never asks for (plan 4)."""
    fingers = ('index', 'middle', 'ring', 'pinky')
    out = {}
    for k in (1, 2, 3):
        flex = {}
        ext = {}
        for f in fingers + ('thumb',):
            lim = limits_of(f + '.0%d' % k)
            flex[f + '.0%d' % k] = (lim[0][1], 0, 0)
            ext[f + '.0%d' % k] = (lim[0][0], 0, 0)
        out['flex-limit-0%d' % k] = flex
        out['ext-limit-0%d' % k] = ext
    # (clamped to each joint's limits, as the game clamps it)
    out['curl'] = {f + '.0%d' % k: (min(v, limits_of(f + '.0%d' % k)[0][1]), 0, 0)
                   for f in fingers + ('thumb',) for k, v in ((1, 35), (2, 45), (3, 25))}
    spread = {}
    for f in fingers:
        s = limits_of(f + '.01')[1]
        spread[f + '.01'] = (0, s[1] if f in ('ring', 'pinky') else s[0], 0)
    out['spread'] = spread
    relaxed = {f + '.0%d' % k: (v, 0, 0) for f in fingers for k, v in ((1, 18), (2, 25), (3, 12))}
    relaxed.update(_pose_dict(GAME_THUMB_POSES['qa-relaxed'][1]))
    out['relaxed'] = relaxed
    t = limits_of('thumb.01')
    out['thumb-limit'] = {'thumb.01': (t[0][1], t[1][1], t[2][1])}
    out['thumb-limit2'] = {'thumb.01': (t[0][0], t[1][0], t[2][0])}
    out['wrist-limit'] = {'wrist': (10, 8, 0), 'palm': (10, 6, 0)}
    out['natural-rest'] = {}
    out = {k: with_thumb_rest(v) for k, v in out.items()}
    import os
    if os.environ.get('RIG_DIAG'):
        for f in fingers + ('thumb',):
            for k, a in ((1, 40), (1, 60), (2, 50), (2, 60), (2, 70), (3, 45)):
                out[f'diag-{f}-0{k}-{a}'] = {f + '.0%d' % k: (a, 0, 0)}
    return out


def _deformed(hand):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = hand.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    m = np.array(hand.matrix_world)
    co = co @ m[:3, :3].T + m[:3, 3]
    ev.to_mesh_clear()
    return co


def _ensure_armature_modifier(hand, rig):
    for md in hand.modifiers:
        if md.type == 'ARMATURE':
            md.object = rig
            return
    md = hand.modifiers.new('Armature', 'ARMATURE')
    md.object = rig


def _checks(scene, report, check, Wn):
    hand, rig = scene['hand'], scene['rig']
    me = hand.data
    _ensure_armature_modifier(hand, rig)
    rest = gltfio.world_points(hand)
    set_pose(rig, {})
    co0 = _deformed(hand)
    err = float(np.abs(co0 - rest).max())
    check('rig: rest pose reproduces the unskinned mesh', err < 1e-5, float('%.1e' % err), 1e-5)
    s = Wn.sum(1)
    check('rig: weights sum to 1, <= 4 influences', np.abs(s - 1).max() < 1e-3 and (Wn > 0).sum(1).max() <= 4,
          [round(float(np.abs(s - 1).max()), 5), int((Wn > 0).sum(1).max())])
    tris = np.array([p.vertices[:] for p in me.polygons if len(p.vertices) == 3])
    _, gi = _weights(hand)

    def fnormals(co):
        a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
        nn = np.cross(b - a, c - a)
        return nn / (np.linalg.norm(nn, axis=1, keepdims=True) + 1e-18)

    n0 = fnormals(rest)
    # joint sections (rest): vertices within a thin slab at each finger joint
    joints = []
    for f in FINGERS:
        idx = [gi[f + '.0%d' % k] for k in (1, 2, 3)]
        share = Wn[:, idx].sum(1)
        for k in (2, 3):
            head, tail = gltfio.bone_world(rig, f + '.0%d' % k)
            d = (tail - head) / np.linalg.norm(tail - head)
            L = np.linalg.norm(tail - head)
            sel = _section(rest, share > 0.9, head, d, 0.1 * L)
            if sel.sum() >= 8:
                joints.append((f + '.0%d' % k, np.nonzero(sel)[0], head))
    bone_idx = {b.name: i for i, b in enumerate(rig.data.bones)}
    worst_area = 1.0
    worst_name = ''
    flips = 0
    for name, pose in limit_poses().items():
        set_pose(rig, pose)
        co = _deformed(hand)
        # flipped triangles: posed normal against the rest normal carried by the dominant bone
        n1 = fnormals(co)
        dom = np.argmax(Wn, 1)
        names = [g.name for g in hand.vertex_groups]
        R = {}
        for gname in names:
            pb = rig.pose.bones.get(gname)
            if pb is None:
                continue
            m = np.array((rig.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ rig.matrix_world.inverted()).to_3x3())
            R[gname] = m
        rot = np.stack([R.get(names[dom[t[0]]], np.eye(3)) for t in tris])
        n0r = np.einsum('nij,nj->ni', rot, n0)
        bad = int(((n1 * n0r).sum(1) < -0.2).sum())
        flips = max(flips, bad)
        for jn, vi, head in joints:
            # area proxy: mean squared distance of the section ring to its own centroid
            q0 = rest[vi] - rest[vi].mean(0)
            q1 = co[vi] - co[vi].mean(0)
            a = float((q1 ** 2).sum(1).mean() / max((q0 ** 2).sum(1).mean(), 1e-18))
            if a < worst_area:
                worst_area, worst_name = a, f'{jn} @ {name}'
        report.setdefault('rig', {}).setdefault('poses', {})[name] = {'flipped_tris': bad}
        if bad:
            fi = np.nonzero((n1 * n0r).sum(1) < -0.2)[0]
            report['rig']['poses'][name]['at'] = [[round(float(x), 3) for x in rest[tris[t]].mean(0)] + [names[dom[tris[t][0]]]] for t in fi[:6]]
    set_pose(rig, {})
    check(f'rig: joint cross-sections >= {P.VOLUME_MIN:.0%} of rest at every limit pose', worst_area >= P.VOLUME_MIN,
          f'{worst_area:.3f} ({worst_name})', P.VOLUME_MIN)
    check('rig: no flipped triangles at the limit poses', flips == 0, flips, 0)
    # every .02 at +30 deg flex moves its fingertip toward the palm
    set_pose(rig, {f + '.02': (30, 0, 0) for f in FINGERS})
    ok = []
    for f in FINGERS:
        pb = rig.pose.bones[f + '.03']
        tip = np.array(rig.matrix_world @ pb.tail)
        _, rt = gltfio.bone_world(rig, f + '.03')
        n = _nail_normal(scene, f)
        ok.append(float((tip - rt) @ n) < 0)
    set_pose(rig, {})
    check('rig: +X flex on every .02 curls the fingertip toward the palm', all(ok), ok)


THUMB_BONES = ('thumb.01', 'thumb.02', 'thumb.03')


def _pose_dict(t):
    """[base flex, spread, twist, middle flex, last flex] -> set_pose's dict."""
    return {'thumb.01': tuple(t[:3]), 'thumb.02': (t[3], 0, 0), 'thumb.03': (t[4], 0, 0)}


def _thumb_world(rig):
    """World positions of the thumb bones' tails (the tip last), as posed now."""
    return np.array([tuple(rig.matrix_world @ rig.pose.bones[b].tail) for b in THUMB_BONES])


def _thumb_pose_mats(rig):
    """Armature-space rotations of the thumb bones, as posed now."""
    return {b: rig.pose.bones[b].matrix.to_3x3() for b in THUMB_BONES}


def _thumb_reroll(scene):
    """Thumb bones' rolls from the (moved) thumb nail, as _edit_bones does:
    the game derives each bone's axes from the file the same way."""
    rig = scene['rig']
    mwi = np.linalg.inv(np.array(rig.matrix_world))
    n = _nail_normal(scene, 'thumb')
    nails_mw = {f: o.matrix_world.copy() for f, o in scene['nails'].items()}
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name in THUMB_BONES:
        b = rig.data.edit_bones[name]
        nA = mwi[:3, :3] @ n
        d = np.array(b.tail - b.head)
        d /= np.linalg.norm(d)
        palm_side = -(nA - d * (nA @ d))
        b.align_roll(Vector(palm_side / np.linalg.norm(palm_side)))
    bpy.ops.object.mode_set(mode='OBJECT')
    for f, o in scene['nails'].items():
        o.matrix_world = nails_mw[f]
    bpy.context.view_layer.update()


def _rebind_thumb(scene, report, check, Wn):
    """Make the thumb's natural rest the bind pose (B9.8).

    1. pose the thumb at THUMB_BIND (with this build's weights) and bake the
       skinned shape into the mesh; the thumb nail rides along on thumb.03;
    2. apply that pose as the armature's rest, re-roll the thumb bones from
       the moved nail (the game's axes), move the nail plate's frame;
    3. smooth the thenar web where the bake stretched it (Taubin: no shrink);
    4. re-derive the game's thumb poses about the new bind and check them.
    """
    hand, rig = scene['hand'], scene['rig']
    me = hand.data
    assert me.shape_keys is None, 'shape keys: the bake would not carry them'
    _ensure_armature_modifier(hand, rig)
    _, gi = _weights(hand)
    # where each game thumb pose puts the thumb, about the old file
    before, before_m = {}, {}
    for name, (old, _) in GAME_THUMB_POSES.items():
        set_pose(rig, _pose_dict(old))
        before[name] = _thumb_world(rig)
        before_m[name] = _thumb_pose_mats(rig)
    # 1. bake
    set_pose(rig, THUMB_BIND)
    co = _deformed(hand)
    pb3 = rig.pose.bones['thumb.03']
    D3 = np.array(rig.matrix_world @ pb3.matrix @ pb3.bone.matrix_local.inverted() @ rig.matrix_world.inverted())
    nails_mw = {f: o.matrix_world.copy() for f, o in scene['nails'].items()}
    # 2. the pose becomes the rest
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    set_pose(rig, {})
    for f, o in scene['nails'].items():
        o.matrix_world = nails_mw[f]
    pl = scene.get('plates', {}).get('thumb')
    if pl is not None:
        R3 = D3[:3, :3]
        pl.centre = R3 @ np.asarray(pl.centre) + D3[:3, 3]
        pl.x, pl.y, pl.z = R3 @ np.asarray(pl.x), R3 @ np.asarray(pl.y), R3 @ np.asarray(pl.z)
    restA = {b.name: Matrix(b.matrix_local).to_3x3() for b in rig.data.bones}
    _thumb_reroll(scene)
    # 3. the thenar web: the thumb.01 / palm / wrist blend, a few rings out, fading
    n = len(me.vertices)
    E = np.array([e.vertices[:] for e in me.edges])
    hub = Wn[:, [gi['palm'], gi['wrist']]].sum(1)
    w1 = Wn[:, gi['thumb.01']]
    core = (w1 > 0.02) & (Wn[:, [gi['thumb.02'], gi['thumb.03']]].sum(1) < 0.5)
    ring = np.where(core, 0, -1)
    cur = core.copy()
    for k in range(1, P.THENAR_GROW + 1):
        g2 = cur.copy()
        np.logical_or.at(g2, E[:, 0], cur[E[:, 1]])
        np.logical_or.at(g2, E[:, 1], cur[E[:, 0]])
        ring[g2 & (ring < 0)] = k
        cur = g2
    fall = np.where(ring < 0, 0.0, 1.0 - np.maximum(ring, 0) / (P.THENAR_GROW + 1.0))
    moved = np.linalg.norm(co - gltfio.world_points(hand), axis=1)
    a = fall
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    X = co.copy()
    for _ in range(P.THENAR_SMOOTH_ITERS):
        for lam in (P.THENAR_SMOOTH_LAMBDA, P.THENAR_SMOOTH_MU):
            acc = np.zeros_like(X)
            np.add.at(acc, E[:, 0], X[E[:, 1]])
            np.add.at(acc, E[:, 1], X[E[:, 0]])
            L = acc / np.maximum(cnt, 1)[:, None] - X
            X = X + (lam * a)[:, None] * L
    m = np.array(hand.matrix_world)
    loc = (X - m[:3, 3]) @ np.linalg.inv(m[:3, :3]).T
    me.vertices.foreach_set('co', loc.reshape(-1))
    me.update()
    rep = report.setdefault('rig', {}).setdefault('thumb_rebind', {})
    rep['web_vertices'] = int((a > 0).sum())
    rep['smooth_shift_max'] = round(float(np.linalg.norm(X - co, axis=1).max()), 5)
    rep['bake_shift_max'] = round(float(moved.max()), 5)
    # 4. the game's poses about the new bind. A bone's skinning transform
    # (posed x rest^-1) must stay the old one, relative to the bind's: with the
    # new rest = (old bind pose) x roll, the posed bone must be (old posed) x roll.
    signs1 = _semantic_signs(rig)
    A1 = {b.name: Matrix(b.matrix_local).to_3x3() for b in rig.data.bones}
    par = {b.name: b.parent.name for b in rig.data.bones if b.parent}
    derived, worst_deg, worst_tip, worst_tab = {}, 0.0, 0.0, 0.0
    for name, (old, new) in GAME_THUMB_POSES.items():
        M1 = {par['thumb.01']: A1[par['thumb.01']]}
        out = []
        for b in THUMB_BONES:
            M1[b] = before_m[name][b] @ (restA[b].inverted() @ A1[b])
            Q = (M1[par[b]] @ A1[par[b]].inverted() @ A1[b]).inverted() @ M1[b]
            e = Q.to_euler('YZX')  # matrix = Rx(e.x) Rz(e.z) Ry(e.y)
            out.append((math.degrees(e.x), math.degrees(e.z) / signs1[b][0], math.degrees(e.y) / signs1[b][1]))
        exact = (out[0][0], out[0][1], out[0][2], out[1][0], out[2][0])
        resid = max(abs(out[1][1]), abs(out[1][2]), abs(out[2][1]), abs(out[2][2]))
        worst_deg = max(worst_deg, resid)
        derived[name] = [round(v, 3) for v in exact]
        use = new if new is not None else tuple(round(v, 1) for v in exact)
        worst_tab = max(worst_tab, max(abs(u - v) for u, v in zip(use, exact)))
        set_pose(rig, _pose_dict(use))
        after = _thumb_world(rig)
        tip = float(np.linalg.norm(after - before[name], axis=1).max())
        worst_tip = max(worst_tip, tip)
    set_pose(rig, {})
    rep['game_poses'] = derived
    rep['tip_shift_max'] = round(worst_tip, 5)
    # the thumb's length (for the tip tolerance): 0.5 degree at the tip
    tlen = sum(rig.data.bones[b].length for b in THUMB_BONES) * float(rig.matrix_world.to_scale()[0])
    check('rig: the thumb rest is the bind pose (game thumb poses re-derived about it)',
          worst_deg < 0.5 and worst_tab <= 0.051 and worst_tip < tlen * math.radians(1.0),
          {'off_axis_deg': round(worst_deg, 3), 'table_vs_exact_deg': round(worst_tab, 3),
           'tip_shift': round(worst_tip, 5)}, '< 0.5 deg / <= 0.05 deg / < 1 deg of thumb length')


def build(scene, report, check):
    _edit_bones(scene, report)
    Wn = _finger_weights(scene, report)
    _rebind_thumb(scene, report, check, Wn)
    _checks(scene, report, check, Wn)
