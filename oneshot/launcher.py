"""
One-Shot Application Launch Engine
Executes applications in a preset sequentially with per-app delays,
command line argument tokenization, normal/minimized modes, and non-blocking detached processes.
"""

import os
import sys
import time
import shlex
import subprocess
from typing import List, Dict, Tuple
from dataclasses import dataclass

from PyQt6.QtCore import QThread, pyqtSignal

from oneshot.presets import Preset
from oneshot.discovery import DiscoveredApp

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
SW_SHOWMINIMIZED = 2
SW_SHOWNORMAL = 1


@dataclass
class LaunchResult:
    preset_id: str
    preset_name: str
    total: int
    succeeded: int
    failed: int
    errors: List[str]


class PresetLauncherThread(QThread):
    """Background worker that executes apps with delays without freezing the UI."""
    launch_progress = pyqtSignal(str, int, int)  # app_name, current_index, total
    launch_completed = pyqtSignal(object)       # LaunchResult

    def __init__(self, preset: Preset):
        super().__init__()
        self.preset = preset

    def run(self):
        errors: List[str] = []
        succeeded = 0
        total = len(self.preset.apps)

        for idx, app_item in enumerate(self.preset.apps):
            self.launch_progress.emit(app_item.name, idx + 1, total)

            # Apply per-app launch delay
            if app_item.launch_delay_ms > 0 and idx > 0:
                time.sleep(app_item.launch_delay_ms / 1000.0)

            success, err_msg = self.launch_single_app(app_item)
            if success:
                succeeded += 1
            else:
                errors.append(f"{app_item.name}: {err_msg}")

        result = LaunchResult(
            preset_id=self.preset.id,
            preset_name=self.preset.name,
            total=total,
            succeeded=succeeded,
            failed=len(errors),
            errors=errors
        )
        self.launch_completed.emit(result)

    def launch_single_app(self, app_item: DiscoveredApp) -> Tuple[bool, str]:
        path = app_item.executable_path
        if not path:
            return False, "Executable path is empty"
        if not os.path.exists(path):
            return False, f"File not found: {path}"

        cwd = os.path.dirname(path)
        is_script = path.lower().endswith((".bat", ".cmd"))
        is_minimized = app_item.launch_mode == "minimized"

        # Parse custom arguments
        args = []
        if app_item.args and app_item.args.strip():
            try:
                args = shlex.split(app_item.args)
            except Exception:
                args = app_item.args.strip().split()

        try:
            startupinfo = None
            if sys.platform == "win32" and is_minimized:
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = SW_SHOWMINIMIZED

            if is_script:
                cmd_line = ["cmd.exe", "/c", path] + args
                subprocess.Popen(
                    cmd_line,
                    cwd=cwd,
                    startupinfo=startupinfo,
                    creationflags=DETACHED_PROCESS,
                    close_fds=True
                )
            else:
                cmd_line = [path] + args
                subprocess.Popen(
                    cmd_line,
                    cwd=cwd,
                    startupinfo=startupinfo,
                    creationflags=DETACHED_PROCESS,
                    close_fds=True
                )
            return True, ""
        except Exception as e:
            return False, str(e)


class AppLaunchEngine:
    def __init__(self):
        self._active_launchers: Dict[str, PresetLauncherThread] = {}

    def launch_preset(self, preset: Preset, on_completed=None, on_progress=None) -> bool:
        """Launch preset asynchronously with non-blocking thread."""
        if preset.id in self._active_launchers and self._active_launchers[preset.id].isRunning():
            return False  # Already launching this preset

        thread = PresetLauncherThread(preset)
        self._active_launchers[preset.id] = thread

        if on_progress:
            thread.launch_progress.connect(on_progress)

        def _cleanup(res):
            if preset.id in self._active_launchers:
                del self._active_launchers[preset.id]
            if on_completed:
                on_completed(res)

        thread.launch_completed.connect(_cleanup)
        thread.start()
        return True
