"""Build the fly treat as a GLB (Blender headless), the same pipeline as fly_model/build_glb.py.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        --python tools/treats/build_treat.py -- [apple|strawberry]

Why: the first treat was a 4.4 MB "honey banana slice" nobody could read at 8 cm (12.09 Pavlo:
"generate a proper 3D food model, right now it's unclear what that even is"). A treat has to read
as food from two metres, at 8 cm, next to 17.5 cm holographic flies: few big shapes, strong
silhouette, saturated colour.

The mesh is built so its LONGEST axis is exactly 1 unit, the convention FlySwarm.makeTreat relies
on (`setLocalScale(TREAT_CM)` = "generated mesh = 1 cm longest axis").
"""
import json
import struct
import sys
from pathlib import Path

import bpy  # type: ignore
from mathutils import Vector  # type: ignore

KIND = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "apple"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / "treats" / "out"
OUT.mkdir(parents=True, exist_ok=True)


def glb_extent(path: Path):
    """Longest POSITION axis of an existing GLB, to copy its size convention."""
    try:
        data = path.read_bytes()
        n = struct.unpack_from("<I", data, 12)[0]
        gltf = json.loads(data[20 : 20 + n])
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for mesh in gltf.get("meshes", []):
            for prim in mesh.get("primitives", []):
                acc = gltf["accessors"][prim["attributes"]["POSITION"]]
                for i in range(3):
                    lo[i] = min(lo[i], acc["min"][i])
                    hi[i] = max(hi[i], acc["max"][i])
        return max(hi[i] - lo[i] for i in range(3))
    except Exception as e:  # noqa: BLE001
        print("could not read", path.name, e)
        return None


def material(name, rgb, rough=0.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


bpy.ops.wm.read_factory_settings(use_empty=True)

if KIND == "strawberry":
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=0.5)
    body = bpy.context.object
    body.scale = (0.85, 0.85, 1.0)
    # taper to a point at the bottom
    for v in body.data.vertices:
        k = (0.5 - v.co.z) / 1.0  # 0 at top, 1 at bottom
        v.co.x *= 1.0 - 0.55 * k * k
        v.co.y *= 1.0 - 0.55 * k * k
    body.data.materials.append(material("Berry", (0.75, 0.05, 0.09), 0.35))
    parts = [body]
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.34, radius2=0.0, depth=0.22, location=(0, 0, 0.52))
    calyx = bpy.context.object
    calyx.rotation_euler = (3.14159, 0, 0)
    calyx.data.materials.append(material("Leaf", (0.18, 0.55, 0.16), 0.55))
    parts.append(calyx)
else:  # apple
    bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=18, radius=0.5)
    body = bpy.context.object
    body.scale = (1.0, 1.0, 0.92)
    # dimple the top and bottom, like a real apple
    for v in body.data.vertices:
        r = (v.co.x ** 2 + v.co.y ** 2) ** 0.5
        dip = max(0.0, 1.0 - r / 0.22)
        v.co.z -= 0.12 * dip * (1 if v.co.z > 0 else -1)
    body.data.materials.append(material("Apple", (0.78, 0.07, 0.08), 0.3))
    parts = [body]
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.035, depth=0.3, location=(0, 0, 0.5))
    stem = bpy.context.object
    stem.rotation_euler = (0.18, 0, 0)
    stem.data.materials.append(material("Stem", (0.28, 0.17, 0.07), 0.7))
    parts.append(stem)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.16, location=(0.16, 0, 0.56))
    leaf = bpy.context.object
    leaf.scale = (1.5, 0.75, 0.08)
    leaf.rotation_euler = (0, 0.35, 0)
    leaf.data.materials.append(material("Leaf", (0.2, 0.6, 0.18), 0.5))
    parts.append(leaf)

for o in parts:
    shade_smooth(o)
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
obj = bpy.context.object
obj.name = KIND

# centre it and normalise the longest axis to 1 unit (FlySwarm scales by TREAT_CM)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for v in obj.data.vertices:
    lo = Vector((min(lo[i], v.co[i]) for i in range(3)))
    hi = Vector((max(hi[i], v.co[i]) for i in range(3)))
centre = (lo + hi) / 2
size = max(hi[i] - lo[i] for i in range(3))
# the first treat (the 4.4 MB banana, no longer in the tree) was 0.997 u on its longest axis; keep that convention
target = 0.997
for v in obj.data.vertices:
    v.co = (v.co - centre) * (target / size)
print(f"{KIND}: built {size:.3f} u -> normalised to {target:.3f} u (banana convention)")

glb = OUT / f"{KIND}.glb"
bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", export_yup=True, export_animations=False)
tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
print(f"exported {glb} {glb.stat().st_size / 1024:.0f} KB, {tris} tris")
