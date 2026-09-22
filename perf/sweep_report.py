#!/usr/bin/env python3
"""Merge every <stage>.json in a sweep folder (from any number of sweep.py runs) into SWEEP_RESULTS.md,
deltas against 01_full. A stage is VALID only if its rows come from the board with the fly shown; the
runner cannot know that, so `--invalid a,b` marks stages to list but not to interpret."""
import glob, json, os, sys, time

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sweep_2026-09-21")
invalid = set((sys.argv[sys.argv.index("--invalid") + 1] if "--invalid" in sys.argv else "").split(",")) - {""}
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from sweep import STAGES
except Exception:
    STAGES = []
FLAGS = dict(STAGES)
rs = []
for f in sorted(glob.glob(os.path.join(d, "*.json"))):
    if os.path.basename(f) in ("results.json",):
        continue
    r = json.load(open(f)); r["label"] = r.get("label") or os.path.basename(f)[:-5]
    r["flags"] = r.get("flags") or " ".join(f"{k}={v}" for k, v in FLAGS.get(r["label"], {}).items()); rs.append(r)
base = next((r for r in rs if r["label"] == "01_full" and r.get("n")), None)
L = ["# Perf sweep, editor (LS 5.23.2 preview on the Mac, page brain) — " + time.strftime("%Y-%m-%d %H:%M"), "",
     "Instrument: `PERF_ROW` (script ms/frame per subsystem, mean over a 45 s window at the board with the fly shown; worst frame kept) + preview fps. "
     "Δ = stage − `01_full`; a negative Δ frame is what the switched-off system cost. These are EDITOR numbers (the Mac renders the preview); the glasses' numbers come from `LENS_PERF` rows on the page.", "",
     "| stage | flags | rows | fps | frame ms | Δ frame | worst med / max ms | scripts ms | Δ scripts | top subsystems (mean ms) |", "|---|---|---|---|---|---|---|---|---|---|"]
for r in rs:
    lab = r["label"] + (" ⚠ invalid" if r["label"] in invalid else "")
    if not r.get("n"):
        L.append(f"| {lab} | {r.get('flags','')} | 0 | — | — | — | — | — | — | {r.get('error','no rows')} |"); continue
    top = ", ".join(f"{k} {v['mean_ms']:.2f}" for k, v in list(r["per"].items())[:4])
    df = f"{r['frame_ms_mean'] - base['frame_ms_mean']:+.1f}" if base and r is not base else "—"
    ds = f"{r['script_mean_ms'] - base['script_mean_ms']:+.2f}" if base and r is not base else "—"
    L.append(f"| {lab} | {r.get('flags','')} | {r['n']} | {r['fps_mean']} | {r['frame_ms_mean']} | {df} | {r['worst_median_ms']} / {r['worst_max_ms']} | {r['script_mean_ms']} | {ds} | {top} |")
open(os.path.join(d, "SWEEP_RESULTS.md"), "w").write("\n".join(L) + "\n")
print("\n".join(L))
