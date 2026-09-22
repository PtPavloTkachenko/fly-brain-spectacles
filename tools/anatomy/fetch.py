"""Download native MaleCNS v1.0 anatomy (public GCS bucket gs://flyem-male-cns, CC BY 4.0).

ROI meshes (brain/VNC shells, neuropils) + command-neuron meshes and skeletons, all in
MaleCNS voxel space (8 nm). Writes $CYBERFLY_RUNTIME/anatomy/raw/ (~0.9 GB, not in git);
process.py turns them into lens assets.
    uv run --with-requirements tools/anatomy/requirements.txt python tools/anatomy/fetch.py
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import requests

B = "https://storage.googleapis.com/flyem-male-cns"
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
RAW = RUNTIME / "anatomy/raw"
ANN = Path(os.environ.get("FLYWIREHEAD_DATA", RUNTIME / "fly-wirehead/data")) / "annotations.feather"
ROI_LAYERS = ["brain-shell-v2.2", "vnc-shell-v2", "fullbrain-major-shells",
              "malecns-major-compartments-v2", "fullbrain-roi-v5", "malecns-vnc-neuropil-roi-v0"]
TYPES = ["DNa02", "DNa01", "DNp01", "DNp03", "DNa15", "DNb01", "MDN", "DNp09", "MN9",
         "PAM11", "PPL101", "DNpe007"]


def get(url, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 0:
        return dst
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    dst.write_bytes(r.content)
    return dst


def main():
    jobs = []
    for layer in ROI_LAYERS:
        props = requests.get(f"{B}/rois/{layer}/segment_properties/info").json()["inline"]
        names = dict(zip(props["ids"], props["properties"][0]["values"]))
        (RAW / "rois" / layer).mkdir(parents=True, exist_ok=True)
        (RAW / "rois" / layer / "names.json").write_text(json.dumps(names, indent=1))
        for sid, name in names.items():
            frags = requests.get(f"{B}/rois/{layer}/mesh/{sid}:0").json()["fragments"]
            for f in frags:
                jobs.append((f"{B}/rois/{layer}/mesh/{requests.utils.quote(f)}",
                             RAW / "rois" / layer / f))

    a = pd.read_feather(ANN)
    s = a[a.type.isin(TYPES)][["bodyId", "type", "instance", "somaSide", "somaLocation"]]
    bodies = [{"bodyId": int(r.bodyId), "type": r.type, "instance": r.instance,
               "side": r.somaSide, "soma_vox": [int(v) for v in r.somaLocation]}
              for r in s.itertuples()]
    (RAW / "neurons").mkdir(parents=True, exist_ok=True)
    (RAW / "neurons/bodies.json").write_text(json.dumps(bodies, indent=1))
    seg = f"{B}/v1.0/segmentation"
    for b in bodies:
        i = b["bodyId"]
        jobs.append((f"{seg}/single-res-meshes/{i}.ngmesh", RAW / f"neurons/{i}.ngmesh"))
        jobs.append((f"{seg}/skeletons-malecns/skeletons-precomputed/{i}", RAW / f"neurons/{i}.skel"))

    with ThreadPoolExecutor(12) as ex:
        done = list(ex.map(lambda j: get(*j), jobs))
    tot = sum(p.stat().st_size for p in done)
    print(f"{len(done)} files, {tot / 1e6:.0f} MB, {len(bodies)} neurons")


if __name__ == "__main__":
    main()
