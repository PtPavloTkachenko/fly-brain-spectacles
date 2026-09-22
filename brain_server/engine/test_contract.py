"""End-to-end contract test: engine/batch_worker.run (2 flies, one process) must send the
same ready/brain messages as two worker.run processes (today's server), except wall_ms.

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/test_contract.py" [--kernel fast] [--steps 12]

All inbox messages are queued before the loops start, so the first poll (right after
`ready`) consumes them all and the run is deterministic.
"""

import argparse
import multiprocessing as mp
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

MSGS = [  # per fly: messages queued before start
    [{"cloud": True}, {"senses": {"light": {"L": 0.5, "R": 0.7}, "loom": {"L": 1.0, "R": 0.0}}}],
    [{"senses": {"sweet": 1.0, "odor": {"L": 0.6, "R": 0.1}}}, {"pulse": "reward"}],
]


def collect(conns, steps):
    out = {f: [] for f in conns}
    for f, c in conns.items():
        while len(out[f]) < steps + 1:
            m = c.recv()
            m.pop("wall_ms", None)
            out[f].append(m)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kernel", default="fast")
    ap.add_argument("--steps", type=int, default=12)
    args = ap.parse_args()
    import numpy as np

    from engine.batch_worker import run as batch_run
    from worker import run as worker_run

    ctx = mp.get_context("spawn")
    subset = np.arange(0, 166700, 11, dtype=np.int32)
    results = {}
    for engine in ("process", "batch"):
        ends, outs, ins, procs = [], {}, [], []
        for fly in range(2):
            to_worker, worker_in = ctx.Pipe(duplex=False)
            worker_out, from_worker = ctx.Pipe(duplex=False)
            for m in MSGS[fly]:
                worker_in.send(m)
            ins.append(worker_in)
            outs[fly] = worker_out
            if engine == "process":
                procs.append(ctx.Process(target=worker_run, args=(fly, to_worker, from_worker, subset, 50.0), daemon=True))
            else:
                ends.append((fly, to_worker, from_worker))
        if ends:
            procs.append(ctx.Process(target=batch_run, args=(ends, subset, 50.0, args.kernel), daemon=True))
        for p in procs:
            p.start()
        results[engine] = collect(outs, args.steps)
        for w in ins:
            w.send({"stop": True})
        for p in procs:
            p.join(timeout=60)
        print(f"{engine}: fly0 act {results[engine][0][-1]['act']}")
    ok = results["process"] == results["batch"]
    for f in range(2):
        for k, (a, b) in enumerate(zip(results["process"][f], results["batch"][f])):
            if a != b:
                print(f"fly {f} message {k} differs: keys {[x for x in a if a.get(x) != b.get(x)]}")
                break
    print("CONTRACT IDENTICAL" if ok else "CONTRACT MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
