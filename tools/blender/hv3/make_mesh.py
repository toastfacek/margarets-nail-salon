"""Mesh the hv3 hand SDF: python3 make_mesh.py out.npz [h0] [r]"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import hand as H  # noqa: E402
import mesher  # noqa: E402
import skeleton as SK  # noqa: E402


def unit_(v):
    return v / np.linalg.norm(v)


def bbox(hand):
    pts = [hand.forearm.p]
    for t in hand.fingers.values():
        pts.append(t.p)
    pts = np.vstack(pts)
    return pts.min(0) - 26.0, pts.max(0) + 26.0


def main():
    out = sys.argv[1]
    h0 = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
    r = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    hand = H.Hand()
    lo, hi = bbox(hand)
    fn = getattr(hand, 'eval_detail', hand.eval)
    V, Q = mesher.surface_nets(fn, lo, hi, h0=h0, r=r)
    NV, NF, NC = [], [], []
    off = 0
    if hand.nails:
        for f, nu in hand.nails.items():
            v, fq, loc = nu.plate(cols=25, rows=34)
            NV.append(v)
            NF.append(fq + off)
            # the free edge (past the hyponychium) reads lighter
            NC.append(np.clip((loc[:, 1] - nu.yh - 0.2) / 0.6, 0, 1))
            off += len(v)
    foc = {}
    if hand.nails:
        nu = hand.nails['index']
        foc['T_nail'] = nu.o + nu.F * 0.5 * (nu.yc + nu.yh) + nu.W * 5
        foc['D_nail'] = unit_(nu.W * 1.0 + nu.F * 0.55 - nu.U * 0.35)
        nt = hand.nails['thumb']
        foc['T_tnail'] = nt.o + nt.F * 0.5 * (nt.yc + nt.yh) + nt.W * 5
        foc['D_tnail'] = unit_(nt.W * 1.0 + nt.F * 0.5)
    np.savez_compressed(out, V=V.astype(np.float32), Q=Q.astype(np.int32), **foc,
                        **({'NV': np.vstack(NV).astype(np.float32), 'NF': np.vstack(NF).astype(np.int32), 'NC': np.concatenate(NC).astype(np.float32)} if NV else {}))


if __name__ == '__main__':
    main()
