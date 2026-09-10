"""Application entry point: python -m statevo.app (or the `statevo`
console script installed via pyproject.toml)."""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtWidgets import QApplication

from statevo.config import default_projects_dir
from statevo.core import project_io
from statevo.core.project import Project
from statevo.ui.main_window import MainWindow
from statevo.ui.project_dialog import ProjectStartDialog
from statevo.ui.theme import apply_theme


def main() -> int:
    app = QApplication(sys.argv)
    apply_theme(app)

    start_dialog = ProjectStartDialog()
    if start_dialog.exec() != ProjectStartDialog.Accepted or start_dialog.result_data is None:
        return 0

    kind, *rest = start_dialog.result_data
    if kind == "new":
        name, template_path = rest
        default_projects_dir().mkdir(parents=True, exist_ok=True)
        if template_path:
            project = project_io.create_from_template(Path(template_path), name, default_projects_dir())
        else:
            project = Project.new(name)
            project_dir = project_io.create_project_dir(default_projects_dir(), name)
            project_io.save_project(project, project_dir)
    else:  # "open"
        project_dir = Path(rest[0])
        project = project_io.load_project(project_dir)

    window = MainWindow(project)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
