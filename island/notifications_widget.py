"""
Dynamic Windows - Notifications Tab Widget
Displays system notifications, application badges, and dismiss controls.
"""

from datetime import datetime
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QListWidget, QListWidgetItem, QFrame
)

from island.notification_monitor import NotificationMonitor, NotificationItem


class NotificationsWidget(QWidget):
    def __init__(self, notif_monitor: NotificationMonitor, parent=None):
        super().__init__(parent)
        self.notif_monitor = notif_monitor
        self.init_ui()

        self.notif_monitor.queue_updated.connect(self.refresh_list)

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        top_row = QHBoxLayout()
        header = QLabel("🔔 Notifications & Alerts")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(header)
        top_row.addStretch()

        btn_clear = QPushButton("Clear All")
        btn_clear.setStyleSheet("background: transparent; color: #ef4444; font-size: 11px; border: none;")
        btn_clear.clicked.connect(self.notif_monitor.clear_all)
        top_row.addWidget(btn_clear)
        layout.addLayout(top_row)

        self.list_widget = QListWidget()
        self.list_widget.setStyleSheet("""
            QListWidget {
                background-color: #18181b; border: 1px solid #27272a;
                border-radius: 8px; padding: 4px;
            }
            QListWidget::item {
                padding: 8px 10px; border-radius: 6px;
                color: #f4f4f5; font-size: 12px;
            }
        """)
        layout.addWidget(self.list_widget)

        self.refresh_list()

    def refresh_list(self, *args):
        self.list_widget.clear()
        queue = self.notif_monitor.get_active_queue()

        if not queue:
            item = QListWidgetItem("No notifications right now.\nNew notifications from Windows applications will appear here.")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsSelectable)
            self.list_widget.addItem(item)
            return

        for notif in queue:
            time_str = datetime.fromtimestamp(notif.timestamp).strftime("%H:%M")
            item = QListWidgetItem(f"[{notif.app_name}] {notif.title}\n{notif.body}  ({time_str})")
            item.setData(Qt.ItemDataRole.UserRole, notif.id)
            self.list_widget.addItem(item)
