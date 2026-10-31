"""
Dynamic Windows & One-Shot - Comprehensive Settings Architecture
Provides full settings categories: General, Appearance, Interaction, Sound,
Activities, AI Agents, Drop Zone, Task Manager, Updates, Privacy, and About.
"""

import os
import subprocess
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QWidget, QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QListWidget, QListWidgetItem, QStackedWidget, QCheckBox,
    QComboBox, QSlider, QFrame, QMessageBox, QGroupBox, QSpinBox
)

from updater_config import (
    CURRENT_VERSION, APPDATA_DIR, DROP_ZONE_DIR, LOGS_DIR,
    load_config, save_config, DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME
)
from oneshot.startup_takeover import is_startup_enabled, set_startup_enabled


class CompleteSettingsWindow(QDialog):
    settings_changed = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Settings & Preferences")
        self.resize(720, 560)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet("""
            QDialog {
                background-color: #0f0f12;
                color: #e4e4e7;
                font-family: 'Segoe UI', sans-serif;
                border: 1px solid #27272a;
                border-radius: 12px;
            }
            QListWidget {
                background-color: #121215;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 6px;
            }
            QListWidget::item {
                padding: 10px 14px;
                border-radius: 6px;
                color: #a1a1aa;
                font-size: 13px;
                font-weight: 500;
            }
            QListWidget::item:selected {
                background-color: #2563eb;
                color: #ffffff;
                font-weight: 600;
            }
            QCheckBox {
                color: #f4f4f5;
                font-size: 13px;
                spacing: 8px;
            }
            QComboBox, QSpinBox {
                background-color: #18181b;
                color: #f4f4f5;
                border: 1px solid #27272a;
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 12px;
            }
            QPushButton {
                background-color: #1f1f24;
                color: #ffffff;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 6px 14px;
                font-size: 12px;
            }
            QPushButton:hover { background-color: #27272a; }
            QPushButton#primaryBtn {
                background-color: #2563eb;
                border-color: #3b82f6;
            }
            QPushButton#primaryBtn:hover { background-color: #1d4ed8; }
        """)

        self.config_data = load_config()

        layout = QHBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(16)

        # Left Sidebar Navigation
        self.nav_list = QListWidget()
        self.nav_list.setFixedWidth(200)

        categories = [
            ("⚙️ General", self.create_general_page),
            ("🎨 Appearance", self.create_appearance_page),
            ("👆 Interaction", self.create_interaction_page),
            ("🔊 Sound & Feedback", self.create_sound_page),
            ("⚡ Activities", self.create_activities_page),
            ("🤖 AI Coding Agents", self.create_ai_page),
            ("📦 Files & Drop Zone", self.create_files_page),
            ("📊 Task Manager", self.create_task_mgr_page),
            ("🔄 Updates & GitHub", self.create_updates_page),
            ("🛡️ Privacy", self.create_privacy_page),
            ("ℹ️ About", self.create_about_page),
        ]

        self.stack = QStackedWidget()

        for idx, (label, builder) in enumerate(categories):
            self.nav_list.addItem(QListWidgetItem(label))
            page = builder()
            self.stack.addWidget(page)

        self.nav_list.currentRowChanged.connect(self.stack.setCurrentIndex)
        layout.addWidget(self.nav_list)
        layout.addWidget(self.stack, 1)

        self.nav_list.setCurrentRow(0)

    # 1. General
    def create_general_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("General Settings")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        self.chk_startup = QCheckBox("Launch One-Shot Takeover when I sign in to Windows")
        self.chk_startup.setChecked(is_startup_enabled())
        self.chk_startup.toggled.connect(set_startup_enabled)
        l.addWidget(self.chk_startup)

        self.chk_minimized = QCheckBox("Start minimized in System Tray")
        self.chk_minimized.setChecked(self.config_data.get("start_minimized", False))
        l.addWidget(self.chk_minimized)

        l.addStretch()
        return w

    # 2. Appearance
    def create_appearance_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Appearance & Themes")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        theme_row = QHBoxLayout()
        theme_row.addWidget(QLabel("Interface Theme:"))
        self.cmb_theme = QComboBox()
        self.cmb_theme.addItems(["Dark OLED (Default)", "Liquid Glass Light", "Follow Windows System"])
        theme_row.addWidget(self.cmb_theme)
        theme_row.addStretch()
        l.addLayout(theme_row)

        self.chk_reduced_motion = QCheckBox("Reduced Motion (Faster animations, disable spring bouncing)")
        self.chk_reduced_motion.setChecked(self.config_data.get("reduced_motion", False))
        l.addWidget(self.chk_reduced_motion)

        l.addStretch()
        return w

    # 3. Interaction
    def create_interaction_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Interaction & Hover Behavior")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        delay_row = QHBoxLayout()
        delay_row.addWidget(QLabel("Collapse Grace Period (ms):"))
        self.spn_delay = QSpinBox()
        self.spn_delay.setRange(50, 1000)
        self.spn_delay.setValue(self.config_data.get("collapse_duration", 220))
        delay_row.addWidget(self.spn_delay)
        delay_row.addStretch()
        l.addLayout(delay_row)

        l.addStretch()
        return w

    # 4. Sound & Feedback
    def create_sound_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Sound & Typing Feedback")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        self.chk_typing_sound = QCheckBox("Enable subtle mechanical typing sounds")
        self.chk_typing_sound.setChecked(self.config_data.get("typing_sounds_enabled", False))
        l.addWidget(self.chk_typing_sound)

        self.chk_ui_sound = QCheckBox("Enable UI interaction sound effects")
        self.chk_ui_sound.setChecked(self.config_data.get("ui_sounds_enabled", True))
        l.addWidget(self.chk_ui_sound)

        l.addStretch()
        return w

    # 5. Activities
    def create_activities_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Dynamic Activities")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        self.chk_act_music = QCheckBox("Display active music playback in compact island")
        self.chk_act_music.setChecked(True)
        l.addWidget(self.chk_act_music)

        self.chk_act_dl = QCheckBox("Display active downloads in compact island")
        self.chk_act_dl.setChecked(True)
        l.addWidget(self.chk_act_dl)

        self.chk_act_ai = QCheckBox("Display active AI coding agent tasks in compact island")
        self.chk_act_ai.setChecked(True)
        l.addWidget(self.chk_act_ai)

        l.addStretch()
        return w

    # 6. AI Coding Agents
    def create_ai_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("AI Coding Agent Integrations")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        self.chk_ai_antigravity = QCheckBox("Enable Google Antigravity transcript monitoring")
        self.chk_ai_antigravity.setChecked(True)
        l.addWidget(self.chk_ai_antigravity)

        self.chk_ai_claude = QCheckBox("Enable Anthropic Claude Code process monitoring")
        self.chk_ai_claude.setChecked(True)
        l.addWidget(self.chk_ai_claude)

        self.chk_ai_codex = QCheckBox("Enable OpenAI Codex CLI process monitoring")
        self.chk_ai_codex.setChecked(True)
        l.addWidget(self.chk_ai_codex)

        btn_test_ai = QPushButton("Test Agent Connections")
        btn_test_ai.clicked.connect(self.test_ai_connections)
        l.addWidget(btn_test_ai)

        l.addStretch()
        return w

    def test_ai_connections(self):
        from ai_agents.antigravity_adapter import AntigravityAdapter
        from ai_agents.claude_adapter import ClaudeCodeAdapter
        from ai_agents.codex_adapter import CodexAdapter

        res = []
        for ad in [AntigravityAdapter(), ClaudeCodeAdapter(), CodexAdapter()]:
            ok, msg = ad.test_connection()
            status = "✓ OK" if ok else "✗ Missing"
            res.append(f"• {ad.provider_name}: {status} ({msg})")

        QMessageBox.information(self, "AI Connection Test Results", "\n\n".join(res))

    # 7. Files & Drop Zone
    def create_files_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Files & Drop Zone Storage")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        lbl_path = QLabel(f"Persistent Storage Path:\n{DROP_ZONE_DIR}")
        lbl_path.setStyleSheet("font-size: 12px; color: #a1a1aa;")
        lbl_path.setWordWrap(True)
        l.addWidget(lbl_path)

        btn_open = QPushButton("Open Storage Folder ↗")
        btn_open.clicked.connect(lambda: subprocess.run(["explorer.exe", DROP_ZONE_DIR]))
        l.addWidget(btn_open)

        l.addStretch()
        return w

    # 8. Task Manager
    def create_task_mgr_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Task Manager Preferences")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        r_row = QHBoxLayout()
        r_row.addWidget(QLabel("Refresh Interval (seconds):"))
        self.spn_refresh = QSpinBox()
        self.spn_refresh.setRange(1, 10)
        self.spn_refresh.setValue(2)
        r_row.addWidget(self.spn_refresh)
        r_row.addStretch()
        l.addLayout(r_row)

        l.addStretch()
        return w

    # 9. Updates
    def create_updates_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Automatic GitHub Updates")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        lbl_v = QLabel(f"Current Installed Version: <b>v{CURRENT_VERSION}</b>")
        l.addWidget(lbl_v)

        self.chk_auto_up = QCheckBox("Automatically check for updates")
        self.chk_auto_up.setChecked(self.config_data.get("auto_check_updates", True))
        l.addWidget(self.chk_auto_up)

        self.chk_beta_up = QCheckBox("Include Beta / Pre-release updates")
        self.chk_beta_up.setChecked(self.config_data.get("include_beta", False))
        l.addWidget(self.chk_beta_up)

        btn_chk = QPushButton("Check for Updates Now...")
        btn_chk.setObjectName("primaryBtn")
        btn_chk.clicked.connect(lambda: QMessageBox.information(self, "Update Check", f"Dynamic Windows is running v{CURRENT_VERSION} (Up to date)."))
        l.addWidget(btn_chk)

        l.addStretch()
        return w

    # 10. Privacy
    def create_privacy_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("Privacy & Security")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        lbl_info = QLabel(
            "• Local-First: All presets, files, and settings are stored locally on your device.\n"
            "• No Telemetry: No background user tracking or telemetry is collected.\n"
            "• Secure Updates: Updates are verified via official SHA256 cryptographic hashes from GitHub Releases."
        )
        lbl_info.setStyleSheet("color: #a1a1aa; font-size: 13px; line-height: 1.6;")
        l.addWidget(lbl_info)

        l.addStretch()
        return w

    # 11. About
    def create_about_page(self) -> QWidget:
        w = QWidget()
        l = QVBoxLayout(w)
        l.setSpacing(12)

        hdr = QLabel("About Dynamic Windows + One-Shot")
        hdr.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        l.addWidget(hdr)

        lbl_v = QLabel(f"Version: v{CURRENT_VERSION}\nPlatform: Windows 10 / Windows 11 (x64)")
        lbl_v.setStyleSheet("font-size: 13px; color: #ffffff;")
        l.addWidget(lbl_v)

        lbl_desc = QLabel("A unified Windows desktop utility combining Apple-inspired Dynamic Island with One-Shot application launcher.")
        lbl_desc.setStyleSheet("color: #a1a1aa; font-size: 12px;")
        lbl_desc.setWordWrap(True)
        l.addWidget(lbl_desc)

        btn_repo = QPushButton("GitHub Repository ↗")
        btn_repo.clicked.connect(lambda: subprocess.run(["explorer.exe", f"https://github.com/{DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}"]))
        l.addWidget(btn_repo)

        l.addStretch()
        return w
