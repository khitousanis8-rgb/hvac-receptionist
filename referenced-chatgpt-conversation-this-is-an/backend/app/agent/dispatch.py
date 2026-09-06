"""LiveKit room token minting and agent dispatch."""

from __future__ import annotations

import uuid
from datetime import timedelta

import structlog
from livekit.api import AccessToken, LiveKitAPI, VideoGrants
from livekit.protocol import agent_dispatch

from app.config import Settings

logger = structlog.get_logger(__name__)


class DispatchError(Exception):
    """Raised when dispatching an agent or creating a room token fails."""


class CredentialsMissingError(DispatchError):
    """Raised when LiveKit credentials are not configured."""


async def create_room_and_token(
    settings: Settings,
    room_name: str | None = None,
    identity: str | None = None,
    ttl: int = 3600,
    agent_name: str = "hvac-receptionist",
) -> tuple[str, str, str]:
    """Generate a LiveKit JWT token for a room and dispatch the receptionist agent.

    Returns:
        tuple[url, token, room_name]
    """
    if not settings.configured_for_livekit or not settings.livekit_url:
        raise CredentialsMissingError(
            "LiveKit credentials are not configured. Set LIVEKIT_URL, "
            "LIVEKIT_API_KEY, and LIVEKIT_API_SECRET."
        )

    url = str(settings.livekit_url)
    assert settings.livekit_api_key is not None
    assert settings.livekit_api_secret is not None
    api_key = settings.livekit_api_key.get_secret_value()
    api_secret = settings.livekit_api_secret.get_secret_value()

    room = room_name or f"hvac-{uuid.uuid4().hex[:12]}"
    user_identity = identity or f"caller-{uuid.uuid4().hex[:8]}"

    token = (
        AccessToken(api_key=api_key, api_secret=api_secret)
        .with_identity(user_identity)
        .with_grants(VideoGrants(room_join=True, room=room))
        .with_ttl(timedelta(seconds=ttl))
        .to_jwt()
    )

    try:
        async with LiveKitAPI(url=url, api_key=api_key, api_secret=api_secret) as lk:
            await lk.agent_dispatch.create_dispatch(
                agent_dispatch.CreateAgentDispatchRequest(
                    agent_name=agent_name,
                    room=room,
                )
            )
    except Exception as exc:
        logger.error(
            "agent_dispatch_failed",
            room=room,
            agent_name=agent_name,
            error=str(exc),
        )
        raise DispatchError(f"Failed to dispatch agent to room '{room}': {exc}") from exc

    logger.info("room_token_created", room=room, identity=user_identity)
    return url, token, room

