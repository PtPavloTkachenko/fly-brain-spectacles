"""Build a Spectacles-ready skinned fruit fly GLB from the flybody MJCF dump.

One skinned mesh (all parts), one armature whose bones ARE the MJCF bodies (bone frame ==
body frame, bone head == joint pivot), two materials: `fly_body` (opaque, colours in vertex
colour COLOR_0) and `fly_wing` (translucent membrane). Every part is decimated to a per-part
triangle budget so the whole fly stays small enough to share the lens with the brain cloud.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        --python fly_model/build_glb.py -- [lod0|lod1]

Inputs: out/fly_rig.json + out/fly_meshes.npz (from dump_mjcf.py).
Outputs: out/fly_<lod>.glb, out/fly_<lod>_bones.json, out/fly_<lod>_preview_*.png
"""

import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
LOD = (sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "lod0")
LENGTH_M = 0.35  # giant fly: head-to-abdomen length in metres
# Per-part triangle budgets (lod0). lod1 = x0.25 for the status-board hologram.
BUDGET = {
    "head": 3500, "thorax": 3000, "abdomen": 350, "abdomen_2": 250, "abdomen_3": 250,
    "abdomen_4": 250, "abdomen_5": 250, "abdomen_6": 250, "abdomen_7": 400,
    "rostrum": 350, "haustellum": 300, "labrum_left": 80, "labrum_right": 80,
    "antenna_left": 300, "antenna_right": 300, "wing_left": 400, "wing_right": 400,
    "haltere_left": 80, "haltere_right": 80,
    "coxa": 150, "femur": 220, "tibia": 160, "tarsus": 220,
}
SCALE_BUDGET = {"lod0": 0.65, "lod1": 0.2}[LOD]  # ADR 13: 5 flies -> ~10k / ~3k tris
MIN_TRIS = 24

rig = json.loads((OUT / "fly_rig.json").read_text())
arrays = np.load(OUT / "fly_meshes.npz")
materials = rig["materials"]
# the user, 2026-09-11: "make the fly green" — juicy green body, red eyes kept for contrast.
# Bright + saturated also reads better on the additive Spectacles display than brown.
materials.update({
    "body": [0.30, 0.85, 0.30, 1.0],
    "lower": [0.62, 0.95, 0.55, 1.0],
    "brown": [0.06, 0.32, 0.12, 1.0],
    "bristle-brown": [0.02, 0.18, 0.06, 1.0],
    "black": [0.02, 0.14, 0.05, 1.0],
    "ocelli": [0.85, 1.0, 0.4, 1.0],
    "membrane": [0.65, 0.95, 0.75, 0.4],
})


def bone_of(body):
    """Fold the 4 distal tarsal segments + claw into one `tarsus_<leg>` bone."""
    for prefix in ("tarsus2_", "tarsus3_", "tarsus4_", "claw_"):
        if body.startswith(prefix):
            return "tarsus_" + body[len(prefix):]
    return body


def budget_of(bone):
    if bone in BUDGET:
        return BUDGET[bone]
    return BUDGET[bone.split("_")[0]]


def mj_quat(q):
    return Quaternion((q[0], q[1], q[2], q[3]))


# World transform of every MJCF body (MuJoCo quats are w,x,y,z like mathutils).
world = {}
for b in rig["bodies"]:
    local = Matrix.Translation(Vector(b["pos"])) @ mj_quat(b["quat"]).to_matrix().to_4x4()
    world[b["body"]] = (world[b["parent"]] if b["parent"] else Matrix.Identity(4)) @ local

# Gather geometry in fly-world coordinates, grouped by (bone, material kind).
parts = {}
for b in rig["bodies"]:
    for g in b["geoms"]:
        v = arrays[g["mesh"] + "__v"].astype(np.float64)
        f = arrays[g["mesh"] + "__f"]
        m = world[b["body"]] @ Matrix.Translation(Vector(g["pos"])) @ mj_quat(g["quat"]).to_matrix().to_4x4()
        M = np.array(m)
        vw = v @ M[:3, :3].T + M[:3, 3]
        kind = "wing" if g["material"] == "membrane" else "body"
        rgba = materials.get(g["material"], g["rgba"])
        parts.setdefault((bone_of(b["body"]), kind), []).append((vw, f, rgba))

all_v = np.concatenate([p[0] for lst in parts.values() for p in lst])
root = np.array(world["thorax"])[:3, 3]
length = np.ptp(all_v[:, 0])
S = LENGTH_M / length
print(f"fly length {length:.4f} model units -> scale {S:.2f}")


def to_scene(p):
    return (np.asarray(p) - root) * S


def linear(rgba):
    """MJCF colours are display (sRGB) values; glTF COLOR_0 / base colour are linear.
    Storing them raw made LS render the fly washed-out cream instead of brown."""
    c = np.array(rgba, dtype=np.float64)
    rgb = c[..., :3]
    c[..., :3] = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return c


# --- scene ---------------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)

mat_body = bpy.data.materials.new("fly_body")
mat_body.use_nodes = True
nt = mat_body.node_tree
bsdf = nt.nodes["Principled BSDF"]
attr = nt.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "Col"
nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.45

mat_wing = bpy.data.materials.new("fly_wing")
mat_wing.use_nodes = True
wb = mat_wing.node_tree.nodes["Principled BSDF"]
wb.inputs["Base Color"].default_value = linear(materials["membrane"]).tolist()
wb.inputs["Alpha"].default_value = 0.35
wb.inputs["Roughness"].default_value = 0.2
try:
    mat_wing.surface_render_method = "BLENDED"
except AttributeError:
    mat_wing.blend_method = "BLEND"

objects = []
stats = {}
for (bone, kind), lst in parts.items():
    verts, faces, colors = [], [], []
    base = 0
    for vw, f, rgba in lst:
        verts.append(to_scene(vw))
        faces.append(f + base)
        colors.append(np.tile(linear(rgba), (len(vw), 1)))
        base += len(vw)
    verts, faces, colors = np.concatenate(verts), np.concatenate(faces), np.concatenate(colors)
    # MuJoCo hands back unwelded triangles; weld coincident vertices so decimation can
    # actually collapse edges (otherwise it strips faces and leaves the vertices behind).
    key = np.round(verts / 1e-6).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    verts, colors = verts[first], colors[first]
    faces = inverse.ravel()[faces]
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    me = bpy.data.meshes.new(f"{bone}_{kind}")
    me.from_pydata(verts.tolist(), [], faces.tolist())
    me.update()
    col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    col.data.foreach_set("color", colors.astype(np.float32).ravel())
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat_wing if kind == "wing" else mat_body)
    # Budget split between a bone's body/wing parts by their share of its triangles.
    share = len(faces) / sum(sum(len(x[1]) for x in parts[k]) for k in parts if k[0] == bone)
    target = max(MIN_TRIS, int(budget_of(bone) * SCALE_BUDGET * share))
    if len(faces) > target:
        dec = ob.modifiers.new("dec", "DECIMATE")
        dec.ratio = target / len(faces)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier="dec")
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    vg = ob.vertex_groups.new(name=bone)
    vg.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
    stats[f"{bone}_{kind}"] = (len(faces), len(ob.data.polygons))
    objects.append(ob)

# --- armature: bone frame == MJCF body frame, head at the (first) joint pivot -------------
arm = bpy.data.armatures.new("FlyRig")
rig_ob = bpy.data.objects.new("FlyRig", arm)
bpy.context.scene.collection.objects.link(rig_ob)
bpy.context.view_layer.objects.active = rig_ob
bpy.ops.object.mode_set(mode="EDIT")
bone_len = 0.02 * LENGTH_M
edit = {}
kept = []
for b in rig["bodies"]:
    name = b["body"]
    if name == "world" or bone_of(name) != name:
        continue
    W = world[name]
    R = W.to_3x3()
    pivot = Vector(b["joints"][0]["pos"]) if b["joints"] and "pos" in b["joints"][0] else Vector((0, 0, 0))
    head = Vector(to_scene(np.array(W @ pivot)))
    eb = arm.edit_bones.new(name)
    eb.head = head
    eb.tail = head + R.col[1].normalized() * bone_len
    eb.align_roll(R.col[2])
    edit[name] = eb
    kept.append(b)
for b in kept:
    parent = b["parent"]
    while parent and parent not in edit:
        parent = next(x["parent"] for x in rig["bodies"] if x["body"] == parent)
    if parent:
        edit[b["body"]].parent = edit[parent]
# EditBone references die when edit mode exits — keep the parent names as plain strings.
bone_parent = {n: (eb.parent.name if eb.parent else None) for n, eb in edit.items()}
bpy.ops.object.mode_set(mode="OBJECT")

# Join all parts into one skinned mesh.
bpy.ops.object.select_all(action="DESELECT")
for ob in objects:
    ob.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.join()
fly = bpy.context.view_layer.objects.active
fly.name = fly.data.name = f"fly_{LOD}"
fly.data.validate()
# Smooth shading: organic look, and flat shading would split every triangle's vertices.
fly.data.polygons.foreach_set("use_smooth", [True] * len(fly.data.polygons))
fly.data.update()
fly.parent = rig_ob
mod = fly.modifiers.new("rig", "ARMATURE")
mod.object = rig_ob
tris = sum(len(p.vertices) - 2 for p in fly.data.polygons)
print(f"{LOD}: {len(fly.data.vertices)} verts, {tris} tris, {len(arm.bones)} bones, "
      f"materials {[m.name for m in fly.data.materials]}")

# --- pose check (`-- lod0 --poses`): render the lens animator's joint rotations -------------
# Pose bones rotate in the bone-local frame == MJCF body frame, exactly like the lens does
# (rest * angleAxis(angle, axis_body)), so these renders show the lens poses 1:1.
if "--poses" in sys.argv:
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    legs = ["T1_left", "T2_left", "T3_left", "T1_right", "T2_right", "T3_right"]
    # Batch 1 (11.09) found: rest = wings spread sideways; Z with the SAME sign on both
    # wings = symmetric up/down stroke (right wing frame is mirrored); femur -0.5 = tuck.
    # Batch 2: which single axis folds the wings back over the abdomen when landed.
    both = lambda axis, a: {"wing_left": [(axis, a)], "wing_right": [(axis, a)]}
    POSES = {
        "flap_up": both(Z, 0.6),
        "flap_down": both(Z, -0.6),
        "fold_x+": both(X, 1.2),
        "fold_x-": both(X, -1.2),
        "fold_y+": both(Y, 1.2),
        "fold_y-": both(Y, -1.2),
        "tuck": {**{"femur_" + l: [(X, -0.5)] for l in legs}},
    }
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "VERTEX"
    scene.render.resolution_x, scene.render.resolution_y = 600, 400
    cam = bpy.data.objects.new("pcam", bpy.data.cameras.new("pcam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {"top": (0.0, 0.0, 0.8), "side": (0.0, -0.85, 0.05), "front": (0.85, 0.0, 0.1)}
    for pname, rots in POSES.items():
        for pb in rig_ob.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = Quaternion()
        for bone, lst in rots.items():
            q = Quaternion()
            for axis, angle in lst:
                q = q @ Quaternion(axis, angle)
            rig_ob.pose.bones[bone].rotation_quaternion = q
        bpy.context.view_layer.update()
        for vname, loc in views.items():
            cam.location = Vector(loc)
            cam.rotation_euler = (-cam.location).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(OUT / "poses" / f"{pname}__{vname}.png")
            bpy.ops.render.render(write_still=True)
    print("poses rendered:", list(POSES))
    sys.exit(0)

# --- export ---------------------------------------------------------------------------------
glb = OUT / f"fly_{LOD}.glb"
kwargs = dict(filepath=str(glb), export_format="GLB", export_skins=True, export_animations=False, export_yup=True)
try:
    bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="ACTIVE")
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)

# Joint contract for the lens animator: axes in the bone's local frame (== MJCF body frame),
# plus the same axis after Blender->glTF Y-up conversion (x, z, -y). Verify in LS.
bones = []
for b in kept:
    joints = [
        {"joint": j["joint"], "axis_body": j["axis"], "axis_gltf": [j["axis"][0], j["axis"][2], -j["axis"][1]],
         "range": j.get("range")}
        for j in b["joints"] if "axis" in j
    ]
    folded = [x["body"] for x in rig["bodies"] if bone_of(x["body"]) == b["body"] and x["body"] != b["body"]]
    bones.append({"bone": b["body"], "parent": bone_parent[b["body"]], "joints": joints, "folded_bodies": folded})
(OUT / f"fly_{LOD}_bones.json").write_text(json.dumps(
    {"lod": LOD, "tris": tris, "length_m": LENGTH_M, "scale": S, "forward": "+X (MJCF) -> glTF +X",
     "up": "MJCF +Z -> glTF +Y", "bones": bones}, indent=1))
print("exported", glb, f"{glb.stat().st_size / 1e6:.2f} MB")

# --- previews (Workbench, vertex colours) ---------------------------------------------------
scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.color_type = "VERTEX"
scene.display.shading.light = "STUDIO"
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
scene.render.film_transparent = False
world_bg = bpy.data.worlds.new("bg")
scene.world = world_bg
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
scene.collection.objects.link(cam)
scene.camera = cam
for tag, loc in {"threequarter": (0.45, -0.55, 0.35), "top": (0.0, 0.0, 0.75), "side": (0.0, -0.8, 0.02)}.items():
    cam.location = Vector(loc)
    direction = -cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(OUT / f"fly_{LOD}_preview_{tag}.png")
    bpy.ops.render.render(write_still=True)
print("previews written")
