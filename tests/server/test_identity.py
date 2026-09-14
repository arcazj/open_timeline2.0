import copy
import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import portalocker
import pytest

from server.app.models.domain import DomainError, instant_ms, iso_from_ms, now_iso
from server.app.repositories.json_repository import atomic_json
from server.app.services import identity as identity_module
from server.app.services.identity import IdentityStore, authorize, authorized_sources, scope_fingerprint


SECRET = "identity-tests-bootstrap-only"


@pytest.fixture
def store(tmp_path):
    instance = IdentityStore(tmp_path / "control", SECRET)
    instance.open()
    yield instance
    instance.close()


def admin(store):
    return store.authenticate(SECRET)


def create(store, role="editor", grants=None, name="Editor"):
    grants = [{"workspaceId": "default", "sourceIds": ["operations"], "capabilities": []}] if grants is None else grants
    return store.create_principal(admin(store), {"name": name, "role": role, "grants": grants},
                                  store.state["generation"], store.state["revision"], uuid.uuid4().hex)


def token_for(store, principal, expires=None):
    return store.create_token(admin(store), {"principalId": principal["id"], "name": "Test token", "expiresAt": expires},
                              store.state["generation"], store.state["revision"], uuid.uuid4().hex)


def code(expected, function, *args):
    with pytest.raises(DomainError) as error:
        if function.__name__ in {"create_principal", "update_principal", "create_token", "revoke_token"}:
            function(*args, command_id=uuid.uuid4().hex)
        else:
            function(*args)
    assert error.value.code == expected


def test_bootstrap_is_persisted_once_without_a_raw_secret(store):
    original = admin(store)
    assert store.bootstrap_secret is None
    assert SECRET not in store.path.read_text("utf-8")
    store.close()
    reopened = IdentityStore(store.root, "a-new-env-secret-must-not-reset-identity")
    try:
        reopened.open()
        assert reopened.authenticate(SECRET)["id"] == original["id"]
        code("unauthorized", reopened.authenticate, "a-new-env-secret-must-not-reset-identity")
    finally:
        reopened.close()


def test_only_one_identity_writer_can_own_a_root(store):
    second = IdentityStore(store.root, SECRET)
    with pytest.raises(portalocker.exceptions.LockException):
        second.open()
    assert admin(store)["enabled"]


def test_editor_scope_and_explicit_shared_publication_capability(store):
    principal = create(store)
    created = token_for(store, principal)
    editor = store.authenticate(created["secret"])
    authorize(editor, "records.edit", "default", "operations")
    authorize(editor, "configuration.personal", "default")
    code("forbidden", authorize, editor, "configuration.publish", "default")
    code("forbidden", authorize, editor, "records.read", "another-workspace")
    code("not_found", authorize, editor, "records.edit", "default", "verification")
    assert authorized_sources(editor, "default", ["operations", "verification"]) == ["operations"]
    before = scope_fingerprint(editor, "default")
    updated = store.update_principal(admin(store), principal["id"], {
        "grants": [{"workspaceId": "default", "sourceIds": None, "capabilities": ["configuration.publish"]}],
    }, store.state["generation"], principal["revision"], uuid.uuid4().hex)
    editor = store.authenticate(created["secret"])
    authorize(editor, "configuration.publish", "default")
    assert updated["revision"] == 2
    assert scope_fingerprint(editor, "default") != before
    renamed = {**editor, "name": "A display name change"}
    assert scope_fingerprint(editor, "default") == scope_fingerprint(renamed, "default")


def test_token_secret_is_returned_once_and_never_listed_or_audited(store):
    principal = create(store, "viewer")
    created = token_for(store, principal)
    assert created["secret"].startswith("obt_")
    assert len(created["secret"]) >= 40
    assert created["secret"] not in store.path.read_text("utf-8")
    assert "secretHash" not in json.dumps(store.list_tokens(admin(store)))
    viewer = store.authenticate(created["secret"])
    visible = store.list_tokens(viewer)["items"]
    assert [item["id"] for item in visible] == [created["token"]["id"]]
    code("forbidden", store.list_principals, viewer)
    code("forbidden", authorize, viewer, "records.create", "default", "operations")


def test_revocation_and_disable_recheck_stale_request_contexts(store):
    principal = create(store)
    first, second = token_for(store, principal), token_for(store, principal)
    stale = store.authenticate(first["secret"])
    store.revoke_token(admin(store), first["token"]["id"], store.state["generation"], 1, uuid.uuid4().hex)
    code("unauthorized", store.authenticate, first["secret"])
    code("unauthorized", store.list_tokens, stale)
    code("unauthorized", store.create_token, stale, {"principalId": principal["id"], "name": "Forged", "expiresAt": None},
         store.state["generation"], store.state["revision"])
    store.update_principal(admin(store), principal["id"], {"enabled": False}, store.state["generation"], 1, uuid.uuid4().hex)
    code("unauthorized", store.authenticate, second["secret"])
    assert all(item["revokedAt"] is not None for item in store.state["tokens"] if item["principalId"] == principal["id"])


def test_last_administrator_cannot_be_disabled(store):
    before = store.path.read_bytes()
    code("last_administrator", store.update_principal, admin(store), admin(store)["id"], {"enabled": False}, store.state["generation"], 1)
    assert store.path.read_bytes() == before
    assert len(store.state["audit"]) == 0


def test_preconditions_and_serialized_competing_edits(store):
    principal = create(store)
    actor, generation = admin(store), store.state["generation"]
    code("precondition_required", store.update_principal, actor, principal["id"], {"name": "Missing"}, None, 1)
    code("generation_conflict", store.update_principal, actor, principal["id"], {"name": "Wrong"}, "old", 1)

    def update(index):
        try:
            store.update_principal(actor, principal["id"], {"name": f"Editor {index}"}, generation, 1, uuid.uuid4().hex)
            return "committed"
        except DomainError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(update, range(8)))
    assert results.count("committed") == 1
    assert results.count("revision_conflict") == 7
    assert store.state["revision"] == 3
    assert len(store.state["audit"]) == 2


@pytest.mark.parametrize("override", [
    {"role": []}, {"role": "superuser"}, {"name": " "}, {"grants": []},
    {"grants": [{"workspaceId": "default", "sourceIds": None, "capabilities": [{}]}]},
    {"grants": [{"workspaceId": "default", "sourceIds": ["same", "same"], "capabilities": []}]},
    {"grants": [{"workspaceId": "default", "sourceIds": None, "capabilities": ["*"]}]},
])
def test_invalid_roles_scopes_and_fields_cannot_publish(store, override):
    payload = {"name": "Invalid", "role": "editor", "grants": [{"workspaceId": "default", "sourceIds": None, "capabilities": []}], **override}
    before = store.path.read_bytes()
    with pytest.raises(DomainError):
        store.create_principal(admin(store), payload, store.state["generation"], store.state["revision"], uuid.uuid4().hex)
    assert store.path.read_bytes() == before


def test_token_expiry_is_checked_on_every_request(store, monkeypatch):
    principal = create(store)
    expires = iso_from_ms(instant_ms(now_iso()) + 60000)
    created = token_for(store, principal, expires)
    stale = store.authenticate(created["secret"])
    monkeypatch.setattr(identity_module, "now_iso", lambda: iso_from_ms(instant_ms(expires) + 1))
    code("unauthorized", store.authenticate, created["secret"])
    code("unauthorized", store.list_tokens, stale)


def test_external_edit_freezes_writes_without_overwriting_evidence(store):
    actor = admin(store)
    changed = copy.deepcopy(store.state)
    changed["principals"][0]["name"] = "External change"
    atomic_json(store.path, changed)
    before = store.path.read_bytes()
    code("external_change", store.create_principal, actor, {"name": "Editor", "role": "editor", "grants": [
        {"workspaceId": "default", "sourceIds": None, "capabilities": []},
    ]}, store.state["generation"], store.state["revision"])
    assert not store.available
    assert store.path.read_bytes() == before


@pytest.mark.parametrize("after_replace", [False, True])
def test_unknown_commit_freezes_and_restart_reconciles_actual_json(store, monkeypatch, after_replace):
    original = identity_module.atomic_json

    def fail(path, value):
        if after_replace:
            original(path, value)
        raise OSError("injected write or sync failure")

    monkeypatch.setattr(identity_module, "atomic_json", fail)
    code("identity_commit_unknown", create, store, "editor", None, "Uncertain identity")
    assert not store.available
    store.close()
    monkeypatch.setattr(identity_module, "atomic_json", original)
    store.open()
    assert any(item["name"] == "Uncertain identity" for item in store.state["principals"]) is after_replace
    assert len(store.state["audit"]) == int(after_replace)


def test_corrupt_audit_fails_closed_and_releases_ownership(store):
    changed = copy.deepcopy(store.state)
    changed["revision"] += 1
    store.close()
    atomic_json(store.path, changed)
    broken = IdentityStore(store.root, SECRET)
    code("identity_integrity", broken.open)
    assert not broken.available and broken.lock is None
