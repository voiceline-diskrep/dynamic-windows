"""
Dynamic Windows & One-Shot
An Apple Dynamic Island & One-Shot Application Launcher for Windows 10/11.
Combines One-Shot application discovery, presets, startup takeover mode,
with a liquid glass Dynamic Island featuring Drop Zone, Task Manager,
AI Coding Agents, Music controls, System Audio, Calendar, Timers, and GitHub auto-updater.
"""

import sys
import os
import time
import ctypes
import webbrowser
from datetime import datetime

from PyQt6.QtCore import (
    Qt, QTimer, QPropertyAnimation, QEasingCurve, pyqtProperty, QPoint, QPointF, QRect, QRectF
)
from PyQt6.QtGui import (
    QColor, QPainter, QPainterPath, QFont, QPen, QBrush, QLinearGradient,
    QAction, QIcon, QCursor, QFontMetricsF, QPixmap
)
from PyQt6.QtWidgets import (
    QApplication, QWidget, QMenu, QSystemTrayIcon, QDialog, QVBoxLayout,
    QHBoxLayout, QLabel, QSlider, QPushButton, QMessageBox, QStackedWidget,
    QScrollArea, QFrame
)

# Windows native constants
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
CREATE_NO_WINDOW = 0x08000000

# Central Configurations & Updates
from updater_config import (
    CURRENT_VERSION, APP_NAME, DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME,
    load_config, save_config, APPDATA_DIR, UPDATES_DIR
)
import updater_logger as logger
from updater_engine import (
    UpdateCheckerThread, UpdateDownloaderThread, ReleaseInfo,
    apply_update_and_restart
)
from updater_dialogs import (
    UpdateSettingsDialog, ReleaseHistoryDialog, UpdateLogsDialog
)

# One-Shot Launcher Modules
from oneshot.discovery import AppDiscoveryEngine
from oneshot.presets import PresetManager
from oneshot.launcher import AppLaunchEngine
from oneshot.startup_takeover import StartupTakeoverWindow, is_startup_enabled, set_startup_enabled
from oneshot.ui import OneShotWidget

# Dynamic Island Modules
from island.sound_manager import SoundManager
from island.sound_widget import SoundWidget
from island.music_manager import MusicManager
from island.music_widget import MusicWidget
from island.timer_widget import FocusTimer, TimerWidget
from island.drop_zone import DropZoneWidget
from island.calendar_widget import CalendarWidget
from island.task_manager import TaskManagerWidget
from island.download_monitor import DownloadMonitor
from island.notification_monitor import NotificationMonitor
from island.notifications_widget import NotificationsWidget
from island.sticker_manager import StickerManager
from island.sticker_widget import StickerWidget
from island.activities_widget import ActivitiesWidget
from island.activity_engine import DynamicActivityEngine, PrimaryIslandActivity
from island.home_dashboard import HomeDashboardWidget

# AI Coding Agents
from ai_agents.manager import AIAgentActivityManager

# Comprehensive Settings Window
from settings_window import CompleteSettingsWindow

SPEED_PRESETS = {
    "very_fast": {"name": "⚡ Very Fast (120ms)", "expand": 120, "collapse": 90},
    "fast":      {"name": "🚀 Fast (180ms)",      "expand": 180, "collapse": 140},
    "normal":    {"name": "✨ Normal (280ms)",    "expand": 280, "collapse": 220},
    "slow":      {"name": "🐢 Slow (550ms)",      "expand": 550, "collapse": 420},
    "very_slow": {"name": "🎬 Cinematic (900ms)", "expand": 900, "collapse": 720},
}


class SpeedSliderDialog(QDialog):
    """Sleek dark-mode dialog to dial in custom animation duration."""
    def __init__(self, parent=None, current_expand=280):
        super().__init__(parent)
        self.parent_notch = parent
        self.setWindowTitle("Animation Speed")
        self.setFixedSize(340, 190)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet("""
            QDialog {
                background-color: #121215; color: #e4e4e7;
                border: 1px solid #27272a; border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
            QLabel { color: #e4e4e7; font-size: 13px; }
            QSlider::groove:horizontal { height: 6px; background: #27272a; border-radius: 3px; }
            QSlider::sub-page:horizontal { background: #3b82f6; border-radius: 3px; }
            QSlider::handle:horizontal {
                background: #ffffff; border: 2px solid #3b82f6;
                width: 16px; margin-top: -5px; margin-bottom: -5px; border-radius: 8px;
            }
            QPushButton {
                background-color: #1f1f24; color: #f4f4f5;
                border: 1px solid #3f3f46; border-radius: 6px;
                padding: 6px 14px; font-size: 12px;
            }
            QPushButton:hover { background-color: #27272a; }
            QPushButton#primaryBtn { background-color: #2563eb; color: white; }
        """)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        header = QLabel("Adjust Animation Duration")
        header.setStyleSheet("font-weight: 600; font-size: 14px; color: #ffffff;")
        layout.addWidget(header)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(80, 1500)
        self.slider.setSingleStep(20)
        self.slider.setValue(current_expand)
        self.slider.valueChanged.connect(self.on_slider_change)
        layout.addWidget(self.slider)

        self.val_label = QLabel(f"Duration: {current_expand} ms")
        self.val_label.setStyleSheet("color: #a1a1aa; font-size: 12px;")
        layout.addWidget(self.val_label)

        btn_layout = QHBoxLayout()
        btn_test = QPushButton("Test Animation")
        btn_test.clicked.connect(self.test_animation)
        btn_layout.addWidget(btn_test)

        btn_apply = QPushButton("Apply & Close")
        btn_apply.setObjectName("primaryBtn")
        btn_apply.clicked.connect(self.accept)
        btn_layout.addWidget(btn_apply)
        layout.addLayout(btn_layout)

    def on_slider_change(self, val):
        self.val_label.setText(f"Duration: {val} ms (Expand: {val}ms, Collapse: {int(val * 0.78)}ms)")
        if self.parent_notch:
            self.parent_notch.set_custom_speed(val)

    def test_animation(self):
        if self.parent_notch:
            self.parent_notch.expand_notch()
            QTimer.singleShot(int(self.slider.value() + 600), self.parent_notch.collapse_notch)


class DynamicNotch(QWidget):
    def __init__(self):
        super().__init__()

        # 1. Window Flags: Always on top, frameless, tool, does not steal focus
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool |
            Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_Hover, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setMouseTracking(True)

        # 2. Config & Display Settings
        self.config_data = load_config()
        self.mode = self.config_data.get("mode", "floating")
        self.is_24h = self.config_data.get("is_24h", False)
        self.show_seconds = self.config_data.get("show_seconds", True)
        self.pinned = False
        self.speed_preset = self.config_data.get("speed_preset", "normal")
        self.expand_duration = self.config_data.get("expand_duration", 280)
        self.collapse_duration = self.config_data.get("collapse_duration", 220)
        self.offset_x = self.config_data.get("offset_x", 0)

        # Dynamic Island Dimensions
        self.rest_width = 136
        self.rest_height = 29
        self.exp_width = 540
        self.exp_height = 420

        # Current Animated State
        self._anim_progress = 0.0
        self._current_width = float(self.rest_width)
        self._current_height = float(self.rest_height)
        self.is_expanded = False
        self.drag_position = None

        # 3. Instantiate Subsystems
        # One-Shot
        self.discovery_engine = AppDiscoveryEngine()
        self.preset_manager = PresetManager()
        self.launch_engine = AppLaunchEngine()

        # Audio, Music, Timer, Downloads, Notifications, Stickers
        self.sound_manager = SoundManager(self)
        self.music_manager = MusicManager(self)
        self.focus_timer = FocusTimer(self)
        self.download_monitor = DownloadMonitor(self)
        self.notification_monitor = NotificationMonitor(self)
        self.sticker_manager = StickerManager(self)

        # AI Coding Agents
        self.ai_manager = AIAgentActivityManager(self)

        # Dynamic Activity Engine
        self.activity_engine = DynamicActivityEngine(
            self.ai_manager, self.music_manager, self.download_monitor,
            self.focus_timer, self.notification_monitor, self
        )
        self.activity_engine.primary_activity_changed.connect(self.on_primary_activity_changed)

        # Updater State
        self.update_state = "idle"  # 'idle', 'available', 'downloading', 'ready'
        self.current_release: ReleaseInfo = None
        self.download_percent = 0
        self.download_speed_kbps = 0.0
        self.download_status_txt = ""
        self.verified_installer_path = ""
        self.checker_thread: UpdateCheckerThread = None
        self.downloader_thread: UpdateDownloaderThread = None

        # 4. Build Internal UI Container (Navigation Tabs & Panels)
        self.init_expanded_ui()

        # Geometry & Animation
        self.recalculate_geometry()
        self.anim = QPropertyAnimation(self, b"progress")
        self.anim.setDuration(self.expand_duration)
        self.anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        # Clock Timer
        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self.update)
        self.clock_timer.start(250)

        # Leave Timer
        self.leave_timer = QTimer(self)
        self.leave_timer.setSingleShot(True)
        self.leave_timer.timeout.connect(self.check_and_collapse)

        # Topmost Enforcement
        self.topmost_timer = QTimer(self)
        self.topmost_timer.timeout.connect(self.enforce_topmost)
        self.topmost_timer.start(2000)

        # System Tray
        self.setup_tray()

        # Periodic Updater Timer
        self.periodic_update_timer = QTimer(self)
        self.periodic_update_timer.timeout.connect(self.scheduled_update_check)
        self.apply_update_settings()
        QTimer.singleShot(4000, self.initial_background_check)

    # -----------------------------------------------------
    # Qt Property for animation
    # -----------------------------------------------------
    def get_progress(self):
        return self._anim_progress

    def set_progress(self, val):
        self._anim_progress = val
        self._current_width = self.rest_width + (self.exp_width - self.rest_width) * val
        self._current_height = self.rest_height + (self.exp_height - self.rest_height) * val
        self.recalculate_geometry()

        # Show/Hide internal widgets based on animation threshold
        if val > 0.45:
            self.content_container.setVisible(True)
        else:
            self.content_container.setVisible(False)

        self.update()

    progress = pyqtProperty(float, get_progress, set_progress)

    def recalculate_geometry(self):
        screen = QApplication.primaryScreen()
        if not screen:
            return
        screen_geom = screen.geometry()

        w = int(round(self._current_width / 2.0)) * 2
        h = int(round(self._current_height))
        x = ((screen_geom.width() - w) // 2) + self.offset_x
        y = 6 if self.mode == "floating" else 0

        self.setGeometry(x, y, w, h)

    def on_primary_activity_changed(self, act: PrimaryIslandActivity):
        """Update resting pill width and badge based on active background activity."""
        if act:
            self.rest_width = 200
        elif self.update_state != "idle":
            self.rest_width = 188
        else:
            self.rest_width = 136

        if not self.is_expanded:
            self._current_width = float(self.rest_width)
            self.recalculate_geometry()
        self.update()

    # -----------------------------------------------------
    # Expanded UI Layout & Navigation Tabs
    # -----------------------------------------------------
    def init_expanded_ui(self):
        self.content_container = QWidget(self)
        self.content_container.setVisible(False)
        self.content_container.setStyleSheet("background: transparent;")

        root_l = QVBoxLayout(self.content_container)
        root_l.setContentsMargins(16, 12, 16, 14)
        root_l.setSpacing(8)

        # 1. Top Bar: Digital Clock & Date
        top_bar = QHBoxLayout()
        self.lbl_clock_header = QLabel("12:00 PM")
        self.lbl_clock_header.setStyleSheet("font-size: 15px; font-weight: 700; color: #ffffff;")
        top_bar.addWidget(self.lbl_clock_header)

        self.lbl_date_header = QLabel("Saturday, October 31")
        self.lbl_date_header.setStyleSheet("font-size: 12px; color: #a1a1aa;")
        top_bar.addWidget(self.lbl_date_header)

        top_bar.addStretch()

        btn_pin = QPushButton("📌" if not self.pinned else "📍")
        btn_pin.setStyleSheet("background: transparent; font-size: 13px; border: none;")
        btn_pin.clicked.connect(self.toggle_pin)
        top_bar.addWidget(btn_pin)
        self.btn_pin = btn_pin

        btn_settings = QPushButton("⚙️")
        btn_settings.setStyleSheet("background: transparent; font-size: 13px; border: none;")
        btn_settings.clicked.connect(self.open_complete_settings)
        top_bar.addWidget(btn_settings)

        root_l.addLayout(top_bar)

        # 2. Horizontal Navigation Tabs Bar
        nav_scroll = QScrollArea()
        nav_scroll.setFixedHeight(34)
        nav_scroll.setWidgetResizable(True)
        nav_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        nav_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        nav_scroll.setStyleSheet("background: transparent; border: none;")

        nav_widget = QWidget()
        nav_widget.setStyleSheet("background: transparent;")
        self.nav_layout = QHBoxLayout(nav_widget)
        self.nav_layout.setContentsMargins(0, 0, 0, 0)
        self.nav_layout.setSpacing(6)

        self.tab_buttons = {}
        tab_names = [
            "Home", "One-Shot", "Files", "Calendar", "Notifications",
            "Sound", "Music", "Activities", "Timer", "Task Manager", "Stickers"
        ]

        for name in tab_names:
            btn = QPushButton(name)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #1a1a20;
                    color: #a1a1aa;
                    font-size: 11px;
                    font-weight: 600;
                    border: 1px solid #27272a;
                    border-radius: 12px;
                    padding: 3px 10px;
                }
                QPushButton:hover { background-color: #27272a; color: #ffffff; }
            """)
            btn.clicked.connect(lambda _, n=name: self.switch_tab(n))
            self.nav_layout.addWidget(btn)
            self.tab_buttons[name] = btn

        self.nav_layout.addStretch()
        nav_scroll.setWidget(nav_widget)
        root_l.addWidget(nav_scroll)

        # 3. Stacked Content Panels
        self.stack = QStackedWidget()
        self.stack.setStyleSheet("background: transparent;")

        # Instantiate Panel Widgets
        self.panel_home = HomeDashboardWidget(
            self.preset_manager, self.launch_engine, self.ai_manager,
            self.music_manager, self.focus_timer, self
        )
        self.panel_home.switch_tab_requested.connect(self.switch_tab)

        self.panel_oneshot = OneShotWidget(
            self.preset_manager, self.launch_engine, self.discovery_engine, self
        )
        self.panel_files = DropZoneWidget(self)
        self.panel_calendar = CalendarWidget(self)
        self.panel_notif = NotificationsWidget(self.notification_monitor, self)
        self.panel_sound = SoundWidget(self.sound_manager, self)
        self.panel_music = MusicWidget(self.music_manager, self)
        self.panel_activities = ActivitiesWidget(self.ai_manager, self.download_monitor, self.focus_timer, self)
        self.panel_timer = TimerWidget(self.focus_timer, self)
        self.panel_taskmgr = TaskManagerWidget(self)
        self.panel_stickers = StickerWidget(self.sticker_manager, self)

        self.tab_indices = {
            "Home": self.stack.addWidget(self.panel_home),
            "One-Shot": self.stack.addWidget(self.panel_oneshot),
            "Files": self.stack.addWidget(self.panel_files),
            "Calendar": self.stack.addWidget(self.panel_calendar),
            "Notifications": self.stack.addWidget(self.panel_notif),
            "Sound": self.stack.addWidget(self.panel_sound),
            "Music": self.stack.addWidget(self.panel_music),
            "Activities": self.stack.addWidget(self.panel_activities),
            "Timer": self.stack.addWidget(self.panel_timer),
            "Task Manager": self.stack.addWidget(self.panel_taskmgr),
            "Stickers": self.stack.addWidget(self.panel_stickers),
        }

        root_l.addWidget(self.stack, 1)
        self.switch_tab("Home")

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.content_container.setGeometry(0, 0, self.width(), self.height())

    def switch_tab(self, name: str):
        if name in self.tab_indices:
            self.stack.setCurrentIndex(self.tab_indices[name])
            for tab_name, btn in self.tab_buttons.items():
                if tab_name == name:
                    btn.setStyleSheet("""
                        QPushButton {
                            background-color: #2563eb;
                            color: #ffffff;
                            font-size: 11px;
                            font-weight: 700;
                            border: 1px solid #3b82f6;
                            border-radius: 12px;
                            padding: 3px 10px;
                        }
                    """)
                else:
                    btn.setStyleSheet("""
                        QPushButton {
                            background-color: #1a1a20;
                            color: #a1a1aa;
                            font-size: 11px;
                            font-weight: 600;
                            border: 1px solid #27272a;
                            border-radius: 12px;
                            padding: 3px 10px;
                        }
                        QPushButton:hover { background-color: #27272a; color: #ffffff; }
                    """)

    # -----------------------------------------------------
    # Hover & Animation Controls
    # -----------------------------------------------------
    def enterEvent(self, event):
        self.leave_timer.stop()
        if not self.is_expanded:
            self.expand_notch()
        super().enterEvent(event)

    def leaveEvent(self, event):
        if not self.pinned:
            grace = max(140, min(300, int(self.collapse_duration * 0.6)))
            self.leave_timer.start(grace)
        super().leaveEvent(event)

    def check_and_collapse(self):
        cursor_global = QCursor.pos()
        cursor_local = self.mapFromGlobal(cursor_global)
        if not self.rect().contains(cursor_local) and not self.pinned:
            self.collapse_notch()

    def expand_notch(self):
        self.is_expanded = True
        self.anim.stop()
        self.anim.setStartValue(self._anim_progress)
        self.anim.setEndValue(1.0)
        self.anim.setDuration(self.expand_duration)
        self.anim.start()

    def collapse_notch(self):
        self.is_expanded = False
        self.anim.stop()
        self.anim.setStartValue(self._anim_progress)
        self.anim.setEndValue(0.0)
        self.anim.setDuration(self.collapse_duration)
        self.anim.start()

    def toggle_pin(self):
        self.pinned = not self.pinned
        self.btn_pin.setText("📌" if not self.pinned else "📍")
        if self.pinned:
            self.expand_notch()
        else:
            self.collapse_notch()

    # -----------------------------------------------------
    # Updater System Integration
    # -----------------------------------------------------
    def apply_update_settings(self):
        self.config_data = load_config()
        interval_h = self.config_data.get("check_interval_hours", 6)
        auto_chk = self.config_data.get("auto_check_updates", True)
        self.periodic_update_timer.stop()
        if auto_chk and interval_h > 0:
            self.periodic_update_timer.start(int(interval_h * 3600 * 1000))

    def initial_background_check(self):
        if self.config_data.get("auto_check_updates", True):
            self.start_check_thread(is_manual=False)

    def scheduled_update_check(self):
        if self.config_data.get("auto_check_updates", True):
            self.start_check_thread(is_manual=False)

    def start_check_thread(self, is_manual: bool = False):
        if self.checker_thread and self.checker_thread.isRunning():
            return
        self.checker_thread = UpdateCheckerThread(CURRENT_VERSION)
        self.checker_thread.update_available.connect(lambda rel: self.on_update_found(rel, is_manual))
        self.checker_thread.up_to_date.connect(lambda msg: self.on_up_to_date(msg, is_manual))
        self.checker_thread.error_occurred.connect(lambda err: self.on_check_error(err, is_manual))
        self.checker_thread.start()

    def on_update_found(self, release_info: ReleaseInfo, is_manual: bool):
        logger.info(f"Update available: {release_info.raw_tag}")
        self.current_release = release_info
        self.update_state = "available"
        self.update()

        msg_box = QMessageBox(self)
        msg_box.setWindowTitle("Dynamic Windows Update")
        msg_box.setText(
            f"Update Available: {release_info.raw_tag}\n\n"
            f"Current version: v{CURRENT_VERSION}\n"
            f"New version: {release_info.raw_tag}\n\n"
            f"{release_info.summary}\n\n"
            f"Would you like to download and install this update?"
        )
        btn_update = msg_box.addButton("Update Now", QMessageBox.ButtonRole.AcceptRole)
        msg_box.addButton("Remind Later", QMessageBox.ButtonRole.RejectRole)
        msg_box.exec()

        if msg_box.clickedButton() == btn_update:
            self.start_update_download(release_info)

    def on_up_to_date(self, msg: str, is_manual: bool):
        if is_manual:
            QMessageBox.information(self, "Dynamic Windows", f"✓ {msg}")

    def on_check_error(self, err: str, is_manual: bool):
        if is_manual:
            QMessageBox.warning(self, "Update Check Error", f"⚠ {err}")

    def start_update_download(self, release_info: ReleaseInfo = None):
        rel = release_info or self.current_release
        if not rel or (self.downloader_thread and self.downloader_thread.isRunning()):
            return
        self.update_state = "downloading"
        self.downloader_thread = UpdateDownloaderThread(rel)
        self.downloader_thread.download_progress.connect(self.on_download_progress)
        self.downloader_thread.download_finished.connect(self.on_download_finished)
        self.downloader_thread.download_failed.connect(self.on_download_failed)
        self.downloader_thread.start()

    def on_download_progress(self, percent, done_bytes, total_bytes, speed_kbps, status_txt):
        self.download_percent = percent
        self.download_speed_kbps = speed_kbps
        self.download_status_txt = status_txt
        self.update()

    def on_download_finished(self, file_path: str, release_info: ReleaseInfo):
        self.verified_installer_path = file_path
        self.update_state = "ready"
        self.update()
        if QMessageBox.question(
            self, "Update Ready",
            f"Update {release_info.raw_tag} has been verified and is ready.\nInstall and restart Dynamic Windows now?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        ) == QMessageBox.StandardButton.Yes:
            apply_update_and_restart(file_path, is_silent=True)
            QApplication.quit()

    def on_download_failed(self, error_msg: str):
        self.update_state = "idle"
        self.update()
        QMessageBox.warning(self, "Download Failed", f"Failed to download update: {error_msg}")

    # -----------------------------------------------------
    # Context Menu & System Tray
    # -----------------------------------------------------
    def contextMenuEvent(self, event):
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #121215; color: #e4e4e7;
                border: 1px solid #27272a; border-radius: 8px;
                padding: 6px; font-family: 'Segoe UI', sans-serif; font-size: 13px;
            }
            QMenu::item { padding: 6px 20px; border-radius: 4px; }
            QMenu::item:selected { background-color: #27272a; color: #ffffff; }
            QMenu::separator { height: 1px; background-color: #27272a; margin: 4px 8px; }
        """)

        act_settings = menu.addAction("⚙️ Settings & Preferences...")
        act_settings.triggered.connect(self.open_complete_settings)

        act_takeover = menu.addAction("⚡ Launch One-Shot Takeover Screen")
        act_takeover.triggered.connect(self.open_takeover)

        menu.addSeparator()

        act_chk = menu.addAction("🔄 Check for Updates Now...")
        act_chk.triggered.connect(lambda: self.start_check_thread(is_manual=True))

        act_notes = menu.addAction("📜 View Release History & Notes...")
        act_notes.triggered.connect(lambda: ReleaseHistoryDialog(self).exec())

        act_logs = menu.addAction("📄 View Update Diagnostics & Logs...")
        act_logs.triggered.connect(lambda: UpdateLogsDialog(self).exec())

        menu.addSeparator()

        # Format 12h/24h
        act_format = menu.addAction("Format: 24-Hour" if not self.is_24h else "Format: 12-Hour (AM/PM)")
        act_format.triggered.connect(self.toggle_time_format)

        # Style mode
        act_mode = menu.addAction("Style: Flush Notch (Bezel)" if self.mode == "floating" else "Style: Floating Island")
        act_mode.triggered.connect(self.toggle_style_mode)

        # Pin
        act_pin = menu.addAction("Unpin Notch" if self.pinned else "Pin / Keep Expanded")
        act_pin.triggered.connect(self.toggle_pin)

        # Recenter
        act_recenter = menu.addAction("Recenter Notch")
        act_recenter.triggered.connect(self.reset_center)

        menu.addSeparator()
        act_quit = menu.addAction("Exit Dynamic Windows")
        act_quit.triggered.connect(QApplication.quit)

        menu.exec(self.mapToGlobal(event.pos()))

    def open_complete_settings(self):
        dlg = CompleteSettingsWindow(self)
        dlg.exec()

    def open_takeover(self):
        self.takeover_win = StartupTakeoverWindow(self.preset_manager, self.launch_engine)

    def toggle_time_format(self):
        self.is_24h = not self.is_24h
        self.config_data["is_24h"] = self.is_24h
        save_config(self.config_data)
        self.update()

    def toggle_style_mode(self):
        self.mode = "anchored" if self.mode == "floating" else "floating"
        self.config_data["mode"] = self.mode
        save_config(self.config_data)
        self.recalculate_geometry()
        self.update()

    def reset_center(self):
        self.offset_x = 0
        self.config_data["offset_x"] = 0
        save_config(self.config_data)
        self.recalculate_geometry()

    def enforce_topmost(self):
        try:
            hwnd = int(self.winId())
            ctypes.windll.user32.SetWindowPos(
                hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
            )
        except Exception:
            pass

    def setup_tray(self):
        self.tray = QSystemTrayIcon(self)
        tray_menu = QMenu()
        tray_menu.setStyleSheet("""
            QMenu { background-color: #121215; color: #e4e4e7; border: 1px solid #27272a; padding: 4px; }
            QMenu::item { padding: 6px 16px; }
            QMenu::item:selected { background-color: #27272a; }
        """)

        tray_menu.addAction("One-Shot Launcher...", self.open_takeover)
        tray_menu.addAction("Settings & Preferences...", self.open_complete_settings)
        tray_menu.addAction("Check for Updates...", lambda: self.start_check_thread(is_manual=True))
        tray_menu.addAction("Recenter Notch", self.reset_center)
        tray_menu.addSeparator()
        tray_menu.addAction("Exit", QApplication.quit)

        self.tray.setContextMenu(tray_menu)
        self.tray.setToolTip(f"Dynamic Windows + One-Shot (v{CURRENT_VERSION})")
        self.tray.show()

    # =====================================================
    # PAINT EVENT: Sleek Dynamic Island Rendering
    # =====================================================
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)

        w = float(self.width())
        h = float(self.height())
        p = max(0.0, min(1.0, self._anim_progress))

        # Dynamic Corner Radius
        path = QPainterPath()
        if self.mode == "floating":
            radius = (14.0 + 12.0 * p)
            path.addRoundedRect(QRectF(0, 0, w, h), radius, radius)
        else:
            radius = (14.0 + 10.0 * p)
            path.moveTo(0, 0)
            path.lineTo(w, 0)
            path.lineTo(w, h - radius)
            path.quadTo(w, h, w - radius, h)
            path.lineTo(radius, h)
            path.quadTo(0, h, 0, h - radius)
            path.closeSubpath()

        # 1. Outer Glow / Drop Shadow
        glow_alpha = int(120 + 40 * p)
        painter.fillPath(path, QColor(0, 0, 0, glow_alpha))

        # 2. Main OLED Black Surface with subtle glass gradient
        surface_grad = QLinearGradient(0, 0, 0, h)
        surface_grad.setColorAt(0.0, QColor(16, 16, 20, 245 if p > 0.4 else 255))
        surface_grad.setColorAt(0.5, QColor(8, 8, 10, 250 if p > 0.4 else 255))
        surface_grad.setColorAt(1.0, QColor(2, 2, 4, 255))
        painter.fillPath(path, QBrush(surface_grad))

        # 3. Specular Border
        border_pen = QPen()
        border_alpha = int(35 + 25 * p)
        border_pen.setColor(QColor(255, 255, 255, border_alpha))
        border_pen.setWidthF(1.0)
        painter.strokePath(path, border_pen)

        now = datetime.now()

        # Time formatting
        if self.is_24h:
            time_standby = now.strftime("%H:%M")
        else:
            time_standby = now.strftime("%I:%M %p").lstrip("0")

        # -------------------------------------------------
        # STANDBY VIEW (p < 0.20): Compact Pill
        # -------------------------------------------------
        if p < 0.20:
            alpha_standby = int(max(0.0, min(1.0, (0.20 - p) / 0.20)) * 235)
            font_standby = QFont("Segoe UI Variable Display", 10, QFont.Weight.Medium)
            painter.setFont(font_standby)
            painter.setPen(QColor(235, 235, 245, alpha_standby))

            primary_act = self.activity_engine.current_primary

            if not primary_act and self.update_state == "idle":
                # Clean, pure time only
                clock_rect = QRectF(0, 0, w, h)
                painter.drawText(clock_rect, Qt.AlignmentFlag.AlignCenter, time_standby)
            else:
                # Time on left
                clock_rect = QRectF(14, 0, 78, h)
                painter.drawText(clock_rect, Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, time_standby)

                # Badge on right
                badge_text = primary_act.badge if primary_act else f"✦ v{CURRENT_VERSION}"
                badge_rect = QRectF(w - 96, (h - 18) / 2, 84, 18)
                badge_path = QPainterPath()
                badge_path.addRoundedRect(badge_rect, 9, 9)
                painter.fillPath(badge_path, QColor(37, 99, 235, int(alpha_standby * 0.4)))
                painter.strokePath(badge_path, QPen(QColor(59, 130, 246, int(alpha_standby * 0.7)), 1))

                badge_font = QFont("Segoe UI Variable Text", 8, QFont.Weight.DemiBold)
                painter.setFont(badge_font)
                painter.setPen(QColor(224, 242, 254, alpha_standby))
                painter.drawText(badge_rect, Qt.AlignmentFlag.AlignCenter, badge_text)

        # -------------------------------------------------
        # EXPANDED VIEW UPDATE: Sync Top Bar
        # -------------------------------------------------
        if p > 0.45:
            self.lbl_clock_header.setText(time_standby)
            self.lbl_date_header.setText(now.strftime("%A, %B %d"))


def main():
    if hasattr(Qt.ApplicationAttribute, 'AA_EnableHighDpiScaling'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    if hasattr(Qt.ApplicationAttribute, 'AA_UseHighDpiPixmaps'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    # Check for startup takeover mode flag
    if "--startup-mode" in sys.argv or "--takeover" in sys.argv:
        preset_mgr = PresetManager()
        launch_engine = AppLaunchEngine()
        takeover = StartupTakeoverWindow(preset_mgr, launch_engine)

        def on_takeover_exit():
            notch = DynamicNotch()
            notch.show()
            notch.enforce_topmost()

        takeover.takeover_closed.connect(on_takeover_exit)
    else:
        notch = DynamicNotch()
        notch.show()
        notch.enforce_topmost()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
