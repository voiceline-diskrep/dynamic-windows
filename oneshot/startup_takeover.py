"""
One-Shot Startup Takeover Mode
Full-screen launcher experience shown when user signs into Windows or requests takeover mode.
Includes prominent "Just Enter" button in the upper-right corner and fail-safe recovery.
"""

import os
import sys
import winreg
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QRectF
from PyQt6.QtGui import QFont, QColor, QPainter, QPainterPath, QLinearGradient, QBrush, QPen, QCursor
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGridLayout, QScrollArea, QFrame, QApplication
)

from oneshot.presets import PresetManager, Preset
from oneshot.launcher import AppLaunchEngine, LaunchResult

REG_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_RUN_NAME = "OneShotDynamicWindows"


def is_startup_enabled() -> bool:
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_KEY, 0, winreg.KEY_READ)
        winreg.QueryValueEx(key, APP_RUN_NAME)
        winreg.CloseKey(key)
        return True
    except FileNotFoundError:
        return False
    except Exception:
        return False


def set_startup_enabled(enabled: bool) -> bool:
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_RUN_KEY, 0, winreg.KEY_SET_VALUE)
        if enabled:
            exe_path = sys.executable
            cmd = f'"{exe_path}" --startup-mode'
            winreg.SetValueEx(key, APP_RUN_NAME, 0, winreg.REG_SZ, cmd)
        else:
            try:
                winreg.DeleteValue(key, APP_RUN_NAME)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


class StartupTakeoverWindow(QWidget):
    takeover_closed = pyqtSignal()

    def __init__(self, preset_manager: PresetManager, launch_engine: AppLaunchEngine):
        super().__init__()
        self.preset_manager = preset_manager
        self.launch_engine = launch_engine

        self.setWindowTitle("One-Shot Startup Launcher")
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.showFullScreen()

        self.init_ui()

    def init_ui(self):
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(60, 40, 60, 50)
        root_layout.setSpacing(24)

        # Top Bar: Title & Just Enter Button
        top_bar = QHBoxLayout()

        title_box = QVBoxLayout()
        title_box.setSpacing(4)
        lbl_brand = QLabel("ONE-SHOT")
        lbl_brand.setStyleSheet("font-size: 13px; font-weight: 700; color: #3b82f6; letter-spacing: 2px;")
        title_box.addWidget(lbl_brand)

        lbl_headline = QLabel("Choose Your Workspace Preset")
        lbl_headline.setStyleSheet("font-size: 26px; font-weight: 600; color: #ffffff;")
        title_box.addWidget(lbl_headline)

        top_bar.addLayout(title_box)
        top_bar.addStretch()

        # Prominent "Just Enter" Button in upper-right corner
        self.btn_just_enter = QPushButton("Just Enter ➔")
        self.btn_just_enter.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_just_enter.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #2563eb, stop:1 #3b82f6);
                color: #ffffff;
                font-size: 15px;
                font-weight: 700;
                padding: 12px 28px;
                border: 1px solid #60a5fa;
                border-radius: 24px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #1d4ed8, stop:1 #2563eb);
                border-color: #93c5fd;
            }
            QPushButton:pressed {
                background: #1e40af;
            }
        """)
        self.btn_just_enter.clicked.connect(self.exit_takeover)
        top_bar.addWidget(self.btn_just_enter)

        root_layout.addLayout(top_bar)

        # Preset Cards Grid
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("background: transparent; border: none;")

        container = QWidget()
        container.setStyleSheet("background: transparent;")
        grid = QGridLayout(container)
        grid.setSpacing(20)

        presets = self.preset_manager.get_presets()
        for idx, p in enumerate(presets):
            card = self.create_preset_card(p)
            row = idx // 3
            col = idx % 3
            grid.addWidget(card, row, col)

        scroll.setWidget(container)
        root_layout.addWidget(scroll)

        # Bottom Hint
        lbl_hint = QLabel("Press Enter or Esc to bypass and continue to Windows desktop.")
        lbl_hint.setStyleSheet("font-size: 12px; color: #71717a; text-align: center;")
        lbl_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root_layout.addWidget(lbl_hint)

    def create_preset_card(self, preset: Preset) -> QFrame:
        card = QFrame()
        card.setCursor(Qt.CursorShape.PointingHandCursor)
        card.setStyleSheet("""
            QFrame {
                background-color: rgba(24, 24, 27, 0.85);
                border: 1px solid rgba(63, 63, 70, 0.6);
                border-radius: 16px;
                padding: 20px;
            }
            QFrame:hover {
                background-color: rgba(39, 39, 42, 0.95);
                border: 1px solid #3b82f6;
            }
        """)

        layout = QVBoxLayout(card)
        layout.setSpacing(10)

        lbl_icon = QLabel("⚡")
        lbl_icon.setStyleSheet("font-size: 28px;")
        layout.addWidget(lbl_icon)

        lbl_name = QLabel(preset.name)
        lbl_name.setStyleSheet("font-size: 18px; font-weight: 600; color: #ffffff;")
        layout.addWidget(lbl_name)

        lbl_desc = QLabel(preset.description or f"{len(preset.apps)} applications configured")
        lbl_desc.setStyleSheet("font-size: 12px; color: #a1a1aa;")
        lbl_desc.setWordWrap(True)
        layout.addWidget(lbl_desc)

        layout.addStretch()

        app_tags = QLabel(" • ".join([a.name for a in preset.apps[:4]]) or "No apps added")
        app_tags.setStyleSheet("font-size: 11px; color: #71717a;")
        layout.addWidget(app_tags)

        # Click handling
        card.mousePressEvent = lambda e, p=preset: self.launch_and_exit(p)
        return card

    def launch_and_exit(self, preset: Preset):
        self.launch_engine.launch_preset(preset)
        self.exit_takeover()

    def exit_takeover(self):
        self.takeover_closed.emit()
        self.close()

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Escape, Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self.exit_takeover()
        else:
            super().keyPressEvent(event)

    def paintEvent(self, event):
        # Deep frosted glass background
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(10, 10, 14, 235))
