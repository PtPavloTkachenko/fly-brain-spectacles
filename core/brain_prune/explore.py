"""How big is the sub-connectome between our inputs and our readouts?

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/core/brain_prune/explore.py

Sources = every cell that receives current: retina (R1-R6), lamina bias cells, R8, sugar, and every
sense channel's cell set. Sinks = every readout cell the decoder reads. A neuron is kept when it lies
on a directed path source -> sink of at most `k` hops through edges with at least `c` synaptic
contacts. Prints neuron and edge counts per (k, c) so we can pick a size before testing fidelity.
"""

import os
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "brain_server"))
os.environ.setdefault("FLYWIREHEAD_DATA", str(Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")) / "fly-wirehead/data"))

from flywirehead.neural.common import GRAPH, annotations  # noqa: E402

from channels import index_readouts, index_senses  # noqa: E402

UNIT_MV = 0.275  # weight = contacts * 0.275 mV (signed)


def hops(ptr, nbr, contacts, seeds, k, cmin, n):
    """Distance (in hops, <= k) from the seed set along CSR (ptr, nbr) using edges with >= cmin contacts."""
    dist = np.full(n, 255, np.uint8)
    dist[seeds] = 0
    frontier = np.unique(seeds)
    for d in range(1, k + 1):
        starts, ends = ptr[frontier], ptr[frontier + 1]
        lens = ends - starts
        if lens.sum() == 0:
            break
        idx = np.repeat(ends - lens.cumsum(), lens) + np.arange(lens.sum())
        idx = np.repeat(starts - np.r_[0, lens.cumsum()[:-1]], lens) + np.arange(lens.sum())
        ok = contacts[idx] >= cmin
        tgt = nbr[idx[ok]]
        new = tgt[dist[tgt] == 255]
        new = np.unique(new)
        dist[new] = d
        frontier = new
        if len(frontier) == 0:
            break
    return dist


def main():
    t0 = time.time()
    g = np.load(GRAPH)
    ptr, post, weight = g["ptr"], g["post"], g["weight"]
    retina, lamina, sugar, ids = g["retina"], g["lamina"], g["sugar"], g["ids"]
    n = len(ids)
    contacts = np.rint(np.abs(weight) / UNIT_MV).astype(np.int32)
    print(f"graph: {n} neurons, {len(post)} edges, contacts median {int(np.median(contacts))}, load {time.time()-t0:.1f}s")

    # reverse CSR (incoming edges by target)
    t1 = time.time()
    pre = np.repeat(np.arange(n, dtype=np.int32), np.diff(ptr))
    order = np.argsort(post, kind="stable")
    rptr = np.r_[0, np.cumsum(np.bincount(post, minlength=n))].astype(np.int64)
    rnbr = pre[order]
    rcontacts = contacts[order]
    print(f"reverse CSR {time.time()-t1:.1f}s")

    a = annotations(ids)
    senses = index_senses(a)
    reads = index_readouts(a)
    r8 = np.flatnonzero(a.type.fillna("").str.startswith("R8").to_numpy())
    src = np.unique(np.concatenate([retina, lamina, sugar, r8] + [c for grp in senses.values() for c in grp.values()]).astype(np.int32))
    snk = np.unique(np.concatenate(list(reads.values())).astype(np.int32))
    print(f"sources {len(src)}  sinks {len(snk)}")

    print(f"{'k':>2} {'cmin':>4} {'neurons':>8} {'%':>5} {'edges':>9} {'%':>5} {'MB(post+w)':>10}")
    for cmin in (1, 3, 5, 10):
        for k in (4, 6, 8, 10):
            fwd = hops(ptr, post, contacts, src, k, cmin, n)
            bwd = hops(rptr, rnbr, rcontacts, snk, k, cmin, n)
            keep = (fwd.astype(np.int32) + bwd.astype(np.int32)) <= k
            keep[src] = True
            keep[snk] = True
            m = keep[pre] & keep[post] & (contacts >= cmin)
            ne = int(m.sum())
            print(f"{k:>2} {cmin:>4} {int(keep.sum()):>8} {100*keep.mean():>5.1f} {ne:>9} {100*ne/len(post):>5.1f} {ne*8/1e6:>10.1f}")
    print(f"done {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
