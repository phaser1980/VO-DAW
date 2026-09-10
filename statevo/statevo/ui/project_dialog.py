"""Startup dialog: new project (optionally from a template) or open an
existing one. This is the entire "Project Management" surface for the
MVP — no separate preferences window yet, deliberately."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from statevo.config import PROJECT_DIR_SUFFIX, default_projects_dir

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "assets" / "templates"


class ProjectStartDialog(QDialog):
    """After exec(), `self.result_data` holds one of:
        ("new", name, template_path_or_None)
        ("open", project_dir)
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("StateVO")
        self.setMinimumSize(420, 320)
        self.result_data = None

        layout = QVBoxLayout(self)
        tabs = QTabWidget()
        layout.addWidget(tabs)

        # -- New project tab -----------------------------------------------
        new_tab = QWidget()
        new_layout = QVBoxLayout(new_tab)
        new_layout.addWidget(QLabel("Project name:"))
        self.name_edit = QLineEdit("Untitled Episode")
        new_layout.addWidget(self.name_edit)

        new_layout.addWidget(QLabel("Template:"))
        self.template_combo = QComboBox()
        self.template_combo.addItem("Blank (single voice track)", None)
        if TEMPLATES_DIR.exists():
            for path in sorted(TEMPLATES_DIR.glob("*.json")):
                self.template_combo.addItem(path.stem.replace("_", " ").title(), str(path))
        new_layout.addWidget(self.template_combo)

        create_button = QPushButton("Create Project")
        create_button.clicked.connect(self._create)
        new_layout.addWidget(create_button)
        new_layout.addStretch(1)
        tabs.addTab(new_tab, "New")

        # -- Open project tab -----------------------------------------------
        open_tab = QWidget()
        open_layout = QVBoxLayout(open_tab)
        self.recent_list = QListWidget()
        self._populate_recent()
        open_layout.addWidget(self.recent_list)
        open_row = QHBoxLayout()
        browse_button = QPushButton("Browse…")
        browse_button.clicked.connect(self._browse)
        open_button = QPushButton("Open Selected")
        open_button.clicked.connect(self._open_selected)
        open_row.addWidget(browse_button)
        open_row.addWidget(open_button)
        open_layout.addLayout(open_row)
        tabs.addTab(open_tab, "Open")

    def _populate_recent(self) -> None:
        root = default_projects_dir()
        if not root.exists():
            return
        for entry in sorted(root.glob(f"*{PROJECT_DIR_SUFFIX}")):
            item = QListWidgetItem(entry.name)
            item.setData(Qt.UserRole, str(entry))
            self.recent_list.addItem(item)

    def _create(self) -> None:
        template = self.template_combo.currentData()
        self.result_data = ("new", self.name_edit.text().strip() or "Untitled Episode", template)
        self.accept()

    def _browse(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Open Project", str(default_projects_dir()))
        if folder:
            self.result_data = ("open", folder)
            self.accept()

    def _open_selected(self) -> None:
        item = self.recent_list.currentItem()
        if item:
            self.result_data = ("open", item.data(Qt.UserRole))
            self.accept()
