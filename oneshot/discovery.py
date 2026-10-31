"""
One-Shot Application Discovery Engine
Scans Windows Start Menu, Registry, and standard system paths to automatically
discover installed applications, resolve .lnk shortcuts, extract icons via Qt,
and filter out helper/uninstaller binaries.
"""

import os
import sys
import glob
import hashlib
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict

from PyQt6.QtCore import QFileInfo
from PyQt6.QtWidgets import QFileIconProvider, QFileDialog
from PyQt6.QtGui import QIcon, QPixmap

@dataclass
class DiscoveredApp:
    id: str
    name: str
    executable_path: str
    icon_data_uri: Optional[str] = None
    launch_delay_ms: int = 0
    launch_mode: str = "normal"  # "normal" or "minimized"
    args: str = ""
    source: str = "startMenu"    # "startMenu", "system", or "manual"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> 'DiscoveredApp':
        return cls(
            id=data.get("id", ""),
            name=data.get("name", "Unknown App"),
            executable_path=data.get("executable_path", ""),
            icon_data_uri=data.get("icon_data_uri"),
            launch_delay_ms=data.get("launch_delay_ms", 0),
            launch_mode=data.get("launch_mode", "normal"),
            args=data.get("args", ""),
            source=data.get("source", "startMenu")
        )


class AppDiscoveryEngine:
    def __init__(self):
        self._cached_apps: List[DiscoveredApp] = []
        self._icon_provider = QFileIconProvider()

    def discover_applications(self, force_refresh: bool = False) -> List[DiscoveredApp]:
        """Discover installed applications from Start Menu and standard system paths."""
        if self._cached_apps and not force_refresh:
            return self._cached_apps

        discovered: Dict[str, DiscoveredApp] = {}

        # 1. Standard System Applications
        system_candidates = [
            ("File Explorer", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "explorer.exe")),
            ("Notepad", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "notepad.exe")),
            ("Paint", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "mspaint.exe")),
            ("Calculator", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "calc.exe")),
            ("Task Manager", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "Taskmgr.exe")),
            ("Command Prompt", os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "cmd.exe")),
            ("Windows Terminal", os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WindowsApps", "wt.exe")),
        ]

        for name, path in system_candidates:
            if os.path.exists(path):
                norm = os.path.normpath(path).lower()
                app_id = f"sys_{hashlib.md5(norm.encode()).hexdigest()[:12]}"
                discovered[norm] = DiscoveredApp(
                    id=app_id,
                    name=name,
                    executable_path=path,
                    source="system"
                )

        # 2. Start Menu Shortcuts (.lnk files)
        start_menu_dirs = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            user_programs = os.path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs")
            if os.path.exists(user_programs):
                start_menu_dirs.append(user_programs)

        programdata = os.environ.get("PROGRAMDATA", "C:\\ProgramData")
        common_programs = os.path.join(programdata, "Microsoft", "Windows", "Start Menu", "Programs")
        if os.path.exists(common_programs):
            start_menu_dirs.append(common_programs)

        # Helper to resolve shortcut target via WScript.Shell
        wscript_shell = None
        try:
            import win32com.client
            wscript_shell = win32com.client.Dispatch("WScript.Shell")
        except Exception:
            try:
                import comtypes.client
                wscript_shell = comtypes.client.CreateObject("WScript.Shell")
            except Exception:
                pass

        for s_dir in start_menu_dirs:
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if not f.lower().endswith(".lnk"):
                        continue
                    lnk_path = os.path.join(root, f)
                    base_name = os.path.splitext(f)[0]
                    lower_name = base_name.lower()

                    # Filter out uninstallers, helpers, crashpad, web links
                    if any(bad in lower_name for bad in [
                        "uninstall", "remove", "helper", "crashpad", "update", "setup",
                        "help", "documentation", "readme", "website"
                    ]):
                        continue

                    target_path = None
                    if wscript_shell:
                        try:
                            sc = wscript_shell.CreateShortcut(lnk_path)
                            target = sc.TargetPath
                            if target and os.path.exists(target) and target.lower().endswith(".exe"):
                                target_path = target
                        except Exception:
                            pass

                    # Fallback if shortcut resolver is unavailable
                    if not target_path and os.path.exists(lnk_path):
                        # Use shortcut itself or inspect
                        target_path = lnk_path

                    if target_path and os.path.exists(target_path):
                        norm = os.path.normpath(target_path).lower()
                        if norm not in discovered:
                            app_id = f"app_{hashlib.md5(norm.encode()).hexdigest()[:12]}"
                            discovered[norm] = DiscoveredApp(
                                id=app_id,
                                name=base_name,
                                executable_path=target_path,
                                source="startMenu"
                            )

        # Sort alphabetically
        self._cached_apps = sorted(discovered.values(), key=lambda a: a.name.lower())
        return self._cached_apps

    def get_app_icon(self, executable_path: str) -> QIcon:
        """Extract native icon for executable or file via Qt."""
        if not executable_path or not os.path.exists(executable_path):
            return QIcon()
        return self._icon_provider.icon(QFileInfo(executable_path))

    def browse_for_custom_executable(self, parent=None) -> Optional[DiscoveredApp]:
        """Allow user to manually pick an executable or script."""
        file_path, _ = QFileDialog.getOpenFileName(
            parent,
            "Select Application Executable",
            os.environ.get("PROGRAMFILES", "C:\\Program Files"),
            "Executables (*.exe *.bat *.cmd *.lnk);;All Files (*.*)"
        )
        if not file_path or not os.path.exists(file_path):
            return None

        base_name = os.path.splitext(os.path.basename(file_path))[0]
        norm = os.path.normpath(file_path).lower()
        app_id = f"custom_{hashlib.md5(norm.encode()).hexdigest()[:12]}"
        return DiscoveredApp(
            id=app_id,
            name=base_name,
            executable_path=file_path,
            source="manual"
        )
