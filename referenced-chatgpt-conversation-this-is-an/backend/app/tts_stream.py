"""Streaming Neural Voice API using Edge-TTS (Microsoft Azure Neural)."""

from __future__ import annotations

import asyncio
import re
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

import edge_tts
import structlog
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/v1/voice", tags=["voice"])

DEFAULT_VOICE = "en-US-JennyNeural"

# Allowed neural voice format: e.g. "en-US-JennyNeural", "es-ES-ElviraNeural"
# Must prevent SSML injection, path traversal, XML tags, and SSRF URLs
_VOICE_REGEX = re.compile(r"^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9]+Neural$")

_MAX_CACHE_ENTRIES = 50
_MAX_CACHE_BYTES = 5 * 1024 * 1024  # 5 MB RAM budget
_MAX_CACHED_TEXT_LEN = 250


class AudioLRUCache:
    """Thread-safe and async-safe LRU cache bounded by entry count and byte size.

    Prevents unbounded memory growth on memory-constrained hosting (e.g. Render 512MB RAM).
    """

    def __init__(
        self,
        max_entries: int = _MAX_CACHE_ENTRIES,
        max_bytes: int = _MAX_CACHE_BYTES,
    ) -> None:
        self._cache: OrderedDict[tuple[str, str], bytes] = OrderedDict()
        self._lock = asyncio.Lock()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._total_bytes = 0

    async def get(self, key: tuple[str, str]) -> bytes | None:
        async with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            return None

    async def put(self, key: tuple[str, str], data: bytes) -> None:
        data_len = len(data)
        if data_len > self._max_bytes:
            return
        async with self._lock:
            if key in self._cache:
                self._total_bytes -= len(self._cache[key])
                del self._cache[key]

            while self._cache and (
                len(self._cache) >= self._max_entries
                or (self._total_bytes + data_len) > self._max_bytes
            ):
                _, evicted_data = self._cache.popitem(last=False)
                self._total_bytes -= len(evicted_data)

            self._cache[key] = data
            self._total_bytes += data_len

    async def clear(self) -> None:
        async with self._lock:
            self._cache.clear()
            self._total_bytes = 0

    def __len__(self) -> int:
        return len(self._cache)


audio_cache = AudioLRUCache()
_AUDIO_CACHE = audio_cache._cache

_TTS_SEMAPHORE = asyncio.Semaphore(10)
_RATE_LIMIT_LOCK = threading.Lock()
_IP_TTS_TIMESTAMPS: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_TTS_PER_WINDOW = 30


def check_tts_rate_limit(client_ip: str) -> None:
    """Sliding-window rate limiter for TTS generation to prevent abuse and DoS."""
    now = time.time()
    cutoff = now - _RATE_LIMIT_WINDOW_SECONDS
    with _RATE_LIMIT_LOCK:
        timestamps = _IP_TTS_TIMESTAMPS.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= _MAX_TTS_PER_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded for speech synthesis. Please wait before trying again.",
            )
        timestamps.append(now)
        _IP_TTS_TIMESTAMPS[client_ip] = timestamps
        if len(_IP_TTS_TIMESTAMPS) > 1000:
            for ip in list(_IP_TTS_TIMESTAMPS.keys()):
                _IP_TTS_TIMESTAMPS[ip] = [t for t in _IP_TTS_TIMESTAMPS[ip] if t > cutoff]
                if not _IP_TTS_TIMESTAMPS[ip]:
                    del _IP_TTS_TIMESTAMPS[ip]
            if len(_IP_TTS_TIMESTAMPS) > 1000:
                excess = len(_IP_TTS_TIMESTAMPS) - 1000
                for old_ip in list(_IP_TTS_TIMESTAMPS.keys())[:excess]:
                    del _IP_TTS_TIMESTAMPS[old_ip]


def get_client_ip(request: Request | None) -> str:
    """Extract client IP safely from request headers."""
    if request is None:
        return "127.0.0.1"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


@router.get("/stream")
async def stream_voice(
    text: str = Query(..., min_length=1, max_length=1500, description="Text to synthesize"),
    voice: str = Query(default=DEFAULT_VOICE, description="Neural voice identifier"),
    request: Request = None,  # type: ignore[assignment]
) -> Response:
    """Stream studio-quality neural audio bytes (audio/mpeg) for the given text."""
    # 1. Input sanitization & validation
    clean_text = "".join(c for c in text.strip() if c.isprintable() or c in "\n\r\t").strip()
    if not clean_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty or non-printable text parameter.",
        )
    if len(clean_text) > 1500:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text exceeds maximum length of 1500 characters.",
        )

    # Validate voice parameter against strict regex pattern to prevent SSML/SSRF injection
    voice_clean = voice.strip()
    if len(voice_clean) > 64 or not _VOICE_REGEX.match(voice_clean):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Invalid voice identifier '{voice}'. "
                "Voice must match pattern '[lang]-[REGION]-[Name]Neural'."
            ),
        )

    cache_key = (clean_text, voice_clean)
    # Check cache first for instant 0ms TTFB on greetings and confirmations
    cached_data = await audio_cache.get(cache_key)
    if cached_data is not None:
        return Response(
            content=cached_data,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Audio-Source": "cache",
                "X-Voice-Persona": voice_clean,
            },
        )

    # Rate limiting on non-cached synthesis requests
    client_ip = get_client_ip(request)
    check_tts_rate_limit(client_ip)

    # Concurrency limiter to protect Render 512MB RAM
    try:
        await asyncio.wait_for(_TTS_SEMAPHORE.acquire(), timeout=5.0)
    except TimeoutError as err:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech synthesis service is at maximum capacity. Please retry shortly.",
        ) from err

    should_cache = len(clean_text) < _MAX_CACHED_TEXT_LEN
    stream_iter = None
    try:
        communicate = edge_tts.Communicate(
            text=clean_text,
            voice=voice_clean,
            rate="+2%",
            pitch="+0Hz",
        )
        stream_iter = communicate.stream()

        # Connect and retrieve initial audio chunk with 10s timeout
        # If upstream fails or times out, we catch it BEFORE sending HTTP 200 headers
        first_audio: bytes | None = None
        async with asyncio.timeout(10.0):
            async for chunk in stream_iter:
                if chunk["type"] == "audio":
                    first_audio = chunk["data"]
                    break

        if first_audio is None:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Neural speech synthesis returned no audio stream.",
            )

    except TimeoutError as err:
        if stream_iter is not None:
            await stream_iter.aclose()
        _TTS_SEMAPHORE.release()
        logger.error("edge_tts_connect_timeout", voice=voice_clean, text_preview=clean_text[:50])
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Neural speech synthesis upstream timed out connecting.",
        ) from err
    except HTTPException:
        if stream_iter is not None:
            await stream_iter.aclose()
        _TTS_SEMAPHORE.release()
        raise
    except Exception as exc:
        if stream_iter is not None:
            await stream_iter.aclose()
        _TTS_SEMAPHORE.release()
        logger.error(
            "edge_tts_connect_error",
            error=str(exc),
            voice=voice_clean,
            text_preview=clean_text[:50],
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Neural speech synthesis connection error: {exc}",
        ) from exc

    # Stream generator with guaranteed cleanup of websocket and semaphore
    async def audio_stream_generator() -> AsyncIterator[bytes]:
        collected_bytes: list[bytes] = [first_audio] if should_cache else []
        try:
            yield first_audio
            async for chunk in stream_iter:
                if chunk["type"] == "audio":
                    data = chunk["data"]
                    if should_cache:
                        collected_bytes.append(data)
                    yield data

            # Cache short sentences (< 250 chars) for repeat turns
            if should_cache and collected_bytes:
                await audio_cache.put(cache_key, b"".join(collected_bytes))

        except (GeneratorExit, asyncio.CancelledError):
            logger.debug("edge_tts_client_disconnected", voice=voice_clean)
            raise
        except Exception as exc:
            logger.warning("edge_tts_stream_interrupted", error=str(exc), voice=voice_clean)
        finally:
            try:
                await stream_iter.aclose()
            finally:
                _TTS_SEMAPHORE.release()

    return StreamingResponse(
        audio_stream_generator(),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Voice-Persona": voice_clean,
        },
    )


@router.get("/voices")
async def list_recommended_voices() -> list[dict[str, Any]]:
    """Return available high-quality neural voice personas for the receptionist."""
    return [
        {
            "id": "en-US-JennyNeural",
            "name": "Jenny (Warm & Caring - Recommended)",
            "gender": "Female",
            "style": "Conversational Receptionist",
            "recommended": True,
        },
        {
            "id": "en-US-AvaNeural",
            "name": "Ava (Expressive & Upbeat)",
            "gender": "Female",
            "style": "Modern Assistant",
            "recommended": False,
        },
        {
            "id": "en-US-AriaNeural",
            "name": "Aria (Professional & Crisp)",
            "gender": "Female",
            "style": "Corporate Receptionist",
            "recommended": False,
        },
        {
            "id": "en-US-GuyNeural",
            "name": "Guy (Casual & Friendly)",
            "gender": "Male",
            "style": "Customer Support",
            "recommended": False,
        },
    ]
