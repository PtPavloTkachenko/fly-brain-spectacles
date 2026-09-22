"""Every MaleCNS v1.0 skeleton, from the same public bucket fetch.py already uses (CC BY 4.0).

    uv run --with numpy python tools/anatomy/fetch_all.py [--threads 32]

166,700 precomputed skeletons, ~5.9 GB measured by a stratified HEAD probe. Resumable: a body
already on disk with a non-zero size is skipped, so re-running costs one stat() each. Sharded
1,000 to a directory so no folder holds 166k entries. Lives in $CYBERFLY_RUNTIME/anatomy/raw/skel
and is never in git.

Format (neuroglancer precomputed skeletons): uint32 nv, uint32 ne, float32 xyz[nv*3] in NANOMETRES,
uint32 edges[ne*2]. process_all.py turns them into the page's LOD assets.
"""
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import urllib.request

B = "https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-precomputed"
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
RAW = RUNTIME / "anatomy/raw/skel"
REPO = Path(__file__).resolve().parents[2]


def path_of(bid: int) -> Path:
    return RAW / f"{bid // 1000:06d}" / str(bid)


def one(bid: int) -> int:
    dst = path_of(bid)
    try:
        if dst.exists() and dst.stat().st_size > 8:
            return -dst.stat().st_size          # negative = already had it
    except OSError:
        pass
    dst.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f"{B}/{bid}", timeout=120) as r:
                data = r.read()
            if len(data) < 8:
                return 0
            tmp = dst.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.replace(dst)                     # atomic: a killed run never leaves half a file
            return len(data)
        except Exception:
            if attempt == 3:
                return 0
            time.sleep(1.5 * (attempt + 1))
    return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=32)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--reverse", action="store_true", help="second worker: meet the first in the middle")
    a = ap.parse_args()
    ids = np.load(REPO / "brain/results/pointcloud.npz")["ids"].astype(np.int64)
    if a.limit:
        ids = ids[: a.limit]
    if a.reverse:
        ids = ids[::-1]
    RAW.mkdir(parents=True, exist_ok=True)
    got = new = fail = 0
    t0 = time.time()
    with ThreadPoolExecutor(a.threads) as ex:
        for i, n in enumerate(ex.map(one, ids.tolist()), 1):
            if n < 0:
                got += -n
            elif n:
                got += n
                new += 1
            else:
                fail += 1
            if i % 2000 == 0:
                el = time.time() - t0
                print(f"{i}/{len(ids)}  {got/1e9:.2f} GB  new {new}  fail {fail}  "
                      f"{i/max(1,el):.0f}/s  eta {(len(ids)-i)/max(1,i/max(1,el))/60:.0f} min", flush=True)
    print(f"DONE {len(ids)} bodies, {got/1e9:.2f} GB, {new} downloaded, {fail} failed, "
          f"{(time.time()-t0)/60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
