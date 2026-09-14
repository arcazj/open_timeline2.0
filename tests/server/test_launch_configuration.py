import copy
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from server.app.models.domain import DomainError
from server.app.services.launch_configuration import load_launch_configuration


@pytest.fixture
def profile(tmp_path):
    (tmp_path / "profiles").mkdir()
    (tmp_path / "legacy").mkdir()
    partition = tmp_path / "data" / "2024/03/01"
    partition.mkdir(parents=True)
    (partition / "events.json").write_text(json.dumps({"events": [
        {"id": "a", "start": "2024-03-01T12:00:00Z", "data": {"title": "Profile event"}},
    ]}), encoding="utf-8")
    path = tmp_path / "profiles" / "server.yml"
    document = {
        "version": 1,
        "server": {"host": "127.0.0.1", "port": 9876, "local_browser": True, "state_root": "../state"},
        "legacy": {"root": "../legacy", "allow_roots": ["../data"], "path_maps": {"/archive": "../data"}},
        "data_sources": [{"namespace": "N", "type": "json_file", "enable": True,
                          "data_path": "/archive", "data_model": "/archive/yyyy/mm/dd"}],
    }
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return path, document


def test_profile_paths_are_independent_of_working_directory(profile, tmp_path, monkeypatch):
    path, _ = profile
    monkeypatch.chdir(tmp_path.parent)
    settings = load_launch_configuration(path)
    assert settings["legacy_root"] == tmp_path / "legacy"
    assert settings["state_root"] == tmp_path / "state"
    assert settings["allow_root"] == [str(tmp_path / "data")]
    assert settings["path_map"] == [f"/archive={tmp_path / 'data'}"]
    assert settings["local_browser"] is True
    assert settings["background_startup"] is True


@pytest.mark.parametrize(("section", "key", "value"), [
    (None, "version", 2), (None, "version", True), (None, "unknown", 1),
    ("server", "prot", 8769), ("server", "port", "9876"), ("server", "port", True),
    ("server", "port", 0), ("server", "port", 65536), ("server", "local_browser", "true"),
    ("server", "host", "0.0.0.0"), ("server", "state_root", ""),
    ("server", "startup_mode", "fast"), ("server", "startup_mode", True),
    ("server", "startup_mode", {}), ("server", "startup_mode", []),
    ("legacy", "allow_roots", []), ("legacy", "allow_roots", "data"),
    ("legacy", "path_maps", []), ("legacy", "timezone", "Invalid/Zone"),
    ("legacy", "dialect", "sql"), ("legacy", "namespace_grouping", "false"),
])
def test_profile_rejects_invalid_options(profile, section, key, value):
    path, document = profile
    (document if section is None else document[section])[key] = value
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    with pytest.raises((ValueError, DomainError)):
        load_launch_configuration(path)


@pytest.mark.parametrize("raw", ["version: 1\nversion: 1\n", "a: &a [1]\nb: *a\n", "!!python/object:builtins.object {}", "[1, 2]", ""])
def test_profile_rejects_ambiguous_or_unsafe_yaml(profile, raw):
    path, _ = profile
    path.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError):
        load_launch_configuration(path)


def launcher():
    path = Path(__file__).resolve().parents[2] / "scripts/serve-legacy.py"
    spec = importlib.util.spec_from_file_location("profile_launcher_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_profile_launches_real_read_only_application(profile, tmp_path, monkeypatch, capsys):
    path, _ = profile
    original = {item: item.read_bytes() for item in tmp_path.rglob("*.json")}
    module = launcher()
    monkeypatch.delenv("OPENBEXI_API_TOKEN", raising=False)
    monkeypatch.delenv("OPENBEXI_CORS_ORIGINS", raising=False)
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--yaml", str(path), "--port", "9877"])
    launched = []

    def run(app, host, port):
        assert (host, port) == ("127.0.0.1", 9877)
        origin = f"http://{host}:{port}"
        headers = {"X-OpenBEXI-Local": "1", "Sec-Fetch-Site": "same-origin", "Origin": origin}
        with TestClient(app, base_url=origin, client=(host, 54321), headers=headers) as client:
            deadline = time.monotonic() + 5
            while client.get("/health/ready").status_code != 200 and time.monotonic() < deadline:
                time.sleep(.01)
            response = client.get("/api/v1/workspaces/default")
            assert response.status_code == 200, response.text
            assert response.json()["legacy"]["lazy"] is True
            while not client.get("/api/v1/workspaces/default/legacy/loading").json()["complete"] and time.monotonic() < deadline:
                time.sleep(.01)
            assert client.get("/api/v1/workspaces/default").json()["recordCount"] == 1
            assert response.json()["durability"] == "read-only-files"
            assert client.post("/api/v1/workspaces/default/records", json={}).status_code == 403
        launched.append(True)

    monkeypatch.setattr(module.uvicorn, "run", run)
    module.main()
    assert launched == [True]
    assert "Client URL: http://127.0.0.1:9877/" in capsys.readouterr().out
    assert all(item.read_bytes() == content for item, content in original.items())


@pytest.mark.parametrize("options", [["--source-yaml", "other.yml"], ["--allow-root", "other"], ["--host", "0.0.0.0"]])
def test_profile_rejects_mixed_source_flags_and_unsafe_bind(profile, monkeypatch, options):
    module = launcher()
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--yaml", str(profile[0]), *options])
    monkeypatch.setattr(module.uvicorn, "run", lambda *a, **k: pytest.fail("Must not start"))
    with pytest.raises(SystemExit) as error:
        module.main()
    assert error.value.code == 2


def test_model_is_relative_to_legacy_root(profile, tmp_path):
    path, document = profile
    document = copy.deepcopy(document)
    document["legacy"]["model"] = "models/regular.json"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    assert load_launch_configuration(path)["model"] == tmp_path / "legacy/models/regular.json"


def test_profile_can_keep_foreground_startup(profile):
    path, document = profile
    document["server"]["startup_mode"] = "foreground"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    assert load_launch_configuration(path)["background_startup"] is False


def test_lazy_loading_defaults_and_explicit_settings(profile):
    path, document = profile
    settings = load_launch_configuration(path)
    assert settings["lazy"] is True
    assert settings["loading"] == {"bufferRatio": .25, "cacheMiB": 64, "indexRefreshSeconds": 30}
    document["server"]["data_loading"] = "eager"
    document["loading"] = {"buffer_ratio": .5, "cache_mib": 32, "index_refresh_seconds": 60,
                           "initial_range": {"from": "2024-03-18T19:00:00Z", "to": "2024-03-18T21:00:00Z"}}
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    settings = load_launch_configuration(path)
    assert settings["lazy"] is False
    assert settings["loading"] == {"bufferRatio": .5, "cacheMiB": 32, "indexRefreshSeconds": 60,
                                   "initialRange": document["loading"]["initial_range"]}


@pytest.mark.parametrize("loading", [
    [], {"unknown": 1}, {"buffer_ratio": True}, {"buffer_ratio": -1}, {"buffer_ratio": 1.1},
    {"buffer_ratio": float("nan")}, {"cache_mib": 7}, {"cache_mib": 257}, {"cache_mib": 64.5},
    {"index_refresh_seconds": 0}, {"index_refresh_seconds": float("inf")},
    {"initial_range": {}}, {"initial_range": {"from": "bad", "to": "bad"}},
    {"initial_range": {"from": "2024-03-18T21:00:00Z", "to": "2024-03-18T19:00:00Z"}},
])
def test_lazy_loading_rejects_invalid_settings(profile, loading):
    path, document = profile
    document["loading"] = loading
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    with pytest.raises((ValueError, DomainError)):
        load_launch_configuration(path)


@pytest.mark.parametrize("value", ["fast", True, {}, []])
def test_profile_rejects_unknown_loading_mode(profile, value):
    path, document = profile
    document["server"]["data_loading"] = value
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    with pytest.raises(ValueError):
        load_launch_configuration(path)
