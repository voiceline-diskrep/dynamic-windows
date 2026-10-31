"""
One-Shot Presets Manager
Handles preset storage, retrieval, modification, duplication,
and atomic JSON persistence in %APPDATA%\\DynamicWindows\\presets.json.
"""

import os
import json
import uuid
from typing import List, Dict, Optional
from dataclasses import dataclass, field, asdict

from updater_config import APPDATA_DIR
from oneshot.discovery import DiscoveredApp

PRESETS_FILE = os.path.join(APPDATA_DIR, "presets.json")


@dataclass
class Preset:
    id: str
    name: str
    description: str = ""
    icon: str = "sparkles"
    apps: List[DiscoveredApp] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "apps": [a.to_dict() for a in self.apps]
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'Preset':
        apps = [DiscoveredApp.from_dict(a) for a in data.get("apps", [])]
        return cls(
            id=data.get("id", str(uuid.uuid4())[:8]),
            name=data.get("name", "New Preset"),
            description=data.get("description", ""),
            icon=data.get("icon", "sparkles"),
            apps=apps
        )


DEFAULT_PRESETS = [
    {
        "id": "preset_work",
        "name": "Work & Code",
        "description": "Browser, text editor, terminal",
        "icon": "briefcase",
        "apps": [
            {
                "id": "sys_notepad",
                "name": "Notepad",
                "executable_path": os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "notepad.exe"),
                "launch_delay_ms": 0,
                "launch_mode": "normal",
                "args": "",
                "source": "system"
            },
            {
                "id": "sys_explorer",
                "name": "File Explorer",
                "executable_path": os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "explorer.exe"),
                "launch_delay_ms": 200,
                "launch_mode": "normal",
                "args": "",
                "source": "system"
            }
        ]
    },
    {
        "id": "preset_gaming",
        "name": "Gaming",
        "description": "Discord, Steam, Game Launchers",
        "icon": "gamepad",
        "apps": []
    },
    {
        "id": "preset_creative",
        "name": "Creative Studio",
        "description": "Blender, Photoshop, Design Suite",
        "icon": "palette",
        "apps": [
            {
                "id": "sys_paint",
                "name": "Paint",
                "executable_path": os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "System32", "mspaint.exe"),
                "launch_delay_ms": 0,
                "launch_mode": "normal",
                "args": "",
                "source": "system"
            }
        ]
    }
]


class PresetManager:
    def __init__(self):
        self._presets: List[Preset] = []
        self.load_presets()

    def get_presets(self) -> List[Preset]:
        return list(self._presets)

    def get_preset_by_id(self, preset_id: str) -> Optional[Preset]:
        for p in self._presets:
            if p.id == preset_id:
                return p
        return None

    def add_preset(self, name: str, description: str = "", icon: str = "sparkles", apps: List[DiscoveredApp] = None) -> Preset:
        p_id = f"preset_{uuid.uuid4().hex[:8]}"
        preset = Preset(id=p_id, name=name, description=description, icon=icon, apps=apps or [])
        self._presets.append(preset)
        self.save_presets()
        return preset

    def update_preset(self, preset_id: str, name: str, description: str, icon: str, apps: List[DiscoveredApp]) -> bool:
        for p in self._presets:
            if p.id == preset_id:
                p.name = name
                p.description = description
                p.icon = icon
                p.apps = apps
                self.save_presets()
                return True
        return False

    def duplicate_preset(self, preset_id: str) -> Optional[Preset]:
        src = self.get_preset_by_id(preset_id)
        if not src:
            return None
        new_apps = [DiscoveredApp.from_dict(a.to_dict()) for a in src.apps]
        new_preset = Preset(
            id=f"preset_{uuid.uuid4().hex[:8]}",
            name=f"{src.name} (Copy)",
            description=src.description,
            icon=src.icon,
            apps=new_apps
        )
        self._presets.append(new_preset)
        self.save_presets()
        return new_preset

    def delete_preset(self, preset_id: str) -> bool:
        before = len(self._presets)
        self._presets = [p for p in self._presets if p.id != preset_id]
        if len(self._presets) < before:
            self.save_presets()
            return True
        return False

    def load_presets(self):
        if os.path.exists(PRESETS_FILE):
            try:
                with open(PRESETS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self._presets = [Preset.from_dict(p) for p in data]
                    return
            except Exception:
                pass

        # Load default starter presets
        self._presets = [Preset.from_dict(p) for p in DEFAULT_PRESETS]
        self.save_presets()

    def save_presets(self) -> bool:
        try:
            os.makedirs(APPDATA_DIR, exist_ok=True)
            temp_path = PRESETS_FILE + ".tmp"
            data = [p.to_dict() for p in self._presets]
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            if os.path.exists(PRESETS_FILE):
                os.replace(temp_path, PRESETS_FILE)
            else:
                os.rename(temp_path, PRESETS_FILE)
            return True
        except Exception:
            return False
