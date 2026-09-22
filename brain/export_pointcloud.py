"""Export one 3D point per retained neuron, in the brain's own index order.

Positions: MaleCNS `somaLocation` (else `tosomaLocation`). Neurons without one (mostly
sensory cells whose bodies lie outside the imaged CNS) are placed at the synapse-weighted
mean of their located partners, repeated until no more can be placed.

Output `results/pointcloud.npz`: xyz float32 in [-1, 1] (aspect kept, y up),
superclass uint8 codes + their names, placed_from ("soma" | "partners" | "centroid").

Run from the fly-wirehead runtime:
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<this file>"
"""

from pathlib import Path

import numpy as np

from flywirehead.neural.common import GRAPH, annotations

OUT = Path(__file__).with_name("results")

with np.load(GRAPH) as g:
    ids, ptr, post, weight, superclass = (
        g["ids"],
        g["ptr"],
        g["post"],
        np.abs(g["weight"]),
        g["superclass"],
    )
n = len(ids)
a = annotations(ids)

xyz = np.full((n, 3), np.nan)
source = np.full(n, "", dtype="U8")
for col in ["somaLocation", "tosomaLocation"]:
    for i, loc in enumerate(a[col].to_numpy()):
        if np.isnan(xyz[i, 0]) and loc is not None and not (
            isinstance(loc, float) and np.isnan(loc)
        ):
            xyz[i] = loc
            source[i] = "soma"

pre = np.repeat(np.arange(n), np.diff(ptr))
for _ in range(4):
    missing = np.isnan(xyz[:, 0])
    if not missing.any():
        break
    # Edges between a missing neuron and a located partner, in either direction.
    acc = np.zeros((n, 3))
    wsum = np.zeros(n)
    for a_, b_ in ((pre, post), (post, pre)):
        m = missing[a_] & ~missing[b_]
        np.add.at(acc, a_[m], xyz[b_[m]] * weight[m, None])
        np.add.at(wsum, a_[m], weight[m])
    fill = missing & (wsum > 0)
    xyz[fill] = acc[fill] / wsum[fill, None]
    source[fill] = "partners"

left = np.isnan(xyz[:, 0])
xyz[left] = np.nanmean(xyz, axis=0)
source[left] = "centroid"

# Voxel space: x right, y down (dorsal->ventral), z anterior-posterior. Flip y to up.
xyz[:, 1] *= -1
center = (xyz.max(0) + xyz.min(0)) / 2
xyz = ((xyz - center) / (np.ptp(xyz, 0).max() / 2)).astype(np.float32)

names, codes = np.unique(superclass, return_inverse=True)
OUT.mkdir(exist_ok=True)
np.savez_compressed(
    OUT / "pointcloud.npz",
    xyz=xyz,
    superclass=codes.astype(np.uint8),
    superclass_names=names,
    placed_from=source,
    ids=ids,
)
kinds, counts = np.unique(source, return_counts=True)
print(dict(zip(kinds.tolist(), counts.tolist())), "extent", np.ptp(xyz, 0).round(3))
