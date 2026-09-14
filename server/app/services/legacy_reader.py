"""Allowlisted, read-only legacy file snapshots with explicit compatibility reports."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import stat
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from ..models.domain import DomainError, instant_ms, iso_from_ms, json_bytes, now_iso, validate_snapshot
from .legacy_json import legacy_instant, parse_legacy_json


LEGACY_ID_NAMESPACE = uuid.UUID("c51e00ef-a902-521c-9c51-b8f64c6634a1")
SCHEMA_ID = "legacy-read-only-fields"
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
SOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
MAX_LEGACY_INSTANT = instant_ms("9999-12-31T23:59:59.999Z")
ICON_MAP = {"ob_check.png": "check", "ob_error.png": "alert-triangle", "ob_yellow_flag.png": "flag",
            "ob_red_flag.png": "flag", "ob_info.png": "info", "ob_phone.png": "radio",
            "ob_clock.png": "clock", "ob_volcano_active.png": "alert-triangle",
            "ob_volcano.png": "alert-triangle", "ob_volcano_no_active.png": "alert-triangle"}
HAZARD_ICONS = json.loads((Path(__file__).resolve().parents[3] / "shared/legacy-hazard-icons.json").read_text(encoding="utf-8"))
ICON_MAP.update(HAZARD_ICONS)


@dataclass(frozen=True)
class LegacySource:
    id: str
    root: Path | str
    namespace: str | None = None
    timezone: str | None = None
    dialect: str = "strict"
    abbreviations: dict = field(default_factory=dict)
    data_model: str | None = None


@dataclass(frozen=True)
class LegacyLimits:
    max_files: int = 20000
    max_directories: int = 30000
    max_file_bytes: int = 32 * 1024 * 1024
    max_scan_bytes: int = 512 * 1024 * 1024
    max_records: int = 250000
    max_seconds: float = 180
    cache_bytes: int = 64 * 1024 * 1024
    max_diagnostics: int = 2000

    def __post_init__(self):
        for name in ("max_files", "max_directories", "max_file_bytes", "max_scan_bytes",
                     "max_records", "cache_bytes", "max_diagnostics"):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise DomainError("legacy_limits", "Legacy count and byte limits require nonnegative integers.")
        if (type(self.max_seconds) not in (int, float) or not math.isfinite(self.max_seconds)
                or self.max_seconds < 0):
            raise DomainError("legacy_limits", "Legacy scan time limit must be finite and nonnegative.")


@dataclass
class LegacyScan:
    snapshot: dict
    report: dict


def canonical_legacy_id(source_id, namespace, legacy_id, relative_path, pointer):
    identity = [source_id, namespace, "id", str(legacy_id)] if legacy_id not in (None, "") else [
        source_id, namespace, "location", relative_path, pointer]
    return str(uuid.uuid5(LEGACY_ID_NAMESPACE, json_bytes(identity).decode("utf-8")))


def _resource(identity, name, definition, timestamp):
    return {"formatVersion": 1, "id": identity, "name": name, "description": "Read-only legacy compatibility",
            "tags": ["legacy", "read-only"], "revision": 1, "lifecycle": "active", "createdAt": timestamp,
            "updatedAt": timestamp, "ownerId": "legacy-reader", "visibility": "workspace", "copiedFrom": None,
            "draft": None, "versions": [{"version": 1, "publishedAt": timestamp,
                                           "publishedBy": "legacy-reader", "definition": definition}]}


def _unsafe(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & REPARSE)


def _path_guard(path, root):
    path = Path(os.path.abspath(path))
    try:
        path.relative_to(root)
    except ValueError as error:
        raise DomainError("legacy_path", "Legacy paths must remain within their configured source root.", 403) from error
    for component in (path, *path.parents):
        info = component.lstat()
        if _unsafe(info):
            raise DomainError("legacy_path", "Symlinks and reparse points are not legacy source authorities.", 403)
        if component == root:
            break
    return path


def safe_read(path, root, maximum):
    """Read an ordinary file, binding its opened handle to the approved path."""
    path = _path_guard(path, root)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
        raise DomainError("legacy_file_limit", "Legacy file is not ordinary or exceeds the configured byte limit.", 413)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise DomainError("legacy_file_changed", "Legacy file changed while it was being opened.", 409)
        if os.name == "nt":
            import ctypes
            import msvcrt
            from ctypes import wintypes
            final_path = ctypes.windll.kernel32.GetFinalPathNameByHandleW
            final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
            final_path.restype = wintypes.DWORD
            buffer = ctypes.create_unicode_buffer(32768)
            count = final_path(msvcrt.get_osfhandle(descriptor), buffer, len(buffer), 0)
            if not count or count >= len(buffer):
                raise DomainError("legacy_path", "Cannot verify the opened legacy file path.", 403)
            actual = buffer.value
            actual = "\\\\" + actual[8:] if actual.startswith("\\\\?\\UNC\\") else actual.removeprefix("\\\\?\\")
            if Path(actual) != path:
                raise DomainError("legacy_path", "Opened legacy file resolved to an unexpected path.", 403)
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            raw = handle.read(maximum + 1)
        after = os.fstat(descriptor)
        _path_guard(path, root)
        current = path.stat()
        def receipt(info):
            return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

        # Windows stat and fstat expose different ctime meanings. Compare ctime
        # within each observation method, while binding shared identity/mtime.
        if (len(raw) > maximum or receipt(before) != receipt(opened)
                or receipt(opened) != receipt(after) or receipt(after) != receipt(current)
                or opened.st_ctime_ns != after.st_ctime_ns or before.st_ctime_ns != current.st_ctime_ns):
            raise DomainError("legacy_file_changed", "Legacy file changed during its read; this image was not admitted.", 409)
        return raw
    finally:
        os.close(descriptor)


def classify_document(value):
    if isinstance(value, dict):
        if "event_descriptor" in value:
            return "descriptor", value["event_descriptor"]
        if "bands" in value and "params" in value:
            return "model", []
        if "startup configuration" in value or "sources" in value:
            return "source-configuration", []
        if "filters" in value or "openbexi_timeline" in value:
            return "filter-configuration", []
        for envelope in ("events", "sessions", "session"):
            if envelope in value:
                items = value[envelope]
                if not isinstance(items, list):
                    raise DomainError("legacy_envelope", "Legacy record envelopes require an array.")
                if envelope == "session" and any(isinstance(item, dict) and "<" in str(item.get("id", "")) for item in items):
                    return "format-template", []
                return "records", items
        if "start" in value:
            return "records", [value]
    if isinstance(value, list) and all(isinstance(item, dict) and "start" in item for item in value):
        return "records", value
    raise DomainError("legacy_format", "Unrecognized legacy envelope; the file was not treated as an empty dataset.")


class LegacyReader:
    def __init__(self, sources, *, allow_roots, limits=None, source_name="Read-only legacy JSON"):
        self.limits = limits or LegacyLimits()
        self.source_name = source_name
        self.sources = []
        roots = [Path(os.path.abspath(root)) for root in allow_roots]
        if not roots:
            raise DomainError("legacy_allowlist", "An explicit legacy root allowlist is required.", 403)
        for source in sources:
            if (not isinstance(source.id, str) or not SOURCE_ID.fullmatch(source.id)
                    or any(item.id == source.id for item in self.sources)):
                raise DomainError("legacy_source", "Legacy source IDs must be unique, bounded ASCII identifiers.")
            if source.namespace is not None and (not isinstance(source.namespace, str)
                                                 or not 1 <= len(source.namespace) <= 256):
                raise DomainError("legacy_namespace", "Configured namespaces require 1 to 256 characters.")
            if source.data_model not in (None, "yyyy", "yyyy/mm", "yyyy/mm/dd"):
                raise DomainError("legacy_data_model", "Unsupported legacy calendar partition model.")
            root = Path(os.path.abspath(source.root))
            if not any(root == allowed or root.is_relative_to(allowed) for allowed in roots):
                raise DomainError("legacy_allowlist", "Legacy source root is outside the operator allowlist.", 403)
            # Reject links anywhere in the root's absolute ancestry, not just its leaf.
            _path_guard(root, Path(root.anchor))
            if not root.is_dir():
                raise DomainError("legacy_root", "Configured legacy source root must be an existing directory.")
            if source.dialect not in ("strict", "legacy-json"):
                raise DomainError("legacy_dialect", "Unknown legacy dialect.")
            self.sources.append(LegacySource(source.id, root, source.namespace, source.timezone,
                                             source.dialect, dict(source.abbreviations), source.data_model))
        if not self.sources or len(self.sources) > 100:
            raise DomainError("legacy_source", "Between 1 and 100 explicitly configured sources are required.")
        self._cache = OrderedDict()
        self._cache_size = 0
        self._mutex = threading.Lock()
        self._last_signature = None
        self._known_files = set()
        self._revision = 0
        self._created_at = now_iso()
        self.generation = str(uuid.uuid4())

    def _remember(self, key, value):
        size = len(json_bytes(value))
        old = self._cache.pop(key, None)
        if old:
            self._cache_size -= old[0]
        if size > self.limits.cache_bytes:
            return
        while self._cache and self._cache_size + size > self.limits.cache_bytes:
            _, (removed, _) = self._cache.popitem(last=False)
            self._cache_size -= removed
        self._cache[key] = (size, value)
        self._cache_size += size

    def _files(self, source, check, counters, report):
        if source.data_model is not None:
            from .legacy_sources import is_partition_directory, is_partition_file
        pending = [source.root]
        while pending:
            check()
            directory = pending.pop()
            _path_guard(directory, source.root)
            counters["directories"] += 1
            if counters["directories"] > self.limits.max_directories:
                raise DomainError("legacy_scan_limit", "Legacy directory admission limit exceeded.", 413)
            directories, files = [], []
            with os.scandir(directory) as entries:
                for entry in entries:
                    check()
                    path = Path(entry.path)
                    info = entry.stat(follow_symlinks=False)
                    if _unsafe(info):
                        raise DomainError("legacy_path", "Legacy source contains a symlink or reparse point.", 403)
                    if stat.S_ISDIR(info.st_mode):
                        if entry.name.casefold() == "descriptors":
                            report["descriptorDirectories"] += 1
                        elif entry.name.casefold() != "noises" and (source.data_model is None
                                or is_partition_directory(path.relative_to(source.root), source.data_model)):
                            if counters["directories"] + len(pending) + len(directories) >= self.limits.max_directories:
                                raise DomainError("legacy_scan_limit", "Legacy directory admission limit exceeded.", 413)
                            directories.append(path)
                    elif entry.name.lower().endswith(".json"):
                        if source.data_model is not None and not is_partition_file(
                                path.relative_to(source.root), source.data_model):
                            continue
                        if not stat.S_ISREG(info.st_mode):
                            raise DomainError("legacy_path", "Legacy JSON authority must be an ordinary file.", 403)
                        counters["files"] += 1
                        if counters["files"] > self.limits.max_files:
                            raise DomainError("legacy_scan_limit", "Legacy file admission limit exceeded.", 413)
                        files.append(path)
            # Bound admission before sorting, then use a repeatable provenance
            # winner when the same legacy record appears in multiple partitions.
            pending.extend(sorted(directories, key=lambda path: (path.name.casefold(), path.name), reverse=True))
            yield from sorted(files, key=lambda path: (path.name.casefold(), path.name))

    def _convert(self, items, source, relative, timestamp, diagnostics, check=lambda: None):
        records, zones = [], []

        def date(value):
            return legacy_instant(value, default_timezone=source.timezone, abbreviations=source.abbreviations)

        def visit(item, pointer, parent=None, inherited_namespace=None, depth=0):
            if len(records) % 256 == 0:
                check()
            if not isinstance(item, dict) or depth > 8:
                raise DomainError("legacy_record", "Legacy records require objects with at most eight nested activity levels.")
            data = item.get("data", {})
            if not isinstance(data, dict):
                raise DomainError("legacy_record", "Legacy data must be an object.")
            namespace = item.get("namespace", data.get("namespace", inherited_namespace or source.namespace or source.id))
            if not isinstance(namespace, str) or not 1 <= len(namespace) <= 256:
                raise DomainError("legacy_namespace", "Legacy namespace must contain 1 to 256 characters.")
            legacy_id = item.get("id", item.get("ID"))
            if legacy_id is not None and (isinstance(legacy_id, bool) or not isinstance(legacy_id, (str, int))):
                raise DomainError("legacy_identity", "Legacy ID must be a string or integer.")
            identity = canonical_legacy_id(source.id, namespace, legacy_id, relative, pointer)
            start = date(item.get("start"))
            end = date(item["end"]) if item.get("end") not in (None, "") else None
            if end is not None and instant_ms(end) < instant_ms(start):
                raise DomainError("legacy_interval", "Legacy interval ends before it starts; dates were not swapped.")
            title = data.get("title") or item.get("title") or data.get("text") or item.get("text")
            if not isinstance(title, str) or not title.strip():
                raise DomainError("legacy_title", "Legacy title or text must contain readable text.")
            if len(title) > 500:
                raise DomainError("legacy_title", "Legacy label exceeds the supported 500-character limit; original retained in source.")
            authored = item.get("render") or {}
            if not isinstance(authored, dict):
                raise DomainError("legacy_render", "Legacy render overrides must be an object.")
            render = {}
            for name in ("color", "textColor", "backgroundColor"):
                if name in authored:
                    if isinstance(authored[name], str) and COLOR.fullmatch(authored[name]):
                        render[name] = authored[name]
                    else:
                        diagnostics.append({"code": "legacy_render_unmapped", "pointer": pointer, "field": name})
            if isinstance(authored.get("image"), str):
                icon = authored["image"].replace("\\", "/").split("/")[-1]
                render["icon"] = ICON_MAP.get(icon, "file-text")
                diagnostics.append({"code": "legacy_icon_preserved" if icon in HAZARD_ICONS else "legacy_icon_substitution", "pointer": pointer,
                                    "image": authored["image"], "icon": render["icon"]})
            if item.get("zone") not in (None, False, ""):
                if end is None or instant_ms(end) <= instant_ms(start):
                    raise DomainError("legacy_zone", "Legacy zones require a positive interval.")
                zones.append({"id": identity, "title": title[:200], "start": start, "end": end,
                              "color": render.get("color", "#DD9933"), "opacity": 0.2,
                              "legacy": {"sourceId": source.id, "namespace": namespace, "record": item}})
                return
            activities = item.get("activities", [])
            if not isinstance(activities, list):
                raise DomainError("legacy_record", "Legacy activities must be an array.")
            # A legacy empty-end record is a point. A parent with activities is
            # an explicit session enclosure; a zero-duration enclosure stays finite.
            kind = "session" if end is not None or activities or item.get("kind") == "session" else "event"
            if activities and end is None:
                end = start
            governed = {"namespace": namespace, "legacy": copy.deepcopy(data)}
            for name in ("description", "text", "system", "type", "status"):
                if isinstance(data.get(name), str):
                    governed[name] = data[name]
            if isinstance(data.get("priority"), (int, float)) and not isinstance(data["priority"], bool):
                governed["priority"] = data["priority"]
            elif isinstance(data.get("priority"), str) and re.fullmatch(r"-?\d+(?:\.\d+)?", data["priority"]):
                governed["priority"] = float(data["priority"])
            original_start = date(item["original_start"]) if item.get("original_start") not in (None, "") else None
            original_end = date(item["original_end"]) if item.get("original_end") not in (None, "") else None
            extra = {key: copy.deepcopy(value) for key, value in item.items() if key not in ("data", "activities")}
            records.append({"id": identity, "workspaceId": "default", "kind": kind, "title": title,
                            "start": start, "end": end, "parentSessionId": parent, "order": len(records),
                            "sourceId": source.id, "groupIds": [], "tags": [], "data": governed, "render": render,
                            "extensions": {"legacy": {"formatVersion": 1, "sourceId": source.id, "namespace": namespace,
                                                       "id": legacy_id, "file": relative, "pointer": pointer,
                                                       "original": extra, "readOnly": True}},
                            "schemaId": SCHEMA_ID, "schemaVersion": 1, "originalStart": original_start,
                            "originalEnd": original_end, "version": 1, "createdAt": timestamp,
                            "updatedAt": timestamp, "createdBy": "legacy-reader", "updatedBy": "legacy-reader",
                            "deletedAt": None})
            if len(records) > self.limits.max_records:
                raise DomainError("legacy_record_limit", "Legacy record admission limit exceeded.", 413)
            for index, child in enumerate(activities):
                visit(child, f"{pointer}/activities/{index}", identity, namespace, depth + 1)

        for index, item in enumerate(items):
            visit(item, f"/events/{index}")
        return records, zones

    def scan(self, *, time_range=None, cancel=None, include_inventory=True, progress=None, file_selection=None, cache_result=True, reuse_unchanged=False):
        """Capture all authority files; optional range limits retained records, not file membership.

        Sidecars are independently read by descriptor(), never bulk-traversed.
        Whole-file conversion failures retain a cached last-good image when present.
        """
        with self._mutex:
            return self._scan(time_range=time_range, cancel=cancel, include_inventory=include_inventory, progress=progress,
                              file_selection=file_selection, cache_result=cache_result, reuse_unchanged=reuse_unchanged)

    def _scan(self, *, time_range, cancel, include_inventory, progress=None, file_selection=None, cache_result=True, reuse_unchanged=False):
        started, timestamp = time.monotonic(), now_iso()
        last_progress = started - 1
        reading = True
        report = {"formatVersion": 1, "readOnly": True, "snapshotAt": timestamp, "status": "current",
                  "sources": [], "diagnostics": [], "diagnosticsOmitted": 0, "inventory": [],
                  "descriptorDirectories": 0, "descriptorPolicy": "on-demand-by-record-identity",
                  "rejectedFiles": 0, "staleFiles": 0, "missingFiles": 0, "duplicateRecords": 0,
                  "classificationCounts": {}, "configurationFiles": []}
        counters = {"files": 0, "directories": 0, "bytes": 0}
        records, zones, seen, receipts, all_ids = {}, {}, set(), [], set()
        selected_range = None if time_range is None else (instant_ms(time_range["from"]), instant_ms(time_range["to"]))
        if selected_range and selected_range[0] >= selected_range[1]:
            raise DomainError("legacy_range", "Legacy analysis range must be positive.")
        domain_min, domain_max = None, None

        def check():
            nonlocal last_progress
            from .preparation_control import checkpoint
            checkpoint()
            if cancel is not None and cancel.is_set():
                raise DomainError("legacy_cancelled", "Legacy scan was cancelled.", 409)
            if time.monotonic() - started >= self.limits.max_seconds:
                raise DomainError("legacy_scan_timeout", "Legacy scan exceeded its configured time budget.", 503)
            if reading and progress and time.monotonic() - last_progress >= .25:
                progress("reading-legacy", filesRead=len(receipts), recordsRead=len(records))
                last_progress = time.monotonic()

        def diagnostic(item):
            if len(report["diagnostics"]) < self.limits.max_diagnostics:
                report["diagnostics"].append(item)
            else:
                report["diagnosticsOmitted"] += 1

        for source in self.sources:
            source_report = {"id": source.id, "root": str(source.root), "namespace": source.namespace,
                             "timezone": source.timezone, "dialect": source.dialect,
                             "dataModel": source.data_model, "files": 0, "bytes": 0}
            report["sources"].append(source_report)
            paths = self._files(source, check, counters, report) if file_selection is None else file_selection.get(source.id, ())
            for path in paths:
                check()
                if file_selection is not None:
                    counters["files"] += 1
                    if counters["files"] > self.limits.max_files:
                        raise DomainError("legacy_scan_limit", "Legacy file admission limit exceeded.", 413)
                relative = path.relative_to(source.root).as_posix()
                key = (source.id, relative)
                seen.add(key)
                source_report["files"] += 1
                stale = False
                try:
                    _path_guard(path, source.root)
                    info = path.stat()
                    stamp = [info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]
                    cached = self._cache.get(key)
                    unchanged = reuse_unchanged and cached and cached[1].get("stamp") == stamp
                    raw = None if unchanged else safe_read(path, source.root, self.limits.max_file_bytes)
                    counters["bytes"] += len(raw) if raw is not None else 0
                    source_report["bytes"] += len(raw) if raw is not None else 0
                    if counters["bytes"] > self.limits.max_scan_bytes:
                        raise DomainError("legacy_scan_limit", "Legacy scan byte limit exceeded.", 413)
                    digest = cached[1]["sha256"] if unchanged else hashlib.sha256(raw).hexdigest()
                    if cached and cached[1]["sha256"] == digest:
                        image = cached[1]
                        self._cache.move_to_end(key)
                    else:
                        document, warnings = parse_legacy_json(raw, source.dialect)
                        classification, items = classify_document(document)
                        authored_at = iso_from_ms(path.stat().st_mtime_ns // 1000000)
                        converted, annotations = self._convert(items, source, relative, authored_at, warnings, check) if classification == "records" else ([], [])
                        image = {"sha256": digest, "bytes": len(raw), "classification": classification,
                                 "records": converted, "zones": annotations, "warnings": warnings, "readAt": timestamp, "stamp": stamp}
                        if cache_result:
                            self._remember(key, image)
                except (DomainError, OSError) as error:
                    if isinstance(error, DomainError) and error.code in (
                            "legacy_scan_limit", "legacy_path", "legacy_scan_timeout", "legacy_cancelled"):
                        raise
                    code = error.code if isinstance(error, DomainError) else "legacy_read_error"
                    diagnostic({"sourceId": source.id, "file": relative, "code": code,
                                "message": str(error)[:500]})
                    cached = self._cache.get(key)
                    if not cached:
                        report["rejectedFiles"] += 1
                        continue
                    image, stale = cached[1], True
                    report["staleFiles"] += 1
                classification = image["classification"]
                report["classificationCounts"][classification] = report["classificationCounts"].get(classification, 0) + 1
                receipt = {"sourceId": source.id, "file": relative, "sha256": image["sha256"], "bytes": image["bytes"],
                           "classification": classification, "records": len(image["records"]), "stale": stale}
                receipts.append((source.id, relative, image["sha256"]))
                if include_inventory:
                    report["inventory"].append(receipt)
                if classification not in ("records", "descriptor"):
                    report["configurationFiles"].append(receipt)
                for warning in image["warnings"]:
                    diagnostic({"sourceId": source.id, "file": relative, **warning})
                file_records = {record["id"]: record for record in image["records"]}
                required_parents = set()
                for index, record in enumerate(image["records"]):
                    if index % 256 == 0:
                        check()
                    all_ids.add(record["id"])
                    start, end = instant_ms(record["start"]), instant_ms(record["end"]) if record["end"] else None
                    if start == MAX_LEGACY_INSTANT:
                        raise DomainError("legacy_range_limit", "A record starting at the final supported millisecond has no representable exclusive range endpoint; the snapshot was not published.", 422)
                    domain_min = start if domain_min is None else min(domain_min, start)
                    domain_max = max(start + 1, end or start + 1) if domain_max is None else max(domain_max, start + 1, end or start + 1)
                    if selected_range:
                        low, high = selected_range
                        point = record["kind"] == "event" or end == start
                        if not (low <= start < high if point else start < high and (end is None or end > low)):
                            continue
                    identity = record["id"]
                    if identity in records:
                        previous = records[identity]
                        def comparable(value):
                            return {k: v for k, v in value.items()
                                    if k not in ("createdAt", "updatedAt", "extensions", "order")}
                        if comparable(previous) != comparable(record):
                            raise DomainError("legacy_duplicate_id", "Conflicting legacy records share a source, namespace and ID; snapshot was not published.", 409)
                        report["duplicateRecords"] += 1
                    else:
                        records[identity] = record
                    parent = record["parentSessionId"]
                    while parent is not None and parent not in required_parents:
                        required_parents.add(parent)
                        parent = file_records[parent]["parentSessionId"]
                    if len(records) > self.limits.max_records:
                        raise DomainError("legacy_record_limit", "Selected legacy records exceed the admission limit.", 413)
                for identity in required_parents:
                    records.setdefault(identity, file_records[identity])
                for zone in image["zones"]:
                    start, end = instant_ms(zone["start"]), instant_ms(zone["end"])
                    domain_min = start if domain_min is None else min(domain_min, start)
                    domain_max = end if domain_max is None else max(domain_max, end)
                    if selected_range and not (instant_ms(zone["start"]) < selected_range[1] and instant_ms(zone["end"]) > selected_range[0]):
                        continue
                    if zone["id"] in zones and zone != zones[zone["id"]]:
                        raise DomainError("legacy_duplicate_id", "Conflicting legacy zones share an identity.", 409)
                    zones[zone["id"]] = zone
        for key in (self._known_files - seen if file_selection is None else ()):
            report["missingFiles"] += 1
            diagnostic({"sourceId": key[0], "file": key[1], "code": "legacy_file_removed",
                        "message": "Removed files leave the next snapshot; existing pinned snapshots are unchanged."})
            removed = self._cache.pop(key, None)
            if removed:
                self._cache_size -= removed[0]
        if len(records) > self.limits.max_records:
            raise DomainError("legacy_record_limit", "Legacy records and their required ancestors exceed the admission limit.", 413)
        if len(zones) > 512:
            raise DomainError("legacy_zone_limit", "Selected legacy zones exceed the 512-zone snapshot limit.", 413)
        report.update(counters)
        report["recordCount"] = len(records)
        report["allRecordCount"] = len(all_ids)
        report["zoneCount"] = len(zones)
        report["domain"] = {"from": iso_from_ms(domain_min), "to": iso_from_ms(domain_max)} if domain_min is not None else None
        report["declaredRange"] = time_range
        report["status"] = "incomplete" if report["rejectedFiles"] else "stale" if report["staleFiles"] else "current"
        ordered = sorted(records.values(), key=lambda record: (record["start"], record["sourceId"], record["id"]))
        signature = hashlib.sha256(json_bytes([sorted(receipts), time_range])).hexdigest()
        revision = self._revision + int(signature != self._last_signature)
        bounds = time_range or report["domain"] or {"from": "2024-01-01T00:00:00.000Z", "to": "2024-01-02T00:00:00.000Z"}
        snapshot = {"format": "timeline-snapshot", "formatVersion": 1,
                    "manifest": {"bundleId": str(uuid.uuid5(LEGACY_ID_NAMESPACE, self.generation + signature)),
                                 "workspaceId": "default", "generation": self.generation, "revision": revision,
                                 "snapshotAt": timestamp, "sourceName": self.source_name, "sourceKind": "imported",
                                 "completeness": "complete-for-declared-universe", "recordCount": len(ordered),
                                 "scope": {"workspaceId": "default", "sourceIds": [source.id for source in self.sources]},
                                 "legacy": {"readOnly": True, "status": report["status"], "declaredRange": time_range,
                                            "domain": report["domain"], "rejectedFiles": report["rejectedFiles"],
                                            "allRecordCount": report["allRecordCount"],
                                            "staleFiles": report["staleFiles"], "missingFiles": report["missingFiles"],
                                            "descriptorPolicy": report["descriptorPolicy"]}},
                    "records": copy.deepcopy(ordered), "zones": copy.deepcopy(list(zones.values())),
                    "models": [{"id": "legacy-read-only", "name": "Legacy timeline", "theme": "light",
                                "rowHeight": 32, "fontSize": 12, "groupBy": "sourceId"}], "filters": [],
                    "settings": {"range": bounds, "overview": bounds, "referenceTime": bounds["from"],
                                 "modelId": "legacy-read-only", "scaleMode": "uniform", "ratio": 4, "bins": 64},
                    "sources": [_resource(source.id, source.namespace or source.id, {"storage": "json", "enabled": True,
                                "writable": False, "defaultSchema": {"id": SCHEMA_ID, "version": 1}}, self._created_at) for source in self.sources],
                    "schemas": [_resource(SCHEMA_ID, "Legacy metadata", {"schema": {"$schema": "https://json-schema.org/draft/2020-12/schema",
                                "type": "object", "properties": {"namespace": {"type": "string"},
                                "legacy": {"type": "object", "additionalProperties": True}}, "additionalProperties": False}}, self._created_at)]}
        check()
        reading = False
        if progress:
            progress("validating-records", filesRead=len(receipts), recordsRead=len(ordered))
        validate_snapshot(snapshot)
        check()
        report["durationMs"] = round((time.monotonic() - started) * 1000)
        self._revision, self._last_signature = revision, signature
        if file_selection is None:
            self._known_files = seen
        return LegacyScan(snapshot, report)

    def descriptor(self, record):
        legacy = record.get("extensions", {}).get("legacy", {})
        source = next((source for source in self.sources if source.id == record["sourceId"]), None)
        if source is None or legacy.get("id") in (None, ""):
            return {"status": "unavailable", "reason": "No linked legacy identity."}
        identity = str(legacy["id"])
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identity):
            raise DomainError("legacy_descriptor_id", "Descriptor filename must be a bounded safe identifier.")
        # Legacy event_descriptor resolves the start date, source namespace and
        # ID to yyyy/mm/dd/descriptors/id.json. Also try the event file's day.
        start = legacy_instant(record["start"])
        day = start[:10].split("-")
        relative = Path(legacy.get("file", ""))
        candidates = [source.root.joinpath(*day, "descriptors", identity + ".json"),
                      source.root / relative.parent / "descriptors" / (identity + ".json")]
        for path in dict.fromkeys(candidates):
            try:
                raw = safe_read(path, source.root, self.limits.max_file_bytes)
            except FileNotFoundError:
                continue
            value, diagnostics = parse_legacy_json(raw, source.dialect)
            classification, items = classify_document(value)
            if classification != "descriptor" or not isinstance(items, list):
                raise DomainError("legacy_descriptor", "Sidecar is not a descriptor envelope.")
            matches = []
            for item in items:
                if not isinstance(item, dict) or str(item.get("id", item.get("ID"))) != identity:
                    continue
                data = item.get("data", {})
                if not isinstance(data, dict):
                    raise DomainError("legacy_descriptor", "Descriptor data must be an object.")
                if item.get("namespace", data.get("namespace", legacy.get("namespace"))) == legacy.get("namespace"):
                    matches.append(item)
            if len(matches) != 1:
                raise DomainError("legacy_descriptor", "Descriptor does not uniquely match the source namespace and ID.")
            return {"status": "current", "readOnly": True, "sha256": hashlib.sha256(raw).hexdigest(),
                    "file": path.relative_to(source.root).as_posix(), "descriptor": matches[0], "diagnostics": diagnostics}
        return {"status": "missing", "readOnly": True, "reason": "No matching descriptor sidecar."}
