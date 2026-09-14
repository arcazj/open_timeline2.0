import copy
import hashlib
import json
import stat
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from server.app.models.domain import DomainError
from server.app.services import legacy_reader
from server.app.services.legacy_reader import LegacyLimits, LegacyReader, LegacySource, safe_read


DAY = {"from": "2024-03-18T00:00:00.000Z", "to": "2024-03-19T00:00:00.000Z"}


def event(identity="point", start="2024-03-18T12:00:00Z", **extra):
    return {"id": identity, "start": start, "data": {"title": str(identity), "namespace": "operations"}, **extra}


def write(root, relative, value):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value).encode())
    return path


def reader(root, **kwargs):
    source = kwargs.pop("source", LegacySource("source", root, timezone="UTC", data_model="yyyy/mm/dd"))
    return LegacyReader([source], allow_roots=[root], **kwargs)


def test_known_hazard_images_keep_distinct_variants_without_changing_source_bytes(tmp_path):
    images = legacy_reader.HAZARD_ICONS
    source = write(tmp_path, "2024/03/18/hazards.json", {"events": [
        event(name, render={"image": f"icon/{name}", "color": "#731616"}) for name in images
    ]})
    before = source.read_bytes()
    result = reader(tmp_path).scan()
    assert source.read_bytes() == before
    assert {record["render"]["icon"] for record in result.snapshot["records"]} == set(images.values())
    assert all(record["render"]["color"] == "#731616" for record in result.snapshot["records"])
    assert any(item["code"] == "legacy_icon_preserved" for item in result.report["diagnostics"])


def test_dated_folders_keep_earlier_crossing_sessions_and_half_open_edges(tmp_path):
    write(tmp_path, "2024/03/17/events.json", {"events": [
        event("crossing", "2024-03-17T23:00:00Z", end="2024-03-18T01:00:00Z"),
        event("ended", "2024-03-17T23:00:00Z", end=DAY["from"]),
        event("open", "2024-03-17T20:00:00Z", kind="session"),
    ]})
    write(tmp_path, "2024/03/18/events.json", {"events": [event("left", DAY["from"]), event("right", DAY["to"])]})
    result = reader(tmp_path).scan(time_range=DAY)
    assert {record["title"] for record in result.snapshot["records"]} == {"crossing", "open", "left"}
    assert result.report["allRecordCount"] == 5
    assert result.report["status"] == "current"
    assert result.snapshot["manifest"]["legacy"]["declaredRange"] == DAY


@pytest.mark.parametrize(("start", "end"), [
    ("0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00.001Z"),
    ("9999-12-31T23:59:59.998Z", "9999-12-31T23:59:59.999Z"),
])
def test_archive_domain_has_exact_positive_edges_near_supported_year_limits(tmp_path, start, end):
    partition = start[:10].replace("-", "/")
    write(tmp_path, f"{partition}/events.json", {"events": [event(start=start)]})
    result = reader(tmp_path).scan()
    assert result.report["domain"] == {"from": start, "to": end}
    assert result.snapshot["settings"]["range"] == result.report["domain"]


def test_final_representable_point_is_explicitly_rejected_without_overflow_or_omission(tmp_path):
    start = "9999-12-31T23:59:59.999Z"
    write(tmp_path, "9999/12/31/events.json", {"events": [event(start=start)]})
    engine = reader(tmp_path)
    with pytest.raises(DomainError) as error:
        engine.scan()
    assert error.value.code == "legacy_range_limit"
    assert engine._revision == 0


def test_session_can_end_at_last_supported_instant(tmp_path):
    start, end = "9999-12-30T00:00:00.000Z", "9999-12-31T23:59:59.999Z"
    write(tmp_path, "9999/12/30/events.json", {"events": [event(start=start, end=end)]})
    result = reader(tmp_path).scan()
    assert result.report["domain"] == {"from": start, "to": end}
    assert result.snapshot["records"][0]["end"] == end


def test_daily_source_prunes_non_dates_sidecars_noise_and_keeps_nested_json(tmp_path):
    write(tmp_path, "2024/03/18/subfolder/part.json", {"events": [event()]})
    for path in ("events.json", "2024/3/18/events.json", "2023/02/29/events.json",
                 "2024/03/18/descriptors/broken.json", "2024/03/18/noises/broken.json"):
        write(tmp_path, path, {"not": "an event envelope"})
    result = reader(tmp_path).scan()
    assert result.report["recordCount"] == 1
    assert result.report["files"] == 1
    assert result.report["descriptorDirectories"] == 1
    assert result.report["rejectedFiles"] == 0
    assert result.report["sources"][0]["dataModel"] == "yyyy/mm/dd"


def test_stable_ids_revision_and_timestamps_survive_cache_eviction(tmp_path):
    path = write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    engine = reader(tmp_path, limits=LegacyLimits(cache_bytes=0))
    first, second = engine.scan(), engine.scan()
    assert first.snapshot["records"] == second.snapshot["records"]
    assert first.snapshot["manifest"]["revision"] == second.snapshot["manifest"]["revision"] == 1
    assert first.snapshot["manifest"]["bundleId"] == second.snapshot["manifest"]["bundleId"]
    fresh = reader(tmp_path).scan()
    assert fresh.snapshot["records"][0]["id"] == first.snapshot["records"][0]["id"]
    assert fresh.snapshot["manifest"]["generation"] != first.snapshot["manifest"]["generation"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original
    assert first.snapshot["sources"][0]["versions"][0]["definition"]["writable"] is False


def test_namespace_identity_and_nested_activity_relationships_are_preserved(tmp_path):
    child = event("child")
    parent = event("parent", activities=[child])
    other_namespace = event("child", namespace="other")
    write(tmp_path, "2024/03/18/events.json", {"session": [parent, other_namespace]})
    result = reader(tmp_path).scan()
    records = result.snapshot["records"]
    parent_record = next(record for record in records if record["title"] == "parent")
    children = [record for record in records if record["title"] == "child"]
    assert parent_record["kind"] == "session"
    assert len({child["id"] for child in children}) == 2
    assert {child["data"]["namespace"] for child in children} == {"operations", "other"}
    assert next(child for child in children if child["data"]["namespace"] == "operations")["parentSessionId"] == parent_record["id"]


def test_range_preserves_required_ancestors_with_zero_cache(tmp_path):
    write(tmp_path, "2024/03/17/events.json", {"events": [
        event("parent", "2024-03-17T01:00:00Z", end="2024-03-17T02:00:00Z", activities=[event("child")])
    ]})
    result = reader(tmp_path, limits=LegacyLimits(cache_bytes=0)).scan(time_range=DAY)
    assert {record["title"] for record in result.snapshot["records"]} == {"parent", "child"}


def test_read_failures_keep_bounded_last_good_without_mutating_pinned_snapshot(tmp_path):
    path = write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    engine = reader(tmp_path)
    original = engine.scan()
    pinned = copy.deepcopy(original.snapshot)
    path.write_bytes(b'{"events": [')
    stale = engine.scan()
    assert stale.report["status"] == "stale"
    assert stale.report["staleFiles"] == 1
    assert stale.snapshot["records"] == original.snapshot["records"]
    assert original.snapshot == pinned
    assert stale.report["diagnostics"][0]["code"] == "invalid_json"
    fresh = reader(tmp_path).scan()
    assert fresh.report["status"] == "incomplete"
    assert fresh.report["rejectedFiles"] == 1
    assert fresh.report["recordCount"] == 0


def test_removed_uncached_files_are_reported_and_revision_changes(tmp_path):
    path = write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    engine = reader(tmp_path, limits=LegacyLimits(cache_bytes=0))
    engine.scan()
    path.unlink()
    result = engine.scan()
    assert result.report["missingFiles"] == 1
    assert result.snapshot["manifest"]["revision"] == 2
    assert result.snapshot["records"] == []


def test_zones_have_correct_range_and_color_change_increments_revision(tmp_path):
    zone = event("zone", "2024-03-17T23:00:00Z", end="2024-03-18T02:00:00Z", zone=True,
                 render={"color": "#DD7733"})
    write(tmp_path, "2024/03/17/events.json", {"events": [zone]})
    engine = reader(tmp_path)
    first = engine.scan(time_range=DAY)
    assert first.report["domain"] == {"from": "2024-03-17T23:00:00.000Z", "to": "2024-03-18T02:00:00.000Z"}
    assert first.snapshot["zones"][0]["color"] == "#DD7733"
    zone["render"]["color"] = "#226633"
    write(tmp_path, "2024/03/17/events.json", {"events": [zone]})
    second = engine.scan(time_range=DAY)
    assert second.snapshot["manifest"]["revision"] == 2
    assert second.snapshot["zones"][0]["color"] == "#226633"


def test_conflicting_identity_is_rejected_but_identical_duplicate_is_collapsed(tmp_path):
    write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    write(tmp_path, "2024/03/17/events.json", {"events": [event()]})
    engine = reader(tmp_path)
    initial = engine.scan()
    assert initial.report["duplicateRecords"] == 1
    assert initial.snapshot["records"][0]["extensions"]["legacy"]["file"] == "2024/03/17/events.json"
    changed = event()
    changed["data"]["title"] = "Changed title"
    write(tmp_path, "2024/03/18/events.json", {"events": [changed]})
    with pytest.raises(DomainError) as error:
        engine.scan()
    assert error.value.code == "legacy_duplicate_id"


def test_descriptors_are_on_demand_and_identity_checked(tmp_path):
    write(tmp_path, "2024/03/17/events.json", {"events": [event("detail")]})
    sidecar = {"event_descriptor": [{"id": "detail", "namespace": "operations", "description": "Details"}]}
    path = write(tmp_path, "2024/03/17/descriptors/detail.json", sidecar)
    engine = reader(tmp_path)
    result = engine.scan()
    record = result.snapshot["records"][0]
    assert result.report["files"] == 1
    detail = engine.descriptor(record)
    assert detail["file"] == "2024/03/17/descriptors/detail.json"
    assert detail["descriptor"]["description"] == "Details"
    assert detail["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    sidecar["event_descriptor"][0]["namespace"] = "other"
    write(tmp_path, "2024/03/17/descriptors/detail.json", sidecar)
    with pytest.raises(DomainError) as error:
        engine.descriptor(record)
    assert error.value.code == "legacy_descriptor"


def test_allowlist_and_symlinks_are_not_legacy_authorities(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(DomainError) as error:
        LegacyReader([LegacySource("outside", outside)], allow_roots=[root])
    assert error.value.code == "legacy_allowlist"
    assert legacy_reader._unsafe(SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0))
    assert legacy_reader._unsafe(SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=legacy_reader.REPARSE))


def test_reparse_ancestry_is_rejected_before_read(tmp_path, monkeypatch):
    path = write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    original = Path.lstat

    def reparse(target):
        if target == path.parent:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=legacy_reader.REPARSE)
        return original(target)

    monkeypatch.setattr(Path, "lstat", reparse)
    with pytest.raises(DomainError) as error:
        safe_read(path, tmp_path, 10000)
    assert error.value.code == "legacy_path"


@pytest.mark.parametrize('short_name', [False, True] if sys.platform == 'win32' else [False])
def test_safe_read_binds_unchanged_file_and_rejects_growth(tmp_path, monkeypatch, short_name):
    path = write(tmp_path, "events.json", {"events": [event()]})
    if short_name:
        import ctypes
        from ctypes import wintypes
        short = ctypes.windll.kernel32.GetShortPathNameW
        short.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        short.restype = wintypes.DWORD
        buffer = ctypes.create_unicode_buffer(32768)
        assert 0 < short(str(path), buffer, len(buffer)) < len(buffer)
        path = Path(buffer.value)
        tmp_path = path.parent
    assert safe_read(path, tmp_path, 10000) == path.read_bytes()
    original = legacy_reader.os.fstat
    calls = 0

    def changed(descriptor):
        nonlocal calls
        calls += 1
        if calls == 2:
            with path.open("ab") as handle:
                handle.write(b" ")
        return original(descriptor)

    monkeypatch.setattr(legacy_reader.os, "fstat", changed)
    with pytest.raises(DomainError) as error:
        safe_read(path, tmp_path, 10000)
    assert error.value.code == "legacy_file_changed"


@pytest.mark.parametrize('count', [0, 32768, 32769])
def test_windows_short_name_expansion_fails_closed(tmp_path, monkeypatch, count):
    import ctypes
    def expand(path, buffer, size):
        return count
    monkeypatch.setattr(ctypes, 'windll', SimpleNamespace(kernel32=SimpleNamespace(GetLongPathNameW=expand)), raising=False)
    with pytest.raises(DomainError) as error:
        legacy_reader._windows_long_path(tmp_path / 'source.json')
    assert error.value.code == 'legacy_path' and error.value.status == 403


@pytest.mark.parametrize('actual,expected', [
    ('C:/Users/RunnerAdmin/source.json', 'c:/users/runneradmin/source.json'),
    ('\\\\?\\C:\\Users\\RunnerAdmin\\source.json', 'C:/Users/RunnerAdmin/source.json'),
    ('\\\\?\\UNC\\server\\share\\source.json', '//server/share/source.json'),
])
def test_windows_long_names_preserve_drive_and_unc_authorities(monkeypatch, actual, expected):
    import ctypes
    def expand(path, buffer, size):
        assert path == 'C:/Users/RUNNER~1/source.json'
        buffer.value = actual
        return len(actual)
    monkeypatch.setattr(ctypes, 'windll', SimpleNamespace(kernel32=SimpleNamespace(GetLongPathNameW=expand)), raising=False)
    result = legacy_reader._windows_long_path('C:/Users/RUNNER~1/source.json')
    assert result == legacy_reader._windows_path(expected)
    assert result != legacy_reader._windows_path('D:/Users/RunnerAdmin/source.json')
    assert result != legacy_reader._windows_path('//different-server/share/source.json')


@pytest.mark.parametrize(("limits", "code"), [
    (LegacyLimits(max_files=0), "legacy_scan_limit"),
    (LegacyLimits(max_directories=0), "legacy_scan_limit"),
    (LegacyLimits(max_scan_bytes=1), "legacy_scan_limit"),
    (LegacyLimits(max_seconds=0), "legacy_scan_timeout"),
])
def test_whole_scan_limits_fail_without_publishing_partial_snapshot(tmp_path, limits, code):
    write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    with pytest.raises(DomainError) as error:
        reader(tmp_path, limits=limits).scan()
    assert error.value.code == code


def test_cancelled_scan_fails_before_reading_sources(tmp_path):
    stopped = threading.Event()
    stopped.set()
    with pytest.raises(DomainError) as error:
        reader(tmp_path).scan(cancel=stopped)
    assert error.value.code == "legacy_cancelled"


def test_progress_does_not_revert_to_reading_after_validation(tmp_path, monkeypatch):
    write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    phases = []
    clock = [0]
    def tick():
        clock[0] += .3
        return clock[0]
    monkeypatch.setattr(legacy_reader.time, 'monotonic', tick)
    result = reader(tmp_path).scan(progress=lambda phase, **counts: phases.append((phase, counts)))
    assert result.report['status'] == 'current'
    assert phases[0][0] == 'reading-legacy'
    assert phases[-1] == ('validating-records', {'filesRead': 1, 'recordsRead': 1})


def test_cancellation_during_file_conversion_does_not_publish_partial_snapshot(tmp_path, monkeypatch):
    write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    stopped = threading.Event()
    parse = legacy_reader.parse_legacy_json

    def cancelling(*args):
        result = parse(*args)
        stopped.set()
        return result

    monkeypatch.setattr(legacy_reader, "parse_legacy_json", cancelling)
    engine = reader(tmp_path)
    with pytest.raises(DomainError) as error:
        engine.scan(cancel=stopped)
    assert error.value.code == "legacy_cancelled"
    assert engine._revision == 0


def test_failed_snapshot_validation_does_not_commit_revision(tmp_path, monkeypatch):
    write(tmp_path, "2024/03/18/events.json", {"events": [event()]})
    engine = reader(tmp_path)
    validate = legacy_reader.validate_snapshot

    def fail(_snapshot):
        raise DomainError("test_validation", "Injected validation failure")

    monkeypatch.setattr(legacy_reader, "validate_snapshot", fail)
    with pytest.raises(DomainError):
        engine.scan()
    assert engine._revision == 0
    assert engine._last_signature is None
    monkeypatch.setattr(legacy_reader, "validate_snapshot", validate)
    assert engine.scan().snapshot["manifest"]["revision"] == 1


def test_record_conversion_limit_is_reported_and_diagnostics_are_bounded(tmp_path):
    for number in range(3):
        write(tmp_path, f"2024/03/18/{number}.json", {"events": [event(str(number))]})
    result = reader(tmp_path, limits=LegacyLimits(max_file_bytes=1, max_diagnostics=1)).scan()
    assert result.report["status"] == "incomplete"
    assert result.report["rejectedFiles"] == 3
    assert len(result.report["diagnostics"]) == 1
    assert result.report["diagnosticsOmitted"] == 2
    with pytest.raises(DomainError) as error:
        reader(tmp_path, limits=LegacyLimits(max_records=1)).scan()
    assert error.value.code == "legacy_record_limit"


def test_cli_exports_new_snapshot_and_never_writes_inside_legacy_root(tmp_path):
    root = tmp_path / "legacy"
    path = write(root, "2024/03/18/events.json", {"events": [event()]})
    original = path.read_bytes()
    command = [sys.executable, "scripts/import-legacy.py", "--source", f"source={root}",
               "--allow-root", str(root), "--data-model", "yyyy/mm/dd", "--timezone", "UTC"]
    output = tmp_path / "snapshot.json"
    run = subprocess.run([*command, "--output", str(output)], capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    assert json.loads(output.read_bytes())["manifest"]["recordCount"] == 1
    blocked = subprocess.run([*command, "--output", str(root / "forbidden.json")],
                             capture_output=True, text=True, check=False)
    assert blocked.returncode != 0
    assert not (root / "forbidden.json").exists()
    repeated = subprocess.run([*command, "--output", str(output)], capture_output=True, text=True, check=False)
    assert repeated.returncode != 0
    assert path.read_bytes() == original


def test_cli_does_not_export_incomplete_source_as_complete_snapshot(tmp_path):
    root = tmp_path / "legacy"
    path = write(root, "2024/03/18/events.json", {})
    output, report = tmp_path / "snapshot.json", tmp_path / "report.json"
    run = subprocess.run([sys.executable, "scripts/import-legacy.py", "--source", f"source={root}",
                          "--allow-root", str(root), "--output", str(output), "--report", str(report)],
                         capture_output=True, text=True, check=False)
    assert run.returncode != 0
    assert not output.exists()
    assert json.loads(report.read_bytes())["status"] == "incomplete"
    assert path.read_bytes() == b"{}"


def test_cli_accepts_dated_yaml_without_executing_connectors(tmp_path):
    project, data = tmp_path / "project", tmp_path / "data"
    project.mkdir()
    write(data / "source", "2024/03/18/events.json", {"events": [event()]})
    config = write(project, "sources.yml", {"data_sources": [{"namespace": "operations", "type": "json_file",
        "enable": True, "data_path": "/data/source", "data_model": "/data/source/yyyy/mm/dd",
        "connector": "must never execute", "converter2events_class": "build_in"}]})
    output = tmp_path / "snapshot.json"
    run = subprocess.run([sys.executable, "scripts/import-legacy.py", "--legacy-yaml", str(config),
                          "--legacy-root", str(project), "--path-map", f"/data={data}",
                          "--allow-root", str(data), "--output", str(output)],
                         capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    assert json.loads(output.read_bytes())["manifest"]["recordCount"] == 1
    assert json.loads(run.stdout)["configuration"]["sources"][0]["dataModel"] == "yyyy/mm/dd"


def test_cli_model_export_preserves_records_and_explicit_declared_universe(tmp_path):
    project, data = tmp_path / "project", tmp_path / "data"
    project.mkdir()
    write(data / "source", "2024/03/17/events.json", {"events": [event("outside", "2024-03-17T01:00:00Z")]})
    write(data / "source", "2024/03/18/events.json", {"events": [event()]})
    config = write(project, "sources.yml", {"data_sources": [{"namespace": "operations", "type": "json_file",
        "enable": True, "data_path": "/data/source", "data_model": "/data/source/yyyy/mm/dd",
        "render": {"color": "#112233", "textColor": "#FFFFFF"}}]})
    fixture = json.loads(Path("shared/fixtures/legacy-presentation.json").read_bytes())["namespace"]["model"]
    model = write(project, "models/timeline.json", fixture)
    model_before = model.read_bytes()
    output = tmp_path / "snapshot.json"
    run = subprocess.run([sys.executable, "scripts/import-legacy.py", "--legacy-yaml", str(config),
                          "--legacy-root", str(project), "--path-map", f"/data={data}", "--allow-root", str(data),
                          "--model", "models/timeline.json", "--namespace-grouping", "--from", DAY["from"],
                          "--to", DAY["to"], "--output", str(output)],
                         capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr
    snapshot = json.loads(output.read_bytes())
    assert snapshot["manifest"]["recordCount"] == 1
    assert snapshot["manifest"]["legacy"]["allRecordCount"] == 2
    assert snapshot["manifest"]["legacy"]["declaredRange"] == DAY
    assert snapshot["settings"]["range"] == DAY
    assert snapshot["settings"]["overview"] == DAY
    assert snapshot["records"][0]["title"] == "point"
    assert snapshot["settings"]["presentation"]["grouping"]["field"] == "/data/namespace"
    assert snapshot["settings"]["presentation"]["sourceStyles"][0]["backgroundColor"] == "#112233"
    assert snapshot["manifest"]["legacy"]["viewHints"]["bands"]["primary"]["heightFraction"] == 0.75
    assert model.read_bytes() == model_before


def test_cli_visual_model_cannot_escape_legacy_project(tmp_path):
    project, data = tmp_path / "project", tmp_path / "data"
    project.mkdir()
    write(data / "source", "2024/03/18/events.json", {"events": [event()]})
    config = write(project, "sources.yml", {"data_sources": [{"namespace": "operations", "type": "json_file",
        "enable": True, "data_path": "/data/source", "data_model": "/data/source/yyyy/mm/dd"}]})
    outside = write(tmp_path, "outside-model.json", {})
    run = subprocess.run([sys.executable, "scripts/import-legacy.py", "--legacy-yaml", str(config),
                          "--legacy-root", str(project), "--path-map", f"/data={data}",
                          "--allow-root", str(data), "--model", str(outside)],
                         capture_output=True, text=True, check=False)
    assert run.returncode != 0
    assert json.loads(run.stderr)["code"] == "legacy_path"


@pytest.mark.parametrize("values", [{"max_files": -1}, {"max_records": 1.5}, {"max_scan_bytes": True},
                                     {"max_seconds": float("nan")}, {"max_seconds": float("inf")}])
def test_invalid_limits_do_not_remove_admission_bounds(values):
    with pytest.raises(DomainError) as error:
        LegacyLimits(**values)
    assert error.value.code == "legacy_limits"
