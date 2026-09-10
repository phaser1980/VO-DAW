"""
The waveform view — the dominant element of the main window per spec.

Renders the active track's clips as filled min/max waveforms, plus the
playhead, markers, and the current time selection. Click to move the
playhead, drag to select a range, double-click a clip to split it,
scroll to pan, Ctrl+scroll to zoom.

MVP note: fade-handle and clip-edge *dragging* are drawn but not yet
wired to mouse interaction — trims/fades currently go through
edit_ops-backed menu actions. Wiring the drag handles is a good next
increment; the hit-testing scaffolding (time_to_x / x_to_time) is
already here to build on.
"""
from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen
from PySide6.QtWidgets import QWidget

from statevo.core.project import Project, Track
from statevo.core.waveform import PeakData
from statevo.ui.theme import ACCENT_INFO, ACCENT_RECORD, BG, BG_PANEL, TEXT_DIM


@dataclass
class Selection:
    start_sec: float
    end_sec: float

    @property
    def is_empty(self) -> bool:
        return abs(self.end_sec - self.start_sec) < 1e-3


class WaveformView(QWidget):
    playhead_moved = Signal(float)
    selection_changed = Signal(object)   # Selection | None
    split_requested = Signal(float)      # absolute timeline seconds

    MIN_PPS, MAX_PPS = 10.0, 800.0

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMouseTracking(True)
        self.setMinimumHeight(220)

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

    # -- coordinate helpers -------------------------------------------------

    def time_to_x(self, seconds: float) -> int:
        return int((seconds - self.scroll_start_sec) * self.pixels_per_second)

    def x_to_time(self, x: int) -> float:
        return max(0.0, self.scroll_start_sec + x / self.pixels_per_second)

    def _ensure_playhead_visible(self) -> None:
        x = self.time_to_x(self.playhead_sec)
        if x < 0:
            self.scroll_start_sec = max(0.0, self.playhead_sec - 1.0)
        elif x > self.width():
            self.scroll_start_sec = self.playhead_sec - (self.width() / self.pixels_per_second) * 0.8

    # -- painting -------------------------------------------------------------

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(BG))
        self._draw_ruler(painter)
        if self.active_track is not None and self.project is not None:
            self._draw_clips(painter)
            self._draw_markers(painter)
        self._draw_selection(painter)
        self._draw_playhead(painter)

    def _draw_ruler(self, painter: QPainter) -> None:
        painter.setPen(QPen(QColor(TEXT_DIM)))
        step = self._nice_time_step()
        first_tick = int(self.scroll_start_sec / step) * step
        t = first_tick
        while self.time_to_x(t) < self.width():
            x = self.time_to_x(t)
            if x >= 0:
                painter.drawLine(x, 0, x, 8)
                painter.drawText(x + 2, 20, f"{t:.0f}s")
            t += step

    def _nice_time_step(self) -> float:
        target_px = 80
        raw = target_px / self.pixels_per_second
        for step in (0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60):
            if raw <= step:
                return step
        return 120.0

    def _draw_clips(self, painter: QPainter) -> None:
        mid_y = self.height() // 2
        amp_px = (self.height() - 40) / 2

        for clip in self.active_track.clips:
            x_start = self.time_to_x(clip.start_sec)
            x_end = self.time_to_x(clip.end_sec)
            if x_end < 0 or x_start > self.width():
                continue
            width_px = max(1, x_end - x_start)

            painter.fillRect(QRectF(x_start, 30, width_px, self.height() - 40), QColor(BG_PANEL))

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
            painter.drawRect(x_start, 30, width_px, self.height() - 40)

    def _draw_markers(self, painter: QPainter) -> None:
        for m in self.project.markers:
            x = self.time_to_x(m.position_sec)
            if 0 <= x <= self.width():
                painter.setPen(QPen(QColor(m.color), 2))
                painter.drawLine(x, 0, x, self.height())
                painter.drawText(x + 3, self.height() - 4, m.name)

    def _draw_selection(self, painter: QPainter) -> None:
        if self.selection is None or self.selection.is_empty:
            return
        x1 = self.time_to_x(self.selection.start_sec)
        x2 = self.time_to_x(self.selection.end_sec)
        color = QColor(ACCENT_INFO)
        color.setAlpha(60)
        painter.fillRect(QRectF(min(x1, x2), 0, abs(x2 - x1), self.height()), color)

    def _draw_playhead(self, painter: QPainter) -> None:
        x = self.time_to_x(self.playhead_sec)
        if 0 <= x <= self.width():
            painter.setPen(QPen(QColor(ACCENT_RECORD), 2))
            painter.drawLine(x, 0, x, self.height())

    # -- interaction ------------------------------------------------------------

    def mousePressEvent(self, event: QMouseEvent) -> None:
        self._drag_start_x = event.position().x()
        t = self.x_to_time(int(self._drag_start_x))
        self.set_playhead(t)
        self.playhead_moved.emit(t)
        self.selection = None

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
        t = self.x_to_time(int(event.position().x()))
        self.split_requested.emit(t)

    def wheelEvent(self, event) -> None:
        # Ctrl+scroll to zoom, plain scroll to pan — standard DAW convention.
        if event.modifiers() & Qt.ControlModifier:
            factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
            self.zoom(factor)
        else:
            self.scroll_start_sec = max(0.0, self.scroll_start_sec - event.angleDelta().y() / 120.0 * 0.5)
            self.update()
