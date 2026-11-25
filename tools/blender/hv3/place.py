"""Placement of the hv3 hand in the game's world (v1's frame, Blender Z up):
one similarity transform (uniform scale, rotation, translation), least
squares on landmarks: the palm bone head, the four knuckles and the four
long-finger nail centres, against v1's (tools/blender/params.py)."""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import params as P  # noqa: E402  (hv2's table: v1's landmarks)

LONG = ('index', 'middle', 'ring', 'pinky')


def palm_head(sk):
    import skeleton as SK
    b = np.array([SK.MC[f][0] for f in LONG])
    return b.mean(0)


def landmarks(hand):
    sk = hand.sk
    src, dst, names = [], [], []
    src.append(palm_head(sk))
    dst.append(P.V1_BONE_HEAD['palm'])
    names.append('palm')
    for f in LONG:
        src.append(sk[f]['joints'][0])
        dst.append(P.V1_BONE_HEAD[f + '.01'])
        names.append(f + '.01')
    for f in LONG:
        nu = hand.nails[f]
        y = 0.5 * (nu.yc + nu.yh)
        src.append(nu.o + nu.F * y + nu.W * float(nu.z_top(0.0, y)))
        dst.append(P.V1_NAIL_CENTRE[f])
        names.append(f + ' nail')
    return np.array(src), np.array(dst), names


def similarity(A, B, w=None):
    """s, R, t minimising sum w |s R a + t - b|^2 (Umeyama)."""
    w = np.ones(len(A)) if w is None else np.asarray(w, dtype=np.float64)
    w = w / w.sum()
    ma, mb = w @ A, w @ B
    A0, B0 = A - ma, B - mb
    C = (B0 * w[:, None]).T @ A0
    U, S, Vt = np.linalg.svd(C)
    D = np.eye(3)
    D[2, 2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ D @ Vt
    va = (w * (A0 ** 2).sum(1)).sum()
    s = np.trace(np.diag(S) @ D) / va
    t = mb - s * R @ ma
    return s, R, t


def solve(hand):
    A, B, names = landmarks(hand)
    # the nails count double: they are what the game frames and paints
    w = [1.0] * 5 + [2.0] * 4
    s, R, t = similarity(A, B, w)
    res = np.linalg.norm((s * (R @ A.T)).T + t - B, axis=1)
    return dict(s=s, R=R, t=t, resid=dict(zip(names, res)), mm_per_unit=1.0 / s)


def apply(T, X):
    return (T['s'] * (T['R'] @ np.asarray(X, dtype=np.float64).T)).T + T['t']


def forearm_drop(T):
    """The wrist extension that points our forearm along v1's: the angle in
    the hand's sagittal plane (Y-Z) between -Y and v1's forearm direction."""
    v1 = np.array(P.V1_WRIST_HEAD) - np.array(P.V1_BONE_HEAD['palm'])
    d = T['R'].T @ (v1 / np.linalg.norm(v1))     # into the hand frame
    return float(np.degrees(np.arctan2(-d[2], -d[1]))), d


if __name__ == '__main__':
    import hand as H
    h = H.Hand(detail=False)
    T = solve(h)
    print('mm per unit %.1f' % T['mm_per_unit'])
    for k, v in T['resid'].items():
        print('  %-12s %.4f units = %.1f mm' % (k, v, v * T['mm_per_unit']))
    print('forearm drop (deg), dir in hand frame', forearm_drop(T))
