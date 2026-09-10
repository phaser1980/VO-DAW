"""Sanity tests for non-destructive edit operations."""
from statevo.config import TrackKind
from statevo.core import edit_ops
from statevo.core.project import Clip, Track


def _track_with_one_clip(duration=10.0) -> Track:
    track = Track(name="Voice", kind=TrackKind.VOICE)
    track.clips.append(Clip(take_id="take_1", start_sec=0.0, source_in_sec=0.0, source_out_sec=duration))
    return track


def test_split_clip_creates_two_contiguous_clips():
    track = _track_with_one_clip(10.0)
    original = track.clips[0]
    result = edit_ops.split_clip(track, original, at_sec=4.0)
    assert result is not None
    left, right = result
    assert len(track.clips) == 2
    assert left.start_sec == 0.0 and left.duration_sec == 4.0
    assert right.start_sec == 4.0 and abs(right.duration_sec - 6.0) < 1e-6
    assert left.end_sec == right.start_sec  # contiguous, no gap


def test_split_outside_clip_bounds_is_a_no_op():
    track = _track_with_one_clip(10.0)
    result = edit_ops.split_clip(track, track.clips[0], at_sec=20.0)
    assert result is None
    assert len(track.clips) == 1


def test_ripple_delete_shifts_later_clips_left():
    track = _track_with_one_clip(5.0)
    second = Clip(take_id="take_1", start_sec=5.0, source_in_sec=0.0, source_out_sec=3.0)
    track.clips.append(second)
    edit_ops.ripple_delete(track, track.clips[0])
    assert len(track.clips) == 1
    assert track.clips[0].start_sec == 0.0  # shifted left by the deleted clip's 5s


def test_crossfade_overlaps_adjacent_clips():
    track = _track_with_one_clip(5.0)
    second = Clip(take_id="take_1", start_sec=5.0, source_in_sec=0.0, source_out_sec=3.0)
    track.clips.append(second)
    edit_ops.crossfade(track, track.clips[0], track.clips[1], duration_sec=0.5)
    assert second.start_sec == 4.5
    assert track.clips[0].fade_out_sec == 0.5
    assert second.fade_in_sec == 0.5


def test_build_comp_overlaps_and_orders_clips():
    track = Track(name="Voice", kind=TrackKind.VOICE)
    selections = [("take_1", 0.0, 2.0), ("take_2", 5.0, 8.0)]
    clips = edit_ops.build_comp(track, selections, start_at_sec=0.0, crossfade_sec=0.1)
    assert len(clips) == 2
    assert clips[0].start_sec == 0.0
    # second clip should start 0.1s before the first clip's natural end (2.0)
    assert abs(clips[1].start_sec - 1.9) < 1e-6
    assert clips[0].fade_out_sec == 0.1
    assert clips[1].fade_in_sec == 0.1
