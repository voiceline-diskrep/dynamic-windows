"""
Dynamic Windows - OpenAI Codex Adapter
Monitors local Codex CLI process and workspace activities.
"""

import os
import psutil
from typing import List, Tuple

from ai_agents.base_adapter import (
    BaseAgentAdapter, AgentActivity,
    STATUS_WORKING, STATUS_PLANNING
)


class CodexAdapter(BaseAgentAdapter):
    def __init__(self):
        super().__init__("OpenAI Codex")

    def test_connection(self) -> Tuple[bool, str]:
        codex_home = os.path.join(os.environ.get("USERPROFILE", "C:\\"), ".codex")
        if os.path.exists(codex_home):
            return True, f"Codex directory detected at {codex_home}"
        return False, "OpenAI Codex directory not found."

    def poll_activity(self) -> List[AgentActivity]:
        if not self.is_enabled:
            return []

        activities = []
        for p in psutil.process_iter(['pid', 'name', 'create_time', 'cmdline']):
            try:
                name = (p.info['name'] or "").lower()
                cmdline = " ".join(p.info['cmdline'] or []).lower()
                if "codex" in name or "codex" in cmdline:
                    activities.append(AgentActivity(
                        provider="OpenAI Codex",
                        task_id=str(p.info['pid']),
                        task_name="Codex Assistant",
                        workspace=os.getcwd(),
                        status=STATUS_WORKING,
                        phase="Synthesizing changes",
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
