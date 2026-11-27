"""Proportions, the rest pose and the placement in game space (hand-v2-plan.md
3.1 to 3.3). All on the quad cage, in numpy; nothing here is subdivided yet.

1. Anthropometry: the targets are applied in base.load(); here the result is
   measured against an adult female 50th percentile hand (params.ANTHRO).
2. The rest pose (the bind pose is the game's rest): the cage is posed with
   linear blend skinning (the source's painted weights) and the posed shape
   becomes the mesh, so nothing at rest is a skinned bend.
   * fingers: middle joint REST_FLEX[1], last joint REST_FLEX[2]; the knuckle
     is solved per finger so the pad's lowest point meets the desk plane,
     and the spread so the finger's heading on the desk is v1's;
   * the forearm bends at the wrist to v1's forearm direction (v1 rests the
     hand flat with the forearm sloping down under the towel roll);
   * the thumb: a 5-number least-squares fit (base flex / spread / twist and
     the two outer flexes) so its nail's centre and normal land on v1's.
   Then Taubin relaxation on the finger webs, the thenar web and the wrist
   (where the re-pose stretched the skin).
3. Placement: one similarity transform (uniform scale, rotation, translation),
   least squares on landmarks (the palm bone's head, the four finger knuckles,
   the four finger nail centres) onto v1's (params.V1_*), so the rail, the pan
   and the neighbours' nails stay where the game expects them.
4. The forearm's open end is closed with a cap.

The desk: the plane of the palm's underside; the final placement holds its
normal vertical (the game's desk is horizontal) and fits the rest.
"""
import math

import numpy as np

import params as P
from base import BI, BONES, FINGERS, PARENT

GAME_UNITS_PER_MM = None  # set by placement (report only)


# ---- small math ---------------------------------------------------------------------
def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def rot(axis, deg):
    a = math.radians(deg)
    x, y, z = unit(axis)
    K = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
    return np.eye(3) + math.sin(a) * K + (1 - math.cos(a)) * K @ K


def umeyama(src, dst):
    """Similarity (s, R, t) with dst ~ s R src + t (least squares)."""
    ms, md = src.mean(0), dst.mean(0)
    A, B = src - ms, dst - md
    U, S, Vt = np.linalg.svd(B.T @ A / len(src))
    D = np.eye(3)
    if np.linalg.det(U @ Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (A ** 2).sum(1).mean()
    t = md - s * R @ ms
    return s, R, t


# ---- forward kinematics on the cage --------------------------------------------------
class Skeleton:
    """Rest joints and per-bone axes (X flex, Y along, Z spread) of a cage."""

    def __init__(self, cage):
        self.cage = cage
        self.head, self.tail, self.A = {}, {}, {}
        for b in BONES:
            h, t = cage.bone(b)
            d = unit(t - h)
            f = 'middle' if b in ('wrist', 'palm') else b.split('.')[0]
            n = cage.nail_normal(f)
            X = unit(np.cross(n, d))
            Z = np.cross(X, d)
            self.head[b], self.tail[b] = h.copy(), t.copy()
            self.A[b] = np.stack([X, d, Z], 1)   # columns: flex, along, spread axes (world)

    def transforms(self, pose, glob=None):
        """pose: bone -> (flex, spread, twist) degrees about the bone's rest axes,
        in the bone's own frame (as HandRig: rest * Rx * Rz * Ry), or a 3x3
        world rotation about the bone's head. glob: (M, t) applied after all.
        Returns bone -> (M, t): world x -> M x + t."""
        out = {}
        G = glob if glob is not None else (np.eye(3), np.zeros(3))
        for b in BONES:
            v = pose.get(b, (0.0, 0.0, 0.0))
            if np.shape(v) == (3, 3):
                Rw = np.asarray(v)
            else:
                fl, sp, tw = v
                A = self.A[b]
                Rl = rot((1, 0, 0), fl) @ rot((0, 0, 1), sp) @ rot((0, 1, 0), tw)
                Rw = A @ Rl @ A.T
            h = self.head[b]
            p = PARENT[b]
            Mp, tp = out[p] if p else G
            out[b] = (Mp @ Rw, Mp @ (h - Rw @ h) + tp)
        return out

    def skin(self, V, W, T):
        out = np.zeros_like(V)
        for b in BONES:
            w = W[:, BI[b]]
            if not w.any():
                continue
            M, t = T[b]
            out += w[:, None] * (V @ M.T + t)
        return out

    def posed_joints(self, T):
        J = {}
        for b in BONES:
            M, t = T[b]
            J[b] = (M @ self.head[b] + t, M @ self.tail[b] + t)
        return J


def apply_transform(cage, s, R, t):
    cage.V = s * cage.V @ R.T + t
    for k in cage.joints:
        cage.joints[k] = s * R @ cage.joints[k] + t


# ---- measurements --------------------------------------------------------------------
def _finger_w(cage, f):
    return cage.W[:, [BI[f + '.0%d' % k] for k in (1, 2, 3)]].sum(1)


def anthropometry(cage):
    """Millimetres, on the cage as loaded (hand frame)."""
    V, J = cage.V, cage.joints
    mid = _finger_w(cage, 'middle') > 0.5
    out = {'hand_length': float(V[mid][:, 0].max() - J['wrist'][0])}
    mcp = np.array([J[f + '.1'] for f in ('index', 'middle', 'ring', 'pinky')])
    xm = mcp[:, 0].mean()
    band = np.abs(V[:, 0] - xm) < 4.0
    band &= ~(_finger_w(cage, 'thumb') > 0.3)
    out['knuckle_breadth'] = float(V[band][:, 1].max() - V[band][:, 1].min())
    # the middle finger from its palm-side base (the mean of the two webs) to the tip
    webs = []
    for a, b in (('index', 'middle'), ('middle', 'ring')):
        wa, wb = cage.W[:, BI[a + '.01']], cage.W[:, BI[b + '.01']]
        both = (wa > 0.2) & (wb > 0.2)
        webs.append(V[both][:, 0].min() if both.any() else xm)
    tip = V[mid][:, 0].max()
    out['middle_finger'] = float(tip - np.mean(webs))
    # the index finger's breadth at its last joint (side to side, across the flex axis)
    h = J['index.3']
    d = unit(J['index.4'] - J['index.2'])
    n = cage.nail_normal('index')
    X = unit(np.cross(n, d))
    sel = (_finger_w(cage, 'index') > 0.5) & (np.abs((V - h) @ d) < 1.5)
    q = (V[sel] - h) @ X
    out['index_dip_breadth'] = float(q.max() - q.min()) if sel.sum() > 3 else float('nan')
    return out


def flex_between(sk, T, a, b):
    """Flex angle (degrees) of bone b relative to its parent a, posed: angle of
    b's direction from a's, signed toward the palm (about a's flex axis)."""
    Ma, _ = T[a]
    Mb, _ = T[b]
    da = Ma @ sk.A[a][:, 1]
    db = Mb @ sk.A[b][:, 1]
    X = Ma @ sk.A[a][:, 0]
    return math.degrees(math.atan2(np.cross(da, db) @ X, da @ db))


# ---- relax ---------------------------------------------------------------------------
def taubin(V, E, mask, iters, lam, mu):
    """Taubin smoothing (no shrink) of the vertices with mask > 0, weighted by it."""
    n = len(V)
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    X = V.copy()
    for _ in range(iters):
        for k in (lam, mu):
            acc = np.zeros_like(X)
            np.add.at(acc, E[:, 0], X[E[:, 1]])
            np.add.at(acc, E[:, 1], X[E[:, 0]])
            L = acc / np.maximum(cnt, 1)[:, None] - X
            X = X + (k * mask)[:, None] * L
    return X


def grow(E, sel, rings):
    """Ring distance (0 inside sel, 1.. outward, -1 beyond `rings`)."""
    ring = np.where(sel, 0, -1)
    cur = sel.copy()
    for k in range(1, rings + 1):
        g = cur.copy()
        np.logical_or.at(g, E[:, 0], cur[E[:, 1]])
        np.logical_or.at(g, E[:, 1], cur[E[:, 0]])
        ring[g & (ring < 0)] = k
        cur = g
    return ring


# ---- the fit -------------------------------------------------------------------------
def _landmarks(cage, J=None, V=None, nails=True):
    """(names, hand-frame points, v1 game points)."""
    J = cage.joints if J is None else J
    names, src, dst = [], [], []
    names.append('palm')
    src.append(J['wrist'])     # the anatomical wrist: v1's palm head sits there
    dst.append(P.V1_BONE_HEAD['palm'])
    for f in ('index', 'middle', 'ring', 'pinky'):
        names.append(f + '.01')
        src.append(J[f + '.1'])
        dst.append(P.V1_BONE_HEAD[f + '.01'])
    if nails:
        for f in ('index', 'middle', 'ring', 'pinky'):
            names.append('nail ' + f)
            src.append(cage.nail_centre(f, V))
            dst.append(P.V1_NAIL_CENTRE[f])
    return names, np.array(src), np.array(dst)


def bake_weights(cage, E):
    W = cage.W.copy()
    t1 = W[:, BI['thumb.01']]
    hub = W[:, [BI['palm'], BI['wrist']]].sum(1)
    first = W[:, [BI[f + '.01'] for f in FINGERS]]
    region = ((t1 + W[:, BI['thumb.02']] > 0.02) & (hub + first[:, 1] > 0.02)) | \
             ((first.max(1) > 0.02) & (hub > 0.02)) | ((W[:, BI['palm']] > 0.02) & (W[:, BI['wrist']] > 0.02))
    ring = grow(E, region, P.BAKE_SOFT_RINGS)
    a = np.where(ring < 0, 0.0, 1.0 - np.maximum(ring, 0) / (P.BAKE_SOFT_RINGS + 1.0))
    for f in FINGERS:
        a[np.unique(cage.F[np.concatenate([cage.nails[f]] + list(cage.folds[f]))])] = 0.0
    n = len(W)
    cnt = np.zeros(n)
    np.add.at(cnt, E[:, 0], 1)
    np.add.at(cnt, E[:, 1], 1)
    for _ in range(P.BAKE_SOFT_PASSES):
        acc = np.zeros_like(W)
        np.add.at(acc, E[:, 0], W[E[:, 1]])
        np.add.at(acc, E[:, 1], W[E[:, 0]])
        W = W + (0.5 * a)[:, None] * (acc / np.maximum(cnt, 1)[:, None] - W)
    return W / W.sum(1, keepdims=True)


def build(cage, report, check):
    rep = report.setdefault('fit', {})
    # 1. anthropometry
    a = anthropometry(cage)
    rep['anthropometry_mm'] = {k: round(v, 1) for k, v in a.items()}
    ratios = {k: round(a[k] / P.ANTHRO[k], 3) for k in P.ANTHRO}
    rep['anthropometry_ratio'] = ratios
    check('fit: proportions within +-%d%% of an adult female 50th percentile hand' % round(P.ANTHRO_BAND * 100),
          all(abs(r - 1) <= P.ANTHRO_BAND for r in ratios.values()), ratios, P.ANTHRO_BAND)
    hand_len = a['hand_length']

    E = cage.edges()
    # the thumb chain's proportions (Jesse, after V2), in the source pose
    import thumb as TH
    TH.proportions(cage, rep, bake_weights, E)
    sk = Skeleton(cage)
    T0 = sk.transforms({})
    cur = {}
    for f in ('index', 'middle', 'ring', 'pinky'):
        cur[f] = (flex_between(sk, T0, f + '.01', f + '.02'), flex_between(sk, T0, f + '.02', f + '.03'))
    rep['source_flex'] = {f: [round(x, 1) for x in v] for f, v in cur.items()}
    four = ('index', 'middle', 'ring', 'pinky')

    # the rigid hand (wrist joint + knuckles) is the placement's anchor
    _, src, dst = _landmarks(cage, nails=False)
    s, R, t = umeyama(src, dst)

    # the forearm: bend it at the wrist to v1's direction; the hand stays put
    # (the palm bone turns the hand about the wrist, a global turn back undoes it
    # for everything but the forearm)
    v1_fore = unit(np.array(P.V1_BONE_HEAD['palm']) - np.array(P.V1_WRIST_HEAD))
    want = R.T @ v1_fore
    have = unit(cage.joints['wrist'] - cage.joints['elbow'])
    ax = np.cross(have, want)
    ang = math.degrees(math.atan2(np.linalg.norm(ax), have @ want))
    Rf = rot(ax, ang) if ang > 1e-3 else np.eye(3)
    w0 = cage.joints['wrist']
    pose = {'palm': Rf.T}
    glob = (Rf, w0 - Rf @ w0)
    rep['wrist_bend_deg'] = round(ang, 2)

    def tfm():
        return sk.transforms(pose, glob)

    def pad_low(T, f, up):
        sel = cage.W[:, BI[f + '.03']] > 0.5
        return float((sk.skin(cage.V[sel], cage.W[sel], T) @ up).min())

    def heading(T, f, up):
        Mb, tb = T[f + '.03']
        M1, t1 = T[f + '.01']
        d = (Mb @ sk.tail[f + '.03'] + tb) - (M1 @ sk.head[f + '.01'] + t1)
        d -= up * (d @ up)
        return unit(d)

    def ang_about(u, v, up):
        return math.degrees(math.atan2(np.cross(u, v) @ up, u @ v))

    k = {f: [0.0, 0.0] for f in four}
    for f in four:
        pose[f + '.02'] = (P.REST_FLEX[1] - cur[f][0], 0.0, 0.0)
        pose[f + '.03'] = (P.REST_FLEX[2] - cur[f][1], 0.0, 0.0)
    # the desk: the plane the hand lies on, touching the heel of the palm and the
    # four finger pads (knuckles at REST_FLEX[0]); its normal is the hand's up
    # (the final placement makes it the game's up)
    palm_sel = cage.W[:, BI['palm']] > 0.5
    pad_sel = {f: cage.W[:, BI[f + '.03']] > 0.5 for f in four}
    up = np.array([0.0, 0.0, 1.0])
    for f in four:
        pose[f + '.01'] = (P.REST_FLEX[0], 0.0, 0.0)
    for _ in range(8):
        T = tfm()
        Vp = sk.skin(cage.V[palm_sel], cage.W[palm_sel], T)
        pts = [Vp[np.argmin(Vp @ up)]] * 4
        for f in four:
            Vf = sk.skin(cage.V[pad_sel[f]], cage.W[pad_sel[f]], T)
            pts.append(Vf[np.argmin(Vf @ up)])
        pts = np.array(pts)
        Q = pts - pts.mean(0)
        n = np.linalg.eigh(Q.T @ Q)[1][:, 0]
        up = n if n @ up > 0 else -n
    rep['desk_normal_vs_hand_frame_deg'] = round(math.degrees(math.acos(np.clip(up[2], -1, 1))), 2)
    for it in range(P.HEADING_ITERS + 1):
        T = tfm()
        desk = float((sk.skin(cage.V[palm_sel], cage.W[palm_sel], T) @ up).min())
        v1_head = {}
        for f in four:
            d = R.T @ (np.array(P.V1_FINGER_TIP[f]) - np.array(P.V1_BONE_HEAD[f + '.01']))
            d -= up * (d @ up)
            v1_head[f] = unit(d)
        for f in four:
            for _ in range(10):
                pose[f + '.01'] = (k[f][0], k[f][1], 0.0)
                h0 = pad_low(tfm(), f, up) - desk
                pose[f + '.01'] = (k[f][0] + 1.0, k[f][1], 0.0)
                h1 = pad_low(tfm(), f, up) - desk
                if abs(h1 - h0) > 1e-9:
                    k[f][0] = float(np.clip(k[f][0] - h0 / (h1 - h0), *P.REST_KNUCKLE_RANGE))
                pose[f + '.01'] = (k[f][0], k[f][1], 0.0)
                e0 = ang_about(heading(tfm(), f, up), v1_head[f], up)
                pose[f + '.01'] = (k[f][0], k[f][1] + 1.0, 0.0)
                e1 = ang_about(heading(tfm(), f, up), v1_head[f], up)
                if abs(e1 - e0) > 1e-9:
                    k[f][1] = float(np.clip(k[f][1] - e0 / (e1 - e0), -15, 15))
                pose[f + '.01'] = (k[f][0], k[f][1], 0.0)
        # placement with the posed finger nails
        T = tfm()
        J = {'wrist': cage.joints['wrist']}
        for f in four:
            J[f + '.1'] = cage.joints[f + '.1']
        nails = {}
        for f in four:
            M, tt = T[f + '.03']
            nails[f] = M @ cage.nail_centre(f) + tt
        names = ['palm'] + [f + '.01' for f in four] + ['nail ' + f for f in four]
        src = np.array([J['wrist']] + [J[f + '.1'] for f in four] + [nails[f] for f in four])
        dst = np.array([P.V1_BONE_HEAD['palm']] + [P.V1_BONE_HEAD[f + '.01'] for f in four] + [P.V1_NAIL_CENTRE[f] for f in four])
        s, R, t = umeyama(src, dst)
    T = tfm()
    solved = {}
    for f in four:
        solved[f] = {'knuckle': round(k[f][0], 2), 'spread': round(k[f][1], 2),
                     'pad_vs_desk_mm': round(pad_low(T, f, up) - desk, 2),
                     'heading_err_deg': round(ang_about(heading(T, f, up), v1_head[f], up), 2)}
    rep['fingers'] = solved
    resid_free = np.linalg.norm(s * src @ R.T + t - dst, axis=1) / s   # mm
    # the placement the game gets: the same fit with the desk normal held vertical
    # (the hand lies flat on the game's horizontal desk; v1's hand was tilted)
    u = R @ up
    ax = np.cross(u, [0, 0, 1.0])
    Qa = rot(ax, math.degrees(math.atan2(np.linalg.norm(ax), u[2]))) if np.linalg.norm(ax) > 1e-9 else np.eye(3)
    p = src @ (Qa @ R).T
    pc, dc = p[:, :2].mean(0), dst[:, :2].mean(0)
    A2, B2 = p[:, :2] - pc, dst[:, :2] - dc
    yaw = math.atan2((A2[:, 0] * B2[:, 1] - A2[:, 1] * B2[:, 0]).sum(), (A2 * B2).sum())
    Rz = rot((0, 0, 1), math.degrees(yaw))
    sc = float(((A2 @ Rz[:2, :2].T) * B2).sum() / (A2 ** 2).sum())
    Rc = Rz @ Qa @ R
    tc = dst.mean(0) - sc * (src @ Rc.T).mean(0)
    resid = np.linalg.norm(sc * src @ Rc.T + tc - dst, axis=1) / sc
    rep['placement'] = {'scale_game_per_mm': round(sc, 7), 'mm_per_game_unit': round(1 / sc, 2),
                        'tilt_vs_free_fit_deg': round(math.degrees(math.acos(np.clip(u[2], -1, 1))), 2),
                        'residual_mm': {n: round(float(r), 2) for n, r in zip(names, resid)},
                        'residual_free_fit_mm': {n: round(float(r), 2) for n, r in zip(names, resid_free)}}
    check('fit: placement residual per landmark < %d%% of hand length (info: v1\'s proportions were off)' % round(P.PLACE_RESID_FRAC * 100),
          True, round(float(resid.max()), 2), 'info; %.1f expected' % (P.PLACE_RESID_FRAC * hand_len))

    # the thumb: 5 numbers so its nail lands on v1's (B9.8, signed off): the nail
    # centre's place on the desk (game x, y) and its normal; its height is the
    # thumb lying on its side on the desk (v1's thumb hung below its palm)
    th_sel = cage.W[:, [BI['thumb.02'], BI['thumb.03']]].sum(1) > 0.5
    th_base = (cage.W[:, BI['thumb.01']] > 0.5) & ~th_sel        # the thenar
    ix0 = unit((Rc @ (cage.joints['index.4'] - cage.joints['index.1']))[:2])
    side0 = np.array([-ix0[1], ix0[0]])

    def thumb_geom(T):
        """The thumb seen from the side: its two pitches (degrees, + = up toward
        the tip) and heights above the desk (mm), against the index's axis."""
        def pt(b, end):
            M, tt = T[b]
            return M @ (sk.head[b] if end == 'h' else sk.tail[b]) + tt
        cmc, mcp, ip, tip = pt('thumb.01', 'h'), pt('thumb.02', 'h'), pt('thumb.03', 'h'), pt('thumb.03', 't')
        pitch = lambda a, b: math.degrees(math.asin(np.clip(unit(b - a) @ up, -1, 1)))  # noqa: E731
        ih = 0.5 * (pt('index.03', 'h') + pt('index.03', 't')) @ up - desk
        flat = lambda v: v - up * (v @ up)  # noqa: E731
        im, ip2 = pt('index.01', 'h'), pt('index.02', 'h')
        wr = pt('palm', 'h')
        # the second metacarpal runs about parallel to the third (wrist to middle MCP)
        mc_top = math.degrees(math.acos(np.clip(unit(flat(mcp - cmc)) @ unit(flat(pt('middle.01', 'h') - wr)), -1, 1)))
        ax = flat(ip2 - im)
        reach = float(flat(tip - im) @ ax / (ax @ ax))
        # seen from above: + = the phalanges turn from the metacarpal toward the index
        a_, b_ = unit(flat(mcp - cmc)), unit(flat(tip - mcp))
        toward = np.cross(a_, unit(flat(im - mcp))) @ up
        top_bend = math.degrees(math.atan2(np.cross(a_, b_) @ up, a_ @ b_)) * (1.0 if toward >= 0 else -1.0)
        return {'mc_top_deg': mc_top, 'tip_reach_index_pp': reach, 'digit_vs_mc_top_deg': top_bend,
                'pitch_meta': pitch(cmc, mcp), 'pitch_prox': pitch(mcp, ip), 'pitch_dist': pitch(ip, tip),
                'pitch_phal': pitch(mcp, tip), 'tip_h': float(tip @ up - desk), 'ip_h': float(ip @ up - desk),
                'mcp_h': float(mcp @ up - desk), 'index_axis_h': float(ih)}

    def thumb_err(x, stage=1):
        pose['thumb.01'] = (x[0], x[1], x[2])
        pose['thumb.02'] = (x[3], 0.0, 0.0)
        pose['thumb.03'] = (x[4], 0.0, 0.0)
        T = tfm()
        low = float((sk.skin(cage.V[th_sel], cage.W[th_sel], T) @ up).min()) - desk
        if stage == 2:
            # stage 2 (Jesse, after V2): seen from the side, a relaxed thumb beside
            # the index is fairly straight (a slight curl only), its metacarpal
            # sloping a little down, the thumb about level with the index and a
            # little below it; it never hooks down to the desk, and clears it.
            # The base keeps near its stage-1 place and the nail near v1's facing
            gm = thumb_geom(T)
            curl = [max(abs(gm['pitch_meta'] - gm['pitch_prox']) - P.THUMB_SIDE_CURL_MAX, 0.0),
                    max(abs(gm['pitch_prox'] - gm['pitch_dist']) - P.THUMB_SIDE_CURL_MAX, 0.0)]
            meta = gm['pitch_meta'] - P.THUMB_META_PITCH
            level = max(gm['tip_h'] - (gm['index_axis_h'] - P.THUMB_BELOW_INDEX_MM), 0.0) * P.THUMB_LEVEL_W
            low1 = float((sk.skin(cage.V[th_base], cage.W[th_base], T) @ up).min()) - desk
            rest = min(low - P.THUMB_DESK_CLEAR_MM, 0.0) * 20.0 + min(low1 - P.THENAR_DESK_CLEAR_MM, 0.0) * 20.0
            M, tt = T['thumb.03']
            ng = Rc @ (M @ cage.nail_normal('thumb'))
            cg = sc * Rc @ (M @ cage.nail_centre('thumb') + tt) + tc
            dv = (cg[:2] - np.array(P.V1_NAIL_CENTRE['thumb'][:2])) / sc
            # the nail faces up-and-out like v1's (its tilt from up, not its heading)
            e_n = [(math.degrees(math.acos(np.clip(unit(ng) @ unit(Rc @ up), -1, 1))) - P.THUMB_NAIL_TILT) * P.THUMB_NAIL_TILT_W]
            out = 0.0   # (the anatomy targets below place it; v1's nail position no longer does)
            prior = np.concatenate([(np.asarray(x[:3]) - x1[:3]) * P.THUMB_STAGE2_BASE_W,
                                    (np.asarray(x[3:]) - th2[3:]) * P.THUMB_STRAIGHT_PRIOR_W])
            mc_ang = (gm['mc_top_deg'] - P.THUMB_MC_ANGLE) * P.THUMB_MC_ANGLE_W
            curl.append(max(gm['digit_vs_mc_top_deg'] - P.THUMB_TOP_BEND[1], 0.0) + max(P.THUMB_TOP_BEND[0] - gm['digit_vs_mc_top_deg'], 0.0))
            reach = (gm['tip_reach_index_pp'] - P.THUMB_REACH) * P.THUMB_REACH_W
            return np.concatenate([np.array(curl) * P.THUMB_CURL_W, [meta * P.THUMB_META_W, level, rest, out, mc_ang, reach], e_n, prior])
        M, tt = T['thumb.03']
        cg = sc * Rc @ (M @ cage.nail_centre('thumb') + tt) + tc
        ng = Rc @ (M @ cage.nail_normal('thumb'))
        dv = (cg[:2] - np.array(P.V1_NAIL_CENTRE['thumb'][:2])) / sc      # mm, on the desk
        e_c = np.array([dv @ ix0 * P.THUMB_ALONG_W, dv @ side0 * P.THUMB_OUT_W])
        e_n = (ng - unit(P.V1_NAIL_NORMAL['thumb'])) * 25.0              # 1 rad ~ 25 mm
        # the base joint (the metacarpal, at the wrist) does the work; the two
        # outer joints stay near a natural relaxed flex (no hyper-extension)
        prior = (np.asarray(x) - th0) * np.array(P.THUMB_PRIOR_W)
        # it rests on the desk (never through it, never lifted off it), and the
        # base joint stays inside a natural range
        rest = min(low, 0.0) * 3.0 + max(low - P.THUMB_DESK_GAP_MM, 0.0)
        rng = np.maximum(np.abs(np.asarray(x[:3]) - th0[:3]) - P.THUMB_BASE_RANGE, 0.0) * 0.5
        return np.concatenate([e_c, e_n, [rest], prior, rng])

    cur_t = (flex_between(sk, T0, 'thumb.01', 'thumb.02'), flex_between(sk, T0, 'thumb.02', 'thumb.03'))
    rep['source_thumb_flex'] = [round(v, 1) for v in cur_t]
    th0 = np.array([0.0, 0.0, 0.0, P.THUMB_REST_FLEX[0] - cur_t[0], P.THUMB_REST_FLEX[1] - cur_t[1]])
    th2 = np.array([0.0, 0.0, 0.0, P.THUMB_STRAIGHT_FLEX[0] - cur_t[0], P.THUMB_STRAIGHT_FLEX[1] - cur_t[1]])

    def solve(x, stage=1):
        free = [0, 1, 2, 3, 4]
        lam = 1e-2
        for _ in range(80):
            r = thumb_err(x, stage)
            Jm = np.zeros((len(r), len(free)))
            for j, i in enumerate(free):
                dx = np.zeros(5)
                dx[i] = 0.25
                Jm[:, j] = (thumb_err(x + dx, stage) - r) / 0.25
            st = np.linalg.solve(Jm.T @ Jm + lam * np.eye(len(free)), -Jm.T @ r)
            step = np.zeros(5)
            step[free] = st
            if (thumb_err(x + step, stage) ** 2).sum() < (r ** 2).sum():
                x = x + step
                lam *= 0.5
            else:
                lam *= 4
            if np.abs(step).max() < 1e-4:
                break
        return x, float((thumb_err(x, stage) ** 2).sum())
    # stage 1: the base joint places the thumb like v1's (B9.8); a few starts
    # (its cost has more than one valley)
    best = None
    for a in (-40, 0, 40):
        for b in (-40, 0, 40):
            for c_ in (-30, 0, 30):
                x0 = th0 + np.array([a, b, c_, 0.0, 0.0])
                xs, cost = solve(x0)
                if best is None or cost < best[1]:
                    best = (xs, cost)
    x = best[0]
    rep['thumb_stage1'] = {kk: round(v, 1) for kk, v in thumb_geom(tfm()).items()}
    # stage 2: straighten the outer joints (the base keeps its place)
    x1 = x.copy()
    x, _ = solve(np.concatenate([x[:3], th2[3:]]), stage=2)
    r = thumb_err(x)
    T = tfm()
    M, tt = T['thumb.03']
    cg = sc * Rc @ (M @ cage.nail_centre('thumb') + tt) + tc
    ng = Rc @ (M @ cage.nail_normal('thumb'))
    dmm = float(np.linalg.norm(cg[:2] - np.array(P.V1_NAIL_CENTRE['thumb'][:2])) / sc)
    ddeg = float(math.degrees(math.acos(np.clip(ng @ unit(P.V1_NAIL_NORMAL['thumb']), -1, 1))))
    rep['thumb_height_vs_v1_mm'] = round(float((cg[2] - P.V1_NAIL_CENTRE['thumb'][2]) / sc), 1)
    rep['thumb_low_vs_desk_mm'] = round(float((sk.skin(cage.V[th_sel], cage.W[th_sel], T) @ up).min() - desk), 2)
    # where the thumb sits against v1's: along the index (a longer, anatomical
    # thumb reaches further) and sideways out of the hand (what "sticks out" means)
    ix = unit((cage.joints['index.4'] - cage.joints['index.1']) @ np.eye(3))  # hand frame
    ixg = unit((Rc @ ix)[:2])
    side = np.array([-ixg[1], ixg[0]])
    tg = (np.array(P.V1_NAIL_CENTRE['thumb'][:2]) - np.array(P.V1_BONE_HEAD['index.01'][:2]))
    if tg @ side < 0:
        side = -side                       # + = away from the hand, on the thumb side
    dv = (cg[:2] - np.array(P.V1_NAIL_CENTRE['thumb'][:2])) / sc
    along, out = float(dv @ ixg), float(dv @ side)
    gm = thumb_geom(T)
    rep['thumb_side'] = {kk: round(v, 1) for kk, v in gm.items()}
    bends = [gm['pitch_meta'] - gm['pitch_prox'], gm['pitch_prox'] - gm['pitch_dist']]
    check('fit: thumb from the side: no joint bends down more than %g deg (no hook)' % (P.THUMB_SIDE_CURL_MAX + 2),
          max(bends) <= P.THUMB_SIDE_CURL_MAX + 2, [round(b, 1) for b in bends], P.THUMB_SIDE_CURL_MAX + 2)
    check('fit: thumb clears the desk', rep['thumb_low_vs_desk_mm'] >= 0.0, rep['thumb_low_vs_desk_mm'], '>= 0 mm')
    # the thumb chain's anatomy (thumb.py, Jesse after V2): the first metacarpal
    # 30-45 deg from the hand's metacarpals seen from above; the phalanges shorter
    # than the index's digit
    J0 = {k: v for k, v in cage.joints.items()}
    tl = [np.linalg.norm(J0['thumb.%d' % (k + 1)] - J0['thumb.%d' % k]) for k in (1, 2, 3)]
    il = sum(np.linalg.norm(J0['index.%d' % (k + 1)] - J0['index.%d' % k]) for k in (1, 2, 3))
    digit = (tl[1] + tl[2]) / il
    rep['thumb_anatomy'] = {'mc_vs_hand_metacarpals_top_deg': round(gm['mc_top_deg'], 1), 'digit_over_index_digit': round(float(digit), 3),
                            'tip_reach_index_pp (info: 0 = MCP, 1 = PIP)': round(gm['tip_reach_index_pp'], 2),
                            'phalanges_turn_toward_index_top_deg': round(gm['digit_vs_mc_top_deg'], 1)}
    check('fit: thumb metacarpal 30-45 deg from the hand\'s metacarpals (from above)', 30.0 <= gm['mc_top_deg'] <= 45.0,
          round(gm['mc_top_deg'], 1), [30, 45])
    check('fit: thumb phalanges / index digit 0.65-0.80 (shorter, stockier than a finger)', 0.65 <= digit <= 0.80,
          round(float(digit), 3), [0.65, 0.8])
    rep['thumb'] = {'pose': [round(float(v), 2) for v in x], 'centre_mm': round(dmm, 2), 'normal_deg': round(ddeg, 2),
                    'along_index_mm': round(along, 2), 'out_of_hand_mm': round(out, 2)}
    # Jesse (after V2) re-set the thumb's target: straight and level from the side.
    # Lying straight on its side it cannot also keep v1's nail facing (v1's thumb
    # hung below the palm), so the nail normal against v1's is now information
    rep['thumb']['nail_from_up_deg'] = round(math.degrees(math.acos(np.clip(unit(ng) @ unit(Rc @ up), -1, 1))), 1)
    rep['thumb']['v1_nail_from_up_deg'] = round(math.degrees(math.acos(np.clip(unit(P.V1_NAIL_NORMAL['thumb'])[2], -1, 1))), 1)
    check("fit: thumb beside the index, no further out of the hand than v1's + %g mm" % P.THUMB_OUT_MM,
          out <= P.THUMB_OUT_MM,
          {'out_mm': round(out, 2), 'along_mm (info)': round(along, 2), 'nail_vs_v1_deg (info)': round(ddeg, 2)},
          P.THUMB_OUT_MM)
    rep['pose'] = {kk: ([round(float(u), 2) for u in v] if np.shape(v) == (3,) else 'matrix') for kk, v in pose.items()}

    # 2. bake: the posed cage is the new rest; the joints move with their bones
    V0 = cage.V.copy()
    # the bake spreads each joint's turn over a wide, soft falloff (diffused
    # weights round the thumb's base, the webs and the wrist), so the re-pose
    # never pinches the skin into a crease there; the rig's own weights stay
    cage.V = sk.skin(cage.V, bake_weights(cage, E), T)
    Jp = sk.posed_joints(T)
    newJ = dict(cage.joints)
    newJ['elbow'] = Jp['wrist'][0]
    newJ['wrist'] = Jp['palm'][0]
    for f in FINGERS:
        for kk in (1, 2, 3):
            newJ[f'{f}.{kk}'] = Jp[f'{f}.0{kk}'][0]
        newJ[f'{f}.4'] = Jp[f'{f}.03'][1]
    cage.joints = newJ
    # relax where the re-pose stretched the skin: the finger webs, the thenar
    # web and the wrist (weights split between a .01 / the palm / the wrist),
    # plus two rings, fading; never the nail units
    Wn = cage.W
    first = Wn[:, [BI[f + '.01'] for f in FINGERS]]
    hub = Wn[:, [BI['palm'], BI['wrist']]].sum(1)
    mixed = ((first.max(1) > 0.05) & (hub > 0.05)) | ((first > 0.05).sum(1) > 1) | \
            ((Wn[:, BI['palm']] > 0.05) & (Wn[:, BI['wrist']] > 0.05))
    ring = grow(E, mixed, 2)
    mask = np.where(ring < 0, 0.0, 1.0 - np.maximum(ring, 0) / 3.0)
    for f in FINGERS:
        mask[np.unique(cage.F[np.concatenate([cage.nails[f]] + list(cage.folds[f]))])] = 0.0
    cage.V = taubin(cage.V, E, mask, P.WEB_RELAX_ITERS, P.WEB_RELAX_LAMBDA, P.WEB_RELAX_MU)
    rep['relaxed_verts'] = int((mask > 0).sum())
    TH.volume(cage, rep, E, up)
    rep['bake_shift_max_mm'] = round(float(np.linalg.norm(cage.V - V0, axis=1).max()), 2)

    # desk checks (before placement, in mm): pads on the desk, no skin below it
    low = {}
    for f in four:
        sel = cage.W[:, BI[f + '.03']] > 0.5
        low[f] = round(float((cage.V[sel] @ up).min() - desk), 2)
    arm = cage.W[:, BI['wrist']] > 0.5
    below = cage.V[~arm] @ up - desk
    iv = np.nonzero(~arm)[0][int(np.argmin(below))]
    rep['desk'] = {'pads_mm': low, 'lowest_non_forearm_mm': round(float(below.min()), 2),
                   'lowest_at_bone': BONES[int(np.argmax(cage.W[iv]))]}
    check('fit: every finger pad within %.1f mm of the desk plane' % P.DESK_PAD_TOL_MM,
          all(abs(v) <= P.DESK_PAD_TOL_MM for v in low.values()), low, P.DESK_PAD_TOL_MM)
    check('fit: no skin below the desk plane (the forearm aside: it dips under the towel)',
          below.min() >= -P.DESK_PAD_TOL_MM, round(float(below.min()), 2), '>= -%.1f mm' % P.DESK_PAD_TOL_MM)

    # 3. into game space
    apply_transform(cage, sc, Rc, tc)
    cage.scale = sc
    cage.desk_z = float((sc * Rc @ (up * desk) + tc)[2])
    rep['desk_z'] = round(cage.desk_z, 4)
    return cage


def cap_forearm(cage, report):
    """Close the forearm's open end (one boundary loop) with a quad fan around
    its centre, wound like its neighbours (no hole in the viewer)."""
    F = cage.F
    e = np.concatenate([F[:, [i, (i + 1) % 4]] for i in range(4)])
    key = np.sort(e, 1)
    u, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    bnd = e[cnt[inv] == 1]                      # directed as in their face
    nxt = {int(a): int(b) for a, b in bnd}
    start = int(bnd[0, 0])
    loop = [start]
    while nxt[loop[-1]] != start:
        loop.append(nxt[loop[-1]])
    assert len(loop) == len(bnd) and len(loop) % 2 == 0, 'one even boundary loop'
    # the faces run a->b along the loop; the cap runs the other way
    loop = loop[::-1]
    c = len(cage.V)
    cage.V = np.vstack([cage.V, cage.V[loop].mean(0)])
    cage.W = np.vstack([cage.W, cage.W[loop].mean(0)])
    cage.other = np.append(cage.other, cage.other[loop].mean())
    quads = [[c, loop[2 * i], loop[2 * i + 1], loop[(2 * i + 2) % len(loop)]] for i in range(len(loop) // 2)]
    cage.F = np.vstack([F, np.array(quads)])
    cage.fuv = np.vstack([cage.fuv, np.repeat(cage.fuv[:1, :1], 4, 1).repeat(len(quads), 0)])
    report.setdefault('fit', {})['forearm_cap'] = {'loop_verts': len(loop), 'quads': len(quads)}
    return cage
