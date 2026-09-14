"""Automated verification suite ensuring 100% test database isolation and zero runtime DB pollution."""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import NamedTuple

import pytest
from fastapi.testclient import TestClient

from app.call_tracking import start_or_get_browser_call
from app.config import Settings, get_settings
from app.db import (
    Appointment,
    CallRecord,
    Customer,
    get_engine,
    init_db,
    new_session,
    reset_engine,
)
from app.main import create_app

# Absolute path to the runtime database in referenced-chatgpt-conversation-this-is-an/backend
RUNTIME_DB_PATH = (Path(__file__).resolve().parent.parent / "hvac_receptionist.db").resolve()


class DatabaseSnapshot(NamedTuple):
    """Immutable snapshot of SQLite database file metrics and table row counts."""

    exists: bool
    size_bytes: int | None
    md5_hash: str | None
    sha256_hash: str | None
    call_records_count: int | None
    customers_count: int | None
    appointments_count: int | None


def capture_snapshot(db_path: Path) -> DatabaseSnapshot:
    """Capture a byte-level and row-level snapshot of a SQLite database.

    Uses strict read-only URI mode (?mode=ro) to guarantee no journal files,
    write locks, or timestamp mutations are produced during inspection.
    """
    if not db_path.exists():
        return DatabaseSnapshot(
            exists=False,
            size_bytes=None,
            md5_hash=None,
            sha256_hash=None,
            call_records_count=None,
            customers_count=None,
            appointments_count=None,
        )

    data = db_path.read_bytes()
    size = len(data)
    md5 = hashlib.md5(data).hexdigest()
    sha256 = hashlib.sha256(data).hexdigest()

    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        cursor = conn.cursor()
        calls = cursor.execute("SELECT COUNT(*) FROM call_records").fetchone()[0]
        customers = cursor.execute("SELECT COUNT(*) FROM customers").fetchone()[0]
        appts = cursor.execute("SELECT COUNT(*) FROM appointments").fetchone()[0]

    return DatabaseSnapshot(
        exists=True,
        size_bytes=size,
        md5_hash=md5,
        sha256_hash=sha256,
        call_records_count=int(calls),
        customers_count=int(customers),
        appointments_count=int(appts),
    )


def assert_snapshots_identical(before: DatabaseSnapshot, after: DatabaseSnapshot) -> None:
    """Assert that two snapshots are strictly identical across all metrics."""
    assert before.exists == after.exists, (
        f"Database existence changed: before={before.exists}, after={after.exists}"
    )
    if not before.exists:
        return

    assert before.size_bytes == after.size_bytes, (
        f"Database size changed: before={before.size_bytes} bytes, after={after.size_bytes} bytes"
    )
    assert before.md5_hash == after.md5_hash, (
        f"Database MD5 hash changed: before={before.md5_hash}, after={after.md5_hash}"
    )
    assert before.sha256_hash == after.sha256_hash, (
        f"Database SHA256 hash changed: before={before.sha256_hash}, after={after.sha256_hash}"
    )
    assert before.call_records_count == after.call_records_count, (
        f"call_records count changed: before={before.call_records_count}, after={after.call_records_count}"
    )
    assert before.customers_count == after.customers_count, (
        f"customers count changed: before={before.customers_count}, after={after.customers_count}"
    )
    assert before.appointments_count == after.appointments_count, (
        f"appointments count changed: before={before.appointments_count}, after={after.appointments_count}"
    )


def test_active_engine_points_to_temporary_database() -> None:
    """Verify that under test execution, settings and engine point to an isolated temp database."""
    settings = get_settings()
    engine = get_engine()

    assert settings.database_url.startswith("sqlite:///"), (
        f"Expected sqlite URL, got {settings.database_url}"
    )
    assert "hvac_receptionist.db" not in settings.database_url.lower(), (
        f"Settings database_url points to runtime database: {settings.database_url}"
    )
    assert "hvac_receptionist.db" not in str(engine.url).lower(), (
        f"Engine URL points to runtime database: {engine.url}"
    )


def test_database_operations_mutate_temp_db_without_polluting_runtime_db() -> None:
    """Verify that comprehensive DB writes mutate only the isolated test DB, leaving runtime DB untouched."""
    before = capture_snapshot(RUNTIME_DB_PATH)

    # 1. Perform mutating write operations via call tracking
    call_id = start_or_get_browser_call("test-isolation-room-101", "b" * 64)
    assert call_id > 0

    # 2. Perform direct ORM inserts
    with new_session() as session:
        customer = Customer(phone_number="+15550009999", name="Zero Pollution Tester")
        session.add(customer)
        session.flush()

        appt = Appointment(
            customer_id=customer.id,
            service="AC Repair",
            scheduled_for=datetime.now(UTC),
            status="booked",
            notes="Isolation verification test",
        )
        session.add(appt)
        session.commit()

    # 3. Perform FastAPI app request with TestClient
    app = create_app(Settings(BUSINESS_COMPANY_NAME="Isolation HVAC", _env_file=None))
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200

    # 4. Verify that the isolated test database actually contains the written records
    with new_session() as session:
        temp_calls = session.query(CallRecord).count()
        temp_customers = session.query(Customer).count()
        temp_appts = session.query(Appointment).count()
        assert temp_calls >= 1
        assert temp_customers >= 1
        assert temp_appts >= 1

    # 5. Capture post-mutation snapshot of runtime database and assert 100% identity
    after = capture_snapshot(RUNTIME_DB_PATH)
    assert_snapshots_identical(before, after)


def test_isolation_guard_blocks_relative_runtime_url() -> None:
    """Verify that calling get_engine with relative runtime DB URL raises RuntimeError."""
    with pytest.raises(RuntimeError, match="Database isolation guard violation"):
        get_engine("sqlite:///./hvac_receptionist.db")


def test_isolation_guard_blocks_bare_filename_runtime_url() -> None:
    """Verify that calling get_engine with bare filename runtime DB URL raises RuntimeError."""
    with pytest.raises(RuntimeError, match="Database isolation guard violation"):
        get_engine("sqlite:///hvac_receptionist.db")


def test_isolation_guard_blocks_absolute_runtime_url() -> None:
    """Verify that calling get_engine with absolute path to runtime DB raises RuntimeError."""
    runtime_abs_url = f"sqlite:///{RUNTIME_DB_PATH.as_posix()}"
    with pytest.raises(RuntimeError, match="Database isolation guard violation"):
        get_engine(runtime_abs_url)


def test_isolation_guard_blocks_init_db_on_runtime_url() -> None:
    """Verify that calling init_db with runtime DB URL raises RuntimeError."""
    with pytest.raises(RuntimeError, match="Database isolation guard violation"):
        init_db("sqlite:///./hvac_receptionist.db")


def test_isolation_guard_blocks_env_bypass_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify that an intentional attempt to bypass isolation via environment tampering raises RuntimeError."""
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./hvac_receptionist.db")
    get_settings.cache_clear()
    reset_engine()

    try:
        with pytest.raises(RuntimeError, match="Database isolation guard violation"):
            get_engine()
    finally:
        reset_engine()
        get_settings.cache_clear()


def test_reset_engine_disposes_connection_pool_releasing_windows_file_locks(tmp_path: Path) -> None:
    """Verify that reset_engine disposes connection pools, allowing immediate file deletion on Windows."""
    lock_db_path = tmp_path / "lock_test.db"
    lock_db_url = f"sqlite:///{lock_db_path.as_posix()}"

    reset_engine()
    init_db(lock_db_url)

    with new_session() as session:
        session.add(Customer(phone_number="+15558880001", name="Lock Test Customer"))
        session.commit()

    assert lock_db_path.exists()

    # Reset engine, which must call _engine.dispose()
    reset_engine()

    # If _engine.dispose() was omitted, Windows raises PermissionError: [WinError 32]
    lock_db_path.unlink()
    assert not lock_db_path.exists()


def test_consecutive_isolated_tests_have_pristine_tables() -> None:
    """Verify that each test receives an initially empty database without state bleeding."""
    with new_session() as session:
        assert session.query(CallRecord).count() == 0
        assert session.query(Customer).count() == 0
        assert session.query(Appointment).count() == 0
