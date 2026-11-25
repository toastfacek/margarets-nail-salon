"""hv3 hand skeleton: bone positions and frames of a young adult female right
hand at the game's rest, in millimetres.

Hand frame: +Y distal (toward the fingertips), +X ulnar (toward the pinky),
+Z dorsal (back of the hand up). Origin: the wrist joint centre (radiocarpal),
on the forearm's axis. The hand lies palm-down on a flat towel; the forearm
slopes down behind the wrist (the game hides it under the towel roll).

Every bone is a point chain with a per-bone frame (f forward, u ulnar side,
w dorsal). Lengths are joint-centre to joint-centre, from published
radiographic means for adult women (metacarpals and phalanges), rounded.
"""
import numpy as np

FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def rot(axis, deg):
    """Rotation matrix about a unit axis (right hand rule)."""
    a = unit(axis)
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


# ---- carpus and metacarpals ------------------------------------------------------
# (X, Y, Z) of each metacarpal's base (carpometacarpal joint) and head (MCP
# joint centre). The heads make the knuckle line: middle furthest, index 2 mm
# behind it, ring 6, little finger 13; the transverse arch drops the ring and
# little finger heads palmward, and the bases sit on the deeper carpal arch.
MC = {
    'index':  ((-12.5, 23.0, 3.0), (-25.5, 81.0, 1.5)),
    'middle': ((-2.0, 24.0, 4.0), (-6.0, 83.0, 2.5)),
    'ring':   ((7.5, 23.0, 1.5), (12.8, 77.0, 0.0)),
    'pinky':  ((15.0, 21.0, -2.5), (29.0, 70.0, -3.8)),
}
# phalanx lengths P1, P2, P3 (P3: DIP centre to the bone's tuft)
PHAL = {
    'index': (40.5, 23.5, 16.5),
    'middle': (44.5, 27.5, 17.5),
    'ring': (41.5, 26.5, 17.5),
    'pinky': (32.5, 19.0, 15.5),
}
# rest pose of the long fingers, degrees: heading of P1 seen from above
# (+ toward the pinky), and flexion at MCP, PIP, DIP (+ toward the palm).
# A relaxed hand on a towel: the knuckles barely bent, the middle joints a
# little, the cascade growing toward the little finger.
REST = {
    'index':  dict(yaw=-1.5, flex=(-2.0, 7.0, 3.0), roll=-3.0),
    'middle': dict(yaw=0.5, flex=(-2.0, 7.5, 3.5), roll=0.0),
    'ring':   dict(yaw=3.5, flex=(-1.0, 8.0, 3.5), roll=3.0),
    'pinky':  dict(yaw=7.5, flex=(1.0, 9.0, 4.0), roll=7.0),
}

# ---- thumb ------------------------------------------------------------------------
THUMB_CMC = (-20.0, 15.0, -8.0)      # trapeziometacarpal joint: radial, palmar, near the wrist
THUMB_LEN = (42.0, 30.5, 22.5)       # first metacarpal, proximal phalanx, distal phalanx (to the tuft)
# first metacarpal at rest: angle from the hand's long axis seen from above
# (radial), its slope (down = negative) and pronation (its nail-side axis
# turned from straight up toward the radial side). Then each joint's flexion
# (toward its own palm side: ulnar and down) and abduction (about its dorsal
# axis, + away from the index).
THUMB_REST = dict(mc_yaw=34.0, mc_pitch=3.0, pronation=65.0,
                  flex=(16.0, 9.0), abd=(-6.0, 0.0))

TIP_EXT = {'thumb': 4.0, 'index': 3.6, 'middle': 3.8, 'ring': 3.7, 'pinky': 3.3}

# ---- wrist and forearm ----------------------------------------------------------------
FOREARM_LEN = 85.0                   # wrist centre back to the cut
FOREARM_DROP = 27.0                   # wrist extension at rest (deg): forearm slopes down behind the wrist


DESK_Z = -16.5                       # the towel under the palm pads and fingertips
TIP_AXIS_ABOVE_DESK = {'index': 6.6, 'middle': 6.8, 'ring': 6.6, 'pinky': 6.0}


def finger_chain(f, mcp_flex=None):
    """Joint positions and per-bone frames of a long finger.

    Returns dict: joints [MCP, PIP, DIP, TIPB] (4,3); frames list of 3
    (f, u, w) per phalanx; mc (base, head)."""
    base, head = (np.array(p, dtype=np.float64) for p in MC[f])
    r = REST[f]
    yaw = np.radians(r['yaw'])
    fwd = np.array([np.sin(yaw), np.cos(yaw), 0.0])
    w = np.array([0.0, 0.0, 1.0])
    # the finger's dorsal axis follows the metacarpal arch a little (roll)
    w = rot(fwd, r['roll']) @ w
    u = unit(np.cross(fwd, w))
    joints = [head]
    frames = []
    p = head.copy()
    for k, L in enumerate(PHAL[f]):
        a = r['flex'][k] if (k or mcp_flex is None) else mcp_flex
        R = rot(u, -a)
        fwd = R @ fwd
        w = R @ w
        frames.append((fwd.copy(), u.copy(), w.copy()))
        p = p + fwd * L
        joints.append(p.copy())
    return dict(joints=np.array(joints), frames=frames, mc=(base, head))


def thumb_chain():
    t = THUMB_REST
    cmc = np.array(THUMB_CMC, dtype=np.float64)
    yaw, pitch = np.radians(t['mc_yaw']), np.radians(t['mc_pitch'])
    fwd = np.array([-np.sin(yaw) * np.cos(pitch), np.cos(yaw) * np.cos(pitch), np.sin(pitch)])
    up = np.array([0.0, 0.0, 1.0])
    w = unit(up - fwd * np.dot(up, fwd))
    # pronation: the nail turns from up toward radial (-X)
    w1 = rot(fwd, t['pronation']) @ w
    w2 = rot(fwd, -t['pronation']) @ w
    w = w1 if w1[0] < w2[0] else w2
    u = unit(np.cross(fwd, w))
    joints = [cmc]
    frames = []
    p = cmc.copy()
    for k, L in enumerate(THUMB_LEN):
        if k > 0:
            R = rot(u, -t['flex'][k - 1])
            fwd, w = R @ fwd, R @ w
            A = rot(w, t['abd'][k - 1] * (1 if np.dot(np.cross(w, fwd), [-1, 0, 0]) > 0 else -1))
            fwd, u = A @ fwd, A @ u
            u = unit(np.cross(fwd, w))
        frames.append((fwd.copy(), u.copy(), w.copy()))
        p = p + fwd * L
        joints.append(p.copy())
    return dict(joints=np.array(joints), frames=frames)


def build():
    sk = {'thumb': thumb_chain()}
    for f in FINGERS[1:]:
        # solve the knuckle flex so the fingertip pad rests on the towel
        lo, hi = -25.0, 35.0
        want = DESK_Z + TIP_AXIS_ABOVE_DESK[f]
        for _ in range(40):
            m = 0.5 * (lo + hi)
            z = finger_chain(f, m)['joints'][-1][2]
            lo, hi = (m, hi) if z > want else (lo, m)
        sk[f] = finger_chain(f, 0.5 * (lo + hi))
        sk[f]['mcp_flex'] = 0.5 * (lo + hi)
    sk['wrist'] = np.zeros(3)
    return sk


def report(sk):
    lines = []
    for f in FINGERS:
        j = sk[f]['joints']
        lines.append(f + ' ' + ' '.join('(%.1f %.1f %.1f)' % tuple(p) for p in j))
    mid = sk['middle']['joints'][-1] + sk['middle']['frames'][-1][0] * TIP_EXT['middle']
    lines.append('hand length (wrist centre to middle tip, along Y): %.1f' % mid[1])
    return '\n'.join(lines)


if __name__ == '__main__':
    print(report(build()))
