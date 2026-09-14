import json
import stat
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from server.app.models.domain import DomainError
from server.app.services.legacy_sources import (
    is_partition_directory,
    is_partition_file,
    load_legacy_sources,
    partition_date,
    partition_interval,
    partition_paths,
    split_data_model,
)


@pytest.fixture
def source_config(tmp_path):
    legacy = tmp_path / "legacy"
    data = tmp_path / "data"
    (legacy / "yaml").mkdir(parents=True)
    (data / "earthquake").mkdir(parents=True)
    path = legacy / "yaml" / "sources.yml"
    entry = {
        "namespace": "earthquake", "type": "json_file", "enable": True,
        "permission": "", "converter2events_class": "build_in", "data_path": "/data/",
        "data_model": "/data/earthquake/yyyy/mm/dd", "filter": {"include": "", "exclude": ""},
        "connector": "secure_sse:8441|secure:8442", "render": {"color": "#BBEDF0"},
    }

    def load(entries=None, raw=None, **options):
        payload = {"data_sources": json.loads(json.dumps(entries or [entry]))}
        path.write_text(raw if raw is not None else yaml.safe_dump(payload), encoding="utf-8")
        arguments = {"legacy_root": legacy, "allow_roots": [data], "path_maps": {"/data": data}, **options}
        return load_legacy_sources(path, **arguments)

    return load, entry, legacy, data, path


def test_legacy_yaml_remaps_absolute_prefix_and_never_executes_connector(source_config):
    load, _, _, data, path = source_config
    result = load()
    before = path.read_bytes()
    assert result.sources[0].root == data / "earthquake"
    assert result.sources[0].data_model == "yyyy/mm/dd"
    assert result.sources[0].timezone == "UTC"
    assert result.sources[0].id.startswith("earthquake-")
    assert result.render_sources == [{"sourceId": result.sources[0].id, "namespace": "earthquake", "render": {"color": "#BBEDF0"}}]
    assert result.metadata()["readOnly"] is True
    assert result.metadata()["sources"][0]["available"] is True
    assert "legacy_connector_not_executed" in {item["code"] for item in result.diagnostics}
    assert "secure_sse" not in str(result.metadata())
    assert path.read_bytes() == before


def test_relative_model_is_based_at_legacy_root_not_yaml_directory(source_config):
    load, entry, legacy, _, _ = source_config
    (legacy / "tests" / "data" / "SOURCES1").mkdir(parents=True)
    entry.update(data_path="tests/data/", data_model="tests/data/SOURCES1/yyyy/mm/dd")
    result = load(allow_roots=[legacy / "tests" / "data"])
    assert result.sources[0].root == legacy / "tests" / "data" / "SOURCES1"


def test_longest_component_prefix_map_wins(source_config):
    load, _, _, data, _ = source_config
    (data / "alternate").mkdir()
    result = load(path_maps={"/data": data, "/data/earthquake": data / "alternate"})
    assert result.sources[0].root == data / "alternate"


def test_prefix_map_does_not_match_a_partial_component(source_config):
    load, entry, _, data, _ = source_config
    entry.update(data_path="/database", data_model="/database/earthquake/yyyy/mm/dd")
    with pytest.raises(DomainError):
        load(path_maps={"/data": data})


def test_disabled_and_non_json_sources_do_not_resolve_or_execute_paths(source_config):
    load, entry, *_ = source_config
    result = load([entry, {"enable": False, "type": "json_file", "data_model": "../../private"},
                   {"enable": True, "type": "postgresql", "password": "do-not-report", "host": "example.invalid"}])
    assert len(result.sources) == 1
    assert "do-not-report" not in str(result.metadata())
    assert {item["code"] for item in result.diagnostics} >= {
        "legacy_source_disabled", "legacy_source_type_unsupported"}


@pytest.mark.parametrize("field,value,code", [
    ("converter2events_class", "dangerous.class", "legacy_converter_unsupported"),
    ("permission", "private", "legacy_permission_unsupported"),
    ("filter", {"include": "secret"}, "legacy_source_filter_unsupported"),
])
def test_untranslatable_access_or_transform_policy_fails_closed(source_config, field, value, code):
    load, entry, *_ = source_config
    result = load([{**entry, field: value}])
    assert not result.sources
    assert result.diagnostics == [{"index": 0, "code": code, "severity": "error"}]


def test_missing_root_is_reported_without_creation(source_config):
    load, entry, _, data, _ = source_config
    entry["data_model"] = "/data/missing/yyyy/mm/dd"
    result = load()
    assert not (data / "missing").exists()
    assert not result.metadata()["sources"][0]["available"]
    assert "legacy_source_root_missing" in {item["code"] for item in result.diagnostics}


def test_authored_buildin_marker_is_an_explicit_compatibility_alias(source_config):
    load, entry, *_ = source_config
    entry["converter2events_class"] = "buildin"
    result = load()
    assert len(result.sources) == 1
    assert {"index": 0, "code": "legacy_builtin_alias", "severity": "info"} in result.diagnostics


def test_duplicate_namespace_ids_are_stable_when_yaml_order_changes(source_config):
    load, entry, _, data, _ = source_config
    (data / "volcano").mkdir()
    other = {**entry, "data_model": "/data/volcano/yyyy/mm/dd"}
    first, second = load([entry, other]), load([other, entry])
    assert {item.root: item.id for item in first.sources} == {item.root: item.id for item in second.sources}
    assert load([entry]).sources[0].id == first.sources[0].id
    assert len({item.id for item in first.sources}) == 2
    with pytest.raises(DomainError, match="Duplicate legacy"):
        load([entry, dict(entry)])


@pytest.mark.parametrize("model", [
    "/data/../secret/yyyy/mm/dd", "/data/./earthquake/yyyy/mm/dd", "https://example.invalid/yyyy/mm/dd",
    "//host/share/yyyy/mm/dd", "/data/%USER%/yyyy/mm/dd", "/data/*/yyyy/mm/dd",
    "/data/earthquake/yyyy/dd/mm", "/data/earthquake/yyyy/MM/dd", "/data/earthquake/yyyy/mm/dd/files",
    "/data/earthquake/yyyy/mm/dd/yyyy", "/data/earthquake/events.json", "C:relative/yyyy/mm/dd",
    "/data/earthquake:alternate/yyyy/mm/dd",
])
def test_unsafe_or_ambiguous_templates_are_rejected(source_config, model):
    load, entry, *_ = source_config
    entry["data_model"] = model
    with pytest.raises(DomainError):
        load()


def test_root_outside_allowlist_is_rejected(source_config):
    load, _, legacy, *_ = source_config
    with pytest.raises(DomainError, match="allowlist"):
        load(allow_roots=[legacy])


def test_data_model_must_be_within_declared_data_path(source_config):
    load, entry, *_ = source_config
    entry["data_path"] = "/data/other"
    with pytest.raises(DomainError, match="data_path"):
        load()


@pytest.mark.parametrize("raw", [
    "data_sources: []\ndata_sources: []\n",
    "data_sources:\n- enable: true\n  enable: false\n",
    "data_sources: &loop [*loop]\n",
    "data_sources: !!python/object/apply:os.system ['echo invalid']\n",
    "data_sources: !!map invalid\n",
    "data_sources:\n- <<: {enable: true}\n",
    "data_sources: []\nunrecognized_root: true\n",
    "data_sources:\n- enable: 'true'\n",
])
def test_unsafe_or_ambiguous_yaml_is_rejected(source_config, raw):
    load, *_ = source_config
    with pytest.raises(DomainError):
        load(raw=raw)


def test_yaml_depth_and_size_are_bounded(source_config):
    load, *_ = source_config
    with pytest.raises(DomainError):
        load(raw="data_sources: " + "[" * 100 + "0" + "]" * 100)
    with pytest.raises(DomainError):
        load(raw="data_sources: []\n#" + "x" * (1024 * 1024))


def test_unknown_timezone_does_not_use_machine_timezone(source_config):
    load, *_ = source_config
    with pytest.raises(DomainError, match="timezone"):
        load(timezone="Unknown/Local")


@pytest.mark.parametrize("model,expected", [
    ("/data/source/yyyy", ("/data/source", "yyyy")),
    ("/data/source/yyyy/mm", ("/data/source", "yyyy/mm")),
    ("tests/data/SOURCE1/yyyy/mm/dd/", ("tests/data/SOURCE1", "yyyy/mm/dd")),
    (r"C:\data\source\yyyy\mm\dd", ("C:/data/source", "yyyy/mm/dd")),
])
def test_supported_calendar_suffixes(model, expected):
    assert split_data_model(model) == expected


@pytest.mark.parametrize("path", ["2024/02/29/events.json", "2024/02/29/nested/a.JSON", "2000/12/31/zones.json"])
def test_valid_partition_files(path):
    assert is_partition_file(Path(path))
    assert partition_date(Path(path)) == date(*(int(value) for value in path.split("/")[:3]))


@pytest.mark.parametrize("path", [
    "2023/02/29/events.json", "2024/02/30/events.json", "0000/01/01/events.json", "2024/13/01/events.json",
    "2024/2/29/events.json", "2024/02/9/events.json", "2024/02/29/events.json.tmp", "2024/02/29",
    "2024/02/29/descriptors/a.json", "2024/02/29/noises/a.json", "2024/02/29/descriptors_backup/a.json",
    "2024/02/29/.hidden/a.json", "2024/02/29/../../other.json", "/2024/02/29/a.json", "C:/2024/02/29/a.json",
])
def test_invalid_or_excluded_partition_files(path):
    assert not is_partition_file(path)


@pytest.mark.parametrize("path", [".", "2024", "2024/02", "2024/02/29", "2024/02/29/nested"])
def test_valid_directory_prefixes(path):
    assert is_partition_directory(Path(path))


@pytest.mark.parametrize("path", ["2023/02/29", "2024/13", "2024/00", "2024/2", "2024/noises", "elsewhere"])
def test_invalid_directory_prefixes(path):
    assert not is_partition_directory(path)


def test_calendar_range_handles_year_and_leap_boundaries_without_fixed_steps(tmp_path):
    paths = partition_paths(tmp_path, "2023-12-31T23:00:00Z", "2024-01-02T00:00:00Z", existing_only=False)
    assert [path.relative_to(tmp_path).as_posix() for path in paths] == ["2023/12/31", "2024/01/01"]
    paths = partition_paths(tmp_path, "2024-02-28T00:00:00Z", "2024-03-01T00:00:00Z", existing_only=False)
    assert [path.relative_to(tmp_path).as_posix() for path in paths] == ["2024/02/28", "2024/02/29"]


def test_month_and_year_ranges_are_calendar_based(tmp_path):
    months = partition_paths(tmp_path, "2023-12-31T00:00:00Z", "2024-03-01T00:00:00Z",
                             data_model="yyyy/mm", existing_only=False)
    assert [path.relative_to(tmp_path).as_posix() for path in months] == ["2023/12", "2024/01", "2024/02"]
    years = partition_paths(tmp_path, "2023-12-31T00:00:00Z", "2025-01-01T00:00:00Z",
                            data_model="yyyy", existing_only=False)
    assert [path.relative_to(tmp_path).as_posix() for path in years] == ["2023", "2024"]


def test_missing_dates_are_empty_gaps_and_not_created(tmp_path):
    (tmp_path / "2024" / "02" / "29").mkdir(parents=True)
    paths = partition_paths(tmp_path, "2024-02-28T00:00:00Z", "2024-03-02T00:00:00Z")
    assert paths == [tmp_path / "2024" / "02" / "29"]
    assert not (tmp_path / "2024" / "03").exists()


def test_partition_timezone_is_explicit_and_handles_dst(tmp_path):
    paths = partition_paths(tmp_path, "2024-01-01T00:00:00Z", "2024-01-01T01:00:00Z",
                            timezone="America/New_York", existing_only=False)
    assert paths == [tmp_path / "2023" / "12" / "31"]
    first, last = partition_interval(date(2024, 3, 10), timezone="America/New_York")
    assert last - first == timedelta(hours=23)
    first, last = partition_interval(date(2024, 11, 3), timezone="America/New_York")
    assert last - first == timedelta(hours=25)


@pytest.mark.parametrize("start,end", [
    ("2024-01-01", "2024-01-02"), ("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
    ("2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z"), ("invalid", "2024-01-01T00:00:00Z"),
])
def test_partition_range_rejects_naive_empty_reversed_or_invalid_instants(tmp_path, start, end):
    with pytest.raises(DomainError):
        partition_paths(tmp_path, start, end)


def test_partition_capacity_counts_missing_directories_too(tmp_path):
    with pytest.raises(DomainError, match="limit"):
        partition_paths(tmp_path, "2024-01-01T00:00:00Z", "2024-01-04T00:00:00Z", max_partitions=2)


@pytest.mark.parametrize("mode,attributes", [(stat.S_IFLNK, 0), (stat.S_IFDIR, 0x400)])
def test_symlink_roots_and_partition_directories_are_rejected(source_config, monkeypatch, mode, attributes):
    load, entry, _, data, _ = source_config
    target = data / "earthquake"
    link = data / "alias"
    actual_lstat = Path.lstat
    forbidden = {link, target / "2024" / "01" / "01"}

    def lstat(path, *args, **kwargs):
        if path in forbidden:
            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
        return actual_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    entry["data_model"] = "/data/alias/yyyy/mm/dd"
    with pytest.raises(DomainError, match="Symlinks"):
        load()
    with pytest.raises(DomainError, match="Symlinks"):
        partition_paths(target, "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z")
