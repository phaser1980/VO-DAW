"""Small shared DSP helpers used by both offline export and (in future) a
live playback engine — kept tiny and dependency-light on purpose."""
from __future__ import annotations

import math

import numpy as np

from statevo.config import FadeCurve


def fade_curve_gain(progress, curve: FadeCurve):
    """progress: 0..1 (0 = start of fade, 1 = end of fade). Returns a gain
    curve 0..1 for a fade-IN. For a fade-OUT, pass progress reversed
    (i.e. build the ramp then flip it) — see exporter._apply_clip_gain_and_fades."""
    p = np.clip(progress, 0.0, 1.0)
    if curve == FadeCurve.EQUAL_POWER:
        return np.sin(p * math.pi / 2)
    return p


def db_to_gain(db: float) -> float:
    return 10.0 ** (db / 20.0)


def gain_to_db(gain: float) -> float:
    return 20.0 * math.log10(max(gain, 1e-9))
