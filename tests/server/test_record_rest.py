import copy
import uuid

import pytest

from conftest import BASE
from server.app.models.domain import DomainError, MUTABLE_FIELDS
from server.app.models.record_commands import patch_record


def create(client, headers, collection="events", **fields):
    response = client.post(f"{BASE}/{collection}", headers=headers, json={"title": "API event", "start": "2026-09-12T12:00:00Z", **fields})
    assert response.status_code == 201, response.text
    assert response.headers["location"] == f'{BASE}/{collection}/{response.json()["record"]["id"]}'
    return response


def patch_headers(headers, response, key=None):
    return {**headers, "If-Match": response.headers["etag"], "Idempotency-Key": key or str(uuid.uuid4()),
            "Content-Type": "application/json-patch+json"}


def test_typed_routes_and_complete_replacement(client, write_headers):
    event = create(client, write_headers)
    record = event.json()["record"]
    path = event.headers["location"]
    assert record["kind"] == "event"
    assert client.get(f'{BASE}/sessions/{record["id"]}').status_code == 404
    headers = {**write_headers, "If-Match": event.headers["etag"], "Idempotency-Key": "replace"}
    assert client.put(path, json={"title": "Incomplete"}, headers=headers).json()["code"] == "incomplete_replacement"
    payload = {key: record[key] for key in MUTABLE_FIELDS}
    payload.update(title="Complete replacement", tags=["verified"], originalStart=None, originalEnd=None)
    replaced = client.put(path, json=payload, headers=headers)
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["record"]["tags"] == ["verified"]
    assert client.put(path, json=payload, headers=headers).json() == replaced.json()
    assert client.put(f'{BASE}/records/{record["id"]}', json=payload, headers=headers).status_code == 409
    deleted = client.delete(path, headers={**headers, "If-Match": replaced.headers["etag"], "Idempotency-Key": "delete"})
    assert deleted.status_code == 204 and deleted.content == b""
    assert client.delete(path, headers={**headers, "If-Match": replaced.headers["etag"], "Idempotency-Key": "delete"}).status_code == 204
    assert client.get(BASE + "/command-results/delete").json()["record"]["version"] == 3
    assert client.get(path).status_code == 404
    assert client.get(path + "?includeDeleted=true").json()["deletedAt"] is not None
    session = create(client, {**write_headers, "Idempotency-Key": "session"}, "sessions")
    assert session.json()["record"]["kind"] == "session"
    assert all(item["kind"] == "event" for item in client.get(BASE + "/events").json()["items"])
    assert all(item["kind"] == "session" for item in client.get(BASE + "/sessions").json()["items"])


def test_patch_array_operations_null_test_atomicity_and_replay(client, write_headers):
    created = create(client, write_headers, tags=["a", "b"], extensions={"flag": True, "a/b": "escaped"})
    path = created.headers["location"]
    operations = [{"op": "test", "path": "/extensions/flag", "value": True},
                  {"op": "add", "path": "/tags/-", "value": "c"},
                  {"op": "move", "from": "/tags/0", "path": "/tags/2"},
                  {"op": "copy", "from": "/extensions/a~1b", "path": "/extensions/copy"},
                  {"op": "remove", "path": "/extensions/flag"},
                  {"op": "replace", "path": "/originalStart", "value": None}]
    headers = patch_headers(write_headers, created, "patch")
    response = client.patch(path, json=operations, headers=headers)
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    assert record["tags"] == ["b", "c", "a"]
    assert record["extensions"] == {"a/b": "escaped", "copy": "escaped"}
    assert client.patch(path, json=operations, headers=headers).json() == response.json()
    bad = [{"op": "replace", "path": "/title", "value": "Must roll back"}, {"op": "test", "path": "/tags/0", "value": "wrong"}]
    failed = client.patch(path, json=bad, headers=patch_headers(write_headers, response))
    assert failed.status_code == 409 and failed.json()["code"] == "patch_test_failed"
    assert client.get(path).json() == record
    assert client.patch(path, json=operations, headers=write_headers).status_code == 415


@pytest.mark.parametrize("operations,code", [
    ([{"op": "replace", "path": "/id", "value": "changed"}], "immutable_field"),
    ([{"op": "add", "path": "/extensions/__proto__/bad", "value": True}], "immutable_field"),
    ([{"op": "remove", "path": "/originalStart"}], "incomplete_replacement"),
    ([{"op": "replace", "path": "/extensions/missing", "value": True}], "invalid_patch"),
    ([{"op": "test", "path": "/extensions/flag", "value": 1}], "patch_test_failed"),
    ([{"op": "copy", "from": "/createdBy", "path": "/title"}], "immutable_field"),
    ([{"op": "test", "path": "/title~2", "value": "bad"}], "invalid_patch"),
    ([], "invalid_patch"),
])
def test_patch_policy_is_atomic(bundle, operations, code):
    record = copy.deepcopy(bundle["records"][0])
    record["extensions"] = {"flag": True}
    before = copy.deepcopy(record)
    with pytest.raises(DomainError) as caught:
        patch_record(record, operations)
    assert caught.value.code == code
    assert record == before


def test_json_patch_does_not_change_kind(client, write_headers):
    created = create(client, write_headers)
    response = client.patch(created.headers["location"], json=[{"op": "replace", "path": "/kind", "value": "session"}],
                            headers=patch_headers(write_headers, created))
    assert response.status_code == 422
    assert client.get(created.headers["location"]).json()["version"] == 1


def test_health_capabilities_and_parameter_problems_are_sanitized(client, app):
    assert client.get("/health/live").json() == {"status": "live"}
    assert client.get("/health/ready").status_code == 200
    capabilities = client.get("/api/v1/capabilities").json()
    assert capabilities["limits"]["batchRecords"] == 500
    assert capabilities["limits"]["batchRequestBytes"] == 8 * 1024 * 1024
    assert capabilities["modes"] == ["server", "standalone"]
    assert "token" not in str(capabilities).lower()
    response = client.get(BASE + "/events", params={"limit": "sensitive-invalid-parameter"})
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["requestId"] == response.headers["x-request-id"]
    assert "sensitive-invalid-parameter" not in response.text
    app.state.repository.available = False
    assert client.get("/health/live").status_code == 200
    assert client.get("/health/ready").status_code == 503
    assert client.get("/api/v1/capabilities").json()["readOnly"] is True


def test_structured_query_and_snapshot_release_use_their_actual_identities(client, bundle):
    response = client.post(BASE + "/records/query", json={"domain": bundle["settings"]["overview"]})
    assert response.status_code == 200
    manifest = response.json()
    assert manifest["snapshotId"] != manifest["queryId"]
    assert client.delete(BASE + "/query-snapshots/" + manifest["snapshotId"]).status_code == 204
    assert client.get(BASE + "/query-sessions/" + manifest["queryId"]).status_code == 404
