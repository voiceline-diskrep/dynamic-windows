"""
Dynamic Windows - Notification Monitor & History
Manages system notification queue, application-specific formatting (WhatsApp, Discord, etc.),
and notification history with dismiss actions.
"""

import time
from typing import List, Dict, Optional
from dataclasses import dataclass
from PyQt6.QtCore import QObject, pyqtSignal


@dataclass
class NotificationItem:
    id: str
    app_name: str
    title: str
    body: str
    timestamp: float
    icon_name: str = "bell"


class NotificationMonitor(QObject):
    notification_received = pyqtSignal(object)  # NotificationItem
    queue_updated = pyqtSignal(list)           # List[NotificationItem]

    def __init__(self, parent=None):
        super().__init__(parent)
        self._history: List[NotificationItem] = []
        self._active_queue: List[NotificationItem] = []

    def push_notification(self, app_name: str, title: str, body: str, icon_name: str = "bell") -> NotificationItem:
        item = NotificationItem(
            id=f"notif_{time.time()}_{len(self._history)}",
            app_name=app_name,
            title=title,
            body=body,
            timestamp=time.time(),
            icon_name=icon_name
        )
        self._history.insert(0, item)
        self._active_queue.append(item)
        self.notification_received.emit(item)
        self.queue_updated.emit(self._active_queue)
        return item

    def dismiss(self, notif_id: str):
        self._active_queue = [n for n in self._active_queue if n.id != notif_id]
        self.queue_updated.emit(self._active_queue)

    def clear_all(self):
        self._active_queue.clear()
        self.queue_updated.emit(self._active_queue)

    def get_history(self) -> List[NotificationItem]:
        return list(self._history)

    def get_active_queue(self) -> List[NotificationItem]:
        return list(self._active_queue)
