"""Wall time per 50 ms neural step per fly: process-per-fly (today's server) vs one process
with a shared connectome and one thread per fly.

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/bench.py" \
        --flies 1,3,5 --configs process:orig,thread:orig,thread:fast

Every fly settles SETTLE ms (activity needs ~0.3-1 s to wake), then all flies start together
and each times STEPS steps of 50 ms (5 x 10 ms rgb_step chunks, like worker.py) at the
worker's resting light. Each fly gets a different 100 ms kick at the start of the settle
(light offset) so the flies decorrelate like real flies but keep comparable activity.
"""

import argparse
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.engine import FlyBatch, kernel_function  # noqa: E402

CHUNK_MS = 10.0


def frame(l=160, r=160):
    img = np.empty((8, 16, 3), np.uint8)
    img[:, :8], img[:, 8:] = l, r
    return img


def advance(brain, img, ms):
    spikes = 0
    for _ in range(int(round(ms / CHUNK_MS))):
        c, _ = brain.rgb_step(img, CHUNK_MS, learning=False)
        spikes += int(c.sum())
    return spikes


def settle(brain, fly, ms):
    advance(brain, frame(160 + 8 * fly, 160 + 4 * fly), 100)  # per-fly kick -> decorrelated state
    advance(brain, frame(), ms - 100)


def measure(brain, fly, steps, step_ms):
    img = frame()
    walls, spikes = [], 0
    for _ in range(steps):
        t = time.perf_counter()
        spikes += advance(brain, img, step_ms)
        walls.append((time.perf_counter() - t) * 1000)
    return walls, spikes


def proc_main(fly, kernel, settle_ms, steps, step_ms, barrier, out):
    from flywirehead.neural.visual import VisualMemoryBrain

    b = VisualMemoryBrain()
    b.weights_frozen = True
    b.advance = kernel_function(b, kernel)
    settle(b, fly, settle_ms)
    barrier.wait()
    out.put(measure(b, fly, steps, step_ms))


def run_process(flies, kernel, settle_ms, steps, step_ms):
    ctx = mp.get_context("spawn")
    barrier, out = ctx.Barrier(flies), ctx.Queue()
    ps = [ctx.Process(target=proc_main, args=(f, kernel, settle_ms, steps, step_ms, barrier, out)) for f in range(flies)]
    for p in ps:
        p.start()
    res = [out.get() for _ in ps]
    for p in ps:
        p.join()
    return res


def run_thread(flies, kernel, settle_ms, steps, step_ms, proto):
    batch = FlyBatch(flies, kernel, proto)
    ids = list(range(flies))
    batch.map(lambda b, f: settle(b, f, settle_ms), ids)
    res = batch.map(lambda b, f: measure(b, f, steps, step_ms), ids)
    batch.close()
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flies", default="1,3,5")
    ap.add_argument("--configs", default="process:orig,thread:orig,thread:fast")
    ap.add_argument("--settle", type=float, default=500.0)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--step-ms", type=float, default=50.0)
    ap.add_argument("--out", default=None, help="append JSON lines here")
    args = ap.parse_args()
    proto = None
    for flies in [int(x) for x in args.flies.split(",")]:
        for cfg in args.configs.split(","):
            mode, kernel = cfg.split(":")
            t = time.perf_counter()
            if mode == "process":
                res = run_process(flies, kernel, args.settle, args.steps, args.step_ms)
            else:
                if proto is None:
                    from flywirehead.neural.visual import VisualMemoryBrain

                    proto = VisualMemoryBrain()
                res = run_thread(flies, kernel, args.settle, args.steps, args.step_ms, proto)
            walls = np.concatenate([w for w, _ in res])
            spikes = sum(s for _, s in res) / (flies * args.steps)
            row = {
                "flies": flies, "engine": mode, "kernel": kernel,
                "ms_per_step_median": round(float(np.median(walls)), 1),
                "ms_per_step_mean": round(float(np.mean(walls)), 1),
                "spikes_per_step": round(spikes),
                "rtf": round(args.step_ms / float(np.median(walls)), 3),
                "total_s": round(time.perf_counter() - t, 1),
            }
            print(json.dumps(row), flush=True)
            if args.out:
                with open(args.out, "a") as fh:
                    fh.write(json.dumps(row) + "\n")


if __name__ == "__main__":
    main()
