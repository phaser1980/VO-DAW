"""Peak input meter + LUFS readout."""
from __future__ import annotations

import math

from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QHBoxLayout, QLabel, QWidget

from statevo.ui.theme import ACCENT_OK, ACCENT_RECORD, BG_PANEL


class PeakMeter(QWidget):
    """Small horizontal peak bar with a red zone above -3dBFS."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(14)
        self.setMinimumWidth(140)
        self._level_db = -60.0

    def set_level_linear(self, peak: float) -> None:
        db = 20 * math.log10(max(peak, 1e-6))
        # Instant rise, slow fall — standard peak-meter ballistics.
        self._level_db = db if db > self._level_db else self._level_db - 1.2
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(BG_PANEL))
        frac = max(0.0, min(1.0, (self._level_db + 60) / 60.0))
        width = int(self.width() * frac)
        color = QColor(ACCENT_RECORD) if self._level_db > -3 else QColor(ACCENT_OK)
        painter.fillRect(0, 0, width, self.height(), color)


class LufsReadout(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.label = QLabel("LUFS: —")
        self.target_label = QLabel("")
        self.target_label.setStyleSheet("color: #9A9AA2;")
        layout.addWidget(self.label)
        layout.addWidget(self.target_label)

    def set_lufs(self, value: float | None, target: float | None = None) -> None:
        self.label.setText(f"LUFS: {value:.1f}" if value is not None else "LUFS: —")
        self.target_label.setText(f"(target {target:.0f})" if target is not None else "")
