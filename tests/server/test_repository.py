import copy
from concurrent.futures import ThreadPoolExecutor

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, MAX_SAFE_INT, content_checksum, read_json, validate_snapshot
from server.app.repositories.json_repository import JsonRepository, atomic_json

SEED = ROOT / "data" / "default-dataset.json"


def repository(tmp_path):
    return JsonRepository(tmp_path / "data", SEED).open()


def test_exclusive_writer_lock_and_reacquisition(tmp_path):
    first = repository(tmp_path)
    try:
        with pytest.raises(RuntimeError, match="active writer"):
            repository(tmp_path)
    finally:
        first.close()
    second = repository(tmp_path)
    assert second.metadata()["recordCount"] == 48
    second.close()


@pytest.mark.parametrize("command", ["update", "delete", "batch"])
def test_immutable_query_capture_survives_later_record_publication(tmp_path, command):
    repo = repository(tmp_path)
    try:
        generation = repo.meta["manifest"]["generation"]
        created = repo.mutate("create", None, {"kind": "event", "title": "Before capture", "data": {"status": "Ready"}},
                              generation, None, "capture-created", "actor")["record"]
        captured = repo.capture_query_snapshot()
        pinned = next(record for record in captured["records"] if record["id"] == created["id"])
        before = copy.deepcopy(captured)
        assert pinned is repo.records[created["id"]]
        assert captured["manifest"] is not repo.meta["manifest"]
        if command == "batch":
            repo.mutate_batch({"operations": [{"type": "update", "recordId": created["id"], "expectedVersion": created["version"],
                                                "payload": {"title": "After batch", "data": {"status": "Complete"}}},
                                               {"type": "create", "payload": {"title": "New batch membership"}}]},
                              generation, "capture-batch", "actor", request_route=None, authorize_record=lambda operation, record: None)
        else:
            payload = {"title": "After update", "data": {"status": "Complete"}} if command == "update" else {}
            repo.mutate(command, created["id"], payload, generation, f'"{generation}:{created["version"]}"', "after-capture", "actor")
        assert captured == before
        assert repo.records[created["id"]] is not pinned
        assert repo.meta["manifest"]["revision"] > captured["manifest"]["revision"]
        exported = repo.query_snapshot()
        independent = next(record for record in exported["records"] if record["id"] == created["id"])
        assert independent is not repo.records[created["id"]]
        independent["data"]["status"] = "Export caller edit"
        assert repo.records[created["id"]]["data"]["status"] != "Export caller edit"
    finally:
        repo.close()


def test_workspace_revision_ceiling_preserves_replay_and_restart(tmp_path, bundle):
    seed = tmp_path / "seed.json"
    bundle["manifest"]["revision"] = MAX_SAFE_INT - 1
    bundle["manifest"].pop("contentSha256", None)
    atomic_json(seed, bundle)
    first = JsonRepository(tmp_path / "data", seed).open()
    try:
        generation = first.metadata()["generation"]
        payload = {"title": "Last supported revision"}
        committed = first.mutate("create", None, payload, generation, None, "last-valid", "principal")
        assert committed["revision"] == MAX_SAFE_INT
        before = {path.relative_to(first.root): path.read_bytes() for path in first.root.rglob("*.json")}
        with pytest.raises(DomainError) as error:
            first.mutate("create", None, {"title": "Must not persist"}, generation, None, "over-limit", "principal")
        assert error.value.code == "revision_capacity" and error.value.status == 413
        assert first.mutate("create", None, payload, generation, None, "last-valid", "principal") == committed
        assert before == {path.relative_to(first.root): path.read_bytes() for path in first.root.rglob("*.json")}
        validate_snapshot(first.snapshot())
    finally:
        first.close()
    second = JsonRepository(tmp_path / "data", seed).open()
    try:
        assert second.metadata()["revision"] == MAX_SAFE_INT
        assert second.command_outcome("principal", "last-valid") == committed
        assert second.get_record(committed["record"]["id"])["title"] == payload["title"]
    finally:
        second.close()


def test_internal_query_snapshot_omits_only_export_checksum_and_is_pinned(tmp_path, monkeypatch):
    first = repository(tmp_path)
    try:
        import server.app.repositories.json_repository as module
        checksum = module.content_checksum
        calls = []

        def checked(bundle):
            calls.append(bundle["manifest"]["revision"])
            return checksum(bundle)

        monkeypatch.setattr(module, "content_checksum", checked)
        internal = first.query_snapshot()
        assert "contentSha256" not in internal["manifest"] and calls == []
        exported = first.snapshot()
        assert calls == [internal["manifest"]["revision"]]
        assert exported["manifest"]["contentSha256"] == content_checksum(exported)
        validate_snapshot(exported)
        assert internal["records"] == exported["records"]
        assert internal["models"] == exported["models"] and internal["settings"] == exported["settings"]
        record = internal["records"][0]
        original_title = record["title"]
        generation = internal["manifest"]["generation"]
        first.mutate("update", record["id"], {"title": "Changed after query copy"}, generation,
                     f'"{generation}:{record["version"]}"', "copy-isolation", "principal")
        assert record["title"] == original_title
        assert first.get_record(record["id"])["title"] != original_title
        internal["records"][1]["title"] = "Caller-owned copy"
        assert first.get_record(internal["records"][1]["id"])["title"] != "Caller-owned copy"
        later = first.snapshot()
        assert later["manifest"]["contentSha256"] == content_checksum(later)
        assert later["manifest"]["contentSha256"] != exported["manifest"]["contentSha256"]
    finally:
        first.close()


def test_committed_journal_redoes_record_revision_and_outcome(tmp_path, monkeypatch):
    first = repository(tmp_path)
    generation = first.metadata()["generation"]
    write_journal = first._write_journal

    def fail_after_commit_marker(journal):
        write_journal(journal)
        if journal["state"] == "committed":
            raise OSError("Simulated interruption after durable commit marker")

    monkeypatch.setattr(first, "_write_journal", fail_after_commit_marker)
    with pytest.raises(DomainError) as error:
        first.mutate("create", None, {"title": "Recover this committed record"}, generation, None, "recover-me", "principal")
    assert error.value.code == "commit_outcome_unknown"
    assert not first.available
    assert read_json(first.root / "transaction.json")["state"] == "committed"
    with pytest.raises(DomainError, match="requires restart"):
        first.snapshot()
    first.close()
    second = repository(tmp_path)
    try:
        outcome = second.command_outcome("principal", "recover-me")
        assert outcome["revision"] == 2
        assert second.metadata()["recordCount"] == 49
        assert second.get_record(outcome["record"]["id"])["title"] == "Recover this committed record"
        assert not (second.root / "transaction.json").exists()
        replay = second.mutate("create", None, {"title": "Recover this committed record"}, generation, None, "recover-me", "principal")
        assert replay == outcome
        assert second.metadata()["revision"] == 2
        with pytest.raises(DomainError) as error:
            second.command_outcome("other-principal", "recover-me")
        assert error.value.status == 404
    finally:
        second.close()


def test_prepared_journal_does_not_publish_uncommitted_state(tmp_path):
    first = repository(tmp_path)
    changed = copy.deepcopy(first.meta)
    changed["manifest"]["revision"] = 900
    atomic_json(first.root / "transaction.json", {"state": "prepared", "after": {"workspace.json": changed}})
    first.close()
    second = repository(tmp_path)
    try:
        assert second.metadata()["revision"] == 1
        assert not (second.root / "transaction.json").exists()
    finally:
        second.close()


def test_concurrent_edits_have_exactly_one_winner(tmp_path):
    repo = repository(tmp_path)
    try:
        generation = repo.metadata()["generation"]
        record = repo.snapshot()["records"][0]
        etag = f'"{generation}:{record["version"]}"'

        def update(index):
            try:
                return repo.mutate("update", record["id"], {"title": f"Winner {index}"}, generation, etag, f"concurrent-{index}", "principal")
            except DomainError as error:
                return error.code

        with ThreadPoolExecutor(max_workers=8) as executor:
            outcomes = list(executor.map(update, range(8)))
        assert sum(isinstance(item, dict) for item in outcomes) == 1
        assert outcomes.count("version_conflict") == 7
        assert repo.metadata()["revision"] == 2
        assert repo.get_record(record["id"])["version"] == 2
    finally:
        repo.close()


def test_data_root_contains_json_records_and_no_database(tmp_path):
    repo = repository(tmp_path)
    try:
        assert len(list((repo.root / "records").glob("*.json"))) == 48
        assert all(path.suffix == ".json" or path.name == ".writer.lock" for path in repo.root.rglob("*") if path.is_file())
    finally:
        repo.close()


def test_missing_workspace_never_reseeds_or_overwrites_existing_records(tmp_path):
    repo = repository(tmp_path)
    record_path = next((repo.root / "records").glob("*.json"))
    original = record_path.read_bytes()
    metadata_path = repo.root / "workspace.json"
    repo.close()
    metadata_path.unlink()
    with pytest.raises(RuntimeError, match="refusing to reseed"):
        repository(tmp_path)
    assert record_path.read_bytes() == original
    assert not metadata_path.exists()


def test_missing_record_fails_closed_instead_of_exporting_false_completeness(tmp_path):
    repo = repository(tmp_path)
    record_path = next((repo.root / "records").glob("*.json"))
    repo.close()
    record_path.unlink()
    with pytest.raises(DomainError) as error:
        repository(tmp_path)
    assert error.value.code == "incomplete_snapshot"


def test_empty_sources_survive_complete_export_and_first_mutation(tmp_path, bundle):
    bundle["records"] = []
    bundle["manifest"]["recordCount"] = 0
    seed = tmp_path / "empty-seed.json"
    atomic_json(seed, bundle)
    repo = JsonRepository(tmp_path / "data", seed).open()
    try:
        expected_sources = bundle["manifest"]["scope"]["sourceIds"]
        assert repo.snapshot()["manifest"]["scope"]["sourceIds"] == expected_sources
        repo.mutate("create", None, {"title": "First"}, repo.metadata()["generation"], None, "first", "principal")
        assert repo.snapshot()["manifest"]["scope"]["sourceIds"] == expected_sources
        assert repo.metadata()["sourceIds"] == expected_sources
    finally:
        repo.close()


def test_seed_with_missing_model_reference_is_rejected_before_persistence(tmp_path, bundle):
    bundle["settings"]["modelId"] = "absent-model"
    seed = tmp_path / "bad-seed.json"
    atomic_json(seed, bundle)
    with pytest.raises(DomainError) as error:
        JsonRepository(tmp_path / "data", seed).open()
    assert error.value.code == "missing_model"
    assert not (tmp_path / "data" / "workspace.json").exists()
