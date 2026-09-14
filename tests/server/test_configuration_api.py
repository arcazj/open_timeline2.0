import copy
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app.main import create_app
from server.app.models.configuration_catalog import default_configuration_definition
from server.app.models.domain import DomainError, content_checksum, read_json
from server.app.services.configuration import ConfigurationService

ROOT = Path(__file__).resolve().parents[2]
BASE = "/api/v1/workspaces/default"
TOKEN = "test-token-keep-private"


@pytest.fixture
def catalog(tmp_path):
    app = create_app(tmp_path / "workspace", TOKEN, ROOT / "shared/fixtures/initial-snapshot.json")
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        yield client, app.state.configuration, app.state.identities, app.state.repository


def member(catalog, name="Alice", sources=None, capabilities=None):
    _, _, identities, _ = catalog
    admin = identities.authenticate(TOKEN)
    principal = identities.create_principal(admin, {"name": name, "role": "viewer", "grants": [{"workspaceId": "default", "sourceIds": sources, "capabilities": capabilities or []}]}, identities.state["generation"], identities.state["revision"], str(uuid.uuid4()))
    token = identities.create_token(admin, {"principalId": principal["id"], "name": "Test", "expiresAt": None}, identities.state["generation"], identities.state["revision"], str(uuid.uuid4()))
    return principal, token


def request_command(catalog, family, operation, payload=None, resource=None, secret=TOKEN, key=None, preference_revision=None):
    client, _, _, repository = catalog
    generation = repository.meta["manifest"]["generation"]
    value = {"family": family, "type": operation, "generation": generation, "clientCommandId": key or str(uuid.uuid4()), "payload": {} if payload is None else payload}
    if resource is not None:
        value.update(resourceId=resource["id"], expectedRevision=resource["revision"])
    if preference_revision is not None:
        value["expectedPreferenceRevision"] = preference_revision
    headers = {"Authorization": "Bearer " + secret, "X-Workspace-Generation": generation, "Idempotency-Key": value["clientCommandId"]}
    if resource is not None:
        headers["If-Match"] = f'"{generation}:{resource["revision"]}"'
    return client.post(BASE + "/configuration/commands", json=value, headers=headers), value, headers


def create(catalog, family, definition=None, visibility="workspace", secret=TOKEN, name="Resource"):
    if definition is None:
        definition = default_configuration_definition(family, catalog[1]._snapshot({"id": "admin", "capabilities": ["*"]}))
    response, _, _ = request_command(catalog, family, "create", {"name": name, "definition": definition, "visibility": visibility}, secret=secret)
    assert response.status_code == 200, response.text
    resource = response.json()["resource"]
    if not resource["versions"]:
        response, _, _ = request_command(catalog, family, "publish", resource=resource, secret=secret)
        assert response.status_code == 200, response.text
        resource = response.json()["resource"]
    return resource


def test_catalog_routes_do_not_intercept_records_and_lists_never_contain_definitions(catalog):
    client, _, _, _ = catalog
    resource = create(catalog, "filters")
    records = client.get(BASE + "/records")
    assert records.status_code == 200 and len(records.json()["items"]) == 48
    items = client.get(BASE + "/filters").json()["items"]
    assert items[0]["id"] == resource["id"]
    assert "draft" not in items[0] and "versions" not in items[0]
    assert items[0]["publishedVersions"] == [1]
    response = client.get(BASE + "/configuration/resource", params={"family": "filters", "id": resource["id"]})
    assert response.json()["resource"] == resource
    assert response.headers["etag"].endswith(':2"')
    assert client.get(BASE + f'/filters/{resource["id"]}/versions/1').json()["publication"]["definition"] == resource["versions"][0]["definition"]


def test_private_resources_and_outcomes_are_actor_scoped(catalog):
    client, service, identities, _ = catalog
    alice, alice_token = member(catalog)
    _, bob_token = member(catalog, "Bob")
    resource = create(catalog, "filters", visibility="personal", secret=alice_token["secret"])
    bob_headers = {"Authorization": "Bearer " + bob_token["secret"]}
    assert client.get(BASE + "/filters", headers=bob_headers).json()["items"] == []
    assert client.get(BASE + "/configuration/resource", params={"family": "filters", "id": resource["id"]}, headers=bob_headers).status_code == 404
    response, command, _ = request_command(catalog, "filters", "update", {"name": "Alice only"}, resource, alice_token["secret"], key="same-key")
    assert response.status_code == 200
    alice_identity = identities.authenticate(alice_token["secret"])
    assert service.outcome(alice_identity, command["clientCommandId"])["resource"]["ownerId"] == alice["id"]
    with pytest.raises(DomainError) as error:
        service.outcome(identities.authenticate(bob_token["secret"]), command["clientCommandId"])
    assert error.value.code == "command_not_found"
    shared = create(catalog, "schemas")
    rejected, _, _ = request_command(catalog, "schemas", "update", {"name": "not allowed"}, shared, alice_token["secret"])
    assert rejected.status_code == 403


def test_header_preconditions_and_idempotent_replay_are_atomic(catalog):
    client, service, identities, repository = catalog
    resource = create(catalog, "groups")
    response, command, headers = request_command(catalog, "groups", "update", {"name": "Once"}, resource, key="durable-key")
    assert response.status_code == 200
    committed = response.json()
    revision = repository.meta["manifest"]["revision"]
    assert client.post(BASE + "/configuration/commands", json=command, headers=headers).json() == committed
    assert repository.meta["manifest"]["revision"] == revision
    changed = copy.deepcopy(command)
    changed["payload"]["name"] = "Twice"
    assert client.post(BASE + "/configuration/commands", json=changed, headers=headers).status_code == 409
    assert service.outcome(identities.authenticate(TOKEN), "durable-key") == committed
    for header in ("If-Match", "X-Workspace-Generation", "Idempotency-Key"):
        missing = {key: value for key, value in headers.items() if key != header}
        assert client.post(BASE + "/configuration/commands", json=command, headers=missing).status_code == 428
    mismatch = {**headers, "Idempotency-Key": "different"}
    assert client.post(BASE + "/configuration/commands", json=command, headers=mismatch).status_code == 400


def test_private_usage_descriptors_and_counts_are_not_disclosed(catalog):
    client, _, _, _ = catalog
    _, alice_token = member(catalog)
    _, bob_token = member(catalog, "Bob")
    schema = create(catalog, "schemas")
    definition = default_configuration_definition("filters")
    definition["schemaRefs"] = [{"id": schema["id"], "version": 1}]
    create(catalog, "filters", definition, "personal", alice_token["secret"])
    response = client.get(BASE + "/configuration/usage", params={"family": "schemas", "id": schema["id"]}, headers={"Authorization": "Bearer " + bob_token["secret"]})
    assert response.status_code == 200
    assert response.json()["items"] == [] and response.json()["total"] == 0
    assert response.json()["deletionBlocked"] is True
    deleted, _, _ = request_command(catalog, "schemas", "delete", resource=schema)
    assert deleted.status_code == 409 and deleted.json()["code"] == "configuration_referenced"


def test_source_scope_restricts_catalog_references_and_export(catalog):
    client, service, identities, repository = catalog
    sources = repository.meta["manifest"]["scope"]["sourceIds"]
    _, scoped_token = member(catalog, sources=[sources[0]])
    definition = default_configuration_definition("filters")
    definition["sourceIds"] = [sources[1]]
    hidden = create(catalog, "filters", definition)
    headers = {"Authorization": "Bearer " + scoped_token["secret"]}
    assert [item["id"] for item in client.get(BASE + "/sources", headers=headers).json()["items"]] == [sources[0]]
    assert client.get(BASE + "/configuration/resource", params={"family": "filters", "id": hidden["id"]}, headers=headers).status_code == 404
    assert client.post(BASE + "/filters/validate", json={"definition": definition}, headers=headers).json()["valid"] is False
    bundle = service.export_snapshot(identities.authenticate(scoped_token["secret"]))
    assert bundle["manifest"]["scope"]["sourceIds"] == [sources[0]]
    assert all(record["sourceId"] == sources[0] for record in bundle["records"])
    assert bundle["manifest"]["contentSha256"] == content_checksum(bundle)
    assert hidden["id"] not in {item["id"] for item in bundle["filters"]}


def test_export_contains_only_own_private_catalogs_and_preferences(catalog):
    client, service, identities, _ = catalog
    alice, alice_token = member(catalog)
    _, bob_token = member(catalog, "Bob")
    own = create(catalog, "views", visibility="personal", secret=alice_token["secret"], name="Alice private")
    other = create(catalog, "views", visibility="personal", secret=bob_token["secret"], name="Bob private")
    response, _, _ = request_command(catalog, "views", "apply", {"version": 1}, own, alice_token["secret"], preference_revision=0)
    assert response.status_code == 200
    bundle = service.export_snapshot(identities.authenticate(alice_token["secret"]))
    assert {item["id"] for item in bundle["views"]} == {own["id"]}
    assert other["id"] not in str(bundle)
    assert [item["principalId"] for item in bundle["preferences"]] == [alice["id"]]
    effective = client.get(BASE + "/settings/effective", headers={"Authorization": "Bearer " + alice_token["secret"]}).json()
    assert effective["values"]["viewId"] == own["id"]
    assert effective["origins"]["/viewId"] == "personal:" + alice["id"]


def test_view_apply_checks_both_resource_and_preference_revisions(catalog):
    _, _, _, repository = catalog
    view = create(catalog, "views")
    shared_settings = copy.deepcopy(repository.meta["settings"])
    response, _, _ = request_command(catalog, "views", "apply", {"version": 1}, view, preference_revision=0)
    assert response.status_code == 200
    assert response.json()["resource"]["revision"] == view["revision"]
    assert response.json()["effectiveSettings"]["preferenceRevision"] == 1
    assert repository.meta["settings"] == shared_settings
    stale, _, _ = request_command(catalog, "views", "apply", {"version": 1}, view, preference_revision=0)
    assert stale.status_code == 412
    missing, _, _ = request_command(catalog, "views", "apply", {"version": 1}, view)
    assert missing.status_code == 428


def test_restart_retains_catalog_history_and_original_outcome(catalog):
    _, service, identities, repository = catalog
    resource = create(catalog, "filters")
    response, command, _ = request_command(catalog, "filters", "update", {"name": "After restart"}, resource)
    assert response.status_code == 200
    repository.close()
    repository.open()
    restarted = ConfigurationService(identities, repository)
    identity = identities.authenticate(TOKEN)
    assert restarted.get_resource(identity, "filters", resource["id"])["resource"]["name"] == "After restart"
    assert restarted.outcome(identity, command["clientCommandId"]) == response.json()
    assert restarted.export_snapshot(identity)["manifest"]["contentSha256"]


def test_prepared_failure_rolls_back_both_metadata_and_outcome_on_restart(catalog, monkeypatch):
    client, service, identities, repository = catalog
    resource = create(catalog, "groups")
    original = copy.deepcopy(repository.meta)
    install = repository._install

    def fail_outcome(relative, value):
        if relative.startswith("outcomes/"):
            raise OSError("injected outcome install failure")
        install(relative, value)

    monkeypatch.setattr(repository, "_install", fail_outcome)
    response, command, headers = request_command(catalog, "groups", "update", {"name": "Uncommitted"}, resource)
    assert response.status_code == 503 and response.json()["code"] == "commit_outcome_unknown"
    assert repository.available is False
    monkeypatch.setattr(repository, "_install", install)
    repository.close()
    repository.open()
    assert repository.meta == original
    with pytest.raises(DomainError) as error:
        service.outcome(identities.authenticate(TOKEN), command["clientCommandId"])
    assert error.value.code == "command_not_found"
    replay = client.post(BASE + "/configuration/commands", json=command, headers=headers)
    assert replay.status_code == 200
    assert replay.json()["resource"]["name"] == "Uncommitted"


def test_identity_revoked_after_initial_auth_cannot_commit(catalog, monkeypatch):
    _, service, identities, repository = catalog
    _, token = member(catalog)
    identity = identities.authenticate(token["secret"])
    captured = identities.authenticate(TOKEN)
    definition = default_configuration_definition("filters")
    command = {"family": "filters", "type": "create", "generation": repository.meta["manifest"]["generation"], "clientCommandId": "revoked-intent", "payload": {"name": "No commit", "visibility": "personal", "definition": definition}}
    original_snapshot = service._snapshot

    def revoke_before_prepare(actor):
        snapshot = original_snapshot(actor)
        identities.revoke_token(captured, token["token"]["id"], identities.state["generation"], token["token"]["revision"], str(uuid.uuid4()))
        return snapshot

    monkeypatch.setattr(service, "_snapshot", revoke_before_prepare)
    before = copy.deepcopy(repository.meta)
    with pytest.raises(DomainError) as error:
        service.mutate(identity, command, command["generation"], command["clientCommandId"])
    assert error.value.status == 401
    assert repository.meta == before
    assert not repository._outcome_path(identity["id"], command["clientCommandId"]).exists()


def test_settings_patch_reset_permissions_and_replay(catalog):
    client, service, identities, repository = catalog
    alice, token = member(catalog)
    generation = repository.meta["manifest"]["generation"]
    value = {"scope": "personal", "type": "patch", "expectedRevision": 0, "generation": generation, "clientCommandId": "settings-once", "payload": {"rowHeight": 52, "search": {"text": "needle", "mode": "all"}}}
    headers = {"Authorization": "Bearer " + token["secret"], "X-Workspace-Generation": generation, "Idempotency-Key": value["clientCommandId"], "If-Match": f'"{generation}:0"'}
    response = client.post(BASE + "/settings/commands", json=value, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["effectiveSettings"]["values"]["rowHeight"] == 52
    assert client.post(BASE + "/settings/commands", json=value, headers=headers).json() == response.json()
    assert service.outcome(identities.authenticate(token["secret"]), value["clientCommandId"]) == response.json()
    reset = {**value, "type": "reset", "expectedRevision": 1, "clientCommandId": "settings-reset", "payload": {"paths": ["/rowHeight", "/search/text"]}}
    reset_headers = {**headers, "Idempotency-Key": reset["clientCommandId"], "If-Match": f'"{generation}:1"'}
    result = client.post(BASE + "/settings/commands", json=reset, headers=reset_headers)
    assert result.status_code == 200, result.text
    assert result.json()["settings"]["values"] == {"search": {"mode": "all"}}
    assert result.json()["settings"]["principalId"] == alice["id"]
    forbidden = {**value, "scope": "workspace", "expectedRevision": 1, "clientCommandId": "forbidden-defaults"}
    assert client.post(BASE + "/settings/commands", json=forbidden, headers={**headers, "Idempotency-Key": forbidden["clientCommandId"], "If-Match": f'"{generation}:1"'}).status_code == 403


def test_usage_cursor_is_scope_bound_and_deleted_source_outcome_is_readable(catalog):
    client, service, identities, repository = catalog
    first = client.get(BASE + "/configuration/usage", params={"family": "sources", "id": repository.meta["manifest"]["scope"]["sourceIds"][0], "limit": 1}).json()
    assert first["nextCursor"] and len(first["items"]) == 1
    params = {"family": "sources", "id": repository.meta["manifest"]["scope"]["sourceIds"][0], "limit": 1, "cursor": first["nextCursor"]}
    next_page = client.get(BASE + "/configuration/usage", params=params)
    assert next_page.status_code == 200
    assert next_page.json()["items"] != first["items"]
    _, token = member(catalog)
    assert client.get(BASE + "/configuration/usage", params=params, headers={"Authorization": "Bearer " + token["secret"]}).status_code == 409
    source = create(catalog, "sources")
    response, command, _ = request_command(catalog, "sources", "delete", resource=source)
    assert response.status_code == 200 and response.json()["resource"] is None
    assert service.outcome(identities.authenticate(TOKEN), command["clientCommandId"]) == response.json()
    outcome = read_json(repository._outcome_path(identities.authenticate(TOKEN)["id"], command["clientCommandId"]))
    assert "authorization" in outcome and outcome["authorization"]["sourceIds"] == [source["id"]]


def test_schema_impact_is_complete_pinned_paginated_and_read_only(catalog):
    client, _, identities, repository = catalog
    definition = default_configuration_definition("schemas")
    definition["schema"]["properties"]["score"] = {"type": "number"}
    schema = create(catalog, "schemas", definition)
    generation = repository.meta["manifest"]["generation"]
    actor = identities.authenticate(TOKEN)
    records = [record for record in repository.records.values() if record["sourceId"] == "operations"][:3]
    for index, record in enumerate(records):
        repository.mutate("update", record["id"], {"schemaId": schema["id"], "schemaVersion": 1, "data": {**record["data"], "score": index + 1}}, generation, f'"{generation}:{record["version"]}"', f"pin-record-{index}", actor["id"])
    candidate = copy.deepcopy(definition)
    candidate["schema"]["properties"]["score"]["minimum"] = 2
    candidate["schema"]["required"] = ["score"]
    before = copy.deepcopy(repository.meta)
    payload = {"definition": candidate, "limit": 1}
    response = client.post(BASE + f'/schemas/{schema["id"]}/impact', json=payload)
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["totalAffected"] == 3 and page["totalInvalid"] == 1
    assert repository.meta == before
    revision, ids = page["revision"], [page["items"][0]["id"]]
    create(catalog, "groups")
    while page["nextCursor"]:
        page = client.post(BASE + f'/schemas/{schema["id"]}/impact', json={**payload, "cursor": page["nextCursor"]}).json()
        assert page["revision"] == revision
        ids.extend(item["id"] for item in page["items"])
    assert set(ids) == {record["id"] for record in records} and len(ids) == 3
    _, scoped = member(catalog, sources=["verification"])
    hidden = client.post(BASE + f'/schemas/{schema["id"]}/impact', json=payload, headers={"Authorization": "Bearer " + scoped["secret"]}).json()
    assert hidden["totalAffected"] == 0 and hidden["items"] == []


def test_integral_json_revision_has_canonical_etag_spelling(catalog):
    client, _, _, repository = catalog
    resource = create(catalog, "groups")
    generation = repository.meta["manifest"]["generation"]
    command = {"family": "groups", "type": "update", "resourceId": resource["id"], "expectedRevision": float(resource["revision"]), "generation": generation, "clientCommandId": "integral-revision", "payload": {"name": "Canonical"}}
    headers = {"X-Workspace-Generation": generation, "Idempotency-Key": command["clientCommandId"], "If-Match": f'"{generation}:{resource["revision"]}"'}
    response = client.post(BASE + "/configuration/commands", json=command, headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["etag"] == f'"{generation}:{resource["revision"] + 1}"'
