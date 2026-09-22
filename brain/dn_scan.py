"""Which descending neurons (brain -> body commands) respond to each sense, and on which side?

The biological steering/walking cells (DNa01/DNa02/DNp09) barely respond in this model, so
rank every descending neuron by (a) response vs control and (b) left/right mirror asymmetry
for lateralized probes. The top cells are candidate readouts for turn / walk / stop.

Run from the fly-wirehead runtime:
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<this file>"
"""

import json
import re
from pathlib import Path

import numpy as np

from probe import cells, root, run, soma, superclass, types

OUT = Path(__file__).with_name("results")
SECONDS = 0.5

dn = cells(np.char.find(superclass.astype(str), "descending") >= 0)
dn = dn[~np.isin(superclass[dn], ["sensory_descending"])]
print(f"descending neurons: {len(dn)}  (superclasses: {sorted(set(superclass[dn]))})")


def lr(pattern, side_array):
    rx = re.compile(pattern)
    m = np.array([bool(rx.match(t)) for t in types])
    return {s: cells(m & (side_array == s)) for s in "LR"}


ORN_ATTR = lr(r"^ORN_(DM1|DM2|DM4|VA2)$", root)
ORN_ALL = lr(r"^ORN_", root)
LC_OBJECT = lr(r"^LC(9|10[a-e]?|11|12|13|15|18|21|25|26)$", soma)
LOOM = lr(r"^(LPLC2|LC4)$", soma)
SWEET = cells(np.isin(types, ["LB3c", "LB4b"]))
BITTER = cells(np.isin(types, ["LB2a", "LB2c", "LB1d"]))
included = sorted({types[i] for s in "LR" for i in LC_OBJECT[s]})
print("LC object types found:", included)

probes = {"control": None}
for name, groups, mv in [
    ("odor_attr", ORN_ATTR, 30.0),
    ("odor_all", ORN_ALL, 20.0),
    ("lc_object", LC_OBJECT, 20.0),
    ("loom", LOOM, 20.0),
]:
    for s in "LR":
        probes[f"{name}:{s}"] = [(groups[s], mv)]
probes["sweet"] = [(SWEET, 20.0)]
probes["bitter"] = [(BITTER, 20.0)]

rate = {}
for name, stim in probes.items():
    counts, wall = run(stim=stim)
    rate[name] = counts[dn] / SECONDS
    print(f"  {name:<14} wall {wall:5.2f}s  DN spikes {int(counts[dn].sum())}")

base = rate["control"]
dn_type = types[dn]
dn_side = soma[dn]
# Mirror partner of each DN: same type, other side (first match).
mirror = np.full(len(dn), -1)
for k, (t, s) in enumerate(zip(dn_type, dn_side)):
    other = np.flatnonzero((dn_type == t) & (dn_side == ("R" if s == "L" else "L")))
    if len(other):
        mirror[k] = other[0]


def label(k):
    return f"{dn_type[k] or '?'}_{dn_side[k] or '?'}"


report = {}
for name in probes:
    if name == "control":
        continue
    delta = rate[name] - base
    top = np.argsort(-np.abs(delta))[:12]
    report[name] = [(label(k), round(float(base[k]), 1), round(float(rate[name][k]), 1)) for k in top]

# Lateralized families: cells whose response flips with the side of the stimulus.
steer = {}
for fam in ["odor_attr", "odor_all", "lc_object", "loom"]:
    dl = rate[f"{fam}:L"] - base
    dr = rate[f"{fam}:R"] - base
    score = np.abs(dl - dr)
    top = np.argsort(-score)[:12]
    steer[fam] = [(label(k), round(float(dl[k]), 1), round(float(dr[k]), 1)) for k in top]

OUT.mkdir(exist_ok=True)
(OUT / "dn_scan.json").write_text(json.dumps({"top_delta": report, "lateral": steer}, indent=2) + "\n")

print("\n== strongest DN changes vs control (cell: control Hz -> probe Hz)")
for name, rows in report.items():
    print(f"{name:<14} " + "  ".join(f"{c} {b:g}->{p:g}" for c, b, p in rows[:6]))
print("\n== side-flipping DNs (cell: dHz when stim LEFT / dHz when stim RIGHT)")
for fam, rows in steer.items():
    print(f"{fam:<10} " + "  ".join(f"{c} {l:+g}/{r:+g}" for c, l, r in rows[:6]))
