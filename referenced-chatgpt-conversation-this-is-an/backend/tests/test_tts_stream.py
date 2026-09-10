"""Tests for streaming neural TTS voice endpoint."""

from __future__ import annotations

from unittest.mock import patch

import aiohttp
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.tts_stream import _IP_TTS_TIMESTAMPS, AudioLRUCache


def test_list_recommended_voices() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    res = client.get("/v1/voice/voices")
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data, list)
    assert any(v.get("id") == "en-US-JennyNeural" for v in data)
    assert any(v.get("recommended") is True for v in data)


def test_stream_voice_empty_text_rejected() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    res = client.get("/v1/voice/stream?text=")
    assert res.status_code in (400, 422)


def test_stream_voice_whitespace_and_non_printable_rejected() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    # Whitespace only
    res = client.get("/v1/voice/stream?text=%20%20%20")
    assert res.status_code == 400
    assert "Empty or non-printable" in res.json()["detail"]

    # Non-printable control characters only
    res = client.get("/v1/voice/stream?text=%00%01%02")
    assert res.status_code == 400


def test_stream_voice_too_long_rejected() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    res = client.get(f"/v1/voice/stream?text={'a' * 1501}")
    assert res.status_code in (400, 422)


def test_stream_voice_malicious_voice_injection_rejected() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    malicious_voices = [
        "en-US-JennyNeural' <audio src='http://169.254.169.254/latest/meta-data/'/>",
        "../../etc/passwd",
        "http://127.0.0.1:8000",
        "en-US",
        "invalid_voice",
        "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)",
        "en-US-JennyNeural\n<ssml>",
    ]

    for bad_voice in malicious_voices:
        res = client.get("/v1/voice/stream", params={"text": "Hello", "voice": bad_voice})
        assert res.status_code == 400, f"Expected 400 for voice: {bad_voice}, got {res.status_code}"
        assert "Invalid voice identifier" in res.json()["detail"]


@pytest.mark.asyncio
async def test_audio_lru_cache_eviction_and_memory_bounds() -> None:
    cache = AudioLRUCache(max_entries=3, max_bytes=30)
    await cache.put(("k1", "v"), b"0123456789")  # 10 bytes
    await cache.put(("k2", "v"), b"0123456789")  # 10 bytes
    await cache.put(("k3", "v"), b"0123456789")  # 10 bytes
    assert len(cache) == 3

    # Access k1 to move it to MRU position
    assert await cache.get(("k1", "v")) == b"0123456789"

    # Insert k4: should evict k2 (oldest), keeping k1, k3, k4
    await cache.put(("k4", "v"), b"0123456789")
    assert len(cache) == 3
    assert await cache.get(("k2", "v")) is None
    assert await cache.get(("k1", "v")) is not None
    assert await cache.get(("k3", "v")) is not None
    assert await cache.get(("k4", "v")) is not None

    # Test byte limit eviction: inserting 25 bytes should evict k3 and k1
    await cache.put(("k5", "v"), b"x" * 25)
    assert len(cache) <= 2
    assert cache._total_bytes <= 30


def test_stream_voice_upstream_error_returns_502() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    async def mock_stream_error(*args, **kwargs):
        raise aiohttp.ClientError("Upstream connection refused")
        yield  # make it a generator

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream_error):
        res = client.get("/v1/voice/stream?text=Testing upstream error handling 12345")
        assert res.status_code == 502
        assert "Neural speech synthesis" in res.json()["detail"]


def test_stream_voice_upstream_timeout_returns_504() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    async def mock_stream_timeout(*args, **kwargs):
        raise TimeoutError("Upstream timed out")
        yield

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream_timeout):
        res = client.get("/v1/voice/stream?text=Testing upstream timeout handling 12345")
        assert res.status_code == 504
        assert "timed out" in res.json()["detail"]


def test_stream_voice_rate_limit() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    test_ip = "192.168.10.99"
    _IP_TTS_TIMESTAMPS[test_ip] = [1000.0] * 35  # exceed limit

    with patch("time.time", return_value=1010.0):
        res = client.get(
            "/v1/voice/stream?text=Unique test message for rate limiting",
            headers={"x-forwarded-for": test_ip},
        )
        assert res.status_code == 429
        assert "Rate limit exceeded" in res.json()["detail"]


def test_stream_voice_success_and_cache() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\xff\xfb\x90\x00" * 400

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        phrase = "Hello from Example HVAC receptionist unique test."
        res1 = client.get(f"/v1/voice/stream?text={phrase}")
        assert res1.status_code == 200
        assert "audio/mpeg" in res1.headers["content-type"]
        assert len(res1.content) > 1000

        # Test cache on identical request (served without calling stream again)
        res2 = client.get(f"/v1/voice/stream?text={phrase}")
        assert res2.status_code == 200
        assert res2.headers.get("X-Audio-Source") == "cache"
        assert res2.content == res1.content
