"""Adversarial stress test suite for Milestone 2: reap_stale_calls().

This module challenges:
1. Extreme timestamps: future dates, exact boundary conditions, century-old timestamps, NULL started_at.
2. Corrupted and unusual session_slots JSON: null, empty string, malformed JSON,
   non-dict JSON types, numeric confirmed values, and deeply nested/spurious confirmed flags.
3. Rapid concurrent invocations across multi-threaded worker pools to stress SQLite locking,
   race conditions, and idempotency.
4. Complete isolation from runtime hvac_receptionist.db.
"""

from __future__ import annotations

import concurrent.futures
import threading
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from app.call_tracking import reap_stale_calls, start_call, update_call_slots
from app.db import CallRecord, new_session

# ---------------------------------------------------------------------------
# Dimension 1: Extreme Timestamps
# ---------------------------------------------------------------------------


def test_reap_future_start_dates_never_reaped() -> None:
    """Calls with started_at in the future must NEVER be swept by the reaper."""
    now = datetime.now(UTC)
    future_deltas = [
        timedelta(seconds=1),
        timedelta(minutes=5),
        timedelta(hours=1),
        timedelta(days=30),
        timedelta(days=365 * 10),  # 10 years in the future
    ]

    call_ids: list[int] = []
    for delta in future_deltas:
        cid = start_call(f"room-future-{delta.total_seconds()}")
        with new_session() as session:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            rec.started_at = now + delta
            session.commit()
        call_ids.append(cid)

    reaped = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped == 0

    with new_session() as session:
        for cid in call_ids:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            assert rec.ended_at is None
            assert rec.outcome == "in_progress"


def test_reap_boundary_exact_cutoff() -> None:
    """Verify strictly less-than semantics at the exact cutoff boundary."""
    now = datetime.now(UTC)
    cutoff_minutes = 20

    # Call A: Started 20 minutes + 1 second ago (stale)
    cid_stale = start_call("room-just-over-boundary")

    # Call B: Started 20 minutes - 1 second ago (not stale)
    cid_fresh = start_call("room-just-under-boundary")

    exact_time = now - timedelta(minutes=cutoff_minutes)
    stale_time = exact_time - timedelta(seconds=1)
    fresh_time = exact_time + timedelta(seconds=1)

    with new_session() as session:
        rec_stale = session.get(CallRecord, cid_stale)
        assert rec_stale is not None
        rec_stale.started_at = stale_time

        rec_fresh = session.get(CallRecord, cid_fresh)
        assert rec_fresh is not None
        rec_fresh.started_at = fresh_time

        session.commit()

    reaped = reap_stale_calls(cutoff_minutes=cutoff_minutes, duration_minutes=3)
    assert reaped >= 1

    with new_session() as session:
        r_stale = session.get(CallRecord, cid_stale)
        assert r_stale is not None
        assert r_stale.ended_at is not None, "Call older than cutoff must be reaped"

        r_fresh = session.get(CallRecord, cid_fresh)
        assert r_fresh is not None
        assert r_fresh.ended_at is None, "Call younger than cutoff must not be reaped"


def test_reap_very_old_timestamps() -> None:
    """Verify that timestamps dating back decades/centuries calculate ended_at accurately."""
    ancient_dates = [
        datetime(1900, 1, 1, 12, 0, 0, tzinfo=UTC),
        datetime(1970, 1, 1, 0, 0, 0, tzinfo=UTC),
        datetime(1999, 12, 31, 23, 59, 59, tzinfo=UTC),
    ]

    cids: list[int] = []
    for dt in ancient_dates:
        cid = start_call(f"room-ancient-{dt.year}")
        with new_session() as session:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            rec.started_at = dt
            session.commit()
        cids.append(cid)

    reaped = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped == len(ancient_dates)

    with new_session() as session:
        for cid, dt in zip(cids, ancient_dates, strict=True):
            rec = session.get(CallRecord, cid)
            assert rec is not None
            assert rec.ended_at == dt + timedelta(minutes=3)
            assert rec.outcome == "info_only"


def test_reap_schema_enforces_not_null_on_started_at() -> None:
    """The schema enforces NOT NULL on started_at, preventing null timestamp anomalies."""
    cid = start_call("room-null-started-at")
    with pytest.raises(IntegrityError):
        with new_session() as session:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            rec.started_at = None  # type: ignore[assignment]
            session.commit()


# ---------------------------------------------------------------------------
# Dimension 2: Corrupted or Unusual session_slots JSON
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw_slots", "expected_outcome"),
    [
        (None, "info_only"),
        ("", "info_only"),
        ("   ", "info_only"),
        ("not valid json at all", "info_only"),
        ("{unclosed json", "info_only"),
        ("[1, 2, 3]", "info_only"),
        ('"plain string"', "info_only"),
        ("12345", "info_only"),
        ("true", "info_only"),
        ("false", "info_only"),
        ("null", "info_only"),
        ("{}", "info_only"),
        ('{"confirmed": false}', "info_only"),
        ('{"confirmed": null}', "info_only"),
        ('{"confirmed": 0}', "info_only"),
        ('{"confirmed": 1}', "info_only"),
        ('{"confirmed": "true"}', "info_only"),
        ('{"confirmed": "false"}', "info_only"),
        ('{"confirmed": true}', "booked"),
        ('{"service": "Heat Pump", "confirmed": true, "name": "Alice"}', "booked"),
    ],
)
def test_reap_session_slots_resilience(raw_slots: str | None, expected_outcome: str) -> None:
    """Verify reaper parses or defaults corrupted and exotic slot payloads without raising."""
    now = datetime.now(UTC)
    cid = start_call("room-slots-resilience")

    with new_session() as session:
        rec = session.get(CallRecord, cid)
        assert rec is not None
        rec.started_at = now - timedelta(minutes=30)
        rec.session_slots = raw_slots
        session.commit()

    reaped = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped == 1

    with new_session() as session:
        rec = session.get(CallRecord, cid)
        assert rec is not None
        assert rec.outcome == expected_outcome
        assert rec.ended_at is not None


def test_reap_deeply_nested_and_comment_confirmed_fallback_behavior() -> None:
    """Empirically document fallback string matching behavior on nested/spurious confirmed flags.

    Findings:
    - Because reap_stale_calls inspects:
        slots.get("confirmed") is True or ('"confirmed": true' in stale.session_slots.lower())
      any JSON payload that contains the literal substring '"confirmed": true' (even when
      top-level confirmed is explicitly false, or within a nested object or comment) evaluates
      is_confirmed to True.
    """
    now = datetime.now(UTC)

    # Case A: Top-level confirmed is false, but nested object has "confirmed": true
    cid_nested = start_call("room-nested-confirmed")
    # Case B: Top-level confirmed is true
    cid_clean_booked = start_call("room-clean-booked")
    # Case C: Plain text in user comments mentioning confirmed: true
    cid_comment = start_call("room-comment-confirmed")

    with new_session() as session:
        r_a = session.get(CallRecord, cid_nested)
        assert r_a is not None
        r_a.started_at = now - timedelta(minutes=25)
        r_a.session_slots = '{"booking_history": {"confirmed": true}, "confirmed": false}'

        r_b = session.get(CallRecord, cid_clean_booked)
        assert r_b is not None
        r_b.started_at = now - timedelta(minutes=25)
        r_b.session_slots = '{"confirmed": true}'

        r_c = session.get(CallRecord, cid_comment)
        assert r_c is not None
        r_c.started_at = now - timedelta(minutes=25)
        r_c.session_slots = (
            '{"notes": "Caller asked: is this \\"confirmed\\": true?", "confirmed": false}'
        )

        session.commit()

    reaped = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped == 3

    with new_session() as session:
        res_a = session.get(CallRecord, cid_nested)
        assert res_a is not None
        # String fallback matched '"confirmed": true' in nested object:
        assert res_a.outcome == "booked"

        res_b = session.get(CallRecord, cid_clean_booked)
        assert res_b is not None
        assert res_b.outcome == "booked"

        res_c = session.get(CallRecord, cid_comment)
        assert res_c is not None
        # In JSON with escaped quotes (\\"confirmed\\"), the literal substring
        # '"confirmed": true' does NOT match due to the backslash, so it defaults to info_only:
        assert res_c.outcome == "info_only"


# ---------------------------------------------------------------------------
# Dimension 3: Concurrency and Race Conditions
# ---------------------------------------------------------------------------


def test_reap_concurrent_invocations_multi_threaded() -> None:
    """Spawn multiple worker threads simultaneously calling reap_stale_calls().

    Verifies:
    1. Zero deadlocks under concurrent execution.
    2. Idempotent final state where every stale record is finalized exactly once.
    3. Handled transaction serialization without database corruption.
    """
    now = datetime.now(UTC)
    num_stale_records = 30
    num_threads = 8

    # Create batch of stale records
    created_ids: list[int] = []
    for i in range(num_stale_records):
        cid = start_call(f"room-concurrent-stale-{i}")
        with new_session() as session:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            rec.started_at = now - timedelta(minutes=25 + (i % 10))
            if i % 2 == 0:
                rec.session_slots = '{"confirmed": true}'
            session.commit()
        created_ids.append(cid)

    results: list[int] = []
    errors: list[Exception] = []

    def worker_reap() -> int:
        return reap_stale_calls(cutoff_minutes=20, duration_minutes=3)

    with concurrent.futures.ThreadPoolExecutor(max_workers=num_threads) as executor:
        futures = [executor.submit(worker_reap) for _ in range(num_threads)]
        for fut in concurrent.futures.as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as exc:
                errors.append(exc)

    assert not errors, f"Concurrent reap_stale_calls produced errors: {errors}"
    # Individual threads each sweep whatever records were active when their query ran
    assert len(results) == num_threads
    assert any(r > 0 for r in results)

    # Verify all records are finalized with ended_at populated
    with new_session() as session:
        for cid in created_ids:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            assert rec.ended_at is not None, f"Record {cid} was not finalized"
            assert rec.outcome in ("booked", "info_only")

    # Second pass must reap 0 records
    assert reap_stale_calls(cutoff_minutes=20, duration_minutes=3) == 0


def test_reap_concurrent_insert_and_sweep() -> None:
    """Simulate active traffic inserting calls while reaper runs in parallel."""
    stop_event = threading.Event()
    inserted_ids: list[int] = []
    errors: list[Exception] = []

    def traffic_generator() -> None:
        count = 0
        while not stop_event.is_set() and count < 25:
            try:
                cid = start_call(f"traffic-{count}")
                update_call_slots(cid, {"service": "AC Check", "confirmed": False})
                inserted_ids.append(cid)
                count += 1
            except Exception as e:
                errors.append(e)

    # Start 2 traffic generator threads
    t1 = threading.Thread(target=traffic_generator)
    t2 = threading.Thread(target=traffic_generator)
    t1.start()
    t2.start()

    # In main thread, call reaper multiple times
    reaper_counts: list[int] = []
    for _ in range(5):
        try:
            reaper_counts.append(reap_stale_calls(cutoff_minutes=20, duration_minutes=3))
        except Exception as e:
            errors.append(e)

    stop_event.set()
    t1.join()
    t2.join()

    assert not errors, f"Concurrent insert + reap produced errors: {errors}"

    # Verify fresh active calls were not reaped
    with new_session() as session:
        for cid in inserted_ids:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            assert rec.ended_at is None, f"Recent active call {cid} was incorrectly reaped"


def test_reap_extreme_concurrency_stress() -> None:
    """Extreme concurrency test: 20 worker threads simultaneously contending for SQLite write locks."""
    now = datetime.now(UTC)
    num_stale = 50
    num_threads = 20

    for i in range(num_stale):
        cid = start_call(f"room-heavy-concurrent-{i}")
        with new_session() as session:
            rec = session.get(CallRecord, cid)
            assert rec is not None
            rec.started_at = now - timedelta(minutes=30)
            session.commit()

    barrier = threading.Barrier(num_threads)
    errors: list[Exception] = []
    counts: list[int] = []

    def synced_worker() -> None:
        try:
            barrier.wait(timeout=5)
            c = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
            counts.append(c)
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=synced_worker) for _ in range(num_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # All threads must complete without unhandled deadlock or database corruption
    assert not errors, f"High concurrency produced errors: {errors}"
    assert len(counts) == num_threads

    # Verify all records finalized
    with new_session() as session:
        unended = session.query(CallRecord).filter(CallRecord.ended_at.is_(None)).count()
        assert unended == 0

    # Ensure second sweep is strictly 0
    assert reap_stale_calls() == 0
