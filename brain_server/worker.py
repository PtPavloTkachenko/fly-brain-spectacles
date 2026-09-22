"""One fly = one process = one full MaleCNS brain that thinks continuously.

Loop: take the latest senses -> integrate STEP_MS of neural time -> smoothed readouts ->
decoded actions (+ brain-cloud spike bits when this fly is selected) -> send to the server.
"""

import base64
import math
import time

import numpy as np

CHUNK_MS = 10.0
SMOOTH_MS = 150.0  # readout smoothing (one spike of a single cell in 50 ms = 20 Hz)
# Resting light MUST match the atlas calibration (gray 160/255). The network is bistable in
# light: at 153 it stays quiet for seconds (all readouts 0 Hz), at 160 it wakes within 0.3 s.
REST_LIGHT = 160 / 255
# Habituation: the decoder baseline follows the fly's own slow drift (tau in brain steps,
# ~30 s wall at 5 flies). Without it a network that wanders into another state over minutes
# reads as a permanent "stop + back" (11.09: 4 of 5 flies stuck at stop 1.0, back 0.7).
# Sustained stimuli fade on the same scale — disclosed as habituation.
# 11.09 audit: 60 steps (3 s simulated, ~7 s wall) faded a hovering fly's food cue within
# 7-13 s (DNp66 +100 -> +20 Hz), so it "lost interest". Now a simulated-time tau, and frozen
# while an attractive cue (object / odour) is present, so a fly does not get used to its target.
# 11.09 live: freezing on the OBJECT channel froze it for good (other flies are always in view)
# and the slow drift read as a permanent STOP (all flies parked). Freeze on odour only (food /
# flowers), and tau 8 s simulated (~18 s wall) instead of 20 s.
BASE_TAU_MS = 8000.0
ATTRACT_FREEZE = 0.2
ATTRACT_KEYS = ("DNp66_L", "DNp66_R", "appetite", "feed")  # the approach drive that must not fade near food
LOAD_KEYS = ("groom_L", "groom_R")  # ADR 100: a load readout keeps its rest baseline, it is not a change detector


def _peak(v):
    if isinstance(v, dict):
        return max([float(x) for x in v.values() if isinstance(x, (int, float))] or [0.0])
    return float(v) if isinstance(v, (int, float)) else 0.0


def run(fly, inbox, outbox, subset, step_ms):
    from flywirehead.neural.visual import VisualMemoryBrain

    brain = VisualMemoryBrain()
    brain.weights_frozen = True
    fly_loop(brain, prepare(brain), fly, inbox, outbox, subset, step_ms)


def prepare(brain):
    """Read-only cell indices of the connectome (one set shared by all flies of a process)."""
    from flywirehead.neural.common import annotations

    from channels import index_readouts, index_regions, index_senses

    a = annotations(brain.ids)
    # Region rates for the board — 11.09 "all bars should move" (same sets the cloud highlights)
    regions = index_regions(brain.superclass, a.type.fillna("").to_numpy())
    return index_senses(a), index_readouts(a), regions


def prepare_eye(brain):
    """Ommatidial columns -> the lamina/medulla cells the `eye` sense drives (ADR 54).

    Kept out of `prepare` so the older three-tuple contract (engine/, export.py) is unchanged.
    """
    import eye as eyemod
    from flywirehead.neural.common import annotations

    cols, per_type = eyemod.index_columns(annotations(brain.ids))
    return cols, eyemod.stim_lists(per_type)


def fly_loop(brain, indices, fly, inbox, outbox, subset, step_ms, barrier=None):
    """The per-fly think loop. Also run by engine/batch_worker.py (one thread per fly)."""
    from channels import build_stim, decode

    import eye as eyemod

    sense_ix, read_ix, regions = indices
    senses = {"light": REST_LIGHT}
    pulses = {}  # kind -> remaining ms
    cloud = False
    eye_cols, eye_lists = prepare_eye(brain)
    eye_ncol = len(eye_cols)
    eye_cache = [None, []]  # last payload string -> its [(cells, mV)] list (5 chunks share one decode)

    def frame():
        # the fly's own view (lens FlyVision: 16x8 RGB, mean pinned to 160/255, ADR 15) -> R1-R8
        retina = senses.get("retina")
        if isinstance(retina, list) and len(retina) == 16 * 8 * 3:
            return np.asarray(retina, np.uint8).reshape(8, 16, 3)
        light = senses.get("light", REST_LIGHT)
        l, r = (light.get("L", REST_LIGHT), light.get("R", REST_LIGHT)) if isinstance(light, dict) else (light, light)
        img = np.empty((8, 16, 3), np.uint8)
        img[:, :8], img[:, 8:] = round(255 * np.clip(l, 0, 1)), round(255 * np.clip(r, 0, 1))  # 160, not 159
        return img

    def advance(ms):
        counts = np.zeros(brain.n, np.int64)
        for _ in range(int(round(ms / CHUNK_MS))):
            ch = dict(senses)
            ch.update({k: 1.0 for k, left in pulses.items() if left > 0})
            stim = build_stim(sense_ix, ch)
            # the compound eye (ADR 54): per-column ON/OFF after the sense channels and before the
            # R8 pulse rgb_step appends last. The C++ core applies it at exactly this point.
            payload = ch.get("eye")
            if isinstance(payload, str):
                if eye_cache[0] != payload:
                    eye_cache[0] = payload
                    eye_cache[1] = eyemod.build_eye(eye_lists, payload, eye_ncol,
                                                    eyemod.MV_LAMINA, eyemod.MV_MEDULLA)
                stim = stim + eye_cache[1]
            c, _ = brain.rgb_step(frame(), CHUNK_MS, learning=False, stimulation=stim or None)
            counts += c
            for k in pulses:
                pulses[k] = max(0.0, pulses[k] - CHUNK_MS)
        return counts

    def rates(counts, ms):
        s = ms / 1000
        return {k: float(counts[ix].sum() / (max(1, len(ix)) * s)) for k, ix in read_ix.items()}

    # The network needs ~1 s of neural time to reach its resting activity (DNa02_L sits at
    # ~22 Hz at rest, 0 Hz before that). A baseline taken too early turns into a fixed
    # steering bias once the cells wake up.
    advance(800)
    base = rates(advance(500), 500)
    smooth = dict(base)
    outbox.send({
        "t": "ready", "fly": fly, "baseline": {k: round(v, 1) for k, v in base.items()},
        "channels": {k: {s: len(v) for s, v in g.items()} for k, g in sense_ix.items()},
        "eye": {"columns": eye_ncol, "left": int((eye_cols[:, 2] == 0).sum()),
                "cells": {name: int(len(cells)) for name, _, cells, _ in eye_lists}},
    })

    alpha = 1 - math.exp(-step_ms / SMOOTH_MS)
    while True:
        while inbox.poll():
            msg = inbox.recv()
            if msg.get("stop"):
                return
            if "senses" in msg:
                senses = {"light": senses.get("light", REST_LIGHT), **msg["senses"]}
            if "cloud" in msg:
                cloud = bool(msg["cloud"])
            if "pulse" in msg:
                pulses[msg["pulse"]] = 200.0
            if msg.get("reset"):
                brain.reset()
                advance(200)
                smooth = dict(base)
        if barrier is not None:
            try:  # step in lockstep: the GPU rendezvous then batches all flies into one dispatch
                barrier.wait(timeout=2.0)
            except Exception:
                pass
        t0 = time.perf_counter()
        counts = advance(step_ms)
        t_adv = time.perf_counter()
        r = rates(counts, step_ms)
        for k in smooth:
            smooth[k] += alpha * (r[k] - smooth[k])
        act = decode(smooth, base)
        t_dec = time.perf_counter()
        # near food only the ATTRACTION readouts stop habituating (11.09 bench: freezing every
        # baseline turned any drift into a permanent turn -> hungry flies circled the treat and
        # never landed); steering, escape and stop keep adapting as usual
        frozen = _peak(senses.get("odor")) > ATTRACT_FREEZE
        kb = step_ms / BASE_TAU_MS
        for k in base:
            if not (frozen and k in ATTRACT_KEYS) and k not in LOAD_KEYS:  # ADR 100
                base[k] += (smooth[k] - base[k]) * kb
        seconds = step_ms / 1000
        out = {
            "t": "brain", "fly": fly, "sim_ms": round(brain.sim_ms, 1),
            "wall_ms": round((time.perf_counter() - t0) * 1000),
            # where a step actually goes (12.09: GPU is only ~18 ms of an 85-104 ms live step)
            "prof": {"adv": round((t_adv - t0) * 1000), "dec": round((t_dec - t_adv) * 1000)},
            "act": {k: round(v, 3) for k, v in act.items()},
            "neural": {
                "arousal_hz": round(float(counts.sum() / (brain.n * seconds)), 2),
                "reward_hz": round(smooth["reward"], 1),
                "stress_hz": round(smooth["stress"], 1),
                "fear": round(max(act["escape_L"], act["escape_R"]), 3),
                "appetite": act["appetite"], "feeding": act["feed"],
                "attention": act["orient"], "spikes": int(counts.sum()),
            },
            "hz": {k: round(v, 1) for k, v in smooth.items()},
            "regions": {
                k: round(float(counts[ix].sum() / (max(1, len(ix)) * seconds)), 2)
                for k, ix in regions.items()
            },
        }
        t_msg = time.perf_counter()
        if cloud:
            out["cloud"] = base64.b64encode(np.packbits(counts[subset] > 0).tobytes()).decode()
        out["prof"]["msg"] = round((time.perf_counter() - t_msg) * 1000)
        out["prof"]["out"] = round((time.perf_counter() - t0) * 1000)
        outbox.send(out)
