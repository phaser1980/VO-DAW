"""Horizontal voice-chain strip: five toggles + preset dropdown + LUFS
readout. This is the entire "Voice Processing" surface — no nested
dialogs, no per-stage editors."""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QPushButton, QWidget

from statevo.core.presets import VOICE_CHAIN_PRESETS
from statevo.core.project import VoiceChainSettings
from statevo.ui.meters import LufsReadout


class VoiceChainStrip(QWidget):
    settings_changed = Signal(object)  # emits VoiceChainSettings

    STAGES = [
        ("noise_reduction_enabled", "Noise Cleanup"),
        ("deesser_enabled", "De-esser"),
        ("compressor_enabled", "Compressor"),
        ("eq_enabled", "EQ"),
        ("limiter_enabled", "Limiter"),
    ]

    def __init__(self, settings: VoiceChainSettings, parent=None):
        super().__init__(parent)
        self.settings = settings

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 4, 12, 4)
        layout.addWidget(QLabel("Voice Chain:"))

        self._chip_buttons: dict[str, QPushButton] = {}
        for attr, label in self.STAGES:
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setChecked(getattr(settings, attr))
            btn.toggled.connect(lambda checked, a=attr: self._on_stage_toggled(a, checked))
            self._chip_buttons[attr] = btn
            layout.addWidget(btn)

        layout.addSpacing(16)
        layout.addWidget(QLabel("Preset:"))
        self.preset_combo = QComboBox()
        self.preset_combo.addItems(list(VOICE_CHAIN_PRESETS.keys()) + ["custom"])
        self.preset_combo.setCurrentText(settings.preset)
        self.preset_combo.currentTextChanged.connect(self._on_preset_selected)
        layout.addWidget(self.preset_combo)

        layout.addStretch(1)
        self.lufs_readout = LufsReadout()
        layout.addWidget(self.lufs_readout)

    def _on_stage_toggled(self, attr: str, checked: bool) -> None:
        setattr(self.settings, attr, checked)
        self.settings.preset = "custom"
        self.preset_combo.blockSignals(True)
        self.preset_combo.setCurrentText("custom")
        self.preset_combo.blockSignals(False)
        self.settings_changed.emit(self.settings)

    def _on_preset_selected(self, name: str) -> None:
        if name == "custom" or name not in VOICE_CHAIN_PRESETS:
            return
        preset = VOICE_CHAIN_PRESETS[name]
        # Swap in the preset wholesale, then resync the toggle chips to match.
        self.settings.__dict__.update(preset.to_dict())
        for attr, btn in self._chip_buttons.items():
            btn.blockSignals(True)
            btn.setChecked(getattr(self.settings, attr))
            btn.blockSignals(False)
        self.settings_changed.emit(self.settings)
