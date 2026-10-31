"""
One-Shot Application Launcher Package
"""
from oneshot.discovery import AppDiscoveryEngine, DiscoveredApp
from oneshot.presets import PresetManager, Preset
from oneshot.launcher import AppLaunchEngine, LaunchResult
from oneshot.startup_takeover import StartupTakeoverWindow, is_startup_enabled, set_startup_enabled
from oneshot.ui import OneShotWidget, PresetEditorDialog, AppPickerDialog
