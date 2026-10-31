"""
Dynamic Windows - Stickers Tab Widget
Provides sticker collection grid, custom image importing, and Dynamic Island pill docking.
"""

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QIcon, QPixmap
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QGridLayout, QScrollArea, QFileDialog, QFrame, QMessageBox
)

from island.sticker_manager import StickerManager


class StickerWidget(QWidget):
    def __init__(self, sticker_manager: StickerManager, parent=None):
        super().__init__(parent)
        self.sticker_manager = sticker_manager
        self.init_ui()

        self.sticker_manager.active_sticker_changed.connect(self.refresh_grid)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        top_row = QHBoxLayout()
        header = QLabel("✨ Dynamic Island Stickers")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(header)
        top_row.addStretch()

        btn_import = QPushButton("＋ Add Custom Sticker...")
        btn_import.setStyleSheet("""
            QPushButton {
                background-color: #2563eb; color: #ffffff;
                font-weight: 600; border-radius: 6px;
                padding: 4px 12px; font-size: 11px;
            }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        btn_import.clicked.connect(self.import_custom_sticker)
        top_row.addWidget(btn_import)
        layout.addLayout(top_row)

        desc = QLabel("Click any sticker to dock it onto your Dynamic Island pill. Click again to unpin.")
        desc.setStyleSheet("font-size: 11px; color: #a1a1aa;")
        layout.addWidget(desc)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("background: transparent; border: none;")

        self.container = QWidget()
        self.grid = QGridLayout(self.container)
        self.grid.setSpacing(12)
        scroll.setWidget(self.container)
        layout.addWidget(scroll)

        self.refresh_grid()

    def refresh_grid(self, *args):
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        stickers = self.sticker_manager.get_stickers()
        if not stickers:
            lbl_empty = QLabel("No stickers added yet.\nClick 'Add Custom Sticker' above to add any PNG, JPG, or WebP graphic.")
            lbl_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl_empty.setStyleSheet("color: #71717a; font-size: 12px; padding: 30px;")
            self.grid.addWidget(lbl_empty, 0, 0)
            return

        for idx, s_path in enumerate(stickers):
            card = self.create_sticker_card(s_path)
            self.grid.addWidget(card, idx // 4, idx % 4)

    def create_sticker_card(self, s_path: str) -> QFrame:
        card = QFrame()
        is_active = (self.sticker_manager.active_sticker == s_path)
        border_color = "#3b82f6" if is_active else "#27272a"
        card.setStyleSheet(f"""
            QFrame {{
                background-color: #18181c;
                border: 2px solid {border_color};
                border-radius: 8px;
                padding: 6px;
            }}
            QFrame:hover {{ border-color: #60a5fa; }}
        """)
        card.setCursor(Qt.CursorShape.PointingHandCursor)

        l = QVBoxLayout(card)
        l.setContentsMargins(4, 4, 4, 4)
        l.setSpacing(4)

        img_lbl = QLabel()
        pm = QPixmap(s_path).scaled(64, 64, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        img_lbl.setPixmap(pm)
        img_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        l.addWidget(img_lbl)

        card.mousePressEvent = lambda e, p=s_path: self.toggle_sticker(p)
        return card

    def toggle_sticker(self, s_path: str):
        if self.sticker_manager.active_sticker == s_path:
            self.sticker_manager.set_active_sticker("")
        else:
            self.sticker_manager.set_active_sticker(s_path)

    def import_custom_sticker(self):
        fpath, _ = QFileDialog.getOpenFileName(
            self, "Import Sticker", "",
            "Images (*.png *.jpg *.jpeg *.webp *.gif *.svg);;All Files (*.*)"
        )
        if fpath:
            imported = self.sticker_manager.import_sticker(fpath)
            if imported:
                self.refresh_grid()
            else:
                QMessageBox.warning(self, "Import Error", "Failed to copy sticker to application folder.")
