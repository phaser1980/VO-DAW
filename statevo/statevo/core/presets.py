"""Named, opinionated presets — the "good decisions over endless options"
layer. Everything a user picks from a dropdown lives here in one place."""
from __future__ import annotations

from dataclasses import dataclass

from statevo.core.project import VoiceChainSettings

# -- Voice processing presets (spec: "Social / Reels", "Podcast", "Raw") ----

VOICE_CHAIN_PRESETS: dict[str, VoiceChainSettings] = {
    "social": VoiceChainSettings(
        preset="social",
        noise_reduction_enabled=True, noise_reduction_amount=0.7,
        deesser_enabled=True, deesser_threshold_db=-16.0,
        compressor_enabled=True, compressor_threshold_db=-18.0, compressor_ratio=4.0,
        compressor_attack_ms=5.0, compressor_release_ms=100.0,
        eq_enabled=True, eq_hpf_hz=90.0, eq_presence_db=3.5, eq_air_db=2.0,
        limiter_enabled=True, limiter_ceiling_db=-1.0,
    ),
    "podcast": VoiceChainSettings(
        preset="podcast",
        noise_reduction_enabled=True, noise_reduction_amount=0.5,
        deesser_enabled=True, deesser_threshold_db=-20.0,
        compressor_enabled=True, compressor_threshold_db=-22.0, compressor_ratio=2.5,
        compressor_attack_ms=10.0, compressor_release_ms=150.0,
        eq_enabled=True, eq_hpf_hz=75.0, eq_presence_db=2.0, eq_air_db=1.0,
        limiter_enabled=True, limiter_ceiling_db=-1.5,
    ),
    "raw": VoiceChainSettings(
        preset="raw",
        noise_reduction_enabled=False, deesser_enabled=False,
        compressor_enabled=False, eq_enabled=False, limiter_enabled=False,
    ),
}


# -- Export presets (spec: IG Reel/TikTok, YouTube/general, Clean WAV) -----

@dataclass
class ExportPreset:
    key: str
    label: str
    target_lufs: float | None   # None = don't touch loudness (Clean WAV)
    audio_format: str           # "wav" | "mp3" | "aac"
    extension: str
    sample_rate: int
    bitrate: str | None = None  # for lossy formats


EXPORT_PRESETS: dict[str, ExportPreset] = {
    "ig_reel_tiktok": ExportPreset(
        key="ig_reel_tiktok", label="Instagram Reel / TikTok (-14 LUFS, AAC)",
        target_lufs=-14.0, audio_format="aac", extension="m4a",
        sample_rate=44_100, bitrate="192k",
    ),
    "youtube": ExportPreset(
        key="youtube", label="YouTube / General (-14 LUFS, AAC)",
        target_lufs=-14.0, audio_format="aac", extension="m4a",
        sample_rate=48_000, bitrate="256k",
    ),
    "clean_wav": ExportPreset(
        key="clean_wav", label="Clean WAV (no loudness change)",
        target_lufs=None, audio_format="wav", extension="wav",
        sample_rate=48_000,
    ),
}
