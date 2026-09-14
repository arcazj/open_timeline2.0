import copy
import hashlib
import json
import os
import subprocess
import sys
import time

import portalocker
import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, instant_ms, iso_from_ms, now_iso
from server.app.repositories.json_repository import JsonRepository, atomic_json
from server.app.services import identity as module
from server.app.services.identity import IdentityStore, recover_identity

SECRET = "hardening-bootstrap-secret"
SEED = ROOT / "data/default-dataset.json"


@pytest.fixture
def store(tmp_path):
    value = IdentityStore(tmp_path / "control", SECRET)
    value.open()
    yield value
    value.close()


def admin(store):
    return store.authenticate(SECRET)


def create_principal(store, key="principal", name="Reader", role="viewer"):
    return store.create_principal(admin(store), {"name": name, "role": role,
        "grants": [] if role == "admin" else [{"workspaceId": "default", "sourceIds": None, "capabilities": []}]},
        store.state["generation"], store.state["revision"], key)


def test_v1_is_read_only_at_startup_and_upgrades_only_with_authorized_command(store):
    state = copy.deepcopy(store.state)
    state["formatVersion"] = 1
    for key in ("commands", "recoveryHistory", "checksum"):
        state.pop(key)
    store.close()
    atomic_json(store.path, state)
    before = store.path.read_bytes()
    store.open()
    assert store.path.read_bytes() == before and store.state["formatVersion"] == 1
    create_principal(store)
    assert store.state["formatVersion"] == 2 and len(store.state["commands"]) == 1
    assert store.state["checksum"] == module._checksum(store.state)


@pytest.mark.parametrize("change", [
    lambda value: value.update(generation=value["generation"].upper()),
    lambda value: value["principals"][0].update(id=value["principals"][0]["id"].replace("-", "")),
    lambda value: value["tokens"][0].update(id=[]),
    lambda value: value["principals"][0].update(revision=True),
    lambda value: value["tokens"][0].update(revision=1.0),
    lambda value: value["principals"][0].update(name="bad\ud800"),
    lambda value: value["tokens"][0].update(secretHash="x" * 64),
    lambda value: value["tokens"][0].update(createdAt=None),
    lambda value: value["principals"][0].update(updatedAt="0001-01-01T00:00:00.000Z"),
    lambda value: value.update(formatVersion=3),
])
def test_invalid_identity_shapes_are_domain_errors_before_persistence(store, change):
    state = copy.deepcopy(store.state)
    change(state)
    if "\ud800" not in repr(state):
        try:
            state["checksum"] = module._checksum(state)
        except (UnicodeError, TypeError):
            pass
    original = store.path.read_bytes()
    with pytest.raises(DomainError):
        store._validate(state)
    assert store.path.read_bytes() == original


def test_raw_size_and_depth_are_bounded_and_failed_open_releases_lock(store, monkeypatch):
    store.close()
    original = store.path.read_bytes()
    monkeypatch.setattr(module, "IDENTITY_BYTES", len(original) - 1)
    with pytest.raises(DomainError) as error:
        store.open()
    assert error.value.code == "identity_capacity" and store.lock is None
    monkeypatch.setattr(module, "IDENTITY_BYTES", 32 * 1024 * 1024)
    store.path.write_bytes(b"[" * 70 + b"0" + b"]" * 70)
    with pytest.raises(DomainError):
        store.open()
    assert store.lock is None


def test_missing_existing_identity_file_never_rebootstraps(store):
    store.close()
    store.path.unlink()
    other = IdentityStore(store.root, "changed-environment-secret")
    with pytest.raises(DomainError) as error:
        other.open()
    assert error.value.code == "bootstrap_required" and not store.path.exists()


def test_checksum_tampering_fails_closed_on_restart(store):
    state = copy.deepcopy(store.state)
    store.close()
    state["principals"][0]["name"] = "Changed without digest"
    atomic_json(store.path, state)
    evidence = store.path.read_bytes()
    with pytest.raises(DomainError) as error:
        store.open()
    assert error.value.code == "identity_integrity" and store.lock is None
    assert store.path.read_bytes() == evidence


def test_monitor_detects_same_stamp_changed_bytes_and_is_fully_joined(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MONITOR_SECONDS", 0.02)
    value = IdentityStore(tmp_path / "control", SECRET)
    value.open()
    monitor = value.monitor
    stamp = value.path.stat()
    original = value.path.read_bytes()
    changed = original.replace(b"Administrator", b"administratoR")
    assert len(changed) == len(original) and changed != original
    value.path.write_bytes(changed)
    os.utime(value.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    deadline = time.monotonic() + 3
    while value.available and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not value.available
    value.close()
    assert value.monitor is None and not monitor.is_alive() and value.lock is None


def test_current_scope_rechecked_after_admin_demotion(store):
    other = create_principal(store, role="admin")
    credential = store.create_token(admin(store), {"principalId": other["id"], "name": "Second admin", "expiresAt": None},
                                    store.state["generation"], store.state["revision"], "second-token")
    stale = store.authenticate(credential["secret"])
    store.update_principal(admin(store), other["id"], {"role": "viewer", "grants": [
        {"workspaceId": "default", "sourceIds": None, "capabilities": []}]}, store.state["generation"], 1, "demote")
    with pytest.raises(DomainError) as error:
        store.create_principal(stale, {"name": "Forbidden", "role": "admin", "grants": []},
                               store.state["generation"], store.state["revision"], "stale-admin")
    assert error.value.code == "forbidden"


def test_last_currently_usable_admin_token_is_guarded(store):
    actor = admin(store)
    original = store.path.read_bytes()
    with pytest.raises(DomainError) as error:
        store.revoke_token(actor, actor["tokenId"], store.state["generation"], 1, "last-token")
    assert error.value.code == "last_administrator_token"
    assert store.path.read_bytes() == original
    # Merely having another enabled administrator without a token does not prevent lockout.
    create_principal(store, role="admin")
    with pytest.raises(DomainError) as error:
        store.revoke_token(actor, actor["tokenId"], store.state["generation"], 1, "still-last")
    assert error.value.code == "last_administrator_token"


def test_exact_replay_preserves_root_revision_status_and_resource_etag(store):
    actor, generation = admin(store), store.state["generation"]
    payload = {"name": "Stable", "role": "admin", "grants": []}
    first = store.create_principal(actor, payload, generation, 1, "stable")
    create_principal(store, "later", "Later")
    second = store.create_principal(actor, payload, generation, 1, "stable")
    assert first == second and first.response == second.response
    assert second.response["body"]["revision"] == 2 and store.state["revision"] == 3
    assert store.get_command_outcome(actor, "stable")["response"] == first.response
    with pytest.raises(DomainError) as error:
        store.create_principal(actor, {**payload, "name": "Different"}, generation, 1, "stable")
    assert error.value.code == "idempotency_conflict"
    store.close()
    store.open()
    assert store.create_principal(admin(store), payload, generation, 1, "stable").response == first.response


def test_token_replay_returns_metadata_without_secret_or_new_token(store):
    actor, generation, revision = admin(store), store.state["generation"], store.state["revision"]
    payload = {"principalId": actor["id"], "name": "One disclosure", "expiresAt": None}
    first = store.create_token(actor, payload, generation, revision, "one-secret")
    second = store.create_token(actor, payload, generation, revision, "one-secret")
    outcome = store.get_command_outcome(actor, "one-secret")
    assert first["secret"] and first["secretUnavailable"] is False
    assert "secret" not in second and second["secretUnavailable"] is True
    assert first["token"] == second["token"] and len(store.state["tokens"]) == 2
    assert first["secret"] not in json.dumps(outcome) and first["secret"] not in store.path.read_text("utf-8")
    assert "secretHash" not in json.dumps(outcome)


@pytest.mark.parametrize("after_replace", [False, True])
def test_lost_reply_can_be_looked_up_without_unsolicited_retry(store, monkeypatch, after_replace):
    actor, generation = admin(store), store.state["generation"]
    original = module.atomic_json

    def fault(path, candidate):
        if after_replace:
            original(path, candidate)
        raise OSError("Interrupted identity replacement")

    monkeypatch.setattr(module, "atomic_json", fault)
    with pytest.raises(DomainError) as error:
        store.create_principal(actor, {"name": "Lost reply", "role": "admin", "grants": []}, generation, 1, "lost")
    assert error.value.code == "identity_commit_unknown"
    store.close()
    monkeypatch.setattr(module, "atomic_json", original)
    store.open()
    before = store.path.read_bytes()
    if after_replace:
        assert store.get_command_outcome(admin(store), "lost")["response"]["body"]["revision"] == 2
    else:
        with pytest.raises(DomainError) as error:
            store.get_command_outcome(admin(store), "lost")
        assert error.value.code == "command_not_found"
    assert store.path.read_bytes() == before


def test_http_identity_key_replay_retains_original_headers_and_secret_policy(client):
    me = client.get("/api/v1/principals/me").json()
    root = client.get("/api/v1/principals")
    headers = {"X-Identity-Generation": root.json()["generation"], "If-Match": root.headers["etag"], "Idempotency-Key": "http-token"}
    payload = {"principalId": me["principal"]["id"], "name": "HTTP token", "expiresAt": None}
    first = client.post("/api/v1/tokens", json=payload, headers=headers)
    replay = client.post("/api/v1/tokens", json=payload, headers=headers)
    assert first.status_code == replay.status_code == 201
    assert first.headers["etag"] == replay.headers["etag"] and first.headers["location"] == replay.headers["location"]
    assert first.json()["secret"] and "secret" not in replay.json() and replay.json()["secretUnavailable"] is True
    found = client.get("/api/v1/identity/commands/http-token")
    assert found.status_code == 200 and found.json()["response"]["body"] == replay.json()
    assert first.json()["secret"] not in found.text
    assert client.post("/api/v1/tokens", json=payload, headers={key: value for key, value in headers.items() if key != "Idempotency-Key"}).status_code == 428


def recovery_root(tmp_path):
    root = tmp_path / "data"
    repository = JsonRepository(root, SEED).open()
    repository.close()
    identities = IdentityStore(root / "control", SECRET)
    identities.open()
    identities.close()
    return root


def test_offline_recovery_rotates_generation_revokes_all_tokens_and_preserves_records(tmp_path):
    root = recovery_root(tmp_path)
    original = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*.json")
                if "control" not in path.parts}
    first = recover_identity(root, "Lost the only usable administrator credential")
    identities = IdentityStore(root / "control", "environment-does-not-reset")
    identities.open()
    actor = identities.authenticate(first["secret"])
    assert actor["identityGeneration"] == first["generation"]
    with pytest.raises(DomainError):
        identities.authenticate(SECRET)
    assert first["secret"] not in identities.path.read_text("utf-8")
    assert all(token["revokedAt"] is not None for token in identities.state["tokens"] if token["id"] != first["token"]["id"])
    identities.close()
    second = recover_identity(root, "Explicit second recovery")
    assert second["generation"] != first["generation"] and second["revision"] == first["revision"] + 1
    identities.open()
    try:
        with pytest.raises(DomainError):
            identities.authenticate(first["secret"])
        assert identities.authenticate(second["secret"])["id"] == actor["id"]
        assert len(identities.state["recoveryHistory"]) == 2
        assert identities.state["audit"][-1]["action"] == "identity.recover"
    finally:
        identities.close()
    assert original == {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*.json")
                        if "control" not in path.parts}


def test_recovery_rejects_active_workspace_without_modifying_identities(tmp_path):
    root = recovery_root(tmp_path)
    before = (root / "control/identities.json").read_bytes()
    repository = JsonRepository(root, SEED).open()
    try:
        with pytest.raises(portalocker.exceptions.LockException):
            recover_identity(root, "Service is still active")
    finally:
        repository.close()
    assert (root / "control/identities.json").read_bytes() == before


def test_recovery_cli_prints_fresh_secret_only_to_operator(tmp_path):
    root = recovery_root(tmp_path)
    result = subprocess.run([sys.executable, str(ROOT / "scripts/recover-identity.py"), "--data-root", str(root),
                             "--reason", "CLI recovery test"], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    output = json.loads(result.stdout)
    assert output["secret"].startswith("obt_") and output["secret"] not in result.stderr
    assert output["secret"] not in (root / "control/identities.json").read_text("utf-8")


def test_naturally_expired_root_requires_local_recovery(tmp_path, monkeypatch):
    root = recovery_root(tmp_path)
    identities = IdentityStore(root / "control", SECRET)
    identities.open()
    actor = identities.authenticate(SECRET)
    expiry = iso_from_ms(instant_ms(now_iso()) + 60000)
    token = identities.create_token(actor, {"principalId": actor["id"], "name": "Expiring only token", "expiresAt": expiry},
                                     identities.state["generation"], identities.state["revision"], "expiring")
    identities.revoke_token(actor, actor["tokenId"], identities.state["generation"], 1, "revoke-bootstrap")
    identities.close()
    monkeypatch.setattr(module, "now_iso", lambda: iso_from_ms(instant_ms(expiry) + 1))
    identities.open()
    with pytest.raises(DomainError):
        identities.authenticate(token["secret"])
    identities.close()
    recovered = recover_identity(root, "All administrator tokens expired")
    identities.open()
    assert identities.authenticate(recovered["secret"])["role"] == "admin"
    identities.close()


@pytest.mark.parametrize("operation", ["disable", "demote"])
def test_admin_transition_without_another_usable_admin_token_is_rejected(store, operation):
    actor = admin(store)
    create_principal(store, role="admin")
    payload = {"enabled": False} if operation == "disable" else {"role": "viewer", "grants": [
        {"workspaceId": "default", "sourceIds": None, "capabilities": []}]}
    before = store.path.read_bytes()
    with pytest.raises(DomainError) as error:
        store.update_principal(actor, actor["id"], payload, store.state["generation"], 1, "transition")
    assert error.value.code == "last_administrator_token"
    assert store.path.read_bytes() == before


@pytest.mark.parametrize("secret", ["x" * 513, "has an embedded space", "nonascii-secret-\u00e9"])
def test_invalid_bootstrap_never_creates_an_unusable_root(tmp_path, secret):
    root = tmp_path / "control"
    with pytest.raises(DomainError):
        IdentityStore(root, secret).open()
    assert not root.exists()


def test_second_open_on_same_instance_does_not_abandon_original_owner(store):
    monitor = store.monitor
    with pytest.raises(DomainError) as error:
        store.open()
    assert error.value.code == "identity_already_open"
    assert store.monitor is monitor and monitor.is_alive()
    with pytest.raises(portalocker.exceptions.LockException):
        IdentityStore(store.root, SECRET).open()
    assert admin(store)["enabled"]


@pytest.mark.parametrize("mutation", [
    lambda value: value["commands"][0]["response"]["body"].update(secret="must-not-persist"),
    lambda value: value["commands"][0]["response"]["body"]["token"].update(secretHash="0" * 64),
    lambda value: value["commands"][0]["response"]["headers"].update(Location="https://untrusted.invalid/"),
    lambda value: value["commands"][0].update(revision=True),
])
def test_command_metadata_cannot_smuggle_secrets_or_forge_provenance(store, mutation):
    actor = admin(store)
    store.create_token(actor, {"principalId": actor["id"], "name": "Original", "expiresAt": None},
                       store.state["generation"], 1, "metadata")
    changed = copy.deepcopy(store.state)
    mutation(changed)
    changed["checksum"] = module._checksum(changed)
    with pytest.raises(DomainError):
        store._validate(changed)


@pytest.mark.parametrize("after_replace", [False, True])
def test_real_process_exit_leaves_old_or_new_identity_and_outcome(tmp_path, after_replace):
    root = recovery_root(tmp_path)
    program = """
import os, sys
from pathlib import Path
from server.app.services import identity as module
store = module.IdentityStore(Path(sys.argv[1]) / 'control', None)
store.open()
original = module.atomic_json
def stop(path, value):
    if sys.argv[2] == 'yes':
        original(path, value)
    os._exit(79)
module.atomic_json = stop
actor = store.authenticate(sys.argv[3])
store.create_principal(actor, {'name':'Exited','role':'admin','grants':[]}, store.state['generation'],1,'process-exit')
"""
    result = subprocess.run([sys.executable, "-c", program, str(root), "yes" if after_replace else "no", SECRET],
                            cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 79, result.stderr
    for _ in range(2):
        identities = IdentityStore(root / "control", None)
        identities.open()
        try:
            if after_replace:
                assert identities.get_command_outcome(identities.authenticate(SECRET), "process-exit")["response"]["body"]["revision"] == 2
            else:
                with pytest.raises(DomainError) as error:
                    identities.get_command_outcome(identities.authenticate(SECRET), "process-exit")
                assert error.value.code == "command_not_found"
        finally:
            identities.close()
