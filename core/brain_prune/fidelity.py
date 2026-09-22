"""Does a pruned brain still behave like the full one? Offline, deterministic, no network.

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/brain_prune/fidelity.py --cmin 0 3 5 10

For every contact threshold `cmin` (0 = full brain) the script zeroes all edges with fewer contacts,
then drives the brain through fake_lens's scenarios with the worker's own loop (worker.fly_loop):
2 s of neutral light, then 3 s of the scenario, reading the mean decoded actions over the last 1.5 s.
Output: one JSON per cmin in core/brain_prune/out/, plus a comparison table against cmin=0.
Runs each cmin in its own process (CPU `fast` kernel), so they go in parallel.
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "out"
sys.path.insert(0, str(REPO / "brain_server"))
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime"))
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

SCENARIOS = {
    "neutral": {"light": 0.627},
    "food_left": {"object": {"L": 0.8}, "odor": {"L": 0.8, "R": 0.4}},
    "food_right": {"object": {"R": 0.8}, "odor": {"L": 0.4, "R": 0.8}},
    "motion_left": {"motion": {"L": 0.8}},
    "motion_right": {"motion": {"R": 0.8}},
    "loom_left": {"loom": {"L": 1.0}},
    "loom_right": {"loom": {"R": 1.0}},
    "sweet": {"sweet": 1.0, "odor": {"L": 0.6, "R": 0.6}},
    "bitter": {"bitter": 1.0},
    "touch_back": {"touch": {"L": 1.0, "R": 1.0}},
    "hot": {"hot": 1.0},
}
KEYS = ["turn", "orient", "avoid", "escape_L", "escape_R", "stop", "back", "feed", "appetite", "thrust", "groom", "neck"]
STEP_MS = 50.0
GAP_STEPS, SCEN_STEPS = 40, 60


class Pipe:
    """worker.fly_loop talks to a multiprocessing pipe; this drives it step by step instead."""

    def __init__(self):
        self.q = queue.Queue()

    def poll(self):
        return not self.q.empty()

    def recv(self):
        return self.q.get_nowait()


def run_one(cmin):
    from flywirehead.neural.visual import VisualMemoryBrain

    import worker
    from engine.engine import kernel_function

    t0 = time.time()
    brain = VisualMemoryBrain()
    brain.weights_frozen = True
    brain.advance = kernel_function(brain, "fast")
    contacts = np.rint(np.abs(brain.weight) / 0.275).astype(np.int32)
    total_abs = float(np.abs(brain.weight).sum())
    keep = contacts >= cmin
    kept_abs = float(np.abs(brain.weight[keep]).sum())
    if cmin > 0:
        brain.weight[~keep] = 0.0
    load_s = time.time() - t0

    plan = []
    for name, ch in SCENARIOS.items():
        plan += [("gap", {"light": 0.627})] * GAP_STEPS + [(name, ch)] * SCEN_STEPS
    inbox, rows, walls = Pipe(), {n: [] for n in SCENARIOS}, []
    state = {"i": 0}

    class Out:
        def send(self, msg):
            if msg.get("t") != "brain":
                inbox.q.put({"senses": plan[0][1]})
                return
            i = state["i"]
            name, _ = plan[i]
            if name != "gap" and (i % (GAP_STEPS + SCEN_STEPS)) >= GAP_STEPS + SCEN_STEPS // 2:
                rows[name].append(msg["act"])
            walls.append(msg["prof"]["adv"])
            state["i"] = i + 1
            if state["i"] >= len(plan):
                inbox.q.put({"stop": True})
            else:
                inbox.q.put({"senses": plan[state["i"]][1]})

    indices = worker.prepare(brain)
    worker.fly_loop(brain, indices, 0, inbox, Out(), np.arange(16), STEP_MS)
    mean = {n: {k: float(np.mean([r.get(k, 0.0) for r in rs])) for k in KEYS} for n, rs in rows.items()}
    res = {
        "cmin": cmin, "edges_kept": int(keep.sum()), "edges_total": int(len(keep)),
        "weight_share_kept": kept_abs / total_abs, "adv_ms_median": float(np.median(walls)),
        "load_s": load_s, "wall_s": time.time() - t0, "act": mean,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / f"fidelity_c{cmin}.json").write_text(json.dumps(res, indent=1))
    print(f"cmin={cmin} done in {res['wall_s']:.0f}s, adv median {res['adv_ms_median']:.0f} ms", flush=True)


def compare(cmins):
    base = json.loads((OUT / "fidelity_c0.json").read_text())
    print(f"{'cmin':>4} {'edges%':>7} {'|w|%':>6} {'adv ms':>7}  max|diff| per scenario (turn/orient/escape/stop/feed...)")
    for c in cmins:
        r = json.loads((OUT / f"fidelity_c{c}.json").read_text())
        worst = {n: max(abs(r["act"][n][k] - base["act"][n][k]) for k in KEYS) for n in SCENARIOS}
        print(f"{c:>4} {100*r['edges_kept']/r['edges_total']:>7.1f} {100*r['weight_share_kept']:>6.1f} {r['adv_ms_median']:>7.0f}  "
              + " ".join(f"{n}={worst[n]:.2f}" for n in SCENARIOS))
    print("\nfull-brain actions (reference):")
    for n in SCENARIOS:
        print(f"  {n:<13}" + " ".join(f"{k}={base['act'][n][k]:+.2f}" for k in ("turn", "orient", "escape_L", "escape_R", "stop", "feed", "appetite")))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmin", type=int, nargs="+", default=[0, 3, 5, 10])
    ap.add_argument("--one", type=int)
    ap.add_argument("--compare", action="store_true")
    a = ap.parse_args()
    if a.one is not None:
        run_one(a.one)
    elif a.compare:
        compare([c for c in a.cmin if c != 0])
    else:
        procs = [subprocess.Popen([sys.executable, __file__, "--one", str(c)]) for c in a.cmin]
        for p in procs:
            p.wait()
        compare([c for c in a.cmin if c != 0])
