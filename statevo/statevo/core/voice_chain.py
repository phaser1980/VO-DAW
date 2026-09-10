"""
The fixed voice-processing chain.

StateVO deliberately does NOT expose a generic plugin chain — just five
named stages, always in this fixed order, each a simple on/off toggle
plus a couple of knobs owned by a preset. That's the whole point: good
defaults instead of a routing matrix.

Stage order: Noise Reduction -> De-esser -> Compressor -> EQ -> Limiter.
"""
from __future__ import annotations

import numpy as np
from pedalboard import (
    Compressor,
    HighpassFilter,
    HighShelfFilter,
    Limiter,
    LowShelfFilter,
    NoiseGate,
    Pedalboard,
    PeakFilter,
)

from statevo.core.project import VoiceChainSettings

try:
    import noisereduce as nr
    _HAS_NOISEREDUCE = True
except ImportError:  # optional dependency — see requirements.txt "noise" extra
    _HAS_NOISEREDUCE = False


def _to_pedalboard_shape(audio: np.ndarray) -> np.ndarray:
    """pedalboard expects float32, shape (channels, samples). Our internal
    convention is mono float32, shape (samples,) — convert both ways."""
    if audio.ndim == 1:
        return audio.astype(np.float32)[np.newaxis, :]
    return audio.astype(np.float32)


def _from_pedalboard_shape(audio: np.ndarray, was_1d: bool) -> np.ndarray:
    return audio[0] if was_1d and audio.ndim == 2 else audio


def _simple_envelope_follower(signal: np.ndarray, sr: int, attack_ms: float = 5.0, release_ms: float = 80.0) -> np.ndarray:
    """A basic peak-follower used to drive the de-esser's gain reduction.

    NOTE (perf): this is a plain Python loop and is the slowest part of
    the chain on long takes (roughly O(n) in pure Python). It's correct
    and simple, which matters more for an MVP than speed, but it's the
    first thing to vectorize (e.g. via numba, or a chunked block
    approximation) if export times become annoying on long recordings.
    """
    attack = np.exp(-1.0 / (sr * attack_ms / 1000.0))
    release = np.exp(-1.0 / (sr * release_ms / 1000.0))
    env = np.zeros_like(signal)
    level = 0.0
    abs_sig = np.abs(signal)
    for i, s in enumerate(abs_sig):
        coeff = attack if s > level else release
        level = coeff * level + (1 - coeff) * s
        env[i] = level
    return env


class VoiceChain:
    """Wraps VoiceChainSettings and does the actual DSP for offline
    processing (used by the exporter, and for the live LUFS preview)."""

    def __init__(self, settings: VoiceChainSettings):
        self.settings = settings

    # -- stage 1: noise reduction --------------------------------------

    def _reduce_noise(self, audio: np.ndarray, sr: int) -> np.ndarray:
        s = self.settings
        if not s.noise_reduction_enabled:
            return audio
        if _HAS_NOISEREDUCE:
            # Spectral gating against the whole clip's noise floor. Good
            # enough for consistent voiceover room tone; per-clip noise
            # profiling (record 1s of silence, use it as the noise
            # fingerprint) is a natural upgrade slot for a future AI module.
            return nr.reduce_noise(y=audio, sr=sr, prop_decrease=s.noise_reduction_amount)
        # Dependency-free fallback: a gentle noise gate via pedalboard.
        board = Pedalboard([NoiseGate(threshold_db=-45.0, ratio=2.0 + 3.0 * s.noise_reduction_amount)])
        shaped = _to_pedalboard_shape(audio)
        return _from_pedalboard_shape(board(shaped, sr), audio.ndim == 1)

    # -- stage 2: de-esser -----------------------------------------------

    def _deess(self, audio: np.ndarray, sr: int) -> np.ndarray:
        s = self.settings
        if not s.deesser_enabled:
            return audio
        # Split-band de-essing: isolate the sibilant band, measure its
        # envelope, and pull gain down only in that band when it's hot.
        # pedalboard has no built-in sidechain de-esser, so this is a
        # small hand-rolled split-band compressor.
        band_lo = max(2000.0, s.deesser_frequency_hz - 2000.0)
        band_hi = min(sr / 2 - 100, s.deesser_frequency_hz + 3000.0)
        shaped = _to_pedalboard_shape(audio)
        band_board = Pedalboard([
            HighpassFilter(cutoff_frequency_hz=band_lo),
            LowShelfFilter(cutoff_frequency_hz=band_hi, gain_db=-24.0),
        ])
        sibilant_band = _from_pedalboard_shape(band_board(shaped, sr), audio.ndim == 1)

        threshold_lin = 10 ** (s.deesser_threshold_db / 20.0)
        envelope = _simple_envelope_follower(sibilant_band, sr, attack_ms=2.0, release_ms=60.0)
        reduction = np.ones_like(envelope)
        over = envelope > threshold_lin
        # ~4:1-ish soft reduction in the sibilant band above threshold.
        reduction[over] = (threshold_lin / np.maximum(envelope[over], 1e-9)) ** 0.75
        return audio - sibilant_band + (sibilant_band * reduction)

    # -- stages 3-5: compressor / EQ / limiter via pedalboard -------------

    def _build_pedalboard_chain(self) -> Pedalboard:
        s = self.settings
        stages = []
        if s.eq_enabled:
            stages.append(HighpassFilter(cutoff_frequency_hz=s.eq_hpf_hz))
        if s.compressor_enabled:
            stages.append(Compressor(
                threshold_db=s.compressor_threshold_db,
                ratio=s.compressor_ratio,
                attack_ms=s.compressor_attack_ms,
                release_ms=s.compressor_release_ms,
            ))
        if s.eq_enabled:
            stages.append(PeakFilter(cutoff_frequency_hz=3000.0, gain_db=s.eq_presence_db, q=0.9))
            stages.append(HighShelfFilter(cutoff_frequency_hz=9000.0, gain_db=s.eq_air_db))
        if s.limiter_enabled:
            stages.append(Limiter(threshold_db=s.limiter_ceiling_db, release_ms=100.0))
        return Pedalboard(stages)

    # -- public entry point -----------------------------------------------

    def process(self, audio: np.ndarray, sr: int) -> np.ndarray:
        """Run the full chain, in fixed order, honouring each stage's
        enabled flag. `audio` is mono float32, shape (samples,)."""
        out = self._reduce_noise(audio, sr)
        out = self._deess(out, sr)

        board = self._build_pedalboard_chain()
        if len(board) > 0:
            shaped = _to_pedalboard_shape(out)
            out = _from_pedalboard_shape(board(shaped, sr), out.ndim == 1)
        return out
