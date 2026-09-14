import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from server.app.main import create_app
from server.app.models.domain import DomainError
from server.app.models.domain import validate_snapshot


def write_events(path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"events": events}), encoding="utf-8")


@pytest.fixture
def legacy(tmp_path):
    root, data = tmp_path / "legacy", tmp_path / "authority"
    root.mkdir()
    first = data / "2023/12/31/events.json"
    second = data / "2024/03/01/events.json"
    write_events(first, [
        {"id": "long", "start": "2023-12-31T00:00:00Z", "end": "2024-03-02T00:00:00Z", "data": {"title": "Cross-year session", "namespace": "N"}},
        {"id": "old", "start": "2023-12-31T01:00:00Z", "data": {"title": "Old event"}},
    ])
    write_events(second, [
        {"id": "a", "start": "2024-03-01T12:00:00Z", "data": {"title": "First match"}},
        {"id": "b", "start": "2024-03-01T12:00:00Z", "data": {"title": "Second match"}},
        {"id": "z", "zone": True, "start": "2024-03-01T11:00:00Z", "end": "2024-03-01T13:00:00Z", "data": {"title": "Zone"}},
    ])
    yaml = root / "sources.yml"
    yaml.write_text('data_sources:\n- namespace: N\n  type: json_file\n  enable: true\n  data_path: /archive\n  data_model: /archive/yyyy/mm/dd\n', encoding="utf-8")
    options = {"yaml": str(yaml), "legacyRoot": str(root), "allowRoots": [str(data)], "pathMaps": {"/archive": str(data)}}
    return options, first, second


def ready(client, response):
    deadline = time.monotonic() + 5
    while response.status_code == 202 and time.monotonic() < deadline:
        time.sleep(0.01)
        response = client.get(response.headers["location"])
    assert response.status_code == 200, response.text
    assert response.json().get("state", "ready") == "ready", response.text
    return response.json()


def query(client):
    return ready(client, client.post(BASE + "/query-sessions", json={
        "domain": {"from": "2024-03-01T00:00:00Z", "to": "2024-03-02T00:00:00Z"}}))


def test_yaml_archive_query_pagination_and_read_only(legacy, tmp_path):
    options, first, second = legacy
    originals = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (first, second)}
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        status = client.get(BASE).json()
        assert status["recordCount"] == 4
        assert status["legacy"]["queryScope"] == "overlapping-query-domain"
        assert status["durability"] == "read-only-files"
        assert status["capabilities"]["recordCrud"] is False
        assert client.get(BASE + "/settings/effective").status_code == 200
        manifest = query(client)
        assert manifest["baseTotal"] == 3
        assert len(client.get(BASE + f'/query-sessions/{manifest["queryId"]}/zones').json()["items"]) == 1
        layout = ready(client, client.post(BASE + f'/query-sessions/{manifest["queryId"]}/layouts', json={
            "mapId": manifest["mapId"], "from": "2024-03-01T00:00:00Z", "to": "2024-03-02T00:00:00Z",
            "width": 800, "availableHeight": 32, "rowHeight": 32, "fontSize": 12, "groupBy": "none"}))
        path = BASE + f'/query-sessions/{manifest["queryId"]}/layouts/{layout["layoutId"]}/rows'
        ids, cursor = [], None
        while True:
            page = client.get(path, params={"cursor": cursor} if cursor else {}).json()
            ids.extend(item["record"]["id"] for item in page["items"] if item.get("record"))
            cursor = page["nextCursor"]
            if not cursor:
                break
        assert len(ids) == len(set(ids)) == 3
        record = client.get(BASE + "/records/" + ids[0]).json()
        for method, route, payload in [
            ("post", "/records", {"title": "Forbidden", "kind": "event", "start": "2024-03-01T00:00:00Z"}),
            ("delete", "/records/" + record["id"], None),
            ("post", "/configuration/commands", {}), ("post", "/settings/commands", {}),
        ]:
            response = client.request(method, BASE + route, json=payload)
            assert response.status_code == 403, response.text
            assert response.json()["code"] == "legacy_read_only"
        snapshot = client.get(BASE + "/snapshot")
        assert snapshot.status_code == 200, snapshot.text
        assert snapshot.json()["manifest"]["recordCount"] == 4
        assert client.get(BASE + "/openapi.json").status_code == 200
    assert all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in originals.items())


def test_local_browser_paths_are_same_origin_and_read_only(legacy, tmp_path):
    options, first, second = legacy
    original = {path: path.read_bytes() for path in (first, second)}
    origin = "http://127.0.0.1:9876"
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options, local_browser_origin=origin)
    headers = {"X-OpenBEXI-Local": "1", "Sec-Fetch-Site": "same-origin", "Origin": origin}
    with TestClient(app, base_url=origin, client=("127.0.0.1", 54321), headers=headers) as client:
        catalog = client.get("/api/v1/local-sources")
        assert catalog.status_code == 200, catalog.text
        assert catalog.json()["sources"][0]["path"] == str(first.parents[3])
        assert client.get(BASE).status_code == 200
        contract = client.get(BASE + "/openapi.json")
        assert contract.status_code == 200, contract.text
        assert "/api/v1/local-sources" not in contract.json()["paths"]
        assert TOKEN not in contract.text and str(first) not in contract.text
        assert client.post(BASE + "/records", json={}).status_code == 403
        for header in [{"Origin": "http://evil.test"}, {"Origin": "null"}, {"Host": "evil.test:9876"},
                       {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": ""}, {"X-OpenBEXI-Local": ""}]:
            assert client.get("/api/v1/local-sources", headers=header).status_code == 403
            assert client.get(BASE, headers=header).status_code in (401, 403)
        assert client.post("/api/v1/local-sources", json={"path": "C:/Windows"}).status_code == 405
        result = ready(client, client.post(BASE + "/query-sessions", json={
            "domain": {"from": "2024-03-01T00:00:00Z", "to": "2024-03-02T00:00:00Z"}, "filters": {"sourceIds": []}}))
        assert result["baseTotal"] == 0
        assert client.get(BASE + f'/query-sessions/{result["queryId"]}/zones').json()["items"] == []
    assert all(path.read_bytes() == value for path, value in original.items())


@pytest.mark.parametrize("origin", ["http://0.0.0.0:9876", "https://127.0.0.1:9876", "http://evil.test:9876", "http://127.0.0.1:9876/path"])
def test_local_browser_cannot_be_enabled_on_remote_origins(legacy, tmp_path, origin):
    with pytest.raises(ValueError):
        create_app(tmp_path / "state", TOKEN, legacy_config=legacy[0], local_browser_origin=origin)


def test_local_browser_requires_legacy_readonly_and_no_cors(tmp_path, legacy, monkeypatch):
    with pytest.raises(ValueError):
        create_app(tmp_path / "state", TOKEN, local_browser_origin="http://127.0.0.1:9876")
    monkeypatch.setenv("OPENBEXI_CORS_ORIGINS", "http://other.test")
    with pytest.raises(RuntimeError, match="cross-origin"):
        create_app(tmp_path / "state", TOKEN, legacy_config=legacy[0], local_browser_origin="http://127.0.0.1:9876")


def test_local_browser_rejects_nonloopback_peer_with_forged_browser_headers(tmp_path, legacy):
    origin = "http://127.0.0.1:9876"
    app = create_app(tmp_path / "state", TOKEN, legacy_config=legacy[0], local_browser_origin=origin)
    with TestClient(app, base_url=origin, client=("203.0.113.10", 54321),
                    headers={"X-OpenBEXI-Local": "1", "Sec-Fetch-Site": "same-origin", "Origin": origin}) as client:
        assert client.get("/api/v1/local-sources").status_code == 403
        assert client.get(BASE).status_code == 403


def test_local_browser_restart_keeps_private_key_outside_authorities(tmp_path, legacy):
    origin = "http://127.0.0.1:9876"
    headers = {"X-OpenBEXI-Local": "1", "Sec-Fetch-Site": "same-origin", "Origin": origin}
    root = tmp_path / "state"
    identities = []
    for secret in ("first-local-private-key", "different-generated-key"):
        app = create_app(root, secret, legacy_config=legacy[0], local_browser_origin=origin)
        with TestClient(app, base_url=origin, client=("127.0.0.1", 12345), headers=headers) as client:
            response = client.get(BASE)
            assert response.status_code == 200, response.text
            identities.append(response.json()["actor"]["id"])
            assert secret not in response.text
            assert secret not in client.get("/api/v1/local-sources").text
    assert len(set(identities)) == 1
    key = root / "local-browser-key.json"
    assert json.loads(key.read_text())["secret"] == "first-local-private-key"
    key.unlink()
    with pytest.raises(DomainError, match="Local key is missing"):
        with TestClient(create_app(root, TOKEN, legacy_config=legacy[0], local_browser_origin=origin)):
            pass


def test_rescan_keeps_queries_pinned_and_last_good_file_image(legacy, tmp_path):
    options, _, second = legacy
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        before = query(client)
        write_events(second, [{"id": "new", "start": "2024-03-01T12:00:00Z", "data": {"title": "New event"}}])
        response = client.post(BASE + "/legacy/reload")
        assert response.status_code == 200, response.text
        assert query(client)["baseTotal"] == 2
        assert client.get(BASE + f'/query-sessions/{before["queryId"]}').json() == before
        second.write_text('{"events": [', encoding="utf-8")
        response = client.post(BASE + "/legacy/reload")
        assert response.status_code == 200, response.text
        assert response.json()["legacy"]["status"] == "stale"
        assert response.json()["legacy"]["staleFiles"] == 1
        assert query(client)["baseTotal"] == 2


def test_state_cannot_overlap_legacy_authority(legacy):
    options, first, _ = legacy
    app = create_app(first.parent / "state", TOKEN, legacy_config=options)
    with pytest.raises(DomainError, match="disjoint"):
        with TestClient(app):
            pass
    assert not (first.parent / "state").exists()


@pytest.mark.parametrize("short_name", [False, True] if sys.platform == "win32" else [False])
def test_model_and_namespace_bindings_are_served(legacy, tmp_path, short_name):
    options, _, _ = legacy
    model = Path(__file__).parents[1] / "client/fixtures/legacy-test-regular.json"
    target = Path(options["legacyRoot"]) / "model.json"
    target.write_bytes(model.read_bytes())
    if short_name:
        import ctypes
        from ctypes import wintypes
        shorten = ctypes.windll.kernel32.GetShortPathNameW
        shorten.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        shorten.restype = wintypes.DWORD
        buffer = ctypes.create_unicode_buffer(32768)
        count = shorten(str(target), buffer, len(buffer))
        assert 0 < count < len(buffer)
        target = Path(buffer.value)
        options = {**options, "legacyRoot": str(target.parent)}
    app = create_app(tmp_path / "state", TOKEN, legacy_config={**options, "model": str(target), "namespaceGrouping": True})
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        response = client.get(BASE)
        assert response.status_code == 200, response.text
        status = response.json()
        assert status["settings"]["presentation"]["grouping"]["field"] == "/data/namespace"
        assert status["legacy"]["viewHints"]["bands"]["overview"]["heightFraction"] == .25
        assert status["settings"]["presentation"]["sourceStyles"][0]["namespace"] == "N"


@pytest.fixture
def scoped_legacy(tmp_path):
    root, data = tmp_path / "legacy", tmp_path / "authority"
    root.mkdir()
    for namespace, label in (("PUBLIC", "Public"), ("SECRET_NAMESPACE", "hidden-record")):
        source = data / namespace
        write_events(source / "2024/03/01/events.json", [
            {"id": "event", "start": "2024-03-01T12:00:00Z", "data": {"title": label, "namespace": namespace}},
            {"id": "zone", "zone": True, "start": "2024-03-01T11:00:00Z", "end": "2024-03-01T13:00:00Z",
             "data": {"title": label + " zone", "namespace": namespace}},
        ])
        if namespace != "PUBLIC":
            write_events(source / "2035/03/01/events.json", [
                {"id": "future", "start": "2035-03-01T12:00:00Z", "data": {"title": "hidden-future"}},
            ])
            descriptor = source / "2024/03/01/descriptors/event.json"
            descriptor.parent.mkdir()
            descriptor.write_text(json.dumps({"event_descriptor": [
                {"id": "event", "namespace": namespace, "secret": "hidden-sidecar"}]}), encoding="utf-8")
    source_yaml = root / "sources.yml"
    source_yaml.write_text("data_sources:\n" + "".join(
        f"- namespace: {namespace}\n  type: json_file\n  enable: true\n  data_path: /archive\n"
        f"  data_model: /archive/{namespace}/yyyy/mm/dd\n  render:\n    color: '#CCEEFF'\n"
        for namespace in ("PUBLIC", "SECRET_NAMESPACE")), encoding="utf-8")
    model = root / "model.json"
    model.write_bytes((Path(__file__).parents[1] / "client/fixtures/legacy-test-regular.json").read_bytes())
    return {"yaml": str(source_yaml), "legacyRoot": str(root), "allowRoots": [str(data)],
            "pathMaps": {"/archive": str(data)}, "model": str(model), "namespaceGrouping": True}


def source_viewer(app, source_ids):
    store = app.state.identities
    admin = store.authenticate(TOKEN)
    principal = store.create_principal(admin, {"name": "Scoped reader", "role": "viewer", "grants": [
        {"workspaceId": "default", "sourceIds": source_ids, "capabilities": []}]},
        store.state["generation"], store.state["revision"], uuid.uuid4().hex)
    token = store.create_token(admin, {"principalId": principal["id"], "name": "Scope test", "expiresAt": None},
                              store.state["generation"], store.state["revision"], uuid.uuid4().hex)
    return principal, token["secret"]


def assert_no_private_source(value, private_id):
    encoded = json.dumps(value)
    for marker in (private_id, "SECRET_NAMESPACE", "hidden-record", "hidden-sidecar", "hidden-future", "2035-"):
        assert marker not in encoded, marker


def test_source_grants_hide_legacy_metadata_catalogs_records_zones_and_exports(scoped_legacy, tmp_path):
    app = create_app(tmp_path / "state", TOKEN, legacy_config=scoped_legacy)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        admin_metadata = client.get(BASE).json()
        sources = {source.namespace: source.id for source in app.state.repository.configuration.sources}
        public, private = sources["PUBLIC"], sources["SECRET_NAMESPACE"]
        private_record = next(record for record in app.state.repository.records.values() if record["sourceId"] == private)
        _, token = source_viewer(app, [public])
        client.headers["Authorization"] = "Bearer " + token
        for endpoint in (BASE, BASE + "/settings/effective", BASE + "/models", BASE + "/sources"):
            response = client.get(endpoint)
            assert response.status_code == 200, response.text
            assert_no_private_source(response.json(), private)
        metadata = client.get(BASE).json()
        assert metadata["recordCount"] == metadata["legacy"]["allRecordCount"] == 1
        assert metadata["legacy"]["domain"]["to"].startswith("2024-")
        assert metadata["capabilities"]["legacyReload"] is False
        assert client.post(BASE + "/legacy/reload").status_code == 403
        assert client.get(BASE + "/records/" + private_record["id"]).status_code == 404
        assert client.get(BASE + "/records/" + private_record["id"] + "/legacy-descriptor").status_code == 404
        assert client.get(BASE + "/sources/" + private).status_code == 404
        model_id = metadata["settings"]["modelId"]
        for endpoint in (BASE + "/models/" + model_id,
                         BASE + "/configuration/resource?family=sources&id=" + public):
            response = client.get(endpoint)
            assert response.status_code == 200, response.text
            assert_no_private_source(response.json(), private)
        manifest = query(client)
        assert manifest["baseTotal"] == 1
        zones = client.get(BASE + f'/query-sessions/{manifest["queryId"]}/zones').json()
        assert len(zones["items"]) == 1
        assert_no_private_source(zones, private)
        layout = ready(client, client.post(BASE + f'/query-sessions/{manifest["queryId"]}/layouts', json={
            "mapId": manifest["mapId"], "from": "2024-03-01T00:00:00Z", "to": "2024-03-02T00:00:00Z",
            "width": 800, "availableHeight": 160, "rowHeight": 32, "fontSize": 12,
            "groupBy": "none", "presentation": metadata["settings"]["presentation"]}))
        assert_no_private_source(layout, private)
        response = client.get(BASE + "/snapshot")
        assert response.status_code == 200, response.text
        snapshot = response.json()
        assert snapshot["manifest"]["recordCount"] == 1
        assert snapshot["manifest"]["legacy"]["allRecordCount"] == 1
        assert len(snapshot["zones"]) == 1
        assert_no_private_source(snapshot, private)
        validate_snapshot(snapshot)
        client.headers["Authorization"] = "Bearer " + TOKEN
        assert client.get(BASE).json() == admin_metadata


def test_legacy_source_grant_revocation_invalidates_query_and_cached_configuration(scoped_legacy, tmp_path):
    app = create_app(tmp_path / "state", TOKEN, legacy_config=scoped_legacy)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        sources = {source.namespace: source.id for source in app.state.repository.configuration.sources}
        principal, token = source_viewer(app, list(sources.values()))
        client.headers["Authorization"] = "Bearer " + token
        before = query(client)
        assert "SECRET_NAMESPACE" in client.get(BASE + "/settings/effective").text
        store = app.state.identities
        store.update_principal(store.authenticate(TOKEN), principal["id"], {"grants": [
            {"workspaceId": "default", "sourceIds": [sources["PUBLIC"]], "capabilities": []}]},
            store.state["generation"], principal["revision"], uuid.uuid4().hex)
        response = client.get(BASE + f'/query-sessions/{before["queryId"]}')
        assert response.status_code in (409, 410), response.text
        assert_no_private_source(client.get(BASE + "/settings/effective").json(), sources["SECRET_NAMESPACE"])
        assert_no_private_source(client.get(BASE + "/snapshot").json(), sources["SECRET_NAMESPACE"])


def test_legacy_configuration_usage_cursor_survives_next_request(legacy, tmp_path):
    options, _, _ = legacy
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        schema = client.get(BASE + "/schemas").json()["items"][0]["id"]
        response = client.get(BASE + f"/schemas/{schema}/usage", params={"limit": 1})
        assert response.status_code == 200, response.text
        first = response.json()
        assert first["nextCursor"] is not None
        response = client.get(BASE + f"/schemas/{schema}/usage", params={"limit": 1, "cursor": first["nextCursor"]})
        assert response.status_code == 200, response.text
        assert response.json()["items"] != first["items"]


def test_empty_source_scope_cannot_reveal_archive_bounds_or_zone_data(scoped_legacy, tmp_path):
    app = create_app(tmp_path / "state", TOKEN, legacy_config=scoped_legacy)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        _, token = source_viewer(app, [])
        client.headers["Authorization"] = "Bearer " + token
        metadata = client.get(BASE)
        assert metadata.status_code == 200, metadata.text
        metadata = metadata.json()
        assert metadata["sourceIds"] == []
        assert metadata["recordCount"] == metadata["legacy"]["allRecordCount"] == 0
        assert metadata["legacy"]["domain"] is None
        assert metadata["legacy"]["configuration"]["sources"] == []
        assert metadata["settings"]["presentation"]["sourceStyles"] == []
        manifest = query(client)
        assert manifest["baseTotal"] == 0
        assert client.get(BASE + f'/query-sessions/{manifest["queryId"]}/zones').json()["items"] == []
        snapshot = client.get(BASE + "/snapshot")
        assert snapshot.status_code == 200, snapshot.text
        assert snapshot.json()["records"] == []
        assert snapshot.json()["zones"] == []
        validate_snapshot(snapshot.json())


def test_unknown_file_on_reload_does_not_replace_last_good_archive(legacy, tmp_path):
    options, _, second = legacy
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        before = client.get(BASE).json()
        malformed = second.parent / "new-partial.json"
        malformed.write_text('{"events": [', encoding="utf-8")
        response = client.post(BASE + "/legacy/reload")
        assert response.status_code == 409, response.text
        assert response.json()["code"] == "legacy_incomplete"
        assert client.get(BASE).json() == before
        assert query(client)["baseTotal"] == 3


def test_earliest_supported_point_has_a_positive_initial_range(legacy, tmp_path):
    options, first, second = legacy
    write_events(first, [{"id": "earliest", "start": "-009999-01-01T00:00:00.000Z", "data": {"title": "Earliest point"}}])
    write_events(second, [])
    app = create_app(tmp_path / "state", TOKEN, legacy_config=options)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        metadata = client.get(BASE)
        assert metadata.status_code == 200, metadata.text
        for key in ("range", "overview"):
            assert metadata.json()["settings"][key] == {
                "from": "-009999-01-01T00:00:00.000Z", "to": "-009999-01-01T00:00:00.001Z"}


def test_scoped_earliest_point_range_cannot_underflow(scoped_legacy, tmp_path):
    authority = Path(scoped_legacy["allowRoots"][0])
    write_events(authority / "PUBLIC/2024/03/01/events.json", [
        {"id": "earliest", "start": "-009999-01-01T00:00:00.000Z", "data": {"title": "Earliest point"}}])
    app = create_app(tmp_path / "state", TOKEN, legacy_config=scoped_legacy)
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        public = next(source.id for source in app.state.repository.configuration.sources if source.namespace == "PUBLIC")
        _, token = source_viewer(app, [public])
        client.headers["Authorization"] = "Bearer " + token
        metadata = client.get(BASE)
        assert metadata.status_code == 200, metadata.text
        for key in ("range", "overview"):
            assert metadata.json()["settings"][key] == {
                "from": "-009999-01-01T00:00:00.000Z", "to": "-009999-01-01T00:00:00.001Z"}
