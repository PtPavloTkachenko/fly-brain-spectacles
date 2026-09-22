# Third-party data, code and assets

CyberFly's own code is MIT (`LICENSE`). Everything below belongs to its authors and keeps its own licence.

## Brain data

- **MaleCNS v1.0 connectome** by the MaleCNS collaboration (HHMI Janelia FlyEM, University of Cambridge, MRC Laboratory of Molecular Biology, Google Research). CC BY 4.0. https://male-cns.janelia.org/download/
  - Downloaded at setup time into the runtime folder, not stored in this repository. The exported brain file (`brain_c0*.flyb.z`, made by `core/brain_export/export.py`) and the page's data files (`web/assets/*.bin`, made by `web/make_assets.py`) are derived from it, also CC BY 4.0 with this attribution.
  - Other derived files in this repository, same licence: `brain/results/*` (neuron positions, the point-cloud sample, probe results), `Spectacles-*/Assets/Scripts/Fly/BrainCloudData.ts` and `FlyRetinaData.ts`, `tools/anatomy/out/*` and `Spectacles-*/Assets/Fly/Anatomy/*` (brain and nerve cord shells, neuropil and neuron meshes, skeletons from the public `gs://flyem-male-cns` bucket).

## Brain model, learning rule and runtime

- **Shiu et al. 2024**, *A Drosophila computational brain model reveals sensorimotor processing*, Nature 634, 210–219. https://www.nature.com/articles/s41586-024-07763-9 · code: https://github.com/philshiu/Drosophila_brain_model
- **Huang, Luo et al. 2024**, *Dopamine-mediated interactions between short- and long-term memory dynamics*, Nature 634, 1141. https://doi.org/10.1038/s41586-024-07819-w. The plasticity rule and its constants are that paper's, as implemented in fly-wirehead (`rule.py`) and re-implemented in `core/src/flybrain.cpp`.
- **fly-wirehead** by Matty Hempstead. https://github.com/mattyhempstead/fly-wirehead. Cloned at setup time (pinned commit in `scripts/setup_mac.sh`); no file of it is copied into this repository. It publishes no licence file of its own; its neural core is stonkfly's MIT code (notice in `licenses/stonkfly-MIT.txt`). The kernels in `brain_server/engine/` (`kernel_batch.cpp`, `metal/`) and `core/` are derived from its `kernel.cpp` (`memory_advance`: the stonkfly loop plus fly-wirehead's dopamine-gated KC-to-MBON depression): the same arithmetic and operation order, rewritten for other memory layouts and for the GPU. `core/` also re-implements fly-wirehead's extension of the learning rule (the reward side, and the bound on how far a synapse may move) statement for statement.
- **stonkfly / DOOMFLY** (nftechie and DOOMFLY contributors), MIT. https://github.com/nftechie/stonkfly. The LIF loop that fly-wirehead's `kernel.cpp` extends, and so the arithmetic every kernel here keeps. The original notice is in `licenses/stonkfly-MIT.txt`.

## Fly body and motion

- **flybody** (DeepMind and HHMI Janelia), Apache-2.0. https://github.com/TuragaLab/flybody. `fly_model/` converts its MJCF model into the skinned GLBs in `fly_model/out/` and `Spectacles-*/Assets/Fly/Models/`. `tools/anim/out/poses.json` comes from the same model. The three clips derived from the flybody figshare data (`tools/anim/out/wingbeat_cycle.json`, `walk_cycle.json`, `saccade_body.json`) are GPL-3.0-or-later and are redistributed here under that licence; the lens does not ship them (see `tools/README.md`).
- **flygym / NeuroMechFly** (NeLy-EPFL), Apache-2.0. https://github.com/NeLy-EPFL/flygym. `tools/anim/out/walk_steps_cpg.json`.

## Fonts

- **Chakra Petch** (Cadson Demak) and **Share Tech Mono** (Carrois Apostrophe), SIL Open Font License 1.1. https://fonts.google.com/specimen/Chakra+Petch · https://fonts.google.com/specimen/Share+Tech+Mono. `Spectacles-*/Assets/Fly/UI/Fonts/`, the atlases baked from them, and the page's CSS.

## Web

- **three.js** (three.js authors), MIT. https://threejs.org. Vendored as `web/vendor/three.module.min.js` (r169).
- **Emscripten** toolchain (MIT / University of Illinois) builds `web/dist/flybrain.js` + `flybrain.wasm`; the generated loader in `web/dist/` carries Emscripten's runtime.
- **zlib** (Jean-loup Gailly and Mark Adler), zlib licence, linked into the WASM build and the Mac core.
- **Supabase** (Realtime, PostgREST) and **Snap Cloud** provide the relay and the two optional tables; nothing of theirs is redistributed here.
- **Open-Meteo** (https://open-meteo.com, CC BY 4.0 data) provides the weather at run time, no key.

## Snap

- Snap Inc. packages, under their own terms (https://github.com/specs-devs/packages): **Spectacles Interaction Kit, Spectacles UI Kit, Spectacles Sync Kit, Remote Service Gateway, SnapDecorators, Utilities** (both `Spectacles-5.15/Packages/` and `Spectacles-5.23/Packages/`); **LSTween** (5.15 only); **LEAF, AiPreviewAgentInspect, AiPreviewAgentInteract, Bitmoji 3D** (5.23 only).
- The colour/depth frame pairing in `WorldScanner.ts` follows Snap's **Depth Cache** sample. https://github.com/specs-devs/samples

## Services used at runtime

- **Gemini** through Snap's Remote Service Gateway (the room inventory, the inner voice, the training verdict). Bring your own token; none is included.
- **Supabase / Snap Cloud** for the PIN room and the optional memory tables. The repository ships an empty `ref` and `anon` in `web/config.js`; the ref pinned in `web/release.sh`, `FlyConfig.ts` and the docs is the author's own demo project, which a fork should replace with its own (`release.sh --sb <ref>`).
