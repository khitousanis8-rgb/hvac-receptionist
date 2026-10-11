# pyright: reportCallIssue=false
"""Unit tests for LiveKit agent receptionist tools and strict OpenAI schemas."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest
from livekit.agents.llm.utils import build_strict_openai_schema

from app.agent.tools import (
    book_appointment_tool,
    build_receptionist_tools,
    cancel_appointment_tool,
    check_availability,
    check_my_appointments,
    reschedule_appointment_tool,
)
from app.config import Settings
from app.db import init_db, new_session
from app.scheduling import check_slot_availability


def _find_future_weekday(
    settings: Settings, days_ahead: int = 1, target_weekday: int | None = None
) -> datetime:
    tz = ZoneInfo(settings.business_timezone)
    candidate = datetime.now(tz) + timedelta(days=days_ahead)
    candidate = candidate.replace(hour=10, minute=0, second=0, microsecond=0)
    if target_weekday is not None:
        while candidate.weekday() != target_weekday:
            candidate += timedelta(days=1)
    else:
        # Default to a Monday-Friday business day
        while candidate.weekday() >= 5:
            candidate += timedelta(days=1)
    return candidate


def test_build_receptionist_tools_membership() -> None:
    settings = Settings(_env_file=None)
    tools = build_receptionist_tools(settings)
    tool_names = [getattr(fn, "__name__", "") for fn in tools]

    assert "check_availability" in tool_names
    assert "book_appointment_tool" in tool_names
    assert "reschedule_appointment_tool" in tool_names
    assert "cancel_appointment_tool" in tool_names
    # check_my_appointments must NOT be registered as an agent tool
    assert "check_my_appointments" not in tool_names


def test_receptionist_tools_strict_openai_schemas() -> None:
    """Ensure all receptionist tools generate valid OpenAI strict schemas via LiveKit."""
    settings = Settings(_env_file=None)
    tools = build_receptionist_tools(settings)

    for tool in tools:
        schema = build_strict_openai_schema(tool)
        assert schema["type"] == "function"
        fn = schema["function"]
        assert fn["strict"] is True, f"Tool {fn.get('name')} must have strict=True"

        params = fn["parameters"]
        assert params["type"] == "object"
        assert params["additionalProperties"] is False, (
            f"Tool {fn.get('name')} must specify additionalProperties=False"
        )

        props = params.get("properties", {})
        required = params.get("required", [])

        # Strict mode requires that required lists ALL keys declared in properties
        assert set(required) == set(props.keys()), (
            f"Tool {fn.get('name')} required fields {required} must match properties {list(props.keys())}"
        )


def test_check_availability_schema_properties() -> None:
    schema = build_strict_openai_schema(check_availability)
    fn = schema["function"]
    assert fn["name"] == "check_availability"
    assert fn["strict"] is True

    props = fn["parameters"]["properties"]
    assert "date" in props
    assert props["date"]["type"] == "string"

    assert "time" in props
    assert props["time"]["type"] == ["string", "null"]

    assert "service" in props
    assert props["service"]["type"] == ["string", "null"]

    assert fn["parameters"]["required"] == ["date", "time", "service"]
    assert fn["parameters"]["additionalProperties"] is False


def test_book_appointment_tool_schema_properties() -> None:
    schema = build_strict_openai_schema(book_appointment_tool)
    fn = schema["function"]
    assert fn["name"] == "book_appointment_tool"
    assert fn["strict"] is True

    props = fn["parameters"]["properties"]
    assert props["phone_number"]["type"] == "string"
    assert props["service"]["type"] == "string"
    assert props["date"]["type"] == "string"
    assert props["time"]["type"] == "string"
    assert props["name"]["type"] == ["string", "null"]
    assert props["notes"]["type"] == ["string", "null"]

    assert set(fn["parameters"]["required"]) == {
        "phone_number",
        "service",
        "date",
        "time",
        "name",
        "notes",
    }
    assert fn["parameters"]["additionalProperties"] is False


def test_reschedule_and_cancel_schemas() -> None:
    resched = build_strict_openai_schema(reschedule_appointment_tool)["function"]
    assert resched["strict"] is True
    assert resched["parameters"]["additionalProperties"] is False
    assert set(resched["parameters"]["required"]) == {"phone_number", "date", "time"}

    cancel = build_strict_openai_schema(cancel_appointment_tool)["function"]
    assert cancel["strict"] is True
    assert cancel["parameters"]["additionalProperties"] is False
    assert set(cancel["parameters"]["required"]) == {"phone_number"}


@pytest.mark.asyncio
async def test_check_my_appointments_privacy_fallback() -> None:
    res = await check_my_appointments(MagicMock(), "+15555550100")
    assert "privacy and security" in res.lower()
    assert "customer portal" in res.lower()


@pytest.mark.asyncio
async def test_check_availability_async_available_slot() -> None:
    settings = Settings(
        BUSINESS_OPENING_HOURS={
            "monday": "08:00-18:00",
            "tuesday": "08:00-18:00",
            "wednesday": "08:00-18:00",
            "thursday": "08:00-18:00",
            "friday": "08:00-18:00",
            "saturday": "09:00-17:00",
            "sunday": "closed",
        },
        _env_file=None,
    )
    init_db()
    target = _find_future_weekday(settings, days_ahead=2)
    date_str = target.strftime("%Y-%m-%d")
    time_str = "10:00"

    context_mock: Any = MagicMock()
    with patch("app.agent.tools.get_settings", return_value=settings):
        result = await check_availability(
            context=context_mock,
            date=date_str,
            time=time_str,
            service="AC repair",
        )
    assert "is available" in result
    assert "10:00 AM" in result


@pytest.mark.asyncio
async def test_check_availability_async_conflicted_slot() -> None:
    from app.scheduling import book_appointment, parse_local_datetime

    settings = Settings(
        BUSINESS_OPENING_HOURS={
            "monday": "08:00-18:00",
            "tuesday": "08:00-18:00",
            "wednesday": "08:00-18:00",
            "thursday": "08:00-18:00",
            "friday": "08:00-18:00",
            "saturday": "09:00-17:00",
            "sunday": "closed",
        },
        _env_file=None,
    )
    init_db()
    target = _find_future_weekday(settings, days_ahead=3)
    date_str = target.strftime("%Y-%m-%d")
    time_str = "14:00"
    when = parse_local_datetime(settings, date_str, time_str)
    assert when is not None

    with new_session() as session:
        appt, msg = book_appointment(
            session=session,
            settings=settings,
            phone_number="+15555550199",
            service="Heating and furnace repair",
            when=when,
        )
        assert appt is not None
        session.commit()

    context_mock: Any = MagicMock()
    with patch("app.agent.tools.get_settings", return_value=settings):
        result = await check_availability(
            context=context_mock,
            date=date_str,
            time=time_str,
            service="AC repair",
        )
    assert "already booked" in result or "already taken" in result
    assert "Nearest available opening" in result


def test_check_slot_availability_closed_day() -> None:
    settings = Settings(
        BUSINESS_OPENING_HOURS={
            "monday": "08:00-18:00",
            "tuesday": "08:00-18:00",
            "wednesday": "08:00-18:00",
            "thursday": "08:00-18:00",
            "friday": "08:00-18:00",
            "saturday": "09:00-17:00",
            "sunday": "closed",
        },
        _env_file=None,
    )
    init_db()
    # Find next Sunday (weekday == 6)
    sunday = _find_future_weekday(settings, days_ahead=1, target_weekday=6)
    date_str = sunday.strftime("%Y-%m-%d")

    with new_session() as session:
        is_avail, msg, alts = check_slot_availability(
            session, settings, date_str=date_str, time_str="10:00"
        )
        assert is_avail is False
        assert "outside business hours" in msg
        assert len(alts) > 0


def test_check_slot_availability_past_time() -> None:
    settings = Settings(_env_file=None)
    init_db()
    with new_session() as session:
        is_avail, msg, alts = check_slot_availability(
            session, settings, date_str="2020-01-01", time_str="10:00"
        )
        assert is_avail is False
        assert "in the past" in msg


def test_check_slot_availability_unapproved_service() -> None:
    settings = Settings(
        BUSINESS_SERVICES="AC repair,Heating and furnace repair",
        _env_file=None,
    )
    init_db()
    target = _find_future_weekday(settings, days_ahead=2)
    date_str = target.strftime("%Y-%m-%d")

    with new_session() as session:
        is_avail, msg, alts = check_slot_availability(
            session,
            settings,
            date_str=date_str,
            time_str="11:00",
            service="Roof Solar Panel Cleaning",
        )
        assert is_avail is False
        assert "not on our approved services list" in msg
        assert alts == []
