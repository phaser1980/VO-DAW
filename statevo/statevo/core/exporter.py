"""
Rendering + export.

Pipeline: mix down all tracks/clips -> optional voice chain -> loudness
normalize to the export preset's target -> encode to the target format.
"""
from __future__ import annotations

import datetime as dt
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from statevo.core.dsp_utils import db_to_gain, fade_curve_gain
from statevo.core.loudness import build_loudness_report, normalize_to_lufs
from statevo.core.presets import ExportPreset
from statevo.core.project import Project, Take, Track
from statevo.core.voice_chain import VoiceChain


class ExportError(RuntimeError):
    pass


def render_master(project: Project) -> tuple[np.ndarray, int]:
    """Mix every non-muted track's clips down to a single mono float32
    buffer. This is also what powers the "Play" button — playback in
    this MVP is "render then play", not a live streaming mixer (see
    ARCHITECTURE.md, Playback engine upgrade path)."""
    sr = project.sample_rate
    total_len = int(project.duration_sec * sr) + 1
    if total_len <= 1:
        return np.zeros(0, dtype=np.float32), sr

    any_solo = any(t.solo for t in project.tracks)
    mix = np.zeros(total_len, dtype=np.float32)

    for track in project.tracks:
        if track.muted:
            continue
        if any_solo and not track.solo:
            continue
        track_buf = _render_track(track, project, total_len, sr)
        mix[:len(track_buf)] += track_buf * db_to_gain(track.volume_db)

    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.999:
        mix = mix / peak * 0.999  # safety ceiling before the voice chain's own limiter runs
    return mix, sr


def _render_track(track: Track, project: Project, total_len: int, sr: int) -> np.ndarray:
    buf = np.zeros(total_len, dtype=np.float32)
    for clip in track.clips:
        if clip.muted:
            continue
        take = project.takes.get(clip.take_id)
        if take is None:
            continue
        take_path = _take_path(project, take)
        start_frame = int(clip.source_in_sec * sr)
        frames = int(clip.duration_sec * sr)
        if frames <= 0 or not take_path.exists():
            continue
        with sf.SoundFile(str(take_path)) as f:
            f.seek(start_frame)
            data = f.read(frames=frames, dtype="float32", always_2d=True).mean(axis=1)

        data = _apply_clip_gain_and_fades(data, clip, sr)

        dest_start = int(clip.start_sec * sr)
        dest_end = min(total_len, dest_start + len(data))
        if dest_end > dest_start:
            buf[dest_start:dest_end] += data[: dest_end - dest_start]
    return buf


def _apply_clip_gain_and_fades(data: np.ndarray, clip, sr: int) -> np.ndarray:
    data = data * db_to_gain(clip.gain_db)
    if clip.fade_in_sec > 0 and len(data):
        n = min(int(clip.fade_in_sec * sr), len(data))
        ramp = fade_curve_gain(np.linspace(0, 1, n), clip.fade_curve)
        data[:n] *= ramp
    if clip.fade_out_sec > 0 and len(data):
        n = min(int(clip.fade_out_sec * sr), len(data))
        ramp = fade_curve_gain(np.linspace(0, 1, n), clip.fade_curve)[::-1]
        data[-n:] *= ramp
    return data


def _take_path(project: Project, take: Take) -> Path:
    assert project.root_dir is not None, "Project must be saved before rendering/exporting."
    return project.root_dir / "takes" / take.file_name


def _auto_filename(project: Project, preset: ExportPreset) -> str:
    date_str = dt.datetime.now().strftime("%Y-%m-%d")
    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in project.name).strip().replace(" ", "_")
    return f"{safe_name}_{date_str}_{preset.key}.{preset.extension}"


def export(
    project: Project,
    preset: ExportPreset,
    output_dir: Path,
    apply_voice_chain: bool = True,
    write_loudness_report: bool = True,
) -> dict:
    """Render, process, normalize and encode. Returns a result dict with
    the output path and (if requested) the loudness report."""
    output_dir.mkdir(parents=True, exist_ok=True)

    mix, sr = render_master(project)
    if mix.size == 0:
        raise ExportError("Nothing to export — the project has no recorded audio yet.")

    if apply_voice_chain:
        chain = VoiceChain(project.voice_chain)
        mix = chain.process(mix, sr)

    if preset.target_lufs is not None:
        mix = normalize_to_lufs(mix, sr, preset.target_lufs)

    if preset.sample_rate != sr:
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(preset.sample_rate, sr)
        mix = resample_poly(mix, preset.sample_rate // g, sr // g)
        sr = preset.sample_rate

    out_name = _auto_filename(project, preset)
    out_path = output_dir / out_name

    if preset.audio_format == "wav":
        sf.write(str(out_path), mix, sr, subtype="PCM_24")
    else:
        _encode_via_ffmpeg(mix, sr, out_path, preset)

    result = {"path": str(out_path), "preset": preset.key}

    if write_loudness_report:
        report = build_loudness_report(mix, sr, preset.target_lufs)
        report_path = out_path.with_suffix(out_path.suffix + ".loudness.json")
        report_path.write_text(json.dumps(report, indent=2))
        result["loudness_report"] = report
        result["loudness_report_path"] = str(report_path)

    return result


def _encode_via_ffmpeg(mix: np.ndarray, sr: int, out_path: Path, preset: ExportPreset) -> None:
    if shutil.which("ffmpeg") is None:
        raise ExportError(
            "ffmpeg not found on PATH. StateVO uses ffmpeg to encode MP3/AAC — "
            "install it (e.g. `brew install ffmpeg` / `apt install ffmpeg`) or "
            "use the Clean WAV preset instead."
        )
    tmp_wav = out_path.with_suffix(".tmp.wav")
    sf.write(str(tmp_wav), mix, sr, subtype="PCM_16")
    codec = "aac" if preset.audio_format == "aac" else "libmp3lame"
    cmd = ["ffmpeg", "-y", "-i", str(tmp_wav), "-c:a", codec]
    if preset.bitrate:
        cmd += ["-b:a", preset.bitrate]
    cmd += [str(out_path)]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        raise ExportError(f"ffmpeg encode failed: {e.stderr.decode(errors='ignore')}") from e
    finally:
        tmp_wav.unlink(missing_ok=True)
