"""Sanity tests for the voice chain — shape/NaN checks only; this isn't
meant to assert exact DSP output, just that the chain doesn't blow up."""
import numpy as np
import pytest

pytest.importorskip("pedalboard")

from statevo.core.project import VoiceChainSettings  # noqa: E402
from statevo.core.voice_chain import VoiceChain  # noqa: E402


def _noise(seconds=1.0, sr=48000):
    rng = np.random.default_rng(0)
    return rng.normal(0, 0.05, int(sr * seconds)).astype(np.float32), sr


def test_chain_preserves_shape_with_everything_enabled():
    audio, sr = _noise()
    chain = VoiceChain(VoiceChainSettings())
    out = chain.process(audio, sr)
    assert out.shape == audio.shape
    assert np.isfinite(out).all()


def test_chain_is_a_no_op_when_everything_disabled():
    audio, sr = _noise()
    settings = VoiceChainSettings(
        noise_reduction_enabled=False, deesser_enabled=False,
        compressor_enabled=False, eq_enabled=False, limiter_enabled=False,
    )
    out = VoiceChain(settings).process(audio, sr)
    assert out.shape == audio.shape
    assert np.allclose(out, audio)
