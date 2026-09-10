"""Sanity tests for the project data model + save/load round trip."""
import tempfile
from pathlib import Path

from statevo.config import TrackKind
from statevo.core import project_io
from statevo.core.project import Clip, Marker, Project, Take


def test_new_project_has_default_tracks():
    project = Project.new("Test Episode")
    kinds = {t.kind for t in project.tracks}
    assert TrackKind.VOICE in kinds
    assert TrackKind.BED_SFX in kinds
    assert project.primary_voice_track.kind == TrackKind.VOICE


def test_save_and_load_round_trip():
    project = Project.new("Round Trip Episode")
    take = Take(file_name="take_001.wav", duration_sec=12.5)
    project.takes[take.id] = take
    project.primary_voice_track.clips.append(
        Clip(take_id=take.id, start_sec=0.0, source_in_sec=0.0, source_out_sec=12.5)
    )
    project.markers.append(Marker(name="Cold Open", position_sec=0.0))

    with tempfile.TemporaryDirectory() as tmp:
        project_dir = Path(tmp) / "Round_Trip_Episode.svoproj"
        project_io.save_project(project, project_dir)
        reloaded = project_io.load_project(project_dir)

    assert reloaded.name == "Round Trip Episode"
    assert len(reloaded.takes) == 1
    assert reloaded.primary_voice_track.clips[0].duration_sec == 12.5
    assert reloaded.markers[0].name == "Cold Open"
