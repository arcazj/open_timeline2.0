import copy
import hashlib
import uuid

import pytest

from conftest import ROOT
from server.app.models.domain import DomainError, content_checksum, json_bytes, read_json, validate_snapshot
from server.app.repositories import json_shards as shards
from server.app.repositories import storage_migration as migration
from server.app.repositories.json_repository import JsonRepository, atomic_json
from server.app.services.identity import IdentityStore

SEED = ROOT / "data/default-dataset.json"


def migrated(tmp_path):
    source, destination = tmp_path / "source", tmp_path / "destination"
    repo = JsonRepository(source, SEED).open()
    repo.close()
    migration.migrate_storage(source, destination, SEED)
    return JsonRepository(destination, SEED).open()


def test_explicit_migration_preserves_all_records_outcomes_controls_and_source_bytes(tmp_path):
    source, destination = tmp_path / "source", tmp_path / "destination"
    repo = JsonRepository(source, SEED).open()
    created = repo.mutate("create", None, {"title": "Before migration"}, repo.meta["manifest"]["generation"], None, "original", "actor")
    exported = repo.snapshot()
    repo.close()
    identities = IdentityStore(source / "control", "long-enough-bootstrap-secret")
    identities.open()
    identity_state = copy.deepcopy(identities.state)
    identities.close()
    before = {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*.json")}
    report = migration.migrate_storage(source, destination, SEED)
    assert report["activated"] is False and report["recordCount"] == 49
    assert before == {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*.json")}
    assert read_json(destination / "control/identities.json") == identity_state
    assert not (destination / "records").exists()
    assert not (destination / "migration-incomplete.json").exists()
    recovered = JsonRepository(destination, SEED).open()
    try:
        assert recovered.layout["formatVersion"] == 2
        assert recovered.command_outcome("actor", "original") == created
        actual = recovered.snapshot()
        assert actual["records"] == exported["records"]
        assert actual["manifest"]["contentSha256"] == content_checksum(exported)
        validate_snapshot(actual)
    finally:
        recovered.close()


def test_shard_crud_and_model_mutations_advance_manifest_together(tmp_path):
    repo = migrated(tmp_path)
    generation = repo.meta["manifest"]["generation"]
    try:
        record = repo.mutate("create", None, {"title": "Shard mutation"}, generation, None, "create", "actor")["record"]
        for command in ("update", "delete", "restore"):
            record = repo.mutate(command, record["id"], {"title": "Updated shard"} if command == "update" else {},
                                 generation, f'"{generation}:{record["version"]}"', command, "actor")["record"]
            assert repo.layout["revision"] == repo.meta["manifest"]["revision"]
            assert repo.layout["recordCount"] == len(repo.records)
        model = repo.list_models()["items"][0]
        definition = model["versions"][0]["definition"]
        repo.mutate_model("create", None, {"name": "Shard model", "definition": definition}, generation, None, "model", "actor")
        assert repo.layout["revision"] == repo.meta["manifest"]["revision"] == 6
        assert not (repo.root / "records").exists()
        expected = repo.snapshot()
    finally:
        repo.close()
    for _ in range(2):
        again = JsonRepository(repo.root, SEED).open()
        assert again.snapshot()["manifest"]["contentSha256"] == expected["manifest"]["contentSha256"]
        again.close()


def test_deterministic_prefix_splits_and_changed_date_keep_membership(tmp_path, monkeypatch):
    bundle = read_json(SEED)
    template = bundle["records"][0]
    records = [{**copy.deepcopy(template), "id": str(uuid.UUID(int=index + 1))} for index in range(100)]
    manifest = {**bundle["manifest"], "recordCount": len(records)}
    monkeypatch.setattr(shards, "SHARD_BYTES", 4096)
    first, first_documents = shards.build_layout(records, manifest)
    second, second_documents = shards.build_layout(list(reversed(records)), manifest)
    assert first == second and first_documents == second_documents
    assert len(first_documents) > 1
    assert all(len(json_bytes(document)) <= 4096 for document in first_documents.values())
    assert sum(len(document["records"]) for document in first_documents.values()) == 100
    for bucket in first["buckets"]:
        shards.validate_shard(first_documents[bucket["prefix"]], bucket)
    record = records[0]
    changed = {**record, "start": "2026-09-13T00:00:00.000Z", "end": "2026-09-13T01:00:00.000Z"}
    replacements = shards.apply_record_changes(first, first_documents, {record["id"]: changed}, {**manifest, "revision": 2})
    assert [entry["prefix"] for entry in replacements["storage-layout.json"]["buckets"]] == [entry["prefix"] for entry in first["buckets"]]


@pytest.mark.parametrize("state", ["prepared", "committed"])
def test_shard_split_recovers_old_or_new_complete_membership(tmp_path, monkeypatch, state):
    repo = migrated(tmp_path)
    original = repo.snapshot()
    generation = repo.meta["manifest"]["generation"]
    record = max(repo.shards.values(), key=lambda document: len(json_bytes(document)))["records"][0]
    original_write = repo._write_journal

    def stop(journal):
        if state == "prepared" and journal["state"] == "committed":
            raise OSError("Before decision after all target installs")
        original_write(journal)
        if state == "committed" and journal["state"] == "committed":
            raise OSError("After commit decision")

    # Existing sample buckets hold multiple records; the larger record forces a bounded split.
    monkeypatch.setattr(shards, "SHARD_BYTES", 4096)
    monkeypatch.setattr(repo, "_write_journal", stop)
    with pytest.raises(DomainError) as error:
        repo.mutate("update", record["id"], {"data": {"description": "x" * 1500}}, generation,
                    f'"{generation}:{record["version"]}"', "split", "actor")
    assert error.value.code == "commit_outcome_unknown"
    journal = read_json(repo.root / "transaction.json")
    assert journal["state"] == state and "storage-layout.json" in journal["after"]
    assert any(relative.startswith("shards/") and image["exists"] and not journal["after"][relative]["exists"]
               for relative, image in journal["before"].items()), "Fixture must actually split and retire an old shard"
    repo.close()
    for _ in range(2):
        again = JsonRepository(repo.root, SEED).open()
        try:
            if state == "prepared":
                assert again.snapshot()["manifest"]["contentSha256"] == original["manifest"]["contentSha256"]
            else:
                assert again.get_record(record["id"])["data"]["description"] == "x" * 1500
                assert again.command_outcome("actor", "split")["revision"] == 2
            assert not (again.root / "transaction.json").exists()
        finally:
            again.close()


@pytest.mark.parametrize("corruption", ["missing", "extra", "hash", "count", "overlap", "hybrid", "schema", "malformed"])
def test_shard_startup_rejects_incomplete_or_invalid_authority(tmp_path, corruption):
    repo = migrated(tmp_path)
    root, layout = repo.root, copy.deepcopy(repo.layout)
    repo.close()
    bucket = layout["buckets"][0]
    path = root / bucket["path"]
    if corruption == "missing":
        path.unlink()
    elif corruption == "extra":
        atomic_json(root / "shards/ffffffffffffffffffffffffffffffff.json", {})
    elif corruption == "hybrid":
        (root / "records").mkdir()
    elif corruption in ("hash", "schema"):
        document = read_json(path)
        if corruption == "hash":
            document["records"][0]["title"] = "Changed behind checksum"
        else:
            document["records"][0].pop("title")
            bucket["sha256"] = shards.checksum(document)
        atomic_json(path, document)
    elif corruption == "malformed":
        path.write_text('{"duplicate":1,"duplicate":2}', encoding="utf-8")
    elif corruption == "count":
        bucket["recordCount"] += 1
    else:
        layout["buckets"].insert(1, {**bucket, "prefix": bucket["prefix"] + "0", "path": "shards/" + bucket["prefix"] + "0.json"})
    layout["checksum"] = shards.manifest_checksum(layout)
    atomic_json(root / "storage-layout.json", layout)
    before = {str(item.relative_to(root)): hashlib.sha256(item.read_bytes()).hexdigest() for item in root.rglob("*.json")}
    candidate = JsonRepository(root, SEED)
    with pytest.raises((RuntimeError, DomainError)):
        candidate.open()
    assert candidate.owner is None and not candidate.available
    assert before == {str(item.relative_to(root)): hashlib.sha256(item.read_bytes()).hexdigest() for item in root.rglob("*.json")}


def test_interrupted_migration_never_becomes_ready_and_preserves_source(tmp_path, monkeypatch):
    source, destination = tmp_path / "source", tmp_path / "destination"
    repo = JsonRepository(source, SEED).open()
    repo.close()
    before = {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*.json")}
    original = migration.atomic_json

    def fail(path, document):
        original(path, document)
        if path.name == "workspace.json":
            raise OSError("Interrupted staging")

    monkeypatch.setattr(migration, "atomic_json", fail)
    with pytest.raises(OSError):
        migration.migrate_storage(source, destination, SEED)
    assert (destination / "migration-incomplete.json").exists()
    with pytest.raises(RuntimeError, match="incomplete"):
        JsonRepository(destination, SEED).open()
    assert before == {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*.json")}


def test_migration_refuses_existing_nested_active_or_unrecovered_roots(tmp_path):
    source, destination = tmp_path / "source", tmp_path / "destination"
    repo = JsonRepository(source, SEED).open()
    with pytest.raises(RuntimeError, match="active writer"):
        migration.migrate_storage(source, destination, SEED)
    with pytest.raises(DomainError) as error:
        migration.migrate_storage(source, source / "nested", SEED)
    assert error.value.code == "migration_path_conflict"
    repo.close()
    destination.mkdir()
    with pytest.raises(DomainError) as error:
        migration.migrate_storage(source, destination, SEED)
    assert error.value.code == "migration_destination_exists"
    atomic_json(source / "transaction.json", {"state": "prepared", "after": {}})
    with pytest.raises(DomainError) as error:
        migration.migrate_storage(source, tmp_path / "other", SEED)
    assert error.value.code == "migration_recovery_required"
    assert (source / "transaction.json").exists()
