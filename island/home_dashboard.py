"""
Dynamic Windows - Home Dashboard View
Combines One-Shot quick preset tiles, live AI Agent activities,
Now Playing music card, active focus timer, and system resources.
"""

import os
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QGridLayout, QScrollArea
)

from oneshot.presets import PresetManager, Preset
from oneshot.launcher import AppLaunchEngine
from ai_agents.manager import AIAgentActivityManager
from island.music_manager import MusicManager
from island.timer_widget import FocusTimer


class HomeDashboardWidget(QWidget):
    switch_tab_requested = pyqtSignal(str)  # Tab name to switch to

    def __init__(
        self,
        preset_manager: PresetManager,
        launch_engine: AppLaunchEngine,
        ai_manager: AIAgentActivityManager,
        music_manager: MusicManager,
        focus_timer: FocusTimer,
        parent=None
    ):
        super().__init__(parent)
        self.preset_manager = preset_manager
        self.launch_engine = launch_engine
        self.ai_manager = ai_manager
        self.music_manager = music_manager
        self.focus_timer = focus_timer

        self.init_ui()

        # Connect live updates
        self.ai_manager.activities_updated.connect(self.update_ai_card)
        self.music_manager.track_changed.connect(self.update_music_card)
        self.music_manager.playback_state_changed.connect(lambda _: self.update_music_card())
        self.focus_timer.tick.connect(self.update_timer_card)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(12)

        # 1. Quick Presets Section
        p_header = QHBoxLayout()
        lbl_p = QLabel("⚡ One-Shot Workspaces")
        lbl_p.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        p_header.addWidget(lbl_p)
        p_header.addStretch()

        btn_all_p = QPushButton("View All ➔")
        btn_all_p.setStyleSheet("background: transparent; color: #38bdf8; font-size: 11px; border: none;")
        btn_all_p.clicked.connect(lambda: self.switch_tab_requested.emit("One-Shot"))
        p_header.addWidget(btn_all_p)
        layout.addLayout(p_header)

        # Preset Quick Launch Row
        self.preset_row = QHBoxLayout()
        self.preset_row.setSpacing(8)
        layout.addLayout(self.preset_row)
        self.refresh_presets_row()

        # 2. Live Activity Cards Row (AI Agents, Music, Timer)
        cards_grid = QGridLayout()
        cards_grid.setSpacing(10)

        # AI Agent Card
        self.ai_card = QFrame()
        self.ai_card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        ai_l = QVBoxLayout(self.ai_card)
        ai_l.setContentsMargins(8, 8, 8, 8)
        ai_l.setSpacing(4)
        ai_hdr_row = QHBoxLayout()
        logo_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "antigravity_logo.png")
        if os.path.exists(logo_path):
            img = QLabel()
            img.setPixmap(QPixmap(logo_path).scaled(16, 16, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
            ai_hdr_row.addWidget(img)
        ai_hdr = QLabel("AI Coding Agents")
        ai_hdr.setStyleSheet("font-size: 11px; font-weight: 600; color: #a1a1aa;")
        ai_hdr_row.addWidget(ai_hdr)
        ai_hdr_row.addStretch()
        ai_l.addLayout(ai_hdr_row)
        self.lbl_ai_status = QLabel("Idle (No active agent)")
        self.lbl_ai_status.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        self.lbl_ai_sub = QLabel("Antigravity & CLI ready")
        self.lbl_ai_sub.setStyleSheet("font-size: 11px; color: #71717a;")
        ai_l.addWidget(self.lbl_ai_status)
        ai_l.addWidget(self.lbl_ai_sub)
        cards_grid.addWidget(self.ai_card, 0, 0)

        # Music Player Card
        self.music_card = QFrame()
        self.music_card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        m_l = QVBoxLayout(self.music_card)
        m_l.setContentsMargins(8, 8, 8, 8)
        m_l.setSpacing(4)
        m_hdr = QLabel("🎵 Music & Media")
        m_hdr.setStyleSheet("font-size: 11px; font-weight: 600; color: #a1a1aa;")
        self.lbl_music_track = QLabel("No track playing")
        self.lbl_music_track.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        self.lbl_music_artist = QLabel("Spotify / Media player")
        self.lbl_music_artist.setStyleSheet("font-size: 11px; color: #71717a;")
        m_l.addWidget(m_hdr)
        m_l.addWidget(self.lbl_music_track)
        m_l.addWidget(self.lbl_music_artist)
        cards_grid.addWidget(self.music_card, 0, 1)

        # Timer Card
        self.timer_card = QFrame()
        self.timer_card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        t_l = QVBoxLayout(self.timer_card)
        t_l.setContentsMargins(8, 8, 8, 8)
        t_l.setSpacing(4)
        t_hdr = QLabel("⏱ Focus Timer")
        t_hdr.setStyleSheet("font-size: 11px; font-weight: 600; color: #a1a1aa;")
        self.lbl_timer_val = QLabel(self.focus_timer.get_formatted_time())
        self.lbl_timer_val.setStyleSheet("font-size: 14px; font-weight: 700; color: #38bdf8;")
        self.lbl_timer_state = QLabel("Ready (25m session)")
        self.lbl_timer_state.setStyleSheet("font-size: 11px; color: #71717a;")
        t_l.addWidget(t_hdr)
        t_l.addWidget(self.lbl_timer_val)
        t_l.addWidget(self.lbl_timer_state)
        cards_grid.addWidget(self.timer_card, 1, 0, 1, 2)

        layout.addLayout(cards_grid)
        layout.addStretch()

        self.update_ai_card(self.ai_manager.get_active_activities())
        self.update_music_card()

    def refresh_presets_row(self):
        while self.preset_row.count():
            item = self.preset_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        presets = self.preset_manager.get_presets()[:4]
        for p in presets:
            btn = QPushButton(f"⚡ {p.name}")
            btn.setStyleSheet("""
                QPushButton {
                    background-color: #18181c;
                    color: #ffffff;
                    border: 1px solid #27272a;
                    border-radius: 8px;
                    padding: 8px 12px;
                    font-size: 12px;
                    font-weight: 600;
                }
                QPushButton:hover {
                    background-color: #2563eb;
                    border-color: #3b82f6;
                }
            """)
            btn.clicked.connect(lambda _, preset=p: self.launch_engine.launch_preset(preset))
            self.preset_row.addWidget(btn)

    def update_ai_card(self, activities=None):
        acts = activities or self.ai_manager.get_active_activities()
        if acts:
            top = acts[0]
            self.lbl_ai_status.setText(f"{top.provider}: {top.status}")
            self.lbl_ai_sub.setText(top.phase or top.workspace)
        else:
            self.lbl_ai_status.setText("Idle (Monitoring ready)")
            self.lbl_ai_sub.setText("Antigravity, Claude, Codex")

    def update_music_card(self, track=None):
        t = track or self.music_manager.current_track
        if t and self.music_manager.is_playing:
            self.lbl_music_track.setText(t.title[:24])
            self.lbl_music_artist.setText(t.artist[:24])
        else:
            self.lbl_music_track.setText("No music playing")
            self.lbl_music_artist.setText("Play tracks in Spotify/Browser")

    def update_timer_card(self, rem_sec, formatted, progress):
        self.lbl_timer_val.setText(formatted)
        if self.focus_timer.is_running:
            self.lbl_timer_state.setText("Active focus session in progress")
        else:
            self.lbl_timer_state.setText("Paused / Ready")
