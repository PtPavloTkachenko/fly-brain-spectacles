"""Turn raw MaleCNS anatomy (fetch.py) into Lens-Studio-ready assets in the BrainCloud space.

Space: exactly the lens cloud (`BrainCloudData.ts` / `pointcloud.npz`): MaleCNS voxels (8 nm)
-> y flipped (up) -> centred on the 166,700-neuron bbox -> divided by half its largest extent,
i.e. unit coords in [-1, 1] (x right, y up, z = MaleCNS z, the brain->VNC long axis).
The per-axis affine is FITTED from the soma-placed cloud points (exact to float32).

Out (in git): tools/anatomy/out/{shells,neuropils,neurons}/*.glb, out/skeletons/*.json, out/manifest.json
Existing shell/neuropil GLBs are reused; delete them to rebuild.
    uv run --with-requirements tools/anatomy/requirements.txt python tools/anatomy/process.py
"""
import json
import os
from pathlib import Path

import fast_simplification
import numpy as np
import pandas as pd
import trimesh

HERE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
RAW, OUT = RUNTIME / "anatomy/raw", HERE / "out"
PC = HERE.parents[1] / "brain/results/pointcloud.npz"
ANN = Path(os.environ.get("FLYWIREHEAD_DATA", RUNTIME / "fly-wirehead/data")) / "annotations.feather"

SHELL_TRIS, NEUROPIL_TRIS, NEURON_TRIS = 8000, 3000, 2000
FB, VN, MS = "fullbrain-roi-v5", "malecns-vnc-neuropil-roi-v0", "fullbrain-major-shells"
MB = ["CA", "PED", "aL", "a'L", "bL", "b'L", "gL"]
SHELLS = {"brain_shell": [("brain-shell-v2.2", "brain-shell")],
          "vnc_shell": [("vnc-shell-v2", "vnc-shell")]}
NEUROPILS = {
    "OL_L": [(MS, "OL(L)")], "OL_R": [(MS, "OL(R)")],
    "MB_L": [(FB, f"{r}(L)") for r in MB], "MB_R": [(FB, f"{r}(R)") for r in MB],
    "CX": [(FB, r) for r in ["EB", "FB", "PB", "NO", "AB(L)", "AB(R)"]],
    "AL_L": [(FB, "AL(L)")], "AL_R": [(FB, "AL(R)")],
    "LH_L": [(FB, "LH(L)")], "LH_R": [(FB, "LH(R)")],
    "SEZ": [(FB, r) for r in ["GNG", "PRW", "SAD", "FLA(L)", "FLA(R)", "CAN(L)", "CAN(R)"]],
    "VNC_LegNp_T1": [(VN, "LegNp(T1)(L)"), (VN, "LegNp(T1)(R)")],
    "VNC_LegNp_T2": [(VN, "LegNp(T2)(L)"), (VN, "LegNp(T2)(R)")],
    "VNC_LegNp_T3": [(VN, "LegNp(T3)(L)"), (VN, "LegNp(T3)(R)")],
    "VNC_Tectulum": [(VN, n) for n in ["IntTct", "LTct", "NTct(UTct-T1)(L)", "NTct(UTct-T1)(R)",
                                       "WTct(UTct-T2)(L)", "WTct(UTct-T2)(R)",
                                       "HTct(UTct-T3)(L)", "HTct(UTct-T3)(R)"]],
    "VNC_ANm": [(VN, "ANm")],
    "VNC_Ov_mVAC": [(VN, f"{r}({s})") for r in ["Ov"] for s in "LR"]
                   + [(VN, f"mVAC(T{t})({s})") for t in (1, 2, 3) for s in "LR"],
}


def fit_transform():
    """Per-axis affine voxel -> cloud unit, fitted on the soma-placed cloud points."""
    pc = np.load(PC)
    a = pd.read_feather(ANN).set_index("bodyId")
    m = pc["placed_from"] == "soma"
    ids = pc["ids"][m]
    loc = a.loc[ids, "somaLocation"].to_numpy()
    tos = a.loc[ids, "tosomaLocation"].to_numpy()
    vox = np.array([l if l is not None else t for l, t in zip(loc, tos)], float)
    scale, off, err = np.zeros(3), np.zeros(3), 0.0
    for k in range(3):
        A = np.c_[vox[:, k], np.ones(len(vox))]
        (scale[k], off[k]), *_ = np.linalg.lstsq(A, pc["xyz"][m][:, k].astype(float), rcond=None)
        err = max(err, float(np.abs(A @ [scale[k], off[k]] - pc["xyz"][m][:, k]).max()))
    return scale, off, err


def read_ngmesh(path):
    d = path.read_bytes()
    nv = int(np.frombuffer(d[:4], np.uint32)[0])
    v = np.frombuffer(d[4:4 + 12 * nv], np.float32).reshape(-1, 3).astype(np.float64)
    f = np.frombuffer(d[4 + 12 * nv:], np.uint32).reshape(-1, 3).astype(np.int64)
    return v, f


def read_skel(path):
    d = path.read_bytes()
    nv, ne = (int(x) for x in np.frombuffer(d[:8], np.uint32))
    v = np.frombuffer(d[8:8 + 12 * nv], np.float32).reshape(-1, 3).astype(np.float64)
    e = np.frombuffer(d[8 + 12 * nv:8 + 12 * nv + 8 * ne], np.uint32).reshape(-1, 2).astype(np.int64)
    return v, e


def decimate(mesh, target, keep_frac=0.0):
    v, f = mesh.vertices, mesh.faces
    if len(f) > target:
        # the simplifier can stall above target on thin tubes: re-run on its own output with a
        # tighter ratio, bounded (each pass is cheap once the mesh is small)
        v, f = fast_simplification.simplify(v, f, target_reduction=1.0 - target / len(f))
        for _ in range(6):
            if len(f) <= target:
                break
            v, f = fast_simplification.simplify(v, f, target_reduction=1.0 - 0.9 * target / len(f))
    out = trimesh.Trimesh(v, f, process=True)
    out.remove_unreferenced_vertices()
    if keep_frac > 0:
        parts = out.split(only_watertight=False)
        big = [p for p in parts if len(p.faces) >= keep_frac * len(out.faces)]
        if big:
            out = trimesh.util.concatenate(big)
    return out


class Space:
    def __init__(self):
        self.scale, self.off, self.fit_err = fit_transform()

    def nm(self, p):
        return (p / 8.0) * self.scale + self.off

    def vox(self, p):
        return np.asarray(p, float) * self.scale + self.off

    def mesh(self, v_nm, f):
        # the y flip mirrors the mesh: reverse winding so normals stay outward
        return trimesh.Trimesh(self.nm(v_nm), f[:, ::-1], process=False)


def roi_mesh(sp, parts):
    ms = []
    for layer, name in parts:
        v, f = read_ngmesh(RAW / "rois" / layer / f"{name}.ngmesh")
        ms.append(sp.mesh(v, f))
    return trimesh.util.concatenate(ms)


def export(mesh, path, name):
    path.parent.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    scene.add_geometry(mesh, node_name=name, geom_name=name)
    path.write_bytes(scene.export(file_type="glb"))


def polylines(v, e, tol):
    """Skeleton -> unbranched polylines (branch/leaf to branch/leaf), thinned so consecutive
    kept points are >= tol apart (endpoints always kept)."""
    n = len(v)
    adj = [[] for _ in range(n)]
    for a, b in e:
        adj[a].append(b)
        adj[b].append(a)
    deg = np.array([len(x) for x in adj])
    seen_edge, lines = set(), []
    for s in np.flatnonzero(deg != 2):
        for nb in adj[s]:
            if (s, nb) in seen_edge:
                continue
            line, prev, cur = [s], s, nb
            seen_edge.update({(s, nb), (nb, s)})
            while deg[cur] == 2:
                line.append(cur)
                nxt = adj[cur][0] if adj[cur][0] != prev else adj[cur][1]
                seen_edge.update({(cur, nxt), (nxt, cur)})
                prev, cur = cur, nxt
            line.append(cur)
            keep, last = [line[0]], v[line[0]]
            for i in line[1:-1]:
                if np.linalg.norm(v[i] - last) >= tol:
                    keep.append(i)
                    last = v[i]
            keep.append(line[-1])
            lines.append(keep)
    return lines


def main():
    sp = Space()
    man = {"space": {
        "desc": "BrainCloudData.ts unit space: MaleCNS voxel (8 nm) v -> u = scale*v + offset "
                "(y scale negative = flipped up); x right, y up, z = MaleCNS z (brain -> VNC)",
        "scale_per_voxel": sp.scale.tolist(), "offset": sp.off.tolist(),
        "fit_max_err": sp.fit_err, "unit_um": 8e-3 / abs(sp.scale[0]),  # microns per cloud unit
    }, "shells": {}, "neuropils": {}, "neurons": {}}
    print("fit", sp.scale, sp.off, "err", sp.fit_err)

    for grp, table, budget, keep in (("shells", SHELLS, SHELL_TRIS, 0.01),
                                     ("neuropils", NEUROPILS, NEUROPIL_TRIS, 0.02)):
        for name, parts in table.items():
            full = roi_mesh(sp, parts)
            dst = OUT / grp / f"{name}.glb"
            if dst.exists():  # already built (reruns stay light on the live brain server's CPU)
                dec = trimesh.load(dst, force="mesh")
            else:
                dec = decimate(full, budget, keep)
                export(dec, dst, name)
            man[grp][name] = {"file": f"{grp}/{name}.glb", "tris": len(dec.faces),
                              "src_tris": len(full.faces), "rois": [p[1] for p in parts],
                              "bbox": dec.bounds.round(5).tolist(),
                              "watertight": bool(dec.is_watertight)}
            print(f"{grp:9s} {name:14s} {len(full.faces):8d} -> {len(dec.faces):5d}", flush=True)

    bodies = json.loads((RAW / "neurons/bodies.json").read_text())
    tol = 1.5 * abs(sp.scale[0]) * 1000 / 8  # 1.5 um in cloud units
    skel_all = []
    for b in bodies:
        i, side = b["bodyId"], b["side"] or "U"
        tag = f"{b['type']}_{side}_{i}"
        v, f = read_ngmesh(RAW / f"neurons/{i}.ngmesh")
        full = sp.mesh(v, f)
        dec = decimate(full, NEURON_TRIS)
        export(dec, OUT / "neurons" / f"{tag}.glb", tag)
        sv, se = read_skel(RAW / f"neurons/{i}.skel")
        sv = sp.nm(sv)
        lines = polylines(sv, se, tol)
        soma = sp.vox(b["soma_vox"]).round(5).tolist()
        rec = {"bodyId": i, "type": b["type"], "instance": b["instance"], "side": side,
               "soma": soma, "points": int(sum(len(l) for l in lines)),
               "polylines": [np.round(sv[l], 5).ravel().tolist() for l in lines]}
        (OUT / "skeletons").mkdir(parents=True, exist_ok=True)
        (OUT / "skeletons" / f"{tag}.json").write_text(json.dumps(rec, separators=(",", ":")))
        skel_all.append(rec)
        man["neurons"][tag] = {"file": f"neurons/{tag}.glb", "skeleton": f"skeletons/{tag}.json",
                               "bodyId": i, "type": b["type"], "side": side, "soma": soma,
                               "tris": len(dec.faces), "src_tris": len(full.faces),
                               "skel_nodes": len(sv), "skel_points": rec["points"],
                               "skel_polylines": len(lines), "bbox": dec.bounds.round(5).tolist()}
        print(f"neuron {tag:22s} {len(full.faces):8d} -> {len(dec.faces):5d} tris, "
              f"skel {len(sv):6d} -> {rec['points']:5d} pts / {len(lines)} lines", flush=True)
    (OUT / "skeletons_all.json").write_text(json.dumps(skel_all, separators=(",", ":")))
    (OUT / "manifest.json").write_text(json.dumps(man, indent=1))


if __name__ == "__main__":
    main()
