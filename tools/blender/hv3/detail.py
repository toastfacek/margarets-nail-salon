"""Skin creases for the hv3 hand: shallow grooves added to the signed
distance (positive = the surface moves in). Palm creases are 2D curves on the
palm's underside; finger creases are lines across the volar side at the
joints and short arcs over the back of the middle and last joints."""
import numpy as np

from sdf import smoothstep

# palm creases (hand frame X, Y), depth and half width in mm
PALM = [
    # distal transverse crease: from the ulnar border to between index and middle
    dict(pts=[(36, 61), (26, 65.5), (14, 70), (2, 74.5), (-8, 78), (-14, 80.5)], depth=0.55, width=0.75),
    # proximal transverse crease: from the radial border across, sloping down
    dict(pts=[(-34, 63), (-24, 59.5), (-12, 55.5), (0, 52), (12, 49), (20, 47.5)], depth=0.5, width=0.7),
    # thenar crease: round the thenar to the wrist
    dict(pts=[(-33, 64), (-26, 58), (-20, 49), (-16, 39), (-13, 28), (-10, 18), (-7, 10)], depth=0.6, width=0.75),
    # wrist creases: faint, oblique, broken
    dict(pts=[(-22, 9.5), (-12, 8.0), (-3, 7.6)], depth=0.28, width=0.5),
    dict(pts=[(1, 7.4), (10, 6.6), (21, 4.8)], depth=0.25, width=0.5),
    dict(pts=[(-20, 3.0), (-6, 1.8), (6, 1.4), (18, 0.0)], depth=0.18, width=0.45),
]


def _poly_dist(xy, pts):
    pts = np.asarray(pts, dtype=np.float64)
    best = np.full(len(xy), np.inf)
    tt = np.zeros(len(xy))
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = np.clip(((xy - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(xy - (a + t[:, None] * ab), axis=1)
        m = d < best
        best = np.where(m, d, best)
        tt = np.where(m, (L[i] + t * np.linalg.norm(ab)) / L[-1], tt)
    return best, tt


def groove(dist, width):
    """A soft V: 1 at the line, 0 at +-2.2 widths."""
    u = dist / width
    return np.exp(-u * u) * (1 + 0.0 * u)


def palm_creases(P):
    out = np.zeros(len(P))
    vol = smoothstep(-7.0, -11.5, P[:, 2])
    if not vol.any():
        return out
    xy = P[:, :2]
    for c in PALM:
        d, t = _poly_dist(xy, c['pts'])
        # fade in and out along the crease
        ends = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.85, t)
        out += 0.5 * c['depth'] * groove(d, c['width'] * 1.15) * ends
    return out * vol


# finger creases: (where in joint units as in hand.FINGER_PROFILE, side, depth, width)
# side: 'v' volar line across, 'd' dorsal arc
FINGER = [
    (0.36, 'v', 0.55, 0.7), (0.43, 'v', 0.35, 0.55),
    (0.955, 'v', 0.5, 0.55), (1.02, 'v', 0.5, 0.55),
    (1.955, 'v', 0.45, 0.5),
    (0.935, 'd', 0.14, 0.35), (0.975, 'd', 0.22, 0.38), (1.01, 'd', 0.2, 0.38), (1.05, 'd', 0.12, 0.32),
    (1.955, 'd', 0.08, 0.3), (1.99, 'd', 0.07, 0.3),
]
THUMB = [
    (0.98, 'v', 0.5, 0.65), (1.04, 'v', 0.4, 0.55),
    (1.97, 'v', 0.55, 0.6),
    (1.955, 'd', 0.09, 0.35), (1.995, 'd', 0.1, 0.35),
]


def finger_creases(loc, jx, thumb=False):
    """loc: the tube's local frame (s, x, z, a, b) for the points; jx: arc
    lengths of the joints (MCP, PIP, DIP, tip for fingers; CMC, MCP, IP, tip for the thumb)."""
    s, x, z, a, b = loc['s'], loc['x'], loc['z'], loc['a'], loc['b']
    out = np.zeros(len(s))
    ang = np.arctan2(z / np.maximum(b, 1e-3), x / np.maximum(a, 1e-3))   # 0 side, +pi/2 dorsal, -pi/2 volar
    for where, side, depth, width in (THUMB if thumb else FINGER):
        k = min(int(np.floor(where)), 2)
        sc = jx[k] + (where - k) * (jx[k + 1] - jx[k])
        u = np.clip(x / np.maximum(a, 1e-3), -1.2, 1.2)
        if side == 'v':
            # volar only, fading out by +-60 degrees round the finger
            m = smoothstep(-0.5, -0.87, np.sin(ang))
            sc = sc + 0.6 * u * u                     # a slight curve
        else:
            # short arcs over the middle of the knuckle only, bowing toward the tip
            m = smoothstep(0.6, 0.93, np.sin(ang)) * smoothstep(0.55, 0.25, np.abs(u))
            sc = sc - 1.4 * u * u
        out += depth * groove(s - sc, width) * m
    return out
