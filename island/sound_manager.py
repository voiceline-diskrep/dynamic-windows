"""
Dynamic Windows - System Sound Manager & Audio Feedback
Provides real Windows volume control via pycaw, mute/unmute,
audio device detection, and subtle typing/interaction sound feedback.
"""

import sys
import winsound
from typing import Optional, Tuple
from PyQt6.QtCore import QObject, pyqtSignal, QTimer

try:
    from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
    PYCAW_AVAILABLE = True
except Exception:
    PYCAW_AVAILABLE = False


class SoundManager(QObject):
    volume_changed = pyqtSignal(float, bool)  # level (0.0 - 1.0), is_muted

    def __init__(self, parent=None):
        super().__init__(parent)
        self._endpoint_volume = None
        self._last_volume = 0.5
        self._last_mute = False
        self._typing_sounds_enabled = False
        self._sound_volume = 0.5

        if PYCAW_AVAILABLE:
            try:
                speakers = AudioUtilities.GetSpeakers()
                if speakers:
                    self._endpoint_volume = speakers.EndpointVolume
                    self._last_volume = self.get_volume()
                    self._last_mute = self.is_muted()
            except Exception:
                pass

        # Polling timer to detect volume changes made outside the app (e.g. keyboard media keys)
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._check_volume_change)
        self._poll_timer.start(500)

    def get_volume(self) -> float:
        """Get system volume scalar from 0.0 to 1.0."""
        if self._endpoint_volume:
            try:
                return float(self._endpoint_volume.GetMasterVolumeLevelScalar())
            except Exception:
                pass
        return self._last_volume

    def set_volume(self, level: float) -> bool:
        """Set system volume level (0.0 to 1.0)."""
        clamped = max(0.0, min(1.0, float(level)))
        self._last_volume = clamped
        if self._endpoint_volume:
            try:
                self._endpoint_volume.SetMasterVolumeLevelScalar(clamped, None)
                self.volume_changed.emit(clamped, self.is_muted())
                return True
            except Exception:
                pass
        return False

    def is_muted(self) -> bool:
        if self._endpoint_volume:
            try:
                return bool(self._endpoint_volume.GetMute())
            except Exception:
                pass
        return self._last_mute

    def set_muted(self, muted: bool) -> bool:
        self._last_mute = bool(muted)
        if self._endpoint_volume:
            try:
                self._endpoint_volume.SetMute(int(muted), None)
                self.volume_changed.emit(self.get_volume(), self._last_mute)
                return True
            except Exception:
                pass
        return False

    def toggle_mute(self) -> bool:
        return self.set_muted(not self.is_muted())

    def _check_volume_change(self):
        if not self._endpoint_volume:
            return
        try:
            cur_vol = self.get_volume()
            cur_mute = self.is_muted()
            if abs(cur_vol - self._last_volume) > 0.01 or cur_mute != self._last_mute:
                self._last_volume = cur_vol
                self._last_mute = cur_mute
                self.volume_changed.emit(cur_vol, cur_mute)
        except Exception:
            pass

    def set_typing_sounds_enabled(self, enabled: bool):
        self._typing_sounds_enabled = enabled

    def play_typing_sound(self):
        """Optional subtle typing feedback sound."""
        if not self._typing_sounds_enabled:
            return
        try:
            # Low latency subtle mechanical click
            winsound.Beep(1200, 15)
        except Exception:
            pass

    def play_notification_sound(self):
        try:
            winsound.MessageBeep(winsound.MB_ICONASTERISK)
        except Exception:
            pass
