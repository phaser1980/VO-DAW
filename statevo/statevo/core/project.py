"""
Core project data model.

Everything here is a plain dataclass with to_dict/from_dict methods —
deliberately dumb data, no Qt, no audio I/O. Project files are human
readable JSON so a user (or a script) can inspect / hand-edit them if
they ever need to.

Audio itself is never embedded in the JSON — Takes reference WAV files
on disk inside the project folder. This keeps project files tiny and
makes non-destructive editing trivial: edits only ever change
*references* into the take audio (in/out points, gain, fades), never
the take audio itself.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from statevo.config import DEFAULT_CHANNELS, DEFAULT_SAMPLE_RATE, FadeCurve, TrackKind


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class Marker:
    id: str = field(default_factory=_new_id)
    name: str = "Marker"
    position_sec: float = 0.0
    color: str = "#57C7FF"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Marker":
        return cls(**d)


@dataclass
class Take:
    """A single recorded pass. Never overwritten — new takes just pile up
    (this is what makes "easy multi-take recording" easy: there's simply
    nothing to lose)."""
    id: str = field(default_factory=_new_id)
    file_name: str = ""              # relative to <project>/takes/
    recorded_at: float = field(default_factory=time.time)
    duration_sec: float = 0.0
    sample_rate: int = DEFAULT_SAMPLE_RATE
    channels: int = DEFAULT_CHANNELS
    label: str = ""                  # e.g. "Take 3" — auto-filled by the engine.

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Take":
        return cls(**d)


@dataclass
class Clip:
    """
    A reference into a Take, placed on the timeline.

    Editing (split / trim / fade) only ever mutates these fields — the
    underlying Take's audio file on disk is read-only after it's recorded.
    """
    id: str = field(default_factory=_new_id)
    take_id: str = ""
    start_sec: float = 0.0        # position on the track timeline
    source_in_sec: float = 0.0    # in-point within the take
    source_out_sec: float = 0.0   # out-point within the take
    gain_db: float = 0.0
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    fade_curve: FadeCurve = FadeCurve.EQUAL_POWER
    muted: bool = False

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.source_out_sec - self.source_in_sec)

    @property
    def end_sec(self) -> float:
        return self.start_sec + self.duration_sec

    def to_dict(self) -> dict:
        d = asdict(self)
        d["fade_curve"] = self.fade_curve.value
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Clip":
        d = dict(d)
        d["fade_curve"] = FadeCurve(d.get("fade_curve", FadeCurve.EQUAL_POWER.value))
        return cls(**d)


@dataclass
class Track:
    id: str = field(default_factory=_new_id)
    name: str = "Voice"
    kind: TrackKind = TrackKind.VOICE
    clips: list[Clip] = field(default_factory=list)
    volume_db: float = 0.0
    muted: bool = False
    solo: bool = False
    collapsed: bool = False  # bed/SFX track starts collapsed per spec

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind.value,
            "clips": [c.to_dict() for c in self.clips],
            "volume_db": self.volume_db,
            "muted": self.muted,
            "solo": self.solo,
            "collapsed": self.collapsed,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Track":
        return cls(
            id=d["id"], name=d["name"], kind=TrackKind(d["kind"]),
            clips=[Clip.from_dict(c) for c in d.get("clips", [])],
            volume_db=d.get("volume_db", 0.0), muted=d.get("muted", False),
            solo=d.get("solo", False), collapsed=d.get("collapsed", False),
        )


@dataclass
class VoiceChainSettings:
    """Fixed-order voice chain. Stages can be toggled but not reordered —
    reordering is exactly the kind of "power user knob" this app avoids."""
    preset: str = "podcast"

    noise_reduction_enabled: bool = True
    noise_reduction_amount: float = 0.6       # 0..1

    deesser_enabled: bool = True
    deesser_threshold_db: float = -18.0
    deesser_frequency_hz: float = 6500.0

    compressor_enabled: bool = True
    compressor_threshold_db: float = -20.0
    compressor_ratio: float = 3.0
    compressor_attack_ms: float = 8.0
    compressor_release_ms: float = 120.0

    eq_enabled: bool = True
    eq_hpf_hz: float = 80.0
    eq_presence_db: float = 2.5
    eq_air_db: float = 1.5

    limiter_enabled: bool = True
    limiter_ceiling_db: float = -1.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "VoiceChainSettings":
        return cls(**d)


@dataclass
class ScriptSection:
    heading: str
    body: str
    order: int


@dataclass
class Project:
    id: str = field(default_factory=_new_id)
    name: str = "Untitled Episode"
    created_at: float = field(default_factory=time.time)
    sample_rate: int = DEFAULT_SAMPLE_RATE
    channels: int = DEFAULT_CHANNELS

    tracks: list[Track] = field(default_factory=list)
    takes: dict[str, Take] = field(default_factory=dict)
    markers: list[Marker] = field(default_factory=list)

    voice_chain: VoiceChainSettings = field(default_factory=VoiceChainSettings)
    loudness_target_lufs: float = -16.0

    script_text: str = ""
    script_sections: list[ScriptSection] = field(default_factory=list)

    version: int = 1

    # Not serialized into project.json — set by project_io on load/save.
    root_dir: Optional[Path] = field(default=None, repr=False, compare=False)

    # -- convenience ----------------------------------------------------

    @property
    def primary_voice_track(self) -> Track:
        for t in self.tracks:
            if t.kind == TrackKind.VOICE:
                return t
        raise ValueError("Project has no voice track — this should never happen.")

    @property
    def duration_sec(self) -> float:
        ends = [c.end_sec for t in self.tracks for c in t.clips]
        return max(ends) if ends else 0.0

    @classmethod
    def new(cls, name: str, sample_rate: int = DEFAULT_SAMPLE_RATE) -> "Project":
        """Factory for a brand-new project with StateVO's opinionated
        default layout: one voice track, one (collapsed) bed/SFX track."""
        project = cls(name=name, sample_rate=sample_rate)
        project.tracks = [
            Track(name="Voice", kind=TrackKind.VOICE),
            Track(name="Beds / SFX", kind=TrackKind.BED_SFX, collapsed=True),
        ]
        return project

    # -- serialization ----------------------------------------------------

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "created_at": self.created_at,
            "sample_rate": self.sample_rate, "channels": self.channels,
            "tracks": [t.to_dict() for t in self.tracks],
            "takes": {k: v.to_dict() for k, v in self.takes.items()},
            "markers": [m.to_dict() for m in self.markers],
            "voice_chain": self.voice_chain.to_dict(),
            "loudness_target_lufs": self.loudness_target_lufs,
            "script_text": self.script_text,
            "script_sections": [asdict(s) for s in self.script_sections],
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        return cls(
            id=d["id"], name=d["name"], created_at=d["created_at"],
            sample_rate=d["sample_rate"], channels=d["channels"],
            tracks=[Track.from_dict(t) for t in d.get("tracks", [])],
            takes={k: Take.from_dict(v) for k, v in d.get("takes", {}).items()},
            markers=[Marker.from_dict(m) for m in d.get("markers", [])],
            voice_chain=VoiceChainSettings.from_dict(d.get("voice_chain", {})),
            loudness_target_lufs=d.get("loudness_target_lufs", -16.0),
            script_text=d.get("script_text", ""),
            script_sections=[ScriptSection(**s) for s in d.get("script_sections", [])],
            version=d.get("version", 1),
        )
