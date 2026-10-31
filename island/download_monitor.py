"""
Dynamic Windows - Real Download Monitor
Monitors Downloads directory (%USERPROFILE%\\Downloads) for active .crdownload,
.part, and temporary download files, tracking real download speed and progression.
"""

import os
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from PyQt6.QtCore import QObject, QTimer, pyqtSignal

DOWNLOADS_DIR = os.path.join(os.environ.get("USERPROFILE", "C:\\"), "Downloads")


@dataclass
class ActiveDownload:
    id: str
    filename: str
    current_bytes: int
    speed_kbps: float
    elapsed_sec: float


class DownloadMonitor(QObject):
    downloads_updated = pyqtSignal(list)  # List[ActiveDownload]

    def __init__(self, parent=None):
        super().__init__(parent)
        self._prev_sizes: Dict[str, Tuple[int, float]] = {}
        self._active_downloads: List[ActiveDownload] = []

        self._timer = QTimer(self)
        self._timer.timeout.connect(self.poll_downloads)
        self._timer.start(1000)

    def poll_downloads(self):
        active: List[ActiveDownload] = []
        now = time.time()

        if os.path.exists(DOWNLOADS_DIR):
            try:
                for f in os.listdir(DOWNLOADS_DIR):
                    if f.lower().endswith((".crdownload", ".part", ".downloading", ".tmp")):
                        p = os.path.join(DOWNLOADS_DIR, f)
                        try:
                            size = os.path.getsize(p)
                            speed_kbps = 0.0

                            if p in self._prev_sizes:
                                prev_size, prev_time = self._prev_sizes[p]
                                dt = max(0.1, now - prev_time)
                                speed_kbps = ((size - prev_size) / 1024.0) / dt
                                if speed_kbps < 0:
                                    speed_kbps = 0.0

                            self._prev_sizes[p] = (size, now)

                            clean_name = f
                            for ext in [".crdownload", ".part", ".downloading", ".tmp"]:
                                if clean_name.lower().endswith(ext):
                                    clean_name = clean_name[:-len(ext)]

                            active.append(ActiveDownload(
                                id=p,
                                filename=clean_name,
                                current_bytes=size,
                                speed_kbps=speed_kbps,
                                elapsed_sec=0.0
                            ))
                        except Exception:
                            continue
            except Exception:
                pass

        # Clean stale cache
        active_paths = {d.id for d in active}
        self._prev_sizes = {p: v for p, v in self._prev_sizes.items() if p in active_paths}

        self._active_downloads = active
        self.downloads_updated.emit(active)

    def get_active_downloads(self) -> List[ActiveDownload]:
        return list(self._active_downloads)
