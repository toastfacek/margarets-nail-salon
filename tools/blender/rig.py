"""The rig (hand-v2-plan.md section 5): the CC0 painted weights, cleaned; the
joint limits table; posing; the checks at every limit pose.

* Bones (base.make_objects): each bone's head on its joint helper (the
  re-posed MakeHuman joints), rolls from each finger's nail (local Z toward
  the palm side, so +X flex curls the finger on every finger and the thumb;
  src/scene/HandRig.js computeRigAxes derives the same axes at load).
  'palm' starts at the anatomical wrist (where v1's palm bone starts),
  'wrist' is the forearm (from the elbow), as in v1.
* Weights (clean_weights, on the cage; subdivision interpolates them):
  source groups mapped in base.load; keep the 4 largest, renormalise; two
  Laplacian passes on the finger webs and the thenar web; the nail unit
  (the bed patch and two rings of faces around it) rides on .03 only.
* Checks at every limit pose (the table mirrors src/scene/HandPoses.js):
  joint cross-section >= VOLUME_MIN of rest, no flipped triangle, weights sum
  to 1, <= 4 influences, the rest pose reproduces the mesh, and the thenar web
  keeps its shape at the game's thumb poses (max dihedral change, plan 5).
"""
import math

import bpy
import numpy as np
from mathutils import Quaternion

import params as P
from base import BI, BONES, FINGERS

# [min, max] for flex (X), spread (Z), twist (Y), degrees. Mirrors
# src/scene/HandPoses.js LIMITS (fingers, palm, wrist unchanged; the thumb's
# are about its bind, re-derived for v2 in step G1).
LIMITS = {
    'finger.01': ((-15, 45), (-12, 12), (0, 0)),
    'finger.02': ((0, 45), (0, 0), (0, 0)),
    'finger.03': ((-5, 45), (0, 0), (0, 0)),
    'thumb.01': ((-19, 21), (-47, 9), (-9, 21)),
    'thumb.02': ((-17, 33), (0, 0), (0, 0)),
    'thumb.03': ((-20, 45), (0, 0), (0, 0)),
    'palm': ((-10, 10), (-6, 6), (0, 0)),
    'wrist': ((-10, 10), (-8, 8), (0, 0)),
}
# the game's thumb poses (HandPoses.js PRESENT / writeNamed), [base flex, spread,
# twist, middle flex, last flex], about the bind
GAME_THUMB = {
    'thumbActive': (-1.2, -7.1, 14.9, -8, -5),
    'thumbOther': (1.7, 1.2, -0.9, 2, 2),
    'relaxed': (2.6, 7.3, -1.9, -2, 2),
    'fan': (-2.9, -9.3, 7.8, -10, -8),
}


def limits_of(name):
    if name in LIMITS:
        return LIMITS[name]
    f, k = name.split('.')
    return LIMITS['thumb.' + k] if f == 'thumb' else LIMITS['finger.' + k]


# ---- weights on the cage ------------------------------------------------------------
def clean_weights(cage, report, check):
    from fit import grow
    W = cage.W.copy()
    E = cage.edges()
    n = len(W)
    # keep the 4 largest
    for i in np.nonzero((W > 0).sum(1) > 4)[0]:
        W[i, np.argsort(W[i])[:-4]] = 0.0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    # the webs: a .01 against the palm / wrist / a neighbour, and the thenar
    first = W[:, [BI[f + '.01'] for f in FINGERS]]
    hub = W[:, [BI['palm'], BI['wrist']]].sum(1)
    web = ((first.max(1) > 0.02) & (hub > 0.02)) | ((first > 0.02).sum(1) > 1)
    web = grow(E, web, 1) >= 0
    web &= W[:, [BI[f + '.0%d' % k] for f in FINGERS for k in (2, 3)]].sum(1) < 0.5
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    for _ in range(P.WEIGHT_SMOOTH_PASSES):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W[web] = 0.5 * W[web] + 0.5 * (acc / np.maximum(cnt, 1)[:, None])[web]
    # inside the fingers: the joint blends (.01/.02, .02/.03) get a few passes too
    # (MakeHuman's painted bands are narrow; a wider blend folds less when flexed)
    fj = np.zeros(n, dtype=bool)
    for f in FINGERS:
        cols = W[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]]
        fj |= ((cols > 0.02).sum(1) > 1)
    fj = grow(E, fj, 1) >= 0
    for _ in range(P.FINGER_JOINT_PASSES):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W[fj] = 0.5 * W[fj] + 0.5 * (acc / np.maximum(cnt, 1)[:, None])[fj]
    # the thenar web: the thumb's base bones against the palm / the index base,
    # a few rings out, more passes (a broad, soft falloff: no crease when it moves)
    th = W[:, BI['thumb.01']] + W[:, BI['thumb.02']]
    other = W[:, [BI['palm'], BI['wrist'], BI['index.01']]].sum(1)
    thenar = grow(E, (th > 0.02) & (other > 0.02), P.THENAR_RINGS) >= 0
    thenar &= W[:, BI['thumb.03']] < 0.5
    for _ in range(P.THENAR_SMOOTH_PASSES):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W[thenar] = 0.5 * W[thenar] + 0.5 * (acc / np.maximum(cnt, 1)[:, None])[thenar]
    # the nail unit is rigid on .03
    rigid = {}
    for f in FINGERS:
        faces = np.concatenate([cage.nails[f]] + list(cage.folds[f][:P.RIGID_RINGS]))
        vi = np.unique(cage.F[faces])
        W[vi] = 0.0
        W[vi, BI[f + '.03']] = 1.0
        rigid[f] = int(len(vi))
    # soften the rigid unit's border: the ring just outside it blends
    rig_v = np.zeros(n, dtype=bool)
    for f in FINGERS:
        rig_v[np.unique(cage.F[np.concatenate([cage.nails[f]] + list(cage.folds[f][:P.RIGID_RINGS]))])] = True
    border = (grow(E, rig_v, 2) > 0)
    for _ in range(P.RIGID_BORDER_PASSES):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W[border] = 0.5 * W[border] + 0.5 * (acc / np.maximum(cnt, 1)[:, None])[border]
    # 4 influences again after the smoothing, renormalise, drop dust
    W[W < 1e-4] = 0.0
    for i in np.nonzero((W > 0).sum(1) > 4)[0]:
        W[i, np.argsort(W[i])[:-4]] = 0.0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    cage.W = W
    report.setdefault('rig', {}).update({'web_smoothed': int(web.sum()), 'thenar_smoothed': int(thenar.sum()), 'rigid_nail_verts': rigid})
    return cage


# ---- posing (Blender) ---------------------------------------------------------------
def semantic_signs(rig):
    """The game's sign conventions (HandRig.computeRigAxes): spread + toward the
    pinky (fingers, palm, wrist); for the thumb, spread and twist + when they
    lift its local -X toward world up."""
    m = np.array(rig.matrix_world)[:3, :3]
    ph = np.array(rig.matrix_world @ rig.data.bones['pinky.01'].head_local)
    ih = np.array(rig.matrix_world @ rig.data.bones['index.01'].head_local)
    Pp = (ph - ih) / np.linalg.norm(ph - ih)
    up = np.array([0.0, 0.0, 1.0])
    out = {}
    for b in rig.data.bones:
        X = m @ np.array(b.matrix_local.to_3x3().col[0])
        if b.name.startswith('thumb'):
            sg = 1.0 if -X @ up > 0 else -1.0
            out[b.name] = (sg, sg)
        else:
            out[b.name] = (1.0 if -X @ Pp > 0 else -1.0, 1.0)
    return out


def set_pose(rig, pose):
    """pose: {bone: (flex, spread, twist)} degrees about each bone's local X, Z, Y."""
    signs = semantic_signs(rig)
    for pb in rig.pose.bones:
        fl, sp, tw = pose.get(pb.name, (0.0, 0.0, 0.0))
        ss, st = signs.get(pb.name, (1.0, 1.0))
        q = Quaternion((1, 0, 0), math.radians(fl)) @ Quaternion((0, 0, 1), math.radians(sp * ss)) @ \
            Quaternion((0, 1, 0), math.radians(tw * st))
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = q
    bpy.context.view_layer.update()


def thumb_pose(t):
    return {'thumb.01': tuple(t[:3]), 'thumb.02': (t[3], 0, 0), 'thumb.03': (t[4], 0, 0)}


def game_pose(name):
    """The game's named poses (HandPoses.js), for QA and the viewer checks."""
    out = {}
    if name == 'relaxed':
        out.update(thumb_pose(GAME_THUMB['relaxed']))
        for f, sp in zip(('index', 'middle', 'ring', 'pinky'), (-1, 0, 1, 2)):
            out[f + '.01'] = (6, sp, 0)
            out[f + '.02'] = (10, 0, 0)
            out[f + '.03'] = (5, 0, 0)
    elif name == 'fan':
        out.update(thumb_pose(GAME_THUMB['fan']))
        for f, sp in zip(('index', 'middle', 'ring', 'pinky'), (-9, -2, 5, 10)):
            out[f + '.01'] = (-5 if f != 'pinky' else -4, sp, 0)
    elif name.startswith('present'):
        i = int(name[-1])
        for fi, f in enumerate(FINGERS):
            if fi == 0:
                out.update(thumb_pose(GAME_THUMB['thumbActive' if i == 0 else 'thumbOther']))
            elif fi == i:
                out[f + '.01'], out[f + '.02'], out[f + '.03'] = (-8, 0, 0), (4, 0, 0), (4, 0, 0)
            else:
                out[f + '.01'] = (8, 3 if fi > i else -3, 0)
                out[f + '.02'], out[f + '.03'] = (10, 0, 0), (5, 0, 0)
    return out


def limit_poses():
    fingers = ('index', 'middle', 'ring', 'pinky')
    out = {}
    for k in (1, 2, 3):
        flex, ext = {}, {}
        for f in fingers + ('thumb',):
            lim = limits_of(f + '.0%d' % k)
            flex[f + '.0%d' % k] = (lim[0][1], 0, 0)
            ext[f + '.0%d' % k] = (lim[0][0], 0, 0)
        out['flex-limit-0%d' % k] = flex
        out['ext-limit-0%d' % k] = ext
    out['curl'] = {f + '.0%d' % k: (min(v, limits_of(f + '.0%d' % k)[0][1]), 0, 0)
                   for f in fingers + ('thumb',) for k, v in ((1, 35), (2, 45), (3, 25))}
    spread = {}
    for f in fingers:
        s = limits_of(f + '.01')[1]
        spread[f + '.01'] = (0, s[1] if f in ('ring', 'pinky') else s[0], 0)
    out['spread'] = spread
    t = limits_of('thumb.01')
    out['thumb-limit'] = {'thumb.01': (t[0][1], t[1][1], t[2][1])}
    out['thumb-limit2'] = {'thumb.01': (t[0][0], t[1][0], t[2][0])}
    out['wrist-limit'] = {'wrist': (10, 8, 0), 'palm': (10, 6, 0)}
    for g in ('relaxed', 'fan', 'present0', 'present1', 'present4'):
        out['game-' + g] = game_pose(g)
    return out


def deformed(hand):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = hand.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    m = np.array(hand.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def mesh_weights(hand):
    me = hand.data
    W = np.zeros((len(me.vertices), len(BONES)))
    gi = {g.index: BI[g.name] for g in hand.vertex_groups}
    for v in me.vertices:
        for g in v.groups:
            W[v.index, gi[g.group]] = g.weight
    return W


def world_points(obj):
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get('co', co)
    m = np.array(obj.matrix_world)
    return co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]


def checks(scene, report, check):
    hand, rig = scene['hand'], scene['rig']
    me = hand.data
    rest = world_points(hand)
    set_pose(rig, {})
    err = float(np.abs(deformed(hand) - rest).max())
    check('rig: rest pose reproduces the unskinned mesh', err < 1e-5, float('%.1e' % err), 1e-5)
    W = mesh_weights(hand)
    s = W.sum(1)
    check('rig: weights sum to 1, <= 4 influences', np.abs(s - 1).max() < 1e-3 and (W > 0).sum(1).max() <= 4,
          [round(float(np.abs(s - 1).max()), 5), int((W > 0).sum(1).max())])
    tris = np.array([(p.vertices[0], p.vertices[i], p.vertices[i + 1]) for p in me.polygons for i in range(1, len(p.vertices) - 1)])

    def fnormals(co):
        nn = np.cross(co[tris[:, 1]] - co[tris[:, 0]], co[tris[:, 2]] - co[tris[:, 0]])
        return nn / (np.linalg.norm(nn, axis=1, keepdims=True) + 1e-18)

    n0 = fnormals(rest)
    # degenerate slivers (none expected) carry no orientation: leave them out
    area = 0.5 * np.linalg.norm(np.cross(rest[tris[:, 1]] - rest[tris[:, 0]], rest[tris[:, 2]] - rest[tris[:, 0]]), axis=1)
    keep = area > 1e-3 * np.median(area)
    tris, n0 = tris[keep], n0[keep]
    # joint sections (rest): skin within a thin slab at each finger joint
    joints = []
    for f in FINGERS:
        share = W[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1)
        for k in (2, 3):
            b = rig.data.bones[f + '.0%d' % k]
            head = np.array(rig.matrix_world @ b.head_local)
            tail = np.array(rig.matrix_world @ b.tail_local)
            d = (tail - head) / np.linalg.norm(tail - head)
            sel = (share > 0.9) & (np.abs((rest - head) @ d) < 0.1 * np.linalg.norm(tail - head))
            if sel.sum() >= 8:
                joints.append((f + '.0%d' % k, np.nonzero(sel)[0]))
    # the thenar web: faces between thumb.01 and the palm / index base
    t1 = W[:, BI['thumb.01']]
    webv = (t1 > 0.05) & (t1 < 0.95)
    tri_web = webv[tris].all(1)
    adj = {}
    for ti, t in enumerate(tris):
        if not tri_web[ti]:
            continue
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            adj.setdefault((min(a, b), max(a, b)), []).append(ti)
    pairs = np.array([v for v in adj.values() if len(v) == 2])

    def dihedral(nrm):
        return np.degrees(np.arccos(np.clip((nrm[pairs[:, 0]] * nrm[pairs[:, 1]]).sum(1), -1, 1)))

    d0 = dihedral(n0) if len(pairs) else None
    dom = np.argmax(W, 1)
    worst_area, worst_name, flips, web_worst = 1.0, '', 0, {}
    rep = report.setdefault('rig', {}).setdefault('poses', {})
    for name, pose in limit_poses().items():
        set_pose(rig, pose)
        co = deformed(hand)
        n1 = fnormals(co)
        R = {}
        for b in BONES:
            pb = rig.pose.bones[b]
            R[b] = np.array((rig.matrix_world @ pb.matrix @ pb.bone.matrix_local.inverted() @ rig.matrix_world.inverted()).to_3x3())
        rot = np.stack([R[BONES[dom[t[0]]]] for t in tris])
        n0r = np.einsum('nij,nj->ni', rot, n0)
        bad = int(((n1 * n0r).sum(1) < -0.2).sum())
        flips = max(flips, bad)
        for jn, vi in joints:
            q0 = rest[vi] - rest[vi].mean(0)
            q1 = co[vi] - co[vi].mean(0)
            a = float((q1 ** 2).sum(1).mean() / max((q0 ** 2).sum(1).mean(), 1e-18))
            if a < worst_area:
                worst_area, worst_name = a, f'{jn} @ {name}'
        rep[name] = {'flipped_tris': bad}
        if bad:
            fi = np.nonzero((n1 * n0r).sum(1) < -0.2)[0]
            rep[name]['at'] = [[round(float(x), 3) for x in rest[tris[t]].mean(0)] + [BONES[dom[tris[t][0]]]] for t in fi[:4]]
        if d0 is not None and name in ('game-relaxed', 'game-present0', 'game-fan'):
            dd = np.abs(dihedral(n1) - d0)
            web_worst[name] = round(float(dd.max()), 2)
            k = int(np.argmax(dd))
            rep[name]['web_worst_at'] = [round(float(x), 3) for x in rest[tris[pairs[k, 0]]].mean(0)]
    set_pose(rig, {})
    check(f'rig: joint cross-sections >= {P.VOLUME_MIN:.0%} of rest at every limit pose', worst_area >= P.VOLUME_MIN,
          f'{worst_area:.3f} ({worst_name})', P.VOLUME_MIN)
    check('rig: no flipped triangles at the limit poses', flips == 0, flips, 0)
    check('rig: thenar web keeps its shape at the game\'s thumb poses (max dihedral change)',
          bool(web_worst) and max(web_worst.values()) < P.WEB_DIHEDRAL_MAX, web_worst, f'< {P.WEB_DIHEDRAL_MAX} deg')
    # every .02 at +30 deg flex moves its fingertip toward the palm
    set_pose(rig, {f + '.02': (30, 0, 0) for f in FINGERS})
    ok = []
    for f in FINGERS:
        pb = rig.pose.bones[f + '.03']
        tip = np.array(rig.matrix_world @ pb.tail)
        rt = np.array(rig.matrix_world @ pb.bone.tail_local)
        n = scene['nail_normal'][f]
        ok.append(bool((tip - rt) @ n < 0))
    set_pose(rig, {})
    check('rig: +X flex on every .02 curls the fingertip toward the palm', all(ok), ok)
