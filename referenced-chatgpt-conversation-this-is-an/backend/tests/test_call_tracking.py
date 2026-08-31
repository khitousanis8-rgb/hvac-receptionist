from types import SimpleNamespace

import pytest

from app.call_tracking import end_call, start_call, summarize_session
from app.db import CallRecord, init_db, new_session, reset_engine


@pytest.fixture()
def db(tmp_path):
    """Point the engine at a fresh temp database for each test."""
    reset_engine()
    init_db(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    yield
    reset_engine()


def test_start_and_end_call_record(db) -> None:
    call_id = start_call("room-1")
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.room_name == "room-1"
        assert record.outcome == "in_progress"
        assert record.ended_at is None

    end_call(call_id, "booked", "My AC is broken")
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"
        assert record.transcript_summary == "My AC is broken"
        assert record.ended_at is not None


def test_end_call_ignores_unknown_id(db) -> None:
    end_call(9999, "booked")  # must not raise


def test_summarize_session_detects_booking() -> None:
    items = [
        SimpleNamespace(role="user", content=["My AC is broken"]),
        SimpleNamespace(name="book_appointment_tool", arguments="{}"),
        SimpleNamespace(role="assistant", content=["Booked AC repair at 10:00"]),
    ]
    outcome, summary = summarize_session(items)
    assert outcome == "booked"
    assert summary is not None
    assert "AC is broken" in summary


def test_summarize_session_info_only() -> None:
    items = [SimpleNamespace(role="user", content=["What are your hours?"])]
    outcome, summary = summarize_session(items)
    assert outcome == "info_only"
    assert summary == "What are your hours?"


def test_summarize_session_empty_history() -> None:
    outcome, summary = summarize_session([])
    assert outcome == "info_only"
    assert summary is None