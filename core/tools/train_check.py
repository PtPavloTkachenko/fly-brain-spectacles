"""Drive FlyBrainCore through exactly the sequence FlyTrainer emits, with no lens and no server (ADR 62).

    python3 core/tools/train_check.py     # ~80 s: one learning session, one frozen control


Proves the three links the preview cannot show while the socket rejects `learning`:
  1. `{"learning":true}` is acked in `memory.learning`
  2. the CS (odour+object, held) plus the US train (`{"pulse":"reward"}` x16) moves `mean_efficacy`
  3. the same session with learning OFF moves nothing (fly-wirehead's `--frozen` control)
"""
import ctypes as C, json, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # the repo, wherever it is checked out
lib = C.CDLL(str(REPO / "core/build/libflybrain_host.dylib"))
lib.fb_create.restype = C.c_void_p
lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
lib.fb_last_error.restype = C.c_char_p
lib.fb_warmup.restype = C.c_char_p; lib.fb_warmup.argtypes = [C.c_void_p]
lib.fb_step.restype = C.c_char_p; lib.fb_step.argtypes = [C.c_void_p]
lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
lib.fb_destroy.argtypes = [C.c_void_p]

CS = {"odor": {"L": 0.9, "R": 0.9}, "object": {"L": 0.8, "R": 0.8}, "sweet": 1.0}
AIR = {"odor": {"L": 0.0, "R": 0.0}, "object": {"L": 0.0, "R": 0.0}}


def session(learning, bouts=2, pulses=16, tag=""):
    data = (REPO / "core/brain_export/out/brain_c0.flyb").read_bytes()
    b = lib.fb_create(data, len(data), 50.0, 0)
    if not b:
        print("create failed:", lib.fb_last_error().decode()); sys.exit(1)
    lib.fb_set_threads(b, 4)
    lib.fb_warmup(b)
    lib.fb_post(b, json.dumps({"learning": bool(learning)}).encode())
    rows = []

    def step():
        return json.loads(lib.fb_step(b))

    m = step()
    ack = m.get("memory", {})
    print(f"[{tag}] learning acked = {ack.get('learning')}  edges = {ack.get('edges')}  eff = {ack.get('mean_efficacy')}")
    # probe: the CS alone, no US (the before-training measurement)
    lib.fb_post(b, json.dumps({"senses": CS}).encode())
    for _ in range(4):
        m = step()
    pre = m["memory"]["mean_efficacy"], m["memory"]["changed"], m["regions"]["mushroom"], m["hz"]["reward"]
    print(f"[{tag}] probe (CS, no US): eff={pre[0]:.6f} chg={pre[1]} kc={pre[2]:.2f}Hz PAM11={pre[3]:.1f}Hz")
    # bouts: CS held, then the US train
    for n in range(bouts):
        lib.fb_post(b, json.dumps({"senses": CS}).encode())
        for _ in range(2):
            step()
        for _ in range(pulses):
            lib.fb_post(b, json.dumps({"senses": CS}).encode())
            lib.fb_post(b, b'{"pulse":"reward"}')
            m = step()
        mem = m["memory"]
        rows.append((n + 1, mem["mean_efficacy"], mem["changed"], m["hz"]["reward"]))
        print(f"[{tag}] bout {n+1}: eff={mem['mean_efficacy']:.6f} chg={mem['changed']}/{mem['edges']} PAM11={m['hz']['reward']:.1f}Hz")
        lib.fb_post(b, json.dumps({"senses": AIR}).encode())  # air
        for _ in range(4):
            m = step()
    lib.fb_destroy(b)
    return rows


t0 = time.time()
on = session(True, tag="learning ON")
off = session(False, tag="frozen   ")
print(f"\ndelta with learning: {on[-1][1] - 1.0:+.6f} ({on[-1][2]} edges moved)")
print(f"delta frozen:        {off[-1][1] - 1.0:+.6f} ({off[-1][2]} edges moved)")
print(f"wall {time.time() - t0:.0f}s")
