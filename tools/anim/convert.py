#!/usr/bin/env python3
"""Export flybody-rig animation clips for the CyberFly lens (LS 5.15, flybody GLB rig).

Every clip is keyed by OUR bone names (== flybody MJCF body names; tarsus2..claw are folded
into `tarsus_*`, see fly_model/build_glb.py). Quaternions are [x, y, z, w].

    local = MJCF body rest quat * R(axis_1, q_1) * R(axis_2, q_2) ...   (MuJoCo joint order)
    delta = R(axis_1, q_1) * R(axis_2, q_2) ...

The GLB bone rest rotations equal the MJCF body quats (checked: max err 8e-7), so in the lens
either `t.setLocalRotation(local)` or `rest.multiply(delta)` (what FlyBody.setBone does).
Raw joint angles (radians, MJCF joint names) are included too, for procedural blending.

Sources (raw downloads, NOT in git: $CYBERFLY_RUNTIME/anim/..., see tools/README.md):
  flybody-data/flight/wing_pattern_fmech.npy         one wingbeat, flybody WBPG base pattern
  flybody-data/walking/walking-dataset-small_*.hdf5  freely walking flies, IK'd to flybody
  flygym-data/single_steps_flybody.npz               flygym per-leg single steps (CPG)
  flybody-data/flight/flight-dataset_saccade-evasion_augmented.hdf5  body saccades
  MJCF springrefs                                    flight leg tuck / wing fold (flybody)

    uv run --with-requirements tools/anim/requirements.txt python tools/anim/convert.py [--render]
"""

import argparse
import json
import os
from pathlib import Path

import h5py
import mujoco
import numpy as np
from scipy.signal import find_peaks
from scipy.spatial.transform import Rotation

HERE = Path(__file__).resolve().parent
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
FLYBODY_XML = RUNTIME / "flybody/flybody/fruitfly/assets/fruitfly.xml"
FB = RUNTIME / "anim/flybody-data"
FG = RUNTIME / "anim/flygym-data"
OUT = HERE / "out"
WALK_H5 = FB / "walking/walking-dataset-small_female-only_snippets-100_min-len-0.5s_trk-files-0-9.hdf5"
FOLD = ("tarsus2_", "tarsus3_", "tarsus4_", "claw_")
LEGS = [f"T{n}_{s}" for s in ("left", "right") for n in (1, 2, 3)]
LIC_FLYBODY_DATA = "flybody figshare data (doi 10.25378/janelia.25309105), GPL-3.0+"
LIC_FLYBODY_CODE = "flybody model/code (TuragaLab/flybody), Apache-2.0"
LIC_FLYGYM = "flygym (NeLy-EPFL/flygym), Apache-2.0; steps from NeuroMechFly v1 walking-on-ball data"
DEC = 5


# ---------------------------------------------------------------- quaternions (w, x, y, z)
def qmul(a, b):
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], -1)


def qaxis(axis, ang):
    ang = np.asarray(ang, float)[..., None]
    return np.concatenate([np.cos(ang / 2), np.sin(ang / 2) * np.asarray(axis, float)], -1)


def xyzw(q):
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    q = np.where(q[..., :1] < 0, -q, q)  # canonical hemisphere per sample...
    return np.round(q[..., [1, 2, 3, 0]], DEC)


def continuous(q):
    """...then flip signs so consecutive frames stay on the same hemisphere (safe slerp/lerp)."""
    q = q.copy()
    for i in range(1, len(q)):
        if np.dot(q[i], q[i - 1]) < 0:
            q[i] = -q[i]
    return q


# ---------------------------------------------------------------- rig
class Rig:
    def __init__(self):
        self.m = m = mujoco.MjModel.from_xml_path(str(FLYBODY_XML))
        self.rest, self.joints, self.parent = {}, {}, {}
        for b in range(1, m.nbody):
            name = m.body(b).name
            if name == "thorax" or name.startswith(FOLD):
                continue
            self.rest[name] = m.body_quat[b].copy()
            self.parent[name] = m.body(m.body_parentid[b]).name
            js = []
            for j in range(m.body_jntadr[b], m.body_jntadr[b] + m.body_jntnum[b]):
                if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE:
                    js.append((m.joint(j).name, m.jnt_axis[j].copy()))
            self.joints[name] = js
        self.springref = {m.joint(j).name: float(m.qpos_spring[m.jnt_qposadr[j]])
                          for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE}
        self.jrange = {m.joint(j).name: m.jnt_range[j].copy() for j in range(m.njnt)}

    def bone_quats(self, angles: dict, n: int):
        """angles: MJCF joint name -> (n,) radians. Returns bone -> (delta, local), (n,4) wxyz.
        Only bones with at least one driven joint are returned."""
        out = {}
        for bone, js in self.joints.items():
            if not any(jn in angles for jn, _ in js):
                continue
            d = np.tile([1.0, 0, 0, 0], (n, 1))
            for jn, ax in js:
                d = qmul(d, qaxis(ax, np.broadcast_to(angles.get(jn, 0.0), (n,))))
            out[bone] = (d, qmul(np.broadcast_to(self.rest[bone], (n, 4)), d))
        return out


def self_test(rig: Rig):
    """Our rest*delta composition must reproduce MuJoCo's own forward kinematics."""
    m = rig.m
    d = mujoco.MjData(m)
    rng = np.random.default_rng(0)
    ang = {}
    for j in range(m.njnt):
        if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE:
            lo, hi = m.jnt_range[j]
            ang[m.joint(j).name] = rng.uniform(lo, hi)
            d.qpos[m.jnt_qposadr[j]] = ang[m.joint(j).name]
    mujoco.mj_kinematics(m, d)
    bq = {k: v[1][0] for k, v in rig.bone_quats({k: np.array([v]) for k, v in ang.items()}, 1).items()}
    thorax = d.xquat[m.body("thorax").id]
    worst = 0.0
    for bone in bq:
        chain, b = [], bone
        while b != "thorax":
            chain.append(b)
            b = rig.parent[b]
        w = thorax
        for c in reversed(chain):
            w = qmul(w, bq[c] if c in bq else rig.rest[c])
        ref = d.xquat[m.body(bone).id]
        worst = max(worst, min(np.abs(w - ref).max(), np.abs(w + ref).max()))
    assert worst < 1e-6, worst
    print(f"[self-test] rest*delta chain == MuJoCo FK for {len(bq)} bones (max err {worst:.1e})")


def clip_json(rig, name, angles, n, fps, loop, source, license_, extra=None):
    bq = rig.bone_quats(angles, n)
    clip = {
        "name": name, "fps": fps, "frames": n, "loop": loop, "source": source, "license": license_,
        "convention": "quat [x,y,z,w]; local = rest(MJCF body quat == GLB bone rest) * delta; "
                      "delta = product of joint rotations about axis_body in MJCF joint order",
        "bones": {b: {"local": xyzw(continuous(l)).tolist(), "delta": xyzw(continuous(dq)).tolist()}
                  for b, (dq, l) in sorted(bq.items())},
        "joints": {k: np.round(np.broadcast_to(v, (n,)), DEC).tolist() for k, v in sorted(angles.items())},
    }
    if extra:
        clip.update(extra)
    return clip


def write(obj, fname):
    OUT.mkdir(exist_ok=True)
    p = OUT / fname
    p.write_text(json.dumps(obj, separators=(",", ":"), default=lambda o: o.item()))
    print(f"  -> {p}  ({p.stat().st_size / 1024:.1f} KB)")


def report(name, angles, closure=None):
    spans = {k: float(np.ptp(v)) for k, v in angles.items() if np.ndim(v)}
    moving = {k: s for k, s in spans.items() if s > np.radians(2)}
    big = sorted(moving.items(), key=lambda kv: -kv[1])[:5]
    print(f"[{name}] joints {len(angles)}, moving >2deg: {len(moving)}; biggest spans (deg): "
          + ", ".join(f"{k} {np.degrees(s):.0f}" for k, s in big))
    if closure is not None:
        print(f"[{name}] loop closure (max |q_end - q_start| over joints): {np.degrees(closure):.2f} deg")


# ---------------------------------------------------------------- clips
def wingbeat(rig):
    """flybody WBPG base pattern: one real wingbeat (yaw=stroke, roll=deviation, pitch=rotation),
    model joint space, same angles on both wings (right wing frame is mirrored)."""
    pat = np.load(FB / "flight/wing_pattern_fmech.npy").astype(float)  # (500, 3)
    n = 50
    idx = np.linspace(0, len(pat), n, endpoint=False)
    samp = np.stack([np.interp(idx, np.arange(len(pat) + 1), np.r_[pat[:, i], pat[0, i]]) for i in range(3)], 1)
    ang = {}
    for side in ("left", "right"):
        for i, dof in enumerate(("yaw", "roll", "pitch")):
            ang[f"wing_{dof}_{side}"] = samp[:, i]
    step = np.abs(np.diff(pat, axis=0)).max(0)
    wrap = np.abs(pat[0] - pat[-1])
    closure = float(np.max(wrap - step))  # <=0: the wrap-around is no bigger than a normal sample step
    report("wingbeat", ang, closure=max(closure, 0.0))
    base = 218.0
    return clip_json(rig, "wingbeat_cycle", ang, n, fps=n * base, loop=True,
                     source="flybody flight-imitation dataset: wing_pattern_fmech.npy (WingBeatPatternGenerator base pattern)",
                     license_=LIC_FLYBODY_DATA,
                     extra={"cycleHz": base, "note": "native 218 Hz; play one cycle per 1/FlyConfig.WING_HZ in the lens",
                            "dofs": {"yaw": "stroke (fore/aft, Z)", "roll": "deviation (X)", "pitch": "rotation/feathering (Y)"}})


def poses(rig):
    """Single-frame poses from the MJCF springrefs = flybody's own retracted flight/fold poses."""
    tuck = {jn: np.array([rig.springref[jn]]) for leg in LEGS for seg in ("coxa", "femur", "tibia", "tarsus")
            for jn, _ in rig.joints[f"{seg}_{leg}"]}
    fold = {f"wing_{d}_{s}": np.array([rig.springref[f"wing_{d}_{s}"]]) for s in ("left", "right") for d in ("yaw", "roll", "pitch")}
    for k, v in tuck.items():
        lo, hi = rig.jrange[k]
        assert lo - 1e-6 <= v[0] <= hi + 1e-6, (k, v, lo, hi)
    report("flight_leg_tuck", {k: np.r_[0.0, v[0]] for k, v in tuck.items()})
    return {
        "flight_leg_tuck": clip_json(rig, "flight_leg_tuck", tuck, 1, 0, False,
                                     "MJCF leg joint springrefs (flybody: legs retracted in flight, flight_imitation disable_legs)",
                                     LIC_FLYBODY_CODE),
        "wing_fold": clip_json(rig, "wing_fold", fold, 1, 0, False,
                               "MJCF wing springrefs == task_utils.retract_wings (yaw 1.5, roll 0.7, pitch -1.0)",
                               LIC_FLYBODY_CODE),
    }


def walk_dataset(rig):
    """One real stride from the flybody walking-imitation dataset (freely walking females, 500 Hz)."""
    with h5py.File(WALK_H5) as f:
        dt = float(f["timestep_seconds"][()])
        jn = [s.decode() for s in f["id2name"]["joints"]]
        sites = [s.decode() for s in f["id2name"]["sites"]]
        legj = [i for i, name in enumerate(jn) if any(s in name for s in ("coxa", "femur", "tibia", "tarsus_"))]
        ci = sites.index("claw_T2_left")
        # Score EVERY stride (PEP -> PEP of claw_T2_left, i.e. start of its swing) in every snippet:
        # closes well (leg joints), walks straight, walks at a real cruising speed.
        best = None
        for key in f["trajectories"]:
            t = f["trajectories"][key]
            root = t["root_qpos"][()]
            q = t["qpos"][()].astype(float)
            x = t["root2site"][()][:, ci, 0]
            yaw = np.unwrap(Rotation.from_quat(root[:, [4, 5, 6, 3]]).as_euler("ZYX")[:, 0])
            peps, _ = find_peaks(-x, distance=int(0.04 / dt), prominence=0.1 * np.ptp(x))
            for a, b in zip(peps[:-1], peps[1:]):
                dur = (b - a) * dt
                d = root[b, :2] - root[a, :2]
                speed = float(d @ [np.cos(yaw[a]), np.sin(yaw[a])]) / dur
                turn = abs(yaw[b] - yaw[a])
                clos = np.abs(q[b, legj] - q[a, legj]).max()
                if speed < 1.0 or not 0.05 <= dur <= 0.15:
                    continue
                score = clos + 1.0 * turn  # radians of mismatch + radians of heading change
                if best is None or score < best[0]:
                    best = (score, key, a, b, speed, turn / dur, clos)
        _, key, a, b, speed, yawrate, closure = best
        qpos = f["trajectories"][key]["qpos"][()].astype(float)
        peps = [a, b]
    seg = qpos[a:b + 1]
    n = int(b - a)
    ramp = np.linspace(0, 1, n + 1)[:, None]
    seg = seg - ramp * (seg[-1] - seg[0])  # distribute the tiny end mismatch so the loop closes exactly
    seg = seg[:-1]
    ang = {name: seg[:, i] for i, name in enumerate(jn)}
    for k in ang:
        ang[k] = np.clip(ang[k], *rig.jrange[k])
    report("walk_dataset", ang, closure=closure)
    print(f"[walk_dataset] snippet {key}: speed {speed:.2f} cm/s, yaw rate {np.degrees(yawrate):.0f} deg/s, "
          f"stride {n} samples = {n * dt * 1000:.0f} ms ({1 / (n * dt):.1f} Hz), PEPs in snippet {len(peps)}")
    return clip_json(rig, "walk_cycle", ang, n, fps=1 / dt, loop=True,
                     source=f"flybody walking-imitation dataset (small), snippet {key}, one claw_T2_left PEP->PEP stride",
                     license_=LIC_FLYBODY_DATA,
                     extra={"cycleHz": 1 / (n * dt), "speedCmS": float(speed),
                            "note": "phase 0 = T2_left posterior extreme (start of its swing); drive with a phase accumulator"})


def walk_cpg(rig, nbins=100):
    """flygym's per-leg single steps (F/M/H), already in flybody DOFs; for a CPG/phase-oscillator gait."""
    z = np.load(FG / "single_steps_flybody.npz")
    ja, swing = z["joint_angles"], z["swing_fractions"]  # (3, 7, 200), (3,)
    ph = np.linspace(0, ja.shape[2], nbins, endpoint=False)
    ja = np.stack([[np.interp(ph, np.arange(ja.shape[2] + 1), np.r_[ja[p, d], ja[p, d, 0]]) for d in range(7)] for p in range(3)])
    # flygym DOF order -> flybody joint (flygym parse_flybody.dof_mapping: twist->roll, extend->pitch, abduct->yaw)
    dof = ["coxa_{leg}", "coxa_twist_{leg}", "coxa_abduct_{leg}", "femur_{leg}", "femur_twist_{leg}", "tibia_{leg}", "tarsus_{leg}"]
    positions = {"F": 1, "M": 2, "H": 3}
    legs = {}
    closure = 0.0
    for pos, n in positions.items():
        leg = f"T{n}_left"
        pi = list(positions).index(pos)
        ang = {d.format(leg=leg): np.clip(ja[pi, i], *rig.jrange[d.format(leg=leg)]) for i, d in enumerate(dof)}
        closure = max(closure, float(np.abs(ja[pi, :, 0] - ja[pi, :, -1]).max()))
        bq = rig.bone_quats(ang, nbins)
        legs[pos] = {
            "swingFraction": float(swing[pi]),
            "delta": {seg: xyzw(continuous(bq[f"{seg}_{leg}"][0])).tolist() for seg in ("coxa", "femur", "tibia", "tarsus")},
            "joints": {d.split("_{leg}")[0]: np.round(ang[d.format(leg=leg)], DEC).tolist() for d in dof},
        }
        report(f"walk_cpg {pos}", ang)
    print(f"[walk_cpg] loop closure bin0 vs last bin: {np.degrees(closure):.2f} deg (one bin step)")
    return {
        "name": "walk_steps_cpg", "bins": nbins, "source": "flygym single_steps_flybody.npz", "license": LIC_FLYGYM,
        "convention": "delta quat [x,y,z,w] per segment per phase bin; bone local = rest * delta. Left and right "
                      "use the SAME delta (flybody leg frames are sagittally mirrored). Phase 0 = PEP = start of swing; "
                      "swing = phase < 2*pi*swingFraction.",
        "legPosition": {f"T{n}_{s}": p for p, n in positions.items() for s in ("left", "right")},
        "tripodPhase": {"T1_left": 0, "T2_right": 0, "T3_left": 0, "T1_right": np.pi, "T2_left": np.pi, "T3_right": np.pi},
        "legs": legs,
    }


def saccade(rig):
    """Body rotation during one free-flight saccade (Muijres et al. 2015), relative to the start."""
    with h5py.File(FB / "flight/flight-dataset_saccade-evasion_augmented.hdf5") as f:
        dt = float(f["timestep_seconds"][()])
        idx = f["trajectory_type_indices"]["saccade_original"][()]
        keys = sorted(f["trajectories"].keys())
        best = None
        for i in idx[:40]:
            q = f["trajectories"][keys[i]]["com_qpos"][()]
            e = Rotation.from_quat(q[:, [4, 5, 6, 3]]).as_euler("ZYX")
            yaw = np.unwrap(e[:, 0])
            turn = abs(yaw[-1] - yaw[0])
            if best is None or turn > best[0]:
                best = (turn, keys[i], q)
        _, key, q = best
    r0 = Rotation.from_quat(q[0, [4, 5, 6, 3]])
    rel = (r0.inv() * Rotation.from_quat(q[:, [4, 5, 6, 3]])).as_euler("ZYX")  # body-frame yaw, pitch, roll
    step = int(round(0.01 / dt))  # 100 Hz
    rel = rel[::step]
    yaw, pitch, roll = np.unwrap(rel[:, 0]), rel[:, 1], rel[:, 2]
    print(f"[saccade] traj {key}: {len(rel)} frames @100 Hz, yaw {np.degrees(yaw[-1]):.0f} deg, "
          f"peak roll {np.degrees(np.abs(roll).max()):.0f} deg, peak pitch {np.degrees(np.abs(pitch).max()):.0f} deg")
    return {"name": "saccade_body", "fps": 100, "frames": len(rel), "loop": False,
            "source": f"flybody flight dataset, saccade_original traj {key} (Muijres et al. 2015)", "license": LIC_FLYBODY_DATA,
            "convention": "body-frame Euler ZYX relative to the first frame, radians (+yaw = left turn, MuJoCo z-up)",
            "yaw": np.round(yaw, DEC).tolist(), "pitch": np.round(pitch, DEC).tolist(), "roll": np.round(roll, DEC).tolist()}


# ---------------------------------------------------------------- optional visual check
def render(rig, clips):
    from PIL import Image

    m = rig.m
    d = mujoco.MjData(m)
    r = mujoco.Renderer(m, 320, 320)
    cam = mujoco.MjvCamera()
    cam.lookat[:] = [0, 0, 0]
    cam.distance, cam.elevation = 0.9, -15

    def shot(angles, i, az):
        mujoco.mj_resetData(m, d)
        d.qpos[2] = 0.0
        for k, v in angles.items():
            d.qpos[m.jnt_qposadr[m.joint(k).id]] = np.broadcast_to(v, (max(1, np.size(v)),))[i]
        mujoco.mj_kinematics(m, d)
        cam.azimuth = az
        r.update_scene(d, cam)
        return r.render()

    rows = []
    wb = {k: np.array(v) for k, v in clips["wingbeat"]["joints"].items()}
    rows.append([shot(wb, i, 90) for i in range(0, 50, 10)])
    wk = {k: np.array(v) for k, v in clips["walk"]["joints"].items()}
    n = clips["walk"]["frames"]
    rows.append([shot(wk, int(i), 90) for i in np.linspace(0, n, 5, endpoint=False)])
    tuck = {k: np.array(v) for k, v in clips["poses"]["flight_leg_tuck"]["joints"].items()}
    fold = {k: np.array(v) for k, v in clips["poses"]["wing_fold"]["joints"].items()}
    rows.append([shot({}, 0, 90), shot(tuck, 0, 90), shot(tuck, 0, 180), shot(fold, 0, 90), shot(fold, 0, 180)])
    sheet = np.concatenate([np.concatenate(rw, 1) for rw in rows], 0)
    p = OUT / "check_sheet.png"
    Image.fromarray(sheet).save(p)
    print(f"  -> {p}  (row1 wingbeat 0..80%, row2 walk stride 0..80%, row3 rest | tuck side/front | wing fold side/front)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", action="store_true", help="also render out/check_sheet.png with MuJoCo")
    args = ap.parse_args()
    rig = Rig()
    self_test(rig)
    clips = {"wingbeat": wingbeat(rig), "poses": poses(rig), "walk": walk_dataset(rig)}
    write(clips["wingbeat"], "wingbeat_cycle.json")
    write(clips["poses"], "poses.json")
    write(clips["walk"], "walk_cycle.json")
    write(walk_cpg(rig), "walk_steps_cpg.json")
    write(saccade(rig), "saccade_body.json")
    if args.render:
        render(rig, clips)


if __name__ == "__main__":
    main()
