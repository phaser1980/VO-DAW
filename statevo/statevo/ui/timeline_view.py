"""
The timeline view — multi-track successor to the old single-track
WaveformView. Renders every track as a stacked horizontal lane with a
header (name, mute, solo, collapse), plus the shared ruler/playhead/
selection that span all lanes.

Drag-and-drop rule (per spec): dropping a file onto an existing clip's
waveform lands it on that same track; dropping into empty space (a gap
within a lane, or below the last track entirely) creates a brand new
track for it. Actually importing the file (ffmpeg transcode, Take
creation, peak generation) is deliberately NOT done here — this widget
only extracts the dropped paths + target track + drop time and emits
`files_dropped`, mirroring how MainWindow (not WaveformView) has always
owned take-creation for recordings. Keeps this file Qt-glue only.

MVP note: like the old WaveformView, fade-handle/clip-edge dragging
isn't wired yet. Also no QScrollArea — with more tracks than fit
vertically this will just get cramped; wrapping it in a scroll area is
a clean follow-up, not done here to keep this increment focused.
"""
from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen
from PySide6.QtWidgets import QWidget

from statevo.config import TrackKind
from statevo.core.project import Project, Track
from statevo.core.waveform import PeakData
from statevo.ui.theme import (
    ACCENT_INFO, ACCENT_OK, ACCENT_RECORD, BG, BG_PANEL, BG_RAISED, BORDER, TEXT, TEXT_DIM,
)


@dataclass
class Selection:
    start_sec: float
    end_sec: float

    @property
    def is_empty(self) -> bool:
        return abs(self.end_sec - self.start_sec) < 1e-3


class TimelineView(QWidget):
    playhead_moved = Signal(float)
    selection_changed = Signal(object)          # Selection | None
    split_requested = Signal(float)              # absolute timeline seconds, targets active_track
    files_dropped = Signal(list, object, float)  # list[str] local paths, Track|None target, at_sec

    MIN_PPS, MAX_PPS = 10.0, 800.0
    HEADER_WIDTH = 160
    RULER_H = 22
    EXPANDED_LANE_H = 110
    COLLAPSED_LANE_H = 32
    ADD_TRACK_ROW_H = 28

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setMinimumHeight(220)
        self.setAcceptDrops(True)

        self.project: Project | None = None
        self.active_track: Track | None = None
        self.peak_cache: dict[str, PeakData] = {}

        self.pixels_per_second = 80.0
        self.scroll_start_sec = 0.0
        self.playhead_sec = 0.0
        self.selection: Selection | None = None

        self._drag_start_x: float | None = None

    # -- data binding -----------------------------------------------------

    def set_project(self, project: Project) -> None:
        self.project = project
        self.active_track = project.primary_voice_track
        self.refresh_layout()
        self.update()

    def set_peaks(self, take_id: str, peaks: PeakData) -> None:
        self.peak_cache[take_id] = peaks
        self.update()

    def set_playhead(self, seconds: float) -> None:
        self.playhead_sec = max(0.0, seconds)
        self._ensure_playhead_visible()
        self.update()

    def zoom(self, factor: float) -> None:
        self.pixels_per_second = max(self.MIN_PPS, min(self.MAX_PPS, self.pixels_per_second * factor))
        self.update()

    def refresh_layout(self) -> None:
        """Recompute the widget's minimum height for the current track
        count/collapsed states. Call after adding tracks or toggling a
        collapse from outside this widget (e.g. after a drop import)."""
        self.setMinimumHeight(self._content_height())

    # -- layout helpers -----------------------------------------------------

    def _lane_height(self, track: Track) -> int:
        return self.COLLAPSED_LANE_H if track.collapsed else self.EXPANDED_LANE_H

    def _content_height(self) -> int:
        if not self.project:
            return 220
        lanes = sum(self._lane_height(t) for t in self.project.tracks)
        return self.RULER_H + lanes + self.ADD_TRACK_ROW_H

    def _track_rows(self):
        """Yields (track, lane_top_y, lane_height) for every track, top to bottom."""
        y = self.RULER_H
        for track in self.project.tracks:
            h = self._lane_height(track)
            yield track, y, h
            y += h

    def _add_track_row_top(self) -> int:
        return self.RULER_H + sum(self._lane_height(t) for t in self.project.tracks)

    # -- coordinate helpers (time <-> x, offset by the header column) -------

    def time_to_x(self, seconds: float) -> int:
        return int(self.HEADER_WIDTH + (seconds - self.scroll_start_sec) * self.pixels_per_second)

    def x_to_time(self, x: int) -> float:
        return max(0.0, self.scroll_start_sec + (x - self.HEADER_WIDTH) / self.pixels_per_second)

    def _ensure_playhead_visible(self) -> None:
        x = self.time_to_x(self.playhead_sec)
        if x < self.HEADER_WIDTH:
            self.scroll_start_sec = max(0.0, self.playhead_sec - 1.0)
        elif x > self.width():
            usable_px = max(1, self.width() - self.HEADER_WIDTH)
            self.scroll_start_sec = self.playhead_sec - (usable_px / self.pixels_per_second) * 0.8

    # -- painting -------------------------------------------------------------

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(BG))
        if self.project is None:
            return

        self._draw_ruler(painter)
        for track, top, height in self._track_rows():
            self._draw_lane(painter, track, top, height)
        self._draw_add_track_row(painter)
        self._draw_selection(painter)
        self._draw_playhead(painter)

    def _draw_ruler(self, painter: QPainter) -> None:
        painter.fillRect(QRectF(self.HEADER_WIDTH, 0, self.width() - self.HEADER_WIDTH, self.RULER_H), QColor(BG_PANEL))
        painter.setPen(QPen(QColor(TEXT_DIM)))
        step = self._nice_time_step()
        first_tick = int(self.scroll_start_sec / step) * step
        t = first_tick
        while self.time_to_x(t) < self.width():
            x = self.time_to_x(t)
            if x >= self.HEADER_WIDTH:
                painter.drawLine(x, self.RULER_H - 6, x, self.RULER_H)
                painter.drawText(x + 2, self.RULER_H - 8, f"{t:.0f}s")
            t += step

    def _nice_time_step(self) -> float:
        target_px = 80
        raw = target_px / self.pixels_per_second
        for step in (0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60):
            if raw <= step:
                return step
        return 120.0

    def _draw_lane(self, painter: QPainter, track: Track, top: int, height: int) -> None:
        self._draw_header(painter, track, top, height)

        lane_rect = QRectF(self.HEADER_WIDTH, top, self.width() - self.HEADER_WIDTH, height)
        painter.fillRect(lane_rect, QColor(BG_PANEL if track is self.active_track else BG))
        painter.setPen(QPen(QColor(BORDER)))
        painter.drawLine(self.HEADER_WIDTH, top + height, self.width(), top + height)

        if track.collapsed:
            self._draw_collapsed_clips(painter, track, top, height)
        else:
            self._draw_clips(painter, track, top, height)

    def _draw_header(self, painter: QPainter, track: Track, top: int, height: int) -> None:
        header_rect = QRectF(0, top, self.HEADER_WIDTH, height)
        painter.fillRect(header_rect, QColor(BG_RAISED if track is self.active_track else BG_PANEL))
        painter.setPen(QPen(QColor(BORDER)))
        painter.drawRect(header_rect)

        painter.setPen(QPen(QColor(TEXT)))
        name_max_w = self.HEADER_WIDTH - 94
        elided = painter.fontMetrics().elidedText(track.name, Qt.ElideRight, name_max_w)
        painter.drawText(10, top + 20, elided)

        mute_r, solo_r, collapse_r = self._header_control_rects(top)
        self._draw_toggle(painter, mute_r, "M", track.muted, ACCENT_RECORD)
        self._draw_toggle(painter, solo_r, "S", track.solo, ACCENT_OK)
        self._draw_toggle(painter, collapse_r, "▾" if not track.collapsed else "▸", False, ACCENT_INFO)

    def _header_control_rects(self, top: int):
        y = top + 6
        mute_r = QRectF(self.HEADER_WIDTH - 78, y, 20, 20)
        solo_r = QRectF(self.HEADER_WIDTH - 52, y, 20, 20)
        collapse_r = QRectF(self.HEADER_WIDTH - 24, y, 18, 20)
        return mute_r, solo_r, collapse_r

    def _draw_toggle(self, painter: QPainter, rect: QRectF, label: str, active: bool, active_color: str) -> None:
        painter.fillRect(rect, QColor(active_color if active else BG_RAISED))
        painter.setPen(QPen(QColor("#0A0A0C" if active else TEXT_DIM)))
        painter.drawRect(rect)
        painter.drawText(rect, Qt.AlignCenter, label)

    def _draw_clips(self, painter: QPainter, track: Track, top: int, height: int) -> None:
        mid_y = top + height // 2
        amp_px = (height - 30) / 2

        for clip in track.clips:
            x_start = self.time_to_x(clip.start_sec)
            x_end = self.time_to_x(clip.end_sec)
            if x_end < self.HEADER_WIDTH or x_start > self.width():
                continue
            x_start = max(x_start, self.HEADER_WIDTH)
            width_px = max(1, x_end - x_start)

            painter.fillRect(QRectF(x_start, top + 15, width_px, height - 25), QColor(BG_RAISED))

            peaks = self.peak_cache.get(clip.take_id)
            if peaks is not None:
                mins, maxs = peaks.slice_for_view(clip.source_in_sec, clip.source_out_sec, width_px)
                painter.setPen(QPen(QColor(ACCENT_INFO)))
                for i in range(len(mins)):
                    x = x_start + i
                    y1 = mid_y - maxs[i] * amp_px
                    y2 = mid_y - mins[i] * amp_px
                    painter.drawLine(int(x), int(y1), int(x), int(y2))

            painter.setPen(QPen(QColor(TEXT_DIM)))
            painter.drawRect(x_start, top + 15, width_px, height - 25)

    def _draw_collapsed_clips(self, painter: QPainter, track: Track, top: int, height: int) -> None:
        for clip in track.clips:
            x_start = self.time_to_x(clip.start_sec)
            x_end = self.time_to_x(clip.end_sec)
            if x_end < self.HEADER_WIDTH or x_start > self.width():
                continue
            x_start = max(x_start, self.HEADER_WIDTH)
            width_px = max(1, x_end - x_start)
            painter.fillRect(QRectF(x_start, top + 6, width_px, height - 12), QColor(ACCENT_INFO).darker(160))
            painter.setPen(QPen(QColor(TEXT_DIM)))
            painter.drawRect(x_start, top + 6, width_px, height - 12)

    def _draw_add_track_row(self, painter: QPainter) -> None:
        top = self._add_track_row_top()
        rect = QRectF(0, top, self.width(), self.ADD_TRACK_ROW_H)
        painter.fillRect(rect, QColor(BG))
        pen = QPen(QColor(BORDER))
        pen.setStyle(Qt.DashLine)
        painter.setPen(pen)
        painter.drawRect(QRectF(4, top + 3, self.width() - 8, self.ADD_TRACK_ROW_H - 6))
        painter.setPen(QPen(QColor(TEXT_DIM)))
        painter.drawText(rect, Qt.AlignCenter, "+ New Track")

    def _draw_selection(self, painter: QPainter) -> None:
        if self.selection is None or self.selection.is_empty:
            return
        x1 = self.time_to_x(self.selection.start_sec)
        x2 = self.time_to_x(self.selection.end_sec)
        color = QColor(ACCENT_INFO)
        color.setAlpha(50)
        painter.fillRect(QRectF(min(x1, x2), self.RULER_H, abs(x2 - x1), self._add_track_row_top() - self.RULER_H), color)

    def _draw_playhead(self, painter: QPainter) -> None:
        x = self.time_to_x(self.playhead_sec)
        if self.HEADER_WIDTH <= x <= self.width():
            painter.setPen(QPen(QColor(ACCENT_RECORD), 2))
            painter.drawLine(x, 0, x, self._add_track_row_top())

    # -- hit testing ------------------------------------------------------------

    def _track_at_y(self, y: float) -> Track | None:
        for track, top, height in self._track_rows():
            if top <= y < top + height:
                return track
        return None

    def _clip_hit_at(self, x: float, y: float) -> Track | None:
        """Returns the track to drop onto if (x, y) lands on an existing
        clip's rendered waveform (or anywhere in a collapsed lane's body),
        else None — meaning "empty space, make a new track"."""
        if x < self.HEADER_WIDTH:
            return None
        t_sec = self.x_to_time(int(x))
        for track, top, height in self._track_rows():
            if not (top <= y < top + height):
                continue
            if track.collapsed:
                return track  # collapsed lanes have no per-clip hit area — whole strip counts
            for clip in track.clips:
                if clip.start_sec <= t_sec <= clip.end_sec:
                    return track
            return None  # inside this lane, but on empty timeline space
        return None  # below the last lane / on the add-track row

    # -- mouse interaction ------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if self.project is None:
            return
        x, y = event.position().x(), event.position().y()

        if x < self.HEADER_WIDTH:
            self._handle_header_click(x, y)
            return

        if y >= self._add_track_row_top():
            self._add_empty_track()
            return

        track = self._track_at_y(y)
        if track is not None:
            self.active_track = track

        self._drag_start_x = x
        t = self.x_to_time(int(x))
        self.set_playhead(t)
        self.playhead_moved.emit(t)
        self.selection = None

    def _handle_header_click(self, x: float, y: float) -> None:
        for track, top, height in self._track_rows():
            if not (top <= y < top + height):
                continue
            self.active_track = track
            mute_r, solo_r, collapse_r = self._header_control_rects(top)
            local = (x, y)
            if mute_r.contains(*local):
                track.muted = not track.muted
            elif solo_r.contains(*local):
                track.solo = not track.solo
            elif collapse_r.contains(*local):
                track.collapsed = not track.collapsed
                self.refresh_layout()
            self.update()
            return

        if y >= self._add_track_row_top():
            self._add_empty_track()

    def _add_empty_track(self) -> None:
        existing_sfx = sum(1 for t in self.project.tracks if t.kind == TrackKind.BED_SFX)
        name = "Beds / SFX" if existing_sfx == 0 else f"Beds / SFX {existing_sfx + 1}"
        track = Track(name=name, kind=TrackKind.BED_SFX)
        self.project.tracks.append(track)
        self.active_track = track
        self.refresh_layout()
        self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_start_x is None or not (event.buttons() & Qt.LeftButton):
            return
        start_t = self.x_to_time(int(self._drag_start_x))
        end_t = self.x_to_time(int(event.position().x()))
        self.selection = Selection(start_sec=min(start_t, end_t), end_sec=max(start_t, end_t))
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        self._drag_start_x = None
        if self.selection is not None and not self.selection.is_empty:
            self.selection_changed.emit(self.selection)
        else:
            self.selection = None
            self.selection_changed.emit(None)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:
        if event.position().x() < self.HEADER_WIDTH:
            return
        t = self.x_to_time(int(event.position().x()))
        self.split_requested.emit(t)

    def wheelEvent(self, event) -> None:
        if event.modifiers() & Qt.ControlModifier:
            factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
            self.zoom(factor)
        else:
            self.scroll_start_sec = max(0.0, self.scroll_start_sec - event.angleDelta().y() / 120.0 * 0.5)
            self.update()

    # -- drag & drop from the OS (Explorer, or a browser's drag-out) -------------

    def dragEnterEvent(self, event) -> None:
        if event.mimeData().hasUrls() and any(u.isLocalFile() for u in event.mimeData().urls()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event) -> None:
        if self.project is None:
            event.ignore()
            return
        paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
        if not paths:
            event.ignore()
            return

        pos = event.position()
        x = max(pos.x(), self.HEADER_WIDTH)
        at_sec = self.x_to_time(int(x))
        target_track = self._clip_hit_at(pos.x(), pos.y())

        self.files_dropped.emit(paths, target_track, at_sec)
        event.acceptProposedAction()
