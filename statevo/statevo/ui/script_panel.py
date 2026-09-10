"""Collapsible script / teleprompter panel + markers list. Collapsed by
default in spirit — the user has to ask for it to take up room."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from statevo.core.project import Marker, ScriptSection
from statevo.core.script_import import parse_script


class ScriptPanel(QWidget):
    script_imported = Signal(str, list)          # full_text, list[ScriptSection]
    autoplace_markers_requested = Signal(list)    # list[ScriptSection]
    marker_jump_requested = Signal(float)
    collapsed_changed = Signal(bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._collapsed = False
        self._sections: list[ScriptSection] = []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 8, 8, 8)

        header = QHBoxLayout()
        self.collapse_button = QPushButton("Script & Markers ▾")
        self.collapse_button.clicked.connect(self._toggle_collapsed)
        header.addWidget(self.collapse_button)
        outer.addLayout(header)

        self.body = QWidget()
        body_layout = QVBoxLayout(self.body)
        body_layout.setContentsMargins(0, 0, 0, 0)

        import_row = QHBoxLayout()
        import_button = QPushButton("Import Script (.md / .txt)")
        import_button.clicked.connect(self._import_script)
        import_row.addWidget(import_button)
        self.autoscroll_check = QCheckBox("Auto-scroll")
        self.autoscroll_check.setChecked(True)
        import_row.addWidget(self.autoscroll_check)
        body_layout.addLayout(import_row)

        self.script_view = QTextBrowser()
        self.script_view.setMinimumHeight(200)
        body_layout.addWidget(self.script_view)

        body_layout.addWidget(QLabel("Markers"))
        self.markers_list = QListWidget()
        self.markers_list.itemDoubleClicked.connect(self._on_marker_double_clicked)
        body_layout.addWidget(self.markers_list)

        autoplace_button = QPushButton("Auto-place Markers from Script")
        autoplace_button.clicked.connect(lambda: self.autoplace_markers_requested.emit(self._sections))
        body_layout.addWidget(autoplace_button)

        outer.addWidget(self.body)

    def _toggle_collapsed(self) -> None:
        self._collapsed = not self._collapsed
        self.body.setVisible(not self._collapsed)
        self.collapse_button.setText("Script & Markers ▸" if self._collapsed else "Script & Markers ▾")
        self.collapsed_changed.emit(self._collapsed)

    def _import_script(self) -> None:
        path_str, _ = QFileDialog.getOpenFileName(self, "Import Script", "", "Scripts (*.md *.txt)")
        if not path_str:
            return
        text, sections = parse_script(Path(path_str))
        self._sections = sections
        self.script_view.setPlainText(text)
        self.script_imported.emit(text, sections)

    def refresh_markers(self, markers: list[Marker]) -> None:
        self.markers_list.clear()
        for m in sorted(markers, key=lambda x: x.position_sec):
            item = QListWidgetItem(f"{m.position_sec:6.1f}s — {m.name}")
            item.setData(Qt.UserRole, m.position_sec)
            self.markers_list.addItem(item)

    def _on_marker_double_clicked(self, item: QListWidgetItem) -> None:
        self.marker_jump_requested.emit(float(item.data(Qt.UserRole)))

    def highlight_section_for_time(self, position_sec: float, markers: list[Marker]) -> None:
        """Simple auto-scroll: jump the script view to the heading of the
        marker at-or-before the current playhead. Good enough once
        markers exist for each section; exact per-word sync is future work."""
        if not self.autoscroll_check.isChecked() or not markers:
            return
        candidates = [m for m in markers if m.position_sec <= position_sec]
        if not candidates:
            return
        current = max(candidates, key=lambda m: m.position_sec)
        cursor = self.script_view.document().find(current.name)
        if not cursor.isNull():
            self.script_view.setTextCursor(cursor)
            self.script_view.ensureCursorVisible()
