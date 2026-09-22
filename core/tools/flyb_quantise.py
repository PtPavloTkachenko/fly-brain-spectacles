"""Rewrite a FLYB v1 brain file as v2: `weight` (f32 mV) -> `wq` (i16 contacts) + `w_quantum` (f64).

ADR 82. The connectome's weight IS an integer contact count times a fixed quantum (0.275 mV on the
MaleCNS exports), so this is exact, not lossy -- it just stops storing the multiplication. It halves
the weight half of the edge payload: measured on brain_c0, 206.6 -> 156.3 MB uncompressed. The .z the
glasses download gains much less, 77.0 -> 72.1 MB, because zlib was already exploiting the 788
distinct float values. Everything else in the file is copied byte for byte.

    python3 core/tools/flyb_quantise.py <in.flyb[.z]> <out.flyb[.z]>

The core reads v1 and v2, so an old file keeps working; this is only for shrinking one you already
have without re-running the exporter (which now writes v2 itself).
"""

import struct
import sys
import zlib
from pathlib import Path

import numpy as np

SZ = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 4, 7: 8}
DT = {1: np.uint8, 2: np.int8, 3: np.int16, 4: np.int32, 5: np.int64, 6: np.float32, 7: np.float64}
CODE = {v: k for k, v in DT.items()}


def read(path: Path):
    d = path.read_bytes()
    if d[:4] != b"FLYB":
        d = zlib.decompress(d)
    ver, count = struct.unpack_from("<II", d, 4)
    p, out = 12, {}
    for _ in range(count):
        (nl,) = struct.unpack_from("<H", d, p)
        p += 2
        name = d[p:p + nl].decode()
        p += nl
        code = d[p]
        (length,) = struct.unpack_from("<Q", d, p + 2)
        p += 10
        out[name] = np.frombuffer(d, DT[code], length, p).copy()
        p += length * SZ[code]
        p += (8 - p % 8) % 8
    return ver, out


def write(path: Path, arrays, version=2):
    body = bytearray(b"FLYB" + struct.pack("<II", version, len(arrays)))
    for name, arr in arrays.items():
        arr = np.ascontiguousarray(arr)
        nb = name.encode()
        body += struct.pack("<H", len(nb)) + nb + struct.pack("<BBQ", CODE[arr.dtype.type], 0, arr.size)
        body += arr.tobytes()
        body += b"\0" * ((8 - len(body) % 8) % 8)
    path.write_bytes(zlib.compress(bytes(body), 6) if path.suffix == ".z" else bytes(body))


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    ver, m = read(src)
    if "wq" in m:
        raise SystemExit(f"{src} is already v{ver} with integer weights")
    if "weight" not in m:
        raise SystemExit("no `weight` array")
    w = m["weight"].astype(np.float64)
    a = np.abs(w)
    q = float(a[a > 0].min())
    c = w / q
    r = np.rint(c)
    off = np.abs(c - r) > 1e-5 * np.maximum(np.abs(r), 1.0)
    if off.any():
        raise SystemExit(f"{int(off.sum())} of {w.size} weights are not a multiple of {q}")
    if np.abs(r).max() > 32767:
        raise SystemExit(f"contact count {int(np.abs(r).max())} does not fit int16")
    out = {}
    for k, v in m.items():
        if k == "weight":
            out["wq"] = r.astype(np.int16)
            out["w_quantum"] = np.array([q], np.float64)
        else:
            out[k] = v
    write(dst, out)
    print(f"{src.name} v{ver} -> {dst.name} v2: quantum {q}, max {int(np.abs(r).max())} contacts, "
          f"{src.stat().st_size / 1e6:.1f} -> {dst.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
