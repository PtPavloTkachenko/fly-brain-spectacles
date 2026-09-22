"""Behaviour battery on the native core: does a core setting change what the fly DOES?

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/tools/battery.py \
        --flyb <repo>/core/brain_export/out/brain_c0.flyb.z --lib libflybrain_dt.dylib --settings '{}' '{"dt":0.2}'

Same scenarios as brain_server/fake_lens.py (2 s neutral, then 3 s of the scenario, mean decoded
actions over the last 1.5 s), run natively for every settings JSON (posted before warm-up). Prints
the decoded actions per scenario, the max |difference| against the first settings, and the wall
time per 50 ms step. This is the fidelity check for approximations (ADR 47: pruning failed it).
"""

import argparse
import ctypes as C
import json
import sys
import time
from pathlib import Path

import numpy as np

CORE = Path(__file__).resolve().parents[1]
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
    "wall_left": {"loom_wall": {"L": 1.0}},
    "hot": {"hot": 1.0},
}
KEYS = ["turn", "orient", "avoid", "escape_L", "escape_R", "stop", "back", "feed", "appetite", "thrust", "groom", "neck"]
GAP_STEPS, SCEN_STEPS = 40, 60


def run(flyb, lib_name, settings, threads):
    lib = C.CDLL(str(CORE / "build" / lib_name))
    lib.fb_create.restype = C.c_void_p
    lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
    lib.fb_last_error.restype = C.c_char_p
    lib.fb_warmup.restype = C.c_char_p
    lib.fb_warmup.argtypes = [C.c_void_p]
    lib.fb_step.restype = C.c_char_p
    lib.fb_step.argtypes = [C.c_void_p]
    lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
    lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
    lib.fb_destroy.argtypes = [C.c_void_p]
    data = Path(flyb).read_bytes()
    b = lib.fb_create(data, len(data), 50.0, 0)
    if not b:
        raise SystemExit("fb_create: " + lib.fb_last_error().decode())
    del data
    if settings:
        lib.fb_post(b, json.dumps(settings).encode())
    if threads > 1:
        lib.fb_set_threads(b, threads)
    ready = json.loads(lib.fb_warmup(b))
    walls, out = [], {}
    for name, ch in SCENARIOS.items():
        for stage, (senses, steps) in enumerate((({"light": 0.627}, GAP_STEPS), (ch, SCEN_STEPS))):
            lib.fb_post(b, json.dumps({"senses": senses}).encode())
            rows = []
            for i in range(steps):
                m = json.loads(lib.fb_step(b))
                walls.append(m["prof"]["adv"])
                if stage == 1 and i >= steps // 2:
                    rows.append(m["act"])
        out[name] = {k: float(np.mean([r.get(k, 0.0) for r in rows])) for k in KEYS}
    dt = m.get("dt", 0.1)
    lib.fb_destroy(b)
    return {"settings": settings, "dt": dt, "act": out, "adv_ms": float(np.median(walls)), "baseline_DNa02_L": ready["baseline"].get("DNa02_L")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flyb", required=True)
    ap.add_argument("--lib", default="libflybrain_host.dylib")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--settings", nargs="+", default=["{}"])
    a = ap.parse_args()
    res = []
    for s in a.settings:
        t0 = time.time()
        r = run(a.flyb, a.lib, json.loads(s), a.threads)
        r["wall_s"] = time.time() - t0
        res.append(r)
        print(f"settings {s}: dt {r['dt']} ms, median advance {r['adv_ms']:.0f} ms per 50 ms step, {r['wall_s']:.0f} s wall", flush=True)
    base = res[0]
    print(f"\n{'scenario':<13}" + "".join(f"{k:>9}" for k in ("turn", "orient", "escape_L", "escape_R", "stop", "feed", "appetite", "thrust")) + "   | max|diff| vs first, per settings")
    for name in SCENARIOS:
        row = base["act"][name]
        diffs = [max(abs(r["act"][name][k] - row[k]) for k in KEYS) for r in res[1:]]
        print(f"{name:<13}" + "".join(f"{row[k]:9.2f}" for k in ("turn", "orient", "escape_L", "escape_R", "stop", "feed", "appetite", "thrust"))
              + "   | " + "  ".join(f"{d:.2f}" for d in diffs))
    for r in res[1:]:
        worst = max(max(abs(r["act"][n][k] - base["act"][n][k]) for k in KEYS) for n in SCENARIOS)
        print(f"\n{json.dumps(r['settings'])}: worst action difference {worst:.2f}, speed x{base['adv_ms'] / max(1e-9, r['adv_ms']):.2f}")


if __name__ == "__main__":
    main()
