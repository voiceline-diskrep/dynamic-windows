"""
Dynamic Windows - Google Antigravity Adapter
Directly monitors local Antigravity transcripts and task execution.
"""

import os
import json
import time
from typing import List, Tuple, Optional

from ai_agents.base_adapter import (
    BaseAgentAdapter, AgentActivity,
    STATUS_WORKING, STATUS_WRITING_CODE, STATUS_EDITING_FILE,
    STATUS_PLANNING, STATUS_COMPLETED, STATUS_TESTING
)

GEMINI_DIR = os.path.join(os.environ.get("USERPROFILE", "C:\\"), ".gemini", "antigravity")
BRAIN_DIR = os.path.join(GEMINI_DIR, "brain")


class AntigravityAdapter(BaseAgentAdapter):
    def __init__(self):
        super().__init__("Google Antigravity")

    def test_connection(self) -> Tuple[bool, str]:
        if os.path.exists(BRAIN_DIR):
            return True, f"Antigravity brain directory detected at {BRAIN_DIR}"
        return False, "Antigravity installation not found."

    def poll_activity(self) -> List[AgentActivity]:
        if not self.is_enabled or not os.path.exists(BRAIN_DIR):
            return []

        activities = []
        try:
            # Find most recently modified conversation directory
            entries = []
            for item in os.listdir(BRAIN_DIR):
                full_p = os.path.join(BRAIN_DIR, item)
                if os.path.isdir(full_p) and not item.startswith("."):
                    entries.append((os.path.getmtime(full_p), full_p, item))

            if not entries:
                return []

            entries.sort(key=lambda x: x[0], reverse=True)
            mtime, latest_conv_dir, conv_id = entries[0]

            # If modified in the last 15 minutes, consider it active
            if time.time() - mtime < 900:
                transcript_file = os.path.join(latest_conv_dir, ".system_generated", "logs", "transcript.jsonl")
                last_step_type = "Working"
                last_event = "Active development session"
                cur_file = None
                status = STATUS_WORKING

                if os.path.exists(transcript_file):
                    try:
                        with open(transcript_file, "r", encoding="utf-8", errors="ignore") as f:
                            lines = f.readlines()
                            if lines:
                                last_line = lines[-1].strip()
                                data = json.loads(last_line)
                                step_type = data.get("type", "")
                                tool_calls = data.get("tool_calls", [])

                                if tool_calls:
                                    t_name = tool_calls[0].get("toolSummary") or tool_calls[0].get("tool_name", "")
                                    last_event = f"Running: {t_name}"
                                    if "write" in str(t_name).lower():
                                        status = STATUS_WRITING_CODE
                                    elif "edit" in str(t_name).lower():
                                        status = STATUS_EDITING_FILE
                                    elif "test" in str(t_name).lower():
                                        status = STATUS_TESTING
                                    else:
                                        status = STATUS_WORKING
                                elif step_type == "PLANNER_RESPONSE":
                                    status = STATUS_WORKING
                                    last_event = "Synthesizing solution"
                                elif step_type == "USER_INPUT":
                                    status = STATUS_PLANNING
                                    last_event = "Planning user request"
                    except Exception:
                        pass

                activities.append(AgentActivity(
                    provider="Google Antigravity",
                    task_id=conv_id[:8],
                    task_name="Dynamic Island Pair Programming",
                    workspace="Island",
                    status=status,
                    phase=last_event,
                    current_file=cur_file,
                    progress=None,
                    start_time=mtime,
                    elapsed_sec=time.time() - mtime,
                    recent_events=[last_event],
                    is_directly_observed=True
                ))
        except Exception:
            pass

        return activities
