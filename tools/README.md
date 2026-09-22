# tools/

Offline generators for lens assets. Each was run once to make the outputs committed next to it; re-run only to regenerate. Raw downloads stay out of git in `$CYBERFLY_RUNTIME` (default `~/cyberfly_runtime`). Run from the repo root; `uv run --with-requirements` builds a throwaway env with the pinned versions (no venv to manage).

## anim/: fly motion clips for the flybody rig
`convert.py` turns recorded fly motion into per-bone quaternion clips for the lens rig. The GLB bone rest rotations equal the flybody MJCF body rotations, and a self-test checks the composition against MuJoCo's own forward kinematics. Outputs in `out/`: `wingbeat_cycle.json` (218 Hz), `walk_cycle.json`, `walk_steps_cpg.json`, `poses.json` (leg tuck, wing fold), `saccade_body.json`; `--render` also writes `check_sheet.png`. How the lens will use them: COMPONENTS "Fly motion sources".

Inputs (not in git):
- `$CYBERFLY_RUNTIME/flybody`: `git clone https://github.com/TuragaLab/flybody` (the MJCF model);
- `$CYBERFLY_RUNTIME/anim/flybody-data/`: files from the flybody figshare dataset (doi:10.25378/janelia.25309105), ~104 MB: `flight/wing_pattern_fmech.npy`, `flight/flight-dataset_saccade-evasion_augmented.hdf5`, `walking/walking-dataset-small_female-only_snippets-100_min-len-0.5s_trk-files-0-9.hdf5`;
- `$CYBERFLY_RUNTIME/anim/flygym-data/single_steps_flybody.npz`: flygym's per-leg single steps for the flybody anatomy (NeLy-EPFL/flygym).

```sh
uv run --with-requirements tools/anim/requirements.txt python tools/anim/convert.py --render
```

**Licence:** the figshare motion data is GPL-3.0-or-later, and so are the three clips derived from it (`wingbeat_cycle`, `walk_cycle`, `saccade_body`): they are redistributed here under that licence, not under the repository's MIT, and the lens does not ship them (nothing in either `Assets/` reads them; they are the generator's record). `poses.json` comes from the flybody model (Apache-2.0) and `walk_steps_cpg.json` from flygym (Apache-2.0). Every clip carries its own `source` and `license` fields.

## anatomy/: MaleCNS brain meshes in the BrainCloud space
Native MaleCNS v1.0 anatomy from Janelia's public bucket `gs://flyem-male-cns` (no token needed), transformed into exactly the lens brain-cloud space. Outputs in `out/` (~10 MB): `shells/` (brain, VNC), `neuropils/` (14 groups), `neurons/` (39 command neurons, GLB), `skeletons/*.json`, `manifest.json`. Gotchas and placement: COMPONENTS "Brain anatomy assets".

```sh
R=tools/anatomy/requirements.txt
uv run --with-requirements $R python tools/anatomy/fetch.py     # ~0.9 GB -> $CYBERFLY_RUNTIME/anatomy/raw
uv run --with-requirements $R python tools/anatomy/process.py   # raw -> out/ (reuses existing shell/neuropil GLBs; delete them to rebuild)
uv run --with-requirements $R python tools/anatomy/verify.py    # overlay check against brain/results/cloud_subset.npz
```
Needs fly-wirehead's `data/annotations.feather` (`scripts/setup_mac.sh`).

**Licence:** Janelia male-cns meshes and skeletons are CC BY 4.0: credit Janelia FlyEM and the MaleCNS consortium wherever they are shown.
