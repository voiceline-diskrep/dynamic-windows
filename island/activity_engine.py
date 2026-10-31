"""
Dynamic Windows - Central Dynamic Activity Engine
Coordinates events and live activities from:
- AI Coding Agents (Antigravity, Claude Code, Codex)
- Music Playback & Track Sessions
- Active File Downloads
- Focus Timers
- System Notifications & Alerts
- Volume Adjustments
"""

from typing import List, Optional
from dataclasses import dataclass
from PyQt6.QtCore import QObject, pyqtSignal

from ai_agents.manager import AIAgentActivityManager, AgentActivity
from island.music_manager import MusicManager, TrackInfo
from island.download_monitor import DownloadMonitor, ActiveDownload
from island.timer_widget import FocusTimer
from island.notification_monitor import NotificationMonitor, NotificationItem


@dataclass
class PrimaryIslandActivity:
    category: str        # 'ai_agent', 'music', 'download', 'timer', 'notification', 'updater'
    title: str
    subtitle: str
    badge: str
    progress: Optional[float] = None


class DynamicActivityEngine(QObject):
    primary_activity_changed = pyqtSignal(object)  # PrimaryIslandActivity or None
    activities_changed = pyqtSignal()

    def __init__(
        self,
        ai_manager: AIAgentActivityManager,
        music_manager: MusicManager,
        download_monitor: DownloadMonitor,
        focus_timer: FocusTimer,
        notification_monitor: NotificationMonitor,
        parent=None
    ):
        super().__init__(parent)
        self.ai_manager = ai_manager
        self.music_manager = music_manager
        self.download_monitor = download_monitor
        self.focus_timer = focus_timer
        self.notification_monitor = notification_monitor

        # Wire up listeners
        self.ai_manager.activities_updated.connect(self._recalculate)
        self.music_manager.track_changed.connect(self._recalculate)
        self.music_manager.playback_state_changed.connect(self._recalculate)
        self.download_monitor.downloads_updated.connect(self._recalculate)
        self.focus_timer.tick.connect(self._recalculate)
        self.focus_timer.state_changed.connect(self._recalculate)
        self.notification_monitor.queue_updated.connect(self._recalculate)

        self.current_primary: Optional[PrimaryIslandActivity] = None

    def _recalculate(self, *args):
        """Determine top priority active background event."""
        # 1. Active Timer
        if self.focus_timer.is_running:
            self.current_primary = PrimaryIslandActivity(
                category="timer",
                title="Focus Timer",
                subtitle=f"{self.focus_timer.get_formatted_time()} remaining",
                badge=f"⏱ {self.focus_timer.get_formatted_time()}",
                progress=1.0 - (self.focus_timer.remaining_sec / float(self.focus_timer.total_duration_sec))
            )
            self.primary_activity_changed.emit(self.current_primary)
            self.activities_changed.emit()
            return

        # 2. Active Downloads
        downloads = self.download_monitor.get_active_downloads()
        if downloads:
            d = downloads[0]
            self.current_primary = PrimaryIslandActivity(
                category="download",
                title=f"Downloading {d.filename[:18]}...",
                subtitle=f"{d.current_bytes / (1024*1024):.1f} MB • {d.speed_kbps:.0f} KB/s",
                badge=f"⬇ {d.speed_kbps:.0f} KB/s",
                progress=None
            )
            self.primary_activity_changed.emit(self.current_primary)
            self.activities_changed.emit()
            return

        # 3. Active AI Agents
        agents = self.ai_manager.get_active_activities()
        if agents:
            a = agents[0]
            self.current_primary = PrimaryIslandActivity(
                category="ai_agent",
                title=f"{a.provider}: {a.status}",
                subtitle=a.phase,
                badge=f"🤖 {a.provider.split()[-1]}",
                progress=a.progress
            )
            self.primary_activity_changed.emit(self.current_primary)
            self.activities_changed.emit()
            return

        # 4. Music Playback
        if self.music_manager.is_playing and self.music_manager.current_track:
            t = self.music_manager.current_track
            self.current_primary = PrimaryIslandActivity(
                category="music",
                title=t.title,
                subtitle=t.artist,
                badge="🎵 Playing",
                progress=None
            )
            self.primary_activity_changed.emit(self.current_primary)
            self.activities_changed.emit()
            return

        # 5. No active event
        if self.current_primary is not None:
            self.current_primary = None
            self.primary_activity_changed.emit(None)
            self.activities_changed.emit()
