"""`--kernel metal`: every fly's 0.1 ms ticks run on the Apple GPU, all flies in one dispatch.

The fly's state fields that the kernel touches (v, g, refractory, drive, queue, active, ...)
are numpy views on Metal shared buffers (unified memory, no copies): `reset()` and the
package's Python code keep working on them unchanged. `advance` keeps memory_advance's
signature; calls from the fly threads meet in a rendezvous and run as ONE command buffer
(up to `timeout_ms` wait for the other flies), see metal_engine.mm / brain.metal.
"""

import copy
import ctypes as C
import hashlib
import json
import os
import subprocess
import threading
import time
import types
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "metal_engine.mm"
SHADER = HERE / "brain.metal"
BUILD = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser() / "engine_build"
LIBRARY = BUILD / "libmetal_engine.dylib"
FLAGS = ["-O3", "-std=c++17", "-shared", "-fPIC", "-fobjc-arc", "-framework", "Metal", "-framework", "Foundation"]
MAXT = 1024
PROF_KINDS = ("begin", "phase1", "records", "targets", "sort", "end", "empty_launch")  # MTL_PROF=1 split
# field name, dtype, per-fly shape ("n" = neurons, "q" = queue [slots, n], "s" = slots, "1")
FIELDS = [
    ("v", np.float32, "n"), ("g", np.float32, "n"), ("refractory", np.int16, "n"),
    ("drive", np.float32, "n"), ("previous_drive", np.float32, "n"), ("queue", np.int32, "q"),
    ("queue_count", np.int32, "s"), ("counts", np.int32, "n"), ("active", np.int32, "n"),
    ("active_flag", np.uint8, "n"), ("nactive", np.int32, "1"), ("last", np.int64, "n"),
    ("modulation", np.float32, "n"), ("modulation_last", np.int64, "n"), ("adaptation", np.float32, "n"),
]


def build():
    sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    meta = LIBRARY.with_suffix(".json")
    if LIBRARY.exists() and meta.exists() and json.loads(meta.read_text()).get("source_sha256") == sha:
        return LIBRARY
    BUILD.mkdir(parents=True, exist_ok=True)
    tmp = LIBRARY.with_suffix(".partial.dylib")
    subprocess.run(["clang++", *FLAGS, str(SOURCE), "-o", str(tmp)], check=True)
    tmp.replace(LIBRARY)
    meta.write_text(json.dumps({"source_sha256": sha, "flags": FLAGS}))
    return LIBRARY


class _Req:
    __slots__ = ("fly", "args", "taken", "done", "error")

    def __init__(self, fly, args):
        self.fly, self.args, self.taken, self.error = fly, args, False, None
        self.done = threading.Event()


class MetalEngine:
    def __init__(self, proto, flies, timeout_ms=10.0):
        if not proto.weights_frozen:
            raise ValueError("metal kernel needs frozen weights (shared connectome)")
        self.proto, self.flies, self.timeout = proto, flies, timeout_ms / 1000
        lib = C.CDLL(str(build()))
        lib.mtl_create.restype = C.c_void_p
        lib.mtl_create.argtypes = [C.c_char_p, C.c_int, C.c_int64] + [C.c_void_p] * 6 +[C.c_int, C.c_int, C.c_char_p, C.c_int]
        lib.mtl_field.restype = C.c_void_p
        lib.mtl_field.argtypes = [C.c_void_p, C.c_int]
        lib.mtl_run.restype = C.c_int
        lib.mtl_run.argtypes = [C.c_void_p, C.c_int, C.c_void_p, C.c_void_p, C.c_void_p, C.c_float, C.c_float,
                                C.c_float, C.c_float, C.c_void_p, C.c_void_p, C.c_void_p]
        self.lib = lib
        n, slots = proto.n, proto.queue.shape[0]
        kc = np.ascontiguousarray(proto.circuit["kc_mask"], dtype=np.uint8)
        # a neuron fires at most once per rfc(22)+1 ticks -> KC spikes per call are bounded
        kcap = int(kc.sum()) * (MAXT // 22 + 2) + 16
        err = C.create_string_buffer(4096)
        self._keep = [proto.ptr, proto.post, proto.weight, proto.modulation_mask, kc, proto.rest]
        self.h = lib.mtl_create(str(SHADER).encode(), n, len(proto.post), proto.ptr.ctypes.data, proto.post.ctypes.data,
                                proto.weight.ctypes.data, proto.modulation_mask.ctypes.data, kc.ctypes.data,
                                proto.rest.ctypes.data, flies, kcap, err, len(err))
        if not self.h:
            raise RuntimeError("Metal engine: " + err.value.decode(errors="replace"))
        self.weight_addr = proto.weight.ctypes.data
        self.views = [{} for _ in range(flies)]
        for fid, (name, dt, kind) in enumerate(FIELDS):
            shape = {"n": (n,), "q": (slots, n), "s": (slots,), "1": (1,)}[kind]
            per = int(np.prod(shape))
            base = lib.mtl_field(self.h, fid)
            raw = np.ctypeslib.as_array((C.c_uint8 * (per * np.dtype(dt).itemsize * flies)).from_address(base))
            whole = raw.view(dt)
            for f in range(flies):
                self.views[f][name] = whole[f * per:(f + 1) * per].reshape(shape)
        self.v_addr = {self.views[f]["v"].ctypes.data: f for f in range(flies)}
        self.cv = threading.Condition()
        self.pending = {}
        self.running = False
        self.stats = {"calls": 0, "flies": 0, "gpu_ms": 0.0, "wall_ms": 0.0}

    def close(self):
        if self.h:
            self.lib.mtl_free.argtypes = [C.c_void_p]
            self.lib.mtl_free(C.c_void_p(self.h))
            self.h = None

    # -- per-fly state -------------------------------------------------------------------
    def make_fly(self, f, reset_fn):
        proto = self.proto
        fly = copy.copy(proto)
        for k in proto.fields:
            if k in self.views[f]:
                arr = self.views[f][k]
                arr[...] = proto.initial[k]
            else:
                arr = proto.initial[k].copy()
            setattr(fly, k, arr)
        fly.cursor, fly.sim_ms, fly.total_spikes = 0, 0.0, 0
        fly.weights_frozen = True
        fly.advance = lambda *a, _f=f: self.advance(_f, a)
        fly.reset = types.MethodType(reset_fn, fly)
        return fly

    # -- memory_advance signature -> batched GPU run -------------------------------------
    def advance(self, f, a):
        if self.v_addr.get(a[4]) != f or a[3] != self.weight_addr:
            raise ValueError("metal kernel: state arrays are not this fly's GPU buffers")
        if a[31]:
            raise ValueError("metal kernel: learning (weight writes) is not supported")
        req = _Req(f, a)
        deadline = time.perf_counter() + self.timeout
        batch = None
        with self.cv:
            self.pending[f] = req
            self.cv.notify_all()
            # ONE batch in flight: the shim's globals/call buffers are shared (2026-09-11 bug:
            # a timed-out second leader ran concurrently and corrupted the first batch)
            while not req.taken:
                left = deadline - time.perf_counter()
                if not self.running and (len(self.pending) >= self.flies or left <= 0):
                    batch = list(self.pending.values())
                    self.pending.clear()
                    for r in batch:
                        r.taken = True
                    self.running = True
                    break
                self.cv.wait(left if left > 0 else 0.05)
        if batch is not None:
            try:
                self._run(batch)
            except Exception as e:  # noqa: BLE001 - handed to every waiting fly
                for r in batch:
                    r.error = e
            finally:
                with self.cv:
                    self.running = False
                    self.cv.notify_all()
            for r in batch:
                r.done.set()
        req.done.wait()
        if req.error is not None:
            raise req.error

    def _run(self, batch):
        nb = len(batch)
        flies = np.array([r.fly for r in batch], np.int32)
        clocks = np.array([C.c_int64.from_address(r.args[11]).value for r in batch], np.int64)
        steps = np.array([r.args[12] for r in batch], np.int32)
        elig = (C.c_void_p * nb)(*[r.args[21] for r in batch])
        elast = (C.c_void_p * nb)(*[r.args[22] for r in batch])
        a = batch[0].args
        timing = np.zeros(12, np.float64)
        rc = self.lib.mtl_run(self.h, nb, flies.ctypes.data, clocks.ctypes.data, steps.ctypes.data, a[13], a[37], a[38],
                              a[29], C.cast(elig, C.c_void_p), C.cast(elast, C.c_void_p), timing.ctypes.data)
        if rc != 0:
            raise RuntimeError(f"mtl_run failed ({rc})")
        for r, c in zip(batch, clocks):
            C.c_int64.from_address(r.args[11]).value = int(c)
        s = self.stats
        s["calls"] += 1
        s["flies"] += nb
        s["gpu_ms"] += timing[0]
        s["wall_ms"] += timing[1]
        for k, v in zip(PROF_KINDS, timing[3:10]):
            s[k] = s.get(k, 0.0) + v
