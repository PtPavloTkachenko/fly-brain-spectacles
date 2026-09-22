# A lighter brain for a small host — measured, and rejected

**Verdict: no cut ships.** Sixteen candidates, from 0.2 % of edges removed to 70 %. Not one meets
the gate (every named readout within 10 % rate error, DNa02 steering sign agreeing > 95 % of the
time). Nothing was exported. The reason is not that the cuts are too big — a cut that removes
**0.046 % of the connectome's total |w|** fails just as hard as one that removes 31 %.

Tools: `lite.py` (this directory) on the Metal kernel; reference `fidelity.py`, `explore.py`.
Raw results in `out/lite_*.json`, masks in `out/mask_*.npy`, the table in `out/table.json`.

---

## 1. What the weights look like

25,582,938 edges over 166,700 neurons, Σ|w| = 3.415e7 mV. One synaptic contact = 0.275 mV signed.
Contacts: median **2**, mean 4.85, max 2,591. In-degree: median 98, mean 153, p10 23.

| drop the weakest | threshold | edges left | **|w| lost** |
|---|---|---|---|
| 30 % | 1 contact | 17,908,057 | **6.2 %** |
| 50 % | 2 contacts | 12,791,469 | **12.3 %** |
| 70 % | 4 contacts | 7,674,882 | **23.0 %** |
| 80 % | 5 contacts | 5,116,588 | 32.2 % |
| 90 % | 10 contacts | 2,558,294 | 47.4 % |

The graph is overwhelmingly weak edges: **60.3 % of all synapses are single-contact** and together
they carry 8.3 % of the weight. On paper that is a free 60 % cut. It is not (§4).

## 2. What was protected, always

| class | edges | note |
|---|---|---|
| plastic KC→MBON07/11 | 7,835 | ADR 48 — the whole learning substrate, untouched |
| APL→KC | 4,633 | ADR 67 — the sparsening loop, exported as its own class |
| every edge **into or out of** a readout cell | 2,364,230 | 15,149 cells: DNa02, DNp01/02/04/11, DNpe007, MN9, PPL101/PAM11, MBON07/11, LC4/LPLC2/LC11, T4/T5, HS/VS, every motor pool |
| first hop **out of** every injected sense cell | 377,103 | 3,501 cells from `channels.py` SENSES |
| **total protected** | **2,753,801** (10.8 %) | |

Plus a per-postsynaptic **top-k floor**: every cell keeps its k strongest inputs whatever the
global rule says. New silent cells after every candidate: **0** (the 370 zero-in-degree cells are
the connectome's own sensory leaves).

## 3. The table

16 scenarios × (2.0 s settle + 3.0 s drive) at 50 ms/hop = 1,600 hops per candidate, on the Metal
kernel. Rates are the decoder's own smoothed readout Hz, averaged over the last 1.5 s. `rateErr` =
mean over 31 core readouts of (mean |Δ Hz| / mean |full Hz|). `sign%` = DNa02_R − DNa02_L sign
agreement across the whole drive window. `touch/hop` = edges touched per 50 ms hop = Σ over
spiking cells of their kept out-degree — the honest step-cost proxy.

**The harness is exactly deterministic**: full brain run twice → max action diff 0.0, max rate diff
0.0 Hz, sign agreement 1.000. Every number below is the prune, not noise.

| candidate | rule | edges | % | \|w\| % | touch/hop | % | rateErr | max | worst | corrMin | sign % | actErr |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **full** | — | 25,582,938 | 100.0 | 100.0 | 13.52 M | 100.0 | 0.000 | 0.000 | — | 1.000 | 100.0 | 0.000 |
| f999 | keep 99.9 % of each cell's \|w\| | 25,526,267 | 99.8 | 100.0 | 13.26 M | 98.1 | 0.082 | 0.671 | feed | 0.607 | **74.0** | 0.860 |
| f99 | 99 % | 24,578,722 | 96.1 | 99.2 | 12.89 M | 95.3 | 0.139 | 2.015 | feed | 0.259 | 75.9 | 0.999 |
| f95 | 95 % | 20,631,242 | 80.6 | 95.7 | 11.32 M | 83.8 | 0.101 | 1.034 | feed | 0.133 | 77.2 | 0.787 |
| f95c | 95 % + drive compensation | 20,631,242 | 80.6 | 100.0 | 11.66 M | 86.3 | 0.114 | 1.112 | MBON07 | 0.621 | 78.6 | 0.439 |
| f90 | 90 % | 16,908,847 | 66.1 | 91.3 | 9.17 M | 67.8 | 0.147 | 1.248 | feed | −0.077 | 81.7 | 0.825 |
| f90c | 90 % + compensation | 16,908,847 | 66.1 | 100.0 | 9.87 M | 73.0 | 0.231 | 1.592 | MBON07 | 0.013 | 82.2 | 0.845 |
| c2k16 | ≥2 contacts, top-16 floor | 16,296,044 | 63.7 | 92.5 | 8.33 M | 61.6 | 0.150 | 1.147 | feed | −0.122 | 79.1 | 0.846 |
| c3k32 | ≥3, top-32 | 12,606,283 | 49.3 | 86.4 | 6.42 M | 47.5 | 0.145 | 0.947 | MBON07 | 0.252 | 81.0 | 0.732 |
| c3k16 | ≥3, top-16 | 12,118,214 | 47.4 | 85.8 | 6.19 M | 45.8 | 0.141 | 0.947 | MBON07 | 0.648 | 83.2 | 0.786 |
| c3k16c | ≥3, top-16 + compensation | 12,118,214 | 47.4 | 100.0 | 7.22 M | 53.4 | 2.004 | 46.343 | MBON07 | 0.334 | 83.2 | 0.851 |
| c5k32 | ≥5, top-32 | 9,672,499 | 37.8 | 78.5 | 5.30 M | 39.2 | 0.176 | 1.047 | feed | −0.006 | 78.5 | 0.840 |
| c5k16 | ≥5, top-16 | 8,595,866 | 33.6 | 76.2 | 4.36 M | 32.3 | 0.185 | 1.083 | feed | −0.032 | 80.8 | 0.795 |
| c8k32 | ≥8, top-32 | 8,318,816 | 32.5 | 72.2 | 4.29 M | 31.7 | 0.207 | 1.033 | feed | −0.120 | 78.5 | 0.956 |
| c11k48 | ≥11, top-48 | 9,463,635 | 37.0 | 73.0 | 4.95 M | 36.6 | 0.253 | 1.745 | DNp66_L | −0.115 | 77.2 | 0.862 |
| c11k32 | ≥11, top-32 | 7,801,435 | 30.5 | 68.5 | 3.96 M | 29.3 | 0.239 | 1.347 | DNp66_L | −0.115 | 77.3 | 1.000 |
| c21k64 | ≥21, top-64 | 10,749,683 | 42.0 | 73.3 | 5.47 M | 40.5 | 0.349 | 2.385 | DNp66_L | 0.018 | 75.5 | 1.000 |

"MB compressed" is not a column because nothing reached an export. For scale: the current
`brain_c0.flyb.z` is 77.0 MB for 25.1 M edges, and the payload is linear in the edge count — a
c5k16-sized file would be ≈26 MB, a c3k16 one ≈37 MB.

`c3k16c` shows why the compensation idea is a dead end on its own: restoring each cell's summed
drive by rescaling its survivors needs gains past the 5× clip on the cells that lost most, and
MBON07 then overshoots by 46×.

## 4. Why it fails — the number that settles it

**f999 removes 56,671 edges (0.22 %) carrying 0.046 % of Σ|w|. It scores worse on steering sign
(74.0 %) than cuts three hundred times larger.** Across the whole table the error is flat: mean
rate error 8–35 %, sign 74–83 %, from a 0.2 % cut to a 70 % cut. There is no fidelity-versus-size
curve to ride down.

That is the signature of a chaotic trajectory, not of lost information. The MaleCNS LIF network
sits at a bistable resting point (`worker.py` already records it: at light 153/255 it stays silent
for seconds, at 160 it wakes in 0.3 s). Perturb it by anything at all and the trajectory
decorrelates inside the 2 s window. So ADR 47's "pruning breaks behaviour" is right, but its
recorded *reason* — that ≥3/5/10-contact cuts lose 16/28/46 % of the weight — is not the mechanism.
Losing 0.046 % does it too.

**What survives is stimulus-locked drive, and it survives everything.** Relative rate error per
readout:

| readout | full Hz | f999 | f99 | f90 | c3k16 | c5k16 | c11k32 |
|---|---|---|---|---|---|---|---|
| esc_L (DNp01/02/04/11) | 17.3 | 0.005 | 0.004 | 0.008 | 0.001 | 0.006 | 0.035 |
| esc_R | 15.4 | 0.001 | 0.003 | 0.004 | 0.007 | 0.000 | 0.009 |
| LC4_L | 8.1 | 0.001 | 0.002 | 0.001 | 0.004 | 0.003 | 0.004 |
| LPLC2_R | 7.6 | 0.001 | 0.001 | 0.000 | 0.001 | 0.002 | 0.006 |
| reward (PAM11) | 5.7 | 0.002 | 0.004 | 0.005 | 0.011 | 0.016 | 0.025 |
| power_L (DLM/DVM) | 83.0 | 0.051 | 0.047 | 0.080 | 0.109 | 0.152 | 0.204 |
| stress (PPL101) | 143.0 | 0.088 | 0.140 | 0.099 | 0.047 | 0.107 | 0.162 |
| DNa02_L | 34.3 | 0.183 | 0.162 | 0.194 | 0.228 | 0.495 | 0.371 |
| DNa02_R | 17.6 | 0.149 | 0.090 | 0.426 | 0.387 | 0.476 | 0.407 |
| DNp66_R | 23.0 | 0.147 | 0.167 | 0.283 | 0.208 | 0.309 | 0.613 |
| back (MDN) | 30.1 | 0.151 | 0.176 | 0.239 | 0.135 | 0.377 | 0.290 |
| stop (DNpe007) | 87.8 | 0.183 | 0.330 | 0.239 | 0.088 | 0.233 | 0.237 |
| MBON11 | 19.1 | 0.091 | 0.176 | 0.330 | 0.725 | 0.777 | 0.903 |
| appetite | 21.3 | 0.247 | 0.445 | 0.293 | 0.485 | 0.287 | 0.549 |
| MBON07 | 1.5 | 0.422 | 0.330 | 0.631 | 0.947 | 0.975 | 0.986 |
| **feed (MN9)** | 4.3 | **0.671** | **2.015** | **1.248** | **0.621** | **1.083** | **0.998** |

Three tiers, and they line up with cell count and drive strength:

* **Prune-proof (≤ 3.5 % error at every cut):** the escape suite and its detectors, and PAM11. A
  loom injects 20 mV directly into LC4/LPLC2 and drives them to 130 Hz; the escape DNs reach 266 Hz.
  Injected drive that large swamps anything a prune changes. Escape events confirm it: 60/60 steps
  over threshold on loom_left in the full brain, 59–60/60 in every candidate, and 0/60 false
  escapes in every non-loom scenario, everywhere.
* **Drifting (9–60 %):** DNa02, DNp66, the power MNs, MDN, PPL101. The *shape* is right
  (correlation 0.89–1.00 at f99) but the level slides, so the decoder — which reads a difference
  from a habituating baseline — turns a 25 % rate drift into a lost turn. Full brain turns −0.67
  toward food on the left; c5k16 turns −0.09.
* **Broken at any cut:** MN9 (feed), DNpe007 (stop), MBON07. These are **one to four cells firing
  a handful of spikes per window**. A cell at 4 Hz is a threshold-crossing device; shifting its net
  input by a fraction of a percent moves it across. `feed` inverts outright: the full brain feeds at
  0.06–0.21 in neutral and food and *not* on sweet contact; the pruned ones do the opposite.
  `stop` goes from 0.00 to 0.78 in neutral at c5k16 — a fly frozen on the spot.

So the gate cannot be met, and the > 95 % steering-sign clause cannot be met **by any cut at all**,
because the full brain does not reproduce its own steering sign under a 0.046 % perturbation.

## 5. The one lead worth following

**131,399 of 166,700 neurons (78.8 %) never fired a single spike across the whole 16-scenario
battery, and they own 17,632,568 out-edges — 68.9 % of the connectome.** A cell that never fires
delivers nothing, so deleting its outgoing edges is *exactly* behaviour-preserving for that run.

That is a 69 % cut with zero error — and it is **not evidence**, because the battery that defines
the set is the battery that would score it. Circular. To make it real it needs:

1. a **definition** battery that is far broader than `SCENARIOS` — the compound eye driven with
   real frames (T4/T5/HS/VS never fire at all here, because these scenarios send no `eye` payload),
   hands, the room's world-mesh looms, every odour identity, learning on;
2. an **independent validation** battery it never saw — the real `dbg` sense traces off the glasses;
3. a fallback for the cells that do wake up later (they would go silent-but-present, which is a
   behaviour change and needs its own ADR).

This is the only lever measured here with upside proportional to the problem (a 77 MB
download). Cutting weak synapses is not.

## 6. Known blind spots of this study

* **The eye is never driven.** No scenario sends an `eye` payload, so T4/T5, HS/VS and LC11 read
  0.0 Hz throughout and contribute nothing to `rateErr`. Any future candidate must be scored with
  the ommatidial lattice running (ADR 54), or the whole optic lobe is untested.
* **Learning is off** (`weights_frozen`, `learning=False`). The plastic set was protected by
  construction and never exercised; a cut that passed behaviourally could still ruin conditioning.
* **One brain, one seed, one trajectory per candidate.** The harness is deterministic, so the
  comparisons are clean, but there is no ensemble — the "chaotic trajectory" reading in §4 comes
  from the flat error-versus-size curve, not from a Lyapunov measurement.
* **The step-cost proxy is edges touched, not milliseconds.** It tracks the edge count closely
  (c11k32: 29.3 % of edges touched for 30.5 % of edges kept) but says nothing about cache behaviour
  on a small mobile core, which is where `--order hot` lives.
* **Pruning is applied by zeroing, not compacting.** The spikes are identical either way; the file
  size and the real step cost would come from `export.py`'s compaction, which was never run.

## 7. How to reproduce

```bash
cd "$CYBERFLY_RUNTIME/fly-wirehead"
L=<repo>/core/brain_prune/lite.py
.venv/bin/python $L stats                      # §1
.venv/bin/python $L masks                      # §2, writes out/mask_*.npy
.venv/bin/python $L run --kernel metal --cand full f999 f99 f95 f90 c3k16 c5k16   # ~75 s each
.venv/bin/python $L table                      # §3
```

`export.py` takes `--mask <bool .npy over the original edge order>` alongside `--cmin`, so any mask
in `out/` can be exported without further code. That path was **never exercised end to end** —
nothing here was worth exporting.
