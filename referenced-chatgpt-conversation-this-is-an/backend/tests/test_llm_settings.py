# pyright: reportCallIssue=false
"""Tests for settings-driven LLM failover and token limits (Workstream A)."""

from __future__ import annotations

from app.chat_api import _get_candidate_models
from app.config import Settings


def test_default_fallback_list_matches_builtin_behavior() -> None:
    """With no override, the candidate list equals the previous hardcoded order."""
    primary = "openai/gpt-oss-120b"
    candidates = _get_candidate_models(primary)
    assert candidates[0] == primary
    assert candidates == [
        "openai/gpt-oss-120b",
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.6-27b",
    ]


def test_settings_fallback_override_replaces_builtin_list() -> None:
    candidates = _get_candidate_models("primary-model", "model-a, model-b")
    assert candidates == ["primary-model", "model-a", "model-b"]


def test_settings_fallback_override_deduplicates_primary() -> None:
    candidates = _get_candidate_models("model-a", "model-a,model-b")
    assert candidates == ["model-a", "model-b"]


def test_settings_fallback_override_ignores_blank_entries() -> None:
    candidates = _get_candidate_models("primary", ", ,model-a,,")
    assert candidates == ["primary", "model-a"]


def test_settings_defaults_preserve_current_limits() -> None:
    settings = Settings(_env_file=None)
    assert settings.llm_max_tokens == 128
    assert settings.llm_fallback_model_list == [
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.6-27b",
        "openai/gpt-oss-120b",
    ]


def test_settings_llm_max_tokens_bounds() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings(llm_max_tokens=8, _env_file=None)
    with pytest.raises(ValidationError):
        Settings(llm_max_tokens=4096, _env_file=None)
    assert Settings(llm_max_tokens=256, _env_file=None).llm_max_tokens == 256
