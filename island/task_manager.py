"""
Dynamic Windows - System Task Manager
Monitors real Windows CPU, Memory, Disk, Network metrics,
displays running processes, and provides safe process termination with safeguards.
"""

import psutil
from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QHeaderView, QLineEdit,
    QProgressBar, QMessageBox
)

CRITICAL_SYSTEM_PROCESSES = {
    "system", "system idle process", "csrss.exe", "explorer.exe",
    "services.exe", "lsass.exe", "smss.exe", "winlogon.exe",
    "svchost.exe", "fontdrvhost.exe", "dwm.exe"
}


class TaskManagerWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()

        # Update metrics every 1.5 seconds
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.refresh_metrics)
        self._timer.start(1500)
        self.refresh_metrics()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        # Header
        top_row = QHBoxLayout()
        header = QLabel("📊 Windows Task Manager & Diagnostics")
        header.setStyleSheet("font-size: 15px; font-weight: 600; color: #ffffff;")
        top_row.addWidget(header)
        top_row.addStretch()

        self.btn_refresh = QPushButton("Refresh Now")
        self.btn_refresh.setStyleSheet("""
            QPushButton {
                background-color: #1f1f24; color: #e4e4e7;
                border: 1px solid #3f3f46; border-radius: 6px;
                padding: 4px 10px; font-size: 11px;
            }
            QPushButton:hover { background-color: #27272a; }
        """)
        self.btn_refresh.clicked.connect(self.refresh_metrics)
        top_row.addWidget(self.btn_refresh)
        layout.addLayout(top_row)

        # System Resource Glance Cards
        metrics_row = QHBoxLayout()
        metrics_row.setSpacing(10)

        self.cpu_card = self.create_metric_card("CPU Load", "0%")
        self.ram_card = self.create_metric_card("RAM Usage", "0%")
        self.disk_card = self.create_metric_card("Disk Used", "0%")

        metrics_row.addWidget(self.cpu_card[0])
        metrics_row.addWidget(self.ram_card[0])
        metrics_row.addWidget(self.disk_card[0])
        layout.addLayout(metrics_row)

        # Search Bar & End Task Button
        bar_row = QHBoxLayout()
        self.txt_search = QLineEdit()
        self.txt_search.setPlaceholderText("Filter processes by name or PID...")
        self.txt_search.setStyleSheet("""
            QLineEdit {
                background-color: #18181b; color: #ffffff;
                border: 1px solid #27272a; border-radius: 6px;
                padding: 6px 10px; font-size: 12px;
            }
        """)
        self.txt_search.textChanged.connect(self.filter_processes)
        bar_row.addWidget(self.txt_search)

        self.btn_end_task = QPushButton("End Task")
        self.btn_end_task.setStyleSheet("""
            QPushButton {
                background-color: #991b1b; color: #ffffff;
                font-weight: 600; border-radius: 6px;
                padding: 6px 14px; font-size: 12px;
            }
            QPushButton:hover { background-color: #dc2626; }
        """)
        self.btn_end_task.clicked.connect(self.confirm_end_task)
        bar_row.addWidget(self.btn_end_task)
        layout.addLayout(bar_row)

        # Process Table
        self.proc_table = QTableWidget()
        self.proc_table.setColumnCount(4)
        self.proc_table.setHorizontalHeaderLabels(["Name", "PID", "CPU %", "Memory (MB)"])
        self.proc_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.proc_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.proc_table.setStyleSheet("""
            QTableWidget {
                background-color: #121215;
                color: #e4e4e7;
                border: 1px solid #27272a;
                border-radius: 8px;
                gridline-color: #1f1f24;
                font-size: 11px;
            }
            QHeaderView::section {
                background-color: #18181b;
                color: #a1a1aa;
                padding: 4px;
                border: none;
                font-weight: 600;
            }
            QTableWidget::item:selected {
                background-color: #2563eb;
                color: #ffffff;
            }
        """)
        layout.addWidget(self.proc_table)

    def create_metric_card(self, title: str, init_val: str):
        card = QWidget()
        card.setStyleSheet("background-color: #18181c; border: 1px solid #27272a; border-radius: 8px; padding: 6px;")
        l = QVBoxLayout(card)
        l.setContentsMargins(8, 6, 8, 6)
        l.setSpacing(4)
        t_lbl = QLabel(title)
        t_lbl.setStyleSheet("font-size: 11px; color: #a1a1aa;")
        v_lbl = QLabel(init_val)
        v_lbl.setStyleSheet("font-size: 16px; font-weight: 700; color: #ffffff;")
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setValue(0)
        bar.setTextVisible(False)
        bar.setFixedHeight(4)
        bar.setStyleSheet("QProgressBar { background-color: #27272a; border-radius: 2px; } QProgressBar::chunk { background-color: #3b82f6; border-radius: 2px; }")
        l.addWidget(t_lbl)
        l.addWidget(v_lbl)
        l.addWidget(bar)
        return (card, v_lbl, bar)

    def refresh_metrics(self):
        # 1. Update Resource Cards
        try:
            cpu = psutil.cpu_percent(interval=None)
            self.cpu_card[1].setText(f"{cpu:.1f}%")
            self.cpu_card[2].setValue(int(cpu))

            ram = psutil.virtual_memory()
            self.ram_card[1].setText(f"{ram.percent:.1f}% ({ram.used / (1024**3):.1f} GB)")
            self.ram_card[2].setValue(int(ram.percent))

            disk = psutil.disk_usage("C:\\")
            self.disk_card[1].setText(f"{disk.percent:.1f}% ({disk.free / (1024**3):.0f} GB Free)")
            self.disk_card[2].setValue(int(disk.percent))
        except Exception:
            pass

        # 2. Update Process Table if not actively searching
        if not self.txt_search.text().strip():
            self.populate_processes()

    def populate_processes(self, filter_query: str = ""):
        procs = []
        for p in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info']):
            try:
                info = p.info
                name = info['name'] or "Unknown"
                if filter_query and filter_query.lower() not in name.lower() and str(info['pid']) != filter_query:
                    continue
                mem_mb = (info['memory_info'].rss / (1024 * 1024)) if info['memory_info'] else 0
                procs.append((name, info['pid'], info['cpu_percent'] or 0.0, mem_mb))
            except Exception:
                continue

        # Sort by memory descending
        procs.sort(key=lambda x: x[3], reverse=True)
        procs = procs[:50]  # Show top 50

        self.proc_table.setRowCount(len(procs))
        for row, p in enumerate(procs):
            self.proc_table.setItem(row, 0, QTableWidgetItem(p[0]))
            self.proc_table.setItem(row, 1, QTableWidgetItem(str(p[1])))
            self.proc_table.setItem(row, 2, QTableWidgetItem(f"{p[2]:.1f}%"))
            self.proc_table.setItem(row, 3, QTableWidgetItem(f"{p[3]:.1f} MB"))

    def filter_processes(self, query):
        self.populate_processes(query.strip())

    def confirm_end_task(self):
        row = self.proc_table.currentRow()
        if row < 0:
            QMessageBox.information(self, "End Task", "Please select a process from the table.")
            return

        name = self.proc_table.item(row, 0).text()
        pid_str = self.proc_table.item(row, 1).text()

        # Protection for critical processes
        if name.lower() in CRITICAL_SYSTEM_PROCESSES:
            QMessageBox.critical(
                self, "Protected System Process",
                f"Cannot terminate '{name}'. This is a critical Windows system process required for operating system stability."
            )
            return

        res = QMessageBox.warning(
            self, "Confirm End Task",
            f"Are you sure you want to terminate '{name}' (PID: {pid_str})?\nUnsaved data in this application may be lost.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if res == QMessageBox.StandardButton.Yes:
            try:
                p = psutil.Process(int(pid_str))
                p.terminate()
                self.refresh_metrics()
            except Exception as e:
                QMessageBox.warning(self, "Error", f"Failed to terminate process: {e}")
