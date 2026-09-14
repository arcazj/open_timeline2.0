import copy
import uuid

import pytest

from conftest import BASE, ROOT
from server.app.models.domain import DomainError, read_json
from server.app.repositories.audit_history import audit_hash, audit_path, prepare_restore_audit, validate_audit_history
from server.app.repositories.json_repository import JsonRepository, atomic_json


def create(client, headers, source="operations", key=None):
    response = client.post(BASE + "/records", headers={**headers, "Idempotency-Key": key or str(uuid.uuid4())},
                           json={"title": "Private payload must not be in audit", "sourceId": source})
    assert response.status_code == 201, response.text
    return response.json()


def test_audit_is_one_metadata_entry_per_commit_and_cursors_pin_revision(client, write_headers, app):
    assert client.get(BASE + "/audit").json() == {"items": [], "nextCursor": None,
        "coverage": {"firstRevision": None, "throughRevision": 1, "legacyHistoryBefore": 2}}
    for index in range(3):
        create(client, write_headers, key=f"audit-{index}")
    create(client, write_headers, key="audit-0")
    page = client.get(BASE + "/audit", params={"limit": 2}).json()
    assert [entry["revision"] for entry in page["items"]] == [2, 3]
    assert page["nextCursor"] and "total" not in page
    assert "Private payload" not in str(page)
    create(client, write_headers, key="after-page")
    tail = client.get(BASE + "/audit", params={"limit": 2, "cursor": page["nextCursor"]}).json()
    assert [entry["revision"] for entry in tail["items"]] == [4]
    assert tail["coverage"]["throughRevision"] == 4
    assert tail["nextCursor"] is None
    assert client.get(BASE + "/audit", params={"cursor": "tampered"}).status_code == 400
    validate_audit_history(app.state.repository.audit_state, app.state.repository.audit_entries, app.state.repository.meta["manifest"])


def test_audit_permissions_hide_other_sources_and_foreign_cursors(client, write_headers, app):
    from test_identity_api import create_identity
    principal, _, reader = create_identity(client, ["operations"])
    create(client, write_headers, "operations")
    create(client, write_headers, "verification")
    create(client, write_headers, "operations")
    assert client.get(BASE + "/audit", headers=reader).status_code == 403
    root = client.get("/api/v1/principals")
    response = client.patch("/api/v1/principals/" + principal["id"], json={"grants": [{"workspaceId": "default", "sourceIds": ["operations"], "capabilities": ["audit.read"]}]},
        headers={"X-Identity-Generation": root.json()["generation"], "If-Match": f'"{root.json()["generation"]}:{principal["revision"]}"', "Idempotency-Key": uuid.uuid4().hex})
    assert response.status_code == 200, response.text
    page = client.get(BASE + "/audit", headers=reader, params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["items"][0]["records"][0]["sourceId"] == "operations"
    assert client.get(BASE + "/audit", params={"limit": 1, "cursor": page["nextCursor"]}).status_code == 409
    tail = client.get(BASE + "/audit", headers=reader, params={"limit": 1, "cursor": page["nextCursor"]}).json()
    assert tail["nextCursor"] is None and tail["items"][0]["records"][0]["sourceId"] == "operations"
    assert "verification" not in str(page) + str(tail)


@pytest.mark.parametrize("damage", ["missing", "changed", "extra", "state"])
def test_audit_chain_damage_fails_closed_at_startup(tmp_path, damage):
    seed = ROOT / "data" / "default-dataset.json"
    root = tmp_path / "data"
    repository = JsonRepository(root, seed).open()
    generation = repository.meta["manifest"]["generation"]
    repository.mutate("create", None, {"title": "Audited"}, generation, None, "audit", "actor")
    repository.close()
    path = root / audit_path(2)
    if damage == "missing":
        path.unlink()
    elif damage == "changed":
        entry = read_json(path)
        entry["actorId"] = "changed"
        atomic_json(path, entry)
    elif damage == "extra":
        atomic_json(root / audit_path(3), read_json(path))
    else:
        state = read_json(root / "audit-state.json")
        state["lastHash"] = "0" * 64
        atomic_json(root / "audit-state.json", state)
    with pytest.raises(DomainError):
        JsonRepository(root, seed).open()


def test_restore_transition_retains_prior_entries_and_cannot_rewrite_generation(tmp_path):
    seed = ROOT / "data" / "default-dataset.json"
    repository = JsonRepository(tmp_path / "data", seed).open()
    try:
        repository.mutate("create", None, {"title": "Audited"}, repository.meta["manifest"]["generation"], None, "audit", "actor")
        previous = copy.deepcopy(repository.meta["manifest"])
        manifest = {**previous, "generation": str(uuid.uuid4()), "revision": previous["revision"] + 1}
        appended = prepare_restore_audit(repository.audit_state, previous, manifest, "a" * 64)
        documents = {**repository.audit_entries, **{path: value for path, value in appended.items() if path.startswith("audit/")}}
        validate_audit_history(appended["audit-state.json"], documents, manifest)
        assert documents[audit_path(2)] == repository.audit_entries[audit_path(2)]
        bad = copy.deepcopy(documents)
        bad[audit_path(3)]["transition"] = None
        bad[audit_path(3)]["sha256"] = audit_hash(bad[audit_path(3)])
        with pytest.raises(DomainError):
            validate_audit_history(appended["audit-state.json"], bad, manifest)
    finally:
        repository.close()
