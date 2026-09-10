"""
Importing external audio (SFX, ambience, anything not recorded directly
in StateVO) as Takes.

Everything that lands in <project>/takes/ gets transcoded to WAV at the
project's sample rate/channel count via ffmpeg first. That keeps every
take in one predictable format regardless of what got dragged in — an
mp3 from a sound library, a stray ogg/flac, whatever — so the peak
generator and renderer elsewhere in core/ never have to think about
source format.
"""
from __future__ import annotations

import shutil
import subprocess
import uuid
from pathlib import Path

import soundfile as sf

from statevo.config import TAKES_DIRNAME
from statevo.core.project import Project, Take


class MediaImportError(RuntimeError):
    pass


def import_external_audio(project: Project, source_path: Path) -> Take:
    """Copy/transcode an external audio file into the project's takes/
    folder and return a new Take describing it.

    Does NOT register the Take on the project or place a Clip — the
    caller decides where it lands on the timeline (mirrors how
    MainWindow, not the view, has always owned take creation for
    recordings)."""
    if project.root_dir is None:
        raise MediaImportError("Save the project before importing audio.")
    if not source_path.exists():
        raise MediaImportError(f"File not found: {source_path}")
    if shutil.which("ffmpeg") is None:
        raise MediaImportError(
            "ffmpeg not found on PATH — StateVO uses it to normalize dropped-in "
            "audio to a consistent format. Install ffmpeg and try again."
        )

    takes_dir = project.root_dir / TAKES_DIRNAME
    takes_dir.mkdir(exist_ok=True)

    out_name = f"sfx_{uuid.uuid4().hex[:8]}.wav"
    out_path = takes_dir / out_name

    cmd = [
        "ffmpeg", "-y", "-i", str(source_path),
        "-ar", str(project.sample_rate),
        "-ac", str(project.channels),
        "-c:a", "pcm_s24le",
        str(out_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        stderr_tail = e.stderr.decode(errors="ignore")[-400:] if e.stderr else "unknown ffmpeg error"
        raise MediaImportError(f"Couldn't import '{source_path.name}': {stderr_tail}") from e

    with sf.SoundFile(str(out_path)) as f:
        duration_sec = len(f) / f.samplerate

    return Take(
        file_name=out_name,
        duration_sec=duration_sec,
        sample_rate=project.sample_rate,
        channels=project.channels,
        label=_clean_label(source_path.stem),
    )


def _clean_label(stem: str) -> str:
    label = stem.replace("_", " ").replace("-", " ").strip()
    if not label:
        return "SFX"
    return label[:40] + "…" if len(label) > 40 else label
