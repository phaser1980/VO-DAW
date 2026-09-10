"""
Script import: turn a plain-text or markdown script into named sections,
which the UI can turn into timeline markers ("Automatically create
markers from script sections or headings").
"""
from __future__ import annotations

import re
from pathlib import Path

from statevo.core.project import ScriptSection

_MD_HEADING = re.compile(r"^#{1,6}\s+(.*)")


def parse_script(path: Path) -> tuple[str, list[ScriptSection]]:
    """Returns (full_text, sections). Works for .md (headings define
    sections) and .txt (blank-line-separated paragraphs, the first line
    of each paragraph used as its heading)."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".md":
        sections = _parse_markdown(text)
    else:
        sections = _parse_plaintext(text)
    return text, sections


def _parse_markdown(text: str) -> list[ScriptSection]:
    sections: list[ScriptSection] = []
    current_heading = "Intro"
    current_body: list[str] = []
    order = 0

    def flush() -> None:
        nonlocal current_body, order
        if current_body or sections:
            sections.append(ScriptSection(heading=current_heading, body="\n".join(current_body).strip(), order=order))
            order += 1
        current_body = []

    for line in text.splitlines():
        match = _MD_HEADING.match(line)
        if match:
            flush()
            current_heading = match.group(1).strip()
        else:
            current_body.append(line)
    flush()
    return [s for s in sections if s.body or s.heading]


def _parse_plaintext(text: str) -> list[ScriptSection]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    sections = []
    for i, para in enumerate(paragraphs):
        lines = para.splitlines()
        heading = lines[0][:60] if lines else f"Section {i + 1}"
        sections.append(ScriptSection(heading=heading, body=para, order=i))
    return sections
