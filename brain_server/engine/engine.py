"""Several flies in ONE process with ONE shared copy of the MaleCNS connectome.

Each fly is a shallow clone of one `VisualMemoryBrain` (the package's own class): the
read-only connectome and model constants (ptr/post/weight, rest, masks, circuit, retina
geometry, tonic, baseline_plastic, initial state) are shared by reference, every mutable
field listed in `brain.fields` (v, g, refractory, drive, queue, active, ... memory_w) is a
private copy. The package's Python path (`rgb_step` -> `step` -> `_neural_step` -> native
kernel -> `rule.advance`) runs unchanged per fly, so sensory mapping is exactly the package's.

Kernels (`kernel=`):
  orig : the package's own compiled memory_advance (bit-identical by construction)
  fast : engine/kernel_batch.cpp fast_advance (same arithmetic, packed state + prefetch)
  metal: engine/metal (Apple GPU, all flies in one dispatch; same spikes, see metal/RESULTS.md)

ctypes CDLL calls release the GIL, so fly threads integrate in parallel.
Weights must stay frozen: the connectome is shared, a learning fly would write it.
"""

import copy
import ctypes as C
import hashlib
import json
import os
import subprocess
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "kernel_batch.cpp"
BUILD = RUNTIME / "engine_build"
LIBRARY = BUILD / "libengine.dylib"
# Same flags as the package's build() so the float code generation matches.
FLAGS = ["-O3", "-std=c++17", "-shared", "-fPIC"]
KERNELS = ("orig", "fast")


def build():
    sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    meta = LIBRARY.with_suffix(".json")
    if LIBRARY.exists() and meta.exists() and json.loads(meta.read_text()).get("source_sha256") == sha:
        return LIBRARY
    BUILD.mkdir(parents=True, exist_ok=True)
    tmp = LIBRARY.with_suffix(".partial.dylib")
    subprocess.run(["c++", *FLAGS, str(SOURCE), "-o", str(tmp)], check=True)
    tmp.replace(LIBRARY)
    meta.write_text(json.dumps({"source_sha256": sha, "flags": FLAGS}))
    return LIBRARY


def kernel_function(proto, kernel):
    """A callable with memory_advance's exact signature.
    `parR` (e.g. par2) = one fly on R threads (par_advance), sharing one pre-split CSR."""
    if kernel == "orig":
        return proto.advance
    lib = C.CDLL(str(build()))
    if kernel.startswith("par"):
        threads = int(kernel[3:] or 2)
        cache = proto.__dict__.setdefault("_engine_partitions", {})
        if threads not in cache:
            lib.part_build.restype = C.c_void_p
            lib.part_build.argtypes = [C.c_int, C.c_void_p, C.c_void_p, C.c_void_p, C.c_int, C.c_int]
            handle = lib.part_build(
                proto.n, proto.ptr.ctypes.data, proto.post.ctypes.data, proto.weight.ctypes.data, threads, 64
            )
            if not handle:
                raise ValueError("part_build failed")
            cache[threads] = handle
        fn = lib.par_advance
        fn.argtypes = list(proto.advance.argtypes) + [C.c_void_p]
        fn.restype = None
        handle = cache[threads]
        return lambda *args: fn(*args, handle)
    if kernel not in KERNELS:
        raise ValueError(f"kernel must be one of {KERNELS} or parN")
    fn = getattr(lib, f"{kernel}_advance")
    fn.argtypes = proto.advance.argtypes
    fn.restype = None
    return fn


def _reset_fly(self, keep_memory=False):
    """MemoryBrain.reset for a clone: restores this fly's own fields only. The package
    version also rewrites weight[plastic] = baseline_plastic, which is a no-op while
    weights are frozen (checked in FlyBatch) and must not touch the shared array."""
    if keep_memory:
        saved = (self.memory_u.copy(), self.memory_w.copy())
    for k, v in self.initial.items():
        getattr(self, k)[:] = v
    self.cursor = 0
    self.sim_ms = 0.0
    self.total_spikes = 0
    if keep_memory:
        self.memory_u[:], self.memory_w[:] = saved


def make_fly(proto, fn):
    fly = copy.copy(proto)  # shares every array by reference ...
    for k in proto.fields:  # ... then gets private mutable state, at the initial values
        setattr(fly, k, proto.initial[k].copy())
    fly.cursor = 0
    fly.sim_ms = 0.0
    fly.total_spikes = 0
    fly.weights_frozen = True
    fly.advance = fn
    fly.reset = types.MethodType(_reset_fly, fly)
    return fly


class FlyBatch:
    def __init__(self, flies, kernel="fast", proto=None):
        if proto is None:
            from flywirehead.neural.visual import VisualMemoryBrain

            proto = VisualMemoryBrain()
        proto.weights_frozen = True
        if not np.array_equal(proto.weight[proto.circuit["edges"]], proto.baseline_plastic):
            raise ValueError("Plastic weights differ from baseline; shared connectome needs frozen baseline")
        self.proto = proto
        self.kernel = kernel
        self.metal = None
        if kernel == "metal":  # GPU, all flies per dispatch (engine/metal/RESULTS.md)
            from .metal.metal_engine import MetalEngine

            self.metal = MetalEngine(proto, flies)
            self.brains = [self.metal.make_fly(f, _reset_fly) for f in range(flies)]
        else:
            fn = kernel_function(proto, kernel)
            self.brains = [make_fly(proto, fn) for _ in range(flies)]
        self.pool = ThreadPoolExecutor(max_workers=max(1, flies), thread_name_prefix="fly")

    def map(self, fn, *per_fly):
        """Run fn(brain, *args) for every fly in parallel; returns results in fly order."""
        return list(self.pool.map(fn, self.brains, *per_fly))

    def rgb_step(self, frames, ms, stims):
        """One rgb_step per fly (the worker's call), all flies in parallel."""
        return self.map(
            lambda b, f, s: b.rgb_step(f, ms, learning=False, stimulation=s or None)[0], frames, stims
        )

    def close(self):
        self.pool.shutdown(wait=True)
        if self.metal is not None:  # frees the GPU buffers: the flies' state views die with it
            self.metal.close()
