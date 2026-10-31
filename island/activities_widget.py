"""
Dynamic Windows - Activities Tab Widget
Displays live activities: AI Coding Agents, Downloads, Call status, and Background tasks.
"""

import os
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QScrollArea, QFrame, QProgressBar, QDialog
)

from ai_agents.manager import AIAgentActivityManager, AgentActivity
from island.download_monitor import DownloadMonitor
from island.timer_widget import FocusTimer


class ActivitiesWidget(QWidget):
    def __init__(self, ai_manager: AIAgentActivityManager, download_monitor: DownloadMonitor, focus_timer: FocusTimer, parent=None):
        super().__init__(parent)
        self.ai_manager = ai_manager
        self.download_monitor = download_monitor
        self.focus_timer = focus_timer

        self.init_ui()

        self.ai_manager.activities_updated.connect(self.refresh_activities)
        self.download_monitor.downloads_updated.connect(self.refresh_activities)
        self.focus_timer.tick.connect(self.refresh_activities)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        header = QLabel("⚡ Active Background Tasks & AI Agents")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("background: transparent; border: none;")

        self.container = QWidget()
        self.c_layout = QVBoxLayout(self.container)
        self.c_layout.setSpacing(10)
        self.c_layout.setContentsMargins(0, 0, 0, 0)

        scroll.setWidget(self.container)
        layout.addWidget(scroll)

        self.refresh_activities()

    def refresh_activities(self, *args):
        # Clear container
        while self.c_layout.count():
            item = self.c_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        has_any = False

        # 1. AI Agents
        for agent in self.ai_manager.get_active_activities():
            has_any = True
            card = self.create_agent_card(agent)
            self.c_layout.addWidget(card)

        # 2. Downloads
        for dl in self.download_monitor.get_active_downloads():
            has_any = True
            card = self.create_download_card(dl)
            self.c_layout.addWidget(card)

        # 3. Focus Timer
        if self.focus_timer.is_running:
            has_any = True
            card = self.create_timer_card()
            self.c_layout.addWidget(card)

        if not has_any:
            lbl_empty = QLabel("No background activities currently running.\nActivities appear here automatically when tasks, downloads, or agents run.")
            lbl_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl_empty.setStyleSheet("color: #71717a; font-size: 12px; padding: 30px;")
            self.c_layout.addWidget(lbl_empty)

        self.c_layout.addStretch()

    def create_agent_card(self, agent: AgentActivity) -> QFrame:
        card = QFrame()
        card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        l = QVBoxLayout(card)
        l.setContentsMargins(10, 8, 10, 8)
        l.setSpacing(6)

        top = QHBoxLayout()
        # Antigravity official logo or provider tag
        is_ag = "antigravity" in agent.provider.lower()
        logo_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "antigravity_logo.png")
        if is_ag and os.path.exists(logo_path):
            img_lbl = QLabel()
            pm = QPixmap(logo_path).scaled(22, 22, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            img_lbl.setPixmap(pm)
            top.addWidget(img_lbl)

        prov = QLabel(agent.provider)
        prov.setStyleSheet("font-size: 13px; font-weight: 600; color: #38bdf8;")
        top.addWidget(prov)
        top.addStretch()

        status_lbl = QLabel(agent.status)
        status_lbl.setStyleSheet("font-size: 11px; font-weight: 600; color: #34d399; background: #064e3b; padding: 2px 8px; border-radius: 10px;")
        top.addWidget(status_lbl)
        l.addLayout(top)

        phase_lbl = QLabel(agent.phase or agent.task_name)
        phase_lbl.setStyleSheet("font-size: 12px; color: #e4e4e7;")
        l.addWidget(phase_lbl)

        meta = QLabel(f"Workspace: {agent.workspace} | Task: {agent.task_id}")
        meta.setStyleSheet("font-size: 10px; color: #71717a;")
        l.addWidget(meta)
        return card

    def create_download_card(self, dl) -> QFrame:
        card = QFrame()
        card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        l = QVBoxLayout(card)
        l.setContentsMargins(10, 8, 10, 8)
        l.setSpacing(4)

        top = QHBoxLayout()
        name_lbl = QLabel(f"⬇ {dl.filename}")
        name_lbl.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        top.addWidget(name_lbl)
        top.addStretch()

        speed_lbl = QLabel(f"{dl.speed_kbps:.0f} KB/s")
        speed_lbl.setStyleSheet("font-size: 11px; color: #38bdf8;")
        top.addWidget(speed_lbl)
        l.addLayout(top)

        sub_lbl = QLabel(f"Downloaded: {dl.current_bytes / (1024*1024):.1f} MB")
        sub_lbl.setStyleSheet("font-size: 11px; color: #a1a1aa;")
        l.addWidget(sub_lbl)
        return card

    def create_timer_card(self) -> QFrame:
        card = QFrame()
        card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        l = QVBoxLayout(card)
        l.setContentsMargins(10, 8, 10, 8)
        l.setSpacing(4)

        top = QHBoxLayout()
        name_lbl = QLabel("⏱ Pomodoro Focus Session")
        name_lbl.setStyleSheet("font-size: 13px; font-weight: 600; color: #ffffff;")
        top.addWidget(name_lbl)
        top.addStretch()

        rem_lbl = QLabel(self.focus_timer.get_formatted_time())
        rem_lbl.setStyleSheet("font-size: 13px; font-weight: 700; color: #38bdf8;")
        top.addWidget(rem_lbl)
        l.addLayout(top)
        return card


class ActivitiesWindow(QDialog):
    """Spacious standalone dialog for viewing all live AI agents and background activities."""
    def __init__(self, ai_manager, download_monitor, focus_timer, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Live Activities & AI Coding Agents")
        self.resize(600, 480)
        self.setStyleSheet("""
            QDialog {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 12px;
                font-family: 'Segoe UI', sans-serif;
            }
        """)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        self.widget = ActivitiesWidget(ai_manager, download_monitor, focus_timer, self)
        layout.addWidget(self.widget)
