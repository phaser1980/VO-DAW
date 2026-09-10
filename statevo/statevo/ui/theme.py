"""Dark, high-contrast theme. One stylesheet, applied once — no
per-widget styling scattered through the codebase."""
from __future__ import annotations

from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

BG = "#121214"
BG_PANEL = "#1B1B1F"
BG_RAISED = "#242429"
TEXT = "#EDEDEF"
TEXT_DIM = "#9A9AA2"
ACCENT_RECORD = "#FF3B30"
ACCENT_OK = "#30D158"
ACCENT_INFO = "#57C7FF"
BORDER = "#2E2E34"

QSS = f"""
QWidget {{
    background-color: {BG};
    color: {TEXT};
    font-family: -apple-system, "Segoe UI", "Inter", sans-serif;
    font-size: 13px;
}}
QMainWindow, QDialog {{ background-color: {BG}; }}
QToolTip {{ background-color: {BG_RAISED}; color: {TEXT}; border: 1px solid {BORDER}; }}

QPushButton {{
    background-color: {BG_RAISED};
    border: 1px solid {BORDER};
    border-radius: 6px;
    padding: 6px 12px;
}}
QPushButton:hover {{ background-color: #2C2C33; }}
QPushButton:checked {{ background-color: {ACCENT_INFO}; color: #05070A; }}
QPushButton:disabled {{ color: {TEXT_DIM}; }}

QComboBox, QLineEdit, QPlainTextEdit, QTextEdit, QTextBrowser, QListWidget {{
    background-color: {BG_PANEL};
    border: 1px solid {BORDER};
    border-radius: 6px;
    padding: 4px;
}}

QDockWidget::title {{ background-color: {BG_PANEL}; padding: 6px; }}

QMenuBar {{ background-color: {BG}; }}
QMenuBar::item:selected {{ background-color: {BG_RAISED}; }}
QMenu {{ background-color: {BG_PANEL}; border: 1px solid {BORDER}; }}
QMenu::item:selected {{ background-color: {BG_RAISED}; }}

QProgressBar {{
    background-color: {BG_PANEL};
    border: 1px solid {BORDER};
    border-radius: 4px;
    text-align: center;
}}
QProgressBar::chunk {{ background-color: {ACCENT_OK}; border-radius: 4px; }}

QSlider::groove:horizontal {{ background: {BG_PANEL}; height: 4px; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: {ACCENT_INFO}; width: 12px; margin: -5px 0; border-radius: 6px; }}
"""


def apply_theme(app: QApplication) -> None:
    app.setStyleSheet(QSS)
    palette = QPalette()
    palette.setColor(QPalette.Window, QColor(BG))
    palette.setColor(QPalette.WindowText, QColor(TEXT))
    palette.setColor(QPalette.Base, QColor(BG_PANEL))
    palette.setColor(QPalette.Text, QColor(TEXT))
    app.setPalette(palette)
