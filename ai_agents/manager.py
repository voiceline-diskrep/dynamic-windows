"""
Dynamic Windows - Central AI Agent Activity Manager
Coordinates multi-provider adapters (Antigravity, Claude Code, Codex),
aggregates active tasks, maintains timestamped event history, and notifies the Dynamic Island.
"""

from typing import List, Dict, Optional
from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from ai_agents.base_adapter import AgentActivity
from ai_agents.antigravity_adapter import AntigravityAdapter
from ai_agents.claude_adapter import ClaudeCodeAdapter
from ai_agents.codex_adapter import CodexAdapter


class AIAgentActivityManager(QObject):
    activities_updated = pyqtSignal(list)  # List[AgentActivity]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.adapters = {
            "Antigravity": AntigravityAdapter(),
            "Claude Code": ClaudeCodeAdapter(),
            "Codex": CodexAdapter(),
        }
        self.active_activities: List[AgentActivity] = []
        self.history: List[AgentActivity] = []

        # Poll every 2 seconds
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.poll_all)
        self._timer.start(2000)
        self.poll_all()

    def poll_all(self):
        current: List[AgentActivity] = []
        for adapter in self.adapters.values():
            if adapter.is_enabled:
                try:
                    acts = adapter.poll_activity()
                    current.extend(acts)
                except Exception:
                    pass

        self.active_activities = current
        self.activities_updated.emit(self.active_activities)

    def get_active_activities(self) -> List[AgentActivity]:
        return list(self.active_activities)
