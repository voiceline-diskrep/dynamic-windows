"""
Dynamic Windows - Anthropic Claude Code Adapter
Observes local Claude Code process execution and CLI activity.
"""

import os
import psutil
from typing import List, Tuple

from ai_agents.base_adapter import (
    BaseAgentAdapter, AgentActivity,
    STATUS_WORKING, STATUS_PLANNING, STATUS_COMPLETED
)


class ClaudeCodeAdapter(BaseAgentAdapter):
    def __init__(self):
        super().__init__("Anthropic Claude Code")

    def test_connection(self) -> Tuple[bool, str]:
        # Check if claude CLI or process is available
        claude_home = os.path.join(os.environ.get("USERPROFILE", "C:\\"), ".claude")
        if os.path.exists(claude_home):
            return True, f"Claude directory detected at {claude_home}"
        return False, "Claude Code directory not found in user home."

    def poll_activity(self) -> List[AgentActivity]:
        if not self.is_enabled:
            return []

        activities = []
        for p in psutil.process_iter(['pid', 'name', 'create_time', 'cmdline']):
            try:
                name = (p.info['name'] or "").lower()
                cmdline = " ".join(p.info['cmdline'] or []).lower()
                if "claude" in name or "claude" in cmdline:
                    activities.append(AgentActivity(
                        provider="Anthropic Claude Code",
                        task_id=str(p.info['pid']),
                        task_name="Claude CLI Agent",
                        workspace=os.getcwd(),
                        status=STATUS_WORKING,
                        phase="Active execution",
                        current_file=None,
                        progress=None,
                        start_time=p.info['create_time'],
                        elapsed_sec=0.0,
                        recent_events=["CLI process active"],
                        is_directly_observed=True
                    ))
            except Exception:
                continue

        return activities
