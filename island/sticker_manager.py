"""
Dynamic Windows - Sticker System
Manages custom image stickers, built-in sticker badges, and Dynamic Island pill docking.
"""

import os
import shutil
from typing import List, Optional
from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtGui import QPixmap, QIcon

from updater_config import APPDATA_DIR

STICKERS_DIR = os.path.join(APPDATA_DIR, "stickers")


class StickerManager(QObject):
    active_sticker_changed = pyqtSignal(str)  # sticker_path or ""

    def __init__(self, parent=None):
        super().__init__(parent)
        os.makedirs(STICKERS_DIR, exist_ok=True)
        self.active_sticker: Optional[str] = None
        self._ensure_built_in_stickers()

    def _ensure_built_in_stickers(self):
        """Ensure sample stickers exist if empty."""
        pass

    def get_stickers(self) -> List[str]:
        """Return list of file paths to installed stickers."""
        stickers = []
        if os.path.exists(STICKERS_DIR):
            for f in os.listdir(STICKERS_DIR):
                if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")):
                    stickers.append(os.path.join(STICKERS_DIR, f))
        return sorted(stickers)

    def import_sticker(self, src_path: str) -> Optional[str]:
        """Copy a custom image file into the stickers directory."""
        if not os.path.exists(src_path):
            return None
        dest_name = os.path.basename(src_path)
        dest_path = os.path.join(STICKERS_DIR, dest_name)
        try:
            shutil.copy2(src_path, dest_path)
            return dest_path
        except Exception:
            return None

    def set_active_sticker(self, sticker_path: str):
        self.active_sticker = sticker_path if sticker_path and os.path.exists(sticker_path) else None
        self.active_sticker_changed.emit(self.active_sticker or "")

    def remove_sticker(self, sticker_path: str) -> bool:
        try:
            if os.path.exists(sticker_path):
                os.remove(sticker_path)
                if self.active_sticker == sticker_path:
                    self.set_active_sticker("")
                return True
        except Exception:
            pass
        return False
