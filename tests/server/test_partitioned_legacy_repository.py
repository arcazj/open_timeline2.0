import json
from datetime import date, timedelta
from pathlib import Path

import pytest

from server.app.models.domain import DomainError, validate_snapshot
from server.app.repositories.partitioned_legacy_repository import PartitionedLegacyRepository
from server.app.services import legacy_reader
from server.app.main import create_app
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from server.app.api.openapi import build_contract
import time


@pytest.fixture
def archive(tmp_path):
    legacy, root = tmp_path / "legacy", tmp_path / "archive"
    legacy.mkdir()
    originals = {}
    for i in range(120):
        day = date(2024, 1, 1) + timedelta(days=i)
        path = root / day.strftime("%Y/%m/%d") / "events.json"
        path.parent.mkdir(parents=True)
        events = [{"id": f"point-{i}", "start": f"{day}T12:00:00Z", "data": {"title": f"Real event {i}"}}]
        if i == 0:
            events += [
                {"id": "long", "start": "2024-01-01T00:00:00Z", "end": "2024-06-01T00:00:00Z", "data": {"title": "Long session"}},
                {"id": "zone", "zone": True, "start": "2024-01-01T00:00:00Z", "end": "2024-06-01T00:00:00Z", "data": {"title": "Long zone"}},
            ]
        raw = json.dumps({"events": events}).encode()
        path.write_bytes(raw)
        originals[path] = raw
    options = {"yaml": str(tmp_path / "profile.yml"), "legacyRoot": str(legacy), "allowRoots": [str(root)],
               "pathMaps": {"/archive": str(root)}, "lazy": True,
               "loading": {"initialRange": {"from": "2024-02-10T11:30:00Z", "to": "2024-02-10T12:30:00Z"}},
               "sourceDocument": {"data_sources": [{"namespace": "REAL", "type": "json_file", "enable": True,
                                                    "data_model": "/archive/yyyy/mm/dd"}]}}
    return options, tmp_path / "state", originals


def opened(archive):
    options, state, _ = archive
    repository = PartitionedLegacyRepository(options, state)
    repository._index_loop = lambda: None
    repository.open()
    return repository


def window():
    return {"domain": {"from": "2024-02-10T11:30:00Z", "to": "2024-02-10T12:30:00Z"}}


def test_startup_reads_no_record_files_and_cold_window_is_honestly_partial(archive, monkeypatch):
    reads = []
    original = legacy_reader.safe_read
    def capture(path, *args):
        reads.append(Path(path))
        return original(path, *args)
    monkeypatch.setattr(legacy_reader, "safe_read", capture)
    repository = opened(archive)
    try:
        assert reads == []
        assert repository.metadata()["sourceName"] == "REAL"
        assert repository.metadata()["recordCount"] is None
        result = repository.capture_query_domain(window())
        assert [record["title"] for record in result["records"]] == ["Real event 40"]
        assert result["manifest"]["legacy"]["coverage"]["complete"] is False
        assert len(reads) == 1
        assert repository.records == {}
    finally:
        repository.close()


def test_index_finds_earlier_sessions_and_zones_without_holding_the_archive(archive):
    repository = opened(archive)
    try:
        repository._reconcile()
        result = repository.capture_query_domain(window())
        assert {record["title"] for record in result["records"]} == {"Real event 40", "Long session"}
        assert [zone["title"] for zone in result["zones"]] == ["Long zone"]
        assert result["manifest"]["legacy"]["coverage"]["complete"] is True
        assert repository.coverage()["recordCount"] == 121
        assert repository.records == {}
        assert repository.reader._cache_size <= repository.reader.limits.cache_bytes
        assert all(path.read_bytes() == content for path, content in archive[2].items())
    finally:
        repository.close()


def test_warm_start_verifies_metadata_without_rereading_unchanged_json(archive, monkeypatch):
    repository = opened(archive)
    repository._reconcile()
    repository.close()
    reads = []
    original = legacy_reader.safe_read
    def capture(path, *args):
        reads.append(Path(path))
        return original(path, *args)
    monkeypatch.setattr(legacy_reader, "safe_read", capture)
    repository = opened(archive)
    try:
        assert repository.coverage()["state"] == "verifying"
        repository._reconcile()
        assert reads == []
        assert repository.loading_status()["metrics"]["indexFilesReused"] == 120
        repository.capture_query_domain(window())
        assert len(reads) == 2
        repository.capture_query_domain(window())
        assert len(reads) == 2
    finally:
        repository.close()


def test_removed_and_changed_partitions_leave_old_query_images_unchanged(archive):
    repository = opened(archive)
    try:
        repository._reconcile()
        before = repository.capture_query_domain(window())
        path = next(path for path in archive[2] if path.as_posix().endswith("2024/02/10/events.json"))
        path.write_text(json.dumps({"events": [{"id": "replacement", "start": "2024-02-10T12:00:00Z", "data": {"title": "Replacement"}}]}))
        repository._reconcile()
        after = repository.capture_query_domain(window())
        assert {record["title"] for record in before["records"]} == {"Real event 40", "Long session"}
        assert {record["title"] for record in after["records"]} == {"Replacement", "Long session"}
        path.unlink()
        repository._reconcile()
        assert [record["title"] for record in repository.capture_query_domain(window())["records"]] == ["Long session"]
    finally:
        repository.close()


def test_bad_visible_json_is_an_error_not_an_empty_or_stale_success(archive):
    repository = opened(archive)
    try:
        repository.capture_query_domain(window())
        path = next(path for path in archive[2] if path.as_posix().endswith("2024/02/10/events.json"))
        path.write_text('{"events":')
        with pytest.raises(DomainError, match="visible legacy files"):
            repository.capture_query_domain(window())
    finally:
        repository.close()


def test_export_is_complete_and_does_not_export_only_the_last_page(archive):
    repository = opened(archive)
    try:
        repository.capture_query_domain(window())
        snapshot = repository.snapshot()
        validate_snapshot(snapshot)
        assert len(snapshot["records"]) == 121
        assert snapshot["manifest"]["recordCount"] == 121
        assert repository.records == {}
    finally:
        repository.close()


def test_index_corruption_is_discarded_and_source_filter_cannot_escape(archive):
    repository = opened(archive)
    repository._reconcile()
    repository.close()
    path = archive[1] / "legacy-file-index.json"
    value = json.loads(path.read_text())
    value["entries"][0]["file"] = "../../outside.json"
    path.write_text(json.dumps(value))
    repository = opened(archive)
    try:
        assert repository.coverage()["indexedFiles"] == 0
        assert repository.capture_query_domain({**window(), "filters": {"sourceIds": []}})["records"] == []
        with pytest.raises(DomainError):
            repository.capture_query_domain({**window(), "filters": {"sourceIds": [{}]}})
    finally:
        repository.close()


def test_real_api_pins_deferred_identity_density_and_pages_and_exports_all_records(archive, monkeypatch):
    options, state, _ = archive
    monkeypatch.setattr(PartitionedLegacyRepository, "_index_loop", lambda self: None)
    app = create_app(data_root=state, legacy_config=options, token="test-only-lazy-source-token")
    headers = {"Authorization": "Bearer test-only-lazy-source-token"}
    base = "/api/v1/workspaces/default"
    with TestClient(app, headers=headers) as client:
        schemas = build_contract(app)["components"]["schemas"]
        def prepare(body):
            response = client.post(base + "/query-sessions", json=body, headers={"Prefer": "respond-async"})
            assert response.status_code in (200, 202), response.text
            initial = response.json()
            deadline = time.monotonic() + 5
            result = initial
            while result["state"] == "preparing" and time.monotonic() < deadline:
                time.sleep(.01)
                result = client.get(base + "/query-sessions/" + initial["queryId"]).json()
            assert result["state"] == "ready", result
            assert all(result[key] == initial[key] for key in ("generation", "revision", "queryId", "snapshotId", "mapId"))
            return result
        first = prepare({**window(), "scaleMode": "adaptive"})
        assert first["coverage"]["complete"] is False
        Draft202012Validator(schemas["WindowCoverage"]).validate(first["coverage"])
        assert client.get(base).json()["recordCount"] is None
        query_path = base + "/query-sessions/" + first["queryId"]
        density = client.get(query_path + "/density").json()
        Draft202012Validator(schemas["Density"]).validate(density)
        assert density["complete"] is False
        overview = client.get(query_path + "/overview").json()
        Draft202012Validator(schemas["WindowCoverage"]).validate(overview["coverage"])
        assert overview["coverage"]["complete"] is False
        assert client.get(query_path + "/maps/" + first["mapId"]).json()["mode"] == "uniform"
        app.state.repository._reconcile()
        verified = prepare({**window(), "scaleMode": "adaptive"})
        assert verified["coverage"]["complete"] is True
        Draft202012Validator(schemas["WindowCoverage"]).validate(verified["coverage"])
        assert verified["baseTotal"] == 2
        assert client.get(query_path).json()["baseTotal"] == 1
        exported = client.get(base + "/snapshot")
        assert exported.status_code == 200, exported.text
        assert len(exported.json()["records"]) == 121
        assert client.get(base + "/records").status_code == 422
        assert client.post(base + "/legacy/prefetch", json=window()).json()["status"] == "cached"
