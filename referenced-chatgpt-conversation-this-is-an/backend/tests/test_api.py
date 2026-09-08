# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_check_returns_ok() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_public_configuration_never_includes_credentials() -> None:
    settings = Settings(
        BUSINESS_COMPANY_NAME="Northstar Heating",
        BUSINESS_SERVICES="AC repair,Furnace repair",
        LLM_API_KEY="private",
        _env_file=None,
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/v1/config/public")

    assert response.status_code == 200
    assert response.json()["company_name"] == "Northstar Heating"
    assert "LLM_API_KEY" not in response.text
    assert "private" not in response.text


def test_endpoints_query_limit_validation() -> None:
    with TestClient(create_app()) as client:
        res1 = client.get("/v1/calls?limit=0")
        assert res1.status_code == 422

        res2 = client.get("/v1/calls?limit=201")
        assert res2.status_code == 422

        res3 = client.get("/v1/appointments?limit=0")
        assert res3.status_code == 422

        res4 = client.get("/v1/appointments?limit=500")
        assert res4.status_code == 422

