"""Sanity tests for LUFS measurement/normalization. Skips gracefully if
pyloudnorm isn't installed in the current environment."""
import numpy as np
import pytest

pytest.importorskip("pyloudnorm")

from statevo.core.loudness import measure_integrated_lufs, normalize_to_lufs  # noqa: E402


def _test_tone(seconds=3.0, sr=48000, freq=440.0, amplitude=0.2):
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * amplitude).astype(np.float32), sr


def test_normalize_moves_loudness_towards_target():
    audio, sr = _test_tone()
    target = -18.0
    normalized = normalize_to_lufs(audio, sr, target)
    result_lufs = measure_integrated_lufs(normalized, sr)
    assert abs(result_lufs - target) < 0.5
