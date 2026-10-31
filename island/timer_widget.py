"""
Dynamic Windows - Focus Timer & Stopwatch
Provides 25-minute default Pomodoro focus timer, custom durations,
accurate timestamp-based countdown, completion chime, and Dynamic Island badge.
"""

import time
import winsound
from PyQt6.QtCore import Qt, QObject, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QSpinBox, QProgressBar
)

class FocusTimer(QObject):
    tick = pyqtSignal(int, str, float)  # seconds_remaining, formatted_str, progress (0.0 to 1.0)
    finished = pyqtSignal()
    state_changed = pyqtSignal(bool)   # is_running

    def __init__(self, parent=None):
        super().__init__(parent)
        self.total_duration_sec = 25 * 60
        self.remaining_sec = self.total_duration_sec
        self.is_running = False
        self._target_end_time = 0

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._on_tick)
        self._timer.setInterval(200)

    def start(self, duration_sec: int = None):
        if duration_sec is not None:
            self.total_duration_sec = duration_sec
            self.remaining_sec = duration_sec

        self._target_end_time = time.time() + self.remaining_sec
        self.is_running = True
        self._timer.start()
        self.state_changed.emit(True)
        self._emit_tick()

    def pause(self):
        if self.is_running:
            self.remaining_sec = max(0, int(self._target_end_time - time.time()))
            self.is_running = False
            self._timer.stop()
            self.state_changed.emit(False)
            self._emit_tick()

    def reset(self, duration_sec: int = 25 * 60):
        self.is_running = False
        self._timer.stop()
        self.total_duration_sec = duration_sec
        self.remaining_sec = duration_sec
        self.state_changed.emit(False)
        self._emit_tick()

    def _on_tick(self):
        now = time.time()
        self.remaining_sec = max(0, int(self._target_end_time - now))
        self._emit_tick()
        if self.remaining_sec <= 0:
            self.is_running = False
            self._timer.stop()
            self.state_changed.emit(False)
            self.finished.emit()
            try:
                winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
            except Exception:
                pass

    def _emit_tick(self):
        m = self.remaining_sec // 60
        s = self.remaining_sec % 60
        formatted = f"{m:02d}:{s:02d}"
        progress = 1.0 - (self.remaining_sec / float(self.total_duration_sec)) if self.total_duration_sec > 0 else 0.0
        self.tick.emit(self.remaining_sec, formatted, progress)

    def get_formatted_time(self) -> str:
        m = self.remaining_sec // 60
        s = self.remaining_sec % 60
        return f"{m:02d}:{s:02d}"


class TimerWidget(QWidget):
    """Expanded UI panel for the Timer tab in Dynamic Island."""
    def __init__(self, timer: FocusTimer, parent=None):
        super().__init__(parent)
        self.timer = timer
        self.init_ui()

        self.timer.tick.connect(self.on_timer_tick)
        self.timer.state_changed.connect(self.on_state_changed)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(14)

        header = QLabel("⏱ Focus & Productivity Timer")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        # Huge Digital Clock Display
        self.lbl_display = QLabel(self.timer.get_formatted_time())
        self.lbl_display.setStyleSheet("font-size: 42px; font-weight: 700; color: #ffffff; letter-spacing: 2px;")
        self.lbl_display.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.lbl_display)

        # Progress bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setFixedHeight(6)
        self.progress_bar.setStyleSheet("""
            QProgressBar {
                background-color: #27272a;
                border-radius: 3px;
            }
            QProgressBar::chunk {
                background-color: #3b82f6;
                border-radius: 3px;
            }
        """)
        layout.addWidget(self.progress_bar)

        # Preset Duration Buttons (15m, 25m, 45m, 60m)
        preset_row = QHBoxLayout()
        for mins in [15, 25, 45, 60]:
            btn = QPushButton(f"{mins}m")
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #1f1f24;
                    color: #e4e4e7;
                    border: 1px solid #3f3f46;
                    border-radius: 6px;
                    padding: 4px 10px;
                    font-size: 12px;
                }
                QPushButton:hover { background-color: #27272a; border-color: #3b82f6; }
            """)
            btn.clicked.connect(lambda _, m=mins: self.set_preset_duration(m))
            preset_row.addWidget(btn)
        layout.addLayout(preset_row)

        # Control Buttons (Start/Pause, Reset)
        btn_row = QHBoxLayout()
        self.btn_toggle = QPushButton("▶ Start Focus")
        self.btn_toggle.setStyleSheet("""
            QPushButton {
                background-color: #2563eb;
                color: #ffffff;
                font-weight: 600;
                border-radius: 8px;
                padding: 8px 20px;
                font-size: 13px;
            }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        self.btn_toggle.clicked.connect(self.toggle_timer)
        btn_row.addWidget(self.btn_toggle)

        self.btn_reset = QPushButton("↺ Reset")
        self.btn_reset.setStyleSheet("""
            QPushButton {
                background-color: #1f1f24;
                color: #f4f4f5;
                border: 1px solid #3f3f46;
                border-radius: 8px;
                padding: 8px 16px;
                font-size: 13px;
            }
            QPushButton:hover { background-color: #27272a; }
        """)
        self.btn_reset.clicked.connect(self.reset_timer)
        btn_row.addWidget(self.btn_reset)
        layout.addLayout(btn_row)

    def set_preset_duration(self, mins: int):
        self.timer.reset(mins * 60)
        self.btn_toggle.setText("▶ Start Focus")

    def toggle_timer(self):
        if self.timer.is_running:
            self.timer.pause()
            self.btn_toggle.setText("▶ Resume")
        else:
            self.timer.start()
            self.btn_toggle.setText("⏸ Pause")

    def reset_timer(self):
        self.timer.reset(25 * 60)
        self.btn_toggle.setText("▶ Start Focus")

    def on_timer_tick(self, rem_sec, formatted, progress):
        self.lbl_display.setText(formatted)
        self.progress_bar.setValue(int(progress * 100))

    def on_state_changed(self, is_running):
        self.btn_toggle.setText("⏸ Pause" if is_running else "▶ Start Focus")
