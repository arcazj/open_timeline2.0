"""Read-only legacy YAML source configuration and calendar partition paths.

Partition folders describe storage, not record bounds. A range reader must also
consult its record/file interval index for sessions that began in older folders.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml

from ..models.domain import DomainError


_MODELS = {"yyyy": 1, "yyyy/mm": 2, "yyyy/mm/dd": 3}
_SOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class _SourceLoader(yaml.SafeLoader):
    """Bound construction and reject aliases/duplicate keys before interpretation."""

    def __init__(self, stream):
        super().__init__(stream)
        self._depth = 0
        self._nodes = 0

    def compose_node(self, parent, index):
        if self.check_event(yaml.AliasEvent):
            raise yaml.YAMLError("Aliases are not source configuration values.")
        self._depth += 1
        self._nodes += 1
        try:
            if self._depth > 24 or self._nodes > 20000:
                raise yaml.YAMLError("Source configuration exceeds its structural limit.")
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1

    def construct_mapping(self, node, deep=False):
        if not isinstance(node, yaml.MappingNode):
            raise yaml.YAMLError("Source configuration mappings require mapping nodes.")
        keys = set()
        for key_node, _ in node.value:
            if key_node.tag != "tag:yaml.org,2002:str":
                raise yaml.YAMLError("Source configuration requires string keys without merge keys.")
            key = self.construct_object(key_node, deep=deep)
            if key in keys:
                raise yaml.YAMLError("Duplicate source configuration key.")
            keys.add(key)
        return super().construct_mapping(node, deep=deep)


@dataclass(frozen=True)
class LegacySourceConfiguration:
    sources: tuple
    diagnostics: list[dict]
    render_sources: list[dict]
    timezone: str

    def metadata(self):
        return {
            "readOnly": True,
            "partitionTimezone": self.timezone,
            "sources": [{"id": source.id, "sourceId": source.id, "namespace": source.namespace,
                         "dataModel": source.data_model, "readOnly": True,
                         "available": Path(source.root).is_dir()}
                        for source in self.sources],
            "diagnostics": list(self.diagnostics),
        }


def _zone(value):
    if not isinstance(value, str) or not value or len(value) > 128:
        raise DomainError("legacy_timezone", "A bounded IANA partition timezone is required.")
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise DomainError("legacy_timezone", "Unknown partition timezone.") from error


def _logical_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise DomainError("legacy_source_path", "A bounded explicit source path is required.")
    value = value.replace("\\", "/")
    if (value.startswith("//") or any(ord(char) < 32 for char in value)
            or any(char in value for char in ("?", "*", "%", "~", "\x7f"))
            or "://" in value or any(part in (".", "..") for part in value.split("/"))):
        raise DomainError("legacy_source_path", "Source paths cannot contain traversal, URLs, or substitutions.", 403)
    value = value.rstrip("/")
    if not value or any(":" in part for part in value.split("/")[1:]):
        raise DomainError("legacy_source_path", "Invalid legacy source path.", 403)
    if ":" in value and not re.match(r"^[A-Za-z]:/", value):
        raise DomainError("legacy_source_path", "Drive-relative and stream paths are not source roots.", 403)
    return value


def split_data_model(value):
    """Return the static logical root and exact supported calendar suffix."""
    logical = _logical_path(value)
    parts = logical.split("/")
    index = next((i for i, part in enumerate(parts) if part in ("yyyy", "mm", "dd")), None)
    if index is None:
        raise DomainError("legacy_data_model", "Legacy data_model must end in yyyy, yyyy/mm, or yyyy/mm/dd.")
    root, model = "/".join(parts[:index]), "/".join(parts[index:])
    if not root or model not in _MODELS:
        raise DomainError("legacy_data_model", "Date tokens must form one exact trailing calendar path.")
    return root, model


def _guard_path(path):
    path = Path(os.path.abspath(path))
    for component in (path, *path.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & _REPARSE:
            raise DomainError("legacy_source_path", "Symlinks and reparse points cannot select legacy sources.", 403)
    return path


def _mapped_root(value, legacy_root, path_maps):
    logical = _logical_path(value)
    mappings = []
    for prefix, target in path_maps.items():
        prefix = _logical_path(prefix)
        target = Path(target)
        if not target.is_absolute() or any(part == ".." for part in target.parts):
            raise DomainError("legacy_path_map", "Operator path-map targets must be absolute paths without traversal.")
        mappings.append((prefix, _guard_path(target)))
    for prefix, target in sorted(mappings, key=lambda item: len(item[0]), reverse=True):
        if logical == prefix or logical.startswith(prefix + "/"):
            return _guard_path(target.joinpath(*logical[len(prefix):].strip("/").split("/")))
    if os.name == "nt" and logical.startswith("/"):
        raise DomainError("legacy_path_map", "POSIX legacy roots require an explicit operator path map on Windows.")
    if os.name != "nt" and PureWindowsPath(logical).drive:
        raise DomainError("legacy_path_map", "Windows legacy roots require an explicit operator path map on this host.")
    candidate = Path(logical)
    return _guard_path(candidate if candidate.is_absolute() else legacy_root / candidate)


def _within(path, roots):
    return any(path == root or path.is_relative_to(root) for root in roots)


def load_legacy_sources(config_path, *, legacy_root, allow_roots, path_maps=None,
                        timezone="UTC", dialect="strict", document=None):
    """Load enabled JSON sources from an operator-selected legacy YAML file.

    Paths are resolved against legacy_root, not the YAML directory. Explicit
    path_maps use longest component-prefix matching, e.g. {"/data": "C:/data"}.
    Unsupported nonempty permissions/filters/converters fail closed per source.
    No connector, executable converter, or non-JSON database is ever opened.
    """
    from .legacy_reader import LegacySource, safe_read

    _zone(timezone)
    if dialect not in ("strict", "legacy-json"):
        raise DomainError("legacy_dialect", "Unknown legacy JSON dialect.")
    legacy_root = _guard_path(legacy_root)
    approved = [_guard_path(root) for root in allow_roots]
    if not approved:
        raise DomainError("legacy_allowlist", "An explicit legacy data root allowlist is required.", 403)
    if not isinstance(path_maps or {}, dict):
        raise DomainError("legacy_path_map", "Path maps must be an operator-supplied mapping.")
    if document is None:
        path = _guard_path(config_path)
        try:
            raw = safe_read(path, Path(path.anchor), 1024 * 1024)
            document = yaml.load(raw.decode("utf-8-sig"), Loader=_SourceLoader)
        except (yaml.YAMLError, UnicodeError, RecursionError) as error:
            raise DomainError("legacy_yaml", "Invalid, duplicate-key, aliased, or excessive legacy YAML configuration.") from error
    if not isinstance(document, dict) or set(document) != {"data_sources"}:
        raise DomainError("legacy_yaml", "A legacy source YAML file must contain only data_sources.")
    entries = document["data_sources"]
    if not isinstance(entries, list) or len(entries) > 100:
        raise DomainError("legacy_yaml", "data_sources must be a list containing at most 100 entries.")
    accepted, diagnostics = [], []

    def report(index, code, severity="warning", **details):
        diagnostics.append({"index": index, "code": code, "severity": severity, **details})

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or type(entry.get("enable")) is not bool:
            raise DomainError("legacy_yaml", "Each source requires an explicit boolean enable flag.")
        if not entry["enable"]:
            report(index, "legacy_source_disabled", "info")
            continue
        if entry.get("type") != "json_file":
            report(index, "legacy_source_type_unsupported", "error")
            continue
        namespace = entry.get("namespace")
        if not isinstance(namespace, str) or not 1 <= len(namespace) <= 256 or any(ord(c) < 32 for c in namespace):
            raise DomainError("legacy_namespace", "YAML source namespace must contain 1 to 256 readable characters.")
        converter = entry.get("converter2events_class", "build_in")
        if converter not in ("", "build_in", "buildin", None):
            report(index, "legacy_converter_unsupported", "error")
            continue
        if converter == "buildin":
            report(index, "legacy_builtin_alias", "info")
        if entry.get("permission") not in (None, ""):
            report(index, "legacy_permission_unsupported", "error")
            continue
        filters = entry.get("filter", {})
        if not isinstance(filters, dict) or any(value not in (None, "") for value in filters.values()):
            report(index, "legacy_source_filter_unsupported", "error")
            continue
        logical, model = split_data_model(entry.get("data_model"))
        root = _mapped_root(logical, legacy_root, path_maps or {})
        if not _within(root, approved):
            raise DomainError("legacy_allowlist", "Legacy source root is outside the operator allowlist.", 403)
        if "data_path" in entry:
            base = _mapped_root(entry["data_path"], legacy_root, path_maps or {})
            if not _within(root, [base]):
                raise DomainError("legacy_data_model", "data_model must remain within its declared data_path.", 403)
        if not root.is_dir():
            report(index, "legacy_source_root_missing", "error")
        render = entry.get("render", {})
        if not isinstance(render, dict):
            raise DomainError("legacy_render", "Source render settings must be an object.")
        colors = {}
        for field, value in render.items():
            if field in ("color", "textColor", "dateColor", "alternateColor") and isinstance(value, str) and _COLOR.fullmatch(value):
                colors[field] = value
            else:
                report(index, "legacy_source_render_unsupported", field=str(field)[:64])
        if entry.get("connector"):
            report(index, "legacy_connector_not_executed", "info")
        known = {"namespace", "type", "enable", "permission", "converter2events_class", "data_path",
                 "data_model", "filter", "connector", "render"}
        for field in sorted(set(entry) - known):
            report(index, "legacy_source_option_unsupported", field=field[:64])
        accepted.append((index, namespace, logical, root, model, colors))

    counts = {}
    for _, namespace, *_ in accepted:
        counts[namespace] = counts.get(namespace, 0) + 1
    sources, styles, seen = [], [], set()
    for index, namespace, logical, root, model, colors in accepted:
        digest = hashlib.sha256((namespace + "\0" + logical + "/" + model).encode()).hexdigest()[:16]
        identity = (namespace[:100] if _SOURCE_ID.fullmatch(namespace) else "legacy") + "-" + digest
        authority = (namespace, root, model)
        if authority in seen:
            raise DomainError("legacy_source_duplicate", "Duplicate legacy namespace/path source definition.")
        seen.add(authority)
        if counts[namespace] > 1:
            report(index, "legacy_namespace_multiple_sources", "info", sourceId=identity)
        sources.append(LegacySource(identity, root, namespace, timezone, dialect, data_model=model))
        styles.append({"sourceId": identity, "namespace": namespace, "render": colors})
    return LegacySourceConfiguration(tuple(sources), diagnostics, styles, timezone)


def _relative_parts(relative):
    raw = str(relative).replace("\\", "/")
    if not raw or raw.startswith("/") or PureWindowsPath(raw).drive:
        return None
    parts = raw.split("/")
    if any(not part or part in (".", "..") or ":" in part for part in parts):
        return None
    return parts


def _partition(parts, model):
    count = _MODELS.get(model)
    if count is None:
        raise DomainError("legacy_data_model", "Unsupported calendar partition suffix.")
    if len(parts) < count or not re.fullmatch(r"[0-9]{4}", parts[0]):
        return None
    if any(not re.fullmatch(r"[0-9]{2}", value) for value in parts[1:count]):
        return None
    try:
        return date(int(parts[0]), int(parts[1]) if count >= 2 else 1, int(parts[2]) if count == 3 else 1)
    except ValueError:
        return None


def partition_date(relative, data_model="yyyy/mm/dd"):
    parts = _relative_parts(relative)
    return _partition(parts, data_model) if parts else None


def _excluded(part):
    part = part.casefold()
    return part.startswith((".", "descriptors")) or "noises" in part


def is_partition_file(relative, data_model="yyyy/mm/dd"):
    parts = _relative_parts(relative)
    return bool(parts and len(parts) > _MODELS.get(data_model, 0)
                and not any(_excluded(part) for part in parts)
                and PurePosixPath(parts[-1]).suffix.casefold() == ".json"
                and _partition(parts, data_model) is not None)


def is_partition_directory(relative, data_model="yyyy/mm/dd"):
    if str(relative) in ("", "."):
        return True
    parts = _relative_parts(relative)
    count = _MODELS.get(data_model)
    if count is None:
        raise DomainError("legacy_data_model", "Unsupported calendar partition suffix.")
    if not parts or any(_excluded(part) for part in parts):
        return False
    prefix = parts[:count]
    padded = prefix + ["01"] * (count - len(prefix))
    return _partition(padded, data_model) is not None


def _instant(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(parsed, datetime) or parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("An offset-aware instant is required.")
        return parsed.astimezone(dt_timezone.utc)
    except (ValueError, TypeError, OverflowError) as error:
        raise DomainError("legacy_partition_range", "Partition range endpoints require offset-aware ISO instants.") from error


def partition_paths(root, start, end, *, data_model="yyyy/mm/dd", timezone="UTC",
                    existing_only=True, max_partitions=40000):
    """Return calendar folders intersecting [start, end), not all overlapping records.

    Missing dates are ordinary gaps. Calendar arithmetic avoids fixed month/year
    durations and includes a local day only when it overlaps the requested range.
    """
    if data_model not in _MODELS:
        raise DomainError("legacy_data_model", "Unsupported calendar partition suffix.")
    if type(max_partitions) is not int or not 1 <= max_partitions <= 40000:
        raise DomainError("legacy_partition_limit", "Partition limit must be between 1 and 40000.")
    zone = _zone(timezone)
    start, end = _instant(start), _instant(end)
    if start >= end:
        raise DomainError("legacy_partition_range", "Partition range must have a positive duration.")
    root = _guard_path(root)
    first, last = start.astimezone(zone).date(), (end - timedelta(microseconds=1)).astimezone(zone).date()
    count = _MODELS[data_model]
    current = first.replace(month=1, day=1) if count == 1 else first.replace(day=1) if count == 2 else first
    result, visited = [], 0
    while current <= last:
        visited += 1
        if visited > max_partitions:
            raise DomainError("legacy_partition_limit", "Requested range exceeds the calendar partition limit.", 413)
        values = (f"{current.year:04d}", f"{current.month:02d}", f"{current.day:02d}")
        path = _guard_path(root.joinpath(*values[:count]))
        if not existing_only or path.is_dir():
            result.append(path)
        try:
            if count == 1:
                current = current.replace(year=current.year + 1)
            elif count == 2:
                current = current.replace(year=current.year + 1, month=1) if current.month == 12 else current.replace(month=current.month + 1)
            else:
                current += timedelta(days=1)
        except (ValueError, OverflowError):
            break
    return result


def partition_interval(day, *, data_model="yyyy/mm/dd", timezone="UTC"):
    """Return UTC bounds for a calendar leaf, including DST-short/long days."""
    count = _MODELS.get(data_model)
    if count is None or type(day) is not date:
        raise DomainError("legacy_partition_date", "A calendar date and supported partition suffix are required.")
    zone = _zone(timezone)
    first = day.replace(month=1, day=1) if count == 1 else day.replace(day=1) if count == 2 else day
    try:
        if count == 1:
            last = first.replace(year=first.year + 1)
        elif count == 2:
            last = first.replace(year=first.year + 1, month=1) if first.month == 12 else first.replace(month=first.month + 1)
        else:
            last = first + timedelta(days=1)
    except (ValueError, OverflowError) as error:
        raise DomainError("legacy_partition_date", "Calendar partition is outside the supported datetime range.") from error
    return tuple(datetime.combine(value, time.min, zone).astimezone(dt_timezone.utc) for value in (first, last))
