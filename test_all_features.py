"""
Comprehensive Integration Test Suite for Dynamic Windows + One-Shot
Verifies all major features across Part A, B, C, D, E, F, G, H, I, J, K.
"""

import os
import sys
import unittest

os.environ['QT_QPA_PLATFORM'] = 'offscreen'

from PyQt6.QtWidgets import QApplication

# Ensure QApplication instance exists
app = QApplication.instance() or QApplication([])

import updater_config as cfg
import updater_engine as engine
from oneshot.discovery import AppDiscoveryEngine
from oneshot.presets import PresetManager
from oneshot.launcher import AppLaunchEngine
from oneshot.startup_takeover import StartupTakeoverWindow
from island.sound_manager import SoundManager
from island.music_manager import MusicManager
from island.timer_widget import FocusTimer
from island.drop_zone import DropZoneWidget
from island.calendar_widget import CalendarWidget
from island.task_manager import TaskManagerWidget
from island.download_monitor import DownloadMonitor
from island.notification_monitor import NotificationMonitor
from island.sticker_manager import StickerManager
from ai_agents.manager import AIAgentActivityManager
from settings_window import CompleteSettingsWindow
from dynamic_notch import DynamicNotch


class TestFullSystem(unittest.TestCase):
    def test_version_bump(self):
        self.assertEqual(cfg.CURRENT_VERSION, "1.0.4")

    def test_oneshot_app_discovery(self):
        engine = AppDiscoveryEngine()
        apps = engine.discover_applications()
        self.assertGreater(len(apps), 0, "Should discover installed Windows applications")

    def test_oneshot_presets(self):
        mgr = PresetManager()
        presets = mgr.get_presets()
        self.assertGreater(len(presets), 0, "Should have default starter presets")
        new_p = mgr.add_preset("Test Preset", "Testing", "star")
        self.assertIsNotNone(mgr.get_preset_by_id(new_p.id))
        mgr.delete_preset(new_p.id)

    def test_sound_manager(self):
        sm = SoundManager()
        vol = sm.get_volume()
        self.assertGreaterEqual(vol, 0.0)
        self.assertLessEqual(vol, 1.0)

    def test_focus_timer(self):
        timer = FocusTimer()
        timer.start(10)
        self.assertTrue(timer.is_running)
        self.assertEqual(timer.get_formatted_time(), "00:10")
        timer.pause()
        self.assertFalse(timer.is_running)
        timer.reset(25 * 60)
        self.assertEqual(timer.get_formatted_time(), "25:00")

    def test_drop_zone_widget(self):
        dz = DropZoneWidget()
        self.assertTrue(os.path.exists(cfg.DROP_ZONE_DIR))

    def test_calendar_widget(self):
        cal = CalendarWidget()
        self.assertIsNotNone(cal.get_selected_date_str())

    def test_task_manager_widget(self):
        tm = TaskManagerWidget()
        self.assertGreater(tm.proc_table.rowCount(), 0)

    def test_ai_agent_manager(self):
        ai = AIAgentActivityManager()
        self.assertIn("Antigravity", ai.adapters)
        self.assertIn("Claude Code", ai.adapters)
        self.assertIn("Codex", ai.adapters)

    def test_settings_window(self):
        win = CompleteSettingsWindow()
        self.assertEqual(win.nav_list.count(), 11)

    def test_dynamic_notch_144hz_and_logo(self):
        notch = DynamicNotch()
        self.assertEqual(notch.anim_timer.interval(), 7)
        self.assertIsNotNone(notch.antigravity_logo)
        self.assertFalse(notch.antigravity_logo.isNull())
        notch.expand_notch()
        self.assertTrue(notch.is_expanded)
        notch.collapse_notch()
        self.assertFalse(notch.is_expanded)

    def test_startup_takeover_window(self):
        pm = PresetManager()
        le = AppLaunchEngine()
        takeover = StartupTakeoverWindow(pm, le)
        takeover.btn_just_enter.click()


if __name__ == "__main__":
    unittest.main()
