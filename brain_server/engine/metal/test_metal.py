"""GPU kernel vs CPU `fast` kernel (which is byte-identical to the package kernel, engine/RESULTS.md).

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/metal/test_metal.py" [--ms 300] [--chaos]

Same three flies as engine/test_equality.py (rest / light+odour+loom / sugar+reward+touch),
1 fly alone and 3 flies in one batch. Two verdicts per fly:
  EXACT  : per-neuron spike counts of every 10 ms chunk identical, and every state field
           identical after flushing float denormals to 0 (the GPU has no denormals).
  metrics: exact-match fraction / correlation / max |diff| of per-neuron counts over the run,
           readout populations and region rates (Hz) ref vs gpu.
--chaos also runs the CPU kernel with each tick's deliveries summed in REVERSE order (same model,
only float summation order differs = what atomic adds would give), to show how far an
"equivalent" implementation drifts: the natural scale for any tolerance.
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # brain_server/
from engine.engine import FlyBatch  # noqa: E402
from engine.test_equality import run_fly, scenario, snapshot  # noqa: E402

TINY = np.finfo(np.float32).tiny


def ftz(x):
    return np.where(np.abs(x) < TINY, 0, x) if x.dtype == np.float32 else x


def exact(ref, got):
    rc, rs = ref
    gc, gs = got
    bad_chunks = [i for i, (a, b) in enumerate(zip(rc, gc)) if not np.array_equal(a, b)]
    bad = {}
    ftz_only = []
    for k in rs:
        a, b = rs[k], gs[k]
        if k == "active":
            na = int(rs["nactive"][0])
            a, b = a[:na], b[:na]
        if a.tobytes() == b.tobytes():
            continue
        if a.dtype == np.float32 and np.array_equal(ftz(a), ftz(b)):
            ftz_only.append(f"{k}({int(np.sum(a != b))})")
            continue
        bad[k] = int(np.sum(a != b))
    return not bad_chunks and not bad, bad_chunks, bad, ftz_only


def metrics(ref, got, readouts, regions, ms):
    a = sum(c.astype(np.int64) for c in ref[0])
    b = sum(c.astype(np.int64) for c in got[0])
    s = ms / 1000
    rr = {k: (a[ix].sum() / max(1, len(ix)) / s, b[ix].sum() / max(1, len(ix)) / s) for k, ix in {**readouts, **regions}.items()}
    worst = max(rr, key=lambda k: abs(rr[k][0] - rr[k][1]))
    return {
        "spikes": (int(a.sum()), int(b.sum())),
        "exact_frac": float(np.mean(a == b)),
        "corr": float(np.corrcoef(a, b)[0, 1]),
        "max_diff": int(np.abs(a - b).max()),
        "readout_hz": {k: (round(x, 1), round(y, 1)) for k, (x, y) in rr.items()},
        "worst": (worst, round(rr[worst][0], 1), round(rr[worst][1], 1)),
    }


def run_batch(kernel, proto, plans, ids, perturb=False):
    batch = FlyBatch(len(ids), kernel, proto)
    if perturb:  # CPU kernel with each tick's deliveries in reverse order (profile_cpu.cpp revq_advance)
        from engine.metal.profile_cpu import build as build_prof

        fn = build_prof().revq_advance
        fn.argtypes = batch.brains[0].advance.argtypes
        fn.restype = None
        for b in batch.brains:
            b.advance = fn
    t = time.perf_counter()
    got = batch.map(lambda b, f: run_fly(b, plans[f]), ids)
    wall = time.perf_counter() - t
    out = [(c, snapshot(b)) for c, b in zip(got, batch.brains)]
    stats = dict(batch.metal.stats) if batch.metal else None
    batch.close()
    return out, wall, stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ms", type=float, default=300.0)
    ap.add_argument("--chaos", action="store_true")
    args = ap.parse_args()
    from flywirehead.neural.common import annotations
    from flywirehead.neural.visual import VisualMemoryBrain

    import worker

    from channels import index_senses

    proto = VisualMemoryBrain()
    proto.weights_frozen = True
    senses, readouts, regions = worker.prepare(proto)
    chunks = int(round(args.ms / 10))
    plans = [scenario(f, chunks, index_senses(annotations(proto.ids))) for f in range(3)]
    refs, wall, _ = run_batch("fast", proto, plans, [0, 1, 2])
    print(f"reference: CPU fast, 3 flies, {args.ms:.0f} ms ({wall:.1f} s)")
    runs = [("metal", [1]), ("metal", [0, 1, 2])]
    if args.chaos:
        runs.append(("chaos", [0, 1, 2]))
    ok_all = True
    for kind, ids in runs:
        got, wall, st = run_batch("fast" if kind == "chaos" else "metal", proto, plans, ids, perturb=kind == "chaos")
        extra = f", GPU {st['gpu_ms'] / max(1, st['calls']):.2f} ms per call, {st['flies'] / max(1, st['calls']):.2f} flies/call" if st else ""
        print(f"\n{kind} flies={ids} ({wall:.1f} s wall{extra})")
        for f, g in zip(ids, got):
            ok, bc, bad, ftz_only = exact(refs[f], g)
            m = metrics(refs[f], g, readouts, regions, args.ms)
            if kind != "chaos":
                ok_all &= ok
            print(f"  fly {f}: {'EXACT' if ok else 'NOT EXACT'} bad_chunks={bc[:5]}{'...' if len(bc) > 5 else ''} bad_fields={bad}"
                  f" ftz-only={ftz_only}")
            print(f"    spikes ref/got {m['spikes']}  per-neuron exact {m['exact_frac']:.5f}  corr {m['corr']:.5f}"
                  f"  max|diff| {m['max_diff']}  worst readout {m['worst']}")
    print("\nALL EXACT (modulo denormal flush)" if ok_all else "\nNOT EXACT")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()
