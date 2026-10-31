"""
Dynamic Windows - Sound & Volume Settings Widget
Provides real system volume slider, mute/unmute toggle, and typing sound controls.
"""

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QSlider, QCheckBox
)

from island.sound_manager import SoundManager


class SoundWidget(QWidget):
    def __init__(self, sound_manager: SoundManager, parent=None):
        super().__init__(parent)
        self.sound_manager = sound_manager
        self.init_ui()

        self.sound_manager.volume_changed.connect(self.on_volume_changed)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(14)

        header = QLabel("🔊 System Audio & Volume")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        # Volume Slider Row
        v_box = QVBoxLayout()
        v_box.setSpacing(8)

        v_top = QHBoxLayout()
        self.lbl_vol_title = QLabel("Master System Volume")
        self.lbl_vol_title.setStyleSheet("font-size: 13px; color: #f4f4f5;")
        v_top.addWidget(self.lbl_vol_title)
        v_top.addStretch()

        cur_vol = int(self.sound_manager.get_volume() * 100)
        self.lbl_vol_val = QLabel(f"{cur_vol}%")
        self.lbl_vol_val.setStyleSheet("font-size: 14px; font-weight: 700; color: #38bdf8;")
        v_top.addWidget(self.lbl_vol_val)
        v_box.addLayout(v_top)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 100)
        self.slider.setValue(cur_vol)
        self.slider.setStyleSheet("""
            QSlider::groove:horizontal { height: 6px; background: #27272a; border-radius: 3px; }
            QSlider::sub-page:horizontal { background: #3b82f6; border-radius: 3px; }
            QSlider::handle:horizontal {
                background: #ffffff; border: 2px solid #3b82f6;
                width: 16px; margin-top: -5px; margin-bottom: -5px; border-radius: 8px;
            }
        """)
        self.slider.valueChanged.connect(self.on_slider_moved)
        v_box.addWidget(self.slider)
        layout.addLayout(v_box)

        # Mute / Unmute Button
        btn_row = QHBoxLayout()
        self.btn_mute = QPushButton("🔊 Mute Audio" if not self.sound_manager.is_muted() else "🔇 Unmute Audio")
        self.btn_mute.setStyleSheet("""
            QPushButton {
                background-color: #1f1f24; color: #f4f4f5;
                border: 1px solid #3f3f46; border-radius: 6px;
                padding: 6px 14px; font-size: 12px;
            }
            QPushButton:hover { background-color: #27272a; }
        """)
        self.btn_mute.clicked.connect(self.toggle_mute)
        btn_row.addWidget(self.btn_mute)

        btn_test = QPushButton("Test Audio Chime")
        btn_test.setStyleSheet(self.btn_mute.styleSheet())
        btn_test.clicked.connect(self.sound_manager.play_notification_sound)
        btn_row.addWidget(btn_test)

        btn_row.addStretch()
        layout.addLayout(btn_row)

        layout.addStretch()

    def on_slider_moved(self, val):
        self.lbl_vol_val.setText(f"{val}%")
        self.sound_manager.set_volume(val / 100.0)

    def toggle_mute(self):
        is_muted = self.sound_manager.toggle_mute()
        self.btn_mute.setText("🔇 Unmute Audio" if is_muted else "🔊 Mute Audio")

    def on_volume_changed(self, vol, is_muted):
        v_int = int(vol * 100)
        self.slider.blockSignals(True)
        self.slider.setValue(v_int)
        self.slider.blockSignals(False)
        self.lbl_vol_val.setText(f"{v_int}%")
        self.btn_mute.setText("🔇 Unmute Audio" if is_muted else "🔊 Mute Audio")
