"""
Dynamic Windows - Calendar & Reminder System
Provides interactive calendar, month navigation, persistent user reminders,
and event scheduling stored in %APPDATA%\\DynamicWindows\\calendar.json.
"""

import os
import json
from datetime import datetime, date
from PyQt6.QtCore import Qt, QDate, pyqtSignal
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QCalendarWidget, QListWidget, QListWidgetItem, QInputDialog,
    QMessageBox
)

from updater_config import APPDATA_DIR

CALENDAR_FILE = os.path.join(APPDATA_DIR, "calendar.json")


class CalendarWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.events = {}
        self.load_events()
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        # Header
        top_row = QHBoxLayout()
        header = QLabel("📅 Calendar & Events")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(header)
        top_row.addStretch()

        btn_add = QPushButton("＋ Add Event")
        btn_add.setStyleSheet("""
            QPushButton {
                background-color: #2563eb;
                color: #ffffff;
                font-weight: 600;
                border-radius: 6px;
                padding: 4px 12px;
                font-size: 11px;
            }
            QPushButton:hover { background-color: #1d4ed8; }
        """)
        btn_add.clicked.connect(self.prompt_add_event)
        top_row.addWidget(btn_add)
        layout.addLayout(top_row)

        # Qt Calendar Widget
        self.cal = QCalendarWidget()
        self.cal.setGridVisible(True)
        self.cal.setStyleSheet("""
            QCalendarWidget QWidget {
                background-color: #121215;
                color: #e4e4e7;
                font-family: 'Segoe UI', sans-serif;
            }
            QCalendarWidget QTableView {
                alternate-background-color: #18181b;
                background-color: #121215;
                selection-background-color: #2563eb;
                selection-color: #ffffff;
            }
            QCalendarWidget QToolButton {
                color: #ffffff;
                background-color: #1f1f24;
                border-radius: 4px;
                margin: 2px;
                padding: 4px;
            }
        """)
        self.cal.selectionChanged.connect(self.on_date_selected)
        layout.addWidget(self.cal)

        # Events list for selected date
        self.lbl_selected_date = QLabel("Events:")
        self.lbl_selected_date.setStyleSheet("font-size: 12px; font-weight: 600; color: #a1a1aa;")
        layout.addWidget(self.lbl_selected_date)

        self.event_list = QListWidget()
        self.event_list.setStyleSheet("""
            QListWidget {
                background-color: #18181b;
                border: 1px solid #27272a;
                border-radius: 8px;
                padding: 4px;
                max-height: 120px;
            }
            QListWidget::item {
                padding: 6px;
                border-radius: 4px;
                color: #f4f4f5;
            }
        """)
        layout.addWidget(self.event_list)

        self.on_date_selected()

    def get_selected_date_str(self) -> str:
        qdate = self.cal.selectedDate()
        return qdate.toString("yyyy-MM-dd")

    def on_date_selected(self):
        d_str = self.get_selected_date_str()
        self.lbl_selected_date.setText(f"Events for {d_str}:")
        self.event_list.clear()

        day_events = self.events.get(d_str, [])
        if not day_events:
            item = QListWidgetItem("No events scheduled for this day.")
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsSelectable)
            self.event_list.addItem(item)
            return

        for idx, ev in enumerate(day_events):
            item = QListWidgetItem(f"• {ev}")
            self.event_list.addItem(item)

    def prompt_add_event(self):
        d_str = self.get_selected_date_str()
        text, ok = QInputDialog.getText(self, "Add Reminder / Event", f"Enter event for {d_str}:")
        if ok and text.strip():
            if d_str not in self.events:
                self.events[d_str] = []
            self.events[d_str].append(text.strip())
            self.save_events()
            self.on_date_selected()

    def load_events(self):
        if os.path.exists(CALENDAR_FILE):
            try:
                with open(CALENDAR_FILE, "r", encoding="utf-8") as f:
                    self.events = json.load(f)
            except Exception:
                self.events = {}

    def save_events(self):
        try:
            with open(CALENDAR_FILE, "w", encoding="utf-8") as f:
                json.dump(self.events, f, indent=2)
        except Exception:
            pass
