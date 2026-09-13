"""Shared probe harness: one brain, deterministic reset, stimulus in -> spike counts out.

Protocol per run: reset -> 300 ms warm-up on a neutral gray frame -> MEASURE_MS measured
with the stimulus. The model has no noise, so the control run is the exact baseline.
"""

import time

import numpy as np

from flywirehead.neural.common import annotations
from flywirehead.neural.visual import VisualMemoryBrain

W, H = 160, 120
GRAY = 160
WARM_MS, MEASURE_MS, CHUNK_MS = 300.0, 500.0, 10.0

brain = VisualMemoryBrain()
brain.weights_frozen = True
a = annotations(brain.ids)
types = a.type.fillna("").to_numpy()
soma = a.somaSide.fillna("").to_numpy()
root = a.rootSide.fillna("").to_numpy()
superclass = brain.superclass


def gray():
    return np.full((H, W, 3), GRAY, np.uint8)


def cells(mask):
    return np.flatnonzero(mask).astype(np.int32)


def run(scene=None, stim=None, measure_ms=MEASURE_MS):
    """scene(t_ms) -> RGB frame during measurement; stim = [(indices, mV)].

    Returns (spike counts per neuron over the measured window, wall seconds).
    """
    brain.reset()
    for _ in range(int(WARM_MS / CHUNK_MS)):
        brain.rgb_step(gray(), CHUNK_MS, learning=False)
    counts = np.zeros(brain.n, np.int64)
    started = time.perf_counter()
    for k in range(int(measure_ms / CHUNK_MS)):
        img = scene(k * CHUNK_MS) if scene else gray()
        c, _ = brain.rgb_step(
            img, CHUNK_MS, learning=False, stimulation=list(stim) if stim else None
        )
        counts += c
    return counts, time.perf_counter() - started


def rates(counts, groups, measure_ms=MEASURE_MS):
    seconds = measure_ms / 1000
    return {
        k: float(counts[ix].sum() / (max(1, len(ix)) * seconds))
        for k, ix in groups.items()
    }
