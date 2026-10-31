"""
Dynamic Windows & One-Shot (v1.0.4)
An authentic Apple-inspired Dynamic Island & One-Shot Application Launcher for Windows 10/11.
Features:
- High-Precision 144Hz Fluid Animation Engine (7ms precise frame delta timing)
- Pure OLED Minimalist Aesthetics with Liquid Glass Specular Rim and Ambient Glow
- Live Activity Island for Google Antigravity with official logo, live transcripts & progress
- Instant 1-Click Launchers for One-Shot, Drop Zone, Task Manager, and Settings
- Automatic GitHub Releases Update Engine with SHA256 integrity verification
"""

import sys
import os
import time
import ctypes
from datetime import datetime

from PyQt6.QtCore import (
    Qt, QTimer, QPoint, QPointF, QRect, QRectF, pyqtSignal
)
from PyQt6.QtGui import (
    QColor, QPainter, QPainterPath, QFont, QPen, QBrush, QLinearGradient,
    QAction, QIcon, QCursor, QFontMetricsF, QPixmap
)
from PyQt6.QtWidgets import (
    QApplication, QWidget, QMenu, QSystemTrayIcon, QDialog, QVBoxLayout,
    QHBoxLayout, QLabel, QSlider, QPushButton, QMessageBox
)

# Windows native constants
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
CREATE_NO_WINDOW = 0x08000000

APP_DIR = os.path.dirname(os.path.abspath(__file__))

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
from oneshot.startup_takeover import StartupTakeoverWindow
from oneshot.ui import OneShotWindow

# Dynamic Island Modules & Windows
from island.sound_manager import SoundManager
from island.music_manager import MusicManager
from island.timer_widget import FocusTimer
from island.drop_zone import DropZoneWindow
from island.task_manager import TaskManagerWindow
from island.download_monitor import DownloadMonitor
from island.notification_monitor import NotificationMonitor
from island.sticker_manager import StickerManager
from island.activities_widget import ActivitiesWindow
from island.activity_engine import DynamicActivityEngine, PrimaryIslandActivity

# AI Coding Agents
from ai_agents.manager import AIAgentActivityManager

# Comprehensive Settings Window
from settings_window import CompleteSettingsWindow

SPEED_PRESETS = {
    "ultra":     {"name": "⚡ 144Hz Ultra (160ms)", "expand": 160, "collapse": 120},
    "fast":      {"name": "🚀 Fast (220ms)",        "expand": 220, "collapse": 170},
    "normal":    {"name": "✨ Normal (280ms)",      "expand": 280, "collapse": 220},
    "smooth":    {"name": "🌊 Smooth (420ms)",      "expand": 420, "collapse": 330},
    "cinematic": {"name": "🎬 Cinematic (650ms)",   "expand": 650, "collapse": 520},
}


class SpeedSliderDialog(QDialog):
    """Sleek dark-mode dialog to dial in custom animation duration."""
    def __init__(self, parent=None, current_expand=280):
        super().__init__(parent)
        self.parent_notch = parent
        self.setWindowTitle("Animation Speed")
        self.setFixedSize(360, 200)
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
            QPushButton#primaryBtn { background-color: #2563eb; color: white; border-color: #3b82f6; }
        """)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        header = QLabel("Adjust 144Hz Animation Duration")
        header.setStyleSheet("font-weight: 600; font-size: 14px; color: #ffffff;")
        layout.addWidget(header)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(80, 1200)
        self.slider.setSingleStep(20)
        self.slider.setValue(current_expand)
        self.slider.valueChanged.connect(self.on_slider_change)
        layout.addWidget(self.slider)

        self.val_label = QLabel(f"Duration: {current_expand} ms (144 FPS synced)")
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
            QTimer.singleShot(int(self.slider.value() + 500), self.parent_notch.collapse_notch)


class DynamicNotch(QWidget):
    """
    Apple Dynamic Island overlay for Windows.
    Renders pure liquid glass with 144Hz precision timing, zero widget lag,
    and expansive dedicated windows for One-Shot, Drop Zone, Task Manager, and Settings.
    """
    def __init__(self):
        super().__init__()

        # 1. Window Flags: Topmost, frameless, tool, no focus steal
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

        # 3. Dynamic Island Dimensions (Spacious & Apple-proportionate)
        self.idle_rest_width = 140
        self.active_rest_width = 208
        self.rest_height = 30

        self.idle_exp_width = 384
        self.idle_exp_height = 94

        self.active_exp_width = 432
        self.active_exp_height = 104

        # Current Animated State
        self._anim_progress = 0.0  # 0.0 = resting pill, 1.0 = fully expanded
        self._current_width = float(self.idle_rest_width)
        self._current_height = float(self.rest_height)
        self.is_expanded = False
        self.drag_position = None

        # Hover state for interactive buttons
        self.hovered_btn_idx = -1  # 0: Launch, 1: Drop, 2: System, 3: Settings, 4: Activity Action

        # 4. Load High-DPI Official Logos & Assets
        self.antigravity_logo: QPixmap = None
        logo_path = os.path.join(APP_DIR, "antigravity_logo.png")
        if os.path.exists(logo_path):
            self.antigravity_logo = QPixmap(logo_path)

        self.app_icon_pixmap: QPixmap = None
        icon_path = os.path.join(APP_DIR, "app_icon.png")
        if os.path.exists(icon_path):
            self.app_icon_pixmap = QPixmap(icon_path)

        # 5. Instantiate Underlying Subsystems
        self.discovery_engine = AppDiscoveryEngine()
        self.preset_manager = PresetManager()
        self.launch_engine = AppLaunchEngine()

        self.sound_manager = SoundManager(self)
        self.music_manager = MusicManager(self)
        self.focus_timer = FocusTimer(self)
        self.download_monitor = DownloadMonitor(self)
        self.notification_monitor = NotificationMonitor(self)
        self.sticker_manager = StickerManager(self)

        # AI Coding Agents & Dynamic Activity Engine
        self.ai_manager = AIAgentActivityManager(self)
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

        # Standalone Subsystem Windows
        self._win_oneshot = None
        self._win_dropzone = None
        self._win_taskmgr = None
        self._win_activities = None
        self._win_settings = None

        # 6. High-Precision 144Hz Animation Engine
        self.anim_timer = QTimer(self)
        self.anim_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.anim_timer.setInterval(7)  # 7ms ~= 142.8 FPS
        self.anim_timer.timeout.connect(self._step_144hz_animation)

        self._anim_start_time = 0.0
        self._anim_duration_sec = 0.28
        self._anim_start_progress = 0.0
        self._anim_target_progress = 0.0

        # Clock Timer
        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self.update)
        self.clock_timer.start(250)

        # Mouse Leave Grace Timer
        self.leave_timer = QTimer(self)
        self.leave_timer.setSingleShot(True)
        self.leave_timer.timeout.connect(self.check_and_collapse)

        # Topmost Window Enforcement
        self.topmost_timer = QTimer(self)
        self.topmost_timer.timeout.connect(self.enforce_topmost)
        self.topmost_timer.start(2000)

        # Initial positioning & System Tray
        self.recalculate_geometry()
        self.setup_tray()

        # Background Update Checking
        self.periodic_update_timer = QTimer(self)
        self.periodic_update_timer.timeout.connect(self.scheduled_update_check)
        self.apply_update_settings()
        QTimer.singleShot(3500, self.initial_background_check)

    # -----------------------------------------------------
    # Helper Queries
    # -----------------------------------------------------
    def has_active_activity(self) -> bool:
        """Returns True if there is a prominent background activity (Agent, Music, Download, Timer, Update)."""
        return (self.activity_engine.current_primary is not None) or (self.update_state != "idle")

    def get_resting_width(self) -> float:
        return float(self.active_rest_width if self.has_active_activity() else self.idle_rest_width)

    def get_target_expanded_size(self):
        if self.has_active_activity():
            return float(self.active_exp_width), float(self.active_exp_height)
        return float(self.idle_exp_width), float(self.idle_exp_height)

    def on_primary_activity_changed(self, act: PrimaryIslandActivity):
        """Smoothly adapts resting pill width when background activity triggers."""
        if not self.is_expanded:
            target_rest = self.get_resting_width()
            if abs(self._current_width - target_rest) > 1.0:
                self._current_width = target_rest
                self.recalculate_geometry()
        self.update()

    # -----------------------------------------------------
    # 144Hz High-Precision Animation Driver
    # -----------------------------------------------------
    def _step_144hz_animation(self):
        now = time.perf_counter()
        elapsed = now - self._anim_start_time

        if self._anim_duration_sec <= 0.001:
            t = 1.0
        else:
            t = min(1.0, elapsed / self._anim_duration_sec)

        # Fluid Apple Quartic Ease-Out: 1 - (1 - t)^3.6
        ease = 1.0 - pow(1.0 - t, 3.6)
        self._anim_progress = self._anim_start_progress + (self._anim_target_progress - self._anim_start_progress) * ease

        rest_w = self.get_resting_width()
        target_w, target_h = self.get_target_expanded_size()

        self._current_width = rest_w + (target_w - rest_w) * self._anim_progress
        self._current_height = float(self.rest_height) + (target_h - float(self.rest_height)) * self._anim_progress

        self.recalculate_geometry()
        self.update()

        if t >= 1.0:
            self._anim_progress = self._anim_target_progress
            self.anim_timer.stop()
            self.update()

    def expand_notch(self):
        self.is_expanded = True
        self.leave_timer.stop()
        self._anim_start_progress = self._anim_progress
        self._anim_target_progress = 1.0
        self._anim_duration_sec = max(0.08, self.expand_duration / 1000.0)
        self._anim_start_time = time.perf_counter()
        self.anim_timer.start()

    def collapse_notch(self):
        self.is_expanded = False
        self.hovered_btn_idx = -1
        self._anim_start_progress = self._anim_progress
        self._anim_target_progress = 0.0
        self._anim_duration_sec = max(0.08, self.collapse_duration / 1000.0)
        self._anim_start_time = time.perf_counter()
        self.anim_timer.start()

    def toggle_pin(self):
        self.pinned = not self.pinned
        if self.pinned:
            self.expand_notch()
        else:
            self.collapse_notch()

    def enterEvent(self, event):
        self.leave_timer.stop()
        if not self.is_expanded:
            self.expand_notch()
        super().enterEvent(event)

    def leaveEvent(self, event):
        if not self.pinned:
            grace = max(140, min(320, int(self.collapse_duration * 0.6)))
            self.leave_timer.start(grace)
        super().leaveEvent(event)

    def check_and_collapse(self):
        cursor_global = QCursor.pos()
        cursor_local = self.mapFromGlobal(cursor_global)
        if not self.rect().contains(cursor_local) and not self.pinned:
            self.collapse_notch()

    # -----------------------------------------------------
    # Geometry & Multi-Monitor Topmost Centering
    # -----------------------------------------------------
    def recalculate_geometry(self):
        screen = QApplication.primaryScreen()
        if not screen:
            return
        screen_geom = screen.geometry()

        # Enforce exact integer pixel symmetry
        w = int(round(self._current_width / 2.0)) * 2
        h = int(round(self._current_height))
        x = ((screen_geom.width() - w) // 2) + self.offset_x
        y = 6 if self.mode == "floating" else 0

        self.setGeometry(x, y, w, h)

    def enforce_topmost(self):
        try:
            hwnd = int(self.winId())
            ctypes.windll.user32.SetWindowPos(
                hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
            )
        except Exception:
            pass

    # -----------------------------------------------------
    # Mouse Interactivity for Quick Buttons
    # -----------------------------------------------------
    def get_button_rects(self):
        """Returns list of QRectF for interactive buttons when expanded."""
        w = float(self.width())
        h = float(self.height())
        p = self._anim_progress
        if p < 0.65:
            return []

        if not self.has_active_activity():
            # 4 Quick Buttons in idle expanded mode: Launch, Drop, System, Settings
            btn_w = 78.0
            btn_h = 24.0
            spacing = 8.0
            total_w = (4 * btn_w) + (3 * spacing)
            start_x = (w - total_w) / 2.0
            y = h - btn_h - 10.0

            rects = []
            for i in range(4):
                rects.append(QRectF(start_x + i * (btn_w + spacing), y, btn_w, btn_h))
            return rects
        else:
            # Action button on right of active activity card
            btn_w = 76.0
            btn_h = 26.0
            btn_x = w - btn_w - 16.0
            btn_y = (h - btn_h) / 2.0
            return [QRectF(btn_x, btn_y, btn_w, btn_h)]

    def mouseMoveEvent(self, event):
        if self.drag_position and (event.buttons() & Qt.MouseButton.LeftButton):
            screen = QApplication.primaryScreen()
            if screen:
                screen_w = screen.geometry().width()
                new_x = event.globalPosition().toPoint().x() - self.drag_position.x()
                w = int(round(self._current_width / 2.0)) * 2
                self.offset_x = new_x - ((screen_w - w) // 2)
                self.recalculate_geometry()
                self.config_data["offset_x"] = self.offset_x
                save_config(self.config_data)
            event.accept()
            return

        # Check button hover
        pos = event.position()
        rects = self.get_button_rects()
        found_idx = -1
        for idx, r in enumerate(rects):
            if r.contains(pos):
                found_idx = idx
                break

        if found_idx != self.hovered_btn_idx:
            self.hovered_btn_idx = found_idx
            if found_idx >= 0:
                self.setCursor(Qt.CursorShape.PointingHandCursor)
            else:
                self.setCursor(Qt.CursorShape.ArrowCursor)
            self.update()

        super().mouseMoveEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            if event.modifiers() & (Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.ControlModifier):
                self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                event.accept()
                return

            # Check button click
            pos = event.position()
            rects = self.get_button_rects()
            for idx, r in enumerate(rects):
                if r.contains(pos):
                    self.handle_button_click(idx)
                    event.accept()
                    return

            # Clicking the pill while expanded pins/toggles
            if not self.is_expanded:
                self.expand_notch()
            event.accept()
        elif event.button() == Qt.MouseButton.MiddleButton:
            self.reset_center()
            event.accept()
        else:
            super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        self.drag_position = None
        super().mouseReleaseEvent(event)

    def handle_button_click(self, idx: int):
        if not self.has_active_activity():
            if idx == 0:
                self.open_oneshot()
            elif idx == 1:
                self.open_dropzone()
            elif idx == 2:
                self.open_taskmgr()
            elif idx == 3:
                self.open_complete_settings()
        else:
            # Active activity action
            if self.update_state in ["available", "ready"]:
                if self.update_state == "ready":
                    apply_update_and_restart(self.verified_installer_path, is_silent=True)
                    QApplication.quit()
                else:
                    self.start_update_download()
            elif self.activity_engine.current_primary and self.activity_engine.current_primary.category == "music":
                self.music_manager.toggle_play_pause()
                self.update()
            else:
                self.open_activities()

    # -----------------------------------------------------
    # Windows Opener Actions (Spacious & Clean)
    # -----------------------------------------------------
    def open_oneshot(self):
        if not self._win_oneshot or not self._win_oneshot.isVisible():
            self._win_oneshot = OneShotWindow(self.preset_manager, self.launch_engine, self.discovery_engine, self)
            self._win_oneshot.show()
        else:
            self._win_oneshot.raise_()
            self._win_oneshot.activateWindow()

    def open_dropzone(self):
        if not self._win_dropzone or not self._win_dropzone.isVisible():
            self._win_dropzone = DropZoneWindow(self)
            self._win_dropzone.show()
        else:
            self._win_dropzone.raise_()
            self._win_dropzone.activateWindow()

    def open_taskmgr(self):
        if not self._win_taskmgr or not self._win_taskmgr.isVisible():
            self._win_taskmgr = TaskManagerWindow(self)
            self._win_taskmgr.show()
        else:
            self._win_taskmgr.raise_()
            self._win_taskmgr.activateWindow()

    def open_activities(self):
        if not self._win_activities or not self._win_activities.isVisible():
            self._win_activities = ActivitiesWindow(self.ai_manager, self.download_monitor, self.focus_timer, self)
            self._win_activities.show()
        else:
            self._win_activities.raise_()
            self._win_activities.activateWindow()

    def open_complete_settings(self):
        if not self._win_settings or not self._win_settings.isVisible():
            self._win_settings = CompleteSettingsWindow(self)
            self._win_settings.show()
        else:
            self._win_settings.raise_()
            self._win_settings.activateWindow()

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

        # Fast Window Launchers
        act_oneshot = menu.addAction("⚡ One-Shot Launcher...")
        act_oneshot.triggered.connect(self.open_oneshot)

        act_drop = menu.addAction("📁 Drop Zone Shelf...")
        act_drop.triggered.connect(self.open_dropzone)

        act_task = menu.addAction("📊 System Task Manager...")
        act_task.triggered.connect(self.open_taskmgr)

        act_act = menu.addAction("✦ AI Coding Agents & Activities...")
        act_act.triggered.connect(self.open_activities)

        menu.addSeparator()

        # Updates Submenu
        up_menu = menu.addMenu("🔄 Updates & GitHub")
        up_menu.setStyleSheet(menu.styleSheet())
        up_menu.addAction("Check for Updates Now...", lambda: self.start_check_thread(is_manual=True))
        up_menu.addAction("View Release History...", lambda: ReleaseHistoryDialog(self).exec())
        up_menu.addAction("View Update Diagnostics...", lambda: UpdateLogsDialog(self).exec())

        # Speed Presets
        sp_menu = menu.addMenu(f"⚡ Animation Speed ({self.speed_preset.title()})")
        sp_menu.setStyleSheet(menu.styleSheet())
        for k, p_data in SPEED_PRESETS.items():
            act = sp_menu.addAction(p_data["name"])
            act.setCheckable(True)
            act.setChecked(self.speed_preset == k)
            act.triggered.connect(lambda _, key=k: self.set_preset_speed(key))
        sp_menu.addSeparator()
        sp_menu.addAction("🎛️ Custom Speed Slider...", lambda: SpeedSliderDialog(self, self.expand_duration).exec())

        menu.addSeparator()

        act_fmt = menu.addAction("Format: 24-Hour" if not self.is_24h else "Format: 12-Hour (AM/PM)")
        act_fmt.triggered.connect(self.toggle_time_format)

        act_mode = menu.addAction("Style: Flush Notch (Bezel)" if self.mode == "floating" else "Style: Floating Island")
        act_mode.triggered.connect(self.toggle_style_mode)

        act_pin = menu.addAction("Unpin Notch" if self.pinned else "Pin / Keep Expanded")
        act_pin.triggered.connect(self.toggle_pin)

        act_center = menu.addAction("Recenter Notch")
        act_center.triggered.connect(self.reset_center)

        act_settings = menu.addAction("⚙️ Settings & Preferences...")
        act_settings.triggered.connect(self.open_complete_settings)

        menu.addSeparator()
        act_quit = menu.addAction("Exit Dynamic Windows")
        act_quit.triggered.connect(QApplication.quit)

        menu.exec(self.mapToGlobal(event.pos()))

    def set_preset_speed(self, key):
        if key in SPEED_PRESETS:
            self.speed_preset = key
            self.expand_duration = SPEED_PRESETS[key]["expand"]
            self.collapse_duration = SPEED_PRESETS[key]["collapse"]
            self.config_data["speed_preset"] = key
            self.config_data["expand_duration"] = self.expand_duration
            self.config_data["collapse_duration"] = self.collapse_duration
            save_config(self.config_data)

    def set_custom_speed(self, expand_ms):
        self.speed_preset = "custom"
        self.expand_duration = int(expand_ms)
        self.collapse_duration = int(expand_ms * 0.78)
        self.config_data["speed_preset"] = "custom"
        self.config_data["expand_duration"] = self.expand_duration
        self.config_data["collapse_duration"] = self.collapse_duration
        save_config(self.config_data)

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

    def setup_tray(self):
        self.tray = QSystemTrayIcon(self)
        tray_menu = QMenu()
        tray_menu.setStyleSheet("""
            QMenu { background-color: #121215; color: #e4e4e7; border: 1px solid #27272a; padding: 4px; }
            QMenu::item { padding: 6px 16px; }
            QMenu::item:selected { background-color: #27272a; }
        """)

        tray_menu.addAction("⚡ One-Shot Launcher...", self.open_oneshot)
        tray_menu.addAction("📁 Drop Zone Shelf...", self.open_dropzone)
        tray_menu.addAction("📊 Task Manager...", self.open_taskmgr)
        tray_menu.addAction("⚙️ Settings & Preferences...", self.open_complete_settings)
        tray_menu.addAction("Check for Updates...", lambda: self.start_check_thread(is_manual=True))
        tray_menu.addAction("Recenter Notch", self.reset_center)
        tray_menu.addSeparator()
        tray_menu.addAction("Exit", QApplication.quit)

        self.tray.setContextMenu(tray_menu)
        self.tray.setToolTip(f"Dynamic Windows + One-Shot (v{CURRENT_VERSION})")
        if self.app_icon_pixmap and not self.app_icon_pixmap.isNull():
            self.tray.setIcon(QIcon(self.app_icon_pixmap))
        self.tray.show()

    # =====================================================
    # PAINT EVENT: 144Hz Butter-Smooth Dynamic Island
    # =====================================================
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        w = float(self.width())
        h = float(self.height())
        p = max(0.0, min(1.0, self._anim_progress))

        # Dynamic Apple Capsule Geometry
        path = QPainterPath()
        if self.mode == "floating":
            radius = 15.0 + 9.0 * p
            path.addRoundedRect(QRectF(0, 0, w, h), radius, radius)
        else:
            radius = 15.0 + 7.0 * p
            path.moveTo(0, 0)
            path.lineTo(w, 0)
            path.lineTo(w, h - radius)
            path.quadTo(w, h, w - radius, h)
            path.lineTo(radius, h)
            path.quadTo(0, h, 0, h - radius)
            path.closeSubpath()

        # 1. Outer Soft Glow / Ambient Shadow
        glow_alpha = int(110 + 45 * p)
        painter.fillPath(path, QColor(0, 0, 0, glow_alpha))

        # 2. Main OLED Surface: Deep Liquid Black
        surface_grad = QLinearGradient(0, 0, 0, h)
        surface_grad.setColorAt(0.0, QColor(16, 16, 20, 255))
        surface_grad.setColorAt(0.5, QColor(8, 8, 10, 255))
        surface_grad.setColorAt(1.0, QColor(2, 2, 4, 255))
        painter.fillPath(path, QBrush(surface_grad))

        # 3. Specular Border Rim: Apple-style Glass Edge
        border_pen = QPen()
        border_alpha = int(32 + 28 * p)
        border_pen.setColor(QColor(255, 255, 255, border_alpha))
        border_pen.setWidthF(1.0)
        painter.strokePath(path, border_pen)

        now = datetime.now()
        time_str = now.strftime("%H:%M") if self.is_24h else now.strftime("%I:%M %p").lstrip("0")
        time_with_sec = now.strftime("%H:%M:%S") if self.is_24h else now.strftime("%I:%M:%S %p").lstrip("0")

        has_active = self.has_active_activity()
        primary_act = self.activity_engine.current_primary

        # -------------------------------------------------
        # A. RESTING STANDBY PILL (p < 0.30)
        # -------------------------------------------------
        if p < 0.30:
            alpha_standby = int(max(0.0, min(1.0, (0.30 - p) / 0.30)) * 240)
            font_standby = QFont("Segoe UI Variable Display", 10, QFont.Weight.Medium)
            painter.setFont(font_standby)
            painter.setPen(QColor(235, 235, 245, alpha_standby))

            if not has_active:
                # Minimalist, perfectly centered clock
                painter.drawText(QRectF(0, 0, w, h), Qt.AlignmentFlag.AlignCenter, time_str)
            else:
                # Time on Left
                painter.drawText(QRectF(14, 0, 72, h), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft, time_str)

                # Active Activity Badge on Right
                badge_w = 98.0
                badge_h = 18.0
                badge_x = w - badge_w - 10.0
                badge_y = (h - badge_h) / 2.0

                badge_path = QPainterPath()
                badge_path.addRoundedRect(QRectF(badge_x, badge_y, badge_w, badge_h), 9, 9)
                painter.fillPath(badge_path, QColor(30, 41, 59, int(alpha_standby * 0.8)))
                painter.strokePath(badge_path, QPen(QColor(59, 130, 246, int(alpha_standby * 0.6)), 1))

                # If Antigravity: draw official logo
                is_ag = primary_act and primary_act.icon_type == "antigravity"
                if is_ag and self.antigravity_logo and not self.antigravity_logo.isNull():
                    scaled_logo = self.antigravity_logo.scaled(13, 13, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
                    painter.drawPixmap(int(badge_x + 6), int(badge_y + 2), scaled_logo)
                    text_x = badge_x + 22.0
                    text_w = badge_w - 24.0
                else:
                    text_x = badge_x
                    text_w = badge_w

                badge_font = QFont("Segoe UI Variable Text", 8, QFont.Weight.DemiBold)
                painter.setFont(badge_font)
                painter.setPen(QColor(224, 242, 254, alpha_standby))
                badge_lbl = primary_act.badge if primary_act else f"v{CURRENT_VERSION}"
                painter.drawText(QRectF(text_x, badge_y, text_w, badge_h), Qt.AlignmentFlag.AlignCenter, badge_lbl)

        # -------------------------------------------------
        # B. EXPANDED VIEW: REVEAL CONTENT (p > 0.40)
        # -------------------------------------------------
        if p > 0.40:
            alpha_exp = int(max(0.0, min(1.0, (p - 0.40) / 0.60)) * 255)

            if not has_active:
                # -------------------------------------------------
                # 1. IDLE EXPANDED ISLAND (Pure, Apple Aesthetics)
                # -------------------------------------------------
                # Large, crisp digital clock
                font_clock = QFont("Segoe UI Variable Display", 18, QFont.Weight.DemiBold)
                painter.setFont(font_clock)
                painter.setPen(QColor(255, 255, 255, alpha_exp))
                clock_rect = QRectF(0, 10, w, 28)
                display_time = time_with_sec if self.show_seconds else time_str
                painter.drawText(clock_rect, Qt.AlignmentFlag.AlignCenter, display_time)

                # Fine hairline divider
                div_pen = QPen(QColor(255, 255, 255, int(alpha_exp * 0.12)), 1)
                painter.setPen(div_pen)
                div_y = 41.0
                painter.drawLine(QPoint(int(w * 0.18), int(div_y)), QPoint(int(w * 0.82), int(div_y)))

                # Formatted Date
                font_date = QFont("Segoe UI Variable Text", 9, QFont.Weight.Normal)
                painter.setFont(font_date)
                painter.setPen(QColor(161, 161, 170, int(alpha_exp * 0.88)))
                date_str = now.strftime("%A, %B %d, %Y")
                painter.drawText(QRectF(0, 44, w, 18), Qt.AlignmentFlag.AlignCenter, date_str)

                # 4 Quick Buttons along the bottom
                btn_rects = self.get_button_rects()
                labels = ["⚡ Launch", "📁 Drop", "📊 System", "⚙️ Settings"]
                for i, r in enumerate(btn_rects):
                    is_hov = (i == self.hovered_btn_idx)
                    b_path = QPainterPath()
                    b_path.addRoundedRect(r, 6, 6)

                    # Background
                    bg_color = QColor(37, 99, 235, int(alpha_exp * 0.8)) if is_hov else QColor(28, 28, 35, int(alpha_exp * 0.9))
                    border_color = QColor(96, 165, 250, alpha_exp) if is_hov else QColor(45, 45, 55, int(alpha_exp * 0.8))

                    painter.fillPath(b_path, bg_color)
                    painter.strokePath(b_path, QPen(border_color, 1))

                    font_btn = QFont("Segoe UI", 8, QFont.Weight.DemiBold)
                    painter.setFont(font_btn)
                    painter.setPen(QColor(255, 255, 255, alpha_exp if is_hov else int(alpha_exp * 0.8)))
                    painter.drawText(r, Qt.AlignmentFlag.AlignCenter, labels[i])

            else:
                # -------------------------------------------------
                # 2. ACTIVE LIVE ACTIVITY ISLAND (e.g. Antigravity)
                # -------------------------------------------------
                is_ag = primary_act and primary_act.icon_type == "antigravity"

                # Left Bezel: Icon Badge
                icon_rect = QRectF(18, (h - 48) / 2, 48, 48)
                icon_path = QPainterPath()
                icon_path.addRoundedRect(icon_rect, 12, 12)
                painter.fillPath(icon_path, QColor(15, 23, 42, alpha_exp))
                painter.strokePath(icon_path, QPen(QColor(59, 130, 246, int(alpha_exp * 0.5)), 1))

                if is_ag and self.antigravity_logo and not self.antigravity_logo.isNull():
                    scaled_logo = self.antigravity_logo.scaled(32, 32, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
                    painter.drawPixmap(int(icon_rect.x() + 8), int(icon_rect.y() + 8), scaled_logo)
                elif primary_act and primary_act.category == "music":
                    painter.setFont(QFont("Segoe UI Emoji", 18))
                    painter.setPen(QColor(255, 255, 255, alpha_exp))
                    painter.drawText(icon_rect, Qt.AlignmentFlag.AlignCenter, "🎵")
                else:
                    painter.setFont(QFont("Segoe UI Emoji", 18))
                    painter.setPen(QColor(255, 255, 255, alpha_exp))
                    painter.drawText(icon_rect, Qt.AlignmentFlag.AlignCenter, "✦")

                # Center Text Block
                title_text = primary_act.title if primary_act else f"Dynamic Windows v{CURRENT_VERSION}"
                sub_text = primary_act.subtitle if primary_act else "Update ready to install"

                font_title = QFont("Segoe UI Variable Display", 11, QFont.Weight.DemiBold)
                painter.setFont(font_title)
                painter.setPen(QColor(255, 255, 255, alpha_exp))
                painter.drawText(QRectF(76, 20, w - 180, 20), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, title_text)

                font_sub = QFont("Segoe UI Variable Text", 9, QFont.Weight.Normal)
                painter.setFont(font_sub)
                painter.setPen(QColor(148, 163, 184, alpha_exp))
                painter.drawText(QRectF(76, 42, w - 180, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, sub_text)

                # Progress Bar (if available or indeterminate)
                bar_rect = QRectF(76, 68, w - 180, 4)
                bar_bg = QPainterPath()
                bar_bg.addRoundedRect(bar_rect, 2, 2)
                painter.fillPath(bar_bg, QColor(30, 41, 59, alpha_exp))

                prog_val = primary_act.progress if (primary_act and primary_act.progress is not None) else None
                if prog_val is not None:
                    fill_w = max(4.0, (w - 180) * max(0.0, min(1.0, prog_val)))
                    prog_rect = QRectF(76, 68, fill_w, 4)
                    bar_fill = QPainterPath()
                    bar_fill.addRoundedRect(prog_rect, 2, 2)
                    painter.fillPath(bar_fill, QColor(56, 189, 248, alpha_exp))

                # Right Action Button
                btn_rects = self.get_button_rects()
                if btn_rects:
                    r = btn_rects[0]
                    is_hov = (self.hovered_btn_idx == 0)
                    b_path = QPainterPath()
                    b_path.addRoundedRect(r, 6, 6)

                    action_label = "Activity"
                    if self.update_state == "ready":
                        action_label = "Restart"
                    elif self.update_state == "available":
                        action_label = "Update"
                    elif primary_act and primary_act.category == "music":
                        action_label = "Pause" if self.music_manager.is_playing else "Play"

                    bg_color = QColor(37, 99, 235, alpha_exp) if is_hov else QColor(30, 41, 59, alpha_exp)
                    border_color = QColor(96, 165, 250, alpha_exp) if is_hov else QColor(59, 130, 246, int(alpha_exp * 0.7))

                    painter.fillPath(b_path, bg_color)
                    painter.strokePath(b_path, QPen(border_color, 1))

                    painter.setFont(QFont("Segoe UI", 8, QFont.Weight.DemiBold))
                    painter.setPen(QColor(255, 255, 255, alpha_exp))
                    painter.drawText(r, Qt.AlignmentFlag.AlignCenter, action_label)


def main():
    if hasattr(Qt.ApplicationAttribute, 'AA_EnableHighDpiScaling'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    if hasattr(Qt.ApplicationAttribute, 'AA_UseHighDpiPixmaps'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    # Check for startup takeover mode
    if "--startup-mode" in sys.argv or "--takeover" in sys.argv:
        preset_mgr = PresetManager()
        launch_engine = AppLaunchEngine()
        takeover = StartupTakeoverWindow(preset_mgr, launch_engine)
        takeover.showFullScreen()
        sys.exit(app.exec())

    notch = DynamicNotch()
    notch.show()
    notch.enforce_topmost()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
