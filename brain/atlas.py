"""Sensory atlas: stimulate EVERY sensory cell type and every visual projection type,
per side, and record every descending neuron (+ feeding / dopamine cells).

The result is the full "what can we tell the fly -> what does it want to do" matrix the
translator and decoder are designed from. Probes run in parallel processes (the kernel
itself is single-threaded), one brain per worker, ~1.2 GB RAM each.

Run from the fly-wirehead runtime:
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<this file>"
"""

import json
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

OUT = Path(__file__).with_name("results")
MV = 20.0
WORKERS = 8
DN_CLASSES = ["descending_neuron", "descending_neuron_tbc", "efferent_descending"]
EXTRA_TYPES = ["MN9", "PAM11", "PPL101"]
READOUTS = {
    "escape": ["DNp01", "DNp02", "DNp04", "DNp11"],
    "object_L": ["DNp66_L"],
    "object_R": ["DNp66_R"],
    "appetitive": ["DNge051", "DNge023", "DNge173"],
    "stop": ["DNpe007"],
    "back (MDN)": ["MDN"],
    "walk (DNp09)": ["DNp09"],
    "steer DNa02_L": ["DNa02_L"],
    "steer DNa02_R": ["DNa02_R"],
    "feed (MN9)": ["MN9"],
    "reward (PAM11)": ["PAM11"],
}


def build_probes():
    import pyarrow.feather as feather

    from flywirehead.neural.common import DATA, GRAPH

    with np.load(GRAPH) as g:
        ids, sc = g["ids"], g["superclass"].astype(str)
    a = feather.read_table(DATA / "annotations.feather").to_pandas().set_index("bodyId").loc[ids]
    t = a.type.fillna("").to_numpy()
    cls = a["class"].fillna("").to_numpy()
    sub = a.subclass.fillna("").to_numpy()
    root = a.rootSide.fillna("").to_numpy()
    soma = a.somaSide.fillna("").to_numpy()

    sensory = np.char.find(sc, "sensory") >= 0
    vpn = sc == "visual_projection"
    key = np.where(t != "", t, np.char.add(np.char.add(cls.astype(str), "/"), sub.astype(str)))

    probes, meta = {}, {}
    for kind, mask, side in (("sense", sensory, root), ("vpn", vpn, soma)):
        for k in sorted(set(key[mask])):
            members = np.flatnonzero(mask & (key == k)).astype(np.int32)
            sides = {s: members[side[members] == s] for s in "LR"}
            groups = {s: ix for s, ix in sides.items() if len(ix)} or {"both": members}
            for s, ix in groups.items():
                name = f"{kind}|{k}|{s}"
                probes[name] = ix
                i0 = members[0]
                meta[name] = {"n": len(ix), "superclass": sc[i0], "class": str(cls[i0]), "subclass": str(sub[i0])}

    watch = np.flatnonzero(np.isin(sc, DN_CLASSES) | np.isin(t, EXTRA_TYPES)).astype(np.int32)
    labels = [f"{t[i] or '?'}_{soma[i] or '?'}" for i in watch]
    return probes, meta, watch, labels


_probe = None


def init():
    global _probe
    import probe

    _probe = probe


def work(name, indices, watch):
    stim = [(indices, MV)] if len(indices) else None
    counts, wall = _probe.run(stim=stim)
    seconds = _probe.MEASURE_MS / 1000
    return name, (counts[watch] / seconds).astype(np.float32), wall


def columns(labels, names):
    """Indices of watched cells whose label is `TYPE_SIDE` or whose type is `TYPE`."""
    return [i for i, lab in enumerate(labels) if lab in names or lab.rsplit("_", 1)[0] in names]


if __name__ == "__main__":
    probes, meta, watch, labels = build_probes()
    probes = {"control": np.zeros(0, np.int32), **probes}
    print(f"{len(probes)} probes over {len(watch)} watched cells, {WORKERS} workers", flush=True)

    started = time.perf_counter()
    rates, walls = {}, []
    with ProcessPoolExecutor(WORKERS, initializer=init) as pool:
        futures = [pool.submit(work, n, ix, watch) for n, ix in probes.items()]
        for done, future in enumerate(as_completed(futures), 1):
            name, r, wall = future.result()
            rates[name] = r
            walls.append(wall)
            if done % 100 == 0 or done == len(futures):
                print(f"  {done}/{len(futures)}  {time.perf_counter() - started:.0f}s", flush=True)
    total = time.perf_counter() - started

    names = list(probes)
    matrix = np.stack([rates[n] for n in names])
    OUT.mkdir(exist_ok=True)
    np.savez_compressed(OUT / "atlas.npz", rates=matrix, probes=np.array(names), cells=np.array(labels), watch=watch)
    (OUT / "atlas_meta.json").write_text(json.dumps(meta, indent=1) + "\n")

    per_run = float(np.mean(walls))
    print(f"\nwall {total:.0f}s for {len(names)} runs; {per_run:.2f}s per 500 ms measure inside a worker;"
          f" parallel throughput {len(names) * 0.5 / total:.2f} neural-s per wall-s")

    delta = matrix - rates["control"]
    responsive = (np.abs(delta) >= 20).sum(1)
    print(f"probes moving >=1 DN by >=20 Hz: {(responsive > 0).sum()} of {len(names) - 1}")

    for readout, cell_names in READOUTS.items():
        cols = columns(labels, cell_names)
        if not cols:
            print(f"\n{readout}: no cells")
            continue
        score = delta[:, cols].mean(1)
        top = np.argsort(-score)[:8]
        print(f"\n{readout} (control {rates['control'][cols].mean():.1f} Hz), strongest drivers:")
        for i in top:
            if score[i] <= 0:
                break
            m = meta.get(names[i], {})
            print(f"   +{score[i]:6.1f} Hz  {names[i]:<40} n={m.get('n', '')} {m.get('class', '')}/{m.get('subclass', '')}")
