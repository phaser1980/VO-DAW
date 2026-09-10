"""The big, obvious Record button — always visible, per spec."""
from __future__ import annotations

from PySide6.QtCore import QTimer, Signal
from PySide6.QtWidgets import QPushButton

from statevo.ui.theme import ACCENT_RECORD, BG_RAISED


class RecordButton(QPushButton):
    toggled_recording = Signal(bool)

    def __init__(self, parent=None):
        super().__init__("● REC", parent)
        self.setCheckable(True)
        self.setMinimumSize(96, 48)
        self._blink_timer = QTimer(self)
        self._blink_timer.timeout.connect(self._blink)
        self._blink_on = True
        self.clicked.connect(self._on_clicked)
        self._apply_style(recording=False)

    def _on_clicked(self) -> None:
        recording = self.isChecked()
        self._apply_style(recording)
        if recording:
            self._blink_timer.start(500)
        else:
            self._blink_timer.stop()
            self._apply_style(False)
        self.toggled_recording.emit(recording)

    def _blink(self) -> None:
        self._blink_on = not self._blink_on
        color = ACCENT_RECORD if self._blink_on else BG_RAISED
        self.setStyleSheet(self._style_for(color))

    def _apply_style(self, recording: bool) -> None:
        color = ACCENT_RECORD if recording else BG_RAISED
        self.setStyleSheet(self._style_for(color))
        self.setText("● STOP" if recording else "● REC")

    @staticmethod
    def _style_for(color: str) -> str:
        return f"""
            QPushButton {{
                background-color: {color};
                border: 2px solid {ACCENT_RECORD};
                border-radius: 24px;
                font-weight: 700;
                font-size: 15px;
                color: white;
            }}
        """

    def force_state(self, recording: bool) -> None:
        """Let external logic (e.g. hitting a max duration) sync the
        button's visual state without re-emitting the signal."""
        self.blockSignals(True)
        self.setChecked(recording)
        self.blockSignals(False)
        self._apply_style(recording)
        if recording:
            self._blink_timer.start(500)
        else:
            self._blink_timer.stop()
