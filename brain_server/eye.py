"""The fly's compound eye: the model's own ommatidial columns, and where vision is injected.

ONE source of truth for the optic-lobe column lattice (ADR 54). `worker.py` (Python brain),
`core/brain_export/export.py` (the native core's file) and the lens table
(`Spectacles/.../FlyRetinaData.ts`, written by `python -m eye --ts`) all come from this module,
so the three can never drift apart.

Why the columns and not the 8x16 frame (measured 15.09, ADR 54):
  * `graph.npz` carries `retina` (3335 R1-R6 cells) with `uv`, but only 825 distinct uv -> at the
    8x16 frame the whole eye collapses into 81 distinct pixels.
  * the LAMINA is the complete layer: L1/L2/L5 have one cell per column with a MaleCNS hex
    assignment - 875 columns on the left eye, 892 on the right, shared 1:1 between the types.
  * R1-R6 covers only 299/875 (L) and 525/892 (R) of them, and is purely inhibitory
    (mean weight -4.63, 0 % positive), so nothing it does can EXCITE the medulla.

The lattice. MaleCNS hex coordinates (assignedOlHex1/2) -> the standard hex-to-cartesian map
x = h1 - h2/2, y = sqrt(3)/2 * h2, times the interommatidial angle DPHI. Drosophila: ~750-800
ommatidia per eye, interommatidial angle 4.5-5.5 deg, acceptance angle (Delta rho) ~5.7 deg,
per-eye field ~145 x 165 deg with a ~30 deg frontal binocular overlap (Land 1997; Goetz 1964;
Stavenga 2003). At DPHI = 5.0 this lattice spans 142 x 165 deg - the real eye, to the degree.

Injection targets, all from the connectome's own wiring (measured sums over the MaleCNS graph):
    ON  pathway   L1 -| Mi1 (-39101, the strongest single input) , L5 -> Mi1 (+21080)  -> T4
    OFF pathway   L2 -> Tm1 (+56493) , L2 -> Tm2 (+60826) , L3 -> Tm9 (+13519)         -> T5
    then T4/T5 -> LPLC2 (+5270/+5017/+4722 from T5d/b/c) -> looming
         T2/T3/Tm6/Tm12 -> LC11 -> small objects (LC11 gets NO T4/T5 input: it is not a
         motion detector, matching Keles & Frye 2017)
Everything downstream of these seven cell types is the connectome computing for itself.
"""

import numpy as np

DPHI_DEG = 5.0  # interommatidial angle (Drosophila 4.5-5.5 deg)
DRHO_DEG = 5.7  # ommatidial acceptance angle, Gaussian FWHM (Goetz 1964)
EYE_YAW_DEG = 35.0  # optical axis of each eye from straight ahead (=> ~30 deg binocular overlap)

# Injection amplitude, mV per unit of normalised LMC contrast. OURS and disclosed, exactly like
# MAX_MV = 20 for the engineered sense channels and the model's own `lamina_bias = 12` and
# `30 * lum / (0.02 + lum)` photoreceptor drive. Measured knee (15.09 sweep, ADR 54):
#   60  -> a loom gives LPLC2 1.8/0.2 Hz, escape 0.13 : present but weak
#   120 -> LPLC2 6.6 vs 0.3 (22:1), LC4 9.8 vs 1.3, DNp02 23 / DNp03 8 / DNp04 39, escape 0.30
#   blank stays at 0.0 Hz across the whole optic lobe at every gain (no false positives)
# Why it takes this much: one L2 spike puts 4.3 mV into Tm1 (weight 27.25 = 99 contacts x 0.275 mV,
# peak EPSP (a-b)/3 = 0.157) against a 7 mV gap to threshold, so every stage of the chain needs
# two coincident spikes inside ~10 ms. Shiu et al. 2024 say the absolute rates of this LIF model
# "are unlikely to be accurate" - the gain is what buys back the missing photoreceptor gain.
MV_LAMINA = 120.0
MV_MEDULLA = 120.0

# the order of the injected cell types is part of the wire contract: Python and the C++ core
# must add their currents in exactly this order or the float sums diverge.
INJECT = (("L1", -1), ("L2", -1), ("L5", +1), ("Mi1", +1), ("Tm1", -1), ("Tm2", -1), ("Tm9", -1))
COLUMN_TYPES = tuple(name for name, _ in INJECT)


def index_columns(a):
    """-> (cols, per_type) for the MaleCNS annotations `a`.

    cols: (NCOL, 3) int32 [hex1, hex2, side] with side 0 = left eye, 1 = right eye,
          left-eye columns first, each side sorted by (hex1, hex2). THIS IS THE WIRE ORDER.
    per_type: {type: int32[NCOL]} cell index per column, -1 where the reconstruction has none.
    """
    types = a.type.fillna("").to_numpy().astype(str)
    soma = a.somaSide.fillna("").to_numpy().astype(str)
    h1 = a.assignedOlHex1.to_numpy(dtype=float)
    h2 = a.assignedOlHex2.to_numpy(dtype=float)
    known = ~(np.isnan(h1) | np.isnan(h2))
    rows, offset = [], {}
    for s, side in enumerate("LR"):
        m = (types == "L1") & known & (soma == side)  # L1 defines the lattice: one cell per column
        keys = sorted(set(zip(h1[m].tolist(), h2[m].tolist())))
        offset[side] = len(rows)
        rows += [(int(x), int(y), s) for x, y in keys]
    cols = np.asarray(rows, np.int32)
    index = {(int(x), int(y), s): i for i, (x, y, s) in enumerate(rows)}
    per_type = {}
    for name in COLUMN_TYPES:
        out = np.full(len(rows), -1, np.int32)
        m = (types == name) & known
        for i in np.flatnonzero(m):
            key = (int(h1[i]), int(h2[i]), 0 if soma[i] == "L" else 1)
            if key in index:
                out[index[key]] = i
        per_type[name] = out
    return cols, per_type


def lattice(cols, dphi=DPHI_DEG, yaw=EYE_YAW_DEG):
    """-> (az, el) float32 degrees in the FLY's head frame: +az = the fly's left, +el = up."""
    az = np.zeros(len(cols), np.float32)
    el = np.zeros(len(cols), np.float32)
    for s in (0, 1):
        m = cols[:, 2] == s
        h = cols[m].astype(np.float64)
        x = h[:, 0] - 0.5 * h[:, 1]
        y = np.sqrt(3) / 2 * h[:, 1]
        a = dphi * (x - x.mean())
        e = dphi * (y - y.mean())
        az[m] = (yaw + a) if s == 0 else (-yaw - a)  # the two eyes look outward
        el[m] = e
    return az, el


def stim_lists(per_type):
    """-> [(type, sign, cells int32, column int32)] in the wire order, gaps removed."""
    out = []
    for name, sign in INJECT:
        ix = per_type[name]
        col = np.flatnonzero(ix >= 0).astype(np.int32)
        out.append((name, sign, ix[col].astype(np.int32), col))
    return out


def decode_payload(payload, ncol):
    """base64 of NCOL unsigned bytes -> float32 signed contrast in [-1, 1]; 128 = zero.

    The exact arithmetic (float32, the same 1/127) is part of the contract: `flybrain.cpp`
    reproduces it statement for statement.
    """
    import base64

    raw = np.frombuffer(base64.b64decode(payload), np.uint8)
    if len(raw) != ncol:
        return None
    return (raw.astype(np.float32) - np.float32(128.0)) * np.float32(1.0 / 127.0), raw


def build_eye(lists, payload, ncol, mv_lamina, mv_medulla):
    """senses["eye"] -> [(indices, mV)] appended after build_stim and before the R8 pulse.

    A column whose byte is exactly 128 is skipped (an integer test, so both implementations
    always agree, and a still scene costs the kernel nothing).
    """
    got = decode_payload(payload, ncol)
    if got is None:
        return []
    c, raw = got
    moved = raw != 128
    on = np.maximum(c, np.float32(0.0))
    off = np.maximum(-c, np.float32(0.0))
    out = []
    for name, sign, cells, col in lists:
        keep = moved[col]
        if not keep.any():
            continue
        mv = np.float32(mv_lamina if name in ("L1", "L2", "L5") else mv_medulla)
        src = on if sign > 0 else off
        out.append((cells[keep], (mv * src[col[keep]]).astype(np.float32)))
    return out


def _write_ts(path, cols, az, el):
    n = len(cols)
    side = cols[:, 2].astype(np.uint8)
    qaz = np.round(az * 100).astype(np.int16)
    qel = np.round(el * 100).astype(np.int16)
    body = [
        "// GENERATED by brain_server/eye.py -- do not edit.",
        "// The MaleCNS optic-lobe column lattice the brain is injected on (ADR 54): one entry per",
        "// ommatidial column, left eye first, each eye sorted by (hex1, hex2). The order IS the",
        "// wire order of the `eye` sense byte string.",
        "// EYE_AZ / EYE_EL: viewing direction in the fly's head frame, centidegrees",
        "// (+az = the fly's left, +el = up). EYE_SIDE: 0 = left eye, 1 = right eye.",
        f"export const EYE_N = {n}",
        f"export const EYE_L = {int((side == 0).sum())}",
        f"export const EYE_SIDE = new Uint8Array([{','.join(map(str, side.tolist()))}])",
        f"export const EYE_HX = new Uint8Array([{','.join(map(str, cols[:, 0].tolist()))}])",
        f"export const EYE_HY = new Uint8Array([{','.join(map(str, cols[:, 1].tolist()))}])",
        f"export const EYE_HEX = {int(max(cols[:, 0].max(), cols[:, 1].max())) + 1} // mosaic texture side",
        f"export const EYE_AZ = new Int16Array([{','.join(map(str, qaz.tolist()))}])",
        f"export const EYE_EL = new Int16Array([{','.join(map(str, qel.tolist()))}])",
        "",
    ]
    path.write_text("\n".join(body))
    return n


if __name__ == "__main__":
    import os
    import sys
    from pathlib import Path

    RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime"))
    os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))
    from flywirehead.neural.common import annotations
    from flywirehead.neural.state import Brain  # noqa: F401  (import check only)
    from flywirehead.neural.visual import VisualMemoryBrain

    brain = VisualMemoryBrain()
    cols, per_type = index_columns(annotations(brain.ids))
    az, el = lattice(cols)
    print(f"{len(cols)} columns: left {int((cols[:, 2] == 0).sum())}, right {int((cols[:, 2] == 1).sum())}")
    for name in COLUMN_TYPES:
        print(f"  {name:4s} mapped {int((per_type[name] >= 0).sum())}")
    print(f"  az {az.min():.0f}..{az.max():.0f} deg   el {el.min():.0f}..{el.max():.0f} deg")
    if "--ts" in sys.argv:
        out = Path(__file__).resolve().parents[1] / "Spectacles-5.23/Assets/Scripts/Fly/FlyRetinaData.ts"  # copy to Spectacles-5.15 too
        print("wrote", out, _write_ts(out, cols, az, el), "columns")
