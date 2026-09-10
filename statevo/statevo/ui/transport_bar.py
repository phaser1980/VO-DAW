"""Transport: record, play/stop, take navigation, punch in/out, input
gain, peak meter, and the time display. Everything a beginner needs is
in this one row — no nested menus to find "record"."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QSlider, QWidget

from statevo.ui.meters import PeakMeter
from statevo.ui.widgets.record_button import RecordButton


class TransportBar(QWidget):
    record_toggled = Signal(bool)
    play_clicked = Signal()
    stop_clicked = Signal()
    prev_take = Signal()
    next_take = Signal()
    punch_toggled = Signal(bool)
    input_gain_changed = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)

        self.record_button = RecordButton()
        self.record_button.toggled_recording.connect(self.record_toggled)

        gain_label = QLabel("Gain")
        self.gain_slider = QSlider(Qt.Horizontal)
        self.gain_slider.setRange(-24, 24)
        self.gain_slider.setValue(0)
        self.gain_slider.setFixedWidth(90)
        self.gain_slider.setToolTip("Input gain (dB)")
        self.gain_slider.valueChanged.connect(lambda v: self.input_gain_changed.emit(float(v)))

        self.peak_meter = PeakMeter()

        self.play_button = QPushButton("▶ Play")
        self.play_button.clicked.connect(self.play_clicked)

        self.stop_button = QPushButton("■ Stop")
        self.stop_button.clicked.connect(self.stop_clicked)

        self.punch_button = QPushButton("Punch In/Out")
        self.punch_button.setCheckable(True)
        self.punch_button.toggled.connect(self.punch_toggled)

        self.prev_take_button = QPushButton("◀ Take")
        self.prev_take_button.clicked.connect(self.prev_take)
        self.next_take_button = QPushButton("Take ▶")
        self.next_take_button.clicked.connect(self.next_take)
        self.take_label = QLabel("No takes yet")

        self.time_label = QLabel("00:00.0")
        self.time_label.setStyleSheet("font-size: 18px; font-weight: 600;")

        for w in (self.record_button, gain_label, self.gain_slider, self.peak_meter,
                  self.play_button, self.stop_button, self.punch_button,
                  self.prev_take_button, self.take_label, self.next_take_button):
            layout.addWidget(w)
        layout.addStretch(1)
        layout.addWidget(self.time_label)

    def set_time(self, seconds: float) -> None:
        m, s = divmod(max(0.0, seconds), 60)
        self.time_label.setText(f"{int(m):02d}:{s:04.1f}")

    def set_take_label(self, text: str) -> None:
        self.take_label.setText(text)
