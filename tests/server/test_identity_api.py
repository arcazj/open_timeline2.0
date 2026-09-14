import copy
import uuid

import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from test_api import prepared
from server.app.main import create_app
from server.app.models.domain import DomainError, validate_json, parse_json


def create_identity(client, sources=None, role="viewer", workspace="default"):
    root = client.get("/api/v1/principals")
    headers = {"X-Identity-Generation": root.json()["generation"], "If-Match": root.headers["etag"], "Idempotency-Key": uuid.uuid4().hex}
    response = client.post("/api/v1/principals", json={"name": role, "role": role,
        "grants": [{"workspaceId": workspace, "sourceIds": sources, "capabilities": []}]}, headers=headers)
    assert response.status_code == 201, response.text
    principal = response.json()["principal"]
    root = client.get("/api/v1/tokens")
    response = client.post("/api/v1/tokens", json={"principalId": principal["id"], "name": "Session", "expiresAt": None},
        headers={"X-Identity-Generation": root.json()["generation"], "If-Match": root.headers["etag"], "Idempotency-Key": uuid.uuid4().hex})
    assert response.status_code == 201, response.text
    return principal, response.json(), {"Authorization": "Bearer " + response.json()["secret"]}


@pytest.mark.parametrize("asynchronous", [False, True])
def test_viewer_metadata_and_every_query_surface_is_source_scoped(client, bundle, asynchronous):
    source = bundle["records"][0]["sourceId"]
    allowed = {record["id"] for record in bundle["records"] if record["sourceId"] == source and not record["deletedAt"]}
    _, _, headers = create_identity(client, [source])
    metadata = client.get(BASE, headers=headers).json()
    assert metadata["recordCount"] == len(allowed)
    assert metadata["sourceIds"] == [source]
    assert metadata["capabilities"]["write"] is False
    assert metadata["capabilities"]["modelManagement"] is False
    assert metadata["actor"]["role"] == "viewer"
    response = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]},
        headers={**headers, **({"Prefer": "respond-async"} if asynchronous else {})})
    if asynchronous:
        assert response.status_code == 202, response.text
    query = prepared(client, response, headers=headers).json()
    assert query["baseTotal"] == len(allowed)
    url = BASE + "/query-sessions/" + query["queryId"]
    overview = client.get(url + "/overview", headers=headers).json()
    assert {item["id"] for item in overview["items"]} == allowed
    assert client.get(BASE + "/records", headers=headers).json()["total"] == len(allowed)
    for record in bundle["records"]:
        response = client.get(BASE + "/records/" + record["id"], headers=headers)
        assert response.status_code == (200 if record["id"] in allowed else 404)
    foreign = {"Authorization": "Bearer " + TOKEN}
    for suffix in ("", "/density", "/overview", "/zones", "/maps/" + query["mapId"]):
        assert client.get(url + suffix, headers=foreign).status_code == 404
    assert client.delete(url, headers=foreign).status_code == 404
    assert client.get(url, headers=headers).status_code == 200


def test_query_permission_change_invalidates_old_snapshot(client, bundle):
    principal, _, headers = create_identity(client)
    query = prepared(client, client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}, headers=headers), headers=headers).json()
    current = client.get("/api/v1/principals/" + principal["id"])
    update = client.patch("/api/v1/principals/" + principal["id"], json={"grants": [{"workspaceId": "default", "sourceIds": [], "capabilities": []}]},
        headers={"X-Identity-Generation": current.json()["generation"], "If-Match": current.headers["etag"], "Idempotency-Key": uuid.uuid4().hex})
    assert update.status_code == 200, update.text
    assert client.get(BASE + "/query-sessions/" + query["queryId"] + "/overview", headers=headers).status_code == 409
    assert client.get(BASE, headers=headers).json()["recordCount"] == 0
    fresh = prepared(client, client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}, headers=headers), headers=headers).json()
    assert fresh["baseTotal"] == fresh["matchTotal"] == 0


def test_permission_revoked_during_preparation_discards_result(client, app, bundle, monkeypatch):
    principal, _, headers = create_identity(client)
    original = app.state.queries.create_query

    def revoke_after_prepare(payload):
        result = original(payload)
        identities = app.state.identities
        admin = identities.authenticate(TOKEN)
        identities.update_principal(admin, principal["id"], {"enabled": False}, identities.state["generation"], 1, uuid.uuid4().hex)
        return result

    monkeypatch.setattr(app.state.queries, "create_query", revoke_after_prepare)
    response = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}, headers=headers)
    assert response.status_code == 401
    assert not app.state.queries.queries


def test_viewer_writes_denied_and_editor_cannot_move_to_hidden_source(client, bundle, write_headers):
    _, _, viewer = create_identity(client)
    assert client.post(BASE + "/records", json={"title": "Denied"}, headers={**write_headers, **viewer}).status_code == 403
    assert client.post(BASE + "/models", json={}, headers={**write_headers, **viewer}).status_code == 403
    source = bundle["records"][0]["sourceId"]
    principal, _, editor = create_identity(client, [source], "editor")
    payload = {"kind": "event", "title": "Scoped", "start": "2026-09-12T12:00:00.000Z", "sourceId": source}
    response = client.post(BASE + "/records", json=payload, headers={**write_headers, **editor})
    assert response.status_code == 201, response.text
    record = response.json()["record"]
    assert record["createdBy"] == principal["id"]
    hidden = next(record["sourceId"] for record in bundle["records"] if record["sourceId"] != source)
    response = client.patch(BASE + "/records/" + record["id"], json=[{"op": "replace", "path": "/sourceId", "value": hidden}],
        headers={**write_headers, **editor, "If-Match": response.headers["etag"], "Idempotency-Key": "move-hidden", "Content-Type": "application/json-patch+json"})
    assert response.status_code == 404
    assert client.get(BASE + "/records/" + record["id"]).json()["sourceId"] == source
    assert client.get(BASE + "/command-results/test-command", headers=editor).status_code == 200
    assert client.get(BASE + "/command-results/test-command").status_code == 404


def test_wrong_workspace_cannot_read_data_or_counts(client, bundle):
    _, _, headers = create_identity(client, workspace="other")
    for suffix in ("", "/status", "/records", "/models", "/snapshot"):
        assert client.get(BASE + suffix, headers=headers).status_code == 403
    assert client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}, headers=headers).status_code == 403


def test_token_secret_appears_once_and_revocation_immediately_blocks_reads(client, bundle):
    principal, created, headers = create_identity(client)
    assert "secretHash" not in str(created)
    tokens = client.get("/api/v1/tokens", headers=headers).json()
    assert len(tokens["items"]) == 1
    assert created["secret"] not in str(tokens)
    assert "secretHash" not in str(tokens)
    assert client.get("/api/v1/principals", headers=headers).status_code == 403
    assert client.get("/api/v1/principals/me", headers=headers).json()["principal"]["id"] == principal["id"]
    response = client.delete("/api/v1/tokens/" + created["token"]["id"], headers={**headers,
        "X-Identity-Generation": tokens["generation"], "If-Match": f'"{tokens["generation"]}:1"', "Idempotency-Key": uuid.uuid4().hex})
    assert response.status_code == 200, response.text
    assert client.get(BASE, headers=headers).status_code == 401
    assert client.get("/api/v1/tokens", headers=headers).status_code == 401


def test_identity_persists_across_server_restart_and_changed_env_is_not_admin(tmp_path):
    root = tmp_path / "data"
    with TestClient(create_app(root, TOKEN), headers={"Authorization": "Bearer " + TOKEN}) as client:
        principal, _, headers = create_identity(client)
    with TestClient(create_app(root, "new-untrusted-env-secret"), headers=headers) as client:
        assert client.get(BASE).json()["actor"]["id"] == principal["id"]
        assert client.get(BASE, headers={"Authorization": "Bearer new-untrusted-env-secret"}).status_code == 401


def test_identity_preconditions_and_problem_details(client):
    payload = {"name": "Test", "role": "viewer", "grants": [{"workspaceId": "default", "sourceIds": [], "capabilities": []}]}
    before = client.get("/api/v1/principals").json()
    response = client.post("/api/v1/principals", json=payload)
    assert response.status_code == 428
    problem = response.json()
    assert problem["status"] == 428 and problem["title"] and problem["detail"]
    assert problem["requestId"] == response.headers["x-request-id"]
    response = client.post("/api/v1/principals", json=payload, headers={"X-Identity-Generation": before["generation"], "If-Match": f'"{before["generation"]}:99"', "Idempotency-Key": uuid.uuid4().hex})
    assert response.status_code == 412
    assert client.get("/api/v1/principals").json() == before


def test_json_nesting_boundary_is_64():
    value = 1
    for _ in range(64):
        value = [value]
    validate_json(value)
    with pytest.raises(DomainError, match="64 levels"):
        validate_json([value])


@pytest.mark.parametrize("encoding", ["utf-16", "utf-32", "utf-8-sig"])
def test_json_bytes_require_utf8_without_bom(encoding):
    with pytest.raises(DomainError) as error:
        parse_json('{"title":"test"}'.encode(encoding))
    assert error.value.code == "invalid_json"


@pytest.mark.parametrize("mutation", [lambda value: value.update(formatVersion=True),
    lambda value: value["tokens"][0].update(principalId=[]),
    lambda value: value["audit"][0].update(action=[])])
def test_corrupt_identity_shapes_fail_as_domain_errors(client, app, mutation):
    create_identity(client)
    state = copy.deepcopy(app.state.identities.state)
    mutation(state)
    with pytest.raises(DomainError):
        app.state.identities._validate(state)
