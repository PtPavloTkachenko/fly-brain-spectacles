# Brain engine: several flies, one connectome (2026-09-11)

## Results (wall ms per 50 ms neural step, per fly)
Setup: `bench.py --flies 1,3,5 --settle 500 --steps 12`, all rows back-to-back while the live 3-worker server was running. Median wall time per step, per fly. Every fly is at REST_LIGHT (~58-62 k spikes per step). Speed-up is vs `process:orig` at the same B. RTF = neural ms / wall ms.

| B | engine:kernel | ms / 50 ms step | speed-up | RTF |
|---|---|---|---|---|
| 1 | process:orig (today) | 404 | 1.00 | 0.124 |
| 1 | thread:orig (Engine A) | 416 | 0.97 | 0.120 |
| 1 | thread:fast | 244 | 1.65 | 0.205 |
| 1 | thread:par2 | 174 | 2.32 | 0.287 |
| 1 | thread:par3 | 142 | **2.84** | 0.352 |
| 3 | process:orig (today) | 635 | 1.00 | 0.079 |
| 3 | thread:orig (Engine A) | 617 | 1.03 | 0.081 |
| 3 | thread:fast | 325 | **1.95** | 0.154 |
| 3 | thread:par2 | 324 | 1.96 | 0.154 |
| 3 | thread:par3 | 362 | 1.75 | 0.138 |
| 5 | process:orig (today) | 783 | 1.00 | 0.064 |
| 5 | thread:orig (Engine A) | 719 | 1.09 | 0.070 |
| 5 | thread:fast | 354 | **2.21** | 0.141 |
| 5 | thread:par2 | 529 | 1.48 | 0.094 |
| 5 | thread:par3 | 533 | 1.47 | 0.094 |

Recommendation: `--engine batch --kernel fast` for 3-5 flies. Use `par2`/`par3` only when flies x N fit in free cores (for example 1-2 flies). An earlier run with dimmer flies (~47 k spikes) gave the same picture: fast 2.0x at B=3 and 2.3x at B=5, Engine A 1.0x.

GPU follow-up (same day): `--kernel metal` gives the same spikes, 1 fly 41 ms / 3 flies 73 ms / 5 flies 123 ms per step. See `metal/RESULTS.md`.

## What changed and what did not
- **Semantics identical.** dt, thresholds, delays, weights, edges, neurons and the float expressions are unchanged. Kernels are built with the package's own flags (`c++ -O3 -std=c++17`) into `$CYBERFLY_RUNTIME/engine_build/`.
- **Engine A (`thread:orig`).** One process, one shared connectome, one thread per fly, running the package's own kernel. ctypes CDLL calls release the GIL. Gain vs processes: about 0. The connectome copy was not the bottleneck.
- **`fast`.** The same kernel, but each neuron's hot state (last, v, g, adaptation, rest, drive, refractory, flag) is packed into one 32-byte cell per call, so a delivery touches one cache line instead of ~8, plus prefetch. This is where the gain comes from.
- **Engine B, as specified (walk each spiker's edges once for all flies): dropped.** Measured on 3 decorrelated flies over 1000 ticks, same-tick coincidence is only 0.3-0.7%, so the saving is 0.4% of edge walks.
- **`parN`.** Neuron-range split instead: each fly runs on N threads, and each thread owns 64-neuron blocks and a pre-split copy of the CSR (+307 MB, shared). Sort keys (awakening tick, delivery sequence) reproduce the original active-list and queue order, so every neuron sees the same float summation order.

## Equality test (`test_equality.py`)
The reference is a fresh `VisualMemoryBrain`, the package kernel and the worker's `rgb_step` per 10 ms chunk. It is compared against 1 fly, and against 3 flies with different stimulation (rest / asymmetric light + odour + loom / sugar + reward pulse + touch) running concurrently.
- orig, ref, fast: per-neuron spike counts of every chunk and every state array are **byte-identical** at 300 ms and at 1.5 s (1.3-1.9 M spikes per fly).
- par2, par3: identical as well, including `queue` and `nactive`. The only exception is the dead tail of `active` past `nactive`, which the kernel never reads.
- `test_contract.py`: batch_worker with 2 flies produces the same ready/brain messages as two worker.py processes (act, hz, regions, cloud bits), except `wall_ms`.

## Run
```
cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run --with websockets --with zeroconf \
    python "<repo>/brain_server/server.py" --flies 5 --engine batch --kernel fast
uv run python "<repo>/brain_server/engine/test_equality.py"   # after any compiler/package update
uv run python "<repo>/brain_server/engine/bench.py" --flies 1,3,5
```

## Risks
- **One process for all flies.** A native crash kills every fly. Pre-existing: the server never gets EOF (it keeps the child's pipe ends), so `dead` isn't sent in either mode.
- **Weights must stay frozen.** The connectome is shared, so a learning fly would write it for all flies, and `parN` copies the weights at start. Plasticity experiments stay on `--engine process`.
- **`parN` needs free cores** (flies x N <= ~8 P-cores). It runs a barrier every 0.1 ms tick, so oversubscription (for example next to another server) makes it slower than `fast`.
- **Measurement noise.** All numbers were measured while the live 3-worker server was running (6-8 busy cores), baseline and new back-to-back under the same conditions. Absolute numbers will be better on an idle Mac.
- Bit-exactness depends on the compiler emitting the same float ops (no fast-math). Re-run `test_equality.py` after an Xcode or package update.
