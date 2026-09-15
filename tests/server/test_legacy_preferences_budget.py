from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from test_legacy_api import legacy  # noqa: F401
from server.app.main import create_app
from server.app.services.query_resources import QueryResourceLedger


def test_admission_rejects_before_preferences_capture_without_retaining_a_handle(legacy, tmp_path, monkeypatch):  # noqa: F811
    options, _, _ = legacy
    root = tmp_path / "state"
    app = create_app(root, TOKEN, legacy_config={**options, "preferencesRoot": str(root / "preferences")})
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        engine, coordinator, adapter = app.state.queries, app.state.preparations, app.state.preferences
        request = {"definitionVersion": 2, "domain": {"from": "2024-03-01T00:00:00Z", "to": "2024-03-02T00:00:00Z"}}
        identity = app.state.identities.authenticate(TOKEN)
        scope = app.state.access._scope(app.state.access._current(identity, "records.read"))
        source, allowance = adapter.capture_admission()
        assert allowance > 0
        probe = QueryResourceLedger()
        probe.reserve("initial", {"scope": scope, "request": request, "metadata": app.state.repository.meta, "preferences": source},
                      overhead=coordinator.preparation_allowance_bytes + 16 * len(app.state.repository.records))
        engine.resources.limit_bytes = probe.retained_bytes + allowance // 2
        called = []
        capture = adapter.capture

        def observe():
            called.append(True)
            return capture()
        monkeypatch.setattr(adapter, "capture", observe)
        response = client.post(BASE + "/query-sessions", json=request, headers={"Prefer": "respond-async"})
        assert response.status_code == 413, response.text
        assert response.json()["code"] == "query_memory_capacity"
        assert called == []
        assert engine.resources.retained_bytes == 0
        assert not engine.resources.roots and not engine.queries and not coordinator.jobs
