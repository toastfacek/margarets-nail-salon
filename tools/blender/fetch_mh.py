"""Re-create tools/blender/src/mh/hand-cage.json from the pinned MakeHuman / MPFB2
commit (hand-v2-plan.md section 2).

Run (needs the network; builds never do):
    /home/claude/bpyenv/bin/python -I tools/blender/fetch_mh.py [--dl=<empty dir>]

1. Downloads the files below from the pinned commit (raw URLs; falls back to
   a blobless git clone) into a new empty directory, and verifies every
   sha256 against the table. Nothing in that directory is executed: the
   files are parsed as data (OBJ text, gzip text, JSON, a JPEG read by
   Blender's image loader).
2. Extracts the right hand: the body faces whose four vertices are at least
   50% weighted to the right finger*, metacarpal*, wrist, lowerarm01/02
   bones (the forearm is cut later, in fit.py, where v1's ends).
3. Writes hand-cage.json: vertices, quads, the base UVs, the source weights
   of the kept vertices, the joint helper centres, the shape targets as
   sparse deltas (kept vertices and joint centres), and the nail faces of
   each finger (found once by a heuristic, cross-checked against the CC0
   nail mask texture in the base UVs, then committed: builds read the
   lists, they never re-run the heuristic).
4. Copies the licence texts and writes SOURCE.md.
"""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'src', 'mh')
REPO = 'makehumancommunity/mpfb2'
COMMIT = '650c5c53bd6989a8ac264f31fa1d11d4a0c7bd8a'
D = 'src/mpfb/data/'
HAND_TARGETS = ['fingers-diameter-decr', 'fingers-diameter-incr', 'fingers-distance-decr', 'fingers-distance-incr',
                'fingers-length-decr', 'fingers-length-incr', 'scale-decr', 'scale-incr', 'trans-in', 'trans-out']
FILES = {
    'LICENSE.md': ('LICENSE.md', '5cefb60680cb9efd4550a2e65d719021cfbec9dad3658481d11d48ae863ce04d'),
    'LICENSE.ASSETS.md': ('LICENSE.ASSETS.md', 'f6089cba01cb570a24712b41ab8a586ccd3cc5ef53dc266ca50b95c288956d2c'),
    'base.obj': (D + '3dobjs/base.obj', '8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c'),
    'weights.default.json': (D + 'rigs/standard/weights.default.json', '154b866774a8c2b055a8e86419f22a87b76c60440fdcb70bcb78345f00924e89'),
    'caucasian-female-young.target.gz': (D + 'targets/macrodetails/caucasian-female-young.target.gz',
                                         'e9d6212373ac5f1e2c596fa145e363385f4d169c3c6c88ede3bab93b681af041'),
    'mpfb_fingernails.jpg': (D + 'textures/mpfb_fingernails.jpg', '0828222964a14c14a46e72445f549a2124de06f072daab71e5a6716324c37362'),
}
_HT_SHA = {
    'fingers-diameter-decr': '3d940e2194c3b46cffc866b99edaa2ca8b5c8c34bcf5eb64959524bfdfd28076',
    'fingers-diameter-incr': '58beddaa9c8097ab7addfe2ae638c6c8c578eb8b7e5ac5ada542fce000d0f7da',
    'fingers-distance-decr': '1de105e5e75d76a41279cd82f3c9f04633d89429906903da4bbc916ef5a7c608',
    'fingers-distance-incr': '874ccc270155e561b5ae24d89e931f5c039b610fcddf572270b2a6c212341276',
    'fingers-length-decr': '710b10a1883fede2bd4bbbe4647ea25ee2311db4190c74009bba3504d217b515',
    'fingers-length-incr': 'ac90a1e7b1776bb41f896b2b5308ab791b860a3fbf4f854f17d56234b3da48a9',
    'scale-decr': '8a0a3e246efb9e3640fabd02c75085e3bc2bf57d20b736e0a98819302a72c83c',
    'scale-incr': '33d4f09b9c7cf1559503dde7b4e40f882a2bb81ec9bc71324c9edbe3655cda34',
    'trans-in': '11166b987bd9972fef9c99c7e7972a08bcb66a6d8bc977e3c2b3350bc9d37460',
    'trans-out': '0ef3a147e798fb19ca8840364390f86399a2989c3e7910dd09ca31b4292dd617',
}
for _t in HAND_TARGETS:
    FILES[f'r-hand-{_t}.target.gz'] = (D + f'targets/hands/r-hand-{_t}.target.gz', _HT_SHA[_t])

FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']
HAND_GROUPS = ([f'finger{f}-{k}.R' for f in range(1, 6) for k in (1, 2, 3)]
               + [f'metacarpal{k}.R' for k in range(1, 5)] + ['wrist.R', 'lowerarm01.R', 'lowerarm02.R'])
JOINTS = ['joint-r-hand', 'joint-r-hand-2', 'joint-r-hand-3', 'joint-r-elbow'] + \
    [f'joint-r-finger-{f}-{k}' for f in range(1, 6) for k in range(1, 5)]


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def download(dl):
    """Fetch every file into dl (raw URLs, else a blobless clone)."""
    missing = []
    for name, (path, _) in FILES.items():
        url = f'https://raw.githubusercontent.com/{REPO}/{COMMIT}/{path}'
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(os.path.join(dl, name), 'wb') as f:
                shutil.copyfileobj(r, f)
        except Exception as e:  # noqa: BLE001
            print('raw download failed:', name, e)
            missing.append(name)
    if missing:
        tmp = tempfile.mkdtemp(prefix='mh-clone-')
        subprocess.run(['git', 'clone', '-q', '--filter=blob:none', '--no-checkout', f'https://github.com/{REPO}.git', tmp], check=True)
        for name in missing:
            data = subprocess.run(['git', '-C', tmp, 'show', f'{COMMIT}:{FILES[name][0]}'], check=True, capture_output=True).stdout
            with open(os.path.join(dl, name), 'wb') as f:
                f.write(data)
    bad = {n: sha256(os.path.join(dl, n)) for n in FILES if sha256(os.path.join(dl, n)) != FILES[n][1]}
    if bad:
        raise SystemExit('sha256 mismatch: ' + json.dumps(bad, indent=1))
    print('all %d files verified' % len(FILES))


def read_obj(path):
    V, VT, groups, g = [], [], {}, None
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                VT.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                g = line.split()[1]
                groups.setdefault(g, [])
            elif line.startswith('f '):
                groups[g].append([tuple(int(a) - 1 for a in p.split('/')[:2]) for p in line.split()[1:]])
    return np.array(V), np.array(VT), groups


def read_target(path, n):
    T = np.zeros((n, 3))
    with gzip.open(path, 'rt') as f:
        for line in f:
            p = line.split()
            if len(p) == 4 and not line.startswith('#'):
                T[int(p[0])] = [float(x) for x in p[1:]]
    return T


def nail_faces(P, F, Wb, joints):
    """The nail bed of each finger: on the last bone, a connected patch of wide
    (not 'narrow' fold-loop) faces, far along the bone, the flattest candidate.
    (The architect's feasibility heuristic, hand-v2-feasibility/nailfind.py.)"""
    fc = P[F].mean(1)
    e = np.stack([np.linalg.norm(P[F[:, i]] - P[F[:, (i + 1) % 4]], axis=1) for i in range(4)], 1)
    wid = np.minimum((e[:, 0] + e[:, 2]) / 2, (e[:, 1] + e[:, 3]) / 2)
    n = np.cross(P[F[:, 2]] - P[F[:, 0]], P[F[:, 3]] - P[F[:, 1]])
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    emap = {}
    for fi, f in enumerate(F):
        for i in range(4):
            emap.setdefault(tuple(sorted((f[i], f[(i + 1) % 4]))), []).append(fi)
    adj = [[] for _ in F]
    for v in emap.values():
        if len(v) == 2:
            adj[v[0]].append(v[1])
            adj[v[1]].append(v[0])
    out, thr_used = {}, {}
    for fi_, f in enumerate(FINGERS):
        w3 = Wb[f'finger{fi_ + 1}-3.R']
        a = joints[f'joint-r-finger-{fi_ + 1}-3']
        t = joints[f'joint-r-finger-{fi_ + 1}-4']
        L = np.linalg.norm(t - a)
        ax = (t - a) / L
        on = set(np.where(w3[F].mean(1) > 0.5)[0].tolist())
        ref = np.percentile(wid[list(on)], 75)
        cand = []
        for thr in (0.5, 0.6, 0.7, 0.8, 0.9):
            wide = {s for s in on if wid[s] > ref * thr}
            comps, left = [], set(wide)
            while left:
                s = left.pop()
                c, st = {s}, [s]
                while st:
                    x = st.pop()
                    for d in adj[x]:
                        if d in left:
                            left.remove(d)
                            c.add(d)
                            st.append(d)
                comps.append(c)
            cand = [c for c in comps if 3 <= len(c) <= 16 and all((fc[i] - a) @ ax > 0.2 * L for i in c)]
            cand.sort(key=lambda c: -np.linalg.norm(n[list(c)].mean(0)))
            if cand:
                thr_used[f] = thr
                break
        out[f] = sorted(cand[0]) if cand else []
    return out, thr_used, adj


def fold_ring(F, patch, rings=2):
    """Faces around a nail patch: `rings` rings of faces sharing a vertex."""
    vset = {int(i) for q in F[patch] for i in q}
    have = set(patch)
    out = []
    for _ in range(rings):
        ring = [fi for fi in range(len(F)) if fi not in have and any(int(i) in vset for i in F[fi])]
        out.append(sorted(ring))
        have |= set(ring)
        vset |= {int(i) for q in F[ring] for i in q}
    return out


def nail_mask_check(dl, F, faceUV, VT, nails):
    """Fraction of each patch's faces whose UV centre is inside the CC0 nail
    mask texture (mpfb_fingernails.jpg, base UV layout)."""
    try:
        import bpy
    except ImportError:
        return None
    img = bpy.data.images.load(os.path.join(dl, 'mpfb_fingernails.jpg'))
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, -1)[..., 0]
    out = {}
    for f, fs in nails.items():
        uvc = VT[faceUV[fs]].mean(1)
        x = np.clip((uvc[:, 0] * w).astype(int), 0, w - 1)
        y = np.clip((uvc[:, 1] * h).astype(int), 0, h - 1)
        out[f] = round(float((px[y, x] > 0.5).mean()), 3)
    return out


def main():
    args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    dl = args.get('dl') or tempfile.mkdtemp(prefix='mh-dl-')
    os.makedirs(dl, exist_ok=True)
    if os.listdir(dl):
        raise SystemExit(f'{dl} is not empty: downloads go in their own empty directory')
    download(dl)

    V, VT, groups = read_obj(os.path.join(dl, 'base.obj'))
    with open(os.path.join(dl, 'weights.default.json')) as f:
        W = json.load(f)['weights']
    tot = np.zeros(len(V))
    for k, v in W.items():
        for i, w in v:
            tot[i] += w
    hw = np.zeros(len(V))
    for k in HAND_GROUPS:
        for i, w in W[k]:
            hw[i] += w
    frac = hw / np.maximum(tot, 1e-9)
    body = [f for f in groups['body'] if all(frac[p[0]] >= 0.5 for p in f)]
    assert all(len(f) == 4 for f in body), 'the hand is all quads'
    used = sorted({p[0] for f in body for p in f})
    remap = {i: n for n, i in enumerate(used)}
    F = np.array([[remap[p[0]] for p in f] for f in body])
    faceUV = np.array([[p[1] for p in f] for f in body])
    uv_used = sorted({int(i) for i in faceUV.ravel()})
    uv_remap = {i: n for n, i in enumerate(uv_used)}
    P = V[used]
    joints = {j: V[sorted({p[0] for f in groups[j] for p in f})].mean(0) for j in JOINTS}
    joint_verts = {j: sorted({p[0] for f in groups[j] for p in f}) for j in JOINTS}

    # weights of the kept vertices (every group that touches them)
    Wk = {}
    for k, v in W.items():
        rows = [[remap[i], round(w, 6)] for i, w in v if i in remap and w > 0]
        if rows:
            Wk[k] = rows
    Wb = {k: np.zeros(len(P)) for k in HAND_GROUPS}
    for k in HAND_GROUPS:
        for i, w in Wk.get(k, []):
            Wb[k][i] = w

    # targets: sparse deltas on the kept vertices, and on the joint centres
    targets = {}
    for name in ['caucasian-female-young'] + [f'r-hand-{t}' for t in HAND_TARGETS]:
        T = read_target(os.path.join(dl, name + '.target.gz'), len(V))
        Tk = T[used]
        nz = np.nonzero(np.abs(Tk).max(1) > 0)[0]
        targets[name] = {
            'index': nz.tolist(),
            'delta': np.round(Tk[nz], 6).tolist(),
            'joints': {j: np.round(T[joint_verts[j]].mean(0), 6).tolist() for j in JOINTS if np.abs(T[joint_verts[j]]).max() > 0},
        }

    # nail faces, on the shape the build uses (the young female target applied)
    T0 = read_target(os.path.join(dl, 'caucasian-female-young.target.gz'), len(V))
    P0 = (V + T0)[used]
    J0 = {j: (V + T0)[joint_verts[j]].mean(0) for j in JOINTS}
    nails, thr, _ = nail_faces(P0, F, Wb, J0)
    folds = {f: fold_ring(F, fs, 2) for f, fs in nails.items()}
    mask = nail_mask_check(dl, F, faceUV, VT, nails)

    cage = {
        'source': {'repo': REPO, 'commit': COMMIT, 'files': {n: s for n, (_, s) in FILES.items()},
                   'units': 'MakeHuman base mesh units (decimetres), +Y up, the figure faces +Z'},
        'verts': np.round(P, 6).tolist(),
        'quads': F.tolist(),
        'uv': np.round(VT[uv_used], 6).tolist(),
        'faceUV': [[uv_remap[int(i)] for i in q] for q in faceUV],
        'weights': Wk,
        'joints': {j: np.round(c, 6).tolist() for j, c in joints.items()},
        'targets': targets,
        'nailFaces': nails,
        'foldRing': folds,
        'nailFind': {'threshold': thr, 'maskFraction': mask},
    }
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'hand-cage.json'), 'w') as f:
        json.dump(cage, f, separators=(',', ':'))
    shutil.copy(os.path.join(dl, 'LICENSE.ASSETS.md'), os.path.join(OUT, 'LICENSE.ASSETS.md'))
    print('verts', len(P), 'quads', len(F), 'nail faces', {f: len(v) for f, v in nails.items()},
          'threshold', thr, 'in the nail mask', mask)
    print('wrote', os.path.join(OUT, 'hand-cage.json'), os.path.getsize(os.path.join(OUT, 'hand-cage.json')), 'bytes')


if __name__ == '__main__':
    main()
