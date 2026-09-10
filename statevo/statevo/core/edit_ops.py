"""
Non-destructive edit operations.

These functions never touch audio files on disk — they only create /
mutate Clip objects (timeline placement + in/out points + fades). The
exporter and playback engine are what actually read audio and apply
these numbers when rendering.
"""
from __future__ import annotations

import uuid
from dataclasses import replace

from statevo.config import FadeCurve
from statevo.core.project import Clip, Track


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def split_clip(track: Track, clip: Clip, at_sec: float) -> tuple[Clip, Clip] | None:
    """Split a clip at an absolute timeline position. Returns the two new
    clips (already inserted into the track in place of the original), or
    None if `at_sec` isn't inside the clip."""
    if not (clip.start_sec < at_sec < clip.end_sec):
        return None

    offset_into_clip = at_sec - clip.start_sec
    split_source_point = clip.source_in_sec + offset_into_clip

    left = replace(clip, source_out_sec=split_source_point, fade_out_sec=0.0)
    right = replace(
        clip,
        id=_new_id(),
        start_sec=at_sec,
        source_in_sec=split_source_point,
        fade_in_sec=0.0,
    )

    idx = track.clips.index(clip)
    track.clips[idx:idx + 1] = [left, right]
    return left, right


def add_clip(track: Track, take, start_sec: float = 0.0) -> Clip:
    """Place an entire take as a new clip on a track at the given timeline
    position. Used for drag-and-dropped SFX/ambience as well as anywhere
    else a whole take needs to land on the timeline in one shot."""
    clip = Clip(
        take_id=take.id,
        start_sec=max(0.0, start_sec),
        source_in_sec=0.0,
        source_out_sec=take.duration_sec,
    )
    track.clips.append(clip)
    return clip


def trim_clip(clip: Clip, *, new_in_sec: float | None = None, new_out_sec: float | None = None) -> None:
    """Adjust a clip's in/out points (and shift its timeline start to
    match a change at the head). Trimming never edits the underlying
    take file — it only narrows the window read from it."""
    if new_in_sec is not None:
        delta = new_in_sec - clip.source_in_sec
        clip.source_in_sec = max(0.0, new_in_sec)
        clip.start_sec += delta
    if new_out_sec is not None:
        clip.source_out_sec = max(clip.source_in_sec, new_out_sec)


def apply_fade(clip: Clip, *, fade_in_sec: float | None = None,
                fade_out_sec: float | None = None,
                curve: FadeCurve = FadeCurve.EQUAL_POWER) -> None:
    if fade_in_sec is not None:
        clip.fade_in_sec = max(0.0, min(fade_in_sec, clip.duration_sec))
    if fade_out_sec is not None:
        clip.fade_out_sec = max(0.0, min(fade_out_sec, clip.duration_sec))
    clip.fade_curve = curve


def crossfade(track: Track, clip_a: Clip, clip_b: Clip, duration_sec: float) -> None:
    """Overlap the tail of clip_a with the head of clip_b. Assumes clip_b
    currently starts at or after clip_a ends (i.e. they're adjacent, the
    normal case right after a split or a comp build)."""
    duration_sec = max(0.0, min(duration_sec, clip_a.duration_sec, clip_b.duration_sec))
    clip_b.start_sec = clip_a.end_sec - duration_sec
    clip_a.fade_out_sec = duration_sec
    clip_b.fade_in_sec = duration_sec


def ripple_delete(track: Track, clip: Clip) -> None:
    """Remove a clip and shift every later clip left to close the gap —
    the "ripple editing" option from the spec. Off by default; the
    caller decides when to use this vs. a plain delete that leaves a gap."""
    removed_duration = clip.duration_sec
    removed_start = clip.start_sec
    track.clips.remove(clip)
    for c in track.clips:
        if c.start_sec >= removed_start:
            c.start_sec -= removed_duration


def delete_clip(track: Track, clip: Clip) -> None:
    """Plain delete — leaves a gap, doesn't ripple."""
    track.clips.remove(clip)


def build_comp(
    track: Track,
    selections: list[tuple[str, float, float]],
    start_at_sec: float,
    crossfade_sec: float = 0.05,
) -> list[Clip]:
    """Take comping primitive: stitch a sequence of "keeper" regions —
    possibly from different takes — into consecutive clips on the
    timeline, with a short auto-crossfade at each join.

    selections: list of (take_id, in_sec, out_sec), in the order they
    should play. The UI calls this once per set of regions the user has
    marked as "the good bits" across one or more takes.
    """
    new_clips: list[Clip] = []
    cursor = start_at_sec
    for i, (take_id, in_sec, out_sec) in enumerate(selections):
        overlap = crossfade_sec if i > 0 else 0.0
        clip = Clip(take_id=take_id, start_sec=cursor - overlap, source_in_sec=in_sec, source_out_sec=out_sec)
        if i > 0:
            clip.fade_in_sec = crossfade_sec
            new_clips[-1].fade_out_sec = crossfade_sec
        new_clips.append(clip)
        cursor = clip.start_sec + clip.duration_sec
    track.clips.extend(new_clips)
    return new_clips
