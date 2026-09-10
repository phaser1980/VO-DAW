"""Export dialog — preset picker, output folder, progress, done state.
The entire "Export" surface the spec asks for: three opinionated
presets, auto-naming, optional loudness report. No advanced options."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QThread, Signal
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
)

from statevo.core import exporter as exporter_mod
from statevo.core.presets import EXPORT_PRESETS
from statevo.core.project import Project


class ExportWorker(QThread):
    finished_ok = Signal(dict)
    failed = Signal(str)

    def __init__(self, project: Project, preset_key: str, output_dir: Path, include_report: bool):
        super().__init__()
        self.project = project
        self.preset_key = preset_key
        self.output_dir = output_dir
        self.include_report = include_report

    def run(self) -> None:
        try:
            preset = EXPORT_PRESETS[self.preset_key]
            result = exporter_mod.export(
                self.project, preset, self.output_dir,
                apply_voice_chain=True, write_loudness_report=self.include_report,
            )
            self.finished_ok.emit(result)
        except Exception as e:  # surfaced to the user via the dialog, not a crash
            self.failed.emit(str(e))


class ExportDialog(QDialog):
    def __init__(self, project: Project, parent=None):
        super().__init__(parent)
        self.project = project
        self.setWindowTitle("Export")
        self.setMinimumWidth(440)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Choose an export preset:"))

        self.button_group = QButtonGroup(self)
        for i, (key, preset) in enumerate(EXPORT_PRESETS.items()):
            radio = QRadioButton(preset.label)
            radio.setProperty("preset_key", key)
            if i == 0:
                radio.setChecked(True)
            self.button_group.addButton(radio, i)
            layout.addWidget(radio)

        folder_row = QHBoxLayout()
        self.folder_label = QLabel(str(self._default_output_dir()))
        folder_button = QPushButton("Choose Folder…")
        folder_button.clicked.connect(self._choose_folder)
        folder_row.addWidget(self.folder_label, 1)
        folder_row.addWidget(folder_button)
        layout.addLayout(folder_row)

        self.report_check = QCheckBox("Include loudness report (.json)")
        self.report_check.setChecked(True)
        layout.addWidget(self.report_check)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # indeterminate — export duration varies with take length
        self.progress.hide()
        layout.addWidget(self.progress)

        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

        button_row = QHBoxLayout()
        self.export_button = QPushButton("Export")
        self.export_button.clicked.connect(self._start_export)
        cancel_button = QPushButton("Close")
        cancel_button.clicked.connect(self.reject)
        button_row.addStretch(1)
        button_row.addWidget(cancel_button)
        button_row.addWidget(self.export_button)
        layout.addLayout(button_row)

        self._worker: ExportWorker | None = None

    def _default_output_dir(self) -> Path:
        assert self.project.root_dir is not None
        return self.project.root_dir / "exports"

    def _choose_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Export Folder", self.folder_label.text())
        if folder:
            self.folder_label.setText(folder)

    def _start_export(self) -> None:
        checked = self.button_group.checkedButton()
        if checked is None:
            return
        preset_key = checked.property("preset_key")
        self.export_button.setEnabled(False)
        self.progress.show()
        self.status_label.setText("Rendering, processing, and encoding…")

        self._worker = ExportWorker(
            self.project, preset_key, Path(self.folder_label.text()), self.report_check.isChecked()
        )
        self._worker.finished_ok.connect(self._on_finished)
        self._worker.failed.connect(self._on_failed)
        self._worker.start()

    def _on_finished(self, result: dict) -> None:
        self.progress.hide()
        self.export_button.setEnabled(True)
        report = result.get("loudness_report")
        summary = f"Exported: {Path(result['path']).name}"
        if report:
            summary += f"\nIntegrated loudness: {report['integrated_lufs']} LUFS"
        self.status_label.setText(summary)
        QMessageBox.information(self, "Export complete", summary)

    def _on_failed(self, message: str) -> None:
        self.progress.hide()
        self.export_button.setEnabled(True)
        self.status_label.setText("Export failed.")
        QMessageBox.critical(self, "Export failed", message)
