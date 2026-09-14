import copy
import json
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, content_checksum, read_json
from server.app.repositories.audit_history import validate_audit_history
from server.app.repositories.json_repository import JsonRepository, atomic_json
from server.app.repositories.storage_migration import migrate_storage
from server.app.services import backup
from server.app.services.identity import IdentityStore, recover_identity

SEED = ROOT / "data/default-dataset.json"
SECRET = "backup-fixture-bootstrap-secret"


def initialized(tmp_path, *, tombstone=True):
    root = tmp_path / "source"
    repository = JsonRepository(root, SEED).open()
    identities = IdentityStore(root / "control", SECRET)
    identities.open()
    actor = identities.authenticate(SECRET)
    result = repository.mutate("create", None, {"title": "Preserved outcome record"}, repository.meta["manifest"]["generation"], None, "created", actor["id"])
    if tombstone:
        record = result["record"]
        repository.mutate("delete", record["id"], {}, result["generation"], f'"{result["generation"]}:{record["version"]}"', "deleted", actor["id"])
    return repository, identities, actor


def make_archive(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    archive = tmp_path / "backup"
    try:
        manifest = backup.create_live_backup(repository, identities, actor, archive)
    finally:
        repository.close()
        identities.close()
    return archive, manifest


def json_files(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*.json")}


def change_manifest(archive, mutate):
    value = read_json(archive / backup.MANIFEST_NAME)
    mutate(value)
    value["checksum"] = backup._checksum(value)
    atomic_json(archive / backup.MANIFEST_NAME, value)


def refresh_member_hash(archive, relative):
    def change(value):
        value["files"] = [backup._entry(relative, (archive / relative).read_bytes()) if entry["path"] == relative else entry for entry in value["files"]]
        value["totalBytes"] = sum(entry["bytes"] for entry in value["files"])
    change_manifest(archive, change)


def test_live_complete_capture_includes_tombstone_outcomes_config_identity_and_raw_bytes(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    before = json_files(repository.root)
    archive = tmp_path / "backup"
    try:
        manifest = backup.create_live_backup(repository, identities, actor, archive)
        assert backup.verify_backup(archive) == manifest
        assert manifest["workspace"]["recordCount"] == 49
        assert manifest["workspace"]["activeRecordCount"] == 48
        assert manifest["workspace"]["tombstoneCount"] == 1
        assert manifest["createdBy"] == actor["id"] and manifest["captureMode"] == "live"
        assert before == json_files(repository.root)
        for relative, raw in before.items():
            assert (archive / relative).read_bytes() == raw
        assert manifest["fileCount"] == len(before)
        assert manifest["totalBytes"] == sum(map(len, before.values()))
        assert len([entry for entry in manifest["files"] if entry["path"].startswith("outcomes/")]) == 2
        assert "audit-state.json" in before
        assert len([entry for entry in manifest["files"] if entry["path"].startswith("audit/")]) == 2
        with pytest.raises(RuntimeError, match="migration is incomplete"):
            JsonRepository(archive, SEED).open()
    finally:
        repository.close()
        identities.close()


def test_restore_rotates_generations_preserves_records_history_and_requires_fresh_recovery(tmp_path):
    archive, manifest = make_archive(tmp_path)
    archive_before, source_before = json_files(archive), json_files(tmp_path / "source")
    destination = tmp_path / "restored"
    result = backup.restore_backup(archive, destination, reason="Verified recovery drill")
    assert result["activated"] is False and result["credentialsRequired"] is True
    assert result["workspace"]["generation"] != manifest["workspace"]["generation"]
    assert result["identity"]["generation"] != manifest["identity"]["generation"]
    assert result["workspace"]["revision"] == manifest["workspace"]["revision"] + 1
    assert result["identity"]["revision"] == manifest["identity"]["revision"] + 1
    assert json_files(archive) == archive_before and json_files(tmp_path / "source") == source_before
    for relative, raw in source_before.items():
        if relative.startswith(("records/", "outcomes/")):
            assert (destination / relative).read_bytes() == raw
    original_meta, new_meta = read_json(archive / "workspace.json"), read_json(destination / "workspace.json")
    assert {key: value for key, value in original_meta.items() if key != "manifest"} == {key: value for key, value in new_meta.items() if key != "manifest"}
    audit_state = read_json(destination / "audit-state.json")
    audit_documents = {path.relative_to(destination).as_posix(): read_json(path) for path in (destination / "audit").glob("*.json")}
    validate_audit_history(audit_state, audit_documents, new_meta["manifest"])
    final_entry = audit_documents[f'audit/{new_meta["manifest"]["revision"]:016d}.json']
    assert final_entry["family"] == "workspace.restore"
    assert final_entry["transition"]["backupSha256"] == manifest["checksum"]
    for relative, raw in source_before.items():
        if relative.startswith("audit/"):
            assert (destination / relative).read_bytes() == raw
    for _ in range(2):
        identities = IdentityStore(destination / "control", "ignored-environment-bootstrap")
        identities.open()
        repository = JsonRepository(destination, SEED).open()
        try:
            with pytest.raises(DomainError) as error:
                identities.authenticate(SECRET)
            assert error.value.status == 401
            assert all(token["revokedAt"] is not None for token in identities.state["tokens"])
            assert identities.state["recoveryHistory"][-1]["reason"].startswith("Inactive restore of backup")
            actor_id = identities.state["principals"][0]["id"]
            with pytest.raises(DomainError) as error:
                repository.command_outcome(actor_id, "created")
            assert error.value.code == "generation_conflict"
            with pytest.raises(DomainError) as error:
                repository.mutate("create", None, {"title": "Old request"}, manifest["workspace"]["generation"], None, "old", actor_id)
            assert error.value.code == "generation_conflict"
            with pytest.raises(DomainError) as error:
                repository.mutate("create", None, {"title": "Reused key"}, result["workspace"]["generation"], None, "created", actor_id)
            assert error.value.code == "idempotency_conflict"
            exported = repository.snapshot()
            assert exported["manifest"]["contentSha256"] == content_checksum(exported)
        finally:
            repository.close()
            identities.close()
    recovery = recover_identity(destination, reason="Issue fresh access after verified restore")
    identities = IdentityStore(destination / "control", None)
    identities.open()
    try:
        assert identities.authenticate(recovery["secret"])["role"] == "admin"
        assert recovery["secret"].encode() not in (destination / "control/identities.json").read_bytes()
    finally:
        identities.close()


def test_offline_backup_refuses_active_owners_then_preserves_source(tmp_path):
    repository, identities, _ = initialized(tmp_path)
    before = json_files(repository.root)
    try:
        with pytest.raises((DomainError, RuntimeError, OSError)):
            backup.create_offline_backup(repository.root, tmp_path / "blocked")
        assert not (tmp_path / "blocked").exists()
    finally:
        repository.close()
        identities.close()
    value = backup.create_offline_backup(tmp_path / "source", tmp_path / "backup")
    assert value["captureMode"] == "offline" and value["createdBy"] == "offline-operator"
    assert json_files(tmp_path / "source") == before


def test_live_barrier_blocks_mutation_and_captures_one_revision(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    started, finished = threading.Event(), threading.Event()
    errors = []

    def mutate():
        started.set()
        try:
            repository.mutate("create", None, {"title": "After capture"}, repository.meta["manifest"]["generation"], None, "concurrent", actor["id"])
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()

    worker = threading.Thread(target=mutate)

    def progress(event):
        if event["phase"] == "copy" and event["completedFiles"] == 0:
            worker.start()
            assert started.wait(2)
            assert not finished.wait(0.05)

    try:
        manifest = backup.create_live_backup(repository, identities, actor, tmp_path / "backup", progress=progress)
        assert finished.wait(3)
        worker.join(3)
        assert not errors
        assert manifest["workspace"]["recordCount"] == 49 and len(repository.records) == 50
        assert backup.verify_backup(tmp_path / "backup")["workspace"]["revision"] + 1 == repository.meta["manifest"]["revision"]
    finally:
        worker.join(3)
        repository.close()
        identities.close()


def test_backup_rechecks_current_administrator(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    stale = {**actor, "identityGeneration": "00000000-0000-0000-0000-000000000000"}
    try:
        with pytest.raises(DomainError):
            backup.create_live_backup(repository, identities, stale, tmp_path / "denied")
        assert not (tmp_path / "denied").exists()
    finally:
        repository.close()
        identities.close()


def test_forged_administrator_role_and_wrong_root_owner_cannot_create_backup(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    try:
        principal = identities.create_principal(actor, {"name": "Viewer", "role": "viewer", "grants": [{"workspaceId": "default", "sourceIds": None, "capabilities": []}]},
                                                 identities.state["generation"], identities.state["revision"], "viewer")
        token = identities.create_token(actor, {"principalId": principal["id"], "name": "Viewer token", "expiresAt": None},
                                         identities.state["generation"], identities.state["revision"], "viewer-token")
        forged = {**identities.authenticate(token["secret"]), "role": "admin"}
        with pytest.raises(DomainError) as error:
            backup.create_live_backup(repository, identities, forged, tmp_path / "forged")
        assert error.value.status == 403
        other = IdentityStore(tmp_path / "other-control", "other-bootstrap-secret")
        other.open()
        try:
            with pytest.raises(DomainError):
                backup.create_live_backup(repository, other, other.authenticate("other-bootstrap-secret"), tmp_path / "wrong-root")
        finally:
            other.close()
        assert not (tmp_path / "forged").exists() and not (tmp_path / "wrong-root").exists()
    finally:
        repository.close()
        identities.close()


def test_token_expiry_during_capture_cannot_publish_complete_backup(tmp_path, monkeypatch):
    from server.app.services import identity as identity_module
    repository, identities, actor = initialized(tmp_path)
    try:
        token = identities.create_token(actor, {"principalId": actor["id"], "name": "Expiring backup token", "expiresAt": "2030-01-01T00:00:00.000Z"},
                                         identities.state["generation"], identities.state["revision"], "expiring-backup")
        context = identities.authenticate(token["secret"])

        def expire(value):
            if value["phase"] == "publish":
                monkeypatch.setattr(identity_module, "now_iso", lambda: "2030-01-01T00:00:00.000Z")

        with pytest.raises(DomainError) as error:
            backup.create_live_backup(repository, identities, context, tmp_path / "expired", progress=expire)
        assert error.value.status == 401
        assert not (tmp_path / "expired" / backup.MANIFEST_NAME).exists()
        assert repository.available
    finally:
        repository.close()
        identities.close()


@pytest.mark.parametrize("name", ["transaction.json", "unregistered.json", "migration-incomplete.json"])
def test_unrecognized_authority_or_pending_recovery_is_not_silently_omitted(tmp_path, name):
    repository, identities, actor = initialized(tmp_path)
    atomic_json(repository.root / name, {"unexpected": True})
    try:
        with pytest.raises(DomainError):
            backup.create_live_backup(repository, identities, actor, tmp_path / "backup")
        assert not (tmp_path / "backup").exists()
    finally:
        repository.close()
        identities.close()


def test_valid_out_of_band_record_edit_freezes_workspace_and_leaves_incomplete_archive(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    record = next(iter(repository.records.values()))
    atomic_json(repository.root / "records" / (record["id"] + ".json"), {**record, "title": "Unexpected external change"})
    try:
        with pytest.raises(DomainError) as error:
            backup.create_live_backup(repository, identities, actor, tmp_path / "backup")
        assert error.value.code == "external_change" and repository.available is False
        assert (tmp_path / "backup" / backup.MARKER_NAME).exists()
        assert not (tmp_path / "backup" / backup.MANIFEST_NAME).exists()
    finally:
        repository.close()
        identities.close()


@pytest.mark.parametrize("mutation", ["missing", "extra", "bytes", "checksum", "malformed", "duplicate", "traversal", "absolute", "backslash", "oversize", "summary_bool", "record_schema", "outcome_identity"])
def test_archive_rejects_corruption_even_with_recomputed_outer_checksum(tmp_path, mutation):
    archive, manifest = make_archive(tmp_path)
    relative = next(entry["path"] for entry in manifest["files"] if entry["path"].startswith("records/"))
    path = archive / relative
    if mutation == "missing":
        path.unlink()
    elif mutation == "extra":
        atomic_json(archive / "records/00000000-0000-0000-0000-000000000000.json", {})
    elif mutation == "bytes":
        path.write_bytes(path.read_bytes() + b" ")
    elif mutation == "checksum":
        value = read_json(archive / backup.MANIFEST_NAME)
        value["checksum"] = "0" * 64
        atomic_json(archive / backup.MANIFEST_NAME, value)
    elif mutation == "malformed":
        path.write_bytes(b'{"duplicate":1,"duplicate":2}')
        refresh_member_hash(archive, relative)
    elif mutation == "record_schema":
        record = read_json(path)
        record["data"]["status"] = 123
        atomic_json(path, record)
        refresh_member_hash(archive, relative)
    elif mutation == "outcome_identity":
        relative = next(entry["path"] for entry in manifest["files"] if entry["path"].startswith("outcomes/"))
        value = read_json(archive / relative)
        value["clientCommandId"] = "wrong-filename"
        atomic_json(archive / relative, value)
        refresh_member_hash(archive, relative)
    else:
        def mutate(value):
            if mutation == "duplicate":
                value["files"].append(copy.deepcopy(value["files"][0]))
                value["fileCount"] += 1
                value["totalBytes"] += value["files"][0]["bytes"]
            elif mutation == "summary_bool":
                value["identity"]["revision"] = True
            elif mutation == "oversize":
                value["files"][0]["bytes"] = 33 * 1024**2
            else:
                value["files"][0]["path"] = {"traversal": "../workspace.json", "absolute": "C:/workspace.json", "backslash": "control\\identities.json"}[mutation]
        change_manifest(archive, mutate)
    with pytest.raises((DomainError, RuntimeError, ValueError)):
        backup.restore_backup(archive, tmp_path / "restored", reason="Must reject corrupt archive")
    assert not (tmp_path / "restored").exists()


@pytest.mark.parametrize("operation", ["capture", "restore"])
def test_write_failure_retains_nonstartable_destination_and_does_not_touch_source(tmp_path, monkeypatch, operation):
    archive, _ = make_archive(tmp_path)
    original_write = backup._write_raw
    count = 0

    def fail(path, raw):
        nonlocal count
        count += 1
        if count == 3:
            raise OSError("Injected storage failure")
        original_write(path, raw)

    monkeypatch.setattr(backup, "_write_raw", fail)
    source = archive if operation == "restore" else tmp_path / "source"
    before = json_files(source)
    destination = tmp_path / "interrupted"
    with pytest.raises(OSError):
        if operation == "restore":
            backup.restore_backup(source, destination, reason="Fault drill")
        else:
            backup.create_offline_backup(source, destination)
    assert before == json_files(source)
    assert (destination / backup.MARKER_NAME).exists()
    for _ in range(2):
        with pytest.raises(RuntimeError, match="incomplete"):
            JsonRepository(destination, SEED).open()


def test_cancellation_retains_marker_and_no_complete_manifest(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    try:
        with pytest.raises(DomainError) as error:
            backup.create_live_backup(repository, identities, actor, tmp_path / "cancelled", cancelled=lambda: True)
        assert error.value.code == "backup_cancelled"
        assert (tmp_path / "cancelled" / backup.MARKER_NAME).exists()
        assert not (tmp_path / "cancelled" / backup.MANIFEST_NAME).exists()
    finally:
        repository.close()
        identities.close()


@pytest.mark.parametrize("limit", ["files", "aggregate", "space"])
def test_admission_failure_keeps_existing_verified_backups_and_no_destination(tmp_path, monkeypatch, limit):
    archive, _ = make_archive(tmp_path)
    existing = json_files(archive)
    if limit == "files":
        monkeypatch.setattr(backup, "MAX_FILES", 2)
    elif limit == "aggregate":
        monkeypatch.setattr(backup, "MAX_TOTAL_BYTES", 32)
    else:
        monkeypatch.setattr(backup.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    with pytest.raises(DomainError) as error:
        backup.create_offline_backup(tmp_path / "source", tmp_path / "no-space")
    assert error.value.status == 413
    assert not (tmp_path / "no-space").exists()
    assert json_files(archive) == existing


def test_destination_owner_blocks_readiness_until_restore_completes(tmp_path):
    archive, _ = make_archive(tmp_path)
    destination = tmp_path / "restored"
    observed = []

    def progress(value):
        if value["phase"] == "complete":
            with pytest.raises(RuntimeError, match="active writer"):
                JsonRepository(destination, SEED).open()
            observed.append(True)

    backup.restore_backup(archive, destination, reason="Destination ownership drill", progress=progress)
    assert observed == [True]
    repository = JsonRepository(destination, SEED).open()
    repository.close()


def test_semantic_verification_rechecks_member_hash_after_late_archive_change(tmp_path, monkeypatch):
    archive, manifest = make_archive(tmp_path)
    original = backup._validate_root
    relative = next(entry["path"] for entry in manifest["files"] if entry["path"].startswith("records/"))

    def change(root, paths):
        record = read_json(root / relative)
        record["title"] = "Changed after first byte check"
        atomic_json(root / relative, record)
        return original(root, paths)

    monkeypatch.setattr(backup, "_validate_root", change)
    with pytest.raises(DomainError):
        backup.verify_backup(archive)


def test_restore_rechecks_unchanged_outcome_bytes_before_activation(tmp_path):
    archive, manifest = make_archive(tmp_path)
    destination = tmp_path / "restored"
    relative = next(entry["path"] for entry in manifest["files"] if entry["path"].startswith("outcomes/"))

    def change(value):
        if value["phase"] == "validate-restored":
            outcome = read_json(destination / relative)
            outcome["result"]["record"]["title"] = "Untrusted replacement"
            atomic_json(destination / relative, outcome)

    with pytest.raises(DomainError):
        backup.restore_backup(archive, destination, reason="Late outcome corruption drill", progress=change)
    assert (destination / backup.MARKER_NAME).exists()
    backup.verify_backup(archive)


def test_malformed_live_source_freezes_writes_without_publishing_archive(tmp_path):
    repository, identities, actor = initialized(tmp_path)
    path = next((repository.root / "records").glob("*.json"))
    path.write_bytes(b'{"broken":')
    try:
        with pytest.raises(DomainError):
            backup.create_live_backup(repository, identities, actor, tmp_path / "invalid")
        assert repository.available is False
        assert not (tmp_path / "invalid" / backup.MANIFEST_NAME).exists()
    finally:
        repository.close()
        identities.close()


def test_restore_cancellation_after_copy_never_activates_destination(tmp_path):
    archive, _ = make_archive(tmp_path)
    destination = tmp_path / "cancelled-restore"
    requested = False

    def progress(value):
        nonlocal requested
        requested = value["phase"] == "restore" and value["completedFiles"] >= 2

    with pytest.raises(DomainError) as error:
        backup.restore_backup(archive, destination, reason="Cancellation drill", progress=progress, cancelled=lambda: requested)
    assert error.value.code == "backup_cancelled"
    assert (destination / backup.MARKER_NAME).exists()
    backup.verify_backup(archive)


def test_restore_validates_audit_chain_even_if_outer_hashes_are_updated(tmp_path):
    archive, manifest = make_archive(tmp_path)
    relative = next(entry["path"] for entry in manifest["files"] if entry["path"].startswith("audit/"))
    entry = read_json(archive / relative)
    entry["previousHash"] = "0" * 64
    atomic_json(archive / relative, entry)
    refresh_member_hash(archive, relative)
    with pytest.raises(DomainError) as error:
        backup.restore_backup(archive, tmp_path / "restored", reason="Audit integrity drill")
    assert error.value.code == "audit_integrity"
    assert not (tmp_path / "restored").exists()


def test_no_overwrite_nested_destination_or_fake_reparse_directory(tmp_path, monkeypatch):
    archive, _ = make_archive(tmp_path)
    existing = tmp_path / "existing"
    existing.mkdir()
    sentinel = existing / "keep.json"
    atomic_json(sentinel, {"keep": True})
    for destination in (existing, archive / "nested", tmp_path):
        with pytest.raises(DomainError):
            backup.restore_backup(archive, destination, reason="Invalid destination")
    assert read_json(sentinel) == {"keep": True}
    original = Path.lstat

    def fake_reparse(path, *args, **kwargs):
        value = original(path, *args, **kwargs)
        if path == archive / "records":
            return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=0x400)
        return value

    monkeypatch.setattr(Path, "lstat", fake_reparse)
    with pytest.raises(DomainError, match="reparse"):
        backup.verify_backup(archive)


def test_shard_backup_restore_and_repeat_restore_provenance_chain(tmp_path):
    archive, _ = make_archive(tmp_path)
    first = tmp_path / "first-restore"
    backup.restore_backup(archive, first, reason="First restore")
    recovered = recover_identity(first, reason="Reissue credentials for next drill")
    sharded = tmp_path / "sharded"
    migrate_storage(first, sharded, SEED)
    assert read_json(sharded / backup.PROVENANCE_NAME) == read_json(first / backup.PROVENANCE_NAME)
    second_archive = tmp_path / "shard-backup"
    manifest = backup.create_offline_backup(sharded, second_archive)
    assert manifest["storageLayoutVersion"] == 2
    second = tmp_path / "second-restore"
    result = backup.restore_backup(second_archive, second, reason="Second restore")
    repository = JsonRepository(second, SEED).open()
    identities = IdentityStore(second / "control", None)
    identities.open()
    try:
        assert repository.layout["generation"] == result["workspace"]["generation"]
        assert repository.layout["revision"] == result["workspace"]["revision"]
        assert len(repository.records) == 49
        with pytest.raises(DomainError):
            identities.authenticate(recovered["secret"])
        for path in (second_archive / "shards").glob("*.json"):
            assert (second / "shards" / path.name).read_bytes() == path.read_bytes()
        provenance = read_json(second / backup.PROVENANCE_NAME)
        assert len(provenance["restores"]) == 2
        backup.validate_provenance(provenance)
    finally:
        repository.close()
        identities.close()


@pytest.mark.parametrize("corruption", ["checksum", "workspace", "capacity"])
def test_normal_startup_rejects_invalid_restore_provenance_and_releases_owner(tmp_path, monkeypatch, corruption):
    archive, _ = make_archive(tmp_path)
    destination = tmp_path / "restored"
    backup.restore_backup(archive, destination, reason="Provenance startup drill")
    original = read_json(destination / backup.PROVENANCE_NAME)
    changed = copy.deepcopy(original)
    if corruption == "checksum":
        changed["checksum"] = "0" * 64
    elif corruption == "workspace":
        changed["restores"][-1]["workspaceId"] = "wrong-workspace"
        changed["checksum"] = backup._checksum(changed)
    else:
        from server.app.repositories import json_repository
        monkeypatch.setattr(json_repository, "_JOURNAL_BYTES", 64)
    atomic_json(destination / backup.PROVENANCE_NAME, changed)
    with pytest.raises(DomainError):
        JsonRepository(destination, SEED).open()
    monkeypatch.undo()
    atomic_json(destination / backup.PROVENANCE_NAME, original)
    for _ in range(2):
        repository = JsonRepository(destination, SEED).open()
        assert repository.restore_provenance == original
        repository.close()


def test_live_backup_detects_valid_external_provenance_rewrite(tmp_path):
    archive, _ = make_archive(tmp_path)
    destination = tmp_path / "restored"
    backup.restore_backup(archive, destination, reason="Original provenance")
    credential = recover_identity(destination, reason="Reissue after restore")
    identities = IdentityStore(destination / "control", None)
    identities.open()
    repository = JsonRepository(destination, SEED).open()
    try:
        provenance = read_json(destination / backup.PROVENANCE_NAME)
        provenance["restores"][-1]["reason"] = "Unauthorized external rewrite"
        provenance["checksum"] = backup._checksum(provenance)
        atomic_json(destination / backup.PROVENANCE_NAME, provenance)
        with pytest.raises(DomainError) as error:
            backup.create_live_backup(repository, identities, identities.authenticate(credential["secret"]), tmp_path / "changed-backup")
        assert error.value.code == "external_change" and not repository.available
    finally:
        repository.close()
        identities.close()


def test_backup_restore_cli_real_processes_and_no_secret_output(tmp_path):
    repository, identities, _ = initialized(tmp_path)
    repository.close()
    identities.close()
    archive, destination = tmp_path / "cli-backup", tmp_path / "cli-restored"
    commands = [
        ["scripts/backup-root.py", "create", "--data-root", str(tmp_path / "source"), "--destination", str(archive)],
        ["scripts/backup-root.py", "verify", "--backup", str(archive)],
        ["scripts/restore-root.py", "--backup", str(archive), "--destination", str(destination), "--reason", "CLI recovery drill"],
    ]
    for command in commands:
        result = subprocess.run([sys.executable, *command], cwd=ROOT, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        value = json.loads(result.stdout)
        assert SECRET not in result.stdout and "secretHash" not in result.stdout and "secret" not in value
    assert value["activated"] is False and value["credentialsRequired"] is True


@pytest.mark.parametrize("phase", ["restore", "complete", "after-marker-removal"])
def test_actual_process_exit_during_restore_leaves_incomplete_or_valid_root(tmp_path, phase):
    archive, _ = make_archive(tmp_path)
    destination = tmp_path / "terminated"
    program = """
import os,sys
from pathlib import Path
from server.app.services import backup
source,destination,phase = Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
def progress(value):
    if value['phase'] == phase and (phase != 'restore' or value['completedFiles'] == 3): os._exit(71)
original = backup.sync_directory
def sync(path):
    original(path)
    if phase == 'after-marker-removal' and path == destination and not (destination/backup.MARKER_NAME).exists(): os._exit(71)
backup.sync_directory = sync
backup.restore_backup(source,destination,reason='Process-exit recovery drill',progress=progress)
"""
    result = subprocess.run([sys.executable, "-c", program, str(archive), str(destination), phase], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 71, result.stderr
    for _ in range(2):
        if phase == "after-marker-removal":
            repository = JsonRepository(destination, SEED).open()
            assert len(repository.records) == 49
            repository.close()
            identities = IdentityStore(destination / "control", None)
            identities.open()
            assert all(token["revokedAt"] is not None for token in identities.state["tokens"])
            identities.close()
        else:
            with pytest.raises(RuntimeError, match="incomplete"):
                JsonRepository(destination, SEED).open()
    backup.verify_backup(archive)


@pytest.mark.parametrize("phase", ["copy", "publish", "after-manifest"])
def test_actual_process_exit_during_backup_preserves_source_and_complete_marker_rules(tmp_path, phase):
    repository, identities, _ = initialized(tmp_path)
    repository.close()
    identities.close()
    source, destination = tmp_path / "source", tmp_path / "terminated-backup"
    before = json_files(source)
    program = """
import os,sys
from pathlib import Path
from server.app.services import backup
source,destination,phase=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
def progress(value):
    if value['phase'] == phase and (phase != 'copy' or value['completedFiles'] == 3): os._exit(72)
original=backup.sync_directory
def sync(path):
    original(path)
    if phase == 'after-manifest' and path == destination and (destination/backup.MANIFEST_NAME).exists(): os._exit(72)
import server.app.repositories.json_repository as repository
repository.sync_directory=sync
backup.create_offline_backup(source,destination,progress=progress)
"""
    result = subprocess.run([sys.executable, "-c", program, str(source), str(destination), phase], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert result.returncode == 72, result.stderr
    assert json_files(source) == before
    if phase == "after-manifest":
        backup.verify_backup(destination)
    else:
        with pytest.raises(DomainError):
            backup.verify_backup(destination)
    for _ in range(2):
        repository = JsonRepository(source, SEED).open()
        repository.close()
        with pytest.raises(RuntimeError, match="incomplete"):
            JsonRepository(destination, SEED).open()
