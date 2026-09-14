import copy
import uuid

import pytest

from conftest import BASE, ROOT
from server.app.models.domain import DomainError
from server.app.repositories.json_repository import JsonRepository


def batch(client, headers, operations, key="batch"):
    return client.post(BASE + "/records/batch", headers={**headers, "Idempotency-Key": key}, json={"operations": operations})


def operation(record, kind="update", payload=None):
    return {"type": kind, "recordId": record["id"], "expectedVersion": record["version"], **({"payload": payload} if payload is not None else {})}


def test_batch_one_revision_and_exact_retry_with_stale_versions(client, write_headers, bundle, app):
    first, second = bundle["records"][:2]
    query = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}).json()
    operations = [operation(first, payload={"title": "First batch edit"}), operation(second, "patch", [{"op": "replace", "path": "/title", "value": "Second batch edit"}]),
                  {"type": "create", "payload": {"title": "Batch-created event", "start": "2026-09-12T12:00:00Z"}}]
    response = batch(client, write_headers, operations)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["revision"] == 2 and result["affectedCount"] == 3
    assert [item["index"] for item in result["items"]] == [0, 1, 2]
    assert result["items"][0]["record"]["version"] == first["version"] + 1
    assert batch(client, write_headers, operations).json() == result
    assert client.get(BASE + "/command-results/batch").json() == result
    assert client.get(BASE).json()["revision"] == 2
    assert client.get(BASE + f'/query-sessions/{query["queryId"]}/overview').json()["total"] == 48
    assert len(app.state.repository.records) == 49


@pytest.mark.parametrize("failure", ["stale", "schema", "duplicate", "immutable", "missing"])
def test_batch_failure_changes_no_memory_files_revision_or_outcome(client, write_headers, bundle, app, failure):
    first, second = bundle["records"][:2]
    bad = operation(second, payload={"title": "Invalid second edit"})
    if failure == "stale":
        bad["expectedVersion"] = 999
    if failure == "schema":
        bad["payload"] = {"data": {"status": 42}}
    if failure == "duplicate":
        bad = operation(first, payload={"title": "Duplicate"})
    if failure == "immutable":
        bad["payload"] = {"createdBy": "Forged"}
    if failure == "missing":
        bad["recordId"] = str(uuid.uuid4())
    repository = app.state.repository
    before = {path.relative_to(repository.root): path.read_bytes() for path in repository.root.rglob("*.json")}
    memory = copy.deepcopy(repository.records)
    response = batch(client, write_headers, [operation(first, payload={"title": "Must not commit"}), bad])
    assert response.status_code in (404, 412, 422), response.text
    assert response.json()["errors"][0]["index"] == 1
    assert repository.records == memory
    assert before == {path.relative_to(repository.root): path.read_bytes() for path in repository.root.rglob("*.json")}
    assert client.get(BASE + "/command-results/batch").status_code == 404


def test_explicit_cascade_delete_and_restore_are_final_graph_atomic(client, write_headers, bundle):
    parent = client.post(BASE + "/sessions", headers=write_headers, json={"title": "Parent", "start": "2026-09-12T12:00:00Z"}).json()["record"]
    child = client.post(BASE + "/events", headers={**write_headers, "Idempotency-Key": "child"}, json={"title": "Child", "start": parent["start"], "parentSessionId": parent["id"]}).json()["record"]
    rejected = batch(client, write_headers, [operation(parent, "delete")], "incomplete-cascade")
    assert rejected.status_code == 422 and rejected.json()["code"] == "invalid_parent"
    deleted = batch(client, write_headers, [operation(parent, "delete"), operation(child, "delete")], "cascade")
    assert deleted.status_code == 200, deleted.text
    deleted_items = [item["record"] for item in deleted.json()["items"]]
    assert all(record["deletedAt"] for record in deleted_items)
    restored = batch(client, write_headers, [operation(record, "restore") for record in reversed(deleted_items)], "restore-cascade")
    assert restored.status_code == 200, restored.text
    assert all(item["record"]["deletedAt"] is None for item in restored.json()["items"])
    assert {item["record"]["id"] for item in restored.json()["items"]} == {parent["id"], child["id"]}


def test_batch_bounds_and_cross_generation_outcome(client, write_headers, app):
    assert batch(client, write_headers, []).status_code == 413
    assert batch(client, write_headers, [{"type": "create", "payload": {"title": "x"}}] * 501).status_code == 413
    huge = client.post(BASE + "/records/batch", headers=write_headers, json={"operations": [{"type": "create", "payload": {"title": "x", "extensions": {"large": "x" * (8 * 1024 * 1024)}}}]})
    assert huge.status_code == 413
    success = batch(client, write_headers, [{"type": "create", "payload": {"title": "Retained history"}}])
    assert success.status_code == 200
    app.state.repository.meta["manifest"]["generation"] = str(uuid.uuid4())
    assert client.get(BASE + "/command-results/batch").status_code == 409


def test_batch_authorization_checks_every_item_and_replayed_result(client, write_headers, bundle, app):
    from test_identity_api import create_identity
    visible = bundle["records"][0]
    hidden = next(record for record in bundle["records"] if record["sourceId"] != visible["sourceId"])
    _, _, editor = create_identity(client, [visible["sourceId"]], "editor")
    before = copy.deepcopy(app.state.repository.records)
    response = batch(client, {**write_headers, **editor}, [operation(visible, payload={"title": "No partial result"}), operation(hidden, payload={"title": "Unauthorized"})])
    assert response.status_code == 404
    assert response.json()["errors"][0]["index"] == 1
    assert app.state.repository.records == before
    viewer = create_identity(client, [visible["sourceId"]], "viewer")[2]
    assert batch(client, {**write_headers, **viewer}, [operation(visible, payload={"title": "Forbidden"})]).status_code == 403


@pytest.mark.parametrize("committed", [False, True])
def test_batch_fault_boundary_recovers_all_old_or_all_new_twice(tmp_path, monkeypatch, committed):
    seed = ROOT / "data" / "default-dataset.json"
    root = tmp_path / "data"
    repository = JsonRepository(root, seed).open()
    records = list(repository.records.values())[:3]
    before = copy.deepcopy(repository.records)
    generation = repository.meta["manifest"]["generation"]
    operations = [operation(record, payload={"title": f"Committed {index}"}) for index, record in enumerate(records)]
    original = repository._write_journal if committed else repository._install

    def failure(*args):
        result = original(*args)
        if not committed or args[0]["state"] == "committed":
            raise OSError("Injected process boundary")
        return result

    monkeypatch.setattr(repository, "_write_journal" if committed else "_install", failure)
    with pytest.raises(DomainError, match="outcome"):
        repository.mutate_batch({"operations": operations}, generation, "fault-batch", "principal", request_route="batch", authorize_record=lambda *_: None)
    repository.close()
    for _ in range(2):
        recovered = JsonRepository(root, seed).open()
        try:
            for index, record in enumerate(records):
                assert recovered.records[record["id"]]["title"] == (f"Committed {index}" if committed else before[record["id"]]["title"])
            assert recovered.meta["manifest"]["revision"] == (2 if committed else 1)
            if committed:
                assert recovered.command_outcome("principal", "fault-batch")["affectedCount"] == 3
            else:
                with pytest.raises(DomainError, match="No committed outcome"):
                    recovered.command_outcome("principal", "fault-batch")
        finally:
            recovered.close()
