# The Metal brain kernel

`brain_server/engine/metal/` runs every fly's MaleCNS brain on the Apple GPU. Like the rest of CyberFly, it was vibe coded with Claude Code: we set the goal (same spikes, faster), and the agent profiled, built, tested and measured until the tests below passed. It is **bit-exact**: the same spikes and the same state as the CPU kernel it replaces, so a fly on the GPU is the same fly. On an M1 Max it is 2 to 6 times faster than our best CPU kernel, and one fly runs faster than real time.

## Why the brain was slow

One 0.1 ms tick of the LIF model is about 32,000 active-neuron updates plus 24,000 synaptic deliveries. Both are random memory access into a 166,700-neuron graph with 25.6 M edges. Profiled on one fly at rest: 43 % of the time in updates, 56 % in deliveries, at ~10 and ~18 ns each. The CPU spends its time waiting for memory, not computing.

We tried the obvious CPU fixes first and measured each (`brain_server/engine/RESULTS.md`):

| idea | result |
|---|---|
| one process, one shared connectome, a thread per fly | **1.0x**, the connectome copies were never the bottleneck |
| walk each spiking neuron's edges once for all flies | dropped, only 0.3–0.7 % of spikes coincide across flies |
| **`fast`**: pack each neuron's hot state into one 32-byte cell | **2.0x at 3 flies, 2.2x at 5**, bit-identical |
| `parN`: split one fly over N threads with ordering keys | 2.8x for one fly, but only with free cores |

`fast` fixed the cache misses, but the memory bus was still the ceiling.

## Why the GPU wins on Apple Silicon

Apple Silicon has unified memory: the GPU reads the same RAM as the CPU with no copy over a bus. That turns the brain's problem around. The fly's state arrays (`v`, `g`, `queue`, `active`, ...) are numpy views on Metal shared buffers, so Python, the server and the package's own code keep using them unchanged, and the GPU works on them in place.

What the GPU buys is parallel random access. Thousands of neuron updates and deliveries per tick run at once instead of one after another. Dispatch overhead is small (~3 µs per dependent dispatch, ~0.2 ms per command buffer), so one command buffer covers a whole 10 ms chunk (100 ticks x 2 dispatches) for all flies together. GPU time per tick for one fly: active neurons 19 µs, delivery records 19 µs, ordered delivery 42 µs, spike sort 25 µs. All of it is latency-bound, so extra flies cost less than linearly.

We rejected two popular alternatives before building anything:

- **Dense sparse-matrix products (MLX, PyTorch MPS).** A dense product touches all 25.6 M edges (~205 MB) every tick instead of ~24,000. That is 1000x the memory traffic, at least 5x slower than real time per fly before any other work.
- **Atomic float additions** (the usual GPU scatter). 47 % of deliveries land on a neuron that receives two or more inputs in the same tick, so the order of the additions changes the float result. Reversing only the delivery order on the CPU made a stimulated fly's spikes diverge after 170 ms; at 1.5 s its appetite read 26 Hz instead of 16. That would be a different fly.

## How it stays exact

1. **Order of the active list.** On the CPU, the only cross-neuron order is the active list: append order becomes spike-queue order becomes the order of `g += w` into each target. On the GPU every active entry carries a key (epoch, sequence) that reproduces that order, and spikes are rank-sorted by it.
2. **Ordered deliveries.** Each delivery record carries the CPU's delivery number and is linked into its target's list. One thread per target sorts its records by that number and adds them in that order. Modulatory deliveries use the same lists.
3. **Same arithmetic.** clang compiles `evolve()` to three fused multiply-adds. The shader writes the same three explicitly and forbids any other fusion (`#pragma METAL fp contract(off)`, math mode Safe). Division is correctly rounded, checked for all 2^32 inputs of the constants used. Exponential tables are built on the CPU with the kernel's own expressions.
4. **State is GPU memory.** No copies in either direction; `reset()` works unchanged.

The only difference: Apple GPUs flush float denormals to zero. 194 to 1,227 of the 166,700 `g` values are denormal on the CPU after 1.5 s and zero on the GPU. They are absorbed in every expression (v is around −52 mV, weights are at least 0.275), so they cannot change a spike.

## Tests

- `engine/metal/test_metal.py --ms 1500 --chaos`: three differently stimulated flies (rest; light + odour + loom; sugar + reward + touch), compared with CPU `fast` per 10 ms chunk and per state field, alone and batched. Result: identical spike counts, identical readouts, identical state except the denormals. Run it after any change to the engine, Xcode or macOS; a compiler change shows up as NOT EXACT, never silently.
- `engine/test_equality.py`: `fast` and `parN` against the package kernel, byte-identical at 300 ms and 1.5 s (1.3–1.9 M spikes per fly).
- `engine/test_contract.py --kernel metal`: the batched GPU worker sends the same messages as the per-process workers.

## Numbers

`engine/bench.py --flies 1,3,5 --configs thread:fast,thread:metal`, M1 Max, measured back to back while a live server and Lens Studio were running (so absolute numbers are better on an idle Mac):

| flies | CPU `fast` | Metal | speed-up | real-time factor |
|---|---|---|---|---|
| 1 | 238 ms | **41 ms** | 5.8x | **1.21** |
| 3 | 151 ms | **73 ms** | 2.1x | 0.69 |
| 5 | 185 ms | **123 ms** | 1.5x | 0.41 |

(ms of wall time per 50 ms of brain time, per fly.) Live with the lens running, two flies take about 70–80 ms per step.

What we tried that did not help, so you do not have to: a 25 ms brain step (per-call overhead doubles the GPU time per neural second), a barrier so fly threads share one dispatch (marginal), and 25–50 ms chunks (slower, and different spike counts).

## Run

```sh
cd "$CYBERFLY_RUNTIME/fly-wirehead"
uv run --with websockets --with zeroconf python <repo>/brain_server/server.py --flies 2 --engine batch --kernel metal
uv run python <repo>/brain_server/engine/metal/test_metal.py --ms 1500 --chaos
uv run python <repo>/brain_server/engine/bench.py --flies 1,3,5 --configs thread:fast,thread:metal
uv run python <repo>/brain_server/engine/metal/prof_gpu.py --flies 1,3
```

Files: `brain.metal` (kernels, compiled at run time, no Metal toolchain needed), `metal_engine.mm` (host, built on first use into `$CYBERFLY_RUNTIME/engine_build/`), `metal_engine.py` (buffer views and fly rendezvous), tests and profilers.

## Limits

- Frozen weights only: the connectome is shared by all flies, so plasticity experiments stay on `--engine process`.
- macOS 15+ (Metal Shading Language 3.2).
- One GPU batch for all flies: a GPU error stops every fly at once. A stalled fly lets the others continue without it.
- Memory: ~250 MB of GPU buffers per fly plus the 205 MB connectome.
- Full measurements: `brain_server/engine/metal/RESULTS.md` and `brain_server/engine/RESULTS.md`.
