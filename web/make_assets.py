"""Build the page's static data files (ADR 61).

    python3 web/make_assets.py

Writes into web/assets/:
  eye_lattice.bin  the MaleCNS ommatidial lattice the brain is injected on (ADR 54), taken from
                   the lens's GENERATED FlyRetinaData.ts so the page, the lens and the C++ core
                   cannot drift: header + per-column side / hex x / hex y / azimuth / elevation.
  neurons.bin      per-neuron point cloud for the brain visual (see build_neurons()).
Both are small, versioned by a magic + a count, and read with one fetch each.
"""
import json
import os
import re
import struct
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "web" / "assets"
PROJECT = os.environ.get("CYBERFLY_PROJECT", "Spectacles-5.23")  # the project a change lands in first
TS = REPO / PROJECT / "Assets/Scripts/Fly/FlyRetinaData.ts"


def ts_array(text: str, name: str) -> list[int]:
    m = re.search(r"export const " + name + r" = new \w+Array\(\[([^\]]*)\]\)", text)
    if not m:
        raise SystemExit("missing " + name + " in " + str(TS))
    return [int(x) for x in m.group(1).split(",") if x.strip()]


def ts_int(text: str, name: str) -> int:
    m = re.search(r"export const " + name + r" = (\d+)", text)
    if not m:
        raise SystemExit("missing " + name)
    return int(m.group(1))


def build_eye() -> None:
    text = TS.read_text()
    n = ts_int(text, "EYE_N")
    hexn = ts_int(text, "EYE_HEX")
    left = ts_int(text, "EYE_L")
    side = ts_array(text, "EYE_SIDE")
    hx = ts_array(text, "EYE_HX")
    hy = ts_array(text, "EYE_HY")
    az = ts_array(text, "EYE_AZ")
    el = ts_array(text, "EYE_EL")
    for name, a in (("SIDE", side), ("HX", hx), ("HY", hy), ("AZ", az), ("EL", el)):
        if len(a) != n:
            raise SystemExit(f"EYE_{name} has {len(a)}, expected {n}")
    buf = bytearray()
    buf += b"EYEL"
    buf += struct.pack("<III", n, hexn, left)
    buf += bytes(side) + bytes(hx) + bytes(hy)
    buf += struct.pack(f"<{n}h", *az) + struct.pack(f"<{n}h", *el)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "eye_lattice.bin").write_bytes(buf)
    print(f"eye_lattice.bin  {len(buf)} B  {n} columns ({left} left), hex {hexn}")




# ---------------------------------------------------------------- the brain point cloud
# All 166,700 MaleCNS neurons at their REAL anatomical position (brain/results/pointcloud.npz:
# somaLocation, else the synapse-weighted mean of located partners, else the centroid — the
# `placed` flag says which), in the same unit cube and the same superclass colours the lens's
# BrainCloud uses, so the page and the glasses draw the same brain.
NPZ = REPO / "brain/results/pointcloud.npz"
SUBSET = REPO / "brain/results/cloud_subset.npz"
CLOUD_TS = REPO / PROJECT / "Assets/Scripts/Fly/BrainCloudData.ts"
ANN = Path.home() / "cyberfly_runtime/fly-wirehead/data/annotations.feather"
GRAPH = None  # set by --edges


def build_neurons(edges_k: int = 0) -> None:
    import numpy as np

    pc = np.load(NPZ)
    sub = np.load(SUBSET)
    xyz, sc, placed = pc["xyz"], pc["superclass"], pc["placed_from"]
    n = xyz.shape[0]
    text = CLOUD_TS.read_text()

    def ts_arr(name: str) -> list[int]:
        body = text.split(f"export const {name} = new ")[1]
        return json.loads(body[body.index("(") + 1: body.index(")")])

    # the lens's superclass -> hue table, rebuilt from the 16,000 sample it was generated with
    hue_of: dict[int, int] = {}
    for code, h in zip(sub["superclass"], ts_arr("CLOUD_HUE")):
        hue_of.setdefault(int(code), int(h))
    hue = np.array([hue_of.get(int(c), 120) for c in sc], dtype=np.uint8)
    # group bits (the board's NEURAL rows) are known for the 16,000 sample; the rest get the six
    # anatomical bits from the superclass name, which is how index_regions defines them anyway
    keys = ts_arr_str(text, "CLOUD_GROUP_KEYS")
    names = [str(s) for s in pc["superclass_names"]]
    group = np.zeros(n, dtype=np.uint16)
    scn = np.array(names, dtype=object)[sc]
    bit = {k: 1 << i for i, k in enumerate(keys)}
    group[np.array([s.startswith("ol_") or s == "visual_projection" for s in scn])] |= bit["optic"]
    group[scn == "cb_intrinsic"] |= bit["central"]
    group[np.array(["descending" in s for s in scn])] |= bit["descending"]
    group[np.array([s.startswith("vnc_") for s in scn])] |= bit["vnc"]
    group[np.array(["sensory" in s for s in scn])] |= bit["sensory"]
    # mushroom body = type prefix "KC", the one region index_regions cannot read off the superclass
    try:
        import pyarrow.feather as feather

        ann = feather.read_table(ANN, columns=["bodyId", "type"]).to_pandas()
        t = dict(zip(ann.bodyId.to_numpy(), ann.type.fillna("").to_numpy()))
        kc = np.array([str(t.get(int(i), "")).startswith("KC") for i in pc["ids"]])
        group[kc] |= bit["mushroom"]
    except Exception as e:  # no runtime data: the sample below still carries its 393 KCs
        print("  (mushroom from the sample only:", e, ")")
    group[sub["idx"]] |= sub["group"]  # the sample carries the command rows, measured

    q = np.round(np.clip(xyz, -1, 1) * 32767).astype("<i2")
    flag = np.where(placed == "soma", 0, np.where(placed == "partners", 1, 2)).astype(np.uint8)
    idx = sub["idx"].astype("<i4")

    ei = np.zeros(0, dtype="<u2")
    if edges_k:
        ei = build_edges(idx, edges_k)

    buf = bytearray()
    buf += b"FLYN"
    buf += struct.pack("<IIIII", 2, n, len(idx), len(ei) // 2, len(keys))
    head = json.dumps(keys).encode() + b"\0"
    head += b"\0" * (-len(head) % 8)  # the typed arrays that follow must stay 8-byte aligned
    buf += head
    buf += q.tobytes() + hue.tobytes() + flag.tobytes() + group.astype("<u2").tobytes()
    buf += idx.tobytes() + ei.tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "neurons.bin").write_bytes(buf)
    print(f"neurons.bin  {len(buf)/1e6:.2f} MB  {n} neurons, {len(idx)} streamed, {len(ei)//2} edges")


def ts_arr_str(text: str, name: str) -> list[str]:
    body = text.split(f"export const {name} = ")[1]
    return json.loads(body[body.index("["): body.index("]") + 1])


def build_edges(idx, k: int):
    """The strongest real connections INSIDE the streamed sample, as uint16 index pairs.

    The page draws a streak along an edge when its presynaptic neuron spikes, so only edges whose
    BOTH ends are in the 16,000 the brain streams are useful. CSR from the fly-wirehead graph.
    """
    import numpy as np

    g = np.load(GRAPH)
    ptr, post, w = g["ptr"], g["post"], g["weight"]
    local = np.full(int(ptr.shape[0] - 1), -1, dtype=np.int32)
    local[idx] = np.arange(len(idx), dtype=np.int32)
    pre_l, post_l, ww = [], [], []
    for a, la in zip(idx, range(len(idx))):
        s, e = int(ptr[a]), int(ptr[a + 1])
        if e <= s:
            continue
        tgt = local[post[s:e]]
        m = tgt >= 0
        if not m.any():
            continue
        pre_l.append(np.full(int(m.sum()), la, dtype=np.int32))
        post_l.append(tgt[m])
        ww.append(np.abs(w[s:e][m]))
    pre_l = np.concatenate(pre_l)
    post_l = np.concatenate(post_l)
    ww = np.concatenate(ww)
    take = np.argsort(-ww)[:k]
    out = np.empty(2 * len(take), dtype="<u2")
    out[0::2] = pre_l[take].astype("<u2")
    out[1::2] = post_l[take].astype("<u2")
    return out


# ---------------------------------------------------------------- the anatomy shells
# tools/anatomy/out/shells/*.glb are the real MaleCNS brain and VNC surfaces, already fitted into
# the SAME unit space as pointcloud.npz (tools/anatomy/process.py fits the affine from the
# soma-placed points). Decimated to ~8 k triangles each, they give the page a hull to hang the
# point cloud inside. Extracted here so the page needs no glTF loader.
SHELLS = REPO / "tools/anatomy/out/shells"
CTYPE = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def glb_mesh(path: Path):
    """POSITION + indices of the first primitive of a single-mesh GLB."""
    raw = path.read_bytes()
    assert raw[:4] == b"glTF", path
    o, js, bin_ = 12, None, None
    while o < len(raw):
        ln, kind = struct.unpack_from("<II", raw, o)
        body = raw[o + 8: o + 8 + ln]
        if kind == 0x4E4F534A:
            js = json.loads(body)
        elif kind == 0x004E4942:
            bin_ = body
        o += 8 + ln + (-ln % 4)
    prim = js["meshes"][0]["primitives"][0]

    def read(ai):
        acc = js["accessors"][ai]
        bv = js["bufferViews"][acc["bufferView"]]
        fmt, size = CTYPE[acc["componentType"]]
        nc = NCOMP[acc["type"]]
        start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = bv.get("byteStride") or size * nc
        out = []
        for i in range(acc["count"]):
            out.extend(struct.unpack_from("<" + fmt * nc, bin_, start + i * stride))
        return out

    return read(prim["attributes"]["POSITION"]), read(prim["indices"])


def build_shells() -> None:
    import numpy as np

    parts = []
    for name in ("brain_shell", "vnc_shell"):
        f = SHELLS / (name + ".glb")
        if not f.exists():
            print("  (no " + name + ")")
            continue
        pos, idx = glb_mesh(f)
        p = np.array(pos, dtype=np.float32).reshape(-1, 3)
        i = np.array(idx, dtype=np.int64)
        tri = p[i]  # expanded triangles: no index buffer, no vertex sharing to get right
        parts.append((name, np.round(np.clip(tri, -1, 1) * 32767).astype("<i2")))
    if not parts:
        return
    buf = bytearray(b"FLYS" + struct.pack("<II", 1, len(parts)))
    for name, tri in parts:
        nb = name.encode()
        buf += struct.pack("<H", len(nb)) + nb + struct.pack("<I", tri.shape[0])
        buf += tri.tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "shells.bin").write_bytes(buf)
    print("shells.bin  " + str(len(buf) // 1024) + " KB  " + ", ".join(n + " " + str(t.shape[0] // 3) + " tris" for n, t in parts))



def _lod_points(name: str = "l0"):
    """skel_l0.bin back as (table, unit-cube points, segments-per-neuron). The point INDEX here is
    exactly the index brain.js uses in the arbor texture, so a site index needs no translation."""
    import numpy as np

    raw = (OUT / f"skel_{name}.bin").read_bytes()
    if raw[:4] != b"FLYL":
        raise SystemExit("skel_" + name + ".bin: bad magic")
    ver, nN, nSeg, per = struct.unpack_from("<IIII", raw, 4)
    o = 20
    table = np.frombuffer(raw, "<i4", nN * 3, o).reshape(-1, 3)
    o += nN * 12
    q = np.frombuffer(raw, "<i2", nSeg * 6, o).reshape(-1, 3)
    return table, q.astype(np.float32) / 32767.0, int(per)


def _synapse_sites(pre, post, somas, name: str = "l0"):
    """For every synapse, the REAL skeleton point at each end (ADR 74 follow-up).

    There are no synapse-site coordinates in MaleCNS v1.0 offline -- edges.feather is
    (body_pre, body_post, weight) and annotations.feather carries somaLocation only. So the page
    cannot draw where a synapse IS. What it CAN do is stop drawing soma-to-soma: the presynaptic
    end moves to the point of the PRE neuron's own skeleton nearest the POST soma, and the
    postsynaptic end to the point of the POST neuron's own skeleton nearest the PRE soma. Both are
    measured points off skel_l0.bin, chosen by a distance, never interpolated or invented. A neuron
    with no skeleton points keeps its soma (sentinel 0xFFFFFFFF).
    """
    import numpy as np

    table, pts, per = _lod_points(name)
    n, cap = len(table), 2 * per
    first, cnt = table[:, 1], table[:, 2]
    P = np.full((n, cap, 3), 1e9, dtype=np.float32)   # every neuron's own points, densely
    I = np.zeros((n, cap), dtype=np.int32)
    for j in range(cap):
        s, e = j >> 1, j & 1
        ok = cnt > s
        gi = 2 * (first[ok] + s) + e
        P[ok, j] = pts[gi]
        I[ok, j] = gi
    m = len(pre)
    sa = np.full(m, -1, dtype=np.int64)
    sb = np.full(m, -1, dtype=np.int64)
    CH = 100000
    for s in range(0, m, CH):
        e = min(s + CH, m)
        a, b = pre[s:e].astype(np.int64), post[s:e].astype(np.int64)
        d = P[a] - somas[b][:, None, :]
        sa[s:e] = I[a, np.einsum("ijk,ijk->ij", d, d).argmin(1)]
        d = P[b] - somas[a][:, None, :]
        sb[s:e] = I[b, np.einsum("ijk,ijk->ij", d, d).argmin(1)]
        sa[s:e][cnt[a] == 0] = -1
        sb[s:e][cnt[b] == 0] = -1
    both = int(((sa >= 0) & (sb >= 0)).sum())
    print(f"  synapse sites: {both}/{m} ({100*both/m:.2f} %) with a real skeleton point at BOTH "
          f"ends, {int((sa < 0).sum())} pre and {int((sb < 0).sum())} post fell back to the soma")
    out = np.empty((2, m), dtype="<u4")
    out[0] = np.where(sa < 0, 0xFFFFFFFF, sa)
    out[1] = np.where(sb < 0, 0xFFFFFFFF, sb)
    return out, both


def build_pulse_edges(k: int = 6) -> None:
    import numpy as np

    g = np.load(GRAPH)
    ptr, post, w = g["ptr"], g["post"], g["weight"]
    n = int(ptr.shape[0] - 1)
    pre_o = np.empty(n * k, dtype="<u4")
    post_o = np.empty(n * k, dtype="<u4")
    w_o = np.empty(n * k, dtype=np.float32)
    m = 0
    for i in range(n):
        s, e = int(ptr[i]), int(ptr[i + 1])
        if e <= s:
            continue
        ww = w[s:e]
        take = np.argsort(-np.abs(ww))[:k] if (e - s) > k else np.arange(e - s)
        t = len(take)
        pre_o[m:m + t] = i
        post_o[m:m + t] = post[s:e][take]
        w_o[m:m + t] = ww[take]
        m += t
    pre_o, post_o, w_o = pre_o[:m], post_o[:m], w_o[:m]
    # weight -> one signed byte: the sign is the transmitter, the magnitude is |w| on its own scale
    a = np.abs(w_o)
    lim = float(np.percentile(a, 99.5))
    q = np.clip(np.round((a / max(1e-9, lim)) * 127), 1, 127).astype(np.int8)
    q[w_o < 0] = -q[w_o < 0]
    sites = None
    try:
        sites, _ = _synapse_sites(pre_o, post_o, np.load(NPZ)["xyz"].astype(np.float32))
    except SystemExit:
        raise
    except Exception as e:
        print("  (no synapse sites:", e, ") -- the page falls back to soma to soma")
    ver = 3 if sites is not None else 2
    buf = bytearray(b"FLYE" + struct.pack("<IIIf", ver, m, k, lim))
    buf += pre_o.tobytes() + post_o.tobytes() + q.tobytes()
    if sites is not None:
        buf += sites[0].tobytes() + sites[1].tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "edges.bin.new"
    tmp.write_bytes(buf)
    tmp.replace(OUT / "edges.bin")
    pos = int((w_o > 0).sum())
    print(f"edges.bin  v{ver}  {len(buf)/1e6:.1f} MB  {m} edges (top {k} out of each neuron), "
          f"{100*pos/m:.0f} % excitatory, |w| p99.5 = {lim:.2f}")



# ---------------------------------------------------------------- real morphology, what there is of it
# There are NO synapse-site coordinates offline: edges.feather is (body_pre, body_post, weight) and
# annotations.feather carries somaLocation only, so a per-neuron arbor cloud cannot be built without
# a download. What DOES exist is `tools/anatomy/out`: 39 real skeletons (the readout cells the
# dashboard already names) and 16 neuropil surfaces, both already fitted into the pointcloud unit
# space. Both ship, and each skeleton carries the index of its own neuron so it lights from its
# own measured spikes.
SKEL = REPO / "tools/anatomy/out/skeletons_all.json"
NEUROPILS = REPO / "tools/anatomy/out/neuropils"


def build_skeletons() -> None:
    import numpy as np

    if not SKEL.exists():
        print("  (no skeletons_all.json)")
        return
    sk = json.loads(SKEL.read_text())
    ids = np.load(NPZ)["ids"]
    where = {int(b): i for i, b in enumerate(ids)}
    names, metas = [], []
    pts, segs = [], []
    for s in sk:
        idx = where.get(int(s["bodyId"]), -1)
        a = len(pts) // 3
        for pl in s["polylines"]:
            n = len(pl) // 3
            if n < 2:
                continue
            base = len(pts) // 3
            for j in range(n):
                pts.extend((pl[3 * j], pl[3 * j + 1], pl[3 * j + 2]))
            for j in range(n - 1):
                segs.extend((base + j, base + j + 1))
        metas.append((idx, a, len(pts) // 3 - a))
        names.append(s["type"] + ("_" + s["side"] if s.get("side") else ""))
    q = np.round(np.clip(np.array(pts, dtype=np.float32), -1, 1) * 32767).astype("<i2")
    seg = np.array(segs, dtype="<u4")
    meta = np.array([v for m in metas for v in m], dtype="<i4")
    head = json.dumps(names).encode() + b"\0"
    head += b"\0" * (-len(head) % 8)
    buf = bytearray(b"FLYK" + struct.pack("<IIII", 1, len(metas), len(q) // 3, len(seg) // 2))
    buf += head + meta.tobytes() + q.tobytes() + seg.tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "skeletons.bin").write_bytes(buf)
    print(f"skeletons.bin  {len(buf)/1e6:.2f} MB  {len(metas)} real skeletons, "
          f"{len(q)//3} points, {len(seg)//2} segments, {sum(1 for m in metas if m[0] >= 0)} matched to a neuron")


def build_neuropils() -> None:
    import numpy as np

    if not NEUROPILS.exists():
        print("  (no neuropils)")
        return
    parts = []
    for f in sorted(NEUROPILS.glob("*.glb")):
        pos, idx = glb_mesh(f)
        p = np.array(pos, dtype=np.float32).reshape(-1, 3)
        tri = p[np.array(idx, dtype=np.int64)]
        parts.append((f.stem, np.round(np.clip(tri, -1, 1) * 32767).astype("<i2")))
    buf = bytearray(b"FLYS" + struct.pack("<II", 1, len(parts)))
    for name, tri in parts:
        nb = name.encode()
        buf += struct.pack("<H", len(nb)) + nb + struct.pack("<I", tri.shape[0])
        buf += tri.tobytes()
    (OUT / "neuropils.bin").write_bytes(buf)
    print(f"neuropils.bin  {len(buf)//1024} KB  {len(parts)} neuropils, "
          f"{sum(t.shape[0] for _, t in parts)//3} triangles")


# ---------------------------------------------------------------- every neuron's real arbor
# 166,700 precomputed MaleCNS skeletons (5.4 GB, tools/anatomy/fetch_all.py) decimated into levels.
# The decimation keeps every Nth SEGMENT of the real skeleton: the arbor stays where it is, points
# the way it really points and spans what it really spans — it is just drawn sparser. That is said
# on screen; nothing here smooths, re-routes or invents a branch.
#
# Layout (`FLYL`): magic, version, nNeuron, nSeg, segsPerNeuron, then per neuron
# int32 (owner, firstSeg, segCount), then int16 xyz for the 2*nSeg endpoints.
#
# VERSION 2+ appends uint16 DIST for the same 2*nSeg endpoints: the PATH length from that neuron's
# own soma to that point, measured along the skeleton's own edges (Dijkstra from the skeleton node
# nearest the soma the point cloud draws), quantised at DIST_Q steps per unit-cube unit. It is what
# lets a spike travel OUT along the arbor instead of flashing the whole cell. Points the skeleton
# graph cannot reach from the soma (a detached fragment — the connectome's skeletons are not all
# one piece) fall back to the straight-line distance and are counted in the build line.
RAWSKEL = Path.home() / "cyberfly_runtime/anatomy/raw/skel"
# tools/anatomy/process.py fitted this from the soma-placed points: MaleCNS voxel -> the unit cube
VOX = 1.607652425737329e-05
OFF = (-0.7727663679989423, 0.5928539849102981, -1.1632410273713247)
# 1 unit-cube unit = 1/VOX MaleCNS voxels x 8 nm = 0.49762 mm, so a millimetre is 2.0096 units.
MM_PER_UNIT = 8e-6 / VOX
# FLYL version -> uint16 steps per unit-cube unit. v2 saturated at 4 units and the longest
# arbors (1.99 mm) were clipping; v3 halves it to 8 units of reach at 0.06 um of resolution, which
# is still 80x finer than the int16 the positions themselves are stored in. The version carries the
# scale, so a reader never has to guess and v2 files keep working.
FLYL_VERSION = 3
DIST_Q = 8192.0


def _skel_one(args):
    """One neuron: read its skeleton, walk it from the soma, keep every Nth segment.

    Returns (int16 xyz[2k,3], uint16 dist[2k], detached) or None. `dist` is the PATH length from
    the soma node along the skeleton's own edges; nothing here moves, smooths or invents a point.
    """
    import numpy as np

    bid, anchor, segs_per_neuron = args
    f = RAWSKEL / f"{bid // 1000:06d}" / str(bid)
    try:
        raw = f.read_bytes()
    except OSError:
        return None
    if len(raw) < 8:
        return None
    nv, ne = struct.unpack_from("<II", raw, 0)
    need = 8 + nv * 12 + ne * 8
    if ne < 1 or len(raw) < need:
        return None
    v = np.frombuffer(raw, "<f4", nv * 3, 8).reshape(-1, 3)
    ea = np.frombuffer(raw, "<u4", ne * 2, 8 + nv * 12).reshape(-1, 2)

    # every vertex into the unit cube first: the walk is measured in the space the page draws in
    p = v / 8.0                                          # nanometres -> MaleCNS voxels
    uv = np.empty_like(p)
    uv[:, 0] = p[:, 0] * VOX + OFF[0]
    uv[:, 1] = -(p[:, 1] * VOX) + OFF[1]                 # the y flip of the fitted affine
    uv[:, 2] = p[:, 2] * VOX + OFF[2]

    # the soma node: the skeleton vertex nearest the position the point cloud draws this neuron at
    d0 = uv - np.asarray(anchor, dtype=np.float32)
    root = int(np.argmin(np.einsum("ij,ij->i", d0, d0)))

    a, b = ea[:, 0].astype(np.int64), ea[:, 1].astype(np.int64)
    w = np.linalg.norm(uv[a] - uv[b], axis=1).astype(np.float64)
    try:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import dijkstra

        g = coo_matrix((w, (a, b)), shape=(nv, nv))
        dist = dijkstra(g + g.T, directed=False, indices=root)
    except Exception:                                    # no scipy: a plain BFS over the tree
        dist = _walk(nv, a, b, w, root)
    bad = ~np.isfinite(dist)
    detached = int(bad.sum())
    if detached:                                         # a fragment the soma cannot reach
        dist[bad] = np.linalg.norm(uv[bad] - np.asarray(anchor, dtype=np.float32), axis=1)

    step = max(1, ne // segs_per_neuron)
    e = ea[::step][:segs_per_neuron]
    flat = e.reshape(-1)
    q = np.round(np.clip(uv[flat], -1, 1) * 32767).astype("<i2")
    dq = np.clip(np.round(dist[flat] * DIST_Q), 0, 65535).astype("<u2")
    return q, dq, detached


def _walk(nv, a, b, w, root):
    """Cumulative edge length from `root`, breadth first. The scipy-free fallback."""
    import numpy as np

    deg = np.bincount(np.concatenate([a, b]), minlength=nv)
    head = np.zeros(nv + 1, dtype=np.int64)
    np.cumsum(deg, out=head[1:])
    nxt = head[:-1].copy()
    adj = np.empty(2 * len(a), dtype=np.int64)
    wl = np.empty(2 * len(a), dtype=np.float64)
    for src, dst, ww in ((a, b, w), (b, a, w)):
        for i in range(len(src)):
            j = nxt[src[i]]
            adj[j] = dst[i]
            wl[j] = ww[i]
            nxt[src[i]] = j + 1
    dist = np.full(nv, np.inf)
    dist[root] = 0.0
    stack = [root]
    while stack:
        u = stack.pop()
        for j in range(head[u], head[u + 1]):
            k = adj[j]
            nd = dist[u] + wl[j]
            if nd < dist[k]:
                dist[k] = nd
                stack.append(k)
    return dist


def build_skeleton_lod(segs_per_neuron: int = 12, name: str = "l0", workers: int = 8) -> None:
    import numpy as np
    from concurrent.futures import ProcessPoolExecutor

    npz = np.load(NPZ)
    ids = npz["ids"].astype(np.int64)
    anchors = npz["xyz"].astype(np.float32)
    n = len(ids)

    out = [None] * n
    jobs = [(int(ids[i]), anchors[i], segs_per_neuron) for i in range(n)]
    with ProcessPoolExecutor(workers) as ex:
        for i, r in enumerate(ex.map(_skel_one, jobs, chunksize=256)):
            out[i] = r
            if i and i % 20000 == 0:
                print(f"  {i}/{n} skeletons", flush=True)

    table = np.zeros((n, 3), dtype="<i4")
    chunks, dchunks = [], []
    seg = 0
    missing = detached = 0
    for i, r in enumerate(out):
        if r is None or not len(r[0]):
            missing += 1
            table[i] = (i, seg, 0)
            continue
        q, dq, det = r
        detached += 1 if det else 0
        k = len(q) // 2
        table[i] = (i, seg, k)
        seg += k
        chunks.append(q)
        dchunks.append(dq)
    pts = np.concatenate(chunks) if chunks else np.zeros((0, 3), dtype="<i2")
    dst = np.concatenate(dchunks) if dchunks else np.zeros(0, dtype="<u2")
    buf = bytearray(b"FLYL" + struct.pack("<IIII", FLYL_VERSION, n, seg, segs_per_neuron))
    buf += table.tobytes() + pts.tobytes() + dst.tobytes()
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / f"skel_{name}.bin.new"
    tmp.write_bytes(buf)
    tmp.replace(OUT / f"skel_{name}.bin")                # atomic: the page never serves half a file
    print(f"skel_{name}.bin  {len(buf)/1e6:.1f} MB  {n} neurons, {seg} segments "
          f"({segs_per_neuron}/neuron cap), {missing} without a skeleton, "
          f"{detached} with a fragment the soma cannot reach, "
          f"path length quantised at {DIST_Q:.0f}/unit ({MM_PER_UNIT:.5f} mm per unit)")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--graph", default=str(Path.home() / "cyberfly_runtime/fly-wirehead/data/graph.npz"))
    ap.add_argument("--edges", type=int, default=60000, help="strongest connections inside the streamed sample")
    ap.add_argument("--eye-only", action="store_true")
    ap.add_argument("--edges-only", action="store_true", help="just edges.bin (needs skel_l0.bin)")
    ap.add_argument("--lod", type=int, default=0, help="segments per neuron for a full-skeleton level")
    ap.add_argument("--lod-name", default="l0")
    ap.add_argument("--workers", type=int, default=8, help="processes for the skeleton walk")
    ap.add_argument("--out-degree", type=int, default=6, help="strongest outgoing edges kept per neuron")
    a = ap.parse_args()
    if a.lod:
        build_skeleton_lod(a.lod, a.lod_name, a.workers)
        raise SystemExit(0)
    if a.edges_only:
        GRAPH = Path(a.graph)
        globals()["GRAPH"] = GRAPH
        build_pulse_edges(a.out_degree)
        raise SystemExit(0)
    build_eye()
    if not a.eye_only:
        build_shells()
        build_skeletons()
        build_neuropils()
        GRAPH = Path(a.graph)
        globals()["GRAPH"] = GRAPH
        build_neurons(a.edges if GRAPH.exists() else 0)
        if GRAPH.exists():
            build_pulse_edges(a.out_degree)


# ---------------------------------------------------------------- the connections that carry pulses
# The page draws a pulse leaving a neuron the moment it spikes and travelling to the target along a
# REAL synapse. 25.6 M edges is too many to ship, so we take the K strongest OUTGOING edges of every
# neuron (not the K strongest overall): that way every neuron that fires has something to send, and
# no region is silent because its synapses happen to be weaker. Sign comes from the weight.
