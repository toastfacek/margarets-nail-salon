"""Skin shape (hand-plan.md 3.1): vertex moves only, plus lighter forearm.

1. Decimate what is never looked at: the forearm past the wrist (under the
   towel and the arm rest) and the palm's underside (it lies on the towel).
   Weights are interpolated by the collapse, then normalised (max 4).
2. Fingers, in cylinder coordinates around each finger's bone chain
   (t = arc length along .01 .. .03, theta from the back of the finger):
   a gentle taper to the last joint, soft bulges at the middle and last
   joints (more on the back than the sides) with a slight waist between,
   a fuller pad under the fingertip and a rounder tip.
3. Back of the hand: soft mounds over the four big knuckles, each with a
   shallow dimple (a young hand: dimples, not bony bumps).
Runs before nails.py, which fits the nail units to the shaped fingertips.
"""
import bmesh
import bpy
import numpy as np
from mathutils import Vector

import gltfio
import params as P
from gltfio import FINGERS


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _weights(obj):
    names = [g.name for g in obj.vertex_groups]
    me = obj.data
    W = np.zeros((len(me.vertices), len(names)))
    for v in me.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return W, {n: i for i, n in enumerate(names)}


def _decimate(hand, report):
    me = hand.data
    W, gi = _weights(hand)
    Pw = gltfio.world_points(hand)
    me.update()
    N = np.array([tuple(v.normal) for v in me.vertices])
    mwn = np.array(hand.matrix_world.to_3x3())
    Nw = N @ mwn.T
    arm = (W[:, gi['wrist']] >= 0.99) & (Pw[:, 0] > P.ARM_X_KEEP)
    palm_down = (W[:, gi['palm']] + W[:, gi['wrist']] >= 0.99) & (Nw[:, 2] < -0.55) & ~arm
    before = len(me.vertices)
    bpy.context.view_layer.objects.active = hand
    for o in bpy.context.view_layer.objects:
        o.select_set(o == hand)
    for sel, ratio in ((arm, P.ARM_RATIO), (palm_down, P.PALM_DOWN_RATIO)):
        bpy.ops.object.mode_set(mode='EDIT')
        bm = bmesh.from_edit_mesh(me)
        bm.verts.ensure_lookup_table()
        for f in bm.faces:
            f.select = all(sel[v.index] for v in f.verts)
        bm.select_flush_mode()
        bmesh.update_edit_mesh(me)
        bpy.ops.mesh.decimate(ratio=ratio)
        bpy.ops.object.mode_set(mode='OBJECT')
        # indices changed: recompute the second selection on the new mesh
        W, gi = _weights(hand)
        Pw = gltfio.world_points(hand)
        me.update()
        Nw = np.array([tuple(v.normal) for v in me.vertices]) @ mwn.T
        arm = (W[:, gi['wrist']] >= 0.99) & (Pw[:, 0] > P.ARM_X_KEEP)
        palm_down = (W[:, gi['palm']] + W[:, gi['wrist']] >= 0.99) & (Nw[:, 2] < -0.55) & ~arm
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    report['counts']['decimated'] = before - len(me.vertices)


def _chain(rig, f):
    pts = [gltfio.bone_world(rig, f + '.01')[0]]
    for k in (1, 2, 3):
        pts.append(gltfio.bone_world(rig, f + '.0%d' % k)[1])
    return np.array(pts)


def _closest_on_chain(p, chain):
    """t (arc length), axis point and tangent of the closest point on a polyline."""
    best = None
    s0 = 0.0
    out_t = np.zeros(len(p))
    out_c = np.zeros_like(p)
    out_d = np.zeros_like(p)
    best_d2 = np.full(len(p), np.inf)
    for i in range(len(chain) - 1):
        a, b = chain[i], chain[i + 1]
        ab = b - a
        L = np.linalg.norm(ab)
        u = np.clip(((p - a) @ ab) / (L * L), 0.0, 1.0)
        # past the tip, extend the last segment (fingertip verts)
        if i == len(chain) - 2:
            u = np.maximum(((p - a) @ ab) / (L * L), 0.0)
        c = a + u[:, None] * ab
        d2 = ((p - c) ** 2).sum(1)
        m = d2 < best_d2
        best_d2[m] = d2[m]
        out_t[m] = s0 + u[m] * L
        out_c[m] = c[m]
        out_d[m] = ab / L
        s0 += L
    return out_t, out_c, out_d


def _shape_fingers(hand, rig, nails, report):
    me = hand.data
    W, gi = _weights(hand)
    mw = np.array(hand.matrix_world)
    mwi = np.linalg.inv(mw)
    Pw = gltfio.world_points(hand)
    new = Pw.copy()
    moved = 0
    for f in FINGERS:
        wf = W[:, [gi[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1)
        sel = wf > 0.05
        if not sel.any():
            continue
        chain = _chain(rig, f)
        seg = np.linalg.norm(np.diff(chain, axis=0), axis=1)
        tj = np.cumsum(np.r_[0.0, seg])  # knuckle, middle joint, last joint, tip
        # back of the finger: the old nail's outward normal
        _, _, _, back = gltfio.pca_frame(gltfio.world_points(nails[f]), rig, f)
        p = Pw[sel]
        t, c, dirn = _closest_on_chain(p, chain)
        r = p - c
        bperp = back[None, :] - dirn * (dirn @ back)[:, None]
        bperp /= np.linalg.norm(bperp, axis=1, keepdims=True)
        rl = np.linalg.norm(r, axis=1) + 1e-12
        cos_th = (r * bperp).sum(1) / rl
        back_w = np.clip(cos_th, 0, 1) ** 2
        side_w = 1.0 - cos_th ** 2
        pad_w = np.clip(-cos_th, 0, 1) ** 1.5
        # taper to the last joint
        k = 1.0 - (1.0 - P.TAPER_END) * smoothstep(tj[0] + 0.2 * seg[0], tj[2], t)
        # joints: soft bulges with a slight waist between
        g = np.zeros_like(t)
        for jt, L in ((tj[1], seg[1]), (tj[2], seg[2])):
            g = np.maximum(g, np.exp(-((t - jt) / (P.JOINT_BULGE_WIDTH * L)) ** 2))
        k *= 1.0 + g * (P.JOINT_BULGE_BACK * back_w + P.JOINT_BULGE_SIDE * side_w)
        mid = np.exp(-((t - (tj[1] + tj[2]) / 2) / (0.3 * seg[1])) ** 2) + np.exp(-((t - (tj[2] + tj[3]) / 2 + 0.1 * seg[2]) / (0.25 * seg[2])) ** 2) * 0.5
        k *= 1.0 - P.WAIST * mid * (1 - pad_w)
        # fingertip: fuller pad under it, rounder tip
        tipz = smoothstep(tj[2] + 0.15 * seg[2], tj[3] - 0.1 * seg[2], t)
        k *= 1.0 + P.PAD_FULL * tipz * pad_w
        # radial scaling; finger membership fades the effect out at the webbing
        fade = smoothstep(0.35, 0.9, wf[sel])
        k = 1.0 + (k - 1.0) * fade
        q = c + r * k[:, None]
        # rounder tip: past the tip joint end, pull the very end in along the axis a little
        over = np.maximum(t - (tj[3] - P.TIP_ROUND * seg[2]), 0.0) / (P.TIP_ROUND * seg[2])
        q -= dirn * (0.12 * P.TIP_ROUND * seg[2] * over ** 2 * fade)[:, None]
        new[sel] = q
        moved += int(sel.sum())
    # back of the hand: knuckle mounds and dimples
    me.update()
    Nw = np.array([tuple(v.normal) for v in me.vertices]) @ mw[:3, :3].T
    up = np.array([0.0, 0.0, 1.0])
    for f in ('index', 'middle', 'ring', 'pinky'):
        head = gltfio.bone_world(rig, f + '.01')[0]
        # the knuckle's top: the skin above the joint
        d = np.linalg.norm((new - head)[:, :2], axis=1)
        top = (Nw @ up > 0.35) & (new[:, 2] > head[2])
        rad = P.KNUCKLE_RADIUS
        bump = P.KNUCKLE_MOUND * np.exp(-(d / rad) ** 2) - P.KNUCKLE_DIMPLE * np.exp(-(d / (0.35 * rad)) ** 2)
        bump = np.where(top, bump * smoothstep(0.35, 0.7, Nw @ up), 0.0)
        new += np.outer(bump, up)
    loc = (np.c_[new, np.ones(len(new))] @ mwi.T)[:, :3]
    me.vertices.foreach_set('co', loc.astype(np.float32).ravel())
    me.update()
    report['counts']['sculpt_moved'] = moved


def build(scene, report, check):
    hand, rig = scene['hand'], scene['rig']
    if 'custom_normal' in hand.data.attributes:
        hand.data.attributes.remove(hand.data.attributes['custom_normal'])
    hand.data.shade_smooth()
    _decimate(hand, report)
    _shape_fingers(hand, rig, scene['nails'], report)
    W, _ = _weights(hand)
    s = W.sum(1)
    check('sculpt: weights sum to 1, <= 4 influences', np.abs(s - 1).max() < 1e-3 and (W > 0).sum(1).max() <= 4,
          [round(float(np.abs(s - 1).max()), 5), int((W > 0).sum(1).max())])
