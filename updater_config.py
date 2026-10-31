"""
Dynamic Windows - Updater Configuration & Paths
Handles configuration loading, persistence in standard Windows AppData,
and migration from legacy configuration paths.
"""

import os
import json
import logging

APP_NAME = "Dynamic Windows"
CURRENT_VERSION = "1.0.3"

# Official GitHub repository defaults
DEFAULT_REPO_OWNER = "voiceline-diskrep"
DEFAULT_REPO_NAME = "dynamic-windows"

# Standard Windows application directories to ensure data persists across updates
APPDATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "DynamicWindows")
LOCALAPPDATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "DynamicWindows")

# Ensure required persistent directories exist
for directory in [
    APPDATA_DIR,
    LOCALAPPDATA_DIR,
    os.path.join(APPDATA_DIR, "drop_zone"),
    os.path.join(APPDATA_DIR, "integrations"),
    os.path.join(LOCALAPPDATA_DIR, "updates"),
    os.path.join(LOCALAPPDATA_DIR, "logs"),
]:
    try:
        os.makedirs(directory, exist_ok=True)
    except Exception:
        pass

CONFIG_FILE = os.path.join(APPDATA_DIR, "config.json")
DROP_ZONE_DIR = os.path.join(APPDATA_DIR, "drop_zone")
INTEGRATIONS_DIR = os.path.join(APPDATA_DIR, "integrations")
UPDATES_DIR = os.path.join(LOCALAPPDATA_DIR, "updates")
LOGS_DIR = os.path.join(LOCALAPPDATA_DIR, "logs")

# Legacy config file alongside python script
LEGACY_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# Default settings
DEFAULT_CONFIG = {
    # UI & Display settings
    "mode": "floating",
    "is_24h": False,
    "show_seconds": True,
    "speed_preset": "normal",
    "expand_duration": 280,
    "collapse_duration": 220,
    "offset_x": 0,

    # Update Settings
    "auto_check_updates": True,
    "check_interval_hours": 6,           # 1, 3, 6, 12, 24, 0 (0 = manual)
    "auto_download_updates": False,       # Automatically download when detected
    "ask_before_install": True,          # Always ask before installing
    "include_beta": False,               # Include pre-release versions
    "repo_owner": DEFAULT_REPO_OWNER,
    "repo_name": DEFAULT_REPO_NAME,
    "github_token": "",                  # Optional token for private repos or rate limits
    "last_check_time": 0,
    "last_check_status": "Never checked",
    "ignored_version": "",               # If user clicked "Remind me later" for this version
}


def load_config() -> dict:
    """Load configuration from APPDATA_DIR, migrating from legacy path if needed."""
    cfg = dict(DEFAULT_CONFIG)

    # 1. Check if legacy config exists and migrate if target does not exist yet
    if not os.path.exists(CONFIG_FILE) and os.path.exists(LEGACY_CONFIG_FILE):
        try:
            with open(LEGACY_CONFIG_FILE, "r", encoding="utf-8") as f:
                legacy_data = json.load(f)
                cfg.update(legacy_data)
            save_config(cfg)
            return cfg
        except Exception:
            pass

    # 2. Load from standard APPDATA_DIR
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                cfg.update(loaded)
        except Exception as e:
            logging.error(f"Error loading config from {CONFIG_FILE}: {e}")

    return cfg


def save_config(cfg: dict) -> bool:
    """Safely persist configuration to APPDATA_DIR."""
    try:
        os.makedirs(APPDATA_DIR, exist_ok=True)
        temp_file = CONFIG_FILE + ".tmp"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        if os.path.exists(CONFIG_FILE):
            os.replace(temp_file, CONFIG_FILE)
        else:
            os.rename(temp_file, CONFIG_FILE)
        return True
    except Exception as e:
        logging.error(f"Error saving config to {CONFIG_FILE}: {e}")
        return False
