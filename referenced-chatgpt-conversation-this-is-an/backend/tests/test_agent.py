# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

import pytest

from app.agent.worker import build_agent_session
from app.config import Settings


def test_agent_session_rejects_missing_credentials() -> None:
    with pytest.raises(RuntimeError, match="Agent credentials are incomplete"):
        build_agent_session(Settings(_env_file=None))