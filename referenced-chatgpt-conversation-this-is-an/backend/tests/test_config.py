# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from app.config import Settings


def test_settings_parse_business_services_from_comma_separated_env() -> None:
    settings = Settings(
        BUSINESS_SERVICES="AC repair, Furnace repair , Heat pump service",
        BUSINESS_OPENING_HOURS='{"monday":"09:00-17:00"}',
        _env_file=None,
    )

    assert settings.business_services == ["AC repair", "Furnace repair", "Heat pump service"]
    assert settings.business_opening_hours == {"monday": "09:00-17:00"}


def test_agent_configuration_requires_all_credentials() -> None:
    assert Settings(_env_file=None).configured_for_agent is False
    assert Settings(
        LIVEKIT_URL="wss://livekit.example.com",
        LIVEKIT_API_KEY="key",
        LIVEKIT_API_SECRET="secret",
        LLM_API_KEY="llm-key",
        _env_file=None,
    ).configured_for_agent is True