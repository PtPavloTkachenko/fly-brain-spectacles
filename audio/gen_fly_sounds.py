"""Procedural fly sounds for the lens (no samples, reproducible):

    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<repo>/audio/gen_fly_sounds.py"

- fly_buzz.wav: seamless 2 s wingbeat loop. A real Drosophila beats ~200 Hz; our flies are
  giant, so 170 Hz with stroke harmonics, a little vibrato and periodic (FFT-built) air noise.
  Every modulation completes whole cycles in 2 s, so the loop has no click.
- fly_song.wav: courtship song as the male sings it with one wing: a pulse train (3-4 cycles of
  ~260 Hz, 35 ms inter-pulse interval) then a softer ~160 Hz sine song. Played only while the
  brain's song command neuron pIP10 fires.
Each file self-checks (not silent, no clipping, loop seam continuity for the buzz).
"""

import wave
from pathlib import Path

import numpy as np

SR = 44100
REPO = Path(__file__).resolve().parent.parent
# both lens projects take the same wav files (one feature state, RUNBOOK: copy, never merge)
OUTS = [REPO / p / "Assets/Fly/Audio" for p in ("Spectacles-5.23", "Spectacles-5.15")]


def write(name, x):
    x = np.asarray(x, np.float64)
    peak = np.max(np.abs(x))
    assert peak > 0.05, f"{name}: silent"
    x = x / peak * 0.85
    for out in OUTS:
        out.mkdir(parents=True, exist_ok=True)
        with wave.open(str(out / name), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((x * 32767).astype(np.int16).tobytes())
    rms = float(np.sqrt(np.mean(x * x)))
    print(f"{name}: {len(x) / SR:.2f} s, rms {rms:.3f}")
    return x


def periodic_noise(n, lo, hi, rng):
    """Band-limited noise that loops perfectly (built in the frequency domain)."""
    spec = np.zeros(n // 2 + 1, complex)
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f >= lo) & (f <= hi)
    spec[band] = np.exp(1j * rng.uniform(0, 2 * np.pi, band.sum()))
    x = np.fft.irfft(spec, n)
    return x / np.max(np.abs(x))


def buzz():
    rng = np.random.default_rng(3)
    n = SR * 2
    t = np.arange(n) / SR
    f0 = 170.0  # 340 whole cycles in 2 s
    phase = 2 * np.pi * f0 * t + 0.12 * np.sin(2 * np.pi * 3 * t)  # 3 Hz vibrato: 6 cycles
    x = sum(a * np.sin(k * phase) for k, a in [(1, 1.0), (2, 0.6), (3, 0.38), (4, 0.22), (5, 0.13), (6, 0.08), (8, 0.04)])
    x = x * (0.85 + 0.15 * np.sin(2 * np.pi * 5 * t))  # wing-stroke unevenness, 10 cycles
    x = x + 0.08 * periodic_noise(n, 900, 4200, rng)
    x = write("fly_buzz.wav", x)
    seam = abs(x[-1] - x[0])
    step = np.median(np.abs(np.diff(x)))
    assert seam < 8 * step + 1e-3, f"loop seam jump {seam:.4f} vs typical step {step:.4f}"


def song():
    t_total = 2.1
    n = int(SR * t_total)
    x = np.zeros(n)
    t = np.arange(n) / SR
    # pulse song: 40 pulses, 35 ms apart, gaussian-windowed 260 Hz carrier (sigma 3 ms)
    for k in range(40):
        c = 0.02 + k * 0.035
        env = np.exp(-((t - c) ** 2) / (2 * 0.003 ** 2))
        x += env * np.sin(2 * np.pi * 260 * (t - c))
    # sine song: 160 Hz hum with soft in/out
    s0, s1 = 1.45, 2.05
    win = np.clip((t - s0) / 0.08, 0, 1) * np.clip((s1 - t) / 0.12, 0, 1)
    x += 0.45 * win * np.sin(2 * np.pi * 160 * t)
    write("fly_song.wav", x)


if __name__ == "__main__":
    buzz()
    song()
