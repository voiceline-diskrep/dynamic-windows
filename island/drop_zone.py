"""
Dynamic Windows - Persistent Drop Zone & File Shelf
Provides persistent file storage in %APPDATA%\\DynamicWindows\\drop_zone,
drag-and-drop ingestion, revealing in Explorer, opening, and storage usage tracking.
"""

import os
import shutil
import subprocess
from PyQt6.QtCore import Qt, QUrl, QMimeData, QFileInfo, pyqtSignal
from PyQt6.QtGui import QIcon, QDrag
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QListWidget, QListWidgetItem, QFileIconProvider, QMessageBox,
    QProgressBar, QMenu, QFrame
)

from updater_config import DROP_ZONE_DIR


class DropZoneWidget(QWidget):
    storage_updated = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.icon_provider = QFileIconProvider()
        os.makedirs(DROP_ZONE_DIR, exist_ok=True)

        self.init_ui()
        self.refresh_files()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        # Header
        top_row = QHBoxLayout()
        header = QLabel("📦 Drop Zone Shelf")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(header)
        top_row.addStretch()

        btn_open_folder = QPushButton("Open Folder ↗")
        btn_open_folder.setStyleSheet("""
            QPushButton {
                background-color: #1f1f24;
                color: #e4e4e7;
                border: 1px solid #3f3f46;
                border-radius: 6px;
                padding: 4px 10px;
                font-size: 11px;
            }
            QPushButton:hover { background-color: #27272a; }
        """)
        btn_open_folder.clicked.connect(lambda: subprocess.run(["explorer.exe", DROP_ZONE_DIR]))
        top_row.addWidget(btn_open_folder)
        layout.addLayout(top_row)

        # Drop Target Box
        self.drop_target = QFrame()
        self.drop_target.setStyleSheet("""
            QFrame {
                border: 2px dashed #3f3f46;
                border-radius: 10px;
                background-color: rgba(24, 24, 27, 0.4);
                padding: 12px;
            }
        """)
        dt_layout = QVBoxLayout(self.drop_target)
        lbl_hint = QLabel("Drag & drop any files or folders here to pin them")
        lbl_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lbl_hint.setStyleSheet("color: #a1a1aa; font-size: 12px;")
        dt_layout.addWidget(lbl_hint)
        layout.addWidget(self.drop_target)

        # File List
        self.file_list = QListWidget()
        self.file_list.setStyleSheet("""
            QListWidget {
                background-color: #18181b;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 4px;
            }
            QListWidget::item {
                padding: 6px 10px;
                border-radius: 4px;
                color: #f4f4f5;
                font-size: 12px;
            }
            QListWidget::item:selected {
                background-color: #27272a;
                color: #38bdf8;
            }
        """)
        self.file_list.itemDoubleClicked.connect(self.open_selected_file)
        self.file_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.file_list.customContextMenuRequested.connect(self.show_context_menu)
        layout.addWidget(self.file_list)

        # Storage Status Bar
        storage_box = QHBoxLayout()
        self.lbl_storage = QLabel("Used: 0 MB")
        self.lbl_storage.setStyleSheet("font-size: 11px; color: #71717a;")
        storage_box.addWidget(self.lbl_storage)

        storage_box.addStretch()

        btn_clear = QPushButton("Clear All")
        btn_clear.setStyleSheet("background: transparent; color: #ef4444; font-size: 11px; border: none;")
        btn_clear.clicked.connect(self.clear_all_files)
        storage_box.addWidget(btn_clear)
        layout.addLayout(storage_box)

    def refresh_files(self):
        self.file_list.clear()
        total_size = 0

        if os.path.exists(DROP_ZONE_DIR):
            entries = os.listdir(DROP_ZONE_DIR)
            for fname in sorted(entries):
                fpath = os.path.join(DROP_ZONE_DIR, fname)
                try:
                    fsize = os.path.getsize(fpath)
                    total_size += fsize
                    size_str = f"{fsize / 1024:.1f} KB" if fsize < 1024*1024 else f"{fsize / (1024*1024):.1f} MB"
                except Exception:
                    size_str = ""

                item = QListWidgetItem(f"{fname}  ({size_str})")
                item.setIcon(self.icon_provider.icon(QFileInfo(fpath)))
                item.setData(Qt.ItemDataRole.UserRole, fpath)
                self.file_list.addItem(item)

        total_mb = total_size / (1024 * 1024)
        self.lbl_storage.setText(f"Drop Zone Storage: {total_mb:.2f} MB used")
        self.storage_updated.emit()

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
            self.drop_target.setStyleSheet("border: 2px dashed #3b82f6; background-color: rgba(37, 99, 235, 0.15); border-radius: 10px;")

    def dragLeaveEvent(self, event):
        self.drop_target.setStyleSheet("border: 2px dashed #3f3f46; background-color: rgba(24, 24, 27, 0.4); border-radius: 10px;")

    def dropEvent(self, event):
        self.drop_target.setStyleSheet("border: 2px dashed #3f3f46; background-color: rgba(24, 24, 27, 0.4); border-radius: 10px;")
        urls = event.mimeData().urls()
        for url in urls:
            src = url.toLocalFile()
            if src and os.path.exists(src):
                dest_name = os.path.basename(src)
                dest = os.path.join(DROP_ZONE_DIR, dest_name)
                # Handle duplicate filenames safely
                base, ext = os.path.splitext(dest_name)
                counter = 1
                while os.path.exists(dest):
                    dest = os.path.join(DROP_ZONE_DIR, f"{base}_{counter}{ext}")
                    counter += 1

                try:
                    if os.path.isdir(src):
                        shutil.copytree(src, dest)
                    else:
                        shutil.copy2(src, dest)
                except Exception as e:
                    QMessageBox.warning(self, "Copy Error", f"Failed to store {dest_name}: {e}")

        self.refresh_files()
        event.acceptProposedAction()

    def open_selected_file(self, item):
        path = item.data(Qt.ItemDataRole.UserRole)
        if path and os.path.exists(path):
            os.startfile(path)

    def show_context_menu(self, pos):
        item = self.file_list.itemAt(pos)
        if not item:
            return
        path = item.data(Qt.ItemDataRole.UserRole)

        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu { background-color: #121215; color: #e4e4e7; border: 1px solid #27272a; padding: 4px; }
            QMenu::item { padding: 6px 16px; border-radius: 4px; }
            QMenu::item:selected { background-color: #27272a; }
        """)

        act_open = menu.addAction("Open File")
        act_open.triggered.connect(lambda: os.startfile(path))

        act_reveal = menu.addAction("Reveal in Explorer")
        act_reveal.triggered.connect(lambda: subprocess.run(["explorer.exe", f"/select,{path}"]))

        act_delete = menu.addAction("Remove from Shelf")
        act_delete.triggered.connect(lambda: self.remove_file(path))

        menu.exec(self.file_list.mapToGlobal(pos))

    def remove_file(self, path):
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
            else:
                os.remove(path)
            self.refresh_files()
        except Exception as e:
            QMessageBox.warning(self, "Error", f"Failed to delete file: {e}")

    def clear_all_files(self):
        if QMessageBox.question(self, "Clear Drop Zone", "Permanently remove all files from Drop Zone?") == QMessageBox.StandardButton.Yes:
            for f in os.listdir(DROP_ZONE_DIR):
                p = os.path.join(DROP_ZONE_DIR, f)
                try:
                    if os.path.isdir(p):
                        shutil.rmtree(p)
                    else:
                        os.remove(p)
                except Exception:
                    pass
            self.refresh_files()
