# pyright: reportCallIssue=false
"""Adversarial stress tests for backend clause splitting and streaming.

Evaluates chat_api._split_into_clause_chunks and _stream_text_deltas:
1. Invariant: ''.join(chunks) == original_text across randomized fuzz and edge strings.
2. Event loop: Non-blocking cooperative streaming with async yield on each chunk.
3. Deterministic turns: Granular multi-clause chunking across all deterministic templates.
"""

from __future__ import annotations

import asyncio
import json
import random
import string
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.call_tracking import start_or_get_browser_call
from app.chat_api import _split_into_clause_chunks, _stream_text_deltas
from app.config import Settings
from app.main import create_app

_CALL_SECRET = "b" * 64


def test_clause_split_invariant_fuzzing() -> None:
    """Stress-test ''.join(chunks) == text invariant across 20,000 randomized strings."""
    char_pool = (
        string.ascii_letters
        + string.digits
        + string.punctuation
        + " \t\n\r"
        + "—–…“”‘’éàüö"
    )
    rng = random.Random(42)

    for _ in range(20000):
        length = rng.randint(0, 80)
        s = "".join(rng.choice(char_pool) for _ in range(length))
        chunks = _split_into_clause_chunks(s)
        assert "".join(chunks) == s, f"Invariant violated on random string: {s!r}"


def test_clause_split_edge_cases_invariant() -> None:
    """Verify invariant on boundary conditions, punctuation clusters, numbers, and quotes."""
    adversarial_inputs = [
        "",
        " ",
        "   ",
        "\t",
        "\n",
        "\n\n\n",
        ".",
        "!",
        "?",
        ",",
        ":",
        ";",
        "...",
        "....",
        "?!?",
        "!!!???",
        ":::;;;",
        ",,,,",
        'He said, "Hello, world!" and waved.',
        '"Wait!" she cried, "don\'t go!"',
        "(Note: this is an AC repair, right?)",
        "$1,500.00 for the unit, plus $250.50 labor.",
        "Total is $10,000. No discount.",
        "Call at 10:30 AM or 2:15 PM.",
        "Call at 10:30 a.m. or 2:15 p.m.",
        "Please call Dr. Smith at 555-0199.",
        "Appointment on Jan. 15 at 10:00 AM.",
        "Version 2.0.1 was released on Oct. 31.",
        "Thinking... okay, got it.",
        "Yes.... absolutely.",
        "First line.\nSecond line.\nThird line.",
        "Sarah’s heating & cooling… Ça va? Schön!",
        "A" * 5000,
        "A. " * 500,
        "\x00\x00.\x00\x00",
    ]

    for text in adversarial_inputs:
        chunks = _split_into_clause_chunks(text)
        assert "".join(chunks) == text, f"Invariant violated on input: {text!r}"


def test_clause_split_numeric_and_currency_protection() -> None:
    """Verify colons in times and commas in numbers are not split."""
    # Colons in times
    time_chunks = _split_into_clause_chunks("Appointment at 10:30 AM.")
    assert len(time_chunks) == 1
    assert time_chunks[0] == "Appointment at 10:30 AM."

    # Commas in currency/large numbers
    num_chunks = _split_into_clause_chunks("That will cost $1,500 total.")
    assert len(num_chunks) == 1
    assert num_chunks[0] == "That will cost $1,500 total."

    # Decimals in currency
    dec_chunks = _split_into_clause_chunks("The fee is $89.95 for diagnostic.")
    assert len(dec_chunks) == 1
    assert dec_chunks[0] == "The fee is $89.95 for diagnostic."


def test_clause_split_abbreviation_and_meridiem_observations() -> None:
    """Document empirical behavior on abbreviations and dotted meridiems."""
    # Invariant holds on dotted meridiems even when sub-chunked
    am_text = "Meet at 10:30 a.m. tomorrow."
    am_chunks = _split_into_clause_chunks(am_text)
    assert "".join(am_chunks) == am_text

    # Invariant holds on abbreviations before proper names
    dr_text = "Please call Dr. Smith today."
    dr_chunks = _split_into_clause_chunks(dr_text)
    assert "".join(dr_chunks) == dr_text

    # Invariant holds on ellipses
    el_text = "Thinking... okay, got it."
    el_chunks = _split_into_clause_chunks(el_text)
    assert "".join(el_chunks) == el_text


@pytest.mark.asyncio
async def test_streaming_event_loop_cooperativity() -> None:
    """Empirically prove that _stream_text_deltas does not block the asyncio event loop."""
    text = (
        "If you smell gas or smoke, please evacuate immediately and call 911 "
        "or your local utility company. Your safety is the top priority. "
        "Do not use electrical switches or phones inside the building."
    )

    interleaved_ticks = 0

    async def ticker() -> None:
        nonlocal interleaved_ticks
        while True:
            await asyncio.sleep(0)
            interleaved_ticks += 1

    ticker_task = asyncio.create_task(ticker())
    deltas: list[str] = []

    async for event in _stream_text_deltas(text):
        deltas.append(event)

    ticker_task.cancel()
    try:
        await ticker_task
    except asyncio.CancelledError:
        pass

    assert len(deltas) >= 3, f"Expected at least 3 deltas, got {len(deltas)}"
    # Verify ticker made progress between yielded chunks
    assert interleaved_ticks >= len(deltas) - 1, (
        f"Event loop was blocked: {interleaved_ticks} ticks for {len(deltas)} deltas"
    )

    # Verify SSE format and text reconstruction
    extracted_chunks = []
    for d in deltas:
        assert d.startswith("event: delta\ndata: ")
        assert d.endswith("\n\n")
        payload = json.loads(d.split("\ndata: ")[1].strip())
        extracted_chunks.append(payload["text"])

    assert "".join(extracted_chunks) == text


def test_deterministic_turn_streaming_fastapi_client() -> None:
    """Verify multi-clause chunking on deterministic turns via TestClient."""
    settings = Settings(
        BUSINESS_COMPANY_NAME="Blueridge Comfort Systems",
        BUSINESS_OPENING_HOURS={"monday": "8:00 AM - 6:00 PM"},
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    # 1. Greeting turn
    res = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "test-adv-greeting",
            "message": "__GREETING__",
            "call_secret": _CALL_SECRET,
        },
    )
    assert res.status_code == 200
    lines = res.text.strip().split("\n")
    deltas: list[str] = []
    for i, line in enumerate(lines):
        if line == "event: delta":
            data_line = lines[i + 1]
            if data_line.startswith("data: "):
                deltas.append(json.loads(data_line[6:])["text"])

    assert len(deltas) >= 2
    full_text = "".join(deltas)
    assert "Blueridge Comfort Systems" in full_text
    assert "Sarah" in full_text

    # 2. Safety emergency turn
    call_id = start_or_get_browser_call("test-adv-emergency", _CALL_SECRET)
    payload: dict[str, Any] = {
        "session_id": "test-adv-emergency",
        "message": "I smell gas in the house!",
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
    }
    res_emer = client.post("/v1/calls/chat", json=payload)
    assert res_emer.status_code == 200
    emer_lines = res_emer.text.strip().split("\n")
    emer_deltas: list[str] = []
    for i, line in enumerate(emer_lines):
        if line == "event: delta":
            data_line = emer_lines[i + 1]
            if data_line.startswith("data: "):
                emer_deltas.append(json.loads(data_line[6:])["text"])

    assert len(emer_deltas) >= 2
    full_emer = "".join(emer_deltas)
    assert "safety is the top priority" in full_emer.lower()
