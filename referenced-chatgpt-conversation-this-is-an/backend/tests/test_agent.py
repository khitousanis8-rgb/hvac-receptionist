from unittest.mock import MagicMock, patch

import pytest

from app.agent.tools import book_appointment_tool
from app.agent.worker import build_agent_session
from app.config import Settings


def test_agent_session_rejects_missing_credentials() -> None:
    with pytest.raises(RuntimeError, match="Agent credentials are incomplete"):
        build_agent_session(Settings(_env_file=None))


@pytest.mark.asyncio
async def test_book_appointment_tool_rejects_unapproved_service() -> None:
    settings = Settings(
        BUSINESS_SERVICES="AC repair,Furnace maintenance",
        _env_file=None,
    )
    with patch("app.agent.tools.get_settings", return_value=settings):
        res = await book_appointment_tool(
            context=MagicMock(),
            phone_number="+15551234567",
            service="Nuclear Reactor Cleaning",
            date="2030-06-03",
            time="10:00",
        )
        assert "not on our approved services list" in res
        assert "Approved services are: AC repair, Furnace maintenance" in res