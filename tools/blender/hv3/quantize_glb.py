"""Quantize a hand GLB's vertex attributes (KHR_mesh_quantization).

Positions stay float: the nails' canonical frames (nailFrame / nailHalf)
are in each nail mesh's own space, and a quantized position needs a node
scale to undo it. Everything else shrinks:

  NORMAL      float32 x3 -> int16 normalized (stride 8)
  TEXCOORD_n  float32 x2 -> uint16 normalized (when inside [0, 1])
  COLOR_0     float32 / uint16 x4 -> uint8 normalized
  WEIGHTS_0   float32 x4 -> uint8 normalized, each vertex summing to 255

Usage: python quantize_glb.py in.glb [out.glb]   (out defaults to in)
"""
import json
import struct
import sys

import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    b = open(path, 'rb').read()
    magic, ver, length = struct.unpack_from('<III', b, 0)
    assert magic == 0x46546C67 and ver == 2
    jlen, jtype = struct.unpack_from('<II', b, 12)
    J = json.loads(b[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from('<II', b, off)
    B = b[off + 8: off + 8 + blen]
    return J, B


def write_glb(path, J, B):
    js = json.dumps(J, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    B = B + b'\0' * ((4 - len(B) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(B)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, total))
        fh.write(struct.pack('<II', len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack('<II', len(B), 0x004E4942))
        fh.write(B)


def accessor_data(J, B, i):
    a = J['accessors'][i]
    bv = J['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']])
    n, c = a['count'], NCOMP[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0) or dt.itemsize * c
    return np.ndarray(shape=(n, c), dtype=dt, buffer=B, offset=start, strides=(stride, dt.itemsize)).copy()


def quantize(J, B):
    used = {}   # accessor index -> semantic
    for m in J['meshes']:
        for p in m['primitives']:
            for sem, ai in p['attributes'].items():
                used[ai] = sem
            for t in p.get('targets', []):
                for sem, ai in t.items():
                    used[ai] = 'TARGET'
    new_bin = bytearray()
    new_views = []

    def add_view(data, target=None, stride=None):
        while len(new_bin) % 4:
            new_bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(new_bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        if stride:
            v['byteStride'] = stride
        new_bin.extend(data)
        new_views.append(v)
        return len(new_views) - 1

    for i, a in enumerate(J['accessors']):
        d = accessor_data(J, B, i)
        sem = used.get(i)
        is_index = any(p.get('indices') == i for m in J['meshes'] for p in m['primitives'])
        target = 34963 if is_index else (34962 if sem else None)
        q = None
        if sem == 'NORMAL' and a['componentType'] == 5126:
            n = d.astype(np.float64)
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
            s = np.round(n * 32767).astype(np.int16)
            q = np.zeros((len(s), 4), np.int16)
            q[:, :3] = s
            a.update(componentType=5122, normalized=True)
            view = add_view(q.tobytes(), target, 8)
        elif sem and sem.startswith('TEXCOORD') and a['componentType'] == 5126 and d.min() >= 0 and d.max() <= 1:
            q = np.round(d.astype(np.float64) * 65535).astype(np.uint16)
            a.update(componentType=5123, normalized=True)
            view = add_view(q.tobytes(), target, 4)
        elif sem == 'COLOR_0' and a['componentType'] in (5126, 5123):
            f = d.astype(np.float64) / (65535.0 if a['componentType'] == 5123 else 1.0)
            q = np.round(np.clip(f, 0, 1) * 255).astype(np.uint8)
            if q.shape[1] == 3:
                q = np.concatenate([q, np.full((len(q), 1), 255, np.uint8)], 1)
                a['type'] = 'VEC4'
            a.update(componentType=5121, normalized=True)
            view = add_view(q.tobytes(), target, 4)
        elif sem == 'WEIGHTS_0' and a['componentType'] == 5126:
            w = np.clip(d.astype(np.float64), 0, None)
            w /= np.maximum(w.sum(1, keepdims=True), 1e-12)
            q = np.floor(w * 255).astype(np.int64)
            # hand the rounding remainder to the largest fractions: rows sum to 255
            rem = 255 - q.sum(1)
            frac = w * 255 - q
            order = np.argsort(-frac, axis=1)
            for k in range(4):
                give = rem > k
                q[give, order[give, k]] += 1
            q = q.astype(np.uint8)
            a.update(componentType=5121, normalized=True)
            view = add_view(q.tobytes(), target, 4)
        else:
            stride = None
            if sem:
                stride = d.dtype.itemsize * d.shape[1]
                if stride % 4:
                    stride = None
            view = add_view(np.ascontiguousarray(d).tobytes(), target, stride)
        if q is not None:
            a.pop('min', None)
            a.pop('max', None)
        a['bufferView'] = view
        a.pop('byteOffset', None)
    # images / other views that are not accessors' (none expected in a hand file)
    for k, im in enumerate(J.get('images', [])):
        if 'bufferView' in im:
            bv = J['bufferViews'][im['bufferView']]
            data = B[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
            im['bufferView'] = add_view(data)
    J['bufferViews'] = new_views
    J['buffers'] = [{'byteLength': len(new_bin)}]
    for key in ('extensionsUsed', 'extensionsRequired'):
        lst = J.setdefault(key, [])
        if 'KHR_mesh_quantization' not in lst:
            lst.append('KHR_mesh_quantization')
    return J, bytes(new_bin)


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    J, B = read_glb(src)
    J, B = quantize(J, B)
    write_glb(dst, J, B)


if __name__ == '__main__':
    main()
