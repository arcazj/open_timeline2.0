import copy
import os
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import ROOT
from server.app.main import create_app
from server.app.models.domain import DomainError, read_json
from server.app.repositories import integrity_monitor as monitoring
from server.app.repositories.json_repository import JsonRepository, atomic_json
from server.app.repositories.storage_migration import migrate_storage
from server.app.services.backup import create_offline_backup, restore_backup
from server.app.services.identity import IdentityStore

SEED = ROOT / "data/default-dataset.json"
SECRET = "integrity-monitor-test-token"


@pytest.fixture
def repository(tmp_path, monkeypatch):
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 60)
    repository = JsonRepository(tmp_path / "root", SEED).open()
    generation = repository.meta["manifest"]["generation"]
    repository.mutate("create", None, {"title": "An audited record"}, generation, None, "created", "actor")
    yield repository
    repository.close()


def path_for(repository, kind):
    if kind == "record":
        return "records/" + next(iter(repository.records)) + ".json"
    if kind == "outcome":
        return repository._outcome_path("actor", "created").relative_to(repository.root).as_posix()
    if kind == "audit":
        return next(iter(repository.audit_entries))
    return {"workspace": "workspace.json", "audit-state": "audit-state.json"}[kind]


@pytest.mark.parametrize("kind", ["record", "outcome", "audit", "workspace", "audit-state"])
@pytest.mark.parametrize("operation", ["edit", "delete"])
def test_untouched_authority_edit_or_deletion_freezes_workspace(repository, kind, operation):
    relative = path_for(repository, kind)
    path = repository.root / relative
    if operation == "edit":
        path.write_bytes(path.read_bytes() + b" ")
    else:
        path.unlink()
    with pytest.raises(DomainError) as error:
        repository.integrity.check_file(relative)
    assert error.value.code == "external_change" and not repository.available
    assert repository.integrity.failure["path"] == relative
    with pytest.raises(DomainError):
        repository.query_snapshot()


def test_complete_hash_detects_equal_length_edit_even_with_forged_unchanged_stat(repository, monkeypatch):
    relative = path_for(repository, "record")
    path = repository.root / relative
    original_stat = path.lstat()
    raw = path.read_bytes()
    index = raw.index(b'"title":')
    offset = index + len(b'"title":"')
    changed = raw[:offset] + (b"Z" if raw[offset:offset + 1] != b"Z" else b"X") + raw[offset + 1:]
    path.write_bytes(changed)
    os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    original_lstat = Path.lstat

    def unchanged_stat(target, *args, **kwargs):
        return original_stat if target == path else original_lstat(target, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", unchanged_stat)
    with pytest.raises(DomainError):
        repository.integrity.check_file(relative)
    assert not repository.available


@pytest.mark.parametrize("relative", ["unregistered.json", "records/unknown.json", "audit/wrong.json", "jobs/job.json",
                                      ".workspace.json." + "0" * 32 + ".tmp"])
def test_unknown_authoritative_json_is_not_silently_ignored(repository, relative):
    atomic_json(repository.root / relative, {"unexpected": True})
    for _ in range(10):
        try:
            repository.integrity.scan_slice()
        except DomainError:
            break
    assert not repository.available
    assert repository.integrity.failure is not None


def test_control_owner_writes_and_own_atomic_writes_do_not_trigger_drift(repository):
    identities = IdentityStore(repository.root / "control", SECRET)
    identities.open()
    try:
        for index in range(8):
            generation = repository.meta["manifest"]["generation"]
            record = repository.mutate("create", None, {"title": f"Owned {index}"}, generation, None, f"create-{index}", "actor")["record"]
            repository.mutate("update", record["id"], {"title": f"Changed {index}"}, generation,
                              f'"{generation}:{record["version"]}"', f"update-{index}", "actor")
            repository.integrity.scan_slice()
            assert repository.available
        for relative in list(repository.integrity.expected):
            repository.integrity.check_file(relative)
        assert repository.available
        assert not any(path.startswith("control/") for path in repository.integrity.expected)
    finally:
        identities.close()


def test_an_own_commit_invalidates_a_concurrent_old_file_observation(repository, monkeypatch):
    relative = path_for(repository, "record")
    path = repository.root / relative
    entered, release = threading.Event(), threading.Event()
    original_lock = repository.integrity.observation_lock
    errors = []

    class DelayedObservationLock:
        def acquire(self, *args, **kwargs):
            if threading.current_thread().name == "test-integrity-read":
                entered.set()
                assert release.wait(3)
            return original_lock.acquire(*args, **kwargs)

        def release(self):
            original_lock.release()

        def __enter__(self):
            return self.acquire()

        def __exit__(self, *args):
            self.release()

    def observe():
        try:
            repository.integrity.check_file(relative)
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(repository.integrity, "observation_lock", DelayedObservationLock())
    worker = threading.Thread(target=observe, name="test-integrity-read")
    worker.start()
    try:
        assert entered.wait(3)
        record = repository.records[path.stem]
        generation = repository.meta["manifest"]["generation"]
        repository.mutate("update", record["id"], {"title": "Committed during the read"}, generation,
                          f'"{generation}:{record["version"]}"', "race", "actor")
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and not errors and repository.available
    repository.integrity.check_file(relative)


def test_owned_atomic_replacement_drains_the_open_monitor_handle(repository, monkeypatch):
    relative = path_for(repository, "record")
    path = repository.root / relative
    original_open = monitoring.open_observation
    entered, release, written = threading.Event(), threading.Event(), threading.Event()
    errors = []

    def held_open(target):
        stream = original_open(target)
        if target == path and threading.current_thread().name == "test-held-observation":
            entered.set()
            if not release.wait(5):
                stream.close()
                raise TimeoutError("Test monitor handle was not released")
        return stream

    def observe():
        try:
            repository.integrity.check_file(relative)
        except BaseException as error:
            errors.append(error)

    def write():
        try:
            record = repository.records[path.stem]
            generation = repository.meta["manifest"]["generation"]
            repository.mutate("update", record["id"], {"title": "Replaced after draining observation handle"}, generation,
                              f'"{generation}:{record["version"]}"', "held-handle", "actor")
        except BaseException as error:
            errors.append(error)
        finally:
            written.set()

    monkeypatch.setattr(monitoring, "open_observation", held_open)
    worker = threading.Thread(target=observe, name="test-held-observation")
    writer = threading.Thread(target=write, name="test-held-writer")
    worker.start()
    try:
        assert entered.wait(3)
        writer.start()
        assert not written.wait(0.1)
    finally:
        release.set()
        worker.join(5)
        if writer.ident is not None:
            writer.join(5)
    assert not worker.is_alive() and not writer.is_alive() and not errors and repository.available
    repository.integrity.check_file(relative)


def test_registry_admission_rejects_before_prepared_and_keeps_healthy_root(repository, monkeypatch):
    before = copy.deepcopy(repository.meta)
    monkeypatch.setattr(monitoring, "REGISTRY_BYTES", repository.integrity.registry_bytes)
    with pytest.raises(DomainError) as error:
        repository.mutate("create", None, {"title": "Cannot fit registry"}, before["manifest"]["generation"], None, "capacity", "actor")
    assert error.value.code == "integrity_capacity" and error.value.status == 413
    assert repository.meta == before and repository.available
    assert not (repository.root / "transaction.json").exists()
    assert not repository._outcome_path("actor", "capacity").exists()


def test_readonly_outcome_lookup_checks_bytes_before_exposing_result(repository):
    relative = path_for(repository, "outcome")
    outcome = read_json(repository.root / relative)
    outcome["result"]["record"]["title"] = "Untrusted result"
    atomic_json(repository.root / relative, outcome)
    with pytest.raises(DomainError) as error:
        repository.command_outcome("actor", "created")
    assert error.value.code == "external_change" and not repository.available


@pytest.mark.parametrize("raw", [b"{broken", b"\xff", b'{"duplicate":1,"duplicate":2}'])
def test_malformed_admitted_outcome_returns_unavailable_not_a_client_validation_error(repository, raw):
    relative = path_for(repository, "outcome")
    (repository.root / relative).write_bytes(raw)
    with pytest.raises(DomainError) as error:
        repository.command_outcome("actor", "created")
    assert error.value.code == "external_change" and error.value.status == 503
    assert repository.integrity.failure["path"] == relative and not repository.available


def test_monitor_thread_failure_and_close_while_holding_mutex_are_fail_closed(repository, monkeypatch):
    original_monitor = repository.integrity
    original_monitor.stop.set()
    original_monitor.thread.join()
    original_monitor.stop.clear()
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 0.005)

    def fail():
        raise OSError("Injected scanner failure")

    monkeypatch.setattr(original_monitor, "scan_slice", fail)
    original_monitor.start()
    deadline = time.monotonic() + 3
    while repository.available and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not repository.available
    assert original_monitor.failure["code"] == "integrity_monitor_failed"
    with repository.mutex:
        repository.close()
    assert not original_monitor.thread.is_alive()


def test_double_open_cannot_abandon_live_monitor_or_owner(repository):
    thread = repository.integrity.thread
    with pytest.raises(RuntimeError, match="active writer"):
        repository.open()
    assert thread.is_alive() and repository.available


def test_failed_monitor_thread_start_releases_writer_ownership(tmp_path, monkeypatch):
    repository = JsonRepository(tmp_path / "thread-start", SEED)
    original_start = threading.Thread.start

    def fail_start(thread):
        if thread.name == "timeline-integrity":
            raise RuntimeError("Injected thread-start failure")
        return original_start(thread)

    monkeypatch.setattr(threading.Thread, "start", fail_start)
    with pytest.raises(RuntimeError, match="Injected thread-start failure"):
        repository.open()
    assert repository.owner is None and repository.integrity is None and not repository.available
    monkeypatch.setattr(threading.Thread, "start", original_start)
    recovered = JsonRepository(repository.root, SEED).open()
    recovered.close()


def test_normal_startup_validates_existing_outcomes_before_readiness(tmp_path):
    repository = JsonRepository(tmp_path / "root", SEED).open()
    repository.mutate("create", None, {"title": "Existing outcome"}, repository.meta["manifest"]["generation"], None, "one", "actor")
    path = repository._outcome_path("actor", "one")
    repository.close()
    original = read_json(path)
    atomic_json(path, {**original, "clientCommandId": "does-not-match-path"})
    with pytest.raises(DomainError):
        JsonRepository(tmp_path / "root", SEED).open()
    atomic_json(path, original)
    reopened = JsonRepository(tmp_path / "root", SEED).open()
    reopened.close()


def test_restored_provenance_is_in_the_monitor_registry(tmp_path, monkeypatch):
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 60)
    source = tmp_path / "source"
    repository = JsonRepository(source, SEED).open()
    repository.close()
    identities = IdentityStore(source / "control", SECRET)
    identities.open()
    identities.close()
    create_offline_backup(source, tmp_path / "backup")
    restore_backup(tmp_path / "backup", tmp_path / "restored", reason="Monitor provenance drill")
    repository = JsonRepository(tmp_path / "restored", SEED).open()
    try:
        assert "restore-provenance.json" in repository.integrity.expected
        (repository.root / "restore-provenance.json").unlink()
        with pytest.raises(DomainError):
            repository.integrity.check_file("restore-provenance.json")
    finally:
        repository.close()


def test_live_monitor_marks_health_unready_after_untouched_record_deletion(tmp_path, monkeypatch):
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 0.01)
    app = create_app(data_root=tmp_path / "api", token=SECRET, seed_path=SEED)
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        path = next((tmp_path / "api/records").glob("*.json"))
        path.unlink()
        deadline = time.monotonic() + 3
        while client.get("/health/ready").status_code == 200 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert client.get("/health/ready").status_code == 503


def test_directory_enumeration_is_bounded_and_round_robins_all_owners(repository, monkeypatch):
    original_scandir = monitoring.os.scandir
    advances, seen = [], set()

    class CountingIterator:
        def __init__(self, path):
            self.iterator = original_scandir(path)
            self.path = Path(path)

        def __next__(self):
            advances.append(self.path)
            seen.add(self.path)
            return next(self.iterator)

        def close(self):
            self.iterator.close()

    monkeypatch.setattr(monitoring.os, "scandir", CountingIterator)
    monkeypatch.setattr(monitoring, "FILES_PER_SLICE", 3)
    for _ in range(20):
        before = len(advances)
        repository.integrity._directory_slice()
        assert len(advances) - before <= 3
    assert seen == {repository.root, repository.root / "records", repository.root / "outcomes", repository.root / "audit"}
    assert repository.available


def test_writer_lock_disappearance_is_checked_even_without_a_directory_entry(repository, monkeypatch):
    original_lstat = Path.lstat
    lock_path = repository.root / ".writer.lock"

    def missing_lock(path, *args, **kwargs):
        if path == lock_path:
            raise FileNotFoundError(path)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", missing_lock)
    with pytest.raises(DomainError) as error:
        repository.integrity._directory_slice()
    assert error.value.code == "external_change"
    assert repository.integrity.failure["path"] == ".writer.lock"


def test_unsafe_writer_lock_is_rejected_before_open(tmp_path):
    root = tmp_path / "unsafe-owner"
    (root / ".writer.lock").mkdir(parents=True)
    repository = JsonRepository(root, SEED)
    with pytest.raises(DomainError) as error:
        repository.open()
    assert error.value.code == "storage_integrity"
    assert repository.owner is None and not (root / "workspace.json").exists()


def test_retained_journal_registry_accounting_survives_cleanup_and_next_commit(repository, monkeypatch):
    cleanup = repository._cleanup_journal

    def retained():
        raise OSError("Injected cleanup failure")

    monkeypatch.setattr(repository, "_cleanup_journal", retained)
    generation = repository.meta["manifest"]["generation"]
    repository.mutate("create", None, {"title": "Retained journal"}, generation, None, "retained", "actor")
    assert repository.available and "transaction.json" in repository.integrity.expected
    assert repository.integrity.registry_bytes == 512 + sum(monitoring._cost(path) for path in repository.integrity.expected)
    repository.integrity.check_file("transaction.json")
    monkeypatch.setattr(repository, "_cleanup_journal", cleanup)
    repository.mutate("create", None, {"title": "Following commit"}, generation, None, "following", "actor")
    assert repository.available and "transaction.json" not in repository.integrity.expected
    assert repository.integrity.registry_bytes == 512 + sum(monitoring._cost(path) for path in repository.integrity.expected)
    repository.integrity.scan_slice()


def test_missing_admitted_journal_cannot_be_hidden_by_a_later_commit(repository, monkeypatch):
    cleanup = repository._cleanup_journal

    def retained():
        raise OSError("Injected cleanup failure")

    monkeypatch.setattr(repository, "_cleanup_journal", retained)
    generation = repository.meta["manifest"]["generation"]
    repository.mutate("create", None, {"title": "Retained journal"}, generation, None, "retained", "actor")
    previous = copy.deepcopy(repository.meta)
    (repository.root / "transaction.json").unlink()
    monkeypatch.setattr(repository, "_cleanup_journal", cleanup)
    with pytest.raises(DomainError) as error:
        repository.mutate("create", None, {"title": "Must not commit"}, generation, None, "not-committed", "actor")
    assert error.value.code == "external_change" and not repository.available
    assert repository.meta == previous
    assert not repository._outcome_path("actor", "not-committed").exists()


def test_shutdown_joins_an_inflight_monitor_read_before_releasing_owner(repository, monkeypatch):
    monitor = repository.integrity
    monitor.stop.set()
    monitor.thread.join()
    monitor.stop.clear()
    original_open = monitoring.open_observation
    path = repository.root / monitor.paths[0]
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    errors = []

    def slow_open(target, *args, **kwargs):
        if target == path and threading.current_thread().name == "timeline-integrity":
            entered.set()
            assert release.wait(5)
        return original_open(target, *args, **kwargs)

    def close_owned():
        try:
            with repository.mutex:
                repository.close()
        except BaseException as error:
            errors.append(error)
        finally:
            closed.set()

    monkeypatch.setattr(monitoring, "open_observation", slow_open)
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 0.005)
    monitor.start()
    closer = threading.Thread(target=close_owned)
    try:
        assert entered.wait(3)
        closer.start()
        assert not closed.wait(0.1) and repository.owner is not None
    finally:
        release.set()
        if closer.ident is not None:
            closer.join(5)
        monitor.thread.join(5)
    assert not errors and closed.is_set() and not monitor.thread.is_alive()
    assert repository.owner is None


def test_shutdown_drains_an_inflight_commit_before_releasing_owner(repository, monkeypatch):
    original_install = repository._install
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    errors = []

    def slow_install(relative, document):
        if relative.startswith("records/"):
            entered.set()
            assert release.wait(5)
        return original_install(relative, document)

    def write():
        try:
            repository.mutate("create", None, {"title": "Commit drained on close"},
                              repository.meta["manifest"]["generation"], None, "drained", "actor")
        except BaseException as error:
            errors.append(error)

    def close():
        try:
            repository.close()
        except BaseException as error:
            errors.append(error)
        finally:
            closed.set()

    monkeypatch.setattr(repository, "_install", slow_install)
    writer, closer = threading.Thread(target=write), threading.Thread(target=close)
    writer.start()
    try:
        assert entered.wait(3)
        closer.start()
        assert not closed.wait(0.1) and repository.owner is not None
    finally:
        release.set()
        writer.join(5)
        if closer.ident is not None:
            closer.join(5)
    assert not errors and not writer.is_alive() and not closer.is_alive() and closed.is_set()
    assert repository.owner is None
    recovered = JsonRepository(repository.root, SEED).open()
    try:
        assert recovered.command_outcome("actor", "drained")["record"]["title"] == "Commit drained on close"
    finally:
        recovered.close()


@pytest.mark.parametrize("kind", ["shard", "layout"])
@pytest.mark.parametrize("operation", ["edit", "delete"])
def test_untouched_shard_or_layout_drift_freezes_workspace(tmp_path, monkeypatch, kind, operation):
    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 60)
    source, destination = tmp_path / "source", tmp_path / "sharded"
    repository = JsonRepository(source, SEED).open()
    repository.close()
    migrate_storage(source, destination, SEED)
    repository = JsonRepository(destination, SEED).open()
    try:
        relative = repository.layout["buckets"][0]["path"] if kind == "shard" else "storage-layout.json"
        path = destination / relative
        if operation == "edit":
            path.write_bytes(path.read_bytes() + b" ")
        else:
            path.unlink()
        with pytest.raises(DomainError) as error:
            repository.integrity.check_file(relative)
        assert error.value.code == "external_change" and not repository.available
    finally:
        repository.close()


def test_live_scans_accept_owned_shard_splits_and_audit_appends(tmp_path, monkeypatch):
    from server.app.repositories import json_shards

    monkeypatch.setattr(monitoring, "PAUSE_SECONDS", 0.005)
    monkeypatch.setattr(json_shards, "SHARD_BYTES", 4096)
    source, destination = tmp_path / "source", tmp_path / "sharded"
    repository = JsonRepository(source, SEED).open()
    repository.close()
    migrate_storage(source, destination, SEED)
    repository = JsonRepository(destination, SEED).open()
    try:
        initial_shards = len(repository.shards)
        generation = repository.meta["manifest"]["generation"]
        for index in range(16):
            repository.mutate("create", None, {"title": str(index) + "A" * 490}, generation, None, f"split-{index}", "actor")
        assert len(repository.shards) > initial_shards
        repository.integrity.close()
        repository.integrity.stop.clear()
        for relative in list(repository.integrity.expected):
            repository.integrity.check_file(relative)
        repository.integrity._directory_slice()
        assert repository.available and repository.integrity.failure is None
        assert len(repository.audit_entries) == 16
    finally:
        repository.close()
