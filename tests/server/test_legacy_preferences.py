import copy
import hashlib
import uuid

import portalocker
import pytest

from conftest import TOKEN
from test_legacy_api import legacy  # noqa: F401
from server.app.models.domain import DomainError, validate_snapshot
from server.app.repositories.legacy_repository import LegacyRepository
from server.app.repositories.legacy_preferences import LegacyPreferencesRepository
from server.app.repositories import legacy_preferences as storage
from server.app.services.identity import IdentityStore
from server.app.services.legacy_configuration import LegacyConfigurationService
from server.app.services.legacy_preferences import LegacyPreferencesConfigurationService


@pytest.fixture
def configured(legacy, tmp_path):  # noqa: F811
    options, first, second = legacy
    originals = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (first, second)}
    base = LegacyRepository(options, tmp_path / "state")
    base.open()
    identities = IdentityStore(base.root / "control", TOKEN)
    identities.open()
    repository = LegacyPreferencesRepository(base, base.root / "preferences")
    service = LegacyPreferencesConfigurationService(identities, repository)
    try:
        yield base, repository, service, identities, identities.authenticate(TOKEN)
    finally:
        repository.close()
        identities.close()
        base.close()
        assert all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in originals.items())


def definition():
    return {"definitionVersion": 2, "relationshipMode": "independent", "sourceIds": None, "kinds": ["event", "session"], "schemaRefs": [],
            "expression": {"version": 2, "root": {"op": "regex", "field": "/title", "pattern": "First|Second"}},
            "search": {"text": "First", "mode": "regex", "flags": [], "fields": ["/title"]}}


def mutate(fixture, operation, payload=None, resource=None, key=None):
    base, repository, service, _, identity = fixture
    generation = base.meta["manifest"]["generation"]
    key = key or str(uuid.uuid4())
    command = {"family": "filters", "type": operation, "generation": generation, "clientCommandId": key, "payload": payload or {}}
    etag = None
    if resource is not None:
        command.update(resourceId=resource["id"], expectedRevision=resource["revision"])
        etag = f'"{generation}:{resource["revision"]}"'
    if operation == "apply":
        command["expectedPreferenceRevision"] = next((item["revision"] for item in repository.document["preferences"] if item["principalId"] == identity["id"]), 0)
    return service.mutate(identity, command, generation, key, etag)


def test_lifecycle_persistence_and_data_revision_remain_separate(configured):
    base, repository, service, identities, identity = configured
    before = copy.deepcopy(base.meta)
    created = mutate(configured, "create", {"name": "App-owned search", "visibility": "personal", "definition": definition()})
    resource = created["resource"]
    if not resource["versions"]:
        resource = mutate(configured, "publish", resource=resource)["resource"]
    applied = mutate(configured, "apply", {"version": 1}, resource)
    assert applied["effectiveSettings"]["values"]["definitionVersion"] == 2
    assert applied["effectiveSettings"]["values"]["search"]["mode"] == "regex"
    assert base.meta == before
    overlay = repository.apply({**base.meta, "records": list(base.records.values())})
    assert overlay["manifest"]["revision"] == before["manifest"]["revision"]
    assert overlay["manifest"]["generation"] == before["manifest"]["generation"]
    assert overlay["manifest"]["preferencesRevision"] == repository.revision > 0
    assert overlay["manifest"]["legacy"]["preferencesEnabled"]
    assert repository.apply(overlay)["filters"] == overlay["filters"]
    exported = service.export_snapshot(identity)
    validate_snapshot(exported)
    assert exported["manifest"]["revision"] == before["manifest"]["revision"]
    assert len(exported["records"]) == len(base.records)
    assert resource["id"] in {item["id"] for item in exported["filters"]}
    assert exported["manifest"]["localPreferencesPrincipalId"] == identity["id"]
    assert not any(path.name == "workspace.json" for path in repository.root.rglob("*.json"))
    repository.close()
    reopened = LegacyPreferencesRepository(base, repository.root)
    try:
        again = LegacyPreferencesConfigurationService(identities, reopened)
        assert again.get_resource(identity, "filters", resource["id"])["resource"]["versions"] == resource["versions"]
        assert again.get_effective(identity)["values"]["search"]["mode"] == "regex"
    finally:
        reopened.close()


def test_readonly_defaults_and_immutable_families_are_unchanged(configured):
    base, repository, service, identities, identity = configured
    original = LegacyConfigurationService(identities, base)
    with pytest.raises(DomainError) as disabled:
        original.mutate(identity, {})
    assert disabled.value.code == "legacy_read_only"
    for family in ("sources", "groups", "schemas", "models"):
        with pytest.raises(DomainError) as failure:
            service.mutate(identity, {"family": family, "type": "create"})
        assert failure.value.code == "legacy_read_only"
    assert repository.revision == 0


def test_idempotency_and_ambiguous_atomic_commit_recover_exactly_once(configured, monkeypatch):
    _, repository, service, _, identity = configured
    original = storage.atomic_json

    def after_replace(path, value):
        original(path, value)
        raise OSError("injected directory sync failure after atomic replace")
    monkeypatch.setattr(storage, "atomic_json", after_replace)
    key = str(uuid.uuid4())
    payload = {"name": "Recoverable", "visibility": "personal", "definition": definition()}
    with pytest.raises(DomainError) as failure:
        mutate(configured, "create", payload, key=key)
    assert failure.value.code == "commit_outcome_unknown"
    monkeypatch.setattr(storage, "atomic_json", original)
    committed = mutate(configured, "create", payload, key=key)
    assert repository.revision == 1
    assert service.outcome(identity, key) == committed
    assert mutate(configured, "create", payload, key=key) == committed
    assert len(repository.document["catalogs"]["filters"]) == 1
    with pytest.raises(DomainError) as conflict:
        mutate(configured, "create", {**payload, "name": "Changed"}, key=key)
    assert conflict.value.code == "idempotency_conflict"


def test_preferences_have_exclusive_lock_path_boundary_and_checksum(configured, tmp_path):
    base, repository, _, _, _ = configured
    with pytest.raises(portalocker.exceptions.LockException):
        LegacyPreferencesRepository(base, repository.root)
    for path in (base.root, tmp_path / "authority" / "preferences", tmp_path / "elsewhere"):
        with pytest.raises(DomainError) as failure:
            LegacyPreferencesRepository(base, path)
        assert failure.value.code == "preferences_path"
    repository.close()
    repository.path.write_text('{}', encoding="utf-8")
    with pytest.raises(DomainError) as corrupt:
        LegacyPreferencesRepository(base, repository.root)
    assert corrupt.value.code == "preferences_integrity"


def test_settings_are_personal_json_and_do_not_modify_source_metadata(configured):
    base, repository, service, _, identity = configured
    before = copy.deepcopy(base.meta)
    generation = base.meta["manifest"]["generation"]
    key = str(uuid.uuid4())
    command = {"type": "patch", "scope": "personal", "generation": generation, "expectedRevision": 0, "clientCommandId": key,
               "payload": {"definitionVersion": 2, "groupOrder": {"order": "natural", "caseSensitive": True}, "collapsedGroups": ["string:N"]}}
    result = service.mutate_settings(identity, command, generation, key, f'"{generation}:0"')
    assert result["settings"]["values"]["groupOrder"]["order"] == "natural"
    assert base.meta == before
    assert repository.document["preferences"][0]["principalId"] == identity["id"]
    assert "records" not in repository.document


def test_captured_preferences_pin_a_query_without_copying_command_outcomes(configured):
    base, repository, _, _, _ = configured
    captured = repository.capture()
    assert set(captured) == {"revision", "catalogs", "defaults", "preferences"}
    created = mutate(configured, "create", {"name": "After submission", "visibility": "personal", "definition": definition()})
    source = {**base.meta, "records": list(base.records.values())}
    pinned = repository.apply(source, captured)
    current = repository.apply(source)
    assert pinned["manifest"]["preferencesRevision"] == 0
    assert current["manifest"]["preferencesRevision"] == 1
    assert created["resource"]["id"] not in {item["id"] for item in pinned["filters"]}
    assert created["resource"]["id"] in current["manifest"]["legacy"]["preferencesCatalogIds"]["filters"]
    assert pinned["records"] == current["records"]
    assert pinned["manifest"]["revision"] == current["manifest"]["revision"]
    captured["defaults"]["revision"] += 100
    assert repository.capture()["defaults"]["revision"] != captured["defaults"]["revision"]


def test_export_marker_does_not_leak_another_principals_personal_resources(configured):
    base, _, service, identities, admin = configured
    private = mutate(configured, "create", {"name": "Private preference", "visibility": "personal", "definition": definition()})
    principal = identities.create_principal(admin, {"name": "Reader", "role": "viewer", "grants": [{
        "workspaceId": base.meta["manifest"]["workspaceId"], "sourceIds": None, "capabilities": []}]},
        identities.state["generation"], identities.state["revision"], str(uuid.uuid4()))
    token = identities.create_token(admin, {"principalId": principal["id"], "name": "Reader", "expiresAt": None},
        identities.state["generation"], identities.state["revision"], str(uuid.uuid4()))
    exported = service.export_snapshot(identities.authenticate(token["secret"]))
    validate_snapshot(exported)
    assert private["resource"]["id"] not in str(exported["manifest"]["legacy"]["preferencesCatalogIds"])
    assert private["resource"]["id"] not in {item["id"] for item in exported["filters"]}
