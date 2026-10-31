"""
Dynamic Windows - Base AI Coding Agent Adapter
Defines normalized agent statuses, activity data models, and common adapter interface.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, List, Tuple
import time


# Normalized Agent Statuses as required by Part G
STATUS_STARTING     = "Starting"
STATUS_INITIALIZING = "Initializing"
STATUS_PLANNING     = "Planning"
STATUS_ANALYZING    = "Analyzing"
STATUS_WORKING      = "Working"
STATUS_WRITING_CODE = "Writing code"
STATUS_EDITING_FILE = "Editing files"
STATUS_TESTING      = "Testing"
STATUS_REVIEWING    = "Reviewing"
STATUS_WAITING      = "Waiting"
STATUS_NEEDS_INPUT  = "Needs input"
STATUS_COMPLETED    = "Completed"
STATUS_FAILED       = "Failed"


@dataclass
class AgentActivity:
    provider: str        # "Antigravity", "Claude Code", "OpenAI Codex"
    task_id: str
    task_name: str
    workspace: str
    status: str          # One of the normalized statuses
    phase: str
    current_file: Optional[str] = None
    progress: Optional[float] = None
    start_time: float = 0.0
    elapsed_sec: float = 0.0
    recent_events: List[str] = None
    is_directly_observed: bool = True

    def __post_init__(self):
        if self.recent_events is None:
            self.recent_events = []


class BaseAgentAdapter(ABC):
    def __init__(self, provider_name: str):
        self.provider_name = provider_name
        self.is_enabled = True

    @abstractmethod
    def poll_activity(self) -> List[AgentActivity]:
        """Poll the environment and return list of current active agent tasks."""
        pass

    @abstractmethod
    def test_connection(self) -> Tuple[bool, str]:
        """Test connection/presence of local provider installation."""
        pass
