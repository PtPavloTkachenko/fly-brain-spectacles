"""Dump the flybody fruit-fly MJCF: body tree, visual geoms (mesh + local pose), joints.

Output `fly_model/out/fly_rig.json` — the contract the GLB builder and the lens animator share:
every body is a node (local pos/quat vs parent, MuJoCo w-x-y-z quat), its visual meshes, and
the hinge joints that rotate it (axis in the body frame, range in radians).

    git clone https://github.com/TuragaLab/flybody "$CYBERFLY_RUNTIME/flybody"   # once
    uv run --with mujoco python fly_model/dump_mjcf.py [path/to/flybody]   # default $CYBERFLY_RUNTIME/flybody
"""

import json
import os
import sys
from pathlib import Path

import mujoco

RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
ROOT = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else RUNTIME / "flybody"
XML = ROOT / "flybody/fruitfly/assets/fruitfly.xml"
OUT = Path(__file__).with_name("out")

m = mujoco.MjModel.from_xml_path(str(XML))
name = lambda kind, i: mujoco.mj_id2name(m, kind, i) or f"{kind.name}_{i}"

bodies = []
for b in range(m.nbody):
    geoms = []
    for g in range(m.body_geomadr[b], m.body_geomadr[b] + m.body_geomnum[b]):
        if m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH or m.geom_group[g] != 1:
            continue
        mesh = m.geom_dataid[g]
        geoms.append({
            "geom": name(mujoco.mjtObj.mjOBJ_GEOM, g),
            "mesh": name(mujoco.mjtObj.mjOBJ_MESH, mesh),
            "pos": m.geom_pos[g].tolist(),
            "quat": m.geom_quat[g].tolist(),
            "material": name(mujoco.mjtObj.mjOBJ_MATERIAL, m.geom_matid[g]) if m.geom_matid[g] >= 0 else None,
            "rgba": m.geom_rgba[g].tolist(),
        })
    joints = []
    for j in range(m.body_jntadr[b], m.body_jntadr[b] + m.body_jntnum[b]):
        if m.jnt_type[j] != mujoco.mjtJoint.mjJNT_HINGE:
            joints.append({"joint": name(mujoco.mjtObj.mjOBJ_JOINT, j), "type": int(m.jnt_type[j])})
            continue
        joints.append({
            "joint": name(mujoco.mjtObj.mjOBJ_JOINT, j),
            "axis": m.jnt_axis[j].tolist(),
            "pos": m.jnt_pos[j].tolist(),
            "range": m.jnt_range[j].tolist() if m.jnt_limited[j] else None,
        })
    bodies.append({
        "body": name(mujoco.mjtObj.mjOBJ_BODY, b),
        "parent": name(mujoco.mjtObj.mjOBJ_BODY, m.body_parentid[b]) if b else None,
        "pos": m.body_pos[b].tolist(),
        "quat": m.body_quat[b].tolist(),
        "geoms": geoms,
        "joints": joints,
    })

materials = {
    name(mujoco.mjtObj.mjOBJ_MATERIAL, i): m.mat_rgba[i].tolist() for i in range(m.nmat)
}
mesh_files = {}
for i in range(m.nmesh):
    mesh_files[name(mujoco.mjtObj.mjOBJ_MESH, i)] = {
        "verts": int(m.mesh_vertnum[i]),
        "faces": int(m.mesh_facenum[i]),
        "scale": m.mesh_scale[i].tolist() if hasattr(m, "mesh_scale") else None,
    }

OUT.mkdir(exist_ok=True)
# Compiled mesh arrays, NOT the raw OBJs: MuJoCo recentres each mesh (and applies the 0.1
# scale), and geom_pos/geom_quat above are only valid for these compiled vertices.
arrays = {}
for i in range(m.nmesh):
    n = name(mujoco.mjtObj.mjOBJ_MESH, i)
    v0, nv = m.mesh_vertadr[i], m.mesh_vertnum[i]
    f0, nf = m.mesh_faceadr[i], m.mesh_facenum[i]
    arrays[f"{n}__v"] = m.mesh_vert[v0 : v0 + nv].astype("float32")
    arrays[f"{n}__f"] = m.mesh_face[f0 : f0 + nf].astype("int32")
import numpy as np

np.savez_compressed(OUT / "fly_meshes.npz", **arrays)
# machine-independent source path (no /Users/<name> in the tracked JSON)
src = str(XML).replace(str(RUNTIME), "$CYBERFLY_RUNTIME").replace(str(Path.home()), "~")
(OUT / "fly_rig.json").write_text(json.dumps({"source": src, "bodies": bodies, "materials": materials, "meshes": mesh_files}, indent=1))

hinge = sum(1 for b in bodies for j in b["joints"] if "axis" in j)
vis = sum(len(b["geoms"]) for b in bodies)
faces = sum(v["faces"] for v in mesh_files.values())
print(f"bodies {len(bodies)}, visual mesh geoms {vis}, hinge joints {hinge}, mesh faces total {faces}")
print("materials:", materials)
for b in bodies:
    js = ",".join(j["joint"] for j in b["joints"])
    gs = ",".join(g["mesh"] for g in b["geoms"])
    print(f"  {b['body']:<22} <- {str(b['parent']):<18} joints[{js}] meshes[{gs}]")
