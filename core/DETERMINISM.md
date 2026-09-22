# Determinism: why the CPU and the GPU kernels agree, bit for bit

The core runs the same brain on four kernels — the CPU serial kernel, the CPU partitioned kernel,
Vulkan compute (the Mac's GPU path), WebGPU (the page) — and `{"gpu_check":k}` runs `k` chunks on the CPU
and on the GPU from the same state and compares every cell, the active list, the delay queues and the
spike counts. This note says what makes that check pass, i.e. every place the two could have drifted
and what was done about it.

Written 16.09 after the check failed on a mobile GPU (and reproduced on the Mac under MoltenVK):

```
NATIVE_GPU_CHECK {"ok":false,"chunks":3,"cells_diff":85673,"active_same":false,"queue_same":false,
                  "spikes_cpu":103280,"spikes_gpu":103185}
```

## The short version

Two things made the old kernel's exactness a coincidence rather than a property:

1. **It asked the compiler for a specific rounding.** `evolve` was one long float expression, and the
   shader hard-coded the `fma` sequence clang was assumed to contract it into, plus a two-fma
   emulation of the two divisions. Nothing in the language guarantees either side.
2. **It asked the GPU to reproduce a float summation ORDER.** Synaptic current was a float `+=` per
   delivery, so the sum depended on the order deliveries were applied in; the GPU rebuilt that order
   with a per-target linked list of records, an insertion sort per target and an O(k²) fallback when
   the scratch filled.

Both are gone. `evolve` now uses nothing but `+`, `-` and `*`, which IEEE-754 and the Vulkan spec
both require to be correctly rounded everywhere, and the synaptic sum is an **integer**, so its order
cannot matter. The kernels now agree by construction.

**This was not only a mobile-GPU problem.** The old kernel fails its own check on the Mac (MoltenVK,
M1 Max) as soon as the run is long enough — measured below. Three chunks passed; ten did not.

## What was found, with file:line

| # | Where | What could drift | Fix |
|---|---|---|---|
| 1 | `src/flybrain.cpp` `evolve_cell` (was `kernel_serial` / `kernel_par`'s `evolve` lambda) | `c.v = c.rest + (c.v - c.rest) * a + current * (1.f - a) + c.g * (a - b) / 3.f;` — whether the two multiply-adds contract into `fma` is the compiler's choice (`-ffp-contract=on` is only a permission). `brain.comp` hard-coded one particular choice. Apple clang and another clang need not agree, and the WASM build has no `fma` at all. | One `evolve_cell<FMA>` with `#pragma clang fp contract(off)`: every `*` and `+` is its own correctly-rounded operation, written out, in a fixed order. The shaders copy that sequence. |
| 2 | same expression, `/ 3.f` and `* tau / (tau - 20.f)` | Vulkan allows 2.5 ULP on `OpFDiv`, so the shader emulated both divisions with two `fma`s (`div3`, `divTau20`, proven by `tools/divcheck.cpp`). That is only correct if the GPU's `fma` is a *fused* multiply-add. Several mobile GPUs lower `fma()` onto an unfused `mad`. | Both divisions are pre-computed on the host into two new decay tables, `ab3 = (a-b)/3` and `adk = tau/(tau-20)·(aa-av)`, each rounded once from double. `evolve` then only multiplies. No division and no `fma` on either side. |
| 3 | `src/flybrain.cpp` `build_tables` vs `gpu/vkbrain.cpp` vs `gpu/webbrain.cpp` | The exp tables were built three times from three copies of the same expression, and the CPU fell back to `std::exp` for gaps ≥ 1024 while the GPU used a table extended "until it underflows" (~176,000 entries). Two libms, two code paths. | One builder, `vkbrain::build_decay_tables` in `gpu/vkbrain.h`, called once by the core; both backends take the pointer through `Params::tab`. Fixed length `TAB_N = 8192`, no `std::exp` fallback: a gap is at most `steps + 1` ticks and a call is at most 1024, so the clamp is unreachable, and where it is reachable both sides clamp identically. Side effect: the GPU's table went from 2.1 MB to 160 KB. |
| 4 | `gpu/brain.comp` `k_tickA`/`k_tickB` (was: `REC` records, per-target linked list, insertion sort, O(k²) fallback) and `kernel_serial`'s `c.g += W[e]` | Float `+` is not associative, so the synaptic sum depended on the order of deliveries. The GPU reproduced the CPU's order with a linked list per target, a sort into a scratch arena, and — when the arena filled — an O(k²) scan. The `rcap` (8 M records) and `scap` (4 M) limits were two silent-ish failure modes under load. | The weight is an **exact integer** (see below). A tick's deliveries into one cell are summed with `atomicAdd` on the GPU and a stamped per-target accumulator on the CPU, then enter `g` with **one** float rounding. Integer addition is associative, so no order has to be reproduced. `REC`, the scratch, the sort and both overflow paths are deleted. |
| 5 | `src/flybrain.cpp` `plasticity` / `write_weights` / `write_kc_inh` | wrote `float` weights into three different copies of the edge array (CSR, partitions, GPU buffer). | All three write `units_of(w)` — the same integer — so the copies cannot disagree by a rounding. |
| 6 | noise / RNG | The brief asked for a per-neuron hash instead of a sequential RNG. **There is no RNG in this model.** Grepped: no `rand`, `random`, `noise`, `seed`, `mt19937` anywhere in `flybrain.cpp` or in any kernel. The LIF of Shiu et al. 2024 as exported here is deterministic; the only "noise" is the drive. Nothing to fix. |
| 7 | delay ring indexing | `clock % slots` on both sides, with `slot0` passed in per call; the queue is copied whole at the hand-off. No drift found, no change. |
| 8 | denormals | GPUs flush denormal results to zero; the CPU keeps them. Absorbed in every expression (a 1e-40 remainder cannot move a −45 mV threshold) and already excluded from the check by `fz()`. No change. |

## The weight is an integer, and always was

The connectome's weight is `sign × 0.275 mV × contacts`, where `contacts` is the raw synaptic contact
count. Measured on the shipped `brain_c0.flyb` (25,147,397 edges):

* `|w| / 0.275` is a whole number for **100.000000 %** of edges, within one float32 ULP
  (max relative error 7.1e-8, i.e. pure f32 representation error);
* contacts run 1 … 2591, and there are only 788 distinct `|w|` values;
* the worst case over all cells of "every in-edge delivering at once" is **114,054 contacts**.

So the core stores `units = contacts × w_k`:

* `w_quantum` — the file's own quantum (its `w_quantum` record, or the smallest non-zero `|w|`);
* `w_k` — the largest power of two that keeps `worst_sum × w_k` under 2^30. For `brain_c0` that is
  **8192**, giving a worst possible tick accumulator of 9.3e8 against an int32 limit of 2.1e9. It is
  derived at load (`fb_brain::weight_scale`), never hard-coded, so an arbitrary brain file cannot
  overflow the accumulator;
* the plastic KC→MBON weights and `kc_inh_base` are quantised to the same grid; at 1/8192 of a
  contact, a learning step of 1–3 % is resolved with four orders of magnitude to spare.

`ready` and `gpu_check` report `"wk"`, `"wq"` and `"wexact"` so a build is identifiable from a log.

### File format: FLYB v2

`export.py` now writes `wq` (i16 signed contact count) + `w_quantum` (f64) instead of `weight` (f32).
It is the same number, not a compression, and the export refuses rather than rounding if any weight is
off the grid. The core reads v1 and v2; a v1 file's floats are turned back into contacts at load, so
every existing export keeps working. `tools/flyb_quantise.py` converts an existing file in place of
re-running the exporter.

Measured on `brain_c0`: **206.6 → 156.3 MB** uncompressed (the weight half, 100.6 → 50.3 MB), and
**77.0 → 72.1 MB** compressed — the `.z` gains little because zlib already exploited the 788 distinct
float values. RAM is unchanged: edges stay 8 bytes (`{i32 post, i32 units}`), because the plastic
weights need sub-contact resolution and 2591 × 8192 does not fit in 16 bits.

**`post` was measured too:** only **55.8 %** of `post` values are below 65,536 after the "hot"
reorder. A u16/u32 split would therefore save under half of the other 100.6 MB, at the price of a
per-row format flag, a misaligned `Edge`, and a branch in the hottest loop in the program. **Not
worth it** — recommend leaving `post` as i32.

## The two evolve modes

`{"acc":"plain"}` (default) and `{"acc":"fma"}` switch **both** kernels together:

* `plain` — the fma-free, division-free form above. This is what a mobile GPU should run.
* `fma` — the pre-16.09 arithmetic, bit for bit (verified: identical spike totals to the old build,
  step for step). Kept so a device that fails the check can A/B the two in one session, with no
  rebuild: if `fma` fails and `plain` passes, the driver's `fma`/divide was the problem; if both
  fail, the new `dv`/`dg`/`da`/`ulp` fields in `gpu_check` say which arithmetic drifted.

`gpu_check` now reports, besides `cells_diff`: `dv`, `dg`, `da` (how many cells differ in v, g,
adaptation), `dlast`, `drefr` (integer bookkeeping — a difference there is a logic bug, not rounding),
and `ulp` `[v, g, adapt]`, the worst distance in ULP. `dv` alone with `ulp` 1 is a last-bit
evaluation difference; `dg` with a large ULP is a lost or doubled delivery; `dlast`/`drefr` is logic.

## What this costs the model

The change is deliberate and disclosed: each tick's membrane update differs from the pre-16.09
kernel by about one ULP, and the synaptic sum is *more* accurate (one rounding instead of ~150).

**The fly's brain is chaotic, and one ULP is enough to send it down a different trajectory.**
Measured (same brain file, same input, warm-up length on the x axis, spikes in a fixed 50 ms window):

| simulated ms | `fma` | `plain` | apart |
|---|---|---|---|
| 10 | 4,148 | 4,148 | identical |
| 50 | 34,893 | 34,893 | identical |
| 100 | 77,532 | 77,532 | identical (the 50 ms window after already differs by 8) |
| 150 | 115,323 | 115,315 | 8 |
| 300 | 231,833 | 232,395 | 562 |
| 500 | 470,182 | 395,754 | 16 % |

So the two modes are the same run for the first ~100 ms of simulated time and diverge exponentially
after that, as any two roundings of a chaotic network would. Both are legitimate runs of the same
equations — same neurons, synapses, weights and delays — and the per-run `baseline` the decoder
subtracts is measured per run. **Whether the fly still behaves the same is a behaviour question, not
an arithmetic one: run `tools/battery.py` before trusting it, and it deserves an ADR.**

An interesting consequence of #4: with the float scatter, `plain` and `fma` landed in *different
activity regimes* (39 k vs 60 k spikes per step). With the integer scatter they land in the same one
(60.5 k vs 61.9 k, against 60.5 k for the old build). Summing ~150 float deliveries one at a time was
losing enough to matter.

## Verified

ADR 81 measured that this network is chaotic at the trajectory level, so a long-horizon spike diff
against the old kernel is not a meaningful test and is not attempted. The three tests that are:

### 1. The hard gate — CPU vs GPU with the new kernel, bit for bit

Mac, M1 Max, MoltenVK (`MVK_CONFIG_FAST_MATH_ENABLED=0`), `brain_c0`, `{"gpu_check":k}`
(the cap is 200 chunks = 2.0 s of simulated time; it used to be 20):

| build | 3 chunks | 10 | 20 | 50 | 200 |
|---|---|---|---|---|---|
| pre-16.09 | ok, `cells_diff` 0 | **FAIL**, 154,678, spikes 750,132 ≠ 750,816 | **FAIL**, 156,693, `ulp` maxed | — | — |
| new, `acc=plain` | ok, 0 | ok, 0 | ok, 0 | ok, 0 (1,252,833 spikes) | **ok, 0** (3,128,084 spikes, every field 0) |
| new, `acc=fma` | ok, 0 | ok, 0 | ok, 0 | — | — |

Also checked: `{"threads":1|2|4}` give bit-identical spikes (the partitioned kernel really runs — 4.03 s
vs 2.80 s wall — and agrees with serial), and a FLYB v1 file and its v2 conversion give identical runs.

### 2. Short horizon — old float kernel vs new integer kernel, from the identical initial state

50 ms hops from `reset_state`, total spikes per hop:

| hop | sim ms | old | new | apart |
|---|---|---|---|---|
| 0 | 50 | 34,893 | 34,893 | **identical** |
| 1 | 100 | 42,639 | 42,639 | **identical** |
| 2 | 150 | 37,791 | 37,783 | 0.02 % |
| 3 | 200 | 36,492 | 36,482 | 0.03 % |
| 4 | 250 | 40,843 | 40,755 | 0.2 % |
| 5 | 300 | 39,175 | 39,843 | 1.7 % |
| 6 | 350 | 49,175 | 42,597 | 13 % |
| 7 | 400 | 62,290 | 38,658 | 38 % |

**They separate at hop 2, 100 ms of simulated time**, and decorrelate by hop 6-7 — the ~2 s figure of
ADR 81, only faster because the perturbation is applied at every tick rather than once. Separation is
expected, not a bug. By hop 16 both runs are back in the same activity band (60-66 k a hop).

Speed on the same state (10 chunks): CPU 372 → 382-390 ms (+3-5 %, the second pass over the touched
targets, clawed back with a prefetch), GPU 231 → 216-222 ms (−5 %). The integer scatter is not slower.

GPU memory on a small GPU: the record buffer (`4 × rcap × 2` = **64 MB**) and the sort scratch's
`scap` half (**16 MB**) are gone, replaced by `4 × n` = 667 KB; the decay table went 2.1 MB → 160 KB.
About **79 MB less GPU memory**, and the `rcap`/`scap` overflow failure modes no longer exist.

`brain_c0.flyb` (v1) and its v2 conversion produce **bit-identical** runs.

### 3. Long horizon — ensemble statistics, old float core vs new integer core

The twelve `fake_lens.py` scenarios (each its own 2 s settle + 3 s stimulus, i.e. twelve independent
starting states), decoded actions averaged over the last 1.5 s, and the mean firing rate of all 58
readouts:

* **median relative rate error across the 58 readouts: 6.0 %.** For scale, the pruning sweep of
  ADR 81 measured 8-35 % for candidates it judged to break behaviour; this is below the mildest.
* worst decoded-action difference over all scenarios and keys: **0.86**, and that single outlier is
  `stop` in `motion_left`. Eleven of the twelve scenarios are 0.10-0.29.
* **escape is untouched**: `loom_left` and `loom_right` give 1.00 on both cores, as ADR 81's
  "prune-proof tier" predicts for a 20 mV direct injection.
* **The threshold devices move, exactly as ADR 81 says they must under any perturbation:**
  `feed` (MN9, 1-4 cells) 5.7 → 9.1 Hz, 64 % relative; `stop` (DNpe007) 79.7 → 64.4 Hz, 20 %, and it
  owns the 0.86 action outlier. MBON07 is not a readout in `brain_c0` (only in the `_mbon` export),
  so it is not in this table. These three are the tier that is unreliable against *any* perturbation,
  including a re-run; they are not evidence about this change specifically.

### Speed, on identical work

Hops 0 and 1 from the identical initial state are bit-identical between the two cores, so they are a
strict like-for-like timing (ms per 50 ms hop):

| | old | new |
|---|---|---|
| CPU, 1 thread | 47 / 71 | 50 / 78 (+6-10 %) |
| CPU, 2 threads | 32 / 47 | 36 / 54 (+12-15 %) |
| GPU (10 chunks, same state) | 231 ms | 216-222 ms (−5 %) |

The CPU cost is structural: the delivery loop now touches an 8-byte accumulator instead of the
32-byte cell, but the cells are then visited again in a second pass, and at 2 threads that second
random pass over the 5.3 MB cell array is what costs. Tried and did not help: removing the
first-touch prefetch, lengthening the prefetch distance, replacing `push_back` with preallocated
arrays (kept anyway — it is cleaner). The way to get it back is to put the accumulator *inside* the
`Cell` struct, which needs `last` to become a per-call int32 the way the GPU already stores it; that
is a separate piece of work. **Accepted for now: on a mobile host the GPU is several times the CPU, and this is the
fallback path.**

## Resident memory, while we were in here

Pavlo asked whether the core holds the connectome twice. **They do not** — `set_gpu` frees the CPU
edge arrays the moment the Vulkan buffer owns them and the CPU kernel then reads the mapped GPU
buffer (`gpu_edges()`), which is what ADR 52 designed and what this checkpoint preserved. But the
process still *showed* both, because an allocator keeps large freed blocks on its own free list and
a memory-pressure killer looks at resident size, not at what malloc could return. Measured on the Mac, `brain_c0` v2:

| | before | after |
|---|---|---|
| resident, CPU only | 630.6 MB | **211.6 MB** |
| resident, GPU up | 880.1 MB | **268.6 MB** |
| peak during bring-up, GPU | 880.1 MB | 730.8 MB |

Three changes, all cheap: `release_memory()` (`malloc_zone_pressure_relief` / `malloc_trim` /
`mallopt(M_PURGE)`) after the load, after the GPU takes the edges and once more after warm-up; a v2
file's contacts are never widened into a temporary f32 array (−100 MB of load peak); and the GPU's
interleaved edge array is filled one source array at a time, each freed as it goes.

**The bring-up peak is the piece still worth doing** (731 MB on the Mac, which is still worth cutting for a small device).
It is not a second copy of the connectome — it is the load-time temporaries plus the buffers being
filled. The plan, for a checkpoint of its own: give the GPU buffers **SoA** layout (`post` and
`units` as two buffers instead of one interleaved `Edge` array, which also makes the 128 MB
per-binding split cleaner on a small GPU) and fill them **straight from the FLYB blob** — the file
already stores `post` (i32) and `wq` (i16) as separate contiguous arrays, so with SoA the loader
never has to materialise a CPU copy of either. That would put the peak at roughly the steady state.
It touches the loader, both GPU hosts, both shaders' edge indexing and both CPU kernels, which is why
it is not in this checkpoint.

## Where the hop goes (17.09) — and a metric that misled three conclusions

A mobile GPU ran this kernel with `NATIVE_GPU_CHECK ok:true, cells_diff 0` three times over, and
reported a step of many seconds with a `gpu_ms` of two.

**`gpu_ms` was `gpu_last_ms`: the wall time of the LAST 10 ms chunk of the five in a 50 ms hop**
(`flybrain.cpp` assigned it per chunk and reported it once per hop; `BrainLink.ts:58` documents it
that way). Read as the hop, it makes the GPU look like 14 % of the step and leaves twelve seconds
unexplained. Five chunks at ~2 s is ~10 s — the GPU's real share was simply never on the row.

Since 17.09: `gpu_ms` is the **whole hop**, `gpu_chunk_ms` keeps the old meaning, and the core
carries a **phase table**, `fb_prof` → the module's `stats()` → the LENS row's `core=` (no lens
change needed), plus the GPU's **own timestamps** via `VK_QUERY_TYPE_TIMESTAMP`:

```
{"gpu":68.4,"busy":0,"drive":0.6,"counts":1,"push":0,"pull":0,"cpu":0,
 "sense":0.9,"plast":0.2,"read":0.1,"msg":0,"gc":5,"cc":0,"step":71.2}
```

`gpu` is the wall time we block on the fence; `busy` is how long the GPU itself was on it. **On a
device whose compositor shares the GPU those are different numbers, and the gap is the answer:**

| what the row prints | what it means | what to do |
|---|---|---|
| `busy` ≈ `gpu` ≈ `step` | the kernel really is that slow on that GPU | kernel/occupancy work |
| `busy` << `gpu` | we are queued behind the renderer | scheduling, not arithmetic |
| `gpu` small, some other phase large | that phase; `counts` is the one to suspect (see below) | fix that phase |

Mac reference, both engines, phases summing to the step:

| engine | gpu | busy | cpu | drive | counts | sense | plast | read | msg | step |
|---|---|---|---|---|---|---|---|---|---|---|
| WebGPU (the page) | 68.4 | — | 0 | 0.6 | 1.0 | 0.9 | 0.2 | 0.1 | 0 | 71.2 |
| Vulkan (MoltenVK) | 573.8 | 542.1 | 0 | 1.0 | 1.0 | 2.6 | 0.1 | 0.0 | 0.2 | 578.6 |
| CPU only | 0 | 0 | 572.9 | 0 | 0 | 0.9 | 0.1 | 0.3 | 1.4 | 574.3 |

So in the core's structure there is no missing 86 %: the hop is the kernel, and everything else
together is under 1 % on Vulkan and 4 % on WebGPU. `push`/`pull` are 0 because
`NATIVE_GPU_FRACTION` is 1, so the state never moves between engines mid-hop (`gc` 5, `cc` 0).

**The one phase that could still blow up on a mobile GPU, and its fix, pre-analysed.** `counts` is
`vk->get_counts` — 166,700 int32 read out of HOST_VISIBLE|HOST_COHERENT memory **every chunk**, five
times a hop. On Apple silicon that memory is cached and it costs 1 ms; on a mobile part it can be
uncached, and then it is not 1 ms. It is also mostly unnecessary: per chunk only `plasticity` needs
counts, and only for the 7,835 plastic presynaptic cells and the DANs; the full array is needed once
per hop, for `rates`, `regions` and the cloud bitset. If a host's `counts` is large, that is the
change — and the phase table will say so before anyone writes the code.

**The duty cannot govern `step=`, by construction.** `duty` makes the brain thread sleep in `loop()`
**after** `step()` returns, so it never enters `last_wall_ms` — which is exactly what
`stats().step_ms` reports as `step=`. Raising the duty from 0.25 to 1.0 and
seeing the step unchanged is what the code predicts, not evidence of an ungoverned phase. What the
duty does govern is the GAP between hops, i.e. the fly's reaction time, which the row does not show.
To judge the duty, measure the interval between brain messages.

## Still open

* **The check on other GPUs.** The log line now carries `"acc"`, `"wk"` and `"wexact"`, so the
  build is identifiable, and `{"acc":"fma"}` gives the control in the same session.
* **WebGPU is not bit-exact, and the new fields say exactly why.** Measured in headless Chrome
  (apple metal-3), `acc=plain`, one chunk:
  `{"cells_diff":56277,"dv":36036,"dg":31115,"da":0,"dlast":0,"drefr":0,"ulp":[28045,466646,0]}`.
  **`da`, `dlast` and `drefr` are all 0** — adaptation (`adapt * cc`, a bare multiply) is identical,
  and so is every integer. Only `v` and `g` differ, and those are exactly the two quantities whose
  update has a multiply feeding an add. That is the signature of a **fused** multiply-add: the WASM
  CPU has none (wasm32 has no fma instruction, so emcc cannot contract) and Chrome's WGSL backend
  fuses. WGSL has no `precise` and no way to forbid it, so this one cannot be closed from here — it
  is a property of the language, not a bug in the kernel. The large `dg` ULP is cancellation, not
  magnitude: `g` is a small difference of large opposite-sign sums, so a last-bit error in either
  term is a big *relative* distance. Judge the page by `spikes_cpu == spikes_gpu` (it held over 3
  chunks: 103,529 both) and by `dlast`/`drefr` staying 0. The Vulkan path is exact — `precise` there maps to SPIR-V `NoContraction`.
* **The Mac server's `--kernel metal` / `--engine batch`** kernels (`brain_server/engine/`) are a
  different kernel family (they batch several flies) and still use the float scatter and the old
  `evolve`. They are not the core and not on the Vulkan path, but they are now one ULP away from it.
