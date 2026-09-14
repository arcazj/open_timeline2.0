import hashlib
import importlib.util
import json
import subprocess
import sys

import pytest

from conftest import ROOT
from scripts.performance_fixture import build_snapshot, fixture_summary
from server.app.models.domain import read_json, validate_snapshot
from server.app.repositories.json_repository import JsonRepository

SPEC = importlib.util.spec_from_file_location("fixture_benchmark", ROOT / "scripts/benchmark-server.py")
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


@pytest.mark.parametrize("storage_layout", ["records", "shards"])
@pytest.mark.parametrize("seed_only", [False, True])
def test_versioned_fixture_preserves_complete_seed_and_valid_server_storage(tmp_path, storage_layout, seed_only):
    summary = benchmark.build_fixture(tmp_path, 1000, seed_only, storage_layout, "small")
    seed = tmp_path / "seed.json"
    bundle = read_json(seed)
    validate_snapshot(bundle)
    assert summary["recipe"] == "release-mixture-v1"
    assert summary["recordCount"] == 1000 and summary["groupCount"] == 100
    assert summary["snapshotFileSha256"] == hashlib.sha256(seed.read_bytes()).hexdigest()
    assert summary["groupingExercised"] == "sourceId"
    assert summary["snapshotFileSha256"] == fixture_summary(build_snapshot("small"), "small")["snapshotFileSha256"]
    if seed_only:
        assert summary["files"] == 0 and not list((tmp_path / "data").iterdir())
    else:
        repository = JsonRepository(tmp_path / "data", seed).open()
        try:
            assert repository.meta["manifest"]["sourceKind"] == "server"
            assert sorted(repository.records.values(), key=lambda record: record["id"]) == sorted(bundle["records"], key=lambda record: record["id"])
            assert (repository.layout is not None) == (storage_layout == "shards")
        finally:
            repository.close()


def test_historical_default_fixture_keeps_its_original_recipe(tmp_path):
    summary = benchmark.build_fixture(tmp_path, 10)
    assert "recipe" not in summary and "groupCount" not in summary
    bundle = read_json(tmp_path / "seed.json")
    assert bundle["records"][0]["id"] == "00000000-0000-0000-0000-000000000001"
    assert bundle["records"][0]["title"] == "Checkpoint 000000"
    assert bundle["records"][0]["sourceId"] == "source-00"
    assert summary["recordCount"] == 10 and summary["files"] == 11


def test_fixture_tier_rejects_conflicting_record_count_before_output(tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / "scripts/benchmark-server.py"), "--fixture-tier", "small", "--records", "10",
                             "--output", str(tmp_path / "not-created.json")], capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and "must match" in result.stderr
    assert not (tmp_path / "not-created.json").exists()


def test_small_fixture_benchmark_real_supervised_startup_binds_source_evidence(tmp_path):
    output = tmp_path / "small-startup.json"
    result = subprocess.run([sys.executable, str(ROOT / "scripts/benchmark-server.py"), "--fixture-tier", "small", "--storage-layout", "shards",
                             "--startup-only", "--output", str(output)], capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, result.stderr or result.stdout
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["fixtureTier"] == "small" and report["recordCount"] == 1000
    assert report["temporaryDataRemoved"] is True
    assert report["groupLayoutQualification"] is False and report["stressTierSupported"] is False
    for lane in report["lanes"]:
        assert lane["exitCode"] == 0 and lane["timedOut"] is False
        assert all(phase["status"] == "ok" for phase in lane["phases"])
    fixture = report["lanes"][0]["phases"][0]["details"]
    assert fixture["recipe"] == "release-mixture-v1" and fixture["groupCount"] == 100
    assert len(report["sourceSha256"]["scripts/benchmark-server.py"]) == 64
    assert len(report["sourceSha256After"]["scripts/benchmark-server.py"]) == 64
    assert report["sourceStateStable"] == (report["sourceSha256"] == report["sourceSha256After"])
