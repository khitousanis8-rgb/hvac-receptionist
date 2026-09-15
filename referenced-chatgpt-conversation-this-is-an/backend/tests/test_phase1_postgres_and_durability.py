"""Tests for Phase 1: PostgreSQL support, dialect engine settings, fail-closed policy, and slot reuse upon cancellation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import inspect, schema
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.config import Settings, normalize_database_url
from app.db import Appointment, get_engine, init_db, reset_engine
from app.scheduling import (
    book_appointment,
    cancel_appointment,
)


def test_normalize_database_url() -> None:
    """Verify dialect URL normalization for SQLAlchemy 2.0 with psycopg."""
    assert (
        normalize_database_url("postgres://user:pass@host:5432/dbname")
        == "postgresql+psycopg://user:pass@host:5432/dbname"
    )
    assert (
        normalize_database_url("postgresql://user:pass@host:5432/dbname")
        == "postgresql+psycopg://user:pass@host:5432/dbname"
    )
    assert (
        normalize_database_url("postgresql+psycopg://user:pass@host:5432/dbname")
        == "postgresql+psycopg://user:pass@host:5432/dbname"
    )
    assert (
        normalize_database_url("sqlite:///./test.db")
        == "sqlite:///./test.db"
    )


def test_production_database_fail_closed() -> None:
    """Verify production fails closed if DATABASE_URL is SQLite or missing."""
    with pytest.raises(ValidationError, match="Ephemeral SQLite database"):
        Settings(
            app_env="production",
            database_url="sqlite:///./hvac_receptionist.db",
            allow_sqlite_in_production=False,
        )

    # Missing/empty DATABASE_URL fails
    with pytest.raises(ValidationError):
        Settings(
            app_env="production",
            database_url="",
            allow_sqlite_in_production=False,
        )

    # Valid PostgreSQL URL passes
    prod_settings = Settings(
        app_env="production",
        database_url="postgresql://user:pass@db.internal:5432/hvac_prod",
        allow_sqlite_in_production=False,
    )
    assert "postgresql+psycopg://" in prod_settings.database_url

    # Explicit override allows SQLite if operator specifically sets allow_sqlite_in_production
    override_settings = Settings(
        app_env="production",
        database_url="sqlite:///./hvac_receptionist.db",
        allow_sqlite_in_production=True,
    )
    assert override_settings.database_url == "sqlite:///./hvac_receptionist.db"


def test_partial_unique_index_ddl_compilation() -> None:
    """Verify that the partial unique index renders WHERE status = 'booked' for PostgreSQL and SQLite."""
    table = Appointment.__table__
    index_name = "uq_appointments_booked_scheduled_for"
    target_index = next((idx for idx in table.indexes if idx.name == index_name), None)
    assert target_index is not None, f"Index {index_name} not found on Appointment"

    pg_ddl = str(schema.CreateIndex(target_index).compile(dialect=postgresql.dialect()))
    assert "CREATE UNIQUE INDEX uq_appointments_booked_scheduled_for ON appointments (scheduled_for) WHERE status = 'booked'" in pg_ddl

    sqlite_ddl = str(schema.CreateIndex(target_index).compile(dialect=sqlite.dialect()))
    assert "WHERE status = 'booked'" in sqlite_ddl


def test_appointment_cancellation_and_slot_reuse(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify that cancelling an appointment allows the same slot to be re-booked without conflict."""
    test_db = tmp_path / "test_cancel_reuse.db"
    db_url = f"sqlite:///{test_db.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("APP_ENV", "test")
    reset_engine()

    init_db(db_url)
    engine = get_engine(db_url)

    settings = Settings(
        app_env="test",
        database_url=db_url,
        business_opening_hours={"monday": "08:00-18:00"},
        business_timezone="UTC",
    )

    # Find next Monday 10:00 AM UTC
    now = datetime.now(UTC)
    days_to_monday = (0 - now.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 7
    slot_time = (now + timedelta(days=days_to_monday)).replace(
        hour=10, minute=0, second=0, microsecond=0
    )

    with Session(engine) as session:
        # 1. Book first appointment
        appt1, msg1 = book_appointment(
            session=session,
            settings=settings,
            phone_number="+15555550111",
            service="AC Repair",
            when=slot_time,
            name="Alice",
        )
        assert appt1 is not None
        session.commit()
        appt1_id = appt1.id

    with Session(engine) as session:
        # 2. Another customer attempts to book the same slot -> Conflict
        appt2, msg2 = book_appointment(
            session=session,
            settings=settings,
            phone_number="+15555550222",
            service="Furnace Repair",
            when=slot_time,
            name="Bob",
        )
        assert appt2 is None
        assert "already taken" in msg2

    with Session(engine) as session:
        # 3. Cancel first appointment
        cancelled = cancel_appointment(session, appt1_id)
        assert cancelled is True
        session.commit()

        re_fetched = session.get(Appointment, appt1_id)
        assert re_fetched is not None
        assert re_fetched.status == "cancelled"

    with Session(engine) as session:
        # 4. Now Bob attempts to book the exact same slot -> Success!
        appt3, msg3 = book_appointment(
            session=session,
            settings=settings,
            phone_number="+15555550222",
            service="Furnace Repair",
            when=slot_time,
            name="Bob",
        )
        assert appt3 is not None
        assert "Booked" in msg3
        session.commit()

    reset_engine()


def test_init_db_idempotency_and_columns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify init_db can be called multiple times idempotently and creates all expected columns."""
    test_db = tmp_path / "test_idempotent.db"
    db_url = f"sqlite:///{test_db.as_posix()}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("APP_ENV", "test")
    reset_engine()

    # Call init_db twice
    init_db(db_url)
    init_db(db_url)

    engine = get_engine(db_url)
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("call_records")}

    expected_cols = {
        "id",
        "room_name",
        "caller_phone",
        "transcript_summary",
        "session_slots",
        "access_token_hash",
        "outcome",
        "started_at",
        "ended_at",
        "platform_class",
        "browser_engine",
        "input_path",
        "mic_permission",
        "end_reason",
        "client_metrics",
    }
    assert expected_cols.issubset(columns)

    reset_engine()
