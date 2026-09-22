"""A LIGHTER brain for the glasses: build candidate prunes, measure them, pick one.

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && .venv/bin/python <repo>/core/brain_prune/lite.py stats
    ... masks          # writes out/mask_<name>.npy + out/masks.json
    ... run --cand NAME [NAME ...]   # fidelity on the Metal kernel, one process per candidate
    ... table          # the comparison table

Why this exists: ADR 47 rejected a pure contact threshold because it breaks behaviour. The
difference here is (a) a per-POSTSYNAPTIC top-k floor, so no cell loses all of its drive, and
(b) hard protection of the plastic KC->MBON set, the APL->KC loop and every edge into or out of
a readout population, so the cells we actually decode keep their full input.

Fidelity is measured exactly the way fidelity.py does it (worker.fly_loop, the same scenarios,
the decoded actions over the second half of each scenario), extended with:
  * per-readout FIRING RATES (Hz) per scenario, not only decoded actions,
  * the DNa02 L-R steering sign on every step,
  * escape / stop event counts,
  * the step cost proxy: edges touched per hop = sum over spiking cells of their KEPT out-degree.

Pruning is applied by ZEROING the dropped weights, not by compacting the CSR: the spikes are
identical either way (a zero-weight edge delivers nothing) and the kept-out-degree proxy above
gives the cost the compacted file would have. export.py does the real compaction.
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
HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
sys.path.insert(0, str(REPO / "brain_server"))
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime"))
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

UNIT_MV = 0.275  # weight = contacts * 0.275 mV (signed)
STEP_MS = 50.0
GAP_STEPS, SCEN_STEPS = 40, 60  # 2.0 s settle + 3.0 s scenario, per fidelity.py

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
    "wall_left": {"loom_wall": {"L": 1.0}},
    "wind": {"wind": {"L": 1.0, "R": 1.0}},
    "bristle": {"bristle": {"L": 1.0, "R": 1.0}},
    "hunger": {"hunger": 1.0},
    "reward": {"reward": 1.0, "odor": {"L": 0.6, "R": 0.6}},
}
ACT_KEYS = ["turn", "orient", "avoid", "steer", "escape_L", "escape_R", "stop", "back", "feed",
            "appetite", "thrust", "groom", "neck", "sacc", "prob", "legs"]
# the readouts the lens actually reads out and the brief names them (steering, escape, stop,
# feeding, dopamine, MB output, vision, horizon)
SPECS = {  # name -> (global minimum contacts, per-postsynaptic top-k floor)
    "c2k16": (2, 16), "c3k16": (3, 16), "c3k32": (3, 32),
    "c5k16": (5, 16), "c5k32": (5, 32), "c8k32": (8, 32),
    "c11k32": (11, 32), "c11k48": (11, 48), "c21k64": (21, 64),
    # per-postsynaptic |w| fraction: keep the strongest inputs carrying f of each cell's own |w|
    "f999": (0.999, 8), "f99": (0.99, 8), "f97": (0.97, 8), "f95": (0.95, 8), "f90": (0.90, 8),
}
COMPENSATED = {"f95c", "f90c", "c3k16c"}  # run with the per-cell drive compensation on top
CORE_READS = ["DNa02_L", "DNa02_R", "esc_L", "esc_R", "stop", "feed", "appetite", "reward", "stress",
              "MBON07", "MBON11", "LC4_L", "LC4_R", "LPLC2_L", "LPLC2_R", "LC11_L", "LC11_R",
              "T4_L", "T4_R", "T5_L", "T5_R", "HSE_L", "HSE_R", "VS_L", "VS_R",
              "DNp66_L", "DNp66_R", "back", "walk", "power_L", "power_R"]


# ---------------------------------------------------------------------------------------
# the connectome, its protected edge classes and the candidate masks
# ---------------------------------------------------------------------------------------

def load_proto():
    from flywirehead.neural.visual import VisualMemoryBrain
    brain = VisualMemoryBrain()
    brain.weights_frozen = True
    return brain


def protected(brain):
    """(mask over edges that must never be dropped, {class: count}) -- the whole readout surface."""
    import worker
    from flywirehead.neural.common import annotations

    n, ptr, post = brain.n, brain.ptr, brain.post
    pre = np.repeat(np.arange(n, dtype=np.int32), np.diff(ptr))
    circ = brain.circuit
    keep = np.zeros(len(post), bool)
    counts = {}

    keep[circ["edges"]] = True
    counts["plastic_kc_mbon"] = int(len(circ["edges"]))

    types = annotations(brain.ids).type.fillna("").to_numpy().astype(str)
    apl = np.flatnonzero(types == "APL")
    iskc = np.zeros(n, bool)
    iskc[circ["kc"]] = True
    inh = np.concatenate([np.arange(ptr[i], ptr[i + 1])[iskc[post[ptr[i]:ptr[i + 1]]]] for i in apl]) if len(apl) else np.zeros(0, np.int64)
    keep[inh.astype(np.int64)] = True
    counts["apl_kc"] = int(len(inh))

    senses, reads, _regions = worker.prepare(brain)
    readcells = np.unique(np.concatenate([v for v in reads.values() if len(v)])).astype(np.int32)
    isread = np.zeros(n, bool)
    isread[readcells] = True
    before = keep.sum()
    keep |= isread[pre] | isread[post]
    counts["readout_io"] = int(keep.sum() - before)
    counts["readout_cells"] = int(isread.sum())

    sensecells = np.unique(np.concatenate([c for grp in senses.values() for c in grp.values() if len(c)])).astype(np.int32)
    issense = np.zeros(n, bool)
    issense[sensecells] = True
    before = keep.sum()
    keep |= issense[pre]  # the first hop out of every injected cell
    counts["sense_out"] = int(keep.sum() - before)
    counts["sense_cells"] = int(issense.sum())
    counts["protected_total"] = int(keep.sum())
    return keep, counts, pre


def topk_mask(ptr, post, weight, n, k):
    """keep each neuron's k strongest INCOMING edges (by |w|) so no cell loses all its drive."""
    order = np.argsort(post, kind="stable")          # edges grouped by target
    tgt = post[order]
    w = np.abs(weight[order])
    starts = np.r_[0, np.cumsum(np.bincount(tgt, minlength=n))].astype(np.int64)
    # rank inside each target's block: sort by (target, -|w|)
    within = np.lexsort((-w, tgt))
    ranked = order[within]
    rank = np.arange(len(post), dtype=np.int64) - np.repeat(starts[:-1], np.diff(starts))
    m = np.zeros(len(post), bool)
    m[ranked[rank < k]] = True
    return m


def frac_mask(ptr, post, weight, n, frac):
    """Per POSTSYNAPTIC cell: keep the strongest incoming edges that together carry `frac` of that
    cell's total incoming |w|. Aimed straight at what breaks a top-k cut: a LIF cell's resting
    point is set by the SUM of its input, so preserving 99 % of each cell's own |w| preserves its
    bias current even when most of its edges go."""
    aw = np.abs(weight)
    within = np.lexsort((-aw, post))       # edges sorted by (target, -|w|)
    tgt, w = post[within], aw[within].astype(np.float64)
    sizes = np.bincount(tgt, minlength=n).astype(np.int64)
    starts = np.r_[0, np.cumsum(sizes)]
    csum = np.cumsum(w)
    before = np.where(starts[:-1] > 0, csum[np.maximum(starts[:-1] - 1, 0)], 0.0)  # sum before each block
    run = csum - np.repeat(before, sizes)                      # running sum inside the block
    total = np.repeat(np.where(sizes > 0, run[np.maximum(starts[1:] - 1, 0)], 0.0), sizes)
    m = np.zeros(len(post), bool)
    m[within] = (run - w) < frac * total   # keep the prefix that reaches the fraction
    return m


def compensate(brain, keep):
    """Restore each cell's dropped input as a gain on its survivors, excitatory and inhibitory
    pools separately, so the summed drive per cell is exactly what the full brain delivers."""
    w = brain.weight
    post = brain.post
    n = brain.n
    out = w.copy()
    for sign in (1.0, -1.0):
        s = (np.sign(w) == sign)
        full = np.bincount(post[s], weights=w[s].astype(np.float64), minlength=n)
        kept = np.bincount(post[s & keep], weights=w[s & keep].astype(np.float64), minlength=n)
        g = np.where(np.abs(kept) > 1e-9, full / np.where(kept == 0, 1.0, kept), 1.0)
        g = np.clip(g, 0.2, 5.0)
        sel = s & keep
        out[sel] = (w[sel].astype(np.float64) * g[post[sel]]).astype(np.float32)
    return out


def build_masks(brain, prot, pre, specs):
    """specs: name -> (minimum synaptic contacts kept globally, per-postsynaptic top-k floor)."""
    contacts = np.rint(np.abs(brain.weight) / UNIT_MV).astype(np.int32)
    out, tk = {}, {}
    for name, (cmin, k) in specs.items():
        if isinstance(cmin, float):           # a per-postsynaptic |w| fraction, not a contact count
            m = frac_mask(brain.ptr, brain.post, brain.weight, brain.n, cmin)
        else:
            m = contacts >= cmin
        if k:
            if k not in tk:
                tk[k] = topk_mask(brain.ptr, brain.post, brain.weight, brain.n, k)
            m |= tk[k]
        m |= prot
        out[name] = (m, float(cmin))
    return out


# ---------------------------------------------------------------------------------------
# fidelity: drive the pruned brain through the scenarios with the worker's own loop
# ---------------------------------------------------------------------------------------

class Pipe:
    def __init__(self):
        self.q = queue.Queue()

    def poll(self):
        return not self.q.empty()

    def recv(self):
        return self.q.get_nowait()


def run_one(name, kernel):
    import worker
    from engine.metal.metal_engine import MetalEngine
    from engine.engine import _reset_fly, kernel_function

    t0 = time.time()
    brain = load_proto()
    total_abs = float(np.abs(brain.weight).sum())
    ne = len(brain.post)
    comp = name in COMPENSATED
    if name == "full":
        keep = np.ones(ne, bool)
    else:
        keep = np.load(OUT / f"mask_{name.rstrip('c') if comp else name}.npy")
        if comp:  # rescale the survivors so every cell keeps the full brain's summed drive
            brain.weight[:] = compensate(brain, keep)
        brain.weight[~keep] = 0.0
    kept_abs = float(np.abs(brain.weight).sum())
    outdeg_kept = np.bincount(np.repeat(np.arange(brain.n, dtype=np.int32), np.diff(brain.ptr))[keep],
                              minlength=brain.n).astype(np.int64)
    load_s = time.time() - t0

    if kernel == "metal":
        engine = MetalEngine(brain, 1)
        fly = engine.make_fly(0, _reset_fly)
    else:
        engine = None
        fly = brain
        fly.advance = kernel_function(brain, kernel)

    # per-neuron spike counts, for the "edges touched per hop" cost proxy. rgb_step is the
    # package's own 10 ms chunk; it returns the per-neuron counts the worker sums.
    tally = {"cells": np.zeros(brain.n, np.int64), "chunks": 0}
    _rgb = fly.rgb_step

    def rgb_step(*args, **kw):
        c, x = _rgb(*args, **kw)
        tally["cells"] += c
        tally["chunks"] += 1
        return c, x

    fly.rgb_step = rgb_step

    indices = worker.prepare(fly)
    read_ix = indices[1]
    plan = []
    for sname, ch in SCENARIOS.items():
        plan += [("gap", {"light": 0.627})] * GAP_STEPS + [(sname, ch)] * SCEN_STEPS
    inbox = Pipe()
    acts = {s: [] for s in SCENARIOS}
    rates = {s: [] for s in SCENARIOS}
    steer = {s: [] for s in SCENARIOS}
    events = {s: {"escape": 0, "stop": 0, "n": 0} for s in SCENARIOS}
    walls = []
    state = {"i": 0}

    class Out:
        def send(self, msg):
            if msg.get("t") != "brain":
                inbox.q.put({"senses": plan[0][1]})
                return
            i = state["i"]
            sname, _ = plan[i]
            if sname != "gap" and (i % (GAP_STEPS + SCEN_STEPS)) >= GAP_STEPS:
                a, hz = msg["act"], msg["hz"]
                if (i % (GAP_STEPS + SCEN_STEPS)) >= GAP_STEPS + SCEN_STEPS // 2:
                    acts[sname].append(a)
                    rates[sname].append(hz)
                # the DNa02 L-R steering timeline + escape/stop events over the WHOLE scenario
                steer[sname].append(hz["DNa02_R"] - hz["DNa02_L"])
                e = events[sname]
                e["n"] += 1
                e["escape"] += int(max(a["escape_L"], a["escape_R"]) > 0.5)
                e["stop"] += int(a["stop"] > 0.5)
            walls.append(msg["prof"]["adv"])
            state["i"] = i + 1
            if state["i"] >= len(plan):
                inbox.q.put({"stop": True})
            else:
                inbox.q.put({"senses": plan[state["i"]][1]})

    worker.fly_loop(fly, indices, 0, inbox, Out(), np.arange(16), STEP_MS)
    spikes = tally["cells"]
    hops = max(1, tally["chunks"] / 5.0)  # 5 x 10 ms chunks = one 50 ms hop
    touched = float((spikes * outdeg_kept).sum())
    indeg_kept = np.bincount(brain.post[keep], minlength=brain.n)
    indeg_full = np.bincount(brain.post, minlength=brain.n)

    res = {
        "name": name, "kernel": kernel,
        "edges_kept": int(keep.sum()), "edges_total": ne,
        "weight_share_kept": kept_abs / total_abs,
        "silent_cells": int(((indeg_kept == 0) & (indeg_full > 0)).sum()),
        "adv_ms_median": float(np.median(walls)), "load_s": load_s, "wall_s": time.time() - t0,
        "touched_per_hop": touched / hops, "hops": hops, "spikes_total": int(spikes.sum()),
        # cells that never fired in the whole battery: their outgoing edges delivered nothing here
        "never_fired": int((spikes == 0).sum()),
        "never_fired_out_edges": int(outdeg_kept[spikes == 0].sum()),
        "act": {s: {k: float(np.mean([r.get(k, 0.0) for r in rs])) for k in ACT_KEYS} for s, rs in acts.items()},
        "rate": {s: {k: float(np.mean([r.get(k, 0.0) for r in rs])) for k in read_ix} for s, rs in rates.items()},
        "steer_sign": {s: [float(x) for x in v] for s, v in steer.items()},
        "events": events,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / f"lite_{name}.json").write_text(json.dumps(res, indent=1))
    print(f"[{name}] {res['edges_kept']/1e6:.2f} M edges ({100*res['edges_kept']/ne:.1f} %), "
          f"|w| {100*res['weight_share_kept']:.1f} %, touched/hop {touched/hops/1e6:.2f} M, "
          f"adv {res['adv_ms_median']:.0f} ms, {res['wall_s']:.0f} s", flush=True)


# ---------------------------------------------------------------------------------------

def table(names):
    base = json.loads((OUT / "lite_full.json").read_text())
    rows = []
    for name in names:
        p = OUT / f"lite_{name}.json"
        if not p.exists():
            continue
        r = json.loads(p.read_text())
        rate_err, corr, worst_read = {}, {}, ("", 0.0)
        for k in CORE_READS:
            a = np.array([base["rate"][s][k] for s in SCENARIOS])
            b = np.array([r["rate"][s][k] for s in SCENARIOS])
            denom = max(1e-6, float(np.mean(np.abs(a))))
            e = float(np.mean(np.abs(b - a)) / denom)
            rate_err[k] = e
            corr[k] = float(np.corrcoef(a, b)[0, 1]) if a.std() > 1e-9 and b.std() > 1e-9 else 1.0
            if e > worst_read[1]:
                worst_read = (k, e)
        same_sign = []
        for s in SCENARIOS:
            a = np.sign(np.round(np.array(base["steer_sign"][s]), 3))
            b = np.sign(np.round(np.array(r["steer_sign"][s]), 3))
            same_sign.append(float((a == b).mean()))
        act_err = max(abs(r["act"][s][k] - base["act"][s][k]) for s in SCENARIOS for k in ACT_KEYS)
        rows.append({
            "name": name, "edges": r["edges_kept"], "edges_pct": 100 * r["edges_kept"] / r["edges_total"],
            "w_pct": 100 * r["weight_share_kept"], "silent": r["silent_cells"],
            "touched": r["touched_per_hop"], "touched_pct": 100 * r["touched_per_hop"] / base["touched_per_hop"],
            "mb_compressed_est": None,
            "rate_err_mean": float(np.mean(list(rate_err.values()))), "rate_err_max": worst_read[1],
            "rate_err_worst": worst_read[0], "corr_min": float(min(corr.values())),
            "steer_same": float(np.mean(same_sign)), "act_err_max": act_err,
            "adv_ms": r["adv_ms_median"],
        })
    hdr = f"{'candidate':<14} {'edges':>10} {'%':>6} {'|w|%':>6} {'silent':>7} {'touch/hop':>10} {'%':>6} {'rateErr':>8} {'max':>7} {'worst':>9} {'corrMin':>8} {'sign%':>6} {'actErr':>7}"
    print(hdr)
    print("-" * len(hdr))
    b = base
    print(f"{'full':<14} {b['edges_total']:>10} {100.0:>6.1f} {100.0:>6.1f} {'-':>7} {b['touched_per_hop']/1e6:>9.2f}M {100.0:>6.1f} {0.0:>8.3f} {0.0:>7.3f} {'-':>9} {1.0:>8.3f} {100.0:>6.1f} {0.0:>7.3f}")
    for r in rows:
        print(f"{r['name']:<14} {r['edges']:>10} {r['edges_pct']:>6.1f} {r['w_pct']:>6.1f} {r['silent']:>7} "
              f"{r['touched']/1e6:>9.2f}M {r['touched_pct']:>6.1f} {r['rate_err_mean']:>8.3f} {r['rate_err_max']:>7.3f} "
              f"{r['rate_err_worst']:>9} {r['corr_min']:>8.3f} {100*r['steer_same']:>6.1f} {r['act_err_max']:>7.3f}")
    (OUT / "table.json").write_text(json.dumps(rows, indent=1))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["stats", "masks", "run", "one", "table"])
    ap.add_argument("--cand", nargs="*", default=[])
    ap.add_argument("--kernel", default="metal")
    a = ap.parse_args()

    if a.cmd == "one":
        run_one(a.cand[0], a.kernel)
        return
    if a.cmd == "table":
        table(a.cand or [p.stem[5:] for p in sorted(OUT.glob("lite_*.json")) if p.stem != "lite_full"])
        return
    if a.cmd == "run":
        for name in a.cand:
            subprocess.run([sys.executable, __file__, "one", "--cand", name, "--kernel", a.kernel], check=True)
        return

    brain = load_proto()
    aw = np.abs(brain.weight)
    ne = len(aw)
    if a.cmd == "stats":
        order = np.sort(aw)
        cum = np.cumsum(order.astype(np.float64))
        tot = cum[-1]
        print(f"edges {ne}  neurons {brain.n}  |w| sum {tot:.4g}")
        print(f"contacts: median {np.median(aw)/UNIT_MV:.0f}  mean {aw.mean()/UNIT_MV:.2f}  max {aw.max()/UNIT_MV:.0f}")
        print(f"{'drop weakest':>13} {'threshold |w|':>14} {'contacts<=':>11} {'edges left':>11} {'|w| lost %':>11}")
        for f in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
            i = int(f * ne)
            print(f"{100*f:>12.0f}% {order[i]:>14.4f} {order[i]/UNIT_MV:>11.1f} {ne-i:>11} {100*cum[i]/tot:>11.2f}")
        for c in (1, 2, 3, 5, 10, 20):
            m = np.rint(aw / UNIT_MV).astype(np.int32) >= c
            print(f"contacts >= {c:<3}: edges {int(m.sum()):>10} ({100*m.mean():>5.1f} %)  |w| kept {100*aw[m].sum()/tot:>5.1f} %")
        indeg = np.bincount(brain.post, minlength=brain.n)
        print(f"in-degree: median {int(np.median(indeg))} mean {indeg.mean():.0f} p10 {int(np.percentile(indeg,10))} zero {int((indeg==0).sum())}")
        return

    prot, counts, pre = protected(brain)
    print("protected edge classes:", json.dumps(counts))
    specs = SPECS
    masks = build_masks(brain, prot, pre, specs)
    OUT.mkdir(exist_ok=True)
    meta = {"protected": counts, "candidates": {}}
    for name, (m, thr) in masks.items():
        np.save(OUT / f"mask_{name}.npy", m)
        indeg = np.bincount(brain.post[m], minlength=brain.n)
        meta["candidates"][name] = {
            "cmin": specs[name][0], "topk": specs[name][1], "threshold_mv": thr * UNIT_MV,
            "edges": int(m.sum()), "edges_pct": 100 * float(m.mean()),
            "weight_pct": 100 * float(np.abs(brain.weight[m]).sum() / np.abs(brain.weight).sum()),
            "silent_cells": int((indeg == 0).sum()),
        }
        print(name, json.dumps(meta["candidates"][name]))
    (OUT / "masks.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
