"""Empirical Adversarial Challenge Suite for Milestone 3: Backend Disconnect & Task Cancellation.

Tests rigorously stress:
1. Client disconnection at every phase of SSE streaming:
   - Initial chunk disconnect (immediate abort)
   - Mid-stream disconnect (delta truncation)
   - Disconnect before tool execution (skips tool execution entirely)
   - Disconnect between multiple tool calls (aborts subsequent tools)
   - Disconnect before second stream pass (skips pass 2)
   - Disconnect mid-second stream pass (aborts pass 2)
   - Zero corrupted/partial assistant turns committed to database in any disconnect case.
2. Rapid sequential requests and barge-in in-flight task cancellation:
   - Cancellation of in-flight streaming task by subsequent turn
   - Storm of 10 rapid sequential requests with preemption
   - Multi-call isolation: cancelling Call A never affects Call B
   - Task dictionary cleanup race preservation in finally block
   - Echo arrival barge-in cancellation of prior task
3. Database integrity:
   - Zero orphaned appointments or incomplete turns
   - Runtime database isolation
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.call_tracking import start_or_get_browser_call
from app.chat_api import (
    ChatRequest,
    _active_chat_tasks,
    chat_stream,
)
from app.config import Settings
from app.db import Appointment, CallTurn, new_session
from app.main import create_app

_CALL_SECRET = "a" * 64


def _browser_payload(room: str, call_id: int, message: str) -> dict[str, Any]:
    return {
        "session_id": room,
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
        "message": message,
        "channel": "browser",
    }


def _make_chunk(content: str | None = None, tool_calls: list[Any] | None = None) -> Any:
    delta = type("Delta", (), {"content": content, "tool_calls": tool_calls})()
    return type("Chunk", (), {"choices": [type("Choice", (), {"delta": delta})()]})()


def _make_fake_request(settings: Settings, is_disconnected_func: Any = None) -> AsyncMock:
    req = AsyncMock(spec=Request)
    req.client = type("Client", (), {"host": "127.0.0.1"})()
    req.headers = {}
    req.app = type("App", (), {"state": type("State", (), {"settings": settings})()})()
    if is_disconnected_func is not None:
        req.is_disconnected = is_disconnected_func
    else:
        req.is_disconnected = AsyncMock(return_value=False)
    return req


# ---------------------------------------------------------------------------
# Category 1: Client Disconnection at Every Phase of SSE Generation
# ---------------------------------------------------------------------------


def test_disconnect_at_initial_token_stream() -> None:
    """Stress test: client disconnects immediately on first token check."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-init-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    async def fake_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        for i in range(5):
            yield _make_chunk(content=f"Token {i} ")

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_stream)
        mock_get_client.return_value = mock_openai

        # Disconnect immediately on first check
        async def mock_is_disconnected(self: Request) -> bool:
            return True

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "What kind of maintenance services do you offer?"),
            )
            assert res.status_code == 200
            # Since client was disconnected immediately, no delta should be yielded
            assert "event: delta" not in res.text
            assert "event: done" not in res.text

    # Verify zero assistant turns in database
    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0, "Aborted stream must NOT record assistant turn"
        # Caller message was recorded authoritatively
        caller_turns = session.query(CallTurn).filter_by(call_id=call_id, role="caller").all()
        assert len(caller_turns) == 1

    # Task tracking dictionary must not leak
    assert call_id not in _active_chat_tasks


def test_disconnect_mid_stream_multi_chunk() -> None:
    """Stress test: client disconnects mid-stream after receiving partial tokens."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-mid-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    yielded_chunks = 0

    async def fake_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        nonlocal yielded_chunks
        for i in range(10):
            yielded_chunks += 1
            yield _make_chunk(content=f"Clause-{i} ")

    # Disconnect after 3 chunks
    checks = 0

    async def mock_is_disconnected(self: Request) -> bool:
        nonlocal checks
        checks += 1
        return checks > 3

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_stream)
        mock_get_client.return_value = mock_openai

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "How do heat pumps work in winter?"),
            )
            assert res.status_code == 200
            # Must contain Clause-0, Clause-1, Clause-2 but NOT Clause-9
            assert "Clause-0" in res.text
            assert "Clause-9" not in res.text

    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0, "Partial stream must NOT record assistant turn in database"

    assert call_id not in _active_chat_tasks


def test_disconnect_prior_to_tool_execution_prevents_booking() -> None:
    """Stress test: LLM returns booking tool call, but client disconnects before execution.

    Assert tool is skipped and zero appointments or turns are recorded.
    """
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-pre-tool-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    tool_call_obj = type(
        "ToolCall",
        (),
        {
            "id": "tc_stress_001",
            "function": type(
                "Function",
                (),
                {
                    "name": "book_appointment_tool",
                    "arguments": json.dumps({
                        "phone_number": "+15550192837",
                        "service": "AC repair",
                        "date": "2026-11-20",
                        "time": "02:00 PM",
                    }),
                },
            )(),
        },
    )()

    async def fake_tool_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(tool_calls=[tool_call_obj])

    # Disconnect when checked right after chunk streaming completes
    # is_disconnected: False during stream loop, then True before tool execution
    call_count = 0

    async def mock_is_disconnected(self: Request) -> bool:
        nonlocal call_count
        call_count += 1
        return call_count > 1  # 1st call False (chunk check), 2nd call True (pre-tool check)

    with patch("app.chat_api._get_client") as mock_get_client, \
         patch("app.chat_api._execute_tool") as mock_tool:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_tool_stream)
        mock_get_client.return_value = mock_openai

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "Can you check available times for next week?"),
            )
            assert res.status_code == 200

        assert mock_tool.call_count == 0, "Tool must NOT be executed after client disconnect"

    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0, "Aborted tool stream must not record assistant turn"
        appts = session.query(Appointment).filter_by(service="AC repair").all()
        assert len(appts) == 0

    assert call_id not in _active_chat_tasks


def test_disconnect_between_multiple_tool_calls_aborts_subsequent() -> None:
    """Stress test: LLM returns multiple tool calls. Client disconnects after tool 1.

    Tool 2 must be aborted and never run.
    """
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-multi-tool-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    tc1 = type(
        "ToolCall",
        (),
        {
            "id": "tc_1",
            "index": 0,
            "function": type(
                "Function",
                (),
                {
                    "name": "check_availability",
                    "arguments": json.dumps({"date": "2026-11-20"}),
                },
            )(),
        },
    )()
    tc2 = type(
        "ToolCall",
        (),
        {
            "id": "tc_2",
            "index": 1,
            "function": type(
                "Function",
                (),
                {
                    "name": "book_appointment_tool",
                    "arguments": json.dumps({
                        "phone_number": "+15551234567",
                        "service": "Furnace tuneup",
                        "date": "2026-11-21",
                        "time": "10:00 AM",
                    }),
                },
            )(),
        },
    )()

    async def fake_multi_tool_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(tool_calls=[tc1, tc2])

    executed_tools: list[str] = []

    def fake_execute_tool(
        _settings: Any, name: str, _args: dict[str, Any], _active_call_id: Any = None
    ) -> str:
        executed_tools.append(name)
        return "available slots: 10:00 AM"

    # Disconnect returns False during stream and before tool 1, then True before tool 2
    step = 0

    async def mock_is_disconnected(self: Request) -> bool:
        nonlocal step
        step += 1
        # step 1: chunk loop check (False)
        # step 2: post-stream check (False)
        # step 3: before tool 1 check (False)
        # step 4: before tool 2 check (True) -> should abort here!
        return step >= 4

    with patch("app.chat_api._get_client") as mock_get_client, \
         patch("app.chat_api._execute_tool", side_effect=fake_execute_tool):
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_multi_tool_stream)
        mock_get_client.return_value = mock_openai

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "Can you tell me what your diagnostic inspection involves?"),
            )
            assert res.status_code == 200

    assert executed_tools == ["check_availability"], (
        f"Only tool 1 should execute; got {executed_tools}"
    )

    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0
        appts = session.query(Appointment).filter_by(service="Furnace tuneup").all()
        assert len(appts) == 0


def test_disconnect_before_second_stream_pass_skips_pass2() -> None:
    """Stress test: tool runs, but client disconnects right before pass 2 LLM completion."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-pre-pass2-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    tc1 = type(
        "ToolCall",
        (),
        {
            "id": "tc_ro",
            "index": 0,
            "function": type(
                "Function",
                (),
                {
                    "name": "check_availability",
                    "arguments": json.dumps({"date": "2026-11-20"}),
                },
            )(),
        },
    )()

    async def fake_first_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(tool_calls=[tc1])

    pass2_called = False

    async def fake_second_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        nonlocal pass2_called
        pass2_called = True
        yield _make_chunk(content="Pass 2 completed")

    # Step: 1=chunk, 2=post-stream, 3=pre-tool, 4=pre-pass2 (return True here!)
    step = 0

    async def mock_is_disconnected(self: Request) -> bool:
        nonlocal step
        step += 1
        return step >= 4

    with patch("app.chat_api._get_client") as mock_get_client, \
         patch("app.chat_api._execute_tool", return_value="Available at 9am, 11am"):
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(
            side_effect=[fake_first_stream(), fake_second_stream()]
        )
        mock_get_client.return_value = mock_openai

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "Could you check your service availability for next week?"),
            )
            assert res.status_code == 200

    assert not pass2_called, "Pass 2 completion must NOT be invoked when client is disconnected"

    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0


def test_disconnect_mid_second_stream_pass_aborts_turn_record() -> None:
    """Stress test: tool runs, pass 2 streams 1 token, then client disconnects."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"disc-mid-pass2-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    tc1 = type(
        "ToolCall",
        (),
        {
            "id": "tc_ro2",
            "index": 0,
            "function": type(
                "Function",
                (),
                {
                    "name": "check_availability",
                    "arguments": json.dumps({"date": "2026-11-20"}),
                },
            )(),
        },
    )()

    async def fake_first_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(tool_calls=[tc1])

    async def fake_second_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        for i in range(5):
            yield _make_chunk(content=f"Pass2-chunk-{i} ")

    # Disconnect after 1st chunk in pass 2
    step = 0

    async def mock_is_disconnected(self: Request) -> bool:
        nonlocal step
        step += 1
        # step 1: pass 1 chunk check (False)
        # step 2: pass 1 post-stream (False)
        # step 3: pre-tool check (False)
        # step 4: pre-pass 2 check (False)
        # step 5: pass 2 chunk 0 check (False)
        # step 6: pass 2 chunk 1 check (True) -> disconnect!
        return step >= 6

    with patch("app.chat_api._get_client") as mock_get_client, \
         patch("app.chat_api._execute_tool", return_value="Available at 9am"):
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(
            side_effect=[fake_first_stream(), fake_second_stream()]
        )
        mock_get_client.return_value = mock_openai

        with patch.object(Request, "is_disconnected", mock_is_disconnected):
            res = client.post(
                "/v1/calls/chat",
                json=_browser_payload(room, call_id, "Could you check your service availability for next week?"),
            )
            assert res.status_code == 200
            assert "Pass2-chunk-0" in res.text
            assert "Pass2-chunk-4" not in res.text

    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 0, "Aborted second pass must NOT record turn"


# ---------------------------------------------------------------------------
# Category 2: Rapid Sequential Requests & In-Flight Task Cancellation (Barge-In)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rapid_sequential_requests_cancels_prior_task() -> None:
    """Stress test: in-flight task is cancelled when a new turn arrives for the same call."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)

    room = f"barge-in-seq-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    req1_cancelled = False
    req1_started = asyncio.Event()

    async def slow_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        req1_started.set()
        try:
            for i in range(20):
                yield _make_chunk(content=f"Slow-{i} ")
                await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            nonlocal req1_cancelled
            req1_cancelled = True
            raise

    async def fast_stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(content="Immediate answer to barge-in.")

    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(side_effect=[slow_stream(), fast_stream()])

    with patch("app.chat_api._get_client", return_value=mock_client):
        # Build Request 1
        req1_payload = ChatRequest(
            session_id=room,
            call_id=call_id,
            call_secret=_CALL_SECRET,
            message="What kind of maintenance services do you provide?",
        )
        fake_req1 = _make_fake_request(settings)

        resp1 = await chat_stream(req1_payload, fake_req1)

        # Consumer for req1 in a background task
        async def consume_resp1() -> list[str]:
            chunks: list[str] = []
            async for chunk in resp1.body_iterator:
                chunks.append(chunk)
            return chunks

        task1 = asyncio.create_task(consume_resp1())

        # Wait until req1 starts streaming
        await req1_started.wait()
        assert call_id in _active_chat_tasks
        assert _active_chat_tasks[call_id] is task1

        # Now send Request 2 for the same call_id
        req2_payload = ChatRequest(
            session_id=room,
            call_id=call_id,
            call_secret=_CALL_SECRET,
            message="Can you tell me what your diagnostic fees are?",
        )
        fake_req2 = _make_fake_request(settings)

        resp2 = await chat_stream(req2_payload, fake_req2)

        # Task1 must now be cancelled
        assert task1.cancelled() or task1.cancelling() or req1_cancelled

        # Consume resp2
        resp2_chunks: list[str] = []
        async def consume_resp2() -> None:
            async for chunk in resp2.body_iterator:
                resp2_chunks.append(chunk)

        task2 = asyncio.create_task(consume_resp2())
        await task2

        # Await task1 cancellation cleanup
        try:
            await task1
        except asyncio.CancelledError:
            pass

    assert req1_cancelled, "Request 1 must receive asyncio.CancelledError"
    assert any("Immediate answer" in c for c in resp2_chunks)

    # Database verification: only Request 2 assistant turn recorded!
    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == 1, f"Expected exactly 1 assistant turn, got {len(turns)}"
        assert "Immediate answer" in turns[0].content


@pytest.mark.asyncio
async def test_storm_of_rapid_requests_for_same_call() -> None:
    """Stress test: 10 rapid sequential barge-in requests fired for same call.

    Preempts prior 9 streams; only the 10th runs to full completion.
    """
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    room = f"storm-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    completed_indices: list[int] = []

    def make_stream(idx: int) -> Any:
        async def stream(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            for step in range(10):
                yield _make_chunk(content=f"Req{idx}-Step{step} ")
                await asyncio.sleep(0.01)
            completed_indices.append(idx)
        return stream()

    streams = [make_stream(i) for i in range(10)]

    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(side_effect=streams)

    with patch("app.chat_api._get_client", return_value=mock_client):
        tasks: list[asyncio.Task[Any]] = []
        for i in range(10):
            req_payload = ChatRequest(
                session_id=room,
                call_id=call_id,
                call_secret=_CALL_SECRET,
                message=f"Barge-in rapid turn {i}",
            )
            fake_req = _make_fake_request(settings)

            resp = await chat_stream(req_payload, fake_req)

            async def consume(r: Any = resp) -> None:
                async for _ in r.body_iterator:
                    pass

            t = asyncio.create_task(consume())
            tasks.append(t)
            # Give tiny slice for task to register before next request preempts it
            await asyncio.sleep(0.002)

        # Wait for all tasks to settle
        for t in tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass

    # The 10th request should have completed
    assert 9 in completed_indices
    # Prior requests were cancelled
    assert len(completed_indices) <= 2, (
        f"Most requests should have been cancelled; completed: {completed_indices}"
    )

    # Database check: assistant turns equal completed requests
    with new_session() as session:
        turns = session.query(CallTurn).filter_by(call_id=call_id, role="assistant").all()
        assert len(turns) == len(completed_indices)


@pytest.mark.asyncio
async def test_concurrent_requests_for_different_calls_isolated() -> None:
    """Stress test: barge-in on Call A must NEVER cancel Call B's task."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)

    room_a = f"call-a-{uuid4().hex[:8]}"
    room_b = f"call-b-{uuid4().hex[:8]}"
    call_id_a = start_or_get_browser_call(room_a, _CALL_SECRET)
    call_id_b = start_or_get_browser_call(room_b, _CALL_SECRET)

    b_cancelled = False
    b_finished = False

    async def stream_a1(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        for i in range(10):
            yield _make_chunk(content=f"A1-{i} ")
            await asyncio.sleep(0.02)

    async def stream_a2(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        yield _make_chunk(content="A2 answer.")

    async def stream_b(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        try:
            for i in range(10):
                yield _make_chunk(content=f"B-{i} ")
                await asyncio.sleep(0.02)
            nonlocal b_finished
            b_finished = True
        except asyncio.CancelledError:
            nonlocal b_cancelled
            b_cancelled = True
            raise

    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(
        side_effect=[stream_a1(), stream_b(), stream_a2()]
    )

    with patch("app.chat_api._get_client", return_value=mock_client):
        fake_req_a1 = _make_fake_request(settings)
        fake_req_b = _make_fake_request(settings)
        fake_req_a2 = _make_fake_request(settings)

        # Launch A1
        resp_a1 = await chat_stream(
            ChatRequest(session_id=room_a, call_id=call_id_a, call_secret=_CALL_SECRET, message="How do heat pumps work?"),
            fake_req_a1,
        )
        task_a1 = asyncio.create_task(_consume(resp_a1))

        # Launch B
        resp_b = await chat_stream(
            ChatRequest(session_id=room_b, call_id=call_id_b, call_secret=_CALL_SECRET, message="What maintenance is needed?"),
            fake_req_b,
        )
        task_b = asyncio.create_task(_consume(resp_b))

        await asyncio.sleep(0.03)

        # Barge-in on Call A with A2
        resp_a2 = await chat_stream(
            ChatRequest(session_id=room_a, call_id=call_id_a, call_secret=_CALL_SECRET, message="A2 barge-in interrupt"),
            fake_req_a2,
        )
        task_a2 = asyncio.create_task(_consume(resp_a2))

        # Wait for all
        await asyncio.gather(task_a2, task_b)
        try:
            await task_a1
        except asyncio.CancelledError:
            pass

    assert not b_cancelled, "Call B must NOT have been cancelled by Call A's barge-in"
    assert b_finished, "Call B must finish successfully"
    assert task_a1.cancelled(), "Call A1 must have been cancelled"


async def _consume(resp: Any) -> list[str]:
    chunks: list[str] = []
    async for c in resp.body_iterator:
        chunks.append(c)
    return chunks


@pytest.mark.asyncio
async def test_finally_block_preserves_superseding_task_in_dictionary() -> None:
    """Stress test: when Task 1 dies, its finally block must NOT remove Task 2 from _active_chat_tasks."""
    settings = Settings(LLM_API_KEY="test-key-stress", _env_file=None)
    room = f"finally-race-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    t1_running = asyncio.Event()

    async def stream_1(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        t1_running.set()
        for i in range(10):
            yield _make_chunk(content=f"T1-{i} ")
            await asyncio.sleep(0.05)

    async def stream_2(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        for i in range(5):
            yield _make_chunk(content=f"T2-{i} ")
            await asyncio.sleep(0.01)

    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(side_effect=[stream_1(), stream_2()])

    with patch("app.chat_api._get_client", return_value=mock_client):
        fake_req1 = _make_fake_request(settings)
        fake_req2 = _make_fake_request(settings)

        resp1 = await chat_stream(
            ChatRequest(session_id=room, call_id=call_id, call_secret=_CALL_SECRET, message="What is an air handler?"),
            fake_req1,
        )
        task1 = asyncio.create_task(_consume(resp1))
        await t1_running.wait()

        # Supersede with task2
        resp2 = await chat_stream(
            ChatRequest(session_id=room, call_id=call_id, call_secret=_CALL_SECRET, message="Interrupting question!"),
            fake_req2,
        )
        task2 = asyncio.create_task(_consume(resp2))

        # Give task1 time to run its finally block
        await asyncio.sleep(0.02)

        # Invariant: _active_chat_tasks[call_id] must still be task2 or None if task2 also finished
        if not task2.done():
            assert _active_chat_tasks.get(call_id) is task2, (
                "Task 1's finally block leaked and popped Task 2!"
            )

        await task2
        try:
            await task1
        except asyncio.CancelledError:
            pass


def test_echo_bargein_cancels_prior_task() -> None:
    """Stress test: caller echo barge-in must also cancel the prior task."""
    from unittest.mock import MagicMock

    settings = Settings(
        BUSINESS_COMPANY_NAME="Acme Cooling",
        LLM_API_KEY="test-key-stress",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"echo-bargein-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)

    # Register an active mock task
    mock_task = MagicMock()
    mock_task.done.return_value = False
    _active_chat_tasks[call_id] = mock_task

    # Send a message that triggers echo detection (e.g. echo of assistant greeting)
    echo_message = "Thanks for calling Acme Cooling, this is Sarah. How can I help you today?"
    res = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, echo_message),
    )
    assert res.status_code == 200
    assert "outcome" in res.text

    # Prior task must be cancelled even when caller message was an echo!
    mock_task.cancel.assert_called_once()
    assert _active_chat_tasks.get(call_id) is not mock_task
