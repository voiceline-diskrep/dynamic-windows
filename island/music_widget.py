"""
Dynamic Windows - Music Player Expanded Widget
Provides track title, artist, timeline visualizer, and Play/Pause/Next/Previous controls.
"""

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QProgressBar
)

from island.music_manager import MusicManager, TrackInfo


class MusicWidget(QWidget):
    def __init__(self, music_manager: MusicManager, parent=None):
        super().__init__(parent)
        self.music_manager = music_manager
        self.init_ui()

        self.music_manager.track_changed.connect(self.update_track)
        self.music_manager.playback_state_changed.connect(self.update_play_state)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(14)

        header = QLabel("🎵 Now Playing & Media Controls")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        # Track Card
        track_box = QHBoxLayout()
        self.art_box = QLabel("💿")
        self.art_box.setStyleSheet("font-size: 36px; padding: 10px; background: #1f1f24; border-radius: 8px;")
        track_box.addWidget(self.art_box)

        info_box = QVBoxLayout()
        self.lbl_title = QLabel("No track playing")
        self.lbl_title.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        self.lbl_artist = QLabel("Play audio in Spotify, Chrome, or Media Player")
        self.lbl_artist.setStyleSheet("font-size: 12px; color: #a1a1aa;")
        info_box.addWidget(self.lbl_title)
        info_box.addWidget(self.lbl_artist)
        track_box.addLayout(info_box)
        layout.addLayout(track_box)

        # Timeline Bar
        self.timeline = QProgressBar()
        self.timeline.setRange(0, 100)
        self.timeline.setValue(45)
        self.timeline.setTextVisible(False)
        self.timeline.setFixedHeight(4)
        self.timeline.setStyleSheet("""
            QProgressBar { background-color: #27272a; border-radius: 2px; }
            QProgressBar::chunk { background-color: #3b82f6; border-radius: 2px; }
        """)
        layout.addWidget(self.timeline)

        # Control Buttons (Prev, Play/Pause, Next)
        ctrl_row = QHBoxLayout()
        ctrl_row.addStretch()

        btn_prev = QPushButton("⏮ Previous")
        btn_prev.setStyleSheet("""
            QPushButton { background-color: #1f1f24; color: #e4e4e7; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px 14px; font-size: 12px; }
            QPushButton:hover { background-color: #27272a; }
        """)
        btn_prev.clicked.connect(self.music_manager.previous_track)
        ctrl_row.addWidget(btn_prev)

        self.btn_play = QPushButton("⏸ Pause" if self.music_manager.is_playing else "▶ Play")
        self.btn_play.setStyleSheet("""
            QPushButton { background-color: #2563eb; color: #ffffff; font-weight: 600; border-radius: 6px; padding: 8px 20px; font-size: 13px; }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        self.btn_play.clicked.connect(self.music_manager.play_pause)
        ctrl_row.addWidget(self.btn_play)

        btn_next = QPushButton("Next ⏭")
        btn_next.setStyleSheet(btn_prev.styleSheet())
        btn_next.clicked.connect(self.music_manager.next_track)
        ctrl_row.addWidget(btn_next)

        ctrl_row.addStretch()
        layout.addLayout(ctrl_row)

        layout.addStretch()
        self.update_track(self.music_manager.current_track)

    def update_track(self, track: TrackInfo = None):
        if track:
            self.lbl_title.setText(track.title)
            self.lbl_artist.setText(track.artist)
            self.btn_play.setText("⏸ Pause" if track.is_playing else "▶ Play")
        else:
            self.lbl_title.setText("No media playing")
            self.lbl_artist.setText("Connects to Windows media session")
            self.btn_play.setText("▶ Play")

    def update_play_state(self, is_playing: bool):
        self.btn_play.setText("⏸ Pause" if is_playing else "▶ Play")
