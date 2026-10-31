"""
Dynamic Windows - Updater Logger
Handles structured, persistent logging for all update operations.
"""

import os
import sys
import threading
from datetime import datetime
from updater_config import LOGS_DIR

LOG_FILE = os.path.join(LOGS_DIR, "updater.log")
_log_lock = threading.Lock()


def log_event(level: str, message: str):
    """Write an event to updater.log with timestamp and thread safety."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"[{timestamp}] [{level.upper()}] {message}\n"
    
    # Also print to stdout for debugging if running from console
    if not getattr(sys, "frozen", False):
        try:
            print(f"[Updater] {entry.strip()}")
        except Exception:
            pass

    try:
        with _log_lock:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(entry)
    except Exception:
        pass


def info(message: str):
    log_event("INFO", message)


def warning(message: str):
    log_event("WARN", message)


def error(message: str):
    log_event("ERROR", message)


def get_logs(max_lines: int = 200) -> str:
    """Retrieve recent lines from updater.log."""
    if not os.path.exists(LOG_FILE):
        return "No update log entries yet."
    try:
        with _log_lock:
            with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
                return "".join(lines[-max_lines:])
    except Exception as e:
        return f"Error reading logs: {e}"


def clear_logs() -> bool:
    """Clear updater.log contents."""
    try:
        with _log_lock:
            with open(LOG_FILE, "w", encoding="utf-8") as f:
                f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [INFO] Update logs cleared.\n")
        return True
    except Exception:
        return False
