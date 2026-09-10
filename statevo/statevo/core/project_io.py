"""
Project save/load + templates.

Project layout on disk:

    <name>.svoproj/
        project.json
        takes/          # raw recorded WAV files, never overwritten
        exports/        # rendered deliverables land here by default
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from statevo.config import EXPORTS_DIRNAME, PROJECT_DIR_SUFFIX, PROJECT_JSON_FILENAME, TAKES_DIRNAME
from statevo.core.project import Project


def project_json_path(project_dir: Path) -> Path:
    return project_dir / PROJECT_JSON_FILENAME


def create_project_dir(root: Path, name: str) -> Path:
    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in name).strip().replace(" ", "_")
    project_dir = root / f"{safe_name}{PROJECT_DIR_SUFFIX}"
    (project_dir / TAKES_DIRNAME).mkdir(parents=True, exist_ok=True)
    (project_dir / EXPORTS_DIRNAME).mkdir(parents=True, exist_ok=True)
    return project_dir


def save_project(project: Project, project_dir: Path) -> None:
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / TAKES_DIRNAME).mkdir(exist_ok=True)
    (project_dir / EXPORTS_DIRNAME).mkdir(exist_ok=True)
    project.root_dir = project_dir
    project_json_path(project_dir).write_text(json.dumps(project.to_dict(), indent=2))


def load_project(project_dir: Path) -> Project:
    data = json.loads(project_json_path(project_dir).read_text())
    project = Project.from_dict(data)
    project.root_dir = project_dir
    return project


def create_from_template(template_path: Path, name: str, projects_root: Path) -> Project:
    data = json.loads(template_path.read_text())
    project = Project.from_dict(data)
    project.name = name
    project.created_at = time.time()
    project_dir = create_project_dir(projects_root, name)
    save_project(project, project_dir)
    return project
