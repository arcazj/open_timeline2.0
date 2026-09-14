import copy
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import rfc8785

from conftest import BASE, ROOT
from server.app.models.domain import DomainError, content_checksum, read_json, validate_snapshot
from server.app.models.model_catalog import apply_model_command, normalize_metadata
from server.app.repositories.json_repository import JsonRepository, atomic_json

DEFINITION = {"theme": "dark", "rowHeight": 38, "fontSize": 14, "groupBy": "sourceId", "displayUnit": "MINUTE",
              "timeZone": "America/New_York", "scaleMode": "adaptive", "ratio": 6, "bins": 64}


def command(client, headers, operation, model=None, payload=None, key=None, etag=None):
    path = BASE + "/models"
    write = {**headers, "Idempotency-Key": key or str(uuid.uuid4())}
    if model is not None:
        path += "/" + model["id"]
        write["If-Match"] = etag or f'"{headers["X-Workspace-Generation"]}:{model["revision"]}"'
    if operation == "delete":
        return client.delete(path, headers=write)
    if operation == "update":
        return client.put(path, json=payload or {}, headers=write)
    if operation != "create":
        path += "/" + operation
    return client.post(path, json=payload or {}, headers=write)


def created_model(client, headers, definition=None, key=None):
    result = command(client, headers, "create", payload={"name": "Operations custom", "definition": definition or DEFINITION}, key=key)
    assert result.status_code == 201, result.text
    return result.json()["model"]


def test_catalog_read_normalizes_legacy_without_writing(client, app, bundle):
    path = app.state.repository.root / "workspace.json"
    before = path.read_bytes()
    response = client.get(BASE + "/models")
    assert response.status_code == 200
    catalog = response.json()
    assert len(catalog["items"]) == 3
    assert catalog["active"] == {"modelId": "light", "version": 1}
    model = catalog["items"][0]
    assert model["revision"] == 1 and model["draft"] is None
    assert model["versions"][0]["publishedAt"] == bundle["manifest"]["snapshotAt"]
    assert model["versions"][0]["definition"]["displayUnit"] == "HOUR"
    detail = client.get(BASE + "/models/light")
    assert detail.json()["usage"] == [{"kind": "workspace-default", "modelId": "light", "version": 1}]
    assert detail.headers["etag"] == f'"{catalog["generation"]}:1"'
    assert path.read_bytes() == before
    status = client.get(BASE).json()
    assert status["capabilities"]["modelManagement"] and status["capabilities"]["modelPublication"]


def test_publish_is_immutable_and_never_applies_implicitly(client, write_headers, app):
    original = client.get(BASE).json()["settings"]
    original_overrides = copy.deepcopy(app.state.repository.query_snapshot()["settings"])
    model = created_model(client, write_headers)
    assert model["versions"] == [] and model["draft"] == DEFINITION
    publication = command(client, write_headers, "publish", model)
    assert publication.status_code == 200, publication.text
    model = publication.json()["model"]
    assert model["revision"] == 2 and model["draft"] is None
    assert model["versions"][0]["definition"] == DEFINITION
    assert publication.json()["settings"] == original_overrides
    assert client.get(BASE).json()["settings"] == original
    changed = {**DEFINITION, "theme": "classic", "ratio": 2}
    update = command(client, write_headers, "update", model, {"draft": changed, "name": "Revised name"})
    assert update.status_code == 200
    model = update.json()["model"]
    assert model["versions"][0]["definition"] == DEFINITION
    second = command(client, write_headers, "publish", model).json()
    assert [version["version"] for version in second["model"]["versions"]] == [1, 2]
    assert second["model"]["versions"][0]["definition"] == DEFINITION
    assert second["model"]["versions"][1]["definition"] == changed
    assert second["settings"] == original_overrides
    assert client.get(BASE).json()["settings"] == original


def test_explicit_apply_pins_old_version_and_preserves_focus(client, write_headers, bundle):
    model = created_model(client, write_headers)
    model = command(client, write_headers, "publish", model).json()["model"]
    model = command(client, write_headers, "update", model, {"draft": {**DEFINITION, "theme": "classic"}}).json()["model"]
    model = command(client, write_headers, "publish", model).json()["model"]
    revision_before = client.get(BASE).json()["revision"]
    applied = command(client, write_headers, "apply", model, {"version": 1})
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["revision"] == revision_before + 1
    assert result["model"]["revision"] == model["revision"]
    assert result["settings"]["modelId"] == model["id"] and result["settings"]["modelVersion"] == 1
    assert all(result["settings"][key] == value for key, value in DEFINITION.items())
    for key in ("range", "overview", "referenceTime"):
        assert result["settings"][key] == bundle["settings"][key]
    assert command(client, write_headers, "delete", model).status_code == 409


def test_archive_unarchive_delete_and_usage(client, write_headers):
    model = created_model(client, write_headers)
    model = command(client, write_headers, "publish", model).json()["model"]
    archived = command(client, write_headers, "archive", model).json()["model"]
    assert archived["lifecycle"] == "archived"
    assert client.get(BASE + "/models/" + model["id"]).status_code == 200
    assert all(item["id"] != model["id"] for item in client.get(BASE + "/models?includeArchived=false").json()["items"])
    for operation, payload in (("update", {"name": "Disallowed"}), ("publish", {}), ("apply", {"version": 1})):
        response = command(client, write_headers, operation, archived, payload)
        assert response.status_code == 409 and response.json()["code"] == "model_archived"
    restored = command(client, write_headers, "unarchive", archived).json()["model"]
    assert restored["lifecycle"] == "active"
    deleted = command(client, write_headers, "delete", restored)
    assert deleted.status_code == 200 and deleted.json()["model"] is None
    assert client.get(BASE + "/models/" + restored["id"]).status_code == 404
    default = client.get(BASE + "/models/light").json()["model"]
    archived_default = command(client, write_headers, "archive", default)
    assert archived_default.status_code == 200
    assert client.get(BASE).json()["settings"]["modelId"] == "light"
    assert command(client, write_headers, "delete", archived_default.json()["model"]).status_code == 409


def test_model_idempotency_revision_and_cross_resource_conflicts(client, write_headers):
    payload = {"name": "Retry model", "definition": DEFINITION}
    original = command(client, write_headers, "create", payload=payload, key="model-create")
    repeated = command(client, write_headers, "create", payload=payload, key="model-create")
    assert original.json() == repeated.json()
    model = original.json()["model"]
    first = command(client, write_headers, "update", model, {"description": "One"})
    assert first.status_code == 200
    assert command(client, write_headers, "update", model, {"description": "Stale"}).status_code == 412
    assert command(client, write_headers, "create", payload={**payload, "name": "Different"}, key="model-create").status_code == 409
    record = client.post(BASE + "/records", json={"title": "Cross-resource"}, headers={**write_headers, "Idempotency-Key": "model-create"})
    assert record.status_code == 409
    outcome = client.get(BASE + "/command-results/model-create")
    assert outcome.json() == original.json()
    assert client.post(BASE + "/models", json=payload).status_code == 428
    assert command(client, {**write_headers, "X-Workspace-Generation": "old"}, "create", payload=payload).status_code == 409


@pytest.mark.parametrize("field,value", [("rowHeight", 32), ("fontSize", "14"), ("groupBy", "command"), ("timeZone", "+03:00"),
                                         ("timeZone", "Not/AZone"), ("timeZone", "america/new_york"), ("theme", "custom"), ("bins", 15), ("ratio", True),
                                         ("displayUnit", "FORTNIGHT"), ("execute", "alert(1)")])
def test_validation_is_readonly_and_unknown_properties_are_rejected(client, write_headers, field, value):
    definition = {**DEFINITION, field: value}
    before = client.get(BASE).json()["revision"]
    checked = client.post(BASE + "/models/validate", json={"definition": definition})
    assert checked.status_code == 200 and checked.json()["valid"] is False
    assert checked.json()["errors"]
    response = command(client, write_headers, "create", payload={"name": "Invalid", "definition": definition})
    assert response.status_code == 422
    assert client.get(BASE).json()["revision"] == before


def test_model_commit_recovery_does_not_rewrite_record_files(tmp_path, monkeypatch):
    seed = ROOT / "data" / "default-dataset.json"
    repo = JsonRepository(tmp_path / "data", seed).open()
    before = {path.name: path.read_bytes() for path in (repo.root / "records").glob("*.json")}
    generation = repo.metadata()["generation"]
    original_write = repo._write_journal

    def fail_after_commit(journal):
        original_write(journal)
        if journal["state"] == "committed":
            raise OSError("Simulated interruption after model commit marker")

    monkeypatch.setattr(repo, "_write_journal", fail_after_commit)
    with pytest.raises(DomainError) as error:
        repo.mutate_model("create", None, {"name": "Recovered model", "definition": DEFINITION}, generation, None, "model-recover", "principal")
    assert error.value.code == "commit_outcome_unknown"
    repo.close()
    recovered = JsonRepository(tmp_path / "data", seed).open()
    try:
        outcome = recovered.command_outcome("principal", "model-recover")
        assert outcome["model"]["name"] == "Recovered model"
        assert outcome["revision"] == 2
        assert len(recovered.list_models()["items"]) == 4
        assert {path.name: path.read_bytes() for path in (recovered.root / "records").glob("*.json")} == before
        replay = recovered.mutate_model("create", None, {"name": "Recovered model", "definition": DEFINITION}, generation, None, "model-recover", "principal")
        assert replay == outcome
    finally:
        recovered.close()


@pytest.mark.parametrize("zone", ["UTC", "America/New_York", "Europe/Paris", "Asia/Tokyo"])
def test_shared_iana_catalog_accepts_named_supported_zones(client, zone):
    response = client.post(BASE + "/models/validate", json={"definition": {**DEFINITION, "timeZone": zone}})
    assert response.status_code == 200 and response.json() == {"valid": True, "errors": []}


def test_json_integral_numbers_have_the_same_model_semantics(client, write_headers):
    model = created_model(client, write_headers, {**DEFINITION, "rowHeight": 38.0, "fontSize": 14.0, "bins": 64.0})
    model = command(client, write_headers, "publish", model).json()["model"]
    assert command(client, write_headers, "apply", model, {"version": 1.0}).status_code == 200
    assert command(client, write_headers, "apply", model, {"version": "1"}).status_code == 422


def test_concurrent_model_edits_have_one_winner(tmp_path):
    repo = JsonRepository(tmp_path / "data", ROOT / "data" / "default-dataset.json").open()
    generation = repo.metadata()["generation"]

    def edit(index):
        try:
            return repo.mutate_model("update", "light", {"description": str(index)}, generation, f'"{generation}:1"', f"edit-{index}", "principal")
        except DomainError as error:
            return error.code

    try:
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(edit, range(4)))
        assert sum(isinstance(value, dict) for value in results) == 1
        assert results.count("model_revision_conflict") == 3
    finally:
        repo.close()


def test_raw_legacy_checksum_verified_before_normalization_and_export_rehashed(tmp_path, bundle):
    bundle["records"][0]["extensions"].update({"number": 1.0, "small": 1e-7, "large": 1e20 / 1000000, "\U00010000": "astral", "\ue000": "bmp"})
    bundle["manifest"]["contentSha256"] = content_checksum(bundle)
    original_hash = bundle["manifest"]["contentSha256"]
    validate_snapshot(bundle)
    seed = tmp_path / "checked-seed.json"
    atomic_json(seed, bundle)
    repo = JsonRepository(tmp_path / "data", seed).open()
    try:
        exported = repo.snapshot()
        assert "versions" in exported["models"][0]
        assert exported["manifest"]["contentSha256"] != original_hash
        assert exported["manifest"]["contentSha256"] == content_checksum(exported)
        validate_snapshot(exported)
        raw_disk = read_json(repo.root / "workspace.json")
        assert "versions" not in raw_disk["models"][0]
        tampered = copy.deepcopy(bundle)
        tampered["models"][0]["name"] = "Tampered"
        with pytest.raises(DomainError) as error:
            validate_snapshot(tampered)
        assert error.value.code == "checksum_mismatch"
    finally:
        repo.close()
    assert rfc8785.dumps({"1": 1.0, "9": 1e-7, "\U00010000": 2, "\ue000": 3}) == '{"1":1,"9":1e-7,"\U00010000":2,"\ue000":3}'.encode("utf-8")


def test_record_edit_freezes_legacy_published_dates_without_startup_migration(client, app, write_headers):
    before = client.get(BASE + "/models/light").json()["model"]["versions"][0]
    response = client.post(BASE + "/records", json={"title": "Record edit"}, headers=write_headers)
    assert response.status_code == 201
    after = client.get(BASE + "/models/light").json()["model"]["versions"][0]
    assert after == before
    assert "versions" in read_json(app.state.repository.root / "workspace.json")["models"][0]


def test_catalog_capacity_version_capacity_and_missing_pins(bundle):
    value = normalize_metadata(bundle)
    for index in range(97):
        copied = copy.deepcopy(value["models"][0])
        copied["id"] = f"copy-{index}"
        value["models"].append(copied)
    with pytest.raises(DomainError) as error:
        apply_model_command(value, "create", None, {"name": "Too many", "definition": DEFINITION}, None)
    assert error.value.code == "model_capacity" and error.value.status == 413
    value = normalize_metadata(bundle)
    model = value["models"][0]
    version = model["versions"][0]
    model["versions"] = [{**copy.deepcopy(version), "version": index} for index in range(1, 33)]
    model["draft"] = DEFINITION
    with pytest.raises(DomainError) as error:
        apply_model_command(value, "publish", model["id"], {}, model["revision"])
    assert error.value.code == "model_version_capacity" and error.value.status == 413
    value["settings"].pop("modelVersion")
    with pytest.raises(DomainError) as error:
        validate_snapshot(value)
    assert error.value.code == "model_version_unavailable"
