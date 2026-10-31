"""
Dynamic Windows - Updater Dialogs
Provides dedicated Settings & Updates configuration,
Release History & Notes viewer, and Update Logs inspector.
"""

import os
import subprocess
import webbrowser
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont, QIcon
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QCheckBox, QComboBox, QLineEdit, QGroupBox, QTextEdit,
    QListWidget, QListWidgetItem, QSplitter, QMessageBox, QFrame
)

from updater_config import (
    CURRENT_VERSION, DEFAULT_REPO_OWNER, DEFAULT_REPO_NAME,
    LOGS_DIR, load_config, save_config
)
import updater_logger as logger
from updater_engine import (
    UpdateCheckerThread, fetch_all_releases, parse_version, ReleaseInfo
)

DARK_STYLESHEET = """
QDialog {
    background-color: #0f0f12;
    color: #e4e4e7;
    border: 1px solid #27272a;
    border-radius: 12px;
    font-family: 'Segoe UI Variable Text', 'Segoe UI', sans-serif;
}
QLabel {
    color: #e4e4e7;
    font-size: 13px;
}
QGroupBox {
    color: #a1a1aa;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid #27272a;
    border-radius: 8px;
    margin-top: 12px;
    padding-top: 14px;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 4px;
}
QCheckBox {
    color: #f4f4f5;
    font-size: 13px;
    spacing: 8px;
}
QCheckBox::indicator {
    width: 18px;
    height: 18px;
    border: 1px solid #3f3f46;
    border-radius: 4px;
    background: #18181b;
}
QCheckBox::indicator:hover {
    border-color: #3b82f6;
}
QCheckBox::indicator:checked {
    background: #2563eb;
    border-color: #3b82f6;
    image: none;
}
QComboBox, QLineEdit {
    background-color: #18181b;
    color: #f4f4f5;
    border: 1px solid #27272a;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
}
QComboBox:hover, QLineEdit:hover {
    border-color: #3f3f46;
}
QComboBox:focus, QLineEdit:focus {
    border-color: #3b82f6;
}
QComboBox::drop-down {
    border: none;
    width: 24px;
}
QComboBox QAbstractItemView {
    background-color: #18181b;
    color: #f4f4f5;
    border: 1px solid #27272a;
    selection-background-color: #27272a;
}
QPushButton {
    background-color: #1f1f24;
    color: #f4f4f5;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
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
    color: #ffffff;
    font-weight: 600;
}
QPushButton#primaryBtn:hover {
    background-color: #1d4ed8;
}
QTextEdit, QListWidget {
    background-color: #121215;
    color: #e4e4e7;
    border: 1px solid #27272a;
    border-radius: 6px;
    padding: 8px;
    font-size: 12px;
}
QListWidget::item {
    padding: 8px;
    border-radius: 4px;
}
QListWidget::item:selected {
    background-color: #27272a;
    color: #38bdf8;
}
"""


class FetchReleasesWorker(QThread):
    """Background fetcher for full release history."""
    releases_loaded = pyqtSignal(list)
    error_occurred = pyqtSignal(str)

    def __init__(self, owner, name, token=None):
        super().__init__()
        self.owner = owner
        self.name = name
        self.token = token

    def run(self):
        try:
            releases = fetch_all_releases(self.owner, self.name, self.token)
            self.releases_loaded.emit(releases)
        except Exception as e:
            self.error_occurred.emit(str(e))


class ReleaseHistoryDialog(QDialog):
    """Clean changelog & release history inspector dialog."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Release History & Notes")
        self.resize(680, 480)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet(DARK_STYLESHEET)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        header = QLabel("✦ Release History")
        header.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        self.splitter = QSplitter(Qt.Orientation.Horizontal)

        # Left: Release List
        self.release_list = QListWidget()
        self.release_list.setFixedWidth(220)
        self.release_list.currentRowChanged.connect(self.on_release_selected)
        self.splitter.addWidget(self.release_list)

        # Right: Release Notes
        right_panel = QFrame()
        r_layout = QVBoxLayout(right_panel)
        r_layout.setContentsMargins(0, 0, 0, 0)
        r_layout.setSpacing(8)

        self.lbl_title = QLabel("Select a release")
        self.lbl_title.setStyleSheet("font-size: 14px; font-weight: 600; color: #ffffff;")
        r_layout.addWidget(self.lbl_title)

        self.lbl_meta = QLabel("")
        self.lbl_meta.setStyleSheet("font-size: 11px; color: #71717a;")
        r_layout.addWidget(self.lbl_meta)

        self.txt_notes = QTextEdit()
        self.txt_notes.setReadOnly(True)
        r_layout.addWidget(self.txt_notes)

        btn_box = QHBoxLayout()
        self.btn_web = QPushButton("Open Release on GitHub ↗")
        self.btn_web.clicked.connect(self.open_current_in_browser)
        self.btn_web.setEnabled(False)
        btn_box.addWidget(self.btn_web)
        btn_box.addStretch()

        r_layout.addLayout(btn_box)
        self.splitter.addWidget(right_panel)
        layout.addWidget(self.splitter)

        # Bottom Bar
        bottom_box = QHBoxLayout()
        self.lbl_status = QLabel("Loading releases from GitHub...")
        self.lbl_status.setStyleSheet("color: #a1a1aa; font-size: 12px;")
        bottom_box.addWidget(self.lbl_status)
        bottom_box.addStretch()

        btn_close = QPushButton("Close")
        btn_close.clicked.connect(self.accept)
        bottom_box.addWidget(btn_close)
        layout.addLayout(bottom_box)

        # Start loading
        self.releases_data = []
        cfg = load_config()
        self.worker = FetchReleasesWorker(
            cfg.get("repo_owner", DEFAULT_REPO_OWNER),
            cfg.get("repo_name", DEFAULT_REPO_NAME),
            cfg.get("github_token", "").strip() or None
        )
        self.worker.releases_loaded.connect(self.on_releases_loaded)
        self.worker.error_occurred.connect(self.on_releases_error)
        self.worker.start()

    def on_releases_loaded(self, releases):
        self.releases_data = releases
        self.release_list.clear()
        if not releases:
            self.lbl_status.setText("No releases found.")
            return

        self.lbl_status.setText(f"Loaded {len(releases)} release(s).")
        for r in releases:
            tag = r.get("tag_name", "Unknown")
            is_pre = r.get("prerelease", False)
            date_str = r.get("published_at", "")[:10]
            display_text = f"{tag} {'[Beta]' if is_pre else ''}\n{date_str}"
            item = QListWidgetItem(display_text)
            self.release_list.addItem(item)

        if self.release_list.count() > 0:
            self.release_list.setCurrentRow(0)

    def on_releases_error(self, err):
        self.lbl_status.setText(f"Error loading: {err[:45]}")

    def on_release_selected(self, row):
        if 0 <= row < len(self.releases_data):
            rel = self.releases_data[row]
            tag = rel.get("tag_name", "")
            title = rel.get("name") or tag
            date_str = rel.get("published_at", "")[:10]
            body = rel.get("body", "No release notes provided.")
            is_pre = rel.get("prerelease", False)

            self.lbl_title.setText(title)
            self.lbl_meta.setText(f"Tag: {tag} | Released: {date_str} {' | Pre-release' if is_pre else ''}")
            self.txt_notes.setPlainText(body)
            self.btn_web.setEnabled(True)
            self.btn_web.setProperty("url", rel.get("html_url", ""))

    def open_current_in_browser(self):
        url = self.btn_web.property("url")
        if url:
            webbrowser.open(url)


class UpdateLogsDialog(QDialog):
    """Sleek viewer for update logs."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Update Logs")
        self.resize(600, 400)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet(DARK_STYLESHEET)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        header = QLabel("Update Diagnostics & Logs")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        self.txt_log = QTextEdit()
        self.txt_log.setReadOnly(True)
        self.txt_log.setFont(QFont("Consolas", 10))
        layout.addWidget(self.txt_log)

        btn_bar = QHBoxLayout()
        btn_refresh = QPushButton("Refresh")
        btn_refresh.clicked.connect(self.reload_logs)
        btn_bar.addWidget(btn_refresh)

        btn_clear = QPushButton("Clear Logs")
        btn_clear.clicked.connect(self.clear_logs)
        btn_bar.addWidget(btn_clear)

        btn_folder = QPushButton("Open Folder")
        btn_folder.clicked.connect(lambda: subprocess.run(["explorer.exe", LOGS_DIR]))
        btn_bar.addWidget(btn_folder)

        btn_bar.addStretch()

        btn_close = QPushButton("Close")
        btn_close.clicked.connect(self.accept)
        btn_bar.addWidget(btn_close)

        layout.addLayout(btn_bar)
        self.reload_logs()

    def reload_logs(self):
        self.txt_log.setPlainText(logger.get_logs())

    def clear_logs(self):
        if QMessageBox.question(self, "Clear Logs", "Are you sure you want to clear updater logs?") == QMessageBox.StandardButton.Yes:
            logger.clear_logs()
            self.reload_logs()


class UpdateSettingsDialog(QDialog):
    """
    Dedicated Update Settings Dialog satisfying Section 6 of requirements.
    Allows configuring update intervals, automatic downloads, beta builds,
    manual checks, and GitHub repo information.
    """
    update_triggered = pyqtSignal(object)  # Emits ReleaseInfo if user chooses Update Now from manual check

    def __init__(self, parent=None):
        super().__init__(parent)
        self.parent_notch = parent
        self.setWindowTitle("Updates & GitHub Settings")
        self.setFixedSize(480, 560)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowStaysOnTopHint)
        self.setStyleSheet(DARK_STYLESHEET)

        self.config_data = load_config()
        self.checker_thread = None

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(14)

        # 1. Header & Version Card
        header = QLabel("Updates & Maintenance")
        header.setStyleSheet("font-size: 16px; font-weight: 600; color: #ffffff;")
        layout.addWidget(header)

        status_card = QFrame()
        status_card.setStyleSheet("background-color: #141418; border: 1px solid #27272a; border-radius: 8px; padding: 10px;")
        s_layout = QVBoxLayout(status_card)
        s_layout.setSpacing(6)

        row1 = QHBoxLayout()
        self.lbl_version = QLabel(f"Current Version: <b>v{CURRENT_VERSION}</b>")
        self.lbl_version.setStyleSheet("font-size: 13px; color: #f4f4f5;")
        row1.addWidget(self.lbl_version)
        row1.addStretch()

        self.btn_check_now = QPushButton("Check Now")
        self.btn_check_now.setObjectName("primaryBtn")
        self.btn_check_now.clicked.connect(self.manual_check_updates)
        row1.addWidget(self.btn_check_now)
        s_layout.addLayout(row1)

        self.lbl_check_status = QLabel(self.config_data.get("last_check_status", "Not checked recently"))
        self.lbl_check_status.setStyleSheet("font-size: 12px; color: #a1a1aa;")
        self.lbl_check_status.setWordWrap(True)
        s_layout.addWidget(self.lbl_check_status)

        layout.addWidget(status_card)

        # 2. Update Preferences
        pref_group = QGroupBox("Automatic Update Preferences")
        p_layout = QVBoxLayout(pref_group)
        p_layout.setSpacing(10)

        self.chk_auto_check = QCheckBox("Automatically check for updates")
        self.chk_auto_check.setChecked(self.config_data.get("auto_check_updates", True))
        p_layout.addWidget(self.chk_auto_check)

        interval_row = QHBoxLayout()
        interval_row.setContentsMargins(24, 0, 0, 0)
        lbl_interval = QLabel("Check frequency:")
        interval_row.addWidget(lbl_interval)

        self.cmb_interval = QComboBox()
        self.cmb_interval.addItem("Every 1 hour", 1)
        self.cmb_interval.addItem("Every 3 hours", 3)
        self.cmb_interval.addItem("Every 6 hours (Recommended)", 6)
        self.cmb_interval.addItem("Every 12 hours", 12)
        self.cmb_interval.addItem("Daily (24 hours)", 24)
        self.cmb_interval.addItem("Manual check only", 0)

        # Set current selection
        cur_int = self.config_data.get("check_interval_hours", 6)
        idx = self.cmb_interval.findData(cur_int)
        if idx != -1:
            self.cmb_interval.setCurrentIndex(idx)
        interval_row.addWidget(self.cmb_interval)
        interval_row.addStretch()
        p_layout.addLayout(interval_row)

        self.chk_auto_download = QCheckBox("Automatically download updates in the background")
        self.chk_auto_download.setChecked(self.config_data.get("auto_download_updates", False))
        p_layout.addWidget(self.chk_auto_download)

        self.chk_ask_install = QCheckBox("Always ask before installing and restarting")
        self.chk_ask_install.setChecked(self.config_data.get("ask_before_install", True))
        p_layout.addWidget(self.chk_ask_install)

        self.chk_beta = QCheckBox("Include Beta / Pre-release updates")
        self.chk_beta.setChecked(self.config_data.get("include_beta", False))
        p_layout.addWidget(self.chk_beta)

        layout.addWidget(pref_group)

        # 3. GitHub Repository Configuration
        repo_group = QGroupBox("Official GitHub Repository")
        r_layout = QVBoxLayout(repo_group)
        r_layout.setSpacing(8)

        repo_row = QHBoxLayout()
        self.txt_owner = QLineEdit(self.config_data.get("repo_owner", DEFAULT_REPO_OWNER))
        self.txt_owner.setPlaceholderText("Owner (e.g. voiceline-diskrep)")
        self.txt_name = QLineEdit(self.config_data.get("repo_name", DEFAULT_REPO_NAME))
        self.txt_name.setPlaceholderText("Repository (e.g. dynamic-windows)")
        repo_row.addWidget(self.txt_owner)
        repo_row.addWidget(QLabel("/"))
        repo_row.addWidget(self.txt_name)
        r_layout.addLayout(repo_row)

        token_row = QHBoxLayout()
        lbl_token = QLabel("Token (optional):")
        lbl_token.setStyleSheet("color: #71717a; font-size: 11px;")
        token_row.addWidget(lbl_token)
        self.txt_token = QLineEdit(self.config_data.get("github_token", ""))
        self.txt_token.setEchoMode(QLineEdit.EchoMode.Password)
        self.txt_token.setPlaceholderText("Leave empty for public repository")
        token_row.addWidget(self.txt_token)
        r_layout.addLayout(token_row)

        layout.addWidget(repo_group)

        # 4. Utilities (History & Logs)
        util_row = QHBoxLayout()
        btn_history = QPushButton("📜 View Release History")
        btn_history.clicked.connect(self.open_release_history)
        util_row.addWidget(btn_history)

        btn_logs = QPushButton("📄 View Update Logs")
        btn_logs.clicked.connect(self.open_update_logs)
        util_row.addWidget(btn_logs)
        layout.addLayout(util_row)

        # 5. Dialog Actions
        bottom_row = QHBoxLayout()
        bottom_row.addStretch()

        btn_save = QPushButton("Save & Close")
        btn_save.setObjectName("primaryBtn")
        btn_save.clicked.connect(self.save_and_close)
        bottom_row.addWidget(btn_save)

        btn_cancel = QPushButton("Cancel")
        btn_cancel.clicked.connect(self.reject)
        bottom_row.addWidget(btn_cancel)

        layout.addLayout(bottom_row)

    def manual_check_updates(self):
        self.btn_check_now.setEnabled(False)
        self.lbl_check_status.setText("Checking GitHub for the latest releases...")

        # Save temporary repo edits first
        self.config_data["repo_owner"] = self.txt_owner.text().strip() or DEFAULT_REPO_OWNER
        self.config_data["repo_name"] = self.txt_name.text().strip() or DEFAULT_REPO_NAME
        self.config_data["include_beta"] = self.chk_beta.isChecked()
        self.config_data["github_token"] = self.txt_token.text().strip()
        save_config(self.config_data)

        self.checker_thread = UpdateCheckerThread(CURRENT_VERSION)
        self.checker_thread.update_available.connect(self.on_check_update_available)
        self.checker_thread.up_to_date.connect(self.on_check_up_to_date)
        self.checker_thread.error_occurred.connect(self.on_check_error)
        self.checker_thread.start()

    def on_check_update_available(self, release_info: ReleaseInfo):
        self.btn_check_now.setEnabled(True)
        self.lbl_check_status.setText(f"✦ Update available: <b>{release_info.raw_tag}</b>")

        msg_box = QMessageBox(self)
        msg_box.setWindowTitle("Update Available")
        msg_box.setText(
            f"A newer version of Dynamic Windows is available!\n\n"
            f"Current version: v{CURRENT_VERSION}\n"
            f"New version: {release_info.raw_tag}\n\n"
            f"Summary:\n{release_info.summary}\n\n"
            f"Would you like to start the update now?"
        )
        msg_box.setStyleSheet(DARK_STYLESHEET)
        btn_update = msg_box.addButton("Update Now", QMessageBox.ButtonRole.AcceptRole)
        msg_box.addButton("Later", QMessageBox.ButtonRole.RejectRole)
        msg_box.exec()

        if msg_box.clickedButton() == btn_update:
            self.accept()
            if self.parent_notch:
                self.parent_notch.start_update_download(release_info)

    def on_check_up_to_date(self, msg):
        self.btn_check_now.setEnabled(True)
        self.lbl_check_status.setText(f"✓ {msg}")

    def on_check_error(self, err):
        self.btn_check_now.setEnabled(True)
        self.lbl_check_status.setText(f"⚠ {err}")

    def open_release_history(self):
        dlg = ReleaseHistoryDialog(self)
        dlg.exec()

    def open_update_logs(self):
        dlg = UpdateLogsDialog(self)
        dlg.exec()

    def save_and_close(self):
        self.config_data["auto_check_updates"] = self.chk_auto_check.isChecked()
        self.config_data["check_interval_hours"] = self.cmb_interval.currentData()
        self.config_data["auto_download_updates"] = self.chk_auto_download.isChecked()
        self.config_data["ask_before_install"] = self.chk_ask_install.isChecked()
        self.config_data["include_beta"] = self.chk_beta.isChecked()
        self.config_data["repo_owner"] = self.txt_owner.text().strip() or DEFAULT_REPO_OWNER
        self.config_data["repo_name"] = self.txt_name.text().strip() or DEFAULT_REPO_NAME
        self.config_data["github_token"] = self.txt_token.text().strip()
        save_config(self.config_data)

        if self.parent_notch and hasattr(self.parent_notch, "apply_update_settings"):
            self.parent_notch.apply_update_settings()

        self.accept()
