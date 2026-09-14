from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.call_tracking import (
    end_call,
    reap_stale_calls,
    start_call,
    summarize_session,
    update_call_slots,
)
from app.db import CallRecord, init_db, new_session, reset_engine


@pytest.fixture()
def db(tmp_path: Path) -> Generator[None, None, None]:
    """Point the engine at a fresh temp database for each test."""
    reset_engine()
    init_db(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    yield
    reset_engine()


def test_start_and_end_call_record(db: None) -> None:
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


def test_end_call_ignores_unknown_id(db: None) -> None:
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


def test_reap_stale_calls_empty_db(db: None) -> None:
    """Empty database should return 0 reaped calls without error."""
    assert reap_stale_calls() == 0


def test_reap_stale_calls_finalizes_unconfirmed_abandoned_call(db: None) -> None:
    """Unbooked abandoned call older than cutoff is marked info_only with ended_at."""
    call_id = start_call("stale-unbooked")
    started = datetime.now(UTC) - timedelta(minutes=25)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        session.commit()

    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 1

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at is not None
        assert record.ended_at == started + timedelta(minutes=3)
        assert record.outcome == "info_only"
        assert record.transcript_summary == (
            "Call completed (session automatically finalized by stale-call reaper)."
        )


def test_reap_stale_calls_finalizes_confirmed_slots(db: None) -> None:
    """Abandoned call with confirmed slots is marked booked upon reaper sweep."""
    call_id = start_call("stale-booked")
    started = datetime.now(UTC) - timedelta(minutes=30)

    update_call_slots(call_id, {"confirmed": True, "service": "AC repair", "name": "Jane"})

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        session.commit()

    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 1

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"
        assert record.ended_at == started + timedelta(minutes=3)
        assert record.transcript_summary == (
            "Call completed (session automatically finalized by stale-call reaper)."
        )


def test_reap_stale_calls_fallback_string_confirmed_slot(db: None) -> None:
    """Detects confirmed slot even if session_slots contains raw JSON with lowercase confirmed: true."""
    call_id = start_call("stale-json-string")
    started = datetime.now(UTC) - timedelta(minutes=22)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        record.session_slots = '{"service": "furnace", "confirmed": true}'
        session.commit()

    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 1

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"


def test_reap_stale_calls_preserves_existing_transcript_summary(db: None) -> None:
    """Reaper must not overwrite an existing non-empty transcript_summary."""
    call_id = start_call("stale-with-summary")
    started = datetime.now(UTC) - timedelta(minutes=25)
    existing_summary = "Caller asked about emergency service pricing."

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        record.transcript_summary = existing_summary
        session.commit()

    reap_stale_calls(cutoff_minutes=20, duration_minutes=3)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.transcript_summary == existing_summary


def test_reap_stale_calls_preserves_already_booked_outcome(db: None) -> None:
    """If call outcome was already marked 'booked', reaper must not downgrade it to info_only."""
    call_id = start_call("stale-pre-booked")
    started = datetime.now(UTC) - timedelta(minutes=25)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        record.outcome = "booked"
        record.session_slots = None  # Slots cleared earlier
        session.commit()

    reap_stale_calls(cutoff_minutes=20, duration_minutes=3)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"


def test_reap_stale_calls_ignores_recent_active_call(db: None) -> None:
    """Calls younger than cutoff_minutes must remain untouched (ended_at is None)."""
    call_id = start_call("active-recent")
    started = datetime.now(UTC) - timedelta(minutes=10)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        session.commit()

    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 0

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at is None
        assert record.outcome == "in_progress"


def test_reap_stale_calls_ignores_already_ended_call(db: None) -> None:
    """Calls with ended_at already populated must not be re-finalized."""
    call_id = start_call("already-ended")
    started = datetime.now(UTC) - timedelta(minutes=40)
    original_ended = datetime.now(UTC) - timedelta(minutes=35)

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        record.started_at = started
        record.ended_at = original_ended
        record.outcome = "info_only"
        session.commit()

    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 0

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at == original_ended


def test_reap_stale_calls_custom_cutoff_and_duration(db: None) -> None:
    """Verify custom cutoff and duration parameters function accurately."""
    call1 = start_call("call-15m")
    call2 = start_call("call-5m")
    now = datetime.now(UTC)

    with new_session() as session:
        r1 = session.get(CallRecord, call1)
        assert r1 is not None
        r1.started_at = now - timedelta(minutes=15)

        r2 = session.get(CallRecord, call2)
        assert r2 is not None
        r2.started_at = now - timedelta(minutes=5)
        session.commit()

    # Cutoff 10 minutes, assumed duration 5 minutes
    reaped_count = reap_stale_calls(cutoff_minutes=10, duration_minutes=5)
    assert reaped_count == 1

    with new_session() as session:
        r1 = session.get(CallRecord, call1)
        assert r1 is not None
        assert r1.ended_at == r1.started_at + timedelta(minutes=5)

        r2 = session.get(CallRecord, call2)
        assert r2 is not None
        assert r2.ended_at is None


def test_reap_stale_calls_validates_arguments(db: None) -> None:
    """Zero or negative cutoff_minutes or duration_minutes must raise ValueError."""
    with pytest.raises(ValueError, match="positive"):
        reap_stale_calls(cutoff_minutes=0)

    with pytest.raises(ValueError, match="positive"):
        reap_stale_calls(cutoff_minutes=-1)

    with pytest.raises(ValueError, match="positive"):
        reap_stale_calls(duration_minutes=0)

    with pytest.raises(ValueError, match="positive"):
        reap_stale_calls(duration_minutes=-1)


def test_reap_stale_calls_mixed_batch_and_idempotency(db: None) -> None:
    """Sweeping a heterogeneous batch reaps only stale calls and is idempotent."""
    now = datetime.now(UTC)

    # 1. Stale unconfirmed call
    c1 = start_call("room-batch-stale-1")
    # 2. Stale confirmed call
    c2 = start_call("room-batch-stale-2")
    update_call_slots(c2, {"confirmed": True})
    # 3. Active recent call
    c3 = start_call("room-batch-active")
    # 4. Already ended call
    c4 = start_call("room-batch-ended")
    end_call(c4, "info_only", "Already completed")

    with new_session() as session:
        r1 = session.get(CallRecord, c1)
        assert r1 is not None
        r1.started_at = now - timedelta(minutes=30)

        r2 = session.get(CallRecord, c2)
        assert r2 is not None
        r2.started_at = now - timedelta(minutes=25)

        r3 = session.get(CallRecord, c3)
        assert r3 is not None
        r3.started_at = now - timedelta(minutes=10)

        r4 = session.get(CallRecord, c4)
        assert r4 is not None
        r4.started_at = now - timedelta(minutes=50)
        session.commit()

    # First sweep: reaps exactly c1 and c2
    first_sweep = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert first_sweep == 2

    with new_session() as session:
        rec1 = session.get(CallRecord, c1)
        assert rec1 is not None and rec1.outcome == "info_only" and rec1.ended_at is not None

        rec2 = session.get(CallRecord, c2)
        assert rec2 is not None and rec2.outcome == "booked" and rec2.ended_at is not None

        rec3 = session.get(CallRecord, c3)
        assert rec3 is not None and rec3.outcome == "in_progress" and rec3.ended_at is None

        rec4 = session.get(CallRecord, c4)
        assert rec4 is not None and rec4.outcome == "info_only"
        assert rec4.transcript_summary == "Already completed"

    # Second sweep: zero calls reaped (idempotent)
    second_sweep = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert second_sweep == 0