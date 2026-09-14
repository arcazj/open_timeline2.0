import importlib.util
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("version", [(3, 8, 20), (3, 9, 13), (3, 10, 0), (3, 11, 0), (3, 14, 0), (4, 0, 0)])
def test_cli_rejects_unsupported_python_before_dependency_imports(monkeypatch, version):
    path = Path(__file__).resolve().parents[2] / "scripts" / "serve-legacy.py"
    spec = importlib.util.spec_from_file_location("serve_legacy_unsupported_python_test", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setattr(sys, "version_info", version)
    monkeypatch.setattr(sys, "executable", "wrong-python.exe")
    monkeypatch.setitem(sys.modules, "uvicorn", None)
    monkeypatch.setitem(sys.modules, "server.app.main", None)

    with pytest.raises(SystemExit) as raised:
        spec.loader.exec_module(module)

    message = str(raised.value)
    assert "Python >=3.12,<3.14" in message
    assert "wrong-python.exe" in message
    assert ".venv" in message
    assert "Use specified interpreter" in message


@pytest.fixture
def command(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "scripts" / "serve-legacy.py"
    spec = importlib.util.spec_from_file_location("serve_legacy_cli_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    captured = {}

    def create_app(**kwargs):
        captured["app"] = kwargs
        return "test-application"

    def run(app, **kwargs):
        captured["server"] = {"application": app, **kwargs}

    monkeypatch.setattr(module, "create_app", create_app)
    monkeypatch.setattr(module.uvicorn, "run", run)
    monkeypatch.setenv("OPENBEXI_API_TOKEN", "private-unit-test-token")
    return module, captured


def test_cli_binds_operator_paths_and_never_starts_legacy_connectors(command, monkeypatch):
    module, captured = command
    monkeypatch.setattr(sys, "argv", [
        "serve-legacy.py", "--source-yaml", "C:/projects/openbexi_timeline/yaml/sources_earthquake.yml",
        "--legacy-root", "C:/projects/openbexi_timeline", "--allow-root", "C:/data",
        "--allow-root", "C:/projects/openbexi_timeline/tests/data", "--path-map", "/data=C:/data",
        "--model", "models/regular_timeline_earthquake.json", "--namespace-grouping",
        "--dialect", "legacy-json", "--timezone", "UTC", "--state-root", "var/legacy-test", "--port", "9876",
    ])
    module.main()
    assert captured["server"] == {"application": "test-application", "host": "127.0.0.1", "port": 9876}
    assert captured["app"] == {
        "background_startup": True,
        "data_root": Path("var/legacy-test"),
        "legacy_config": {
            "yaml": str(Path("C:/projects/openbexi_timeline/yaml/sources_earthquake.yml")),
            "legacyRoot": str(Path("C:/projects/openbexi_timeline")),
            "allowRoots": ["C:/data", "C:/projects/openbexi_timeline/tests/data"],
            "pathMaps": {"/data": "C:/data"}, "model": str(Path("models/regular_timeline_earthquake.json")),
                "namespaceGrouping": True, "timezone": "UTC", "dialect": "legacy-json", "lazy": True, "loading": {},
        },
    }


def test_cli_default_policy_is_strict_loopback_and_explicit_utc(command, monkeypatch):
    module, captured = command
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml",
                                    "--legacy-root", "legacy", "--allow-root", "data"])
    module.main()
    config = captured["app"]["legacy_config"]
    assert config["dialect"] == "strict"
    assert config["timezone"] == "UTC"
    assert config["namespaceGrouping"] is None
    assert config["pathMaps"] == {}
    assert "model" not in config
    assert captured["server"]["host"] == "127.0.0.1"


@pytest.mark.parametrize("maps", [["missing-value"], ["=C:/data"], ["/data="], ["/data=C:/data", "/data=C:/other"]])
def test_cli_rejects_missing_or_duplicate_path_mapping(command, monkeypatch, maps):
    module, captured = command
    arguments = ["serve-legacy.py", "--source-yaml", "sources.yml", "--legacy-root", "legacy", "--allow-root", "data"]
    for mapping in maps:
        arguments.extend(["--path-map", mapping])
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(SystemExit) as raised:
        module.main()
    assert raised.value.code == 2
    assert captured == {}


def test_cli_requires_authentication_token(command, monkeypatch):
    module, captured = command
    monkeypatch.delenv("OPENBEXI_API_TOKEN")
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml",
                                    "--legacy-root", "legacy", "--allow-root", "data"])
    with pytest.raises(SystemExit) as raised:
        module.main()
    assert raised.value.code == 2
    assert captured == {}


def test_cli_local_browser_generates_private_internal_identity(command, monkeypatch, capsys):
    module, captured = command
    monkeypatch.delenv("OPENBEXI_API_TOKEN")
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml", "--legacy-root", "legacy",
                                    "--allow-root", "data", "--local-browser", "--port", "9876"])
    module.main()
    assert captured["app"]["local_browser_origin"] == "http://127.0.0.1:9876"
    assert len(captured["app"]["token"]) >= 32
    output = capsys.readouterr().out
    assert "Client URL: http://127.0.0.1:9876/" in output
    assert captured["app"]["token"] not in output


@pytest.mark.parametrize(("host", "client_host"), [
    ("127.0.0.1", "127.0.0.1"), ("0.0.0.0", "127.0.0.1"),
    ("::", "[::1]"), ("::1", "[::1]"), ("timeline.local", "timeline.local"),
])
def test_cli_prints_client_url_before_running_server(command, monkeypatch, capsys, host, client_host):
    module, _ = command
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml", "--legacy-root", "legacy",
                                    "--allow-root", "data", "--host", host, "--port", "8769"])

    def run(app, **kwargs):
        output = capsys.readouterr().out
        assert f"Client URL: http://{client_host}:8769/ (real source; visible-window loading)" in output
        assert "private-unit-test-token" not in output
        assert kwargs == {"host": host, "port": 8769}

    monkeypatch.setattr(module.uvicorn, "run", run)
    module.main()


def test_cli_automatic_port_does_not_print_an_invalid_client_url(command, monkeypatch, capsys):
    module, _ = command
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml", "--legacy-root", "legacy",
                                    "--allow-root", "data", "--port", "0"])
    module.main()
    output = capsys.readouterr().out
    assert "automatically assigned port" in output
    assert "http://127.0.0.1:0/" not in output


def test_cli_local_browser_rejects_wildcard_bind(command, monkeypatch):
    module, captured = command
    monkeypatch.setattr(sys, "argv", ["serve-legacy.py", "--source-yaml", "sources.yml", "--legacy-root", "legacy",
                                    "--allow-root", "data", "--local-browser", "--host", "0.0.0.0"])
    with pytest.raises(SystemExit):
        module.main()
    assert captured == {}
