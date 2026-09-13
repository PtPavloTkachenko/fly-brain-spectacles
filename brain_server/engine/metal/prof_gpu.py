"""GPU time per 10 ms call for the metal kernel, split by kernel kind (MTL_PROF=1 splits the
command buffer per dispatch, so the split run itself is slower than normal).

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/metal/prof_gpu.py" --flies 1,3
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # brain_server/
from engine.engine import FlyBatch  # noqa: E402


def frame(v=160):
    img = np.empty((8, 16, 3), np.uint8)
    img[:] = v
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flies", default="1,3")
    ap.add_argument("--settle", type=int, default=50, help="10 ms chunks before measuring")
    ap.add_argument("--chunks", type=int, default=20)
    args = ap.parse_args()
    from flywirehead.neural.visual import VisualMemoryBrain

    proto = VisualMemoryBrain()
    proto.weights_frozen = True
    for flies in [int(x) for x in args.flies.split(",")]:
        batch = FlyBatch(flies, "metal", proto)
        ids = list(range(flies))
        step = lambda b, f, k: [b.rgb_step(frame(160 + 4 * f), 10.0, learning=False) for _ in range(k)]  # noqa: E731
        batch.map(lambda b, f: step(b, f, args.settle), ids)
        for prof in ("0", "1"):
            os.environ["MTL_PROF"] = prof
            batch.metal.stats = {"calls": 0, "flies": 0, "gpu_ms": 0.0, "wall_ms": 0.0}
            batch.map(lambda b, f: step(b, f, args.chunks), ids)
            s = batch.metal.stats
            c = max(1, s["calls"])
            from engine.metal.metal_engine import PROF_KINDS

            parts = "  ".join(f"{k} {s.get(k, 0) / c:.2f}" for k in PROF_KINDS)
            print(f"flies={flies} prof={prof}: {s['flies'] / c:.2f} flies/call  GPU {s['gpu_ms'] / c:.2f} ms/call"
                  f"  wall {s['wall_ms'] / c:.2f} ms/call" + (f"  [{parts}]" if prof == "1" else ""))
        batch.close()


if __name__ == "__main__":
    main()
