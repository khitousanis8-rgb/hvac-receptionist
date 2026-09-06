# pyright: reportCallIssue=false
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.agent.dispatch import (
    CredentialsMissingError,
    DispatchError,
    create_room_and_token,
)
from app.config import Settings
from app.db import CallRecord, init_db, new_session, reset_engine
from app.main import create_app


@pytest.fixture()
def db(tmp_path):
    reset_engine()
    init_db(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    yield
    reset_engine()


@pytest.fixture()
def livekit_settings() -> Settings:
    return Settings(
        LIVEKIT_URL="wss://example.livekit.cloud",
        LIVEKIT_API_KEY="test_api_key",
        LIVEKIT_API_SECRET="test_api_secret_must_be_long_enough_for_jwt",
        _env_file=None,
    )


@pytest.mark.asyncio
async def test_create_room_and_token_missing_credentials() -> None:
    settings = Settings(_env_file=None)
    with pytest.raises(CredentialsMissingError):
        await create_room_and_token(settings)


@pytest.mark.asyncio
async def test_create_room_and_token_success(livekit_settings: Settings) -> None:
    with patch("app.agent.dispatch.LiveKitAPI") as mock_livekit:
        mock_instance = AsyncMock()
        mock_livekit.return_value.__aenter__.return_value = mock_instance

        url, token, room = await create_room_and_token(
            settings=livekit_settings,
            room_name="hvac-test-123",
            identity="caller-test",
        )

        assert url == "wss://example.livekit.cloud"
        assert isinstance(token, str) and len(token) > 20
        assert room == "hvac-test-123"
        mock_instance.agent_dispatch.create_dispatch.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_room_and_token_dispatch_failure(livekit_settings: Settings) -> None:
    with patch("app.agent.dispatch.LiveKitAPI") as mock_livekit:
        mock_instance = AsyncMock()
        mock_dispatch = mock_instance.agent_dispatch.create_dispatch
        mock_dispatch.side_effect = RuntimeError("Connection dropped")
        mock_livekit.return_value.__aenter__.return_value = mock_instance

        with pytest.raises(DispatchError, match="Failed to dispatch agent"):
            await create_room_and_token(
                settings=livekit_settings,
                room_name="hvac-test-fail",
            )


def test_token_endpoint_method_not_allowed_for_get() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/v1/calls/token")
    assert response.status_code == 405


def test_token_endpoint_unconfigured_returns_503() -> None:
    settings = Settings(_env_file=None)
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/calls/token", json={})
    assert response.status_code == 503
    assert "LiveKit credentials are not configured" in response.json()["detail"]


def test_token_endpoint_success(livekit_settings: Settings) -> None:
    with patch("app.agent.dispatch.LiveKitAPI") as mock_livekit:
        mock_instance = AsyncMock()
        mock_livekit.return_value.__aenter__.return_value = mock_instance

        with TestClient(create_app(livekit_settings)) as client:
            response = client.post("/v1/calls/token", json={})

        assert response.status_code == 200
        data = response.json()
        assert data["url"] == "wss://example.livekit.cloud"
        assert "token" in data and len(data["token"]) > 20
        assert data["room"].startswith("hvac-")


def test_token_endpoint_rejects_active_call_in_same_room(
    livekit_settings: Settings, db
) -> None:
    with new_session() as session:
        session.add(CallRecord(room_name="hvac-active-room"))

    with TestClient(create_app(livekit_settings)) as client:
        response = client.post("/v1/calls/token", json={"room_name": "hvac-active-room"})

    assert response.status_code == 409
    assert "already in progress" in response.json()["detail"]
