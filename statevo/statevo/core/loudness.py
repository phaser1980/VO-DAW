"""
Loudness measurement + normalization (ITU-R BS.1770 via pyloudnorm).

This is the backbone of "export ready for social" — StateVO always
shows you the LUFS you're at, and on export it normalizes to the
preset's target rather than making you guess and re-export five times.
"""
from __future__ import annotations

import numpy as np
import pyloudnorm as pyln


def measure_integrated_lufs(audio: np.ndarray, sr: int) -> float:
    """audio: float32, shape (samples,) mono or (samples, channels)."""
    meter = pyln.Meter(sr)
    data = audio if audio.ndim > 1 else audio.reshape(-1, 1)
    return float(meter.integrated_loudness(data))


def normalize_to_lufs(audio: np.ndarray, sr: int, target_lufs: float) -> np.ndarray:
    current = measure_integrated_lufs(audio, sr)
    if current == float("-inf"):
        return audio  # silence — nothing to normalize.
    return pyln.normalize.loudness(audio, current, target_lufs)


def estimate_true_peak_db(audio: np.ndarray) -> float:
    """Cheap true-peak approximation via 4x oversampling. Good enough for
    the loudness report; not a substitute for a broadcast-grade meter."""
    from scipy.signal import resample_poly
    oversampled = resample_poly(audio, up=4, down=1) if audio.size else audio
    peak = float(np.max(np.abs(oversampled))) if oversampled.size else 0.0
    return 20.0 * np.log10(max(peak, 1e-9))


def build_loudness_report(audio: np.ndarray, sr: int, target_lufs: float | None) -> dict:
    integrated = measure_integrated_lufs(audio, sr)
    true_peak = estimate_true_peak_db(audio)
    return {
        "integrated_lufs": round(integrated, 2),
        "true_peak_dbtp": round(true_peak, 2),
        "target_lufs": target_lufs,
        "delta_lufs": round(integrated - target_lufs, 2) if target_lufs is not None else None,
    }
