# GPU brain kernel (Apple Metal, M1 Max) — 2026-09-11

**Verdict: pays off, and it is exact.** Same spikes and same state as the CPU `fast` kernel (which is byte-identical to the package kernel). The only difference: tiny `g` values that are denormal on the CPU become 0 on the GPU. 1 fly now runs faster than real time.

## Numbers (ms wall per 50 ms neural step, per fly)
`engine/bench.py --flies 1,3,5 --configs thread:fast,thread:metal --settle 300 --steps 6`, all rows back-to-back, `nice -n 15`, while the live 3-fly server was running (load avg 7.6–8.7) and the user was testing in Lens Studio (the GPU was also 0–44 % busy with WindowServer/LS).

| flies | fast | metal | speed-up | metal RTF |
|---|---|---|---|---|
| 1 | 238 | **41** | 5.8× | **1.21** |
| 3 | 151 | **73** | 2.1× | 0.69 |
| 5 | 185 | **123** | 1.5× | 0.41 |

`fast` is noisy under contention (it measured 325/354 ms at 3/5 flies earlier the same day, `../RESULTS.md`), so the multi-fly speed-up is 2–4× depending on the load. GPU time per 10 ms chunk (all flies together): 1 fly 7–8.7 ms, 3 flies 11.4–12.2 ms, 5 flies 16.7 ms. At 5 flies the wall per chunk is 24 ms: the other ~7 ms go to the package's Python `rgb_step` (~0.8 ms per fly, serialized by the GIL).

## Why this design (profile first)
- **CPU** (`profile_cpu.py`, 1 fly at rest): one 0.1 ms tick = ~32k active-neuron updates + ~24k synaptic deliveries (+1.6k modulatory), 125 spikes, 17k targets touched. Time goes 43 % to updates and 56 % to deliveries. Both are random memory access (~10 and ~18 ns each).
- **Dense SpMV (MLX/PyTorch MPS)**: rejected without building it. A dense product touches all 25.6M edges (~205 MB) every tick, versus ~24k edges: 1000× the traffic, ≥0.5 ms per tick at 400 GB/s ≈ 5× slower than real time per fly before any other work. Neither MLX nor torch is installed.
- **Atomic float adds**: rejected. 47 % of deliveries land on a target that gets ≥2 inputs in the same tick, so the summation order matters. Measured with `revq_advance` (the CPU kernel with only the delivery order reversed): the stimulated fly's spikes diverge after 170 ms. At 1.5 s only 91.7 % of per-neuron counts are identical, the max |diff| is 33 spikes, and appetite reads 26 vs 16 Hz. That fly would not be the same fly.
- **Metal**: ~3 µs per dependent dispatch, ~0.2 ms per command buffer (measured). So one command buffer covers a whole 10 ms chunk (100 ticks × 2 dispatches) for all flies.

## How it stays exact (mechanism)
1. **The CPU's only cross-neuron order is the active list.** Append order → spike queue order → the order of the `g += w` additions into a target. On the GPU every active entry carries a key (epoch, sequence) that reproduces this order: carried over = position; drive change = neuron index; woken at tick t = the global delivery number of the waking delivery. Spikes are rank-sorted by key, so the queue is the CPU's queue.
2. **Deliveries**: record r = the CPU's delivery number, linked into its target's list. One thread per target sorts its records by r (in scratch memory when there are several) and adds them in that order. Modulatory (PPL101-type) deliveries go through the same lists into the `modulation` trace.
3. **Arithmetic**: clang compiles `evolve()` to 3 FMAs (fp-contract=on). The shader writes the same FMAs explicitly and forbids any other fusion (`#pragma METAL fp contract(off)`, mathMode Safe). Division is correctly rounded: checked for all 2³² inputs for ÷3 and ÷180. Exp tables come from the CPU, built with the kernel's own expressions.
4. **Eligibility** (float64, unused while learning is off): the GPU logs KC spikes and the CPU replays them with the kernel's own expression.
5. **State = GPU memory**: the fly's fields (`v`, `g`, `queue`, `active`, …) are numpy views on Metal shared buffers, so there are no copies, and `reset()` and the package's Python keep working on them unchanged.

## Tolerance test (`test_metal.py`)
The reference is CPU `fast`: the 3 flies of `../test_equality.py` (rest / light+odour+loom / sugar+reward+touch), compared per 10 ms chunk and per state field, for 1 fly alone and 3 flies in one batch.

| run | per-neuron counts | readouts (DNa02 L/R, esc, stop, feed, power MNs, regions) | state |
|---|---|---|---|
| 300 ms, 1 and 3 flies | identical (exact fraction 1.00000, corr 1.0, max diff 0) | identical | byte-identical |
| 1.5 s, 1 and 3 flies (1.3–1.9 M spikes per fly) | identical | identical | identical except `g`: 194–1,227 of 166,700 values are denormal on the CPU, 0 on the GPU |
| reversed-order CPU (baseline) | stimulated fly: 0.917 exact, max diff 33 | appetite 26 vs 16 Hz, DNa02_L 13 vs 0 Hz at 300 ms | diverged |

The criterion is exact: every chunk identical and all state equal after flushing denormals. The denormals are absorbed in every expression (v ≈ −52 mV; weights ≥ 0.275), so they cannot change a spike. `../test_contract.py --kernel metal`: batch_worker on the GPU sends the same ready/brain messages as worker.py processes.

## GPU time per tick (`prof_gpu.py`, MTL_PROF=1, 1 fly)
Phase 1 (active neurons) 19 µs ‖ records 19 µs → per-target ordered delivery 42 µs ‖ spike sort + prefix 25 µs. Launch floor ≈ 5 µs per dispatch (‖ = same dispatch). All of it is latency-bound, so extra flies cost less than linearly.

## Run
```
cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead"
uv run --with websockets --with zeroconf python "<repo>/brain_server/server.py" --flies 3 --engine batch --kernel metal
uv run python "<repo>/brain_server/engine/metal/test_metal.py" --ms 1500 --chaos   # after ANY change (engine, Xcode, macOS)
uv run python "<repo>/brain_server/engine/test_contract.py" --kernel metal
uv run python "<repo>/brain_server/engine/bench.py" --flies 1,3,5 --configs thread:fast,thread:metal
uv run python "<repo>/brain_server/engine/metal/prof_gpu.py" --flies 1,3            # GPU split per role
```
Files: `brain.metal` (kernels, compiled at run time, no Metal toolchain needed), `metal_engine.mm` (host; built to `$CYBERFLY_RUNTIME/engine_build/libmetal_engine.dylib` on first use), `metal_engine.py` (views + rendezvous), `test_metal.py`, `prof_gpu.py`, `profile_cpu.{cpp,py}`. Hooked in via `engine.py` (`kernel == "metal"`) and `server.py --kernel metal`, off by default. Only thread mode is supported (no `process:metal` in bench.py).

## Risks
- **One GPU batch for all flies.** A GPU error fails every fly thread at once, as with the batch engine's native crash risk. Flies wait up to 10 ms for each other; a stalled fly makes the rest run without it (still correct, just slower).
- **Only one batch may be in flight.** A timed-out second leader once ran concurrently and corrupted the 1.5 s test. It is fixed (flag + mutex) and covered by `test_metal.py --ms 1500`.
- **Shared GPU.** WindowServer / Lens Studio preview load inflates the step time. Memory: ~250 MB of GPU buffers per fly plus the 205 MB connectome (5 flies ≈ 1.5 GB).
- **Frozen weights only** (learning raises); needs macOS 15 (MSL 3.2).
- **Exactness depends on clang's FMA pattern for `evolve()` and on the CPU reference kernels.** A compiler change would show up as NOT EXACT in `test_metal.py`, never silently.
- **Next levers**, if needed: the per-target pass (neuron renumbering for cache locality), moving the spike sort off the critical path, and the GIL-serialized Python at 5 flies.
