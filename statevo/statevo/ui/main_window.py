"""
Main window — assembles the transport, waveform, voice chain strip,
script panel and meters into StateVO's single-screen workflow.

This is the only module that knows about *all* the pieces; every other
UI module is self-contained and only talks to MainWindow via Qt signals.
"""
from __future__ import annotations

import time as _time
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence, QShortcut
from PySide6.QtWidgets import QDockWidget, QFileDialog, QMainWindow, QMessageBox, QVBoxLayout, QWidget

from statevo.config import TAKES_DIRNAME, TrackKind, default_projects_dir
from statevo.core import edit_ops, media_import, project_io
from statevo.core.audio_engine import AudioEngine
from statevo.core.exporter import render_master
from statevo.core.loudness import measure_integrated_lufs
from statevo.core.project import Clip, Marker, Project, Take, Track
from statevo.core.waveform import generate_peaks
from statevo.ui.export_dialog import ExportDialog
from statevo.ui.script_panel import ScriptPanel
from statevo.ui.transport_bar import TransportBar
from statevo.ui.voice_chain_strip import VoiceChainStrip
from statevo.ui.timeline_view import TimelineView


class MainWindow(QMainWindow):
    def __init__(self, project: Project):
        super().__init__()
        self.project = project
        self.engine = AudioEngine(sample_rate=project.sample_rate, channels=project.channels)

        self.setWindowTitle(f"StateVO — {project.name}")
        self.resize(1200, 700)

        self._active_take: Take | None = None
        self._is_playing = False
        self._punch_enabled = False
        self._playback_started_at_sec = 0.0
        self._playback_duration = 0.0
        self._playback_tick_started: float | None = None

        self._playback_timer = QTimer(self)
        self._playback_timer.timeout.connect(self._tick_playback)

        self._build_ui()
        self._load_existing_takes_into_view()
        self._wire_shortcuts()

    # -- UI construction --------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        central_layout = QVBoxLayout(central)
        central_layout.setContentsMargins(0, 0, 0, 0)

        self.timeline_view = TimelineView()
        self.timeline_view.set_project(self.project)
        self.timeline_view.playhead_moved.connect(self._on_playhead_moved)
        self.timeline_view.split_requested.connect(self._on_split_requested)
        self.timeline_view.files_dropped.connect(self._on_files_dropped)
        central_layout.addWidget(self.timeline_view, 1)

        self.voice_chain_strip = VoiceChainStrip(self.project.voice_chain)
        self.voice_chain_strip.settings_changed.connect(self._on_voice_chain_changed)
        central_layout.addWidget(self.voice_chain_strip)

        self.transport_bar = TransportBar()
        self.transport_bar.record_toggled.connect(self._on_record_toggled)
        self.transport_bar.play_clicked.connect(self._on_play_clicked)
        self.transport_bar.stop_clicked.connect(self._on_stop_clicked)
        self.transport_bar.prev_take.connect(self._on_prev_take)
        self.transport_bar.next_take.connect(self._on_next_take)
        self.transport_bar.punch_toggled.connect(lambda on: setattr(self, "_punch_enabled", on))
        self.transport_bar.input_gain_changed.connect(self._on_input_gain_changed)
        central_layout.addWidget(self.transport_bar)

        self.setCentralWidget(central)

        self.script_panel = ScriptPanel()
        self.script_panel.script_imported.connect(self._on_script_imported)
        self.script_panel.autoplace_markers_requested.connect(self._on_autoplace_markers)
        self.script_panel.marker_jump_requested.connect(self._on_playhead_moved)
        dock = QDockWidget("Script", self)
        dock.setWidget(self.script_panel)
        dock.setFeatures(QDockWidget.DockWidgetMovable | QDockWidget.DockWidgetClosable)
        self.addDockWidget(Qt.RightDockWidgetArea, dock)

        self._build_menu()

    def _build_menu(self) -> None:
        # Deliberately flat — three top-level menus, no nested submenus.
        menu_bar = self.menuBar()

        file_menu = menu_bar.addMenu("&File")

        save_action = QAction("Save Project", self)
        save_action.setShortcut(QKeySequence.Save)
        save_action.triggered.connect(self._save_project)
        file_menu.addAction(save_action)

        save_as_action = QAction("Save Project As…", self)
        save_as_action.triggered.connect(self._save_project_as)
        file_menu.addAction(save_as_action)

        export_action = QAction("Export…", self)
        export_action.setShortcut("Ctrl+E")
        export_action.triggered.connect(self._open_export_dialog)
        file_menu.addAction(export_action)

        file_menu.addSeparator()
        quit_action = QAction("Quit", self)
        quit_action.setShortcut(QKeySequence.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        edit_menu = menu_bar.addMenu("&Edit")

        marker_action = QAction("Add Marker at Playhead", self)
        marker_action.setShortcut("M")
        marker_action.triggered.connect(self._add_marker_at_playhead)
        edit_menu.addAction(marker_action)

        split_action = QAction("Split at Playhead", self)
        split_action.setShortcut("S")
        split_action.triggered.connect(self._split_at_playhead)
        edit_menu.addAction(split_action)

        ripple_action = QAction("Ripple Delete Selection", self)
        ripple_action.setShortcut("Backspace")
        ripple_action.triggered.connect(self._ripple_delete_selection)
        edit_menu.addAction(ripple_action)

        help_menu = menu_bar.addMenu("&Help")
        about_action = QAction("About StateVO", self)
        about_action.triggered.connect(self._show_about)
        help_menu.addAction(about_action)

    def _wire_shortcuts(self) -> None:
        QShortcut(QKeySequence(Qt.Key_Space), self, activated=self._toggle_play)
        QShortcut(QKeySequence("R"), self, activated=self.transport_bar.record_button.click)

    # -- recording -------------------------------------------------------------

    def _on_record_toggled(self, recording: bool) -> None:
        if recording:
            if self._is_playing:
                self._on_stop_clicked()
            self._start_recording()
        else:
            self._finish_recording()

    def _start_recording(self) -> None:
        take_index = len(self.project.takes) + 1
        take_id = f"take_{take_index:03d}"
        file_name = f"{take_id}.wav"
        path = self.project.root_dir / TAKES_DIRNAME / file_name

        # Metering is polled from the timer below (main thread), not from
        # the engine's background callback — see audio_engine's threading note.
        self.engine.start_recording(path)
        self._playback_timer.start(40)

    def _finish_recording(self) -> None:
        path, duration = self.engine.stop_recording()
        self._playback_timer.stop()

        take = Take(
            file_name=path.name, duration_sec=duration,
            sample_rate=self.project.sample_rate, channels=self.project.channels,
            label=f"Take {len(self.project.takes) + 1}",
        )
        self.project.takes[take.id] = take

        # New recordings land on the primary voice track, appended after
        # whatever's already there — the simplest possible default.
        track = self.project.primary_voice_track
        clip = Clip(
            take_id=take.id,
            start_sec=track.clips[-1].end_sec if track.clips else 0.0,
            source_in_sec=0.0, source_out_sec=duration,
        )
        track.clips.append(clip)

        peaks = generate_peaks(str(path))
        self.timeline_view.set_peaks(take.id, peaks)
        self.timeline_view.update()

        self._active_take = take
        self.transport_bar.set_take_label(take.label)
        self._save_project()  # autosave after every take — never lose a recording.

    def _on_input_gain_changed(self, db: float) -> None:
        self.engine.input_gain_db = db

    # -- drag-and-dropped SFX / ambience -------------------------------------------

    def _on_files_dropped(self, paths: list[str], target_track: Track | None, at_sec: float) -> None:
        if self.project.root_dir is None:
            QMessageBox.warning(
                self, "Save First",
                "Save the project before dropping in audio — StateVO needs a "
                "project folder to copy files into.",
            )
            return

        for i, path_str in enumerate(paths):
            # Only the first file honors a hit on an existing clip; any
            # additional files dropped in the same gesture each get their
            # own new track rather than piling onto one spot.
            track = target_track if (i == 0 and target_track is not None) else None
            if track is None:
                track = self._new_sfx_track()
                self.project.tracks.append(track)

            try:
                take = media_import.import_external_audio(self.project, Path(path_str))
            except media_import.MediaImportError as e:
                QMessageBox.warning(self, "Import Failed", str(e))
                continue

            self.project.takes[take.id] = take
            edit_ops.add_clip(track, take, start_sec=at_sec)

            take_path = self.project.root_dir / TAKES_DIRNAME / take.file_name
            self.timeline_view.set_peaks(take.id, generate_peaks(str(take_path)))

        self.timeline_view.refresh_layout()
        self.timeline_view.update()
        self._save_project()

    def _new_sfx_track(self) -> Track:
        existing = sum(1 for t in self.project.tracks if t.kind == TrackKind.BED_SFX)
        name = "Beds / SFX" if existing == 0 else f"Beds / SFX {existing + 1}"
        return Track(name=name, kind=TrackKind.BED_SFX)

    # -- playback -----------------------------------------------------------------

    def _toggle_play(self) -> None:
        self._on_stop_clicked() if self._is_playing else self._on_play_clicked()

    def _on_play_clicked(self) -> None:
        mix, sr = render_master(self.project)
        if mix.size == 0:
            return
        start_sample = int(self.timeline_view.playhead_sec * sr)
        segment = mix[start_sample:]
        if segment.size == 0:
            return
        self.engine.play_buffer(segment, sr)
        self._playback_duration = len(segment) / sr
        self._playback_started_at_sec = self.timeline_view.playhead_sec
        self._playback_tick_started = None
        self._is_playing = True
        self._playback_timer.start(40)

    def _on_stop_clicked(self) -> None:
        self.engine.stop_playback()
        self._is_playing = False
        self._playback_timer.stop()
        self._playback_tick_started = None

    def _tick_playback(self) -> None:
        if self.engine.is_recording:
            self.transport_bar.set_time(self.engine.elapsed_recording_sec)
            self.transport_bar.peak_meter.set_level_linear(self.engine.last_peak_level)
            return
        if not self._is_playing:
            return

        # MVP playback timing is wall-clock based (see AudioEngine docstring
        # on the playback upgrade path) rather than sample-accurate.
        if self._playback_tick_started is None:
            self._playback_tick_started = _time.monotonic()
        elapsed = _time.monotonic() - self._playback_tick_started

        position = self._playback_started_at_sec + elapsed
        if position >= self._playback_started_at_sec + self._playback_duration:
            self._on_stop_clicked()
            return

        self.timeline_view.set_playhead(position)
        self.transport_bar.set_time(position)
        self.script_panel.highlight_section_for_time(position, self.project.markers)

    # -- editing --------------------------------------------------------------------

    def _on_playhead_moved(self, seconds: float) -> None:
        self.timeline_view.set_playhead(seconds)
        self.transport_bar.set_time(seconds)

    def _on_split_requested(self, at_sec: float) -> None:
        track = self.timeline_view.active_track or self.project.primary_voice_track
        for clip in list(track.clips):
            if edit_ops.split_clip(track, clip, at_sec):
                self.timeline_view.update()
                return

    def _split_at_playhead(self) -> None:
        self._on_split_requested(self.timeline_view.playhead_sec)

    def _ripple_delete_selection(self) -> None:
        sel = self.timeline_view.selection
        if sel is None:
            return
        track = self.timeline_view.active_track or self.project.primary_voice_track
        for clip in list(track.clips):
            if clip.start_sec >= sel.start_sec and clip.end_sec <= sel.end_sec:
                edit_ops.ripple_delete(track, clip)
        self.timeline_view.selection = None
        self.timeline_view.update()

    def _add_marker_at_playhead(self) -> None:
        marker = Marker(name=f"Marker {len(self.project.markers) + 1}",
                         position_sec=self.timeline_view.playhead_sec)
        self.project.markers.append(marker)
        self.timeline_view.update()
        self.script_panel.refresh_markers(self.project.markers)

    def _on_prev_take(self) -> None:
        self._cycle_take(-1)

    def _on_next_take(self) -> None:
        self._cycle_take(1)

    def _cycle_take(self, direction: int) -> None:
        takes = list(self.project.takes.values())
        if not takes:
            return
        idx = takes.index(self._active_take) if self._active_take in takes else 0
        idx = (idx + direction) % len(takes)
        self._active_take = takes[idx]
        self.transport_bar.set_take_label(self._active_take.label)

    # -- voice chain / script ------------------------------------------------------

    def _on_voice_chain_changed(self, settings) -> None:
        self.project.voice_chain = settings
        # Cheap live-ish feedback: measure LUFS of the current mix with the
        # chain applied. Fine at MVP recording lengths; would want
        # debouncing/threading for very long projects.
        try:
            mix, sr = render_master(self.project)
            if mix.size:
                from statevo.core.voice_chain import VoiceChain
                processed = VoiceChain(settings).process(mix, sr)
                lufs = measure_integrated_lufs(processed, sr)
                self.voice_chain_strip.lufs_readout.set_lufs(lufs, self.project.loudness_target_lufs)
        except Exception:
            pass  # never let a metering hiccup interrupt editing

    def _on_script_imported(self, text: str, sections: list) -> None:
        self.project.script_text = text
        self.project.script_sections = sections

    def _on_autoplace_markers(self, sections: list) -> None:
        """Evenly spread markers across the current recorded duration — a
        sensible starting layout the user nudges into place, in keeping
        with the "opinionated defaults" philosophy."""
        duration = self.project.duration_sec
        if not sections or duration <= 0:
            return
        self.project.markers = [
            Marker(name=s.heading, position_sec=(duration * i / len(sections)))
            for i, s in enumerate(sections)
        ]
        self.timeline_view.update()
        self.script_panel.refresh_markers(self.project.markers)

    # -- project I/O ------------------------------------------------------------------

    def _save_project(self) -> None:
        project_io.save_project(self.project, self.project.root_dir)

    def _save_project_as(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Save Project As", str(default_projects_dir()))
        if not folder:
            return
        new_dir = project_io.create_project_dir(Path(folder), self.project.name)
        project_io.save_project(self.project, new_dir)
        QMessageBox.information(self, "Saved", f"Project saved to {new_dir}")

    def _open_export_dialog(self) -> None:
        self._save_project()
        dialog = ExportDialog(self.project, self)
        dialog.exec()

    def _load_existing_takes_into_view(self) -> None:
        for take in self.project.takes.values():
            path = self.project.root_dir / TAKES_DIRNAME / take.file_name
            if path.exists():
                self.timeline_view.set_peaks(take.id, generate_peaks(str(path)))
        self.script_panel.refresh_markers(self.project.markers)
        if self.project.script_text:
            self.script_panel.script_view.setPlainText(self.project.script_text)

    def _show_about(self) -> None:
        QMessageBox.information(
            self, "About StateVO",
            "StateVO — a voice-first DAW for spoken-word content.\nMVP build.",
        )

    def closeEvent(self, event) -> None:
        if self.engine.is_recording:
            self.engine.stop_recording()
        self._save_project()
        super().closeEvent(event)
