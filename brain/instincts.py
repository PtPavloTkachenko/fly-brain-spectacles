"""Instinct probes: do innate fly reflexes survive in the LIF model of MaleCNS v1.0?

Each probe: reset -> 300 ms warm-up on a neutral frame -> 500 ms measured with the
stimulus. The model has no noise, so the control run is the exact baseline and every
difference from it is caused by the stimulus.

Run from the fly-wirehead runtime (its data/ and venv):
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<this file>"
"""

import json
import time
from pathlib import Path

import numpy as np

from flywirehead.neural.common import annotations
from flywirehead.neural.visual import VisualMemoryBrain

OUT = Path(__file__).with_name("results")
W, H = 160, 120
GRAY = 160
WARM_MS, MEASURE_MS, CHUNK_MS = 300.0, 500.0, 10.0

# Vinegar / fruit odour channels (Semmelhack & Wang 2009: DM1, VA2; plus DM2, DM4).
ATTRACTIVE_ORNS = ["ORN_DM1", "ORN_DM2", "ORN_DM4", "ORN_VA2"]
COMMANDS = ["DNa01", "DNa02", "DNp09", "MDN", "MN9", "DNp01", "DNp20", "DNpe017"]


def gray():
    return np.full((H, W, 3), GRAY, np.uint8)


brain = VisualMemoryBrain()
brain.weights_frozen = True
a = annotations(brain.ids)
types = a.type.fillna("").to_numpy()
soma = a.somaSide.fillna("").to_numpy()
root = a.rootSide.fillna("").to_numpy()


def cells(mask):
    return np.flatnonzero(mask).astype(np.int32)


READOUTS = {}
for t in COMMANDS:
    for s in "LR":
        ix = cells((types == t) & (soma == s))
        if len(ix):
            READOUTS[f"{t}_{s}"] = ix


def run(scene=None, stim=None):
    """scene(t_ms) -> RGB frame during the measured window; stim = [(indices, mV)]."""
    brain.reset()
    for _ in range(int(WARM_MS / CHUNK_MS)):
        brain.rgb_step(gray(), CHUNK_MS, learning=False)
    counts = np.zeros(brain.n, np.int64)
    started = time.perf_counter()
    for k in range(int(MEASURE_MS / CHUNK_MS)):
        img = scene(k * CHUNK_MS) if scene else gray()
        c, _ = brain.rgb_step(
            img, CHUNK_MS, learning=False, stimulation=list(stim) if stim else None
        )
        counts += c
    seconds = MEASURE_MS / 1000
    rates = {
        k: float(counts[ix].sum() / (len(ix) * seconds)) for k, ix in READOUTS.items()
    }
    rates["_total_spikes"] = int(counts.sum())
    rates["_wall_s"] = round(time.perf_counter() - started, 3)
    return rates


def looming(cx):
    yy, xx = np.mgrid[0:H, 0:W]

    def scene(t):
        img = gray()
        r = 2 + H * 0.9 * (t / MEASURE_MS) ** 3  # accelerating, like an approach
        img[(xx - cx) ** 2 + (yy - H / 2) ** 2 <= r * r] = 10
        return img

    return scene


def bar(cx):
    def scene(t):
        img = gray()
        img[:, int(cx - 8) : int(cx + 8)] = 10
        return img

    return scene


results, sizes = {}, {}
results["control"] = run()

for t in sorted({x for x in types if x.startswith("LB")}):
    ix = cells(types == t)
    sizes[f"taste:{t}"] = len(ix)
    results[f"taste:{t}"] = run(stim=[(ix, 20.0)])

for s in "LR":
    ix = cells(np.isin(types, ATTRACTIVE_ORNS) & (root == s))
    for mv in (10.0, 20.0):
        sizes[f"odor:{s}:{mv:g}"] = len(ix)
        results[f"odor:{s}:{mv:g}"] = run(stim=[(ix, mv)])

for s in "LR":
    ix = cells(np.isin(types, ["LPLC2", "LC4"]) & (soma == s))
    sizes[f"loom_direct:{s}"] = len(ix)
    results[f"loom_direct:{s}"] = run(stim=[(ix, 20.0)])

for s, cx in (("L", W * 0.25), ("R", W * 0.75)):
    results[f"loom_visual:{s}"] = run(scene=looming(cx))
    results[f"bar:{s}"] = run(scene=bar(W * (0.2 if s == "L" else 0.8)))

OUT.mkdir(exist_ok=True)
(OUT / "instincts.json").write_text(
    json.dumps({"results": results, "sizes": sizes}, indent=2) + "\n"
)


def pair(r, t):
    return r.get(f"{t}_L", 0.0), r.get(f"{t}_R", 0.0)


c = results["control"]
print(f"speed: {c['_wall_s']:.2f} s wall per {MEASURE_MS:.0f} ms neural (control)")
print(
    f"{'probe':<22}{'n':>5} | {'MN9':>6} {'DNa02 R-L':>10} {'DNa01 R-L':>10}"
    f" {'DNp09':>6} {'MDN':>6} {'DNp01 L/R':>11} {'spikes':>9} {'wall':>6}"
)
for name, r in results.items():
    mn9 = sum(pair(r, "MN9")) / 2
    a2l, a2r = pair(r, "DNa02")
    a1l, a1r = pair(r, "DNa01")
    p9 = sum(pair(r, "DNp09")) / 2
    mdn = sum(pair(r, "MDN")) / 2
    gl, gr = pair(r, "DNp01")
    print(
        f"{name:<22}{sizes.get(name, ''):>5} | {mn9:6.1f} {a2r - a2l:10.1f} {a1r - a1l:10.1f}"
        f" {p9:6.1f} {mdn:6.1f} {gl:5.1f}/{gr:<5.1f} {r['_total_spikes']:9d} {r['_wall_s']:6.2f}"
    )
