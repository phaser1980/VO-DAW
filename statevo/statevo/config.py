"""
Global constants and defaults for StateVO.

Centralising these values keeps the app's "opinionated defaults"
philosophy honest: there should be ONE obvious place to look for
"what does StateVO do by default", not settings scattered everywhere.
"""
from __future__ import annotations

from enum import Enum
from pathlib import Path

APP_NAME = "StateVO"
APP_ORG = "StateVO"

# --- Audio defaults ---------------------------------------------------

DEFAULT_SAMPLE_RATE = 48_000
DEFAULT_CHANNELS = 1          # Mono by default — this is a voice tool, not a stereo music DAW.
DEFAULT_BIT_DEPTH = "PCM_24"  # soundfile subtype for recorded takes.
METER_UPDATE_MS = 40          # ~25fps peak meter / playhead refresh.

# --- Loudness defaults --------------------------------------------------

DEFAULT_LOUDNESS_TARGET_LUFS = -16.0   # Sensible podcast-ish default until a preset is chosen.

# --- Project layout on disk ---------------------------------------------
#
#   <name>.svoproj/
#       project.json      <- PROJECT_JSON_FILENAME
#       takes/             <- TAKES_DIRNAME  (raw recorded WAV files, never overwritten)
#       exports/           <- EXPORTS_DIRNAME (rendered deliverables)

PROJECT_DIR_SUFFIX = ".svoproj"
PROJECT_JSON_FILENAME = "project.json"
TAKES_DIRNAME = "takes"
EXPORTS_DIRNAME = "exports"
REPORTS_DIRNAME = "reports"  # reserved for future standalone report exports

# --- Enums ---------------------------------------------------------------


class TrackKind(str, Enum):
    VOICE = "voice"
    BED_SFX = "bed_sfx"


class FadeCurve(str, Enum):
    LINEAR = "linear"
    EQUAL_POWER = "equal_power"


def default_projects_dir() -> Path:
    """Where new projects land unless the user picks somewhere else."""
    return Path.home() / "StateVO Projects"
