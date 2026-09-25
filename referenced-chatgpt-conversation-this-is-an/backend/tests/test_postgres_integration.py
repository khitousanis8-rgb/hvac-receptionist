"""Opt-in PostgreSQL integration tests against a disposable local database.

These tests are skipped unless TEST_POSTGRES_URL is explicitly set and points
at a local, disposable database. They never run against the SQLite runtime
database or any non-local host. Run with:

    TEST_POSTGRES_URL=postgresql://... python -m pytest tests/test_postgres_integration.py -m postgres
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.config import get_settings
from app.db import (
    Appointment,
    Base,
    CallRecord,
    CallTurn,
    ConfirmationTicket,
    Customer,
    get_engine,
    init_db,
    new_session,
    reset_engine,
)
from app.scheduling import cancel_appointment

pytestmark = pytest.mark.postgres

_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _postgres_url() -> str:
    """Return the explicit opt-in URL, refusing unsafe or missing targets."""
    url = os.environ.get("TEST_POSTGRES_URL", "").strip()
    if not url:
        pytest.skip("TEST_POSTGRES_URL not set; PostgreSQL integration is opt-in")
    if not url.startswith(("postgresql://", "postgresql+psycopg://")):
        pytest.fail("TEST_POSTGRES_URL must be a PostgreSQL URL")
    host = url.split("://", 1)[1].split("/")[0].split("@")[-1].split(":")[0]
    if host.lower() not in _ALLOWED_HOSTS:
        pytest.fail(
            f"Refusing non-local PostgreSQL target '{host}'; "
            "integration tests must use a disposable local database"
        )
    return url


@pytest.fixture()
def postgres_db() -> Iterator[str]:
    """Provide a clean disposable PostgreSQL schema for one test."""
    url = _postgres_url()
    reset_engine()
    get_settings.cache_clear()
    try:
        init_db(url)
        yield url
    finally:
        reset_engine()
        get_settings.cache_clear()


def test_postgres_creates_all_tables(postgres_db: str) -> None:
    engine = get_engine()
    assert engine.dialect.name == "postgresql"
    existing = set(inspect(engine).get_table_names())
    for table in Base.metadata.tables:
        assert table in existing, f"Table '{table}' was not created"


def test_postgres_utc_timestamp_round_trip(postgres_db: str) -> None:
    moment = datetime(2030, 6, 3, 14, 0, 0, tzinfo=UTC)
    with new_session() as session:
        record = CallRecord(room_name="pg-utc-round-trip", started_at=moment)
        session.add(record)
        session.flush()
        record_id = record.id
    with new_session() as session:
        loaded = session.get(CallRecord, record_id)
        assert loaded is not None
        assert loaded.started_at is not None
        assert loaded.started_at.tzinfo is not None
        assert loaded.started_at.astimezone(UTC) == moment


def test_postgres_booking_uniqueness_and_cancellation(postgres_db: str) -> None:
    moment = datetime(2030, 6, 3, 14, 0, 0, tzinfo=UTC)
    with new_session() as session:
        customer = Customer(phone_number="+15555550901", name="PG Synthetic")
        session.add(customer)
        session.flush()
        session.add(
            Appointment(
                customer_id=customer.id, service="AC repair",
                scheduled_for=moment, status="booked",
            )
        )

    with new_session() as session:
        second = Customer(phone_number="+15555550902", name="PG Second")
        session.add(second)

    # A second booked appointment at the same time violates the partial index.
    with pytest.raises(IntegrityError):
        with new_session() as session:
            cust = session.query(Customer).filter_by(phone_number="+15555550902").one()
            session.add(
                Appointment(
                    customer_id=cust.id, service="Furnace repair",
                    scheduled_for=moment, status="booked",
                )
            )

    with new_session() as session:
        booked = session.query(Appointment).filter_by(status="booked").one()
        assert cancel_appointment(session, booked.id) is True
    with new_session() as session:
        cancelled = session.query(Appointment).one()
        assert cancelled.status == "cancelled"

    # The freed slot can be booked again after cancellation.
    with new_session() as session:
        customer = session.query(Customer).filter_by(phone_number="+15555550902").one()
        session.add(
            Appointment(
                customer_id=customer.id, service="Furnace repair",
                scheduled_for=moment, status="booked",
            )
        )


def test_postgres_call_turns_and_confirmation_tickets(postgres_db: str) -> None:
    with new_session() as session:
        for index, role in enumerate(["assistant", "user", "assistant"]):
            session.add(
                CallTurn(
                    call_id="pg-turns-call", turn_index=index,
                    role=role, content=f"turn {index}",
                )
            )
    with new_session() as session:
        turns = (
            session.query(CallTurn)
            .filter(CallTurn.call_id == "pg-turns-call")
            .order_by(CallTurn.turn_index)
            .all()
        )
        assert [turn.role for turn in turns] == ["assistant", "user", "assistant"]

    moment = datetime(2030, 6, 3, 15, 0, 0, tzinfo=UTC)
    with new_session() as session:
        ticket = ConfirmationTicket(
            ticket_id="tkt_pg_integration_01", call_id="pg-turns-call",
            service="AC repair", phone="+15555550901",
            scheduled_for=moment, fingerprint="fp-pg-integration",
            status="pending",
            created_at=moment, expires_at=moment + timedelta(minutes=5),
        )
        session.add(ticket)
    with new_session() as session:
        loaded = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.ticket_id == "tkt_pg_integration_01")
            .one()
        )
        assert loaded.status == "pending"
        assert loaded.scheduled_for.astimezone(UTC) == moment


def test_postgres_rollback_on_error_preserves_prior_state(postgres_db: str) -> None:
    with new_session() as session:
        session.add(CallRecord(room_name="pg-rollback-keep"))
    with pytest.raises(DBAPIError):
        with new_session() as session:
            session.add(CallRecord(room_name="pg-rollback-doomed"))
            session.execute(text("SELECT 1/0"))
    with new_session() as session:
        rooms = [
            record.room_name
            for record in session.query(CallRecord).filter(
                CallRecord.room_name.like("pg-rollback-%")
            )
        ]
    assert rooms == ["pg-rollback-keep"]


def test_postgres_session_commit_visibility(postgres_db: str) -> None:
    with new_session() as session:
        session.add(CallRecord(room_name="pg-visibility"))
    with new_session() as session:
        count = (
            session.query(CallRecord)
            .filter(CallRecord.room_name == "pg-visibility")
            .count()
        )
    assert count == 1