"""`server.py --engine native`: one fly per process on FlyBrainCore, the SAME C++ core the web page runs.

Same pipe contract as worker.run (ready / brain messages). The core owns the whole per-fly loop
(senses, retina, kernel, smoothing, habituation, decoder, cloud bits) and speaks the server's JSON,
so this process only forwards messages. Used to drive the Lens Studio preview through the exact
code path the page brain runs (core/).
"""

import ctypes as C
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIB = Path(os.environ.get("FLYBRAIN_LIB", REPO / "core/build/libflybrain_host.dylib"))


def load_lib():
    lib = C.CDLL(str(LIB))
    lib.fb_create.restype = C.c_void_p
    lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
    lib.fb_last_error.restype = C.c_char_p
    lib.fb_warmup.restype = C.c_char_p
    lib.fb_warmup.argtypes = [C.c_void_p]
    lib.fb_step.restype = C.c_char_p
    lib.fb_step.argtypes = [C.c_void_p]
    lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
    lib.fb_destroy.argtypes = [C.c_void_p]
    lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
    lib.fb_take.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
    lib.fb_take.restype = C.c_int
    return lib


def run(fly, inbox, outbox, flyb, step_ms, threads=2):
    lib = load_lib()
    data = Path(flyb).read_bytes()
    brain = lib.fb_create(data, len(data), float(step_ms), int(fly))
    if not brain:
        print(f"native fly {fly}: {lib.fb_last_error().decode()}", file=sys.stderr, flush=True)
        return
    del data
    if threads > 1:  # the exact partitioned kernel (bit-identical to one thread)
        lib.fb_set_threads(brain, int(threads))
    outbox.send(json.loads(lib.fb_warmup(brain)))
    # the core's side channel (ADR 62): memory blobs are queued, not published as the step message
    buf = C.create_string_buffer(1 << 20)

    def drain_queue():
        nonlocal buf
        while True:
            n = lib.fb_take(brain, buf, len(buf))
            if n <= 0:
                return
            if n > len(buf):
                buf = C.create_string_buffer(n + 4096)
                continue
            outbox.send(json.loads(buf.raw[:n]))

    try:
        while True:
            while inbox.poll():
                msg = inbox.recv()
                if msg.get("stop"):
                    return
                lib.fb_post(brain, json.dumps(msg, separators=(",", ":")).encode())
            step = json.loads(lib.fb_step(brain))
            drain_queue()
            outbox.send(step)
    finally:
        lib.fb_destroy(brain)
