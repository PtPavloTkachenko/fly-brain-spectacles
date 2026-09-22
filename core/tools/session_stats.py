"""Three conditioning sessions x 4 bouts, plus a frozen control, on the native core (ADR 62/63).

Reads MBON07 / MBON11 -- the memory's OUTPUT -- to the CS+ and to the unpaired CS-, before and
after training. Each session uses a different pair of odour glomeruli as CS+/CS-, so "3 sessions"
is three different cue pairs, not three identical replays of a deterministic model.

    python3 core/tools/session_stats.py [<brain.flyb> [<lib.dylib> [<kc_inh_gain>]]]
        ~6 min. Needs a brain with read:MBON07; the gain needs one with kc_inh_edges (ADR 67).
"""
import ctypes as C, json, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRAIN = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "core/brain_export/out/brain_c0.flyb"
LIB = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "core/build/libflybrain_host.dylib"
KC_INH = float(sys.argv[3]) if len(sys.argv) > 3 else None  # ADR 67: the APL->KC gain, None = the file

lib = C.CDLL(str(LIB))
lib.fb_create.restype = C.c_void_p
lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
lib.fb_last_error.restype = C.c_char_p
lib.fb_warmup.restype = C.c_char_p; lib.fb_warmup.argtypes = [C.c_void_p]
lib.fb_step.restype = C.c_char_p; lib.fb_step.argtypes = [C.c_void_p]
lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
lib.fb_destroy.argtypes = [C.c_void_p]
lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]

DATA = BRAIN.read_bytes()
GAIN, LEVEL = 0.8, 0.9
BOUTS, PULSES = 4, 16


def cue(glom):
    """what the lens sends while a cue is on: the generic smell, its own glomerulus, and (on the
    cue the fly is sitting on) sweet contact"""
    return {"odor": {"L": LEVEL, "R": LEVEL}, glom: {"L": LEVEL * GAIN, "R": LEVEL * GAIN},
            "object": {"L": 0.8, "R": 0.8}, "sweet": 1.0}


AIR = {"odor": {"L": 0.0, "R": 0.0}}


class Run:
    def __init__(self, learning):
        self.b = lib.fb_create(DATA, len(DATA), 50.0, 0)
        if not self.b:
            sys.exit("create failed: " + lib.fb_last_error().decode())
        lib.fb_set_threads(self.b, 4)
        lib.fb_warmup(self.b)
        if KC_INH is not None:
            lib.fb_post(self.b, json.dumps({"kc_inh_gain": KC_INH}).encode())
        lib.fb_post(self.b, json.dumps({"learning": bool(learning)}).encode())

    def post(self, o):
        lib.fb_post(self.b, json.dumps(o, separators=(",", ":")).encode())

    def step(self):
        return json.loads(lib.fb_step(self.b))

    def present(self, glom, pulses=0, steps=4):
        """hold the cue for `steps` brain steps, firing `pulses` US pulses inside it"""
        m = None
        m7 = m11 = kcv = 0.0
        n = 0
        left = pulses
        for i in range(steps):
            self.post({"senses": cue(glom)})
            if left > 0:
                for _ in range(min(4, left)):
                    self.post({"pulse": "reward"})
                left -= min(4, left)
            m = self.step()
            m7 += m["hz"].get("MBON07", 0.0)
            m11 += m["hz"].get("MBON11", 0.0)
            kcv += m["regions"]["mushroom"]
            n += 1
        mem = m.get("memory", {})
        return {"mbon07": m7 / n, "mbon11": m11 / n, "kc": kcv / n, "pam": m["hz"].get("reward", 0),
                "eff": mem.get("mean_efficacy", 1.0), "chg": mem.get("changed", 0),
                "eff_on": mem.get("eff_on", float("nan")), "n_on": mem.get("n_on", 0),
                "learning": mem.get("learning", False)}

    def air(self, steps=3):
        for _ in range(steps):
            self.post({"senses": AIR})
            self.step()

    def close(self):
        lib.fb_destroy(self.b)


def session(name, plus, minus, learning):
    t0 = time.time()
    r = Run(learning)
    pre_p = r.present(plus); r.air()
    pre_m = r.present(minus); r.air()
    rows = []
    for n in range(BOUTS):
        bp = r.present(plus, pulses=PULSES, steps=6); r.air()
        bm = r.present(minus); r.air()
        rows.append((n + 1, bp, bm))
    post_p = r.present(plus); r.air()
    post_m = r.present(minus)
    r.close()
    print(f"\n=== {name}  CS+={plus}  CS-={minus}  learning={learning}  ({time.time()-t0:.0f}s) ===")
    print(f"{'':10s} {'effOn CS+':>10s} {'effOn CS-':>10s} {'nOn +/-':>12s} {'MBON07 CS+':>11s} {'MBON07 CS-':>11s} "
          f"{'KC CS+':>8s} {'eff':>9s} {'changed':>8s}")
    def line(tag, p, m):
        print(f"{tag:10s} {p['eff_on']:10.5f} {m['eff_on']:10.5f} {str(p['n_on']) + '/' + str(m['n_on']):>12s} "
              f"{p['mbon07']:11.2f} {m['mbon07']:11.2f} {p['kc']:8.2f} {p['eff']:9.4f} {p['chg']:8d}")
    line("before", pre_p, pre_m)
    for n, bp, bm in rows:
        line(f"bout {n}", bp, bm)
    line("after", post_p, post_m)
    d = {"name": name, "plus": plus, "minus": minus, "learning": learning,
         "d_mbon07_plus": post_p["mbon07"] - pre_p["mbon07"], "d_mbon07_minus": post_m["mbon07"] - pre_m["mbon07"],
         "d_mbon11_plus": post_p["mbon11"] - pre_p["mbon11"], "d_mbon11_minus": post_m["mbon11"] - pre_m["mbon11"],
         "effOn_plus": post_p["eff_on"], "effOn_minus": post_m["eff_on"],
         "d_effOn": post_p["eff_on"] - post_m["eff_on"],
         "eff": post_p["eff"], "chg": post_p["chg"], "pam_bout": rows[0][1]["pam"]}
    print(f"  effOn after: CS+ {d['effOn_plus']:.5f}  CS- {d['effOn_minus']:.5f}  DIFFERENCE {d['d_effOn']:+.5f}")
    print(f"  dMBON07  CS+ {d['d_mbon07_plus']:+.2f}  CS- {d['d_mbon07_minus']:+.2f}   "
          f"dMBON11  CS+ {d['d_mbon11_plus']:+.2f}  CS- {d['d_mbon11_minus']:+.2f}   "
          f"eff {post_p['eff']:.4f}  chg {post_p['chg']}  PAM11 in bout {d['pam_bout']:.0f} Hz")
    return d


out = []
out.append(session("S1 learning", "odor_va2", "odor_dm4", True))
out.append(session("S2 learning", "odor_dm2", "odor_dm1", True))
out.append(session("S3 learning", "odor_dm1", "odor_va2", True))
out.append(session("C1 FROZEN  ", "odor_va2", "odor_dm4", False))
print("\n" + json.dumps(out, indent=1))
