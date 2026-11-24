"""Build public/models/hand.glb from tools/blender/src/hand-right.glb.

Run (Blender 5.3 as a Python module, headless):
    /home/claude/bpyenv/bin/python tools/blender/build_hand.py [--steps=nails,sculpt,masks] [--qa]

Pipeline: import -> sculpt -> nails -> rig -> masks -> export -> checks (-> QA renders).
Nothing is edited by hand; every number lives in params.py; no randomness, so
two runs give the same file (checked: report.json carries the sha256).

Writes public/models/hand.glb and tools/blender/out/report.json (counts, bytes,
every check with pass/fail). Exit code 1 when a check fails.
"""
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

import bpy  # noqa: E402

import params as P  # noqa: E402
import gltfio  # noqa: E402

# The steps, in order (each is a module here with build(scene, report, check)).
ALL_STEPS = [s for s in ('sculpt', 'nails', 'rig', 'masks') if os.path.exists(os.path.join(HERE, s + '.py'))]


def parse_args(argv):
    flags = {}
    for a in argv:
        if a.startswith('--'):
            k, _, v = a[2:].partition('=')
            flags[k] = v if v else True
    return flags


def main():
    flags = parse_args(sys.argv[1:])
    steps = ALL_STEPS if 'steps' not in flags else [s for s in str(flags['steps']).split(',') if s]
    src = os.path.join(HERE, 'src', 'hand-right.glb')
    out_glb = flags.get('out') or os.path.join(ROOT, 'public', 'models', 'hand.glb')
    out_dir = os.path.join(HERE, 'out')
    os.makedirs(out_dir, exist_ok=True)

    t0 = time.time()
    report = {'source': os.path.relpath(src, ROOT), 'steps': steps, 'checks': [], 'counts': {}}

    def check(name, ok, value=None, gate=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'value': value, 'gate': gate})
        print(('PASS ' if ok else 'FAIL ') + name + ('' if value is None else f'  value={value}') + ('' if gate is None else f'  gate={gate}'))

    scene = gltfio.import_source(src)
    hand = scene['hand']
    rig = scene['rig']
    nails = scene['nails']
    report['counts']['source'] = gltfio.counts(hand, nails)

    if 'sculpt' in steps:
        import sculpt as S
        S.build(scene, report, check)
    if 'nails' in steps:
        import nails as N
        N.build(scene, report, check)
    if 'rig' in steps:
        import rig as RG
        RG.build(scene, report, check)
    if 'masks' in steps:
        import masks as M
        M.build(scene, report, check)

    report['counts']['built'] = gltfio.counts(hand, scene['nails'])
    gltfio.export(scene, out_glb)
    size = os.path.getsize(out_glb)
    with open(out_glb, 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    report['output'] = {'path': os.path.relpath(out_glb, ROOT), 'bytes': size, 'sha256': sha}

    # Re-import the written file and check what the game will see.
    gltfio.verify_export(out_glb, scene, report, check)

    c = report['counts']['built']
    full = 'sculpt' in steps and 'nails' in steps
    # The vertex cap is a property of the finished asset (sculpt.py lightens
    # the forearm; a build without it only reports the count).
    check('total verts (skin + nails) <= %d' % P.CAP_TOTAL_VERTS, c['total_verts'] <= P.CAP_TOTAL_VERTS or not full,
          c['total_verts'], P.CAP_TOTAL_VERTS if full else 'info (partial build)')
    check('glb bytes <= %d' % P.CAP_GLB_BYTES, size <= P.CAP_GLB_BYTES, size, P.CAP_GLB_BYTES)

    if flags.get('qa'):
        import qa
        gltfio.reset()
        qa.render_all(out_glb, out_dir, report)

    report['seconds'] = round(time.time() - t0, 2)
    with open(os.path.join(out_dir, 'report.json'), 'w') as f:
        json.dump(report, f, indent=1)
    failed = [c for c in report['checks'] if not c['pass']]
    print(f'{len(report["checks"]) - len(failed)}/{len(report["checks"])} checks pass; {size} bytes; sha256 {sha[:16]}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
