# Third-party data, code and assets

CyberFly's own code is MIT (`LICENSE`). Everything below belongs to its authors and keeps its own licence.

## Brain data

- **MaleCNS v1.0 connectome** by the MaleCNS collaboration (Janelia FlyEM, University of Cambridge, MRC Laboratory of Molecular Biology, Google Research). CC BY 4.0. https://male-cns.janelia.org/download/
  - Downloaded at setup time into the runtime folder, not stored in this repository.
  - Derived files in this repository, also CC BY 4.0 with this attribution: `brain/results/*` (neuron positions, the point-cloud sample, probe results), `Spectacles/Assets/Scripts/Fly/BrainCloudData.ts`, `tools/anatomy/out/*` and `Spectacles/Assets/Fly/Anatomy/*` (brain and nerve cord shells, neuropil and neuron meshes, skeletons from the public `gs://flyem-male-cns` bucket).

## Brain model and runtime

- **Shiu et al. 2024**, *A Drosophila computational brain model reveals sensorimotor processing*, Nature 634, 210–219. https://www.nature.com/articles/s41586-024-07763-9 · code: https://github.com/philshiu/Drosophila_brain_model
- **fly-wirehead** by Matty Hempstead. https://github.com/mattyhempstead/fly-wirehead. Cloned at setup time (pinned commit in `scripts/setup_mac.sh`), not redistributed here. Its neural core is adapted from stonkfly.
- **stonkfly / DOOMFLY** (nftechie and DOOMFLY contributors), MIT. https://github.com/nftechie/stonkfly. The kernels in `brain_server/engine/` (`kernel_batch.cpp`, `metal/brain.metal`) reimplement this LIF kernel with the same arithmetic. The original notice is in `licenses/stonkfly-MIT.txt`.

## Fly body and motion

- **flybody** (DeepMind and HHMI Janelia), Apache-2.0. https://github.com/TuragaLab/flybody. `fly_model/` converts its MJCF model into the skinned GLBs in `fly_model/out/` and `Spectacles/Assets/Fly/Models/`. `tools/anim/out/poses.json` comes from the same model.
- **flygym / NeuroMechFly** (NeLy-EPFL), Apache-2.0. https://github.com/NeLy-EPFL/flygym. `tools/anim/out/walk_steps_cpg.json`.

## Fonts

- **Chakra Petch** (Cadson Demak) and **Share Tech Mono** (Carrois Apostrophe), SIL Open Font License 1.1. https://fonts.google.com/specimen/Chakra+Petch · https://fonts.google.com/specimen/Share+Tech+Mono. `Spectacles/Assets/Fly/UI/Fonts/` and the atlases baked from them.

## Snap

- **Spectacles Interaction Kit, Spectacles UI Kit, Remote Service Gateway, SnapDecorators, Utilities** packages in `Spectacles/Packages/`, by Snap Inc., under their own terms. https://github.com/specs-devs/packages
- The colour/depth frame pairing in `WorldScanner.ts` follows Snap's **Depth Cache** sample. https://github.com/specs-devs/samples

## Services used at runtime

- **Gemini** through Snap's Remote Service Gateway. Bring your own token; none is included.
