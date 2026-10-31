"""
Dynamic Windows - Music & Media Session Manager
Connects to Windows Media Sessions, detects active playback, track title, artist,
and sends media controls (Play/Pause, Next, Previous).
"""

import re
import ctypes
from dataclasses import dataclass
from typing import Optional
from PyQt6.QtCore import QObject, pyqtSignal, QTimer

# Windows Virtual-Key Codes for Media Control
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP       = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3
KEYEVENTF_KEYUP     = 0x0002


@dataclass
class TrackInfo:
    title: str
    artist: str
    app_name: str
    is_playing: bool


class MusicManager(QObject):
    track_changed = pyqtSignal(object)       # TrackInfo or None
    playback_state_changed = pyqtSignal(bool) # is_playing

    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_track: Optional[TrackInfo] = None
        self.is_playing = False

        # Periodic check for active music player windows (e.g. Spotify, Apple Music, Chrome)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.poll_media_state)
        self._timer.start(1000)

    def poll_media_state(self):
        """Detect active media playback from known players or active media session."""
        track = self._detect_player_from_windows()
        if track:
            if not self.current_track or (self.current_track.title != track.title or self.current_track.artist != track.artist or self.current_track.is_playing != track.is_playing):
                self.current_track = track
                self.is_playing = track.is_playing
                self.track_changed.emit(track)
                self.playback_state_changed.emit(self.is_playing)
        else:
            if self.current_track is not None:
                self.current_track = None
                self.is_playing = False
                self.track_changed.emit(None)
                self.playback_state_changed.emit(False)

    def _detect_player_from_windows(self) -> Optional[TrackInfo]:
        """Scan top-level windows for Spotify and known media players."""
        user32 = ctypes.windll.user32
        EnumWindows = user32.EnumWindows
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        GetWindowTextW = user32.GetWindowTextW
        GetWindowTextLengthW = user32.GetWindowTextLengthW
        IsWindowVisible = user32.IsWindowVisible

        found_track = None

        def foreach_window(hwnd, lParam):
            nonlocal found_track
            if not IsWindowVisible(hwnd):
                return True
            length = GetWindowTextLengthW(hwnd)
            if length == 0:
                return True

            buff = ctypes.create_unicode_buffer(length + 1)
            GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value

            # Spotify format: "Artist - Track Title" (or "Spotify Free" / "Spotify Premium" when paused)
            if " - " in title and not any(bad in title for bad in ["Chrome", "Visual Studio", "Notepad", "Explorer"]):
                # Check if window belongs to Spotify or media player
                class_buff = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, class_buff, 256)
                c_name = class_buff.value
                if "Spotify" in c_name or "Chrome" in c_name or "Edge" in c_name:
                    parts = title.split(" - ", 1)
                    found_track = TrackInfo(
                        title=parts[1].strip(),
                        artist=parts[0].strip(),
                        app_name="Spotify" if "Spotify" in c_name else "Media",
                        is_playing=True
                    )
                    return False
            return True

        EnumWindows(EnumWindowsProc(foreach_window), 0)
        return found_track

    def play_pause(self):
        """Toggle system media playback using Windows media keys."""
        self._send_media_key(VK_MEDIA_PLAY_PAUSE)
        self.is_playing = not self.is_playing
        self.playback_state_changed.emit(self.is_playing)

    def next_track(self):
        self._send_media_key(VK_MEDIA_NEXT_TRACK)

    def previous_track(self):
        self._send_media_key(VK_MEDIA_PREV_TRACK)

    def _send_media_key(self, vk_code: int):
        user32 = ctypes.windll.user32
        user32.keybd_event(vk_code, 0, 0, 0)
        user32.keybd_event(vk_code, 0, KEYEVENTF_KEYUP, 0)
