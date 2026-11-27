"""The source hand (hand-v2-plan.md sections 2, 5): hand-cage.json -> a numpy
cage in a hand frame, and later -> the Blender mesh, armature and vertex groups.

* load(): the committed cage (MakeHuman / MPFB2 base mesh, CC0) with the shape
  targets of params.TARGETS applied as plain vertex deltas (to the vertices and
  to the joint helper centres, which are vertices of the same OBJ), the source
  weights mapped onto the game's 17 bones, the nail faces, the base UVs.
  Coordinates: the hand frame, in millimetres: origin at the wrist joint,
  +x toward the middle fingertip, +y toward the thumb side, +z out of the back
  of the hand. fit.py poses and places it; nothing here is in game space yet.
* make_objects(): the finished cage (game space, Blender Z up) -> 'Hand'
  (quads, smooth, 17 vertex groups, the base UVs as 'MHUV') parented to
  'Hand_Rig' (17 bones; each bone's head at its joint, rolls from the nails).
"""
import json
import os

import numpy as np

import params as P

FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']
BONES = ['wrist', 'palm'] + [f'{f}.0{k}' for f in FINGERS for k in (1, 2, 3)]
BI = {b: i for i, b in enumerate(BONES)}
PARENT = {'wrist': None, 'palm': 'wrist'}
for _f in FINGERS:
    PARENT[_f + '.01'] = 'palm'
    PARENT[_f + '.02'] = _f + '.01'
    PARENT[_f + '.03'] = _f + '.02'
HERE = os.path.dirname(os.path.abspath(__file__))


def joint(f, k):
    """MakeHuman helper name of finger f's joint k (1 = base .. 4 = tip)."""
    return f'joint-r-finger-{FINGERS.index(f) + 1}-{k}'


class Cage:
    """The hand as a quad cage plus everything that rides on it (numpy)."""

    def __init__(self, V, F, uv, fuv, W, joints, nails, folds, other):
        self.V, self.F, self.uv, self.fuv = V, F, uv, fuv
        self.W = W                      # (n, 17) weights, BONES order
        self.joints = joints            # name -> (3,) position
        self.nails = nails              # finger -> face indices (the nail bed patch)
        self.folds = folds              # finger -> [ring 1 faces, ring 2 faces]
        self.other = other              # (n,) weight of groups that map to no bone (upper arm)

    # --- topology helpers ---------------------------------------------------------
    def edges(self):
        e = np.concatenate([self.F[:, [i, (i + 1) % 4]] for i in range(4)])
        e = np.sort(e, 1)
        return np.unique(e, axis=0)

    def face_normals(self, V=None):
        V = self.V if V is None else V
        F = self.F
        n = np.cross(V[F[:, 2]] - V[F[:, 0]], V[F[:, 3]] - V[F[:, 1]]) * 0.5
        return n

    def vertex_normals(self, V=None):
        V = self.V if V is None else V
        fn = self.face_normals(V)
        vn = np.zeros_like(V)
        for i in range(4):
            np.add.at(vn, self.F[:, i], fn)
        return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)

    def nail_normal(self, f, V=None):
        n = self.face_normals(V)[self.nails[f]].sum(0)
        return n / np.linalg.norm(n)

    def nail_centre(self, f, V=None):
        V = self.V if V is None else V
        return V[np.unique(self.F[self.nails[f]])].mean(0)

    def bone(self, name):
        """(head, tail) of a bone from the joints."""
        if name == 'wrist':
            return self.joints['wrist'], self.joints['palm']
        if name == 'palm':
            return self.joints['palm'], self.joints['middle.1']
        f, k = name.split('.')
        k = int(k)
        return self.joints[f'{f}.{k}'], self.joints[f'{f}.{k + 1}']


def load(report=None):
    with open(os.path.join(HERE, P.CAGE)) as fh:
        c = json.load(fh)
    V = np.array(c['verts'], dtype=np.float64)
    J = {k: np.array(v, dtype=np.float64) for k, v in c['joints'].items()}
    for name, w in P.TARGETS.items():
        t = c['targets'][name]
        V[t['index']] += w * np.array(t['delta'])
        for j, d in t['joints'].items():
            J[j] = J[j] + w * np.array(d)
    n = len(V)
    W = np.zeros((n, len(BONES)))
    tot = np.zeros(n)
    for g, rows in c['weights'].items():
        idx = np.array([r[0] for r in rows], dtype=np.int64)
        w = np.array([r[1] for r in rows])
        np.add.at(tot, idx, w)
        if g in P.WEIGHT_MAP:
            np.add.at(W[:, BI[P.WEIGHT_MAP[g]]], idx, w)
    other = np.clip(tot - W.sum(1), 0, None) / np.maximum(tot, 1e-12)
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)

    # the hand frame: origin at the wrist joint, x to the middle fingertip,
    # y toward the index (thumb side), z = x cross y (the back of the hand)
    wr = J['joint-r-hand']
    x = J[joint('middle', 4)] - wr
    x /= np.linalg.norm(x)
    s = J[joint('index', 1)] - J[joint('pinky', 1)]
    s -= x * (s @ x)
    s /= np.linalg.norm(s)
    z = np.cross(x, s)
    R = np.stack([x, s, z])

    def tf(p):
        return (np.asarray(p) - wr) @ R.T * P.MH_MM

    joints = {'wrist': tf(wr), 'palm': tf((J['joint-r-hand-2'] + J['joint-r-hand-3']) / 2)}
    for f in FINGERS:
        for k in (1, 2, 3, 4):
            joints[f'{f}.{k}'] = tf(J[joint(f, k)])
    joints['elbow'] = tf(J['joint-r-elbow'])
    cage = Cage(tf(V), np.array(c['quads'], dtype=np.int64), np.array(c['uv']), np.array(c['faceUV'], dtype=np.int64),
                W, joints, {f: np.array(v, dtype=np.int64) for f, v in c['nailFaces'].items()},
                {f: [np.array(r, dtype=np.int64) for r in v] for f, v in c['foldRing'].items()}, other)
    for f in FINGERS:
        assert cage.nail_normal(f) @ np.array([0, 0, 1.0]) > -0.2 or f == 'thumb', f
    if report is not None:
        report['source'] = {'cage': P.CAGE, 'commit': c['source']['commit'], 'verts': len(V), 'quads': len(cage.F),
                            'targets': P.TARGETS}
    return cage


def make_objects(cage, rolls_from):
    """Blender objects for a finished cage (coordinates already in game space,
    Blender Z up). rolls_from: finger -> outward nail normal (world), used for
    the bones' rolls (local Z toward the palm side; +X flex curls the finger)."""
    import bpy
    from mathutils import Vector

    me = bpy.data.meshes.new('Hand')
    me.from_pydata(cage.V.tolist(), [], cage.F.tolist())
    me.update()
    uvl = me.uv_layers.new(name='MHUV')
    uvl.data.foreach_set('uv', cage.uv[cage.fuv].reshape(-1, 2).astype(np.float32).ravel())
    me.shade_smooth()
    hand = bpy.data.objects.new('Hand', me)
    bpy.context.scene.collection.objects.link(hand)
    for b in BONES:
        g = hand.vertex_groups.new(name=b)
        col = cage.W[:, BI[b]]
        for i in np.nonzero(col > 0)[0]:
            g.add([int(i)], float(col[i]), 'REPLACE')

    arm = bpy.data.armatures.new('Hand_Rig')
    rig = bpy.data.objects.new('Hand_Rig', arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    for o in bpy.context.view_layer.objects:
        o.select_set(o == rig)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    made = {}
    for b in BONES:
        h, t = cage.bone(b)
        e = eb.new(b)
        e.head, e.tail = Vector(h), Vector(t)
        if PARENT[b]:
            e.parent = made[PARENT[b]]
            # connected chains inside a finger (the head is the parent's tail)
            e.use_connect = b.endswith('.02') or b.endswith('.03')
        n = np.asarray(rolls_from['middle' if b in ('wrist', 'palm') else b.split('.')[0]])
        d = np.array(e.tail - e.head)
        d /= np.linalg.norm(d)
        palm_side = -(n - d * (n @ d))
        e.align_roll(Vector(palm_side / np.linalg.norm(palm_side)))
        made[b] = e
    bpy.ops.object.mode_set(mode='OBJECT')
    hand.parent = rig
    md = hand.modifiers.new('Armature', 'ARMATURE')
    md.object = rig
    return hand, rig
