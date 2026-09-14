import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from server.app.main import create_app


def test_null_origin_is_denied_by_default(client):
    response = client.options(BASE, headers={"Origin": "null", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in response.headers


def test_explicit_null_origin_does_not_replace_bearer_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENBEXI_CORS_ORIGINS", "null")
    with TestClient(create_app(tmp_path / "data", TOKEN)) as client:
        preflight = client.options(BASE, headers={"Origin": "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Authorization"})
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "null"
        denied = client.get(BASE, headers={"Origin": "null"})
        assert denied.status_code == 401
        allowed = client.get(BASE, headers={"Origin": "null", "Authorization": "Bearer " + TOKEN})
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "null"


def test_cors_wildcard_is_never_implicitly_trusted(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENBEXI_CORS_ORIGINS", "*")
    with pytest.raises(RuntimeError, match="explicit origins"):
        create_app(tmp_path, TOKEN)


def test_token_is_required_and_not_in_health_or_export(client):
    assert TOKEN not in client.get("/api/v1/health").text
    assert TOKEN not in client.get(BASE + "/snapshot").text
    with pytest.raises(RuntimeError, match="12 characters"):
        create_app(token="weak")
