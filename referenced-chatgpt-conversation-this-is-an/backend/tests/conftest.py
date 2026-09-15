"""Root test configuration ensuring complete SQLite database isolation.

This module provides:
1. Environment configuration (APP_ENV="test") and sys.path resolution.
2. An autouse per-test fixture (isolate_test_db) allocating an isolated temporary
   SQLite database in pytest's tmp_path, monkeypatching DATABASE_URL, clearing
   cached settings, initializing tables, and disposing connection pools on teardown.
3. Session-level verification hooks (pytest_sessionstart, pytest_sessionfinish)
   guaranteeing zero row count changes or byte mutations to the runtime database.
4. Backward-compatible fixture aliases (isolate_database, db).
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import sys
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest

# Ensure backend directory is on sys.path so pytest discovers `app` seamlessly
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from app.config import get_settings  # noqa: E402
from app.db import init_db, reset_engine  # noqa: E402

_RUNTIME_DB_SNAPSHOT: dict[str, Any] = {}


def pytest_configure(config: pytest.Config) -> None:
    """Set global environment flag identifying test execution."""
    os.environ["APP_ENV"] = "test"


def _get_runtime_db_path() -> Path:
    """Return the absolute path to the runtime database file."""
    return backend_dir / "hvac_receptionist.db"


def _capture_db_state(db_path: Path) -> dict[str, Any]:
    """Capture file size, md5 checksum, and row counts of a database."""
    if not db_path.exists():
        return {"exists": False}

    data = db_path.read_bytes()
    md5 = hashlib.md5(data).hexdigest()
    size = len(data)

    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        cur = conn.cursor()
        try:
            calls = cur.execute("SELECT count(*) FROM call_records").fetchone()[0]
        except sqlite3.OperationalError:
            calls = 0
        try:
            customers = cur.execute("SELECT count(*) FROM customers").fetchone()[0]
        except sqlite3.OperationalError:
            customers = 0
        try:
            appts = cur.execute("SELECT count(*) FROM appointments").fetchone()[0]
        except sqlite3.OperationalError:
            appts = 0

    return {
        "exists": True,
        "size": size,
        "md5": md5,
        "calls": calls,
        "customers": customers,
        "appointments": appts,
    }


def pytest_sessionstart(session: pytest.Session) -> None:
    """Snapshot the runtime database before any tests execute."""
    global _RUNTIME_DB_SNAPSHOT
    runtime_db = _get_runtime_db_path()
    _RUNTIME_DB_SNAPSHOT = _capture_db_state(runtime_db)


def pytest_sessionfinish(session: pytest.Session, exitstatus: int | pytest.ExitCode) -> None:
    """Verify that the runtime database has suffered zero mutations during test execution."""
    global _RUNTIME_DB_SNAPSHOT
    runtime_db = _get_runtime_db_path()

    if not _RUNTIME_DB_SNAPSHOT.get("exists", False):
        if runtime_db.exists():
            pytest.fail(
                "Runtime database 'hvac_receptionist.db' was created during test execution! "
                "Tests must execute exclusively against isolated temporary databases."
            )
        return

    current_state = _capture_db_state(runtime_db)

    diffs: list[str] = []
    if current_state["size"] != _RUNTIME_DB_SNAPSHOT["size"]:
        diffs.append(
            f"Size changed: {_RUNTIME_DB_SNAPSHOT['size']} -> {current_state['size']} bytes"
        )
    if current_state["md5"] != _RUNTIME_DB_SNAPSHOT["md5"]:
        diffs.append(f"MD5 changed: {_RUNTIME_DB_SNAPSHOT['md5']} -> {current_state['md5']}")
    if current_state["calls"] != _RUNTIME_DB_SNAPSHOT["calls"]:
        diffs.append(
            f"Call count changed: {_RUNTIME_DB_SNAPSHOT['calls']} -> {current_state['calls']}"
        )
    if current_state["customers"] != _RUNTIME_DB_SNAPSHOT["customers"]:
        diffs.append(
            f"Customer count changed: {_RUNTIME_DB_SNAPSHOT['customers']} -> {current_state['customers']}"
        )
    if current_state["appointments"] != _RUNTIME_DB_SNAPSHOT["appointments"]:
        diffs.append(
            f"Appointment count changed: {_RUNTIME_DB_SNAPSHOT['appointments']} -> {current_state['appointments']}"
        )

    if diffs:
        pytest.fail(
            "Runtime database contamination detected! The test suite mutated 'hvac_receptionist.db':\n"
            + "\n".join(f"- {d}" for d in diffs)
        )


@pytest.fixture(autouse=True)
def isolate_test_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[str, None, None]:
    """Provide a fresh, isolated temporary SQLite database for every single test."""
    test_db_file = tmp_path / "test.db"
    db_url = f"sqlite:///{test_db_file.as_posix()}"

    monkeypatch.setenv("DATABASE_URL", db_url)
    monkeypatch.setenv("APP_ENV", "test")
    get_settings.cache_clear()

    reset_engine()
    init_db()
    from app.security import reset_rate_limits
    reset_rate_limits()

    try:
        yield db_url
    finally:
        reset_engine()
        get_settings.cache_clear()
        reset_rate_limits()


@pytest.fixture()
def isolate_database(isolate_test_db: str) -> str:
    """Backward-compatible fixture alias for isolate_test_db."""
    return isolate_test_db


@pytest.fixture()
def db(isolate_test_db: str) -> str:
    """Backward-compatible fixture alias for tests declaring a `db` parameter."""
    return isolate_test_db
