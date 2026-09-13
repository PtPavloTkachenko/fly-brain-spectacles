# tools/

Offline generators for lens assets. Each was run once and its outputs are committed next to it; re-run only to regenerate. Raw downloads stay out of git in `$CYBERFLY_RUNTIME` (default `~/cyberfly_runtime`). Run from the repo root; `uv run --with-requirements` builds a throwaway environment with pinned versions.

## anatomy/: MaleCNS brain meshes in the point-cloud space

Native MaleCNS v1.0 anatomy from Janelia's public bucket `gs://flyem-male-cns` (no token needed), transformed into the exact space of the lens brain cloud. Outputs in `out/`: `shells/` (brain, nerve cord), `neuropils/` (14 groups), `neurons/` (39 command neurons), `skeletons/*.json`, `manifest.json`.

```sh
R=tools/anatomy/requirements.txt
uv run --with-requirements $R python tools/anatomy/fetch.py     # ~0.9 GB -> $CYBERFLY_RUNTIME/anatomy/raw
uv run --with-requirements $R python tools/anatomy/process.py   # raw -> out/
uv run --with-requirements $R python tools/anatomy/verify.py    # overlay check against brain/results/cloud_subset.npz
```

Needs fly-wirehead's `data/annotations.feather` (`scripts/setup_mac.sh`). Licence: CC BY 4.0, credit Janelia FlyEM and the MaleCNS collaboration wherever shown.

## anim/: poses for the flybody rig

`convert.py` turns fly motion into per-bone quaternion clips for the lens rig. The GLB bone rest rotations equal the flybody MJCF body rotations, and a self-test checks the composition against MuJoCo's forward kinematics. Committed outputs: `poses.json` (leg tuck, wing fold; from the flybody model, Apache-2.0) and `walk_steps_cpg.json` (per-leg steps; from flygym, Apache-2.0). Every clip carries its own `source` and `license` fields.

Inputs (not in git): `git clone https://github.com/TuragaLab/flybody "$CYBERFLY_RUNTIME/flybody"` and flygym's `single_steps_flybody.npz` in `$CYBERFLY_RUNTIME/anim/flygym-data/`.

```sh
uv run --with-requirements tools/anim/requirements.txt python tools/anim/convert.py
```

The script can also export clips from the flybody figshare motion dataset (doi:10.25378/janelia.25309105). That data is GPL-3.0-or-later, so those clips are not committed here.

## text/: board font atlases

`python3 tools/text/build_atlas.py` bakes Chakra Petch SemiBold and Share Tech Mono (SIL OFL 1.1) into MSDF+SDF atlases (`Spectacles/Assets/Fly/UI/Fonts/Board*.png`) and the glyph metadata as TS modules (`Scripts/Fly/Board*FontData.ts`). Needs `npm i -g msdf-bmfont-xml` and Pillow.

## treats/: the treat model

`build_treat.py` builds a simple, readable food model as a GLB in Blender, longest axis exactly 1 unit:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/treats/build_treat.py -- apple
```

## Fly body (`fly_model/`)

```sh
git clone https://github.com/TuragaLab/flybody "$CYBERFLY_RUNTIME/flybody"
uv run --with mujoco python fly_model/dump_mjcf.py          # -> out/fly_rig.json, out/fly_meshes.npz
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python fly_model/build_glb.py -- lod0   # and lod1
```

One skinned mesh, 43 bones. lod0 9,753 triangles, lod1 2,758. Copy the GLBs into `Spectacles/Assets/Fly/Models/`.
