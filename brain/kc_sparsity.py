"""Sparsity sweep. KC coding is combinatorial only when it is SPARSE; at 37 % active every strong
odour recruits the same cells. Does a weaker cue separate VA2 from DM4?"""
import sys, numpy as np
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "brain_server"))
from flywirehead.neural.visual import VisualMemoryBrain
from flywirehead.neural.common import annotations
from channels import index_senses, build_stim

MS, REST = 300.0, 160 / 255
b = VisualMemoryBrain()
a = annotations(b.ids)
types = a.type.fillna("").to_numpy().astype(str)
kc = np.flatnonzero(np.char.startswith(types, "KC"))
ix = index_senses(a)
frame = np.full((8, 16, 3), int(round(REST * 255)), np.uint8)

def run(ch, v):
    b.reset()
    total = np.zeros(b.n, np.int64)
    stim = build_stim(ix, {ch: {"L": v, "R": v}})
    for _ in range(int(MS // 10)):
        c, _ = b.rgb_step(frame, 10.0, learning=False, stimulation=stim)
        total += c
    k = total[kc]
    return set(np.flatnonzero(k > 0).tolist())

print(f"{'level':>6} {'|VA2|':>6} {'|DM4|':>6} {'shared':>7} {'onlyA':>6} {'onlyB':>6} {'jaccard':>8} {'sparsity':>9}")
for v in (0.36, 0.40, 0.45, 0.55, 0.70, 0.90, 1.50):
    A = run("odor_va2", v)
    B = run("odor_dm4", v)
    if not A and not B:
        print(f"{v:6.2f}      0      0       0      0      0        -         -"); continue
    uni = len(A | B) or 1
    print(f"{v:6.2f} {len(A):6d} {len(B):6d} {len(A&B):7d} {len(A-B):6d} {len(B-A):6d} "
          f"{len(A&B)/uni:8.3f} {100*max(len(A),len(B))/len(kc):8.1f}%")
