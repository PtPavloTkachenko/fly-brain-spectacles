#!/usr/bin/env python3
"""Summarise the lens's PERF_ROW lines from a Lens Studio log (the editor-side perf instrument).

    perf_rows.py [--log PATH] [--since HH:MM:SS] [--last N] [--label NAME] [--json OUT]

Each row (every DEBUG_TELEMETRY_S) looks like
    PERF_ROW ok verts=… | fps 19 worst 185ms | perf ours=8.78/0.65 webscene=1.50/0.11 board=0.04/0.02 … | ms
`name=worst/mean` is ms per frame inside the window (worst kept for spikes, mean = the steady cost).
Prints fps (mean, min), worst frame (median, max) and the per-subsystem mean/worst over the rows.
"""
import argparse, glob, json, os, re, statistics as st

LOGDIR = os.path.expanduser("~/Library/Preferences/Snap/Lens Studio/logs")


def newest_log():
    fs = glob.glob(os.path.join(LOGDIR, "LensStudioLog-*.txt"))
    return max(fs, key=os.path.getmtime) if fs else None


def parse(path, since=None, last=None, maxworst=5000):
    rows = []
    with open(path, "rb") as f:
        for raw in f:
            if b"PERF_ROW" not in raw:
                continue
            line = raw.decode("utf-8", "replace")
            m = re.match(r"^. (\d\d:\d\d:\d\d)\.\d+ ", line)
            ts = m.group(1) if m else ""
            if since and ts and ts < since:
                continue
            fps = re.search(r"\| fps (\d+|\?) worst (\d+)ms", line)
            if not fps or fps.group(1) == "?":
                continue
            if int(fps.group(2)) > maxworst:
                continue  # a preview reset / recompile inside the window, not a frame
            perf = dict((k, (float(w), float(mn))) for k, w, mn in re.findall(r"(\w+)=([\d.]+)/([\d.]+)", line.split("| perf", 1)[1] if "| perf" in line else ""))
            rows.append({"t": ts, "fps": int(fps.group(1)), "worst": int(fps.group(2)), "perf": perf})
    if last:
        rows = rows[-last:]
    return rows


def summarise(rows):
    if not rows:
        return {"n": 0}
    keys = sorted({k for r in rows for k in r["perf"]}, key=lambda k: -st.mean(r["perf"].get(k, (0, 0))[1] for r in rows))
    per = {k: {"mean_ms": round(st.mean(r["perf"].get(k, (0, 0))[1] for r in rows), 3),
               "worst_ms": round(max(r["perf"].get(k, (0, 0))[0] for r in rows), 2)} for k in keys}
    return {"n": len(rows), "from": rows[0]["t"], "to": rows[-1]["t"],
            "fps_mean": round(st.mean(r["fps"] for r in rows), 1), "fps_min": min(r["fps"] for r in rows),
            "frame_ms_mean": round(1000 / max(1e-6, st.mean(r["fps"] for r in rows)), 1),
            "worst_median_ms": st.median(r["worst"] for r in rows), "worst_max_ms": max(r["worst"] for r in rows),
            "script_mean_ms": round(sum(v["mean_ms"] for v in per.values()), 2), "per": per}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log"); ap.add_argument("--since"); ap.add_argument("--last", type=int)
    ap.add_argument("--label", default=""); ap.add_argument("--json"); ap.add_argument("--maxworst", type=int, default=5000)
    a = ap.parse_args()
    log = a.log or newest_log()
    rows = parse(log, a.since, a.last, a.maxworst)
    s = summarise(rows)
    s["label"] = a.label; s["log"] = os.path.basename(log or "")
    if s["n"] == 0:
        print("no PERF_ROW rows", "since " + a.since if a.since else ""); return
    print(f"{a.label or 'window'}: {s['n']} rows {s['from']}–{s['to']}  fps {s['fps_mean']} (min {s['fps_min']})  frame {s['frame_ms_mean']} ms  "
          f"worst median {s['worst_median_ms']} max {s['worst_max_ms']} ms  scripts {s['script_mean_ms']} ms/frame")
    for k, v in s["per"].items():
        if v["mean_ms"] >= 0.005 or v["worst_ms"] >= 0.5:
            print(f"  {k:10s} mean {v['mean_ms']:6.3f}  worst {v['worst_ms']:6.2f}")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(s, f, indent=1)


if __name__ == "__main__":
    main()
