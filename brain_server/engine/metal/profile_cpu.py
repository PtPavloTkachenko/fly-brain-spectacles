"""Where does the CPU kernel spend its time, and how much parallel work is in one 0.1 ms tick?

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/brain_server/engine/metal/profile_cpu.py"

Runs profile_cpu.cpp (an instrumented copy of fast_advance, same arithmetic) on one fly:
settle 800 ms at rest light, then profile rest / loom+odour / sugar+reward+touch.
"""

import ctypes as C
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))  # brain_server/
from engine.engine import BUILD, FLAGS, FlyBatch  # noqa: E402

from channels import build_stim, index_senses  # noqa: E402

STATS = ["p1_ns", "p2_ns", "p3_ns", "final_ns", "call_ns", "active", "spikes", "deliveries", "mod_deliveries",
         "touched", "multi_targets", "multi_deliveries", "maxk", "awakened", "qlen", "ticks",
         "k1", "k2_4", "k5_16", "k17_64", "k65_256", "k257p"]


def build():
    src = HERE / "profile_cpu.cpp"
    lib = BUILD / "libprofile.dylib"
    BUILD.mkdir(parents=True, exist_ok=True)
    if not lib.exists() or lib.stat().st_mtime < src.stat().st_mtime:
        subprocess.run(["c++", *FLAGS, str(src), "-o", str(lib)], check=True)
    return C.CDLL(str(lib))


def frame(v=160):
    img = np.empty((8, 16, 3), np.uint8)
    img[:] = v
    return img


def main():
    batch = FlyBatch(1, "fast")
    brain = batch.brains[0]
    lib = build()
    stats = np.zeros(len(STATS), np.float64)
    fn = lib.prof_advance
    fn.argtypes = list(brain.advance.argtypes) + [C.c_void_p]
    fast = brain.advance
    from flywirehead.neural.common import annotations

    six = index_senses(annotations(brain.ids))
    for _ in range(80):
        brain.rgb_step(frame(), 10.0, learning=False)
    # Python overhead of one 10 ms rgb_step (fast kernel): wall - kernel time
    over = []
    for _ in range(20):
        t = time.perf_counter()
        _, k = brain.rgb_step(frame(), 10.0, learning=False)
        over.append((time.perf_counter() - t - k) * 1000)
    print(f"python overhead per 10 ms rgb_step: median {np.median(over):.2f} ms")
    brain.advance = lambda *a: fn(*a, stats.ctypes.data)
    for name, senses, chunks in [
        ("rest", {}, 30),
        ("loom+odour", {"odor": {"L": 0.7, "R": 0.2}, "loom": {"L": 1.0, "R": 0.0}}, 20),
        ("sugar+reward+touch", {"sweet": 1.0, "reward": 1.0, "touch": 0.5}, 20),
    ]:
        stats[:] = 0
        stim = build_stim(six, senses)
        for _ in range(chunks):
            brain.rgb_step(frame(), 10.0, learning=False, stimulation=stim or None)
        s = dict(zip(STATS, stats))
        T = s["ticks"]
        per_step = 500 / T  # ticks per 50 ms step / ticks measured
        tot = s["p1_ns"] + s["p2_ns"] + s["p3_ns"] + s["final_ns"]
        print(f"\n== {name}: {T:.0f} ticks, call {s['call_ns'] * per_step / 1e6:.0f} ms per 50 ms step")
        print(f"  time: phase1 (active update) {100 * s['p1_ns'] / tot:.0f}%  phase2 (deliveries) {100 * s['p2_ns'] / tot:.0f}%"
              f"  phase3 {100 * s['p3_ns'] / tot:.1f}%  boundary evolve {100 * s['final_ns'] / tot:.1f}%")
        print(f"  per tick: active {s['active'] / T:.0f}  spikes {s['spikes'] / T:.1f}  deliveries {s['deliveries'] / T:.0f}"
              f" (+{s['mod_deliveries'] / T:.0f} modulatory)  touched targets {s['touched'] / T:.0f}  awakened {s['awakened'] / T:.0f}")
        print(f"  ns per delivery {s['p2_ns'] / max(1, s['deliveries']):.1f}   ns per active update {s['p1_ns'] / max(1, s['active']):.1f}")
        print(f"  targets hit >=2x in a tick: {100 * s['multi_targets'] / s['touched']:.1f}% of targets,"
              f" {100 * s['multi_deliveries'] / s['deliveries']:.1f}% of deliveries; max hits on one target in one tick {s['maxk']:.0f}")
        h = [s[k] for k in STATS[16:]]
        print("  hits/target/tick histogram 1|2-4|5-16|17-64|65-256|257+: " + " | ".join(f"{x / T:.1f}" for x in h))
    brain.advance = fast
    batch.close()


if __name__ == "__main__":
    main()
