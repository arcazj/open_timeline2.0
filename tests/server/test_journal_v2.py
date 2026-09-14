import copy
import os
import subprocess
import sys
from types import SimpleNamespace
import stat

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, json_bytes, read_json
from server.app.repositories import json_repository as storage

SEED = ROOT / "data/default-dataset.json"


def open_repo(tmp_path):
    return storage.JsonRepository(tmp_path / "data", SEED).open()


def disk_documents(root):
    return {str(path.relative_to(root)): read_json(path) for path in root.rglob("*.json")
            if path.name != "transaction.json"}


def inject_phase(repo, monkeypatch, phase):
    writer, installer, cleaner = repo._write_journal, repo._install, repo._cleanup_journal
    count = 0

    def fault():
        raise OSError("Injected transaction boundary failure")

    def write(journal):
        state = journal["state"]
        if phase == state + "-before":
            fault()
        writer(journal)
        if phase == state + "-after":
            fault()

    def install(relative, document):
        nonlocal count
        count += 1
        if phase == f"install-{count}-before":
            fault()
        installer(relative, document)
        if phase == f"install-{count}-after":
            fault()

    def clean():
        if phase == "cleanup-before":
            fault()
        cleaner()
        if phase == "cleanup-after":
            fault()

    monkeypatch.setattr(repo, "_write_journal", write)
    monkeypatch.setattr(repo, "_install", install)
    monkeypatch.setattr(repo, "_cleanup_journal", clean)


PHASES = ["prepared-before", "prepared-after", "install-1-before", "install-1-after", "install-2-before",
          "install-2-after", "install-3-before", "install-3-after", "committed-before", "committed-after",
          "cleanup-before", "cleanup-after"]


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize("phase", PHASES)
def test_every_boundary_recovers_exactly_old_or_new_state_twice(tmp_path, monkeypatch, operation, phase):
    repo = open_repo(tmp_path)
    original = disk_documents(repo.root)
    generation = repo.meta["manifest"]["generation"]
    record = next(iter(repo.records.values()))
    target = record["id"] if operation == "update" else None
    etag = f'"{generation}:{record["version"]}"' if target else None
    inject_phase(repo, monkeypatch, phase)
    if phase.startswith("cleanup"):
        result = repo.mutate(operation, target, {"title": "New committed title"}, generation, etag, "phase", "trusted-actor")
        assert result["revision"] == 2 and repo.available
    else:
        with pytest.raises(DomainError) as error:
            repo.mutate(operation, target, {"title": "New committed title"}, generation, etag, "phase", "trusted-actor")
        assert error.value.code == "commit_outcome_unknown"
        assert not repo.available
    if phase not in ("prepared-before", "cleanup-after"):
        journal = read_json(repo.root / "transaction.json")
        assert journal["formatVersion"] == 2
        assert journal["checksum"] == storage._journal_checksum(journal)
        assert set(journal["before"]) == set(journal["after"])
    repo.close()
    committed = phase == "committed-after" or phase.startswith("cleanup")
    recovered_documents = None
    for _ in range(2):
        recovered = open_repo(tmp_path)
        try:
            if committed:
                outcome = recovered.command_outcome("trusted-actor", "phase")
                assert outcome["revision"] == 2
                assert recovered.get_record(outcome["record"]["id"])["title"] == "New committed title"
                assert recovered.mutate(operation, target, {"title": "New committed title"}, generation, etag,
                                        "phase", "trusted-actor") == outcome
            else:
                with pytest.raises(DomainError) as error:
                    recovered.command_outcome("trusted-actor", "phase")
                assert error.value.code == "command_not_found"
                assert disk_documents(recovered.root) == original
            assert not (recovered.root / "transaction.json").exists()
            current = disk_documents(recovered.root)
            if recovered_documents is not None:
                assert current == recovered_documents
            recovered_documents = current
        finally:
            recovered.close()


def prepared_fixture(tmp_path, monkeypatch, state="prepared"):
    repo = open_repo(tmp_path)
    original = disk_documents(repo.root)
    inject_phase(repo, monkeypatch, state + "-after")
    with pytest.raises(DomainError):
        repo.mutate("create", None, {"title": "Recoverable"}, repo.meta["manifest"]["generation"], None, "recover", "actor")
    repo.close()
    return repo, original, read_json(repo.root / "transaction.json")


@pytest.mark.parametrize("state", ["prepared", "committed"])
@pytest.mark.parametrize("kind", ["workspace", "record", "outcome"])
def test_missing_targets_are_reconstructed_by_selected_state(tmp_path, monkeypatch, state, kind):
    repo, original, journal = prepared_fixture(tmp_path, monkeypatch, state)
    relative = next(key for key in journal["after"] if key.startswith(kind))
    (repo.root / relative).unlink(missing_ok=True)
    for _ in range(2):
        recovered = open_repo(tmp_path)
        try:
            assert recovered.metadata()["revision"] == (2 if state == "committed" else 1)
            if state == "prepared":
                assert disk_documents(recovered.root) == original
            else:
                assert recovered.command_outcome("actor", "recover")["revision"] == 2
        finally:
            recovered.close()


@pytest.mark.parametrize("mutation", ["checksum", "image", "path", "version", "revision", "keys", "null-image"])
def test_invalid_journal_never_installs_any_target(tmp_path, monkeypatch, mutation):
    repo, original, journal = prepared_fixture(tmp_path, monkeypatch)
    if mutation == "checksum":
        journal["checksum"] = "0" * 64
    elif mutation == "image":
        journal["after"]["workspace.json"]["sha256"] = "0" * 64
    elif mutation == "path":
        for images in (journal["before"], journal["after"]):
            images["../outside.json"] = storage._document_image({"unsafe": True})
    elif mutation == "version":
        journal["formatVersion"] = 3
    elif mutation == "revision":
        changed = journal["after"]["workspace.json"]["document"]
        changed["manifest"]["revision"] = 99
        journal["after"]["workspace.json"] = storage._document_image(changed)
    elif mutation == "keys":
        journal["before"].pop("workspace.json")
    else:
        journal["after"]["workspace.json"] = {"exists": True, "document": None, "sha256": None}
    if mutation != "checksum":
        journal["checksum"] = storage._journal_checksum(journal)
    storage.atomic_json(repo.root / "transaction.json", journal)
    evidence = (repo.root / "transaction.json").read_bytes()
    with pytest.raises((RuntimeError, DomainError)):
        open_repo(tmp_path)
    assert disk_documents(repo.root) == original
    assert (repo.root / "transaction.json").read_bytes() == evidence
    assert not (tmp_path / "outside.json").exists()


@pytest.mark.parametrize("state", ["prepared", "committed"])
def test_newer_or_foreign_target_fails_preflight_without_recovery_overwrite(tmp_path, monkeypatch, state):
    repo, _, journal = prepared_fixture(tmp_path, monkeypatch, state)
    newer = copy.deepcopy(journal["after"]["workspace.json"]["document"])
    newer["manifest"]["revision"] = 99
    storage.atomic_json(repo.root / "workspace.json", newer)
    before = disk_documents(repo.root)
    with pytest.raises(RuntimeError, match="conflicts"):
        open_repo(tmp_path)
    assert disk_documents(repo.root) == before
    assert (repo.root / "transaction.json").exists()


def test_interrupted_rollback_is_itself_idempotent(tmp_path, monkeypatch):
    repo = open_repo(tmp_path)
    original = disk_documents(repo.root)
    inject_phase(repo, monkeypatch, "install-3-after")
    with pytest.raises(DomainError):
        repo.mutate("create", None, {"title": "Rollback"}, repo.meta["manifest"]["generation"], None, "rollback", "actor")
    repo.close()
    interrupted = storage.JsonRepository(repo.root, SEED)
    install = interrupted._install
    count = 0

    def fail_second(relative, document):
        nonlocal count
        count += 1
        install(relative, document)
        if count == 2:
            raise OSError("Interrupted rollback")

    monkeypatch.setattr(interrupted, "_install", fail_second)
    with pytest.raises(OSError):
        interrupted.open()
    assert interrupted.owner is None
    assert (repo.root / "transaction.json").exists()
    for _ in range(2):
        recovered = open_repo(tmp_path)
        assert disk_documents(recovered.root) == original
        recovered.close()


def test_cleanup_failure_does_not_invalidate_commit_and_is_reconciled_before_next_write(tmp_path, monkeypatch):
    repo = open_repo(tmp_path)
    cleanup = repo._cleanup_journal
    monkeypatch.setattr(repo, "_cleanup_journal", lambda: (_ for _ in ()).throw(OSError("cleanup denied")))
    generation = repo.meta["manifest"]["generation"]
    first = repo.mutate("create", None, {"title": "Acknowledged"}, generation, None, "first", "actor")
    assert first["revision"] == 2 and repo.available
    assert read_json(repo.root / "transaction.json")["state"] == "committed"
    monkeypatch.setattr(repo, "_cleanup_journal", cleanup)
    second = repo.mutate("create", None, {"title": "Next"}, generation, None, "second", "actor")
    assert second["revision"] == 3 and repo.command_outcome("actor", "first") == first
    assert not (repo.root / "transaction.json").exists()
    repo.close()


def test_envelope_admission_rejects_before_preparation_without_freezing(tmp_path, monkeypatch):
    repo = open_repo(tmp_path)
    before = disk_documents(repo.root)
    monkeypatch.setattr(storage, "_JOURNAL_BYTES", 2048)
    with pytest.raises(DomainError) as error:
        repo.mutate("create", None, {"title": "Too much"}, repo.meta["manifest"]["generation"], None, "large", "actor")
    assert error.value.code == "journal_capacity"
    assert repo.available and disk_documents(repo.root) == before
    assert not (repo.root / "transaction.json").exists()
    repo.close()


def test_external_edit_is_not_overwritten_and_audit_uses_trusted_principal(tmp_path):
    repo = open_repo(tmp_path)
    generation = repo.meta["manifest"]["generation"]
    result = repo.mutate("create", None, {"title": "Owned"}, generation, None, "create", "actor-one")
    record = result["record"]
    assert record["createdBy"] == record["updatedBy"] == "actor-one"
    for operation in ("update", "delete", "restore"):
        result = repo.mutate(operation, record["id"], {"title": "Updated"} if operation == "update" else {},
                             generation, f'"{generation}:{record["version"]}"', operation, "actor-two")
        record = result["record"]
        assert record["createdBy"] == "actor-one" and record["updatedBy"] == "actor-two"
    path = repo.root / "records" / (record["id"] + ".json")
    changed = {**record, "title": "External edit"}
    storage.atomic_json(path, changed)
    with pytest.raises(DomainError) as error:
        repo.mutate("update", record["id"], {"title": "Must not overwrite"}, generation,
                     f'"{generation}:{record["version"]}"', "external", "actor-two")
    assert error.value.code == "external_change" and not repo.available
    assert read_json(path) == changed
    assert not (repo.root / "transaction.json").exists()
    repo.close()


@pytest.mark.parametrize("state", ["prepared", "committed"])
def test_legacy_v1_keeps_original_recovery_meaning(tmp_path, state):
    repo = open_repo(tmp_path)
    changed = copy.deepcopy(repo.meta)
    changed["manifest"]["revision"] = 2
    storage.atomic_json(repo.root / "transaction.json", {"formatVersion": 1, "state": state,
                                                         "after": {"workspace.json": changed}})
    repo.close()
    for _ in range(2):
        recovered = open_repo(tmp_path)
        assert recovered.meta["manifest"]["revision"] == (2 if state == "committed" else 1)
        recovered.close()


@pytest.mark.parametrize("phase", ["prepared", "install-1", "install-3", "committed", "cleanup"])
def test_process_exit_at_real_transaction_boundaries(tmp_path, phase):
    repo = open_repo(tmp_path)
    original = disk_documents(repo.root)
    repo.close()
    program = """
import os, sys
from pathlib import Path
from server.app.repositories.json_repository import JsonRepository
repo = JsonRepository(Path(sys.argv[1]), Path(sys.argv[2])).open()
phase = sys.argv[3]
write, install, clean = repo._write_journal, repo._install, repo._cleanup_journal
counter = 0
def crash_write(journal):
    write(journal)
    if phase == journal['state']:
        os._exit(79)
def crash_install(relative, document):
    global counter
    install(relative, document)
    counter += 1
    if phase == 'install-' + str(counter):
        os._exit(79)
def crash_clean():
    if phase == 'cleanup':
        os._exit(79)
    clean()
repo._write_journal, repo._install, repo._cleanup_journal = crash_write, crash_install, crash_clean
repo.mutate('create', None, {'title':'Process interruption'}, repo.meta['manifest']['generation'], None, 'exit', 'actor')
"""
    completed = subprocess.run([sys.executable, "-c", program, str(repo.root), str(SEED), phase], cwd=ROOT,
                               capture_output=True, text=True, timeout=30)
    assert completed.returncode == 79, completed.stderr
    for _ in range(2):
        recovered = open_repo(tmp_path)
        try:
            if phase in ("committed", "cleanup"):
                assert recovered.command_outcome("actor", "exit")["revision"] == 2
            else:
                assert disk_documents(recovered.root) == original
        finally:
            recovered.close()


def test_raw_record_size_and_changed_descriptor_are_rejected(tmp_path, monkeypatch):
    path = tmp_path / "record.json"
    path.write_bytes(b" " * (storage._RECORD_FILE_BYTES + 1))
    with pytest.raises(DomainError) as error:
        storage._read_record_file(path)
    assert error.value.code == "record_file_capacity"
    path.write_bytes(json_bytes({"value": "stable"}))
    original = os.fstat
    calls = 0

    def changed(descriptor):
        nonlocal calls
        calls += 1
        if calls == 2:
            with path.open("ab") as stream:
                stream.write(b" ")
        return original(descriptor)

    monkeypatch.setattr(storage.os, "fstat", changed)
    with pytest.raises(DomainError) as error:
        storage._read_record_file(path)
    assert error.value.code == "storage_integrity"


def test_record_symlink_and_recovery_parent_symlink_are_rejected(tmp_path):
    target = tmp_path / "target.json"
    target.write_text("{}", encoding="utf-8")
    link = tmp_path / "link.json"
    try:
        link.symlink_to(target)
    except OSError as error:
        pytest.skip(f"Platform does not permit test symlink creation: {error}")
    with pytest.raises(DomainError):
        storage._read_record_file(link)
    root = tmp_path / "linked-root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "records").symlink_to(outside, target_is_directory=True)
    repo = storage.JsonRepository(root, SEED)
    with pytest.raises(RuntimeError):
        repo._checked_path("records/00000000-0000-0000-0000-000000000000.json")
    assert not list(outside.iterdir())


def test_reparse_attributes_are_rejected_without_opening_a_descriptor():
    class ReparseFile:
        def lstat(self):
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)

        def open(self, *args):
            raise AssertionError("A reparse-point descriptor must not be opened")

    with pytest.raises(DomainError) as error:
        storage._read_record_file(ReparseFile())
    assert error.value.code == "storage_integrity"


@pytest.mark.parametrize("phase", ["prepared", "partial-install", "committed"])
def test_interrupted_initial_seed_recovers_before_readiness_twice(tmp_path, monkeypatch, phase):
    repo = storage.JsonRepository(tmp_path / "data", SEED)
    write, install = repo._write_journal, repo._install
    count = 0

    def crash_write(journal):
        write(journal)
        if journal["state"] == phase:
            raise OSError("Seed marker interruption")

    def crash_install(relative, document):
        nonlocal count
        install(relative, document)
        count += 1
        if phase == "partial-install" and count == 10:
            raise OSError("Seed installation interruption")

    monkeypatch.setattr(repo, "_write_journal", crash_write)
    monkeypatch.setattr(repo, "_install", crash_install)
    with pytest.raises(OSError):
        repo.open()
    assert repo.owner is None and not repo.available
    for _ in range(2):
        recovered = open_repo(tmp_path)
        assert len(recovered.records) == 48 and recovered.meta["manifest"]["revision"] == 1
        assert not (repo.root / "transaction.json").exists()
        recovered.close()


def test_oversized_authoritative_record_fails_startup_and_releases_owner(tmp_path):
    repo = open_repo(tmp_path)
    path = next((repo.root / "records").glob("*.json"))
    repo.close()
    path.write_bytes(b" " * (storage._RECORD_FILE_BYTES + 1))
    failed = storage.JsonRepository(repo.root, SEED)
    with pytest.raises(DomainError) as error:
        failed.open()
    assert error.value.code == "record_file_capacity"
    assert failed.owner is None and not failed.available
    assert path.stat().st_size == storage._RECORD_FILE_BYTES + 1
