# pyright: reportAttributeAccessIssue=false
"""Database engine, session, ORM models, and repeatable migration helpers. (SQLite)."""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, overload

from sqlalchemy import (
    DateTime,
    Engine,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    func,
    inspect,
    text,
)
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


class UTCDateTime(TypeDecorator[datetime]):
    """Store SQLite timestamps as UTC and always return aware datetimes.

    SQLite has no timezone-aware datetime type.  Normalising on both sides of
    the database boundary prevents a UTC wall-clock value from being rendered
    as the browser's local time.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        normalized = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return normalized.replace(tzinfo=None) if dialect.name == "sqlite" else normalized

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Customer(Base):
    """A caller known to the business."""

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    phone_number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)


class CallRecord(Base):
    """One receptionist session: who called, what happened, and the outcome."""

    __tablename__ = "call_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    room_name: Mapped[str] = mapped_column(String(200), index=True)
    caller_phone: Mapped[str | None] = mapped_column(String(32), default=None)
    transcript_summary: Mapped[str | None] = mapped_column(Text, default=None)
    session_slots: Mapped[str | None] = mapped_column(Text, default=None)
    access_token_hash: Mapped[str | None] = mapped_column(String(64), index=True, default=None)
    outcome: Mapped[str] = mapped_column(String(40), default="in_progress", index=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), default=None)
    platform_class: Mapped[str | None] = mapped_column(String(20), index=True, default=None)
    browser_engine: Mapped[str | None] = mapped_column(String(20), default=None)
    input_path: Mapped[str | None] = mapped_column(String(40), default=None)
    mic_permission: Mapped[str | None] = mapped_column(String(20), default=None)
    end_reason: Mapped[str | None] = mapped_column(String(40), default=None)
    client_metrics: Mapped[str | None] = mapped_column(Text, default=None)


class Appointment(Base):
    """A booked service visit within business hours."""

    __tablename__ = "appointments"
    __table_args__ = (
        Index(
            "uq_appointments_booked_scheduled_for",
            "scheduled_for",
            unique=True,
            sqlite_where=text("status = 'booked'"),
            postgresql_where=text("status = 'booked'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    service: Mapped[str] = mapped_column(String(200))
    scheduled_for: Mapped[datetime] = mapped_column(UTCDateTime(), index=True)
    status: Mapped[str] = mapped_column(String(20), default="booked", index=True)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)


class CallTurn(Base):
    """Server-persisted dialogue turn for authoritative session memory."""

    __tablename__ = "call_turns"
    __table_args__ = (
        Index("ix_call_turns_call_id_turn_index", "call_id", "turn_index"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    call_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=_utcnow)


class RateLimitEvent(Base):
    """One sliding-window rate-limit event for the durable limiter backend."""

    __tablename__ = "rate_limit_events"
    __table_args__ = (
        Index("ix_rate_limit_events_key_created_at", "key", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False, default=_utcnow
    )


class ConfirmationTicket(Base):
    """Short-lived, single-use confirmation ticket bound to a call and booking fingerprint."""

    __tablename__ = "confirmation_tickets"
    __table_args__ = (
        Index("ix_confirmation_tickets_call_id", "call_id"),
        Index("ix_confirmation_tickets_ticket_id", "ticket_id", unique=True),
        Index("ix_confirmation_tickets_fingerprint", "fingerprint"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ticket_id: Mapped[str] = mapped_column(String(64), nullable=False)
    call_id: Mapped[str] = mapped_column(String(64), nullable=False)
    service: Mapped[str] = mapped_column(String(200), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    scheduled_for: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True, default=None)
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id"), nullable=True, default=None
    )


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None
_engine_lock = threading.Lock()


def _is_test_environment() -> bool:
    """Return True if executing within a test runner or test environment."""
    return (
        os.getenv("APP_ENV") == "test"
        or "PYTEST_CURRENT_TEST" in os.environ
        or "PYTEST_VERSION" in os.environ
        or "pytest" in sys.modules
    )


def _is_runtime_database(database_url: str) -> bool:
    """Return True if the target URL resolves to the production SQLite database."""
    try:
        url = make_url(database_url)
        if url.get_backend_name() != "sqlite":
            return False
        db_path = url.database
        if not db_path or db_path == ":memory:":
            return False
        resolved = Path(db_path)
        if resolved.name.lower() == "hvac_receptionist.db":
            return True
        return resolved.resolve().name.lower() == "hvac_receptionist.db"
    except Exception:
        clean_url = database_url.split("?")[0].split("#")[0].replace("\\", "/")
        filename = clean_url.rstrip("/").split("/")[-1].lower()
        return filename == "hvac_receptionist.db"


def get_engine(database_url: str | None = None) -> Engine:
    """Create (once) and return the SQLAlchemy engine from settings."""
    global _engine, _SessionLocal
    target_url = database_url or (
        str(_engine.url) if _engine is not None else get_settings().database_url
    )

    if _is_test_environment() and _is_runtime_database(target_url):
        raise RuntimeError(
            "Database isolation guard violation: "
            "Test execution attempted to connect to runtime database 'hvac_receptionist.db'. "
            "All tests must run against isolated temporary databases."
        )

    if _engine is None or (database_url is not None and str(_engine.url) != database_url):
        with _engine_lock:
            if (
                _engine is not None
                and database_url is not None
                and str(_engine.url) != database_url
            ):
                _engine.dispose()
                _engine = None
                _SessionLocal = None

            if _engine is None:
                settings = get_settings()
                create_url = database_url or settings.database_url
                url_obj = make_url(create_url)
                engine_kwargs: dict[str, Any] = {}
                if url_obj.get_backend_name() == "sqlite":
                    engine_kwargs["connect_args"] = {"check_same_thread": False}
                else:
                    engine_kwargs["pool_size"] = settings.db_pool_size
                    engine_kwargs["max_overflow"] = settings.db_max_overflow
                    engine_kwargs["pool_recycle"] = settings.db_pool_recycle
                    engine_kwargs["pool_pre_ping"] = settings.db_pool_pre_ping
                _engine = create_engine(
                    create_url,
                    **engine_kwargs,
                )
                _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    assert _engine is not None
    return _engine


def reset_engine() -> None:
    """Drop the cached engine and dispose open connection pools (releasing file handles)."""
    global _engine, _SessionLocal
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
            _engine = None
        _SessionLocal = None


def init_db(database_url: str | None = None) -> None:
    """Create tables and apply dialect-aware, backwards-compatible migrations."""
    engine = get_engine(database_url)
    Base.metadata.create_all(engine)

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    is_sqlite = engine.dialect.name == "sqlite"
    is_postgres = engine.dialect.name == "postgresql"

    if "call_turns" not in existing_tables and "call_turns" in Base.metadata.tables:
        Base.metadata.create_all(engine, tables=[Base.metadata.tables["call_turns"]])

    if (
        "confirmation_tickets" not in existing_tables
        and "confirmation_tickets" in Base.metadata.tables
    ):
        Base.metadata.create_all(engine, tables=[Base.metadata.tables["confirmation_tickets"]])

    if "call_records" not in existing_tables:
        return

    columns = {column["name"] for column in inspector.get_columns("call_records")}

    with engine.begin() as connection:
        for col_name, col_type in [
            ("session_slots", "TEXT"),
            ("access_token_hash", "VARCHAR(64)"),
            ("platform_class", "VARCHAR(20)"),
            ("browser_engine", "VARCHAR(20)"),
            ("input_path", "VARCHAR(40)"),
            ("mic_permission", "VARCHAR(20)"),
            ("end_reason", "VARCHAR(40)"),
            ("client_metrics", "TEXT"),
        ]:
            if col_name not in columns:
                if is_postgres:
                    connection.execute(
                        text(
                            f"ALTER TABLE call_records ADD COLUMN IF NOT EXISTS "
                            f"{col_name} {col_type}"
                        )
                    )
                else:
                    connection.execute(
                        text(f"ALTER TABLE call_records ADD COLUMN {col_name} {col_type}")
                    )

        if is_sqlite or is_postgres:
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_call_records_access_token_hash "
                    "ON call_records (access_token_hash)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_call_records_platform_class "
                    "ON call_records (platform_class)"
                )
            )
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_booked_scheduled_for "
                    "ON appointments (scheduled_for) WHERE status = 'booked'"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_call_turns_call_id_turn_index "
                    "ON call_turns (call_id, turn_index)"
                )
            )
            connection.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ix_confirmation_tickets_ticket_id "
                    "ON confirmation_tickets (ticket_id)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_confirmation_tickets_call_id "
                    "ON confirmation_tickets (call_id)"
                )
            )
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_confirmation_tickets_fingerprint "
                    "ON confirmation_tickets (fingerprint)"
                )
            )


@contextmanager
def new_session() -> Iterator[Session]:
    """Provide a database session, committing on success and rolling back on error."""
    get_engine()
    assert _SessionLocal is not None
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _record_call_turn_internal(
    db: Session,
    call_id: str,
    role: str,
    content: str,
) -> CallTurn:
    max_index = (
        db.query(func.max(CallTurn.turn_index))
        .filter(CallTurn.call_id == call_id)
        .scalar()
    )
    next_index = 0 if max_index is None else int(max_index) + 1
    turn = CallTurn(
        call_id=call_id,
        turn_index=next_index,
        role=role,
        content=content,
        created_at=_utcnow(),
    )
    db.add(turn)
    db.flush()
    return turn


def _get_recent_call_turns_internal(
    db: Session,
    call_id: str,
    limit: int = 12,
) -> list[CallTurn]:
    turns = (
        db.query(CallTurn)
        .filter(CallTurn.call_id == call_id)
        .order_by(CallTurn.turn_index.desc())
        .limit(limit)
        .all()
    )
    return list(reversed(turns))


@overload
def record_call_turn(
    db: Session,
    call_id: str | int,
    role: str,
    content: str,
) -> CallTurn: ...


@overload
def record_call_turn(
    db: str | int,
    call_id: str,
    role: str,
    content: None = None,
) -> CallTurn: ...


def record_call_turn(
    db: Session | str | int,
    call_id: str | int,
    role: str,
    content: str | None = None,
) -> CallTurn:
    """Record an authoritative conversation turn in the database.

    Accepts (db, call_id, role, content) or (call_id, role, content).
    """
    if isinstance(db, Session):
        return _record_call_turn_internal(
            db,
            str(call_id),
            role,
            content or "",
        )
    with new_session() as session:
        turn = _record_call_turn_internal(
            session,
            str(db),
            str(call_id),
            role,
        )
        session.commit()
        return turn


@overload
def get_recent_call_turns(
    db: Session,
    call_id: str | int,
    limit: int = 12,
) -> list[CallTurn]: ...


@overload
def get_recent_call_turns(
    db: str | int,
    call_id: int = 12,
    limit: int = 12,
) -> list[CallTurn]: ...


def get_recent_call_turns(
    db: Session | str | int,
    call_id: str | int = 12,
    limit: int = 12,
) -> list[CallTurn]:
    """Fetch recent conversation turns for a call in chronological order (oldest first).

    Accepts (db, call_id, limit=12) or (call_id, limit=12).
    """
    if isinstance(db, Session):
        turn_limit = limit if isinstance(limit, int) else 12
        return _get_recent_call_turns_internal(
            db,
            str(call_id),
            turn_limit,
        )
    turn_limit = int(call_id) if isinstance(call_id, int) else 12
    with new_session() as session:
        return _get_recent_call_turns_internal(
            session,
            str(db),
            turn_limit,
        )


def create_confirmation_ticket(
    db: Session,
    call_id: str | int,
    service: str,
    phone: str,
    scheduled_for: datetime,
    fingerprint: str,
    ttl_seconds: int = 300,
) -> ConfirmationTicket:
    """Create a single-use short-lived confirmation ticket.

    Cancels any previous pending tickets for the same call.
    """
    from uuid import uuid4

    now = _utcnow()
    expires_at = now + timedelta(seconds=ttl_seconds)
    ticket_id = f"tkt_{uuid4().hex[:12]}"

    db.query(ConfirmationTicket).filter(
        ConfirmationTicket.call_id == str(call_id),
        ConfirmationTicket.status == "pending",
    ).update({"status": "cancelled"})

    ticket = ConfirmationTicket(
        ticket_id=ticket_id,
        call_id=str(call_id),
        service=service,
        phone=phone,
        scheduled_for=scheduled_for,
        fingerprint=fingerprint,
        status="pending",
        created_at=now,
        expires_at=expires_at,
    )
    db.add(ticket)
    db.flush()
    return ticket


def get_confirmation_ticket(
    db: Session,
    ticket_id: str,
) -> ConfirmationTicket | None:
    """Look up a confirmation ticket by its ticket_id."""
    return (
        db.query(ConfirmationTicket)
        .filter(ConfirmationTicket.ticket_id == ticket_id)
        .one_or_none()
    )

