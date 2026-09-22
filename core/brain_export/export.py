"""Export the fly brain the worker runs into ONE binary file for the native core (FlyBrainCore).

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/brain_export/export.py \
        --out <repo>/core/brain_export/out/brain_full.flyb [--cmin 5] [--compact]

Everything the per-fly loop needs is taken from the SAME objects worker.py uses
(VisualMemoryBrain + channels.index_senses / index_readouts / index_regions + the cloud sample),
so the native core cannot drift from the Python reference.

File format (little endian), "FLYB" v2:
    magic "FLYB" | u32 version | u32 count
    count x record: u16 name_len | name (utf8) | u8 dtype | u8 pad | u64 length | data | pad to 8
    dtype: 1=u8 2=i8 3=i16 4=i32 5=i64 6=f32 7=f64

v2 (16.09, ADR 82) writes the synaptic weight as `wq` (i16, signed CONTACT COUNT) plus `w_quantum`
(f64, mV per contact) instead of `weight` (f32 mV). That is what the connectome actually holds -- the
raw column is an integer contact count and the weight is contacts x 0.275 mV -- so it is bit-exact,
not a compression, and it halves the edge payload's weight half (100.6 -> 50.3 MB of 201 MB on
brain_c0). The core reads either form: a v1 file's f32 weights are quantised back to integers on
load. Contacts fit i16 comfortably (max 2591 measured on the full graph); the plastic KC->MBON
baselines and kc_inh_base stay f32, they are not on the contact grid once learning moves them.

Arrays: n, ptr, post, wq, w_quantum, rest, kc_mask, modulation_mask, retina, retina_uv, lamina, sugar, r8,
r8_uv, r8_channel, adaptation (jump, tau), cloud, and groups "sense:<name>:<L|R|both>",
"read:<name>", "region:<name>".

--cmin N   : drop every synapse with fewer than N contacts (the pruned brain).
--compact  : also drop the outgoing edges of modulatory cells (dopamine/octopamine/serotonin).
             The kernel never delivers current along them (only a modulation trace nobody reads
             while weights are frozen), so they cost memory only.
"""

import argparse
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "brain_server"))
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime"))
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

DTYPES = {np.uint8: 1, np.int8: 2, np.int16: 3, np.int32: 4, np.int64: 5, np.float32: 6, np.float64: 7}


# ADR 82: the weight as the integer it really is. The quantum is the smallest |w| in the file (the
# MaleCNS exports: 0.275 mV, one synaptic contact); every weight must be a whole number of them, or
# the export refuses rather than silently rounding a brain nobody checked.
def quantise(weight):
    w = np.asarray(weight, np.float64)
    a = np.abs(w)
    q = float(a[a > 0].min())
    c = w / q
    r = np.rint(c)
    off = np.abs(c - r) > 1e-5 * np.maximum(np.abs(r), 1.0)
    if off.any():
        raise SystemExit(f"weights are not a multiple of {q}: {int(off.sum())} of {w.size} edges off the grid")
    if np.abs(r).max() > 32767:
        raise SystemExit(f"contact count {int(np.abs(r).max())} does not fit int16")
    return {"wq": r.astype(np.int16), "w_quantum": np.array([q], np.float64)}


def write(path, arrays):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"FLYB" + struct.pack("<II", 2, len(arrays)))
        for name, arr in arrays.items():
            arr = np.ascontiguousarray(arr)
            code = DTYPES[arr.dtype.type]
            nb = name.encode()
            f.write(struct.pack("<H", len(nb)) + nb + struct.pack("<BBQ", code, 0, arr.size))
            f.write(arr.tobytes())
            f.write(b"\0" * ((-f.tell()) % 8))


def hot_order(brain, senses, n):
    """new index of each old index: the neurons that RECEIVE the most synaptic deliveries first.
    Measured on a short sense battery with the package's own step; 57 % of all deliveries land on
    the top 10 % of targets (14.09), so packing them contiguously is where the device cache wins."""
    import channels
    from engine.engine import kernel_function

    brain.advance = kernel_function(brain, "par3")
    battery = [
        {"light": 0.627},
        {"object": {"L": 0.8}, "odor": {"L": 0.8, "R": 0.4}},
        {"motion": {"R": 0.8}},
        {"loom": {"L": 1.0}},
        {"sweet": 1.0, "odor": {"L": 0.6, "R": 0.6}},
        {"bitter": 1.0},
        {"touch": {"L": 1.0, "R": 1.0}},
        {"wind": {"L": 1.0, "R": 1.0}},
        {"bristle": {"L": 1.0, "R": 1.0}},
        {"hunger": 1.0},
        {"loom_wall": {"L": 1.0, "R": 1.0}},
    ]
    rng = np.random.default_rng(1)
    total = np.zeros(n, np.int64)
    for ch in battery:
        stim = channels.build_stim(senses, {"light": 0.627, **ch})
        img = rng.integers(120, 200, (8, 16, 3)).astype(np.uint8)
        for _ in range(100):
            c, _ = brain.rgb_step(img, 10.0, learning=False, stimulation=stim or None)
            total += c
    brain.reset()
    outdeg = np.diff(brain.ptr)
    hits = np.bincount(brain.post, weights=np.repeat(total.astype(np.float64), outdeg), minlength=n)
    rank = np.lexsort((np.arange(n), -hits))  # hottest first, ties by old index
    P = np.empty(n, np.int32)
    P[rank] = np.arange(n, dtype=np.int32)
    return P


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cmin", type=int, default=0)
    ap.add_argument("--compact", action="store_true")
    ap.add_argument("--mask", help="npy bool array over the ORIGINAL edge order: the LITE cut built and "
                                   "measured by core/brain_prune/lite.py (top-k floor + protected populations)")
    ap.add_argument("--cloud", type=int, default=16000)
    ap.add_argument("--order", choices=["none", "hot"], default="none",
                    help="hot = renumber neurons by measured delivery hits (cache locality on the device; exact)")
    a = ap.parse_args()

    from flywirehead.neural.rule import PARAMETERS as RULE
    # 21.09 Pavlo: the memory trace fades with tau 3 h, not rule.py's 1800 s (30 min). She now learns by
    # herself all the time, so forgetting is what keeps accidental pairings from piling up -- but half an
    # hour threw away a room she was still in. 3 h is the range of a real fly's single-trial memory.
    MEMORY_DECAY_S = 10800.0
    from flywirehead.neural.visual import VisualMemoryBrain

    import worker

    brain = VisualMemoryBrain()
    brain.weights_frozen = True
    senses, reads, regions = worker.prepare(brain)

    ptr, post, weight = brain.ptr, brain.post, brain.weight.copy()
    n = brain.n
    pre = np.repeat(np.arange(n, dtype=np.int32), np.diff(ptr))
    keep = np.ones(len(post), bool)
    if a.cmin > 0:
        keep &= np.rint(np.abs(weight) / 0.275).astype(np.int32) >= a.cmin
    if a.mask:
        m = np.load(a.mask)
        if m.shape != keep.shape or m.dtype != bool:
            raise ValueError(f"--mask must be a bool array of {keep.shape}, got {m.dtype} {m.shape}")
        keep &= m
    if a.compact:
        keep &= brain.modulation_mask[pre] == 0
    circ = brain.circuit
    keep[circ["edges"]] = True  # the dopamine-plastic KC->MBON synapses always stay
    # APL -> KC, the mushroom body's own sparsening loop (ADR 67). APL is the single giant GABAergic
    # neuron per hemisphere that every Kenyon cell excites and that inhibits them all back; it is
    # what keeps a real odour code sparse (Lin et al. 2014). Exported as its own edge class so the
    # core can scale JUST these synapses, with the baselines alongside for an exact restore.
    from flywirehead.neural.common import annotations as _ann
    _types = _ann(brain.ids).type.fillna("").to_numpy().astype(str)
    _apl = np.flatnonzero(_types == "APL")
    _iskc = np.zeros(n, bool)
    _iskc[circ["kc"]] = True
    _inh = np.concatenate([np.arange(ptr[i], ptr[i + 1])[_iskc[post[ptr[i]:ptr[i + 1]]]] for i in _apl]).astype(np.int64) \
        if len(_apl) else np.zeros(0, np.int64)
    keep[_inh] = True  # never pruned: the core must be able to hand them back exactly
    newidx = np.cumsum(keep) - 1
    if not keep.all():
        ptr = np.r_[0, np.cumsum(np.bincount(pre[keep], minlength=n))].astype(np.int64)
        post, weight = post[keep], weight[keep]
    plastic = newidx[circ["edges"]].astype(np.int64)
    assert np.array_equal(weight[plastic], brain.baseline_plastic)
    kc_inh = newidx[_inh].astype(np.int64)
    kc_inh_base = weight[kc_inh].copy()

    # Cache order (exact): renumber neurons so the targets that receive most synaptic deliveries sit
    # first and contiguous in the core's Cell array. Every index the core sees is relabelled here;
    # the two orders the CPU kernel depends on (initial active list, drive-change scan) are exported
    # in the ORIGINAL order (`init_active`, `order`), so spikes stay identical (ADR 47).
    P = np.arange(n, dtype=np.int32)  # new index of each old index
    Q = P.copy()  # old index of each new index
    if a.order == "hot":
        P = hot_order(brain, senses, n)
        Q = np.argsort(P, kind="stable").astype(np.int32)
        lens = np.diff(ptr)
        L = lens[Q]
        new_ptr = np.r_[0, np.cumsum(L)].astype(np.int64)
        starts = ptr[Q]
        idx = np.repeat(starts - new_ptr[:-1], L) + np.arange(L.sum(), dtype=np.int64)  # old edge index of each new edge
        pre_kept = np.repeat(np.arange(n, dtype=np.int32), lens)
        srow = pre_kept[plastic]
        plastic = new_ptr[P[srow]] + (plastic - ptr[srow])
        irow = pre_kept[kc_inh]
        kc_inh = new_ptr[P[irow]] + (kc_inh - ptr[irow])
        post, weight, ptr = P[post[idx]].astype(np.int32), weight[idx], new_ptr
        assert np.array_equal(weight[plastic], brain.baseline_plastic)
        assert np.array_equal(weight[kc_inh], kc_inh_base)
    relabel = lambda ix: P[np.asarray(ix, np.int32)].astype(np.int32)

    sub = np.load(REPO / "brain/results/cloud_subset.npz")
    cloud = sub["idx"][: a.cloud].astype(np.int32) if "idx" in sub.files else np.arange(0, dtype=np.int32)

    init_active = np.unique(np.r_[brain.retina, brain.lamina, brain.sugar])  # Brain.__init__ order (old indices)
    arrays = {
        "n": np.array([n], np.int64),
        "ptr": ptr.astype(np.int64), "post": post.astype(np.int32), **quantise(weight),
        "rest": brain.rest[Q].astype(np.float32),
        "kc_mask": brain.circuit["kc_mask"][Q].astype(np.uint8),
        "modulation_mask": brain.modulation_mask[Q].astype(np.uint8),
        "retina": relabel(brain.retina), "retina_uv": brain.uv.astype(np.float32).ravel(),
        "lamina": relabel(brain.lamina), "sugar": relabel(brain.sugar),
        "r8": relabel(brain.r8), "r8_uv": brain.r8_uv.astype(np.float32).ravel(),
        "r8_channel": brain.r8_channel.astype(np.int32),
        "adaptation": np.array([brain.adaptation_jump, brain.adaptation_tau], np.float32),
        "cloud": relabel(cloud),
        "order": P, "old_of": Q, "init_active": relabel(init_active),
        # dopamine plasticity (rule.py): off at runtime unless the lens sends {"learning": true}
        "plastic_edges": plastic, "plastic_pre": relabel(circ["pre"]), "dan": relabel(circ["dan"]),
        "plastic_gain": circ["gain"].astype(np.float32).ravel(), "plastic_baseline": brain.baseline_plastic.astype(np.float32),
        # APL -> KC (ADR 67): scaled at runtime by {"kc_inh_gain": g}; g = 1.0 is the exact file
        "kc_inh_edges": kc_inh, "kc_inh_base": kc_inh_base.astype(np.float32),
        "rule": np.array([RULE["trace_kc_seconds"], RULE["trace_dan_seconds"], MEMORY_DECAY_S,
                          RULE["weight_filter_seconds"], RULE["minimum_fraction"], RULE["maximum_fraction"], brain.eta], np.float64),
    }
    # the compound eye (ADR 54): the ommatidial column lattice and the lamina/medulla cells the
    # `eye` sense drives, taken from the SAME eye.py the Python worker uses.
    import eye as eyemod

    eye_cols, eye_lists = worker.prepare_eye(brain)
    arrays["eye_ncol"] = np.array([len(eye_cols)], np.int32)
    arrays["eye_mv"] = np.array([eyemod.MV_LAMINA, eyemod.MV_MEDULLA], np.float32)
    for name, _sign, cells, col in eye_lists:
        arrays[f"eye:cells:{name}"] = relabel(cells)
        arrays[f"eye:col:{name}"] = col.astype(np.int32)
    for name, groups in senses.items():
        for side, ix in groups.items():
            arrays[f"sense:{name}:{side}"] = relabel(ix)
    for name, ix in reads.items():
        arrays[f"read:{name}"] = relabel(ix)
    for name, ix in regions.items():
        arrays[f"region:{name}"] = relabel(ix)

    out = Path(a.out)
    write(out, arrays)
    import zlib  # the lens fetches <name>.flyb.z over Wi-Fi (~37 % of the size, inflates in ~0.4 s)
    zpath = out.with_name(out.name + ".z")
    zpath.write_bytes(zlib.compress(out.read_bytes(), 1))
    meta = {"order": a.order, "plastic_edges": int(len(plastic)), "kc_inh_edges": int(len(kc_inh)), "apl": int(len(_apl)), "dan": int(len(circ["dan"])), "n": int(n), "edges": int(len(post)), "edges_original": int(len(brain.post)), "cmin": a.cmin,
            "compact": a.compact, "mask": a.mask, "bytes": out.stat().st_size, "bytes_zlib": zpath.stat().st_size, "cloud": int(len(cloud)),
            "eye_columns": int(len(eye_cols)), "eye_cells": int(sum(len(c) for _n, _s, c, _c in eye_lists))}
    out.with_suffix(".json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
