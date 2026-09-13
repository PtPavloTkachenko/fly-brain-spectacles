"""Numerical overlay check of out/ against the lens cloud (BrainCloudData = cloud_subset.npz).
    uv run --with-requirements tools/anatomy/requirements.txt python tools/anatomy/verify.py
Inside tests use the generalised winding number (libigl), distances use an AABB tree - both
robust for the non-watertight decimated meshes.
"""
import json
from pathlib import Path

import igl
import numpy as np
import trimesh

from process import OUT, PC, RAW, Space, read_ngmesh, roi_mesh

CS = PC.with_name("cloud_subset.npz")
man = json.loads((OUT / "manifest.json").read_text())
um = 1.0 / man["space"]["unit_um"]  # cloud units per micron


def load(rel):
    return trimesh.load(OUT / rel, force="mesh")


def _vf(m):
    return np.ascontiguousarray(m.vertices, np.float64), np.ascontiguousarray(m.faces, np.int64)


def winding(m, pts):
    """Generalised winding number (robust for non-watertight meshes): > 0.5 = inside."""
    v, f = _vf(m)
    return np.abs(igl.fast_winding_number(v, f, np.ascontiguousarray(pts, np.float64)))


def dist(m, pts):
    v, f = _vf(m)
    return np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(pts, np.float64), v, f)[0])


def inside(meshes, pts):
    return np.any([winding(m, pts) > 0.5 for m in meshes], axis=0)


def main():
    sp = Space()
    pc, cs = np.load(PC), np.load(CS)
    cloud = cs["xyz"].astype(float)
    ts = (Path(PC).parents[2] / "Spectacles/Assets/Scripts/Fly/BrainCloudData.ts").read_text()
    body = ts.split("export const CLOUD_XYZ = new Int16Array([")[1].split("])")[0]
    lens = np.array(body.split(","), float).reshape(-1, 3) / 32767
    print(f"lens TS == cloud_subset: max |d| = {np.abs(lens - cloud).max():.2e}")
    print(f"space: 1 cloud unit = {man['space']['unit_um']:.1f} um")

    brain, vnc = load(man["shells"]["brain_shell"]["file"]), load(man["shells"]["vnc_shell"]["file"])
    lo, hi = trimesh.util.concatenate([brain, vnc]).bounds
    print("cloud bbox ", cloud.min(0).round(3), cloud.max(0).round(3))
    print("shell bbox ", lo.round(3), hi.round(3))
    print("bbox diff min/max (um)", ((cloud.min(0) - lo) / um).round(0), ((cloud.max(0) - hi) / um).round(0))

    src = pc["placed_from"][cs["idx"]]
    for label, meshes in (("decimated", [brain, vnc]),
                          ("full-res ", [roi_mesh(sp, [("brain-shell-v2.2", "brain-shell")]),
                                         roi_mesh(sp, [("vnc-shell-v2", "vnc-shell")])])):
        ins = inside(meshes, cloud)
        out = cloud[~ins]
        d = np.min([dist(m, out) for m in meshes], 0) / um if len(out) else np.zeros(1)
        print(f"{label} shells: cloud inside {ins.mean():.1%} ({(~ins).sum()} outside: median "
              f"{np.median(d):.1f} um, 95% {np.percentile(d, 95):.1f} um from the surface)")
        print("   by placement: " + ", ".join(
            f"{k} {ins[src == k].mean():.1%} of {(src == k).sum()}"
            for k in ("soma", "partners", "centroid") if (src == k).any()))

    for name, rec in man["neuropils"].items():
        v = load(rec["file"]).vertices
        print(f"neuropil {name:14s} {rec['tris']:5d} tris, verts inside shell {inside([brain, vnc], v).mean():.0%}")

    idx_of = {int(b): i for i, b in enumerate(pc["ids"])}
    in_subset = set(cs["idx"].tolist())
    for tag, rec in man["neurons"].items():
        m = load(rec["file"])
        j = idx_of[rec["bodyId"]]
        dc = np.linalg.norm(pc["xyz"][j] - np.array(rec["soma"])) / um
        full = sp.mesh(*read_ngmesh(RAW / f"neurons/{rec['bodyId']}.ngmesh"))
        soma = np.array([rec["soma"]])
        sk = json.loads((OUT / rec["skeleton"]).read_text())
        pts = np.concatenate([np.array(p).reshape(-1, 3) for p in sk["polylines"]])
        dsk = dist(m, pts) / um
        print(f"{tag:22s} {rec['tris']:5d} tris | in lens cloud {'Y' if j in in_subset else 'n'} | "
              f"soma vs cloud pt {dc:4.2f} um | soma->mesh full {dist(full, soma)[0] / um:4.1f} "
              f"dec {dist(m, soma)[0] / um:4.1f} um | skel pts <=3 um from dec mesh {np.mean(dsk <= 3):.0%}")


if __name__ == "__main__":
    main()
