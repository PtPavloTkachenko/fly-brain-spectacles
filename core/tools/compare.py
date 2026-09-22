"""FlyBrainCore (C++) vs worker.fly_loop (Python), step by step, same messages.

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/tools/compare.py \
        --flyb <repo>/core/brain_export/out/brain_c0.flyb [--steps 20]

Both sides get the identical message sequence (neutral, food_left, loom_left, bitter, sweet+pulse,
retina frame). Reports, per step: total spikes (must match exactly), max |act| difference, and the
wall time of each side. The Python side is the reference kernel `fast` on the full graph; the C++
side reads the exported file (use the full export for the exactness check).
"""

import argparse
import base64
import ctypes as C
import json
import os
import queue
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "brain_server"))
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime"))
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

rng = np.random.default_rng(3)
RETINA = [int(x) for x in rng.integers(100, 220, 16 * 8 * 3)]
# the compound eye (ADR 54): a base64 column map. Two frames of a looming edge, so the byte set
# and therefore the injected cell set differ between the steps and both are exercised.
_NCOL = 1767
_EYE = lambda seed, k: base64.b64encode(
    np.where(np.random.default_rng(seed).random(_NCOL) < k,
             np.random.default_rng(seed + 1).integers(1, 256, _NCOL), 128).astype(np.uint8).tobytes()
).decode()
PLAN = (
    [{"senses": {"light": 0.627}}] + [None] * 5
    + [{"senses": {"object": {"L": 0.8}, "odor": {"L": 0.8, "R": 0.4}}}] + [None] * 5
    + [{"senses": {"loom": {"L": 1.0}}}] + [None] * 5
    + [{"senses": {"bitter": 1.0}}] + [None] * 3
    + [{"senses": {"sweet": 1.0, "odor": {"L": 0.6, "R": 0.6}}}, {"pulse": "reward"}] + [None] * 3
    + [{"senses": {"retina": RETINA, "motion": {"R": 0.8}}}] + [None] * 5
    + [{"senses": {"eye": _EYE(7, 0.25)}}] + [None] * 3
    + [{"senses": {"eye": _EYE(11, 0.9), "retina": RETINA}}] + [None] * 3
    # the ocelli (ADR 68): a sided brightness gradient, then the other way round
    + [{"senses": {"ocelli": {"L": 0.9, "R": 0.3}}}] + [None] * 3
    + [{"senses": {"ocelli": {"L": 0.2, "R": 1.0}, "eye": _EYE(5, 0.4)}}] + [None] * 3
)


def python_side(steps, learning=False):
    from flywirehead.neural.visual import VisualMemoryBrain

    import worker
    from engine.engine import kernel_function

    brain = VisualMemoryBrain()
    brain.weights_frozen = not learning
    brain.advance = kernel_function(brain, "fast")
    if learning:  # worker.fly_loop always passes learning=False; the lens's {"learning": true} flips it on
        orig = brain.rgb_step
        brain.rgb_step = lambda frame, ms, **kw: orig(frame, ms, **{**kw, "learning": True})
    rows, inbox = [], queue.Queue()

    class In:
        poll = staticmethod(lambda: not inbox.empty())
        recv = staticmethod(inbox.get_nowait)

    state = {"i": 0}

    def feed(i):
        m = PLAN[i] if i < len(PLAN) else None
        if m is not None:
            inbox.put(m)

    class Out:
        def send(self, msg):
            if msg["t"] == "ready":
                rows.append(msg)
                feed(0)
                return
            if learning:
                w = brain.weight[brain.circuit["edges"]] / brain.baseline_plastic
                msg["memory"] = {"mean_efficacy": float(w.mean()), "changed": int((w != 1).sum())}
            rows.append(msg)
            state["i"] += 1
            if state["i"] >= steps:
                inbox.put({"stop": True})
            else:
                feed(state["i"])

    idx = worker.prepare(brain)
    sub = np.load(REPO / "brain/results/cloud_subset.npz")["idx"]
    worker.fly_loop(brain, idx, 0, In(), Out(), sub, 50.0)
    return rows


def native_side(flyb, steps, learning=False, threads=1, lib_name="libflybrain_host.dylib", post=()):
    lib = C.CDLL(str(CORE / "build" / lib_name))
    lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
    lib.fb_create.restype = C.c_void_p
    lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
    lib.fb_last_error.restype = C.c_char_p
    for f in ("fb_warmup", "fb_step"):
        getattr(lib, f).restype = C.c_char_p
        getattr(lib, f).argtypes = [C.c_void_p]
    lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
    data = Path(flyb).read_bytes()
    t0 = time.time()
    b = lib.fb_create(data, len(data), 50.0, 0)
    if not b:
        raise SystemExit("fb_create failed: " + lib.fb_last_error().decode())
    load = time.time() - t0
    if threads > 1:
        lib.fb_set_threads(b, threads)
    if learning:
        lib.fb_post(b, b'{"learning":true}')
    for p in post:
        lib.fb_post(b, p.encode())
    rows = [json.loads(lib.fb_warmup(b))]
    if "gpu" in rows[0]:
        print("native gpu:", rows[0]["gpu"], flush=True)
    for i in range(steps):
        m = PLAN[i] if i < len(PLAN) else None
        if m is not None:
            lib.fb_post(b, json.dumps(m).encode())
        rows.append(json.loads(lib.fb_step(b)))
    return rows, load


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flyb", required=True)
    ap.add_argument("--steps", type=int, default=len(PLAN))
    ap.add_argument("--native-only", action="store_true")
    ap.add_argument("--learning", action="store_true", help="dopamine plasticity on, on both sides")
    ap.add_argument("--threads", type=int, default=1, help="native kernel threads (exact partitioned kernel)")
    ap.add_argument("--lib", default="libflybrain_host.dylib")
    ap.add_argument("--post", nargs="*", default=[], help='JSON messages posted before warm-up, e.g. \'{"gpu":1}\'')
    a = ap.parse_args()
    nat, load = native_side(a.flyb, a.steps, a.learning, a.threads, a.lib, a.post)
    walls = [r["prof"]["adv"] for r in nat[1:]]
    print(f"native: load {load:.1f}s, advance per 50 ms step: median {np.median(walls):.0f} ms, max {max(walls):.0f} ms")
    if a.native_only:
        for i, r in enumerate(nat[1:]):
            print(i, r["neural"]["spikes"], {k: r["act"][k] for k in ("turn", "orient", "escape_L", "stop", "feed")})
        return
    ref = python_side(a.steps, a.learning)
    base_diff = max(abs(ref[0]["baseline"][k] - nat[0]["baseline"][k]) for k in ref[0]["baseline"])
    print(f"baseline max |diff| {base_diff:.3f} Hz")
    exact = 0
    worst = 0.0
    for i in range(1, min(len(ref), len(nat))):
        rs, ns = ref[i]["neural"]["spikes"], nat[i]["neural"]["spikes"]
        d = max(abs(ref[i]["act"][k] - nat[i]["act"].get(k, 0.0)) for k in ref[i]["act"])
        worst = max(worst, d)
        exact += rs == ns
        print(f"step {i:2d} spikes py={rs:7d} c++={ns:7d} {'==' if rs == ns else '!='}  max|act diff| {d:.3f}"
              f"  py {ref[i]['prof']['adv']:4d} ms  c++ {nat[i]['prof']['adv']:4d} ms"
              + (f"  eff py {ref[i]['memory']['mean_efficacy']:.6f} c++ {nat[i]['memory']['mean_efficacy']:.6f}" if a.learning else ""))
    print(f"identical spike totals: {exact}/{min(len(ref), len(nat)) - 1}, worst act diff {worst:.3f}")


if __name__ == "__main__":
    main()
