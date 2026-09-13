"""Equality test: engine flies vs the original single-fly path (fresh VisualMemoryBrain,
package kernel, the worker's exact rgb_step call per 10 ms chunk).

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/test_equality.py" [--ms 300] [--kernels orig,ref,fast]

For each fly scenario the per-neuron spike counts of EVERY 10 ms chunk and the complete
final state (every array in brain.fields, byte-for-byte) must be identical, for 1 fly and
for 3 flies with different stimulation running concurrently in one process.
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # brain_server/
from engine.engine import FlyBatch  # noqa: E402 (sets FLYWIREHEAD_DATA)

from channels import build_stim, index_senses  # noqa: E402

CHUNK_MS = 10.0
REST = 160 / 255


def frame(l, r):
    img = np.empty((8, 16, 3), np.uint8)
    img[:, :8], img[:, 8:] = round(255 * np.clip(l, 0, 1)), round(255 * np.clip(r, 0, 1))
    return img


def scenario(fly, chunks, sense_ix):
    """Per chunk (frame, stimulation) — three deliberately different flies."""
    out = []
    for c in range(chunks):
        if fly == 0:  # resting fly
            senses, l, r = {}, REST, REST
        elif fly == 1:  # asymmetric light, odour, a looming object on the left
            senses, l, r = {"odor": {"L": 0.7, "R": 0.2}}, 0.3, 0.8
            if 5 <= c < 15:
                senses["loom"] = {"L": 1.0, "R": 0.0}
        else:  # sugar, a reward pulse, then touch
            senses, l, r = {"sweet": 1.0}, REST, REST
            if 10 <= c < 12:
                senses["reward"] = 1.0
            if 20 <= c < 25:
                senses["touch"] = 0.5
        out.append((frame(l, r), build_stim(sense_ix, senses)))
    return out


def run_fly(brain, plan):
    counts = []
    for img, stim in plan:
        c, _ = brain.rgb_step(img, CHUNK_MS, learning=False, stimulation=stim or None)
        counts.append(c.copy())
    return counts


def snapshot(brain):
    return {k: getattr(brain, k).copy() for k in brain.fields} | {"cursor": np.asarray(brain.cursor)}


def compare(ref, got, name):
    rc, rs = ref
    gc, gs = got
    bad_chunks = [i for i, (a, b) in enumerate(zip(rc, gc)) if not np.array_equal(a, b)]
    bad_fields = [k for k in rs if k != "active" and rs[k].tobytes() != gs[k].tobytes()]
    # `active` is live only up to nactive (the kernel never reads past it); the original's
    # in-place compaction leaves stale ids in the tail, par_advance leaves different ones.
    na = int(rs["nactive"][0])
    if rs["active"][:na].tobytes() != gs["active"][:na].tobytes():
        bad_fields.append("active[:nactive]")
    elif rs["active"].tobytes() != gs["active"].tobytes():
        name += " (dead tail active[nactive:] differs, never read)"
    total_r = int(sum(c.sum() for c in rc))
    total_g = int(sum(c.sum() for c in gc))
    diff = int(np.abs(sum(c.astype(np.int64) for c in rc) - sum(c.astype(np.int64) for c in gc)).sum())
    ok = not bad_chunks and not bad_fields
    print(
        f"  {name}: {'IDENTICAL' if ok else 'DIFFERENT'} spikes ref={total_r} got={total_g} "
        f"|count diff|={diff} bad_chunks={bad_chunks[:5]} bad_fields={bad_fields}"
    )
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ms", type=float, default=300.0)
    ap.add_argument("--kernels", default="orig,ref,fast,par2,par3")
    args = ap.parse_args()
    from flywirehead.neural.common import annotations
    from flywirehead.neural.visual import VisualMemoryBrain

    chunks = int(round(args.ms / CHUNK_MS))
    proto = VisualMemoryBrain()
    sense_ix = index_senses(annotations(proto.ids))
    plans = [scenario(f, chunks, sense_ix) for f in range(3)]

    # Reference: the original single-fly path, one fresh brain per fly, run alone.
    refs = []
    for f in range(3):
        t = time.perf_counter()
        b = VisualMemoryBrain()
        b.weights_frozen = True
        counts = run_fly(b, plans[f])
        refs.append((counts, snapshot(b)))
        print(f"reference fly {f}: {int(sum(c.sum() for c in counts))} spikes in {args.ms:.0f} ms ({time.perf_counter() - t:.1f} s)")
        del b

    all_ok = True
    for kernel in args.kernels.split(","):
        for flies in (1, 3):
            batch = FlyBatch(flies, kernel, proto)
            ids = [1] if flies == 1 else [0, 1, 2]
            t = time.perf_counter()
            got = batch.map(lambda b, f: (run_fly(b, plans[f]), None), ids)
            got = [(c, snapshot(b)) for (c, _), b in zip(got, batch.brains)]
            print(f"kernel={kernel} flies={flies} ({time.perf_counter() - t:.1f} s wall, concurrent)")
            for f, g in zip(ids, got):
                all_ok &= compare(refs[f], g, f"fly {f}")
            batch.close()
    print("ALL IDENTICAL" if all_ok else "MISMATCH")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
