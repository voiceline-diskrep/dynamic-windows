import sys
import os
import json
import ctypes
import subprocess
from datetime import datetime

from PyQt6.QtCore import (
    Qt, QTimer, QPropertyAnimation, QEasingCurve, pyqtProperty, QPoint, QPointF, QRect, QRectF,
    QThread, pyqtSignal
)
from PyQt6.QtGui import (
    QColor, QPainter, QPainterPath, QFont, QPen, QBrush, QLinearGradient,
    QAction, QIcon, QCursor, QFontMetricsF
)
from PyQt6.QtWidgets import (
    QApplication, QWidget, QMenu, QSystemTrayIcon, QDialog, QVBoxLayout,
    QHBoxLayout, QLabel, QSlider, QPushButton, QInputDialog, QMessageBox
)

# Windows native constants
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040

# Windows subprocess flag: completely prevents console/cmd window flash
CREATE_NO_WINDOW = 0x08000000

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
APP_DIR = os.path.dirname(os.path.abspath(__file__))

SPEED_PRESETS = {
    "very_fast": {"name": "⚡ Very Fast (120ms)", "expand": 120, "collapse": 90},
    "fast":      {"name": "🚀 Fast (180ms)",      "expand": 180, "collapse": 140},
    "normal":    {"name": "✨ Normal (280ms)",    "expand": 280, "collapse": 220},
    "slow":      {"name": "🐢 Slow (550ms)",      "expand": 550, "collapse": 420},
    "very_slow": {"name": "🎬 Cinematic (900ms)", "expand": 900, "collapse": 720},
}


class UpdateCheckerThread(QThread):
    """Background worker that queries GitHub quietly with zero CMD flashing."""
    status_signal = pyqtSignal(str, str)  # status_code, message

    def __init__(self, repo_dir):
        super().__init__()
        self.repo_dir = repo_dir

    def run(self):
        try:
            # 1. Check if git remote origin is configured
            res = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=self.repo_dir, capture_output=True, text=True, timeout=3,
                creationflags=CREATE_NO_WINDOW
            )
            remote_url = res.stdout.strip()
            if res.returncode != 0 or not remote_url:
                self.status_signal.emit("no_remote", "GitHub remote repository is not configured.")
                return

            # 2. Get local HEAD commit hash
            head_res = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=self.repo_dir, capture_output=True, text=True, timeout=2,
                creationflags=CREATE_NO_WINDOW
            )
            local_hash = head_res.stdout.strip()

            # 3. Query remote for HEAD of main / master
            ls_res = subprocess.run(
                ["git", "ls-remote", remote_url, "refs/heads/main", "refs/heads/master"],
                cwd=self.repo_dir, capture_output=True, text=True, timeout=6,
                creationflags=CREATE_NO_WINDOW
            )
            if ls_res.returncode != 0 or not ls_res.stdout.strip():
                self.status_signal.emit("error", "Unable to connect to GitHub. Please check your internet.")
                return

            lines = ls_res.stdout.strip().splitlines()
            remote_hash = lines[0].split()[0] if lines else ""

            if remote_hash == local_hash:
                self.status_signal.emit("up_to_date", "You are running the latest version! (Up to date)")
            else:
                self.status_signal.emit("update_available", "A new update is available on GitHub!")
        except subprocess.TimeoutExpired:
            self.status_signal.emit("error", "Update check timed out. GitHub may be slow.")
        except Exception as e:
            self.status_signal.emit("error", f"Error checking updates: {str(e)[:35]}")


class GitPullThread(QThread):
    """Background worker to pull updates from GitHub with zero CMD flashing."""
    finished_signal = pyqtSignal(bool, str)

    def __init__(self, repo_dir):
        super().__init__()
        self.repo_dir = repo_dir

    def run(self):
        try:
            res = subprocess.run(
                ["git", "pull", "origin", "main"],
                cwd=self.repo_dir, capture_output=True, text=True, timeout=20,
                creationflags=CREATE_NO_WINDOW
            )
            if res.returncode == 0:
                self.finished_signal.emit(True, "Successfully updated from GitHub!\nPlease restart the app to apply.")
            else:
                res_master = subprocess.run(
                    ["git", "pull", "origin", "master"],
                    cwd=self.repo_dir, capture_output=True, text=True, timeout=20,
                    creationflags=CREATE_NO_WINDOW
                )
                if res_master.returncode == 0:
                    self.finished_signal.emit(True, "Successfully updated from GitHub!\nPlease restart the app to apply.")
                else:
                    self.finished_signal.emit(False, f"Update failed: {res.stderr.strip()[:40]}")
        except Exception as e:
            self.finished_signal.emit(False, str(e)[:40])


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
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
            QLabel {
                color: #e4e4e7;
                font-size: 13px;
            }
            QSlider::groove:horizontal {
                height: 6px;
                background: #27272a;
                border-radius: 3px;
            }
            QSlider::sub-page:horizontal {
                background: #3b82f6;
                border-radius: 3px;
            }
            QSlider::handle:horizontal {
                background: #ffffff;
                border: 2px solid #3b82f6;
                width: 16px;
                margin-top: -5px;
                margin-bottom: -5px;
                border-radius: 8px;
            }
            QPushButton {
                background-color: #1f1f24;
                color: #f4f4f5;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
                font-size: 12px;
            }
            QPushButton:hover {
                background-color: #27272a;
                border-color: #52525b;
            }
            QPushButton:pressed {
                background-color: #09090b;
            }
            QPushButton#primaryBtn {
                background-color: #2563eb;
                border-color: #3b82f6;
                color: white;
            }
            QPushButton#primaryBtn:hover {
                background-color: #1d4ed8;
            }
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
        
        # 1. Window Flags: Always on top, frameless, tool, doesn't steal focus
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

        # 2. Defaults & Config
        self.mode = "floating"          # "floating" or "anchored"
        self.is_24h = False              # 12h or 24h
        self.show_seconds = True         # Extends to show seconds on hover
        self.pinned = False
        self.speed_preset = "normal"
        self.expand_duration = 280
        self.collapse_duration = 220
        self.offset_x = 0

        # Resting dimensions (compact standby mode without seconds)
        self.rest_width = 136
        self.rest_height = 29
        
        # Expanded dimensions (clean time & date display)
        self.exp_width = 360
        self.exp_height = 88
        
        # Load persisted settings
        self.load_config()

        # Current animated state (0.0 = standby, 1.0 = fully open)
        self._anim_progress = 0.0
        self._current_width = float(self.rest_width)
        self._current_height = float(self.rest_height)
        self.is_expanded = False

        self.checker_thread = None
        self.pull_thread = None

        # Dragging state
        self.drag_position = None

        # Initial geometry positioning
        self.recalculate_geometry()

        # 3. Animation Engine
        self.anim = QPropertyAnimation(self, b"progress")
        self.anim.setDuration(self.expand_duration)
        self.anim.setEasingCurve(QEasingCurve.Type.OutBack)

        # 4. Timer for Clock updates
        self.clock_timer = QTimer(self)
        self.clock_timer.timeout.connect(self.update)
        self.clock_timer.start(250)

        # 5. Timer for Mouse Leave grace period
        self.leave_timer = QTimer(self)
        self.leave_timer.setSingleShot(True)
        self.leave_timer.timeout.connect(self.check_and_collapse)

        # 6. Periodic enforcement of HWND_TOPMOST
        self.topmost_timer = QTimer(self)
        self.topmost_timer.timeout.connect(self.enforce_topmost)
        self.topmost_timer.start(2000)

        # 7. System Tray Setup
        self.setup_tray()

    # Qt Property for animation
    def get_progress(self):
        return self._anim_progress

    def set_progress(self, val):
        self._anim_progress = val
        self._current_width = self.rest_width + (self.exp_width - self.rest_width) * val
        self._current_height = self.rest_height + (self.exp_height - self.rest_height) * val
        self.recalculate_geometry()
        self.update()

    progress = pyqtProperty(float, get_progress, set_progress)

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.mode = data.get("mode", self.mode)
                    self.is_24h = data.get("is_24h", self.is_24h)
                    self.show_seconds = data.get("show_seconds", self.show_seconds)
                    self.speed_preset = data.get("speed_preset", self.speed_preset)
                    self.expand_duration = data.get("expand_duration", self.expand_duration)
                    self.collapse_duration = data.get("collapse_duration", self.collapse_duration)
                    self.offset_x = data.get("offset_x", self.offset_x)
            except Exception:
                pass

    def save_config(self):
        try:
            data = {
                "mode": self.mode,
                "is_24h": self.is_24h,
                "show_seconds": self.show_seconds,
                "speed_preset": self.speed_preset,
                "expand_duration": self.expand_duration,
                "collapse_duration": self.collapse_duration,
                "offset_x": self.offset_x
            }
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception:
            pass

    def set_preset_speed(self, key):
        if key in SPEED_PRESETS:
            self.speed_preset = key
            self.expand_duration = SPEED_PRESETS[key]["expand"]
            self.collapse_duration = SPEED_PRESETS[key]["collapse"]
            self.save_config()

    def set_custom_speed(self, expand_ms):
        self.speed_preset = "custom"
        self.expand_duration = int(expand_ms)
        self.collapse_duration = int(expand_ms * 0.78)
        self.save_config()

    def enforce_topmost(self):
        try:
            hwnd = int(self.winId())
            ctypes.windll.user32.SetWindowPos(
                hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
            )
        except Exception:
            pass

    def recalculate_geometry(self):
        screen = QApplication.primaryScreen()
        if not screen:
            return
        screen_geom = screen.geometry()
        
        # Enforce even pixel width so screen centering has exact integer symmetry without 0.5px jitter
        w = int(round(self._current_width / 2.0)) * 2
        h = int(round(self._current_height))
        
        x = ((screen_geom.width() - w) // 2) + self.offset_x
        y = 6 if self.mode == "floating" else 0
        
        self.setGeometry(x, y, w, h)

    def enterEvent(self, event):
        self.leave_timer.stop()
        if not self.is_expanded:
            self.expand_notch()
        super().enterEvent(event)

    def leaveEvent(self, event):
        if not self.pinned:
            grace = max(100, min(240, int(self.collapse_duration * 0.5)))
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
        self.anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.anim.setDuration(self.expand_duration)
        self.anim.start()

    def collapse_notch(self):
        self.is_expanded = False
        self.anim.stop()
        self.anim.setStartValue(self._anim_progress)
        self.anim.setEndValue(0.0)
        self.anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.anim.setDuration(self.collapse_duration)
        self.anim.start()

    # Dragging & Context Menu support
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            if event.modifiers() & (Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.ControlModifier):
                self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                event.accept()
            else:
                super().mousePressEvent(event)
        elif event.button() == Qt.MouseButton.MiddleButton:
            self.reset_center()
            event.accept()
        else:
            super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self.drag_position and (event.buttons() & Qt.MouseButton.LeftButton):
            screen = QApplication.primaryScreen()
            if screen:
                screen_w = screen.geometry().width()
                new_x = event.globalPosition().toPoint().x() - self.drag_position.x()
                w = int(round(self._current_width / 2.0)) * 2
                self.offset_x = new_x - ((screen_w - w) // 2)
                self.recalculate_geometry()
                self.save_config()
            event.accept()
        else:
            super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        self.drag_position = None
        super().mouseReleaseEvent(event)

    def contextMenuEvent(self, event):
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 6px;
                font-family: 'Segoe UI', sans-serif;
                font-size: 13px;
            }
            QMenu::item {
                padding: 6px 20px;
                border-radius: 4px;
            }
            QMenu::item:selected {
                background-color: #27272a;
                color: #ffffff;
            }
            QMenu::separator {
                height: 1px;
                background-color: #27272a;
                margin: 4px 8px;
            }
        """)

        # 1. Updates Submenu
        update_menu = menu.addMenu("🔄 Updates & GitHub")
        update_menu.setStyleSheet(menu.styleSheet())

        act_check = update_menu.addAction("Check for Updates Now...")
        act_check.triggered.connect(self.menu_check_updates)

        act_pull = update_menu.addAction("Pull Updates from GitHub")
        act_pull.triggered.connect(self.menu_pull_updates)

        act_remote = update_menu.addAction("Set GitHub Repository URL...")
        act_remote.triggered.connect(self.prompt_set_remote)

        menu.addSeparator()

        # 2. Animation Speed Submenu
        speed_menu = menu.addMenu(f"⚡ Animation Speed ({self.speed_preset.replace('_', ' ').title()})")
        speed_menu.setStyleSheet(menu.styleSheet())

        for key, p_data in SPEED_PRESETS.items():
            act = speed_menu.addAction(p_data["name"])
            act.setCheckable(True)
            act.setChecked(self.speed_preset == key)
            act.triggered.connect(lambda checked, k=key: self.set_preset_speed(k))

        speed_menu.addSeparator()
        act_custom = speed_menu.addAction("🎛️ Custom Speed Slider...")
        act_custom.triggered.connect(self.open_speed_dialog)

        menu.addSeparator()

        # Format 12h/24h
        act_format = menu.addAction("Format: 24-Hour" if not self.is_24h else "Format: 12-Hour (AM/PM)")
        act_format.triggered.connect(self.toggle_time_format)

        # Seconds toggle on open
        act_sec = menu.addAction("Disable Seconds on Open" if self.show_seconds else "Enable Seconds on Open")
        act_sec.triggered.connect(self.toggle_seconds)

        # Style mode
        act_mode = menu.addAction("Style: Flush Notch (Bezel)" if self.mode == "floating" else "Style: Floating Island")
        act_mode.triggered.connect(self.toggle_style_mode)

        # Pin / Keep Open
        act_pin = menu.addAction("Unpin Notch" if self.pinned else "Pin / Keep Expanded")
        act_pin.triggered.connect(self.toggle_pin)

        # Recenter
        act_recenter = menu.addAction("Recenter Notch")
        act_recenter.triggered.connect(self.reset_center)

        menu.addSeparator()
        act_quit = menu.addAction("Exit Dynamic Notch")
        act_quit.triggered.connect(QApplication.quit)

        menu.exec(self.mapToGlobal(event.pos()))

    def menu_check_updates(self):
        """Clean update check triggered manually from right-click menu."""
        if self.checker_thread and self.checker_thread.isRunning():
            return
        self.checker_thread = UpdateCheckerThread(APP_DIR)
        self.checker_thread.status_signal.connect(self.on_menu_update_result)
        self.checker_thread.start()

    def on_menu_update_result(self, status, message):
        msg_box = QMessageBox(self)
        msg_box.setWindowFlags(msg_box.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        msg_box.setStyleSheet("""
            QMessageBox {
                background-color: #121215;
                color: #e4e4e7;
                font-family: 'Segoe UI', sans-serif;
            }
            QLabel {
                color: #e4e4e7;
                font-size: 13px;
            }
            QPushButton {
                background-color: #27272a;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
            }
            QPushButton:hover {
                background-color: #3b82f6;
            }
        """)
        msg_box.setWindowTitle("Dynamic Windows Update")
        
        if status == "update_available":
            msg_box.setText("✦ A new update is available on GitHub!\n\nWould you like to pull the update now?")
            btn_update = msg_box.addButton("Update Now", QMessageBox.ButtonRole.AcceptRole)
            msg_box.addButton("Later", QMessageBox.ButtonRole.RejectRole)
            msg_box.exec()
            if msg_box.clickedButton() == btn_update:
                self.menu_pull_updates()
        elif status == "up_to_date":
            msg_box.setText("✓ You are up to date!\n\nYour Dynamic Windows is running the latest version.")
            msg_box.addButton("OK", QMessageBox.ButtonRole.AcceptRole)
            msg_box.exec()
        else:
            msg_box.setText(f"{message}")
            msg_box.addButton("OK", QMessageBox.ButtonRole.AcceptRole)
            msg_box.exec()

    def menu_pull_updates(self):
        if self.pull_thread and self.pull_thread.isRunning():
            return
        self.pull_thread = GitPullThread(APP_DIR)
        self.pull_thread.finished_signal.connect(self.on_menu_pull_finished)
        self.pull_thread.start()

    def on_menu_pull_finished(self, success, message):
        msg_box = QMessageBox(self)
        msg_box.setWindowFlags(msg_box.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        msg_box.setStyleSheet("""
            QMessageBox {
                background-color: #121215;
                color: #e4e4e7;
                font-family: 'Segoe UI', sans-serif;
            }
            QLabel {
                color: #e4e4e7;
                font-size: 13px;
            }
            QPushButton {
                background-color: #27272a;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
            }
        """)
        msg_box.setWindowTitle("Update Result")
        msg_box.setText(message)
        msg_box.addButton("OK", QMessageBox.ButtonRole.AcceptRole)
        msg_box.exec()

    def prompt_set_remote(self):
        url, ok = QInputDialog.getText(
            self, "Set GitHub Remote",
            "Enter GitHub Repository URL:\n(e.g. https://github.com/voiceline-diskrep/dynamic-windows.git)"
        )
        if ok and url.strip():
            target_url = url.strip()
            subprocess.run(["git", "remote", "remove", "origin"], cwd=APP_DIR, capture_output=True, creationflags=CREATE_NO_WINDOW)
            res = subprocess.run(["git", "remote", "add", "origin", target_url], cwd=APP_DIR, capture_output=True, creationflags=CREATE_NO_WINDOW)
            if res.returncode == 0:
                self.menu_check_updates()

    def open_speed_dialog(self):
        dlg = SpeedSliderDialog(self, self.expand_duration)
        dlg.exec()

    def toggle_time_format(self):
        self.is_24h = not self.is_24h
        self.save_config()
        self.update()

    def toggle_seconds(self):
        self.show_seconds = not self.show_seconds
        self.save_config()
        self.update()

    def toggle_style_mode(self):
        self.mode = "anchored" if self.mode == "floating" else "floating"
        self.recalculate_geometry()
        self.save_config()
        self.update()

    def toggle_pin(self):
        self.pinned = not self.pinned
        if self.pinned:
            self.expand_notch()
        else:
            self.collapse_notch()

    def reset_center(self):
        self.offset_x = 0
        self.recalculate_geometry()
        self.save_config()

    def setup_tray(self):
        self.tray = QSystemTrayIcon(self)
        tray_menu = QMenu()
        tray_menu.setStyleSheet("""
            QMenu {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 6px;
                padding: 4px;
            }
            QMenu::item {
                padding: 6px 16px;
            }
            QMenu::item:selected {
                background-color: #27272a;
            }
        """)

        check_action = QAction("Check for Updates...", self)
        check_action.triggered.connect(self.menu_check_updates)
        tray_menu.addAction(check_action)

        speed_action = QAction("Animation Speed...", self)
        speed_action.triggered.connect(self.open_speed_dialog)
        tray_menu.addAction(speed_action)

        recenter_action = QAction("Recenter Notch", self)
        recenter_action.triggered.connect(self.reset_center)
        tray_menu.addAction(recenter_action)

        exit_action = QAction("Exit", self)
        exit_action.triggered.connect(QApplication.quit)
        tray_menu.addAction(exit_action)

        self.tray.setContextMenu(tray_menu)
        self.tray.setToolTip("Dynamic Notch (Always on Top)")
        self.tray.show()

    # ==========================================
    # PAINT EVENT: Clean, Silent & Distraction-Free
    # ==========================================
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.TextAntialiasing)

        w = float(self.width())
        h = float(self.height())
        p = max(0.0, min(1.0, self._anim_progress))  # Clamped strictly to [0.0, 1.0]

        # Smooth Corner Radius
        path = QPainterPath()
        if self.mode == "floating":
            radius = (14.0 + 11.0 * p)
            path.addRoundedRect(QRectF(0, 0, w, h), radius, radius)
        else:
            radius = (14.0 + 9.0 * p)
            path.moveTo(0, 0)
            path.lineTo(w, 0)
            path.lineTo(w, h - radius)
            path.quadTo(w, h, w - radius, h)
            path.lineTo(radius, h)
            path.quadTo(0, h, 0, h - radius)
            path.closeSubpath()

        # 1. Outer Drop Shadow / Ambient Glow
        glow_alpha = int(120 + 40 * p)
        painter.fillPath(path, QColor(0, 0, 0, glow_alpha))

        # 2. Main Body Surface: Deep OLED Black
        surface_grad = QLinearGradient(0, 0, 0, h)
        surface_grad.setColorAt(0.0, QColor(16, 16, 20))
        surface_grad.setColorAt(0.5, QColor(8, 8, 10))
        surface_grad.setColorAt(1.0, QColor(2, 2, 4))
        painter.fillPath(path, QBrush(surface_grad))

        # 3. Specular Border / Subtle Glass Rim
        border_pen = QPen()
        border_alpha = int(35 + 25 * p)
        border_pen.setColor(QColor(255, 255, 255, border_alpha))
        border_pen.setWidthF(1.0)
        painter.strokePath(path, border_pen)

        now = datetime.now()

        # Format strings for standby (no seconds) and expanded (with seconds)
        if self.is_24h:
            time_standby = now.strftime("%H:%M")
            time_expanded = now.strftime("%H:%M:%S") if self.show_seconds else now.strftime("%H:%M")
        else:
            time_standby = now.strftime("%I:%M %p").lstrip("0")
            time_expanded = now.strftime("%I:%M:%S %p").lstrip("0") if self.show_seconds else now.strftime("%I:%M %p").lstrip("0")

        # Smooth vertical travel for clock
        y_clock = 9.0 * p
        h_clock = (29.0 * (1.0 - p)) + (36.0 * p)
        clock_rect = QRectF(0, y_clock, w, h_clock)

        # 1. Standby Clock: Only in resting mode; cleanly fades out in early hover (0.0 -> 0.18)
        if p < 0.18:
            alpha_standby = int(max(0.0, min(1.0, (0.18 - p) / 0.18)) * 235)
            font_standby = QFont("Segoe UI Variable Display", 10, QFont.Weight.Medium)
            font_standby.setStyleHint(QFont.StyleHint.SansSerif)
            painter.setFont(font_standby)
            painter.setPen(QColor(235, 235, 245, alpha_standby))
            painter.drawText(clock_rect, Qt.AlignmentFlag.AlignCenter, time_standby)

        # 2. Expanded Clock: Fades in smoothly once the capsule expands (0.35 -> 1.0)
        # Note: Zero overlap with standby clock ensures zero character collisions or flickering!
        if p > 0.35:
            alpha_exp = int(max(0.0, min(1.0, (p - 0.35) / 0.65)) * 255)
            font_exp = QFont("Segoe UI Variable Display", 18, QFont.Weight.DemiBold)
            font_exp.setStyleHint(QFont.StyleHint.SansSerif)
            painter.setFont(font_exp)
            painter.setPen(QColor(255, 255, 255, alpha_exp))
            painter.drawText(clock_rect, Qt.AlignmentFlag.AlignCenter, time_expanded)

        # ==========================================
        # EXPANDED REVEAL: Date Only (Pure & Clean)
        # ==========================================
        if p > 0.45:
            content_factor = (p - 0.45) / 0.55

            # Subtle Divider Line
            div_alpha = int(content_factor * 30)
            div_y = 48.0 + (2.0 * p)
            div_left = w * (0.28 - 0.16 * content_factor)
            div_right = w * (0.72 + 0.16 * content_factor)

            div_pen = QPen(QColor(255, 255, 255, div_alpha), 1)
            painter.setPen(div_pen)
            painter.drawLine(QPoint(int(div_left), int(div_y)), QPoint(int(div_right), int(div_y)))

            # Date String
            date_alpha = int(content_factor * 225)
            date_str = now.strftime("%A, %B %d, %Y")
            
            date_font = QFont("Segoe UI Variable Text", 9, QFont.Weight.Normal)
            date_font.setStyleHint(QFont.StyleHint.SansSerif)
            painter.setFont(date_font)
            painter.setPen(QColor(165, 165, 180, date_alpha))

            date_y = 52.0 + (3.0 * content_factor)
            date_rect = QRectF(0, date_y, w, 22.0)
            painter.drawText(date_rect, Qt.AlignmentFlag.AlignCenter, date_str)


def main():
    if hasattr(Qt.ApplicationAttribute, 'AA_EnableHighDpiScaling'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    if hasattr(Qt.ApplicationAttribute, 'AA_UseHighDpiPixmaps'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    notch = DynamicNotch()
    notch.show()
    notch.enforce_topmost()

    sys.exit(app.exec())

if __name__ == "__main__":
    main()
