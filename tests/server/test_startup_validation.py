import copy
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from server.app.models import domain
from server.app.repositories import json_repository as storage


def existing_root(tmp_path, bundle):
    root = tmp_path / "data"
    for record in bundle["records"]:
        storage.atomic_json(root / "records" / f"{record['id']}.json", record)
    metadata = {key: value for key, value in bundle.items() if key != "records"}
    storage.atomic_json(root / "workspace.json", metadata)
    return root


def test_snapshot_validates_local_fields_and_relationships_once_without_copying_records(bundle, monkeypatch):
    import server.app.models.model_catalog as catalog

    calls = {"fields": [], "relationships": [], "metadata": []}
    fields, relationships, normalize = domain._validate_record_fields, domain._validate_record_relationships, catalog.normalize_metadata

    def checked_fields(record, workspace):
        calls["fields"].append(record["id"])
        return fields(record, workspace)

    def checked_relationships(record, records, workspace):
        calls["relationships"].append(record["id"])
        return relationships(record, records, workspace)

    def checked_metadata(value):
        assert "records" not in value
        calls["metadata"].append(value)
        return normalize(value)

    original = copy.deepcopy(bundle)
    monkeypatch.setattr(domain, "_validate_record_fields", checked_fields)
    monkeypatch.setattr(domain, "_validate_record_relationships", checked_relationships)
    monkeypatch.setattr(catalog, "normalize_metadata", checked_metadata)
    assert domain.validate_snapshot(bundle) is bundle
    expected = [record["id"] for record in bundle["records"]]
    assert calls["fields"] == expected == calls["relationships"]
    assert len(calls["metadata"]) == 1
    assert bundle == original


@pytest.mark.parametrize("corruption", ["missing-end", "missing-title", "unsafe-number", "surrogate", "bad-render", "missing-parent", "parent-cycle", "checksum"])
def test_existing_root_retains_strict_validation_and_never_becomes_ready(tmp_path, bundle, corruption):
    bundle["manifest"].pop("contentSha256", None)
    record = bundle["records"][0]
    if corruption.startswith("missing-") and corruption != "missing-parent":
        record.pop(corruption.removeprefix("missing-"))
    elif corruption == "unsafe-number":
        record["data"]["unsafe"] = domain.MAX_SAFE_INT + 1
    elif corruption == "surrogate":
        record["data"]["unsafe"] = "\ud800"
    elif corruption == "bad-render":
        record["render"] = {"fontSize": 500}
    elif corruption == "missing-parent":
        record["parentSessionId"] = "00000000-0000-0000-0000-000000000001"
    elif corruption == "parent-cycle":
        record["parentSessionId"] = record["id"]
    else:
        bundle["manifest"]["contentSha256"] = "0" * 64
    if corruption == "surrogate":
        record["data"]["unsafe"] = "placeholder"
    root = existing_root(tmp_path, bundle)
    if corruption == "surrogate":
        path = root / "records" / f"{record['id']}.json"
        path.write_bytes(path.read_bytes().replace(b'"placeholder"', b'"\\ud800"'))
    before = {path.relative_to(root): path.read_bytes() for path in root.rglob("*.json")}
    repository = storage.JsonRepository(root, tmp_path / "unused.json")
    with pytest.raises(domain.DomainError):
        repository.open()
    assert not repository.available and repository.owner is None
    assert before == {path.relative_to(root): path.read_bytes() for path in root.rglob("*.json")}
    with pytest.raises(domain.DomainError, match="requires restart"):
        repository.query_snapshot()


def test_parallel_reads_are_bounded_and_consumed_in_filename_order(tmp_path, bundle, monkeypatch):
    root = existing_root(tmp_path, bundle)
    reader = storage._read_record_file
    lock = threading.Lock()
    active = maximum_active = queued = maximum_queued = 0
    read_ids = []

    class TrackingExecutor(ThreadPoolExecutor):
        def submit(self, operation, *args, **kwargs):
            nonlocal queued, maximum_queued
            with lock:
                queued += 1
                maximum_queued = max(maximum_queued, queued)
            future = super().submit(operation, *args, **kwargs)

            def finished(_):
                nonlocal queued
                with lock:
                    queued -= 1

            future.add_done_callback(finished)
            return future

    def slow_read(path, receipt=None):
        nonlocal active, maximum_active
        with lock:
            active += 1
            maximum_active = max(maximum_active, active)
        try:
            time.sleep(0.002)
            result = reader(path, receipt)
            with lock:
                read_ids.append(result["id"])
            return result
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(storage, "_READ_PARALLEL_THRESHOLD", 0)
    monkeypatch.setattr(storage, "_READ_WORKERS", 4)
    monkeypatch.setattr(storage, "_READ_BATCH_SIZE", 8)
    monkeypatch.setattr(storage, "ThreadPoolExecutor", TrackingExecutor)
    monkeypatch.setattr(storage, "_read_record_file", slow_read)
    repository = storage.JsonRepository(root, tmp_path / "unused.json").open()
    try:
        assert 1 < maximum_active <= 4 and maximum_queued <= 8
        assert active == queued == 0
        assert len(read_ids) == len(bundle["records"])
        assert list(repository.records) == sorted(read_ids)
        assert repository.available
    finally:
        repository.close()


def test_parallel_read_failure_drains_workers_before_releasing_owner(tmp_path, bundle, monkeypatch):
    root = existing_root(tmp_path, bundle)
    paths = sorted((root / "records").glob("*.json"))
    reader = storage._read_record_file
    barrier = threading.Barrier(4)
    release = threading.Event()
    failed = threading.Event()
    lock = threading.Lock()
    active = 0
    completed = []

    def controlled_read(path, receipt=None):
        nonlocal active
        with lock:
            active += 1
        try:
            if path in paths[:4]:
                barrier.wait(timeout=5)
            if path == paths[0]:
                failed.set()
                raise OSError("Injected ordered read failure")
            assert release.wait(timeout=5)
            return reader(path, receipt)
        finally:
            with lock:
                active -= 1
                completed.append(path)

    monkeypatch.setattr(storage, "_READ_PARALLEL_THRESHOLD", 0)
    monkeypatch.setattr(storage, "_READ_WORKERS", 4)
    monkeypatch.setattr(storage, "_READ_BATCH_SIZE", 8)
    monkeypatch.setattr(storage, "_read_record_file", controlled_read)
    repository = storage.JsonRepository(root, tmp_path / "unused.json")
    close = repository.close

    def checked_close():
        assert active == 0
        close()

    monkeypatch.setattr(repository, "close", checked_close)
    with ThreadPoolExecutor(max_workers=1) as runner:
        result = runner.submit(repository.open)
        try:
            assert failed.wait(timeout=5)
            assert not repository.available and repository.owner is not None
            with pytest.raises(RuntimeError, match="active writer"):
                storage.JsonRepository(root, tmp_path / "unused.json").open()
        finally:
            release.set()
        with pytest.raises(OSError, match="ordered read failure"):
            result.result(timeout=5)
    assert active == 0 and repository.owner is None and not repository.available
    assert len(completed) <= 8


@pytest.mark.parametrize("text", ["\ud7ff", "\ue000", "\U0001f600", "ordinary ASCII"])
def test_fast_surrogate_check_preserves_valid_unicode(text):
    domain.validate_json({"text": text})


@pytest.mark.parametrize("text", ["\ud800", "\udfff", "prefix\ud900suffix"])
def test_fast_surrogate_check_rejects_lone_surrogates(text):
    with pytest.raises(domain.DomainError) as error:
        domain.validate_json({"text": text})
    assert error.value.code == "invalid_json"
