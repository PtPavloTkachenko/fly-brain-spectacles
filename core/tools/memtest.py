"""Does the fly's memory survive being saved and loaded? (ADR 63)

Two proofs, both on the real core, one brain load:

  round-trip   train with learning on, and at one step post `memory:echo`: the core saves the
               plastic state and loads it straight back, in the same instant. Every step of that
               run must have the SAME spike total and the same mean efficacy as a run without the
               echo. That is what "lossless and non-perturbing" means: the blob holds everything
               the rule needs to carry on, and reading it back costs the brain nothing.
               (`get` and `set` as separate messages land one step apart, so the pair would rewind
               the rule by a step -- true, and exactly why the check is one message.)

  transfer     train one brain, `memory:get`, then run the SAME test trial twice from the same
               reset state: once naive, once with the memory loaded. If the two trials differ,
               the stored memory is real -- it is the only thing that changed.

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/tools/memtest.py \
        --flyb <repo>/core/brain_export/out/brain_c0.flyb.z [--lib libflybrain_host.dylib]

No Python reference is needed: this checks the core against itself.
"""

import argparse
import ctypes as C
import json
import time
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]

# The conditioning trial. CS = a strong smell on both antennae (ORN_DM1/DM2/DM4/VA2 -> the mushroom
# body's KCs); US = `pulse reward` = 200 ms into PAM11. Both are the channels the lens uses.
CS = {"senses": {"odor": {"L": 0.9, "R": 0.9}}}
AIR = {"senses": {"odor": {"L": 0.0, "R": 0.0}}}
REWARD = {"pulse": "reward"}


class Core:
    def __init__(self, lib_path, flyb, step_ms=50.0, threads=1):
        lib = C.CDLL(str(lib_path))
        lib.fb_create.restype = C.c_void_p
        lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
        lib.fb_last_error.restype = C.c_char_p
        for f in ("fb_warmup", "fb_step"):
            getattr(lib, f).restype = C.c_char_p
            getattr(lib, f).argtypes = [C.c_void_p]
        lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
        lib.fb_take.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
        lib.fb_take.restype = C.c_int
        lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
        self.lib = lib
        data = Path(flyb).read_bytes()
        t0 = time.time()
        self.b = lib.fb_create(data, len(data), step_ms, 0)
        if not self.b:
            raise SystemExit("fb_create failed: " + lib.fb_last_error().decode())
        self.load_s = time.time() - t0
        if threads > 1:
            lib.fb_set_threads(self.b, threads)
        self.buf = C.create_string_buffer(1 << 22)

    def post(self, obj):
        self.lib.fb_post(self.b, json.dumps(obj).encode())

    def warmup(self):
        return json.loads(self.lib.fb_warmup(self.b))

    def step(self):
        return json.loads(self.lib.fb_step(self.b))

    def take(self):
        """the queued side channel: memory blobs, never dropped"""
        out = []
        while True:
            n = self.lib.fb_take(self.b, self.buf, len(self.buf))
            if n <= 0:
                return out
            if n > len(self.buf):
                self.buf = C.create_string_buffer(n + 4096)
                continue
            out.append(json.loads(self.buf.raw[:n]))

    def memory_get(self, compact=False):
        """post `get`, take one step so the core drains its inbox, return the memory message"""
        self.post({"memory": "get", "compact": compact})
        self.step()
        for m in self.take():
            if m.get("t") == "memory" and m.get("op") == "get":
                return m
        raise SystemExit("no memory message came back (core too old?)")

    def memory_set(self, data, elapsed_s=0.0):
        self.post({"memory": "set", "data": data, "elapsed_s": elapsed_s})
        self.step()
        for m in self.take():
            if m.get("t") == "memory" and m.get("op") == "set":
                return m
        raise SystemExit("no memory/set reply")


def train(core, bouts, hold, gap):
    """`bouts` pairings of CS with the US, `hold` steps of CS each, `gap` steps of air between."""
    for _ in range(bouts):
        core.post(CS)
        for k in range(hold):
            if k == 1:
                core.post(REWARD)
            core.step()
        core.post(AIR)
        for _ in range(gap):
            core.step()


def trial(core, steps):
    """CS only, no US: the probe. Returns the per-step spikes and the last act dict."""
    core.post(CS)
    rows = [core.step() for _ in range(steps)]
    core.post(AIR)
    return [r["neural"]["spikes"] for r in rows], rows[-1]["act"], [r["hz"] for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--flyb", required=True)
    ap.add_argument("--lib", default=str(CORE / "build" / "libflybrain_host.dylib"))
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--bouts", type=int, default=6)
    ap.add_argument("--hold", type=int, default=6)
    ap.add_argument("--gap", type=int, default=4)
    ap.add_argument("--probe", type=int, default=8)
    ap.add_argument("--elapsed", type=float, default=0.0, help="seconds of being switched off, for the ageing check")
    a = ap.parse_args()

    core = Core(a.lib, a.flyb, threads=a.threads)
    print(f"brain loaded in {core.load_s:.1f}s")
    core.post({"learning": True})
    core.warmup()

    # ---------------------------------------------------------------- 1. round trip
    # Run the same training twice from the same warm state. The second run does a get+set in the
    # middle. Every step must match.
    def run(echo_at):
        """the same session twice; `echo_at` >= 0 posts memory:echo before that step"""
        core.post({"reset": True})
        core.post({"memory": "clear"})
        core.post({"learning": True})
        core.step()
        spikes, effs, n, echoed = [], [], 0, None
        for i in range(a.bouts):
            core.post(CS)
            for k in range(a.hold):
                if k == 1:
                    core.post(REWARD)
                if n == echo_at:
                    core.post({"memory": "echo"})
                r = core.step()
                if n == echo_at:
                    echoed = [m for m in core.take() if m.get("op") == "echo"][0]
                spikes.append(r["neural"]["spikes"])
                effs.append(r["memory"]["mean_efficacy"])
                n += 1
            core.post(AIR)
            for _ in range(a.gap):
                r = core.step()
                spikes.append(r["neural"]["spikes"])
                effs.append(r["memory"]["mean_efficacy"])
                n += 1
        return spikes, effs, echoed

    t0 = time.time()
    steps_per_bout = a.hold + a.gap
    echo_at = (a.bouts // 2) * steps_per_bout + 2  # mid-session, with the CS on and weights moving
    s_plain, e_plain, _ = run(-1)
    s_rt, e_rt, echoed = run(echo_at)
    same = sum(1 for x, y in zip(s_plain, s_rt) if x == y)
    eff_diff = max(abs(x - y) for x, y in zip(e_plain, e_rt))
    print(f"\n== round trip: memory:echo at step {echo_at} of {len(s_plain)}, twice through the same session")
    print(f"   identical spike totals {same}/{len(s_plain)}, worst |mean_efficacy diff| {eff_diff:.9f}")
    print(f"   at the echo: {echoed['changed']} synapses moved, blob {echoed['bytes']} bytes, ok={echoed['ok']}")
    print(f"   final efficacy {e_plain[-1]:.6f}")
    ok_rt = same == len(s_plain) and eff_diff == 0.0

    # ---------------------------------------------------------------- 2. transfer
    # One trained blob, two identical probes from the same reset state. Learning OFF during the
    # probe, so nothing but the loaded memory can differ.
    core.post({"learning": False})  # freeze the weights, so the two `get`s below see the SAME state
    core.step()
    tg = time.time()
    m = core.memory_get()
    tg = (time.time() - tg) * 1000
    print(f"\n== the trained memory: {m['changed']} of {m['edges']} synapses moved, "
          f"mean efficacy {m['mean_efficacy']:.6f}, {m['rewards']} rewards, {m['punishes']} punishes")
    blob = m["data"]
    print(f"   full blob    {len(blob)} base64 chars = {len(blob) * 3 // 4} bytes "
          f"({len(blob) * 3 // 4 / max(1, m['changed']):.0f} per moved synapse); get+step {tg:.0f} ms")
    mc = core.memory_get(compact=True)
    print(f"   compact blob {len(mc['data'])} base64 chars = {len(mc['data']) * 3 // 4} bytes "
          f"(no 1 s traces: what a session-to-session save stores)")
    compact_blob = mc["data"]

    def probe(load_memory):
        core.post({"reset": True})
        core.post({"memory": "clear"})
        core.post({"learning": False})
        core.step()
        if load_memory:
            r = core.memory_set(blob, a.elapsed)
            if not r["ok"]:
                raise SystemExit("memory/set refused: " + r.get("err", "?"))
            print(f"   loaded: {r['changed']} synapses, efficacy {r['mean_efficacy']:.6f}"
                  + (f" after {a.elapsed:.0f}s off" if a.elapsed else ""))
        return trial(core, a.probe)

    sp_n, act_n, hz_n = probe(False)
    sp_t, act_t, hz_t = probe(True)

    # how much of it is left after the glasses have been off for a while: the rule's own tau (rule[2] of the brain file, 10800 s since ADR 92)
    print("\n== the memory ages while the glasses are off (the rule's own tau, ADR 63)")
    for off in (0, 300, 1800, 3600, 7 * 3600):
        core.post({"reset": True})
        core.post({"memory": "clear"})
        core.post({"learning": False})
        core.step()
        r = core.memory_set(blob, float(off))
        rel = (r["mean_efficacy"] - 1.0) / (m["mean_efficacy"] - 1.0) if m["mean_efficacy"] != 1.0 else 0.0
        print(f"   after {off:6d} s off: efficacy {r['mean_efficacy']:.6f}  ({100 * rel:5.1f} % of what was learned)")
    print(f"\n== the same probe, naive vs remembering")
    print(f"   spikes naive {sum(sp_n):8d}   trained {sum(sp_t):8d}   diff {sum(sp_t) - sum(sp_n):+d}")
    keys = sorted(set(act_n) & set(act_t), key=lambda k: -abs(act_t[k] - act_n[k]))
    for k in keys[:6]:
        print(f"   act {k:<10s} naive {act_n[k]:+.3f}  trained {act_t[k]:+.3f}  diff {act_t[k] - act_n[k]:+.3f}")
    dn = {k: sum(h[k] for h in hz_n) / len(hz_n) for k in hz_n[0]}
    dt = {k: sum(h[k] for h in hz_t) / len(hz_t) for k in hz_t[0]}
    rows = sorted(dn, key=lambda k: -abs(dt[k] - dn[k]))
    for k in rows[:5]:
        print(f"   hz  {k:<10s} naive {dn[k]:7.2f}  trained {dt[k]:7.2f}  diff {dt[k] - dn[k]:+.2f}")
    ok_tr = sum(sp_t) != sum(sp_n) or any(abs(act_t[k] - act_n[k]) > 1e-9 for k in keys)

    # ---------------------------------------------------------------- 3. refusals
    bad = core.memory_set("Tk9UQUJMT0I=", 0.0)
    print(f"\n== a wrong blob is refused: ok={bad['ok']} err={bad.get('err')!r}")
    core.post({"reset": True})
    core.post({"memory": "clear"})
    core.step()
    rc = core.memory_set(compact_blob, 60.0)
    rf = core.memory_set(blob, 60.0)
    print(f"== compact vs full after the same 60 s off: {rc['mean_efficacy']:.9f} vs {rf['mean_efficacy']:.9f} "
          f"(diff {abs(rc['mean_efficacy'] - rf['mean_efficacy']):.9f})")

    print(f"\nround trip {'PASS' if ok_rt else 'FAIL'} | transfer {'PASS' if ok_tr else 'FAIL'} "
          f"| refusal {'PASS' if not bad['ok'] else 'FAIL'}   ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
