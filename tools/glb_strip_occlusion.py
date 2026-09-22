"""Strip the dead occlusion (lightmap) texture out of an unlit GLB.

    python3 tools/glb_strip_occlusion.py Spectacles-5.23/Assets/Fly/Treats/*.glb        # dry run
    python3 tools/glb_strip_occlusion.py --write Spectacles-5.23/Assets/Fly/Treats/*.glb

Why (the 16.09 perf note, P3): every treat material carries `KHR_materials_unlit: true` AND a
1024x1024 `occlusionTexture`. An unlit pass has no occlusion term, so those maps are decoded,
uploaded and never sampled — several MB of texture memory on a device where memory is tight
and a memory-pressure killer takes the lens first.

What it does, and nothing else: drops `occlusionTexture` from every material that is unlit, then
drops the texture, the image and the bufferView that only it referenced, compacts the BIN chunk
and renumbers the indices that moved. Every other byte of every accessor, mesh, node and image is
copied through unchanged, and the script verifies that by re-reading the result and comparing each
surviving bufferView's bytes with the original's. It never touches the `.glb.meta` beside the
file, so Lens Studio keeps the asset's id and every material reference in the scene still resolves.
"""
import argparse
import json
import os
import struct
import sys

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path):
    d = open(path, "rb").read()
    magic, ver, length = struct.unpack_from("<III", d, 0)
    if magic != 0x46546C67:
        raise SystemExit("%s: not a GLB" % path)
    off, chunks = 12, []
    while off < length:
        clen, ctype = struct.unpack_from("<II", d, off)
        chunks.append((ctype, d[off + 8:off + 8 + clen]))
        off += 8 + clen
    js = next(c[1] for c in chunks if c[0] == JSON_CHUNK)
    bins = [c[1] for c in chunks if c[0] == BIN_CHUNK]
    return json.loads(js.decode("utf-8")), (bins[0] if bins else b"")


def write_glb(path, gltf, binary):
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    binary = binary + b"\0" * ((4 - len(binary) % 4) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    out = struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), JSON_CHUNK) + js
    if binary:
        out += struct.pack("<II", len(binary), BIN_CHUNK) + binary
    open(path, "wb").write(out)


def strip(path, write):
    gltf, binary = read_glb(path)
    mats = gltf.get("materials", [])
    hit = [m for m in mats if "occlusionTexture" in m and "KHR_materials_unlit" in (m.get("extensions") or {})]
    lit = [m for m in mats if "occlusionTexture" in m and "KHR_materials_unlit" not in (m.get("extensions") or {})]
    if lit:
        print("%s: SKIP, %d LIT material(s) use occlusion (it would change the look)" % (path, len(lit)))
        return
    if not hit:
        print("%s: nothing to do" % os.path.basename(path))
        return

    dropped_tex = sorted({m["occlusionTexture"]["index"] for m in hit})
    for m in hit:
        del m["occlusionTexture"]

    # a texture goes only if NOTHING else points at it any more
    used_tex = set()

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k.endswith("Texture") or k == "texture":
                    if isinstance(v, dict) and "index" in v:
                        used_tex.add(v["index"])
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk({k: v for k, v in gltf.items() if k != "textures"})
    dropped_tex = [t for t in dropped_tex if t not in used_tex]
    if not dropped_tex:
        print("%s: occlusion reference removed, textures still shared" % os.path.basename(path))
    textures = gltf.get("textures", [])
    dropped_img = sorted({textures[t]["source"] for t in dropped_tex if "source" in textures[t]})
    # keep an image that another surviving texture still uses
    still = {tx["source"] for i, tx in enumerate(textures) if i not in dropped_tex and "source" in tx}
    dropped_img = [i for i in dropped_img if i not in still]

    images = gltf.get("images", [])
    dropped_bv = sorted({images[i]["bufferView"] for i in dropped_img if "bufferView" in images[i]})

    # --- rebuild the BIN with those bufferViews removed, keeping every other byte and its alignment
    views = gltf.get("bufferViews", [])
    keep = [i for i in range(len(views)) if i not in dropped_bv]
    old_bytes = {i: bytes(binary[views[i].get("byteOffset", 0):views[i].get("byteOffset", 0) + views[i]["byteLength"]])
                 for i in range(len(views))}
    new_bin = bytearray()
    bv_map, new_views = {}, []
    for i in keep:
        while len(new_bin) % 4:
            new_bin.append(0)
        v = dict(views[i])
        v["byteOffset"] = len(new_bin)
        new_bin += old_bytes[i]
        bv_map[i] = len(new_views)
        new_views.append(v)
    gltf["bufferViews"] = new_views
    if gltf.get("buffers"):
        gltf["buffers"][0]["byteLength"] = len(new_bin)

    img_map, new_images = {}, []
    for i, im in enumerate(images):
        if i in dropped_img:
            continue
        im = dict(im)
        if "bufferView" in im:
            im["bufferView"] = bv_map[im["bufferView"]]
        img_map[i] = len(new_images)
        new_images.append(im)
    if new_images:
        gltf["images"] = new_images
    else:
        gltf.pop("images", None)

    tex_map, new_textures = {}, []
    for i, tx in enumerate(textures):
        if i in dropped_tex:
            continue
        tx = dict(tx)
        if "source" in tx:
            tx["source"] = img_map[tx["source"]]
        tex_map[i] = len(new_textures)
        new_textures.append(tx)
    if new_textures:
        gltf["textures"] = new_textures
    else:
        gltf.pop("textures", None)

    def renumber(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(v, dict) and "index" in v and (k.endswith("Texture") or k == "texture"):
                    v["index"] = tex_map[v["index"]]
                elif k == "bufferView" and isinstance(v, int):
                    o[k] = bv_map[v]
                else:
                    renumber(v)
        elif isinstance(o, list):
            for v in o:
                renumber(v)

    for key in ("accessors", "meshes", "materials", "nodes", "skins", "animations", "extensions"):
        if key in gltf:
            renumber(gltf[key])

    saved = len(binary) - len(new_bin)
    print("%-18s -%d image(s), -%d bufferView(s), BIN %d -> %d (-%.1f kB)" %
          (os.path.basename(path), len(dropped_img), len(dropped_bv), len(binary), len(new_bin), saved / 1024.0))
    if not write:
        return

    write_glb(path, gltf, bytes(new_bin))
    # --- verify: every surviving bufferView must come back byte-identical
    g2, b2 = read_glb(path)
    for old_i, new_i in bv_map.items():
        v = g2["bufferViews"][new_i]
        got = bytes(b2[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
        if got != old_bytes[old_i]:
            raise SystemExit("%s: bufferView %d changed — NOT written correctly" % (path, old_i))
    for m in g2.get("materials", []):
        if "occlusionTexture" in m:
            raise SystemExit("%s: occlusion survived" % path)
    print("   verified: %d bufferView(s) byte-identical, no occlusion left" % len(bv_map))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("glb", nargs="+")
    ap.add_argument("--write", action="store_true", help="rewrite in place (default: report only)")
    a = ap.parse_args()
    for p in a.glb:
        strip(p, a.write)
    if not a.write:
        print("\n(dry run — pass --write to rewrite in place)", file=sys.stderr)
