import importlib.util
import json
import sys

import pytest

from conftest import ROOT

spec = importlib.util.spec_from_file_location("verify_candidate", ROOT / "scripts/verify-candidate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_inventory_detects_code_changes_but_ignores_runtime_artifacts(tmp_path):
    (tmp_path / "client").mkdir()
    source = tmp_path / "client/app.js"
    source.write_text("export const version = 1;", encoding="utf-8")
    first = module.source_inventory(tmp_path)
    (tmp_path / "runtime").mkdir()
    (tmp_path / "runtime/private.json").write_text('{"notForReports":true}', encoding="utf-8")
    assert module.source_inventory(tmp_path) == first
    source.write_text("export const version = 2;", encoding="utf-8")
    assert module.source_inventory(tmp_path)["sha256"] != first["sha256"]
    assert "runtime" not in json.dumps(first)


def test_inventory_covers_fixtures_and_profiles_but_not_private_overrides(tmp_path):
    for directory in ("data", "yaml/test-data", "yaml/local", "config/local"):
        (tmp_path / directory).mkdir(parents=True, exist_ok=True)
    fixture = tmp_path / "data/example.json"
    fixture.write_text('{}', encoding="utf-8")
    profile = tmp_path / "yaml/test-data/example.yml"
    profile.write_text('version: 1', encoding="utf-8")
    before = module.source_inventory(tmp_path)
    (tmp_path / "yaml/local/private.yml").write_text('private', encoding="utf-8")
    (tmp_path / "config/local/private.yml").write_text('private', encoding="utf-8")
    assert module.source_inventory(tmp_path) == before
    fixture.write_text('{"changed":true}', encoding="utf-8")
    assert module.source_inventory(tmp_path)["sha256"] != before["sha256"]
    assert "yaml/test-data/example.yml" in before["files"]


def test_inventory_detects_changes_to_the_embedded_project_license(tmp_path):
    license_file = tmp_path / "LICENSE"
    license_file.write_text('GNU GPL version 3', encoding="utf-8")
    before = module.source_inventory(tmp_path)
    assert "LICENSE" in before["files"]
    license_file.write_text('changed', encoding="utf-8")
    assert module.source_inventory(tmp_path)["sha256"] != before["sha256"]


def test_check_records_exit_failure_and_scrubs_production_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENBEXI_API_TOKEN", "must-not-enter-test-process")
    monkeypatch.setenv("OPENBEXI_DATA_ROOT", "must-not-enter-test-process")
    command = [sys.executable, "-c", "import os,sys; print(os.getenv('OPENBEXI_API_TOKEN')); print(os.getenv('OPENBEXI_DATA_ROOT')); sys.exit(3)"]
    result = module.run_step("failure", command, tmp_path, tmp_path)
    assert result["status"] == "failed" and result["exitCode"] == 3
    assert (tmp_path / "failure.log").read_text().splitlines() == ["None", "None"]


def test_timeout_and_log_overflow_are_never_passed(tmp_path):
    result = module.run_step("timeout", [sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, tmp_path, timeout=0.1)
    assert result["status"] == "failed" and result["reason"] == "timeout"
    result = module.run_step("overflow", [sys.executable, "-c", "import time; print('x'*100000, flush=True); time.sleep(30)"], tmp_path, tmp_path, log_limit=512)
    assert result["status"] == "failed" and result["reason"] == "log_limit_or_capture_failure"
    assert (tmp_path / "overflow.log").stat().st_size == 512


def test_completed_process_with_excess_output_still_fails(tmp_path):
    result = module.run_step("completed-overflow", [sys.executable, "-c", "print('x'*100000)"], tmp_path, tmp_path, log_limit=512)
    assert result["status"] == "failed" and result["reason"] == "log_limit_or_capture_failure"


def test_skipped_junit_cases_are_reported_separately(tmp_path):
    path = tmp_path / "results.xml"
    path.write_text('<testsuites><testsuite><testcase/><testcase><skipped/></testcase><testcase><failure/></testcase></testsuite></testsuites>', encoding="utf-8")
    assert module.junit_summary(path) == {"tests": 3, "skipped": 1, "failed": 1}


@pytest.mark.parametrize("summary,expected", [
    ({"tests": 0, "skipped": 0, "failed": 0}, "failed"),
    ({"tests": 2, "skipped": 1, "failed": 1}, "failed"),
    ({"tests": 2, "skipped": 1, "failed": 0}, "incomplete"),
    ({"tests": 2, "skipped": 0, "failed": 0}, "passed"),
])
def test_junit_evidence_cannot_hide_empty_runs_or_failures(summary, expected):
    result = {"status": "passed"}
    module.assess_junit(result, summary)
    assert result["status"] == expected


@pytest.mark.parametrize("status,stats,bundle,expected", [
    ("passed", {}, "current", "failed"),
    ("passed", {"expected": 1, "unexpected": 1, "skipped": 1}, "current", "failed"),
    ("passed", {"expected": 1, "skipped": 1}, "old", "failed"),
    ("failed", {"expected": 1, "skipped": 1}, "current", "failed"),
    ("passed", {"expected": 1, "flaky": 1}, "current", "incomplete"),
    ("passed", {"expected": 1}, "current", "passed"),
])
def test_browser_evidence_preserves_failures(status, stats, bundle, expected):
    result = {"status": status}
    browser = {"stats": stats, "config": {"metadata": {"standaloneBundleSha256": bundle}}}
    module.assess_browser(result, browser, "current")
    assert result["status"] == expected
