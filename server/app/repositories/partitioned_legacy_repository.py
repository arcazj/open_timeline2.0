"""Window-first legacy reads backed by a disposable JSON file-interval index."""

from __future__ import annotations

import copy
import hashlib
import logging
import os
import threading
import time
from pathlib import Path

from ..models.domain import DomainError, content_checksum, instant_ms, iso_from_ms, json_bytes, now_iso, parse_json
from ..models.model_catalog import normalize_metadata
from ..services.legacy_reader import _path_guard, safe_read
from ..services.legacy_presentation import apply_legacy_presentation
from ..services.legacy_sources import is_partition_directory, partition_date, partition_interval, partition_paths
from ..services.preparation_control import checkpoint
from ..services.query_access import current_query_access
from .json_repository import atomic_json
from .legacy_repository import LegacyRepository


class PartitionedLegacyRepository(LegacyRepository):
    lazy = True
    deferred_capture = True

    def __init__(self, options, state_root):
        super().__init__(options, state_root)
        self.loading = {"bufferRatio": .25, "cacheMiB": 64, "indexRefreshSeconds": 30,
                        **options.get("loading", {})}
        self.reader.source_name = options.get("name") or " + ".join(source.namespace or source.id for source in self.reader.sources)
        from dataclasses import replace
        self.reader.limits = replace(self.reader.limits, cache_bytes=self.loading["cacheMiB"] * 1024 * 1024)
        self._entries, self._errors = {}, {}
        self._record_counts = {}
        self._index_lock, self._foreground_lock = threading.RLock(), threading.Lock()
        self._stop, self._wake = threading.Event(), threading.Event()
        self._thread = None
        self._foreground = 0
        self._complete = False
        self._checked_at = None
        self._index_version = 0
        self._index_state = "pending"
        self._first_query = threading.Event()
        self._prefetch_gate = threading.Lock()
        self._metrics = {"windowReads": 0, "bytesRead": 0, "indexFilesRead": 0,
                         "indexFilesReused": 0, "prefetches": 0, "lastWindowMs": 0}
        self._index_path = self.root / "legacy-file-index.json"
        self._signature = hashlib.sha256(json_bytes([
            [s.id, str(s.root), s.data_model, s.timezone, s.dialect] for s in self.reader.sources
        ])).hexdigest()

    def _latest_range(self):
        if self.loading.get("initialRange"):
            return copy.deepcopy(self.loading["initialRange"])
        candidates = []
        for source in self.reader.sources:
            current = source.root
            for _ in source.data_model.split("/"):
                _path_guard(current, source.root)
                with os.scandir(current) as children:
                    names = sorted((entry.name for entry in children
                                    if entry.is_dir(follow_symlinks=False)
                                    and is_partition_directory(Path(entry.path).relative_to(source.root), source.data_model)), reverse=True)
                if not names:
                    break
                current /= names[0]
            day = partition_date(current.relative_to(source.root), source.data_model)
            if day:
                try:
                    low, high = partition_interval(day, data_model=source.data_model, timezone=source.timezone or "UTC")
                    candidates.append({"from": low.isoformat().replace("+00:00", "Z"), "to": high.isoformat().replace("+00:00", "Z")})
                except DomainError:
                    pass
        if candidates:
            return max(candidates, key=lambda item: instant_ms(item["to"]))
        now = instant_ms(now_iso())
        return {"from": iso_from_ms(now - 1800000), "to": iso_from_ms(now + 1800000)}

    def open(self, *, cancel=None, progress=None):
        # An empty metadata image uses the exact same schemas/models as exports.
        empty = self.reader.scan(file_selection={}).snapshot
        if self.presentation:
            empty = apply_legacy_presentation(empty, self.presentation)
        self.meta = normalize_metadata({key: value for key, value in empty.items() if key != "records"})
        bounds = self._latest_range()
        self.meta["settings"].update(range=bounds, overview=bounds, referenceTime=bounds["from"])
        self.meta["manifest"]["legacy"].update(configuration=self.configuration.metadata(), domain=bounds,
            queryScope="overlapping-query-domain", lazy=True, loading=copy.deepcopy(self.loading))
        self._load_index()
        self.available = True
        self.report = {"diagnostics": [], "inventory": []}
        self._thread = threading.Thread(target=self._index_loop, name="timeline-file-index", daemon=True)
        self._thread.start()

    def _load_index(self):
        try:
            value = parse_json(safe_read(self._index_path, self.root, 64 * 1024 * 1024))
            checksum = value.pop("sha256", None)
            if (value.get("version") != 2 or value.get("configuration") != self._signature
                    or checksum != hashlib.sha256(json_bytes(value)).hexdigest()):
                return
            entries = value["entries"]
            if not isinstance(entries, list) or len(entries) > self.reader.limits.max_files:
                return
            sources = {source.id: source for source in self.reader.sources}
            validated = {}
            for entry in entries:
                source = sources[entry["sourceId"]]
                relative = Path(entry["file"])
                from ..services.legacy_sources import is_partition_file
                if (relative.is_absolute() or not is_partition_file(relative, source.data_model)
                        or len(entry["stamp"]) != 4 or not all(isinstance(item, str) and item.isdecimal() and len(item) <= 64 for item in entry["stamp"])
                        or type(entry["count"]) is not int or not 0 <= entry["count"] <= self.reader.limits.max_records
                        or not isinstance(entry["ids"], list) or len(entry["ids"]) != entry["count"]
                        or any(not isinstance(identity, str) or len(identity) > 128 for identity in entry["ids"])
                        or not isinstance(entry.get("signatures"), dict)
                        or any(not isinstance(key, str) or not isinstance(digest, str) or len(digest) != 64
                               for key, digest in entry["signatures"].items())
                        or (entry["from"] is not None and instant_ms(entry["from"]) >= instant_ms(entry["to"]))):
                    return
                validated[(source.id, relative.as_posix())] = entry
            self._entries = validated
            self._checked_at = value.get("checkedAt")
            self._index_state = "verifying"
        except (OSError, DomainError, KeyError, TypeError, ValueError):
            # A disposable index is never an authority and never blocks startup.
            self._entries = {}

    def _persist_index(self):
        with self._index_lock:
            value = {"version": 2, "configuration": self._signature, "checkedAt": self._checked_at,
                     "entries": list(self._entries.values())}
        raw = json_bytes(value)
        if len(raw) > 64 * 1024 * 1024:
            raise DomainError("legacy_index_limit", "File interval index exceeds its 64 MiB budget.", 413)
        value["sha256"] = hashlib.sha256(raw).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        _path_guard(self.root, Path(self.root.anchor))
        if self._index_path.exists():
            _path_guard(self._index_path, self.root)
        atomic_json(self._index_path, value)

    @staticmethod
    def _stamp(path, source):
        _path_guard(path, source.root)
        info = path.stat()
        return [str(value) for value in (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)]

    def _leaf_files(self, source, domain):
        from dataclasses import replace
        counters, report = {"files": 0, "directories": 0}, {"descriptorDirectories": 0}
        for directory in partition_paths(source.root, domain["from"], domain["to"],
                                         data_model=source.data_model, timezone=source.timezone or "UTC"):
            for path in self.reader._files(replace(source, root=directory, data_model=None), checkpoint, counters, report):
                from ..services.legacy_sources import is_partition_file
                if is_partition_file(path.relative_to(source.root), source.data_model):
                    yield path

    def coverage(self, source_ids=None):
        allowed = set(source_ids) if source_ids is not None else {s.id for s in self.reader.sources}
        with self._index_lock:
            entries = [entry for entry in self._entries.values() if entry["sourceId"] in allowed]
            errors = [error for (source_id, _), error in self._errors.items() if source_id in allowed]
            count = sum(self._record_counts.get(source, 0) for source in allowed)
            indexed_count = sum(entry["count"] for entry in entries)
            complete = not allowed or (self._complete and not errors)
            return {"complete": complete, "state": self._index_state,
                    "indexVersion": self._index_version, "checkedAt": self._checked_at,
                    "indexedFiles": len(entries), "indexedRecords": indexed_count, "rejectedFiles": len(errors),
                    "recordCount": count if complete else None}

    def loading_status(self, source_ids=None):
        with self._index_lock:
            if source_ids is not None and set(source_ids) != {source.id for source in self.reader.sources}:
                return self.coverage(source_ids)
            return {**self.coverage(source_ids), "metrics": {**self._metrics,
                    "cacheBytes": self.reader._cache_size, "cacheLimitBytes": self.reader.limits.cache_bytes}}

    def _index_file(self, source, path):
        key = (source.id, path.relative_to(source.root).as_posix())
        stamp = self._stamp(path, source)
        with self._index_lock:
            prior = self._entries.get(key)
            if prior and prior["stamp"] == stamp:
                self._metrics["indexFilesReused"] += 1
                return
        result = self.reader.scan(file_selection={source.id: [path]}, cache_result=False, reuse_unchanged=True, cancel=self._stop)
        if result.report["status"] != "current":
            raise DomainError("legacy_index_file", "A legacy file could not be verified.", 409)
        if self._stamp(path, source) != stamp:
            raise DomainError("legacy_file_changed", "A legacy file changed while it was indexed.", 409)
        records = result.snapshot["records"]
        bounds = result.report["domain"]
        # Ongoing sessions must be discoverable from every subsequent partition.
        if bounds and any(record["kind"] == "session" and record["end"] is None for record in records):
            bounds["to"] = "9999-12-31T23:59:59.999Z"
        entry = {"sourceId": source.id, "file": key[1], "stamp": stamp, "count": len(records),
                 "ids": [record["id"] for record in records],
                 "from": bounds["from"] if bounds else None, "to": bounds["to"] if bounds else None}
        entry["signatures"] = {record["id"]: hashlib.sha256(json_bytes({
            key: value for key, value in record.items() if key not in ("createdAt", "updatedAt", "extensions", "order")
        })).hexdigest() for record in records}
        entry["signatures"].update({zone["id"]: hashlib.sha256(json_bytes(zone)).hexdigest() for zone in result.snapshot["zones"]})
        with self._index_lock:
            self._entries[key] = entry
            self._errors.pop(key, None)
            self._metrics["indexFilesRead"] += 1
            self._metrics["bytesRead"] += result.report["bytes"]

    def _index_loop(self):
        # Give the first visible query priority; an unattended server still indexes.
        self._first_query.wait(1)
        while not self._stop.is_set():
            try:
                self._reconcile()
            except Exception:
                with self._index_lock:
                    self._complete = False
                    self._index_state = "failed"
                if not self._stop.is_set():
                    logging.getLogger("uvicorn.error").exception("Legacy interval indexing failed; window reads remain available.")
            self._wake.wait(self.loading["indexRefreshSeconds"])
            self._wake.clear()

    def _reconcile(self):
        started = time.monotonic()
        seen = set()
        counters, report = {"files": 0, "directories": 0}, {"descriptorDirectories": 0}
        with self._index_lock:
            self._index_state = "verifying" if self._entries else "indexing"

        def check():
            if self._stop.is_set():
                raise DomainError("legacy_cancelled", "Indexing stopped.", 409)
            if time.monotonic() - started > self.reader.limits.max_seconds:
                raise DomainError("legacy_scan_timeout", "Indexing exceeded its time budget.", 503)
            while self._foreground and not self._stop.wait(.01):
                pass

        for source in self.reader.sources:
            for path in self.reader._files(source, check, counters, report):
                check()
                key = (source.id, path.relative_to(source.root).as_posix())
                seen.add(key)
                try:
                    self._index_file(source, path)
                except (DomainError, OSError) as error:
                    if self._stop.is_set():
                        return
                    with self._index_lock:
                        self._entries.pop(key, None)
                        self._errors[key] = str(error)[:256]
                self._stop.wait(.002)
        with self._index_lock:
            self._entries = {key: entry for key, entry in self._entries.items() if key in seen}
            self._errors = {key: error for key, error in self._errors.items() if key in seen and key not in self._entries}
            signatures, records_by_source = {}, {}
            for key, entry in self._entries.items():
                records_by_source.setdefault(key[0], set()).update(entry["ids"])
                for identity, digest in entry["signatures"].items():
                    if identity in signatures and signatures[identity] != digest:
                        self._errors[key] = "Conflicting legacy identities in different files."
                    signatures[identity] = digest
            self._record_counts = {source: len(ids) for source, ids in records_by_source.items()}
            if sum(self._record_counts.values()) > self.reader.limits.max_records:
                raise DomainError("legacy_index_limit", "Archive interval index exceeds the record admission limit.", 413)
            self._complete = not self._errors
            self._checked_at = now_iso()
            self._index_version += 1
            self._index_state = "ready" if self._complete else "incomplete"
        with self.mutex:
            self.meta["manifest"]["revision"] = self._index_version + 1
        self._persist_index()

    def reload(self, **kwargs):
        with self._index_lock:
            self._complete = False
            self._index_state = "verifying"
        self._wake.set()
        return self.metadata()

    def close(self):
        self._stop.set()
        self._wake.set()
        self._first_query.set()
        if self._thread:
            self._thread.join()
        super().close()

    def metadata(self):
        result = super().metadata()
        status = self.coverage()
        result.update(recordCount=status["recordCount"], completeness="windowed-server-data")
        result["legacy"].update(coverage=status)
        return result

    def project_scope(self, value, source_ids):
        settings = copy.deepcopy(value.get("settings"))
        value = super().project_scope(value, source_ids)
        status = self.coverage(source_ids)
        if settings is not None:
            value["settings"] = settings
        if "recordCount" in value:
            value["recordCount"] = status["recordCount"]
        if "sources" in value and "records" not in value:
            value["sources"] = list(source_ids)
        if "legacy" in value:
            value["legacy"].update(coverage=status, allRecordCount=status["recordCount"])
        return value

    def capture_query_domain(self, request):
        domain = request.get("domain")
        if not isinstance(domain, dict):
            raise DomainError("invalid_query", "Query requires a finite domain.")
        low, high = instant_ms(domain.get("from")), instant_ms(domain.get("to"))
        if low >= high:
            raise DomainError("invalid_query", "Query domain end must follow its start.")
        access = current_query_access()
        allowed = set(access["sourceIds"]) if access else {source.id for source in self.reader.sources}
        filters = request.get("filters", {})
        if (not isinstance(filters, dict) or not isinstance(filters.get("sourceId", "all"), str)
                or (filters.get("sourceIds") is not None and (not isinstance(filters["sourceIds"], list)
                    or any(not isinstance(value, str) for value in filters["sourceIds"])))):
            raise DomainError("invalid_filter", "Source filters require string identifiers.")
        if isinstance(filters, dict):
            if isinstance(filters.get("sourceIds"), list):
                allowed.intersection_update(filters["sourceIds"])
            if filters.get("sourceId", "all") != "all":
                allowed.intersection_update([filters["sourceId"]])
        started = time.monotonic()
        with self._foreground_lock:
            self._foreground += 1
            try:
                selected = {}
                with self._index_lock:
                    entries = list(self._entries.values())
                    coverage = self.coverage(allowed)
                for source in self.reader.sources:
                    if source.id not in allowed:
                        continue
                    paths = set(self._leaf_files(source, domain))
                    for entry in entries:
                        if (entry["sourceId"] == source.id and entry["from"] is not None
                                and instant_ms(entry["from"]) < high and instant_ms(entry["to"]) > low):
                            path = source.root / entry["file"]
                            if path.exists():
                                paths.add(path)
                    selected[source.id] = sorted(paths, key=lambda path: path.as_posix())
                checkpoint()
                result = self.reader.scan(time_range=domain, file_selection=selected, reuse_unchanged=True, cancel=self._stop)
                if result.report["status"] != "current":
                    raise DomainError("legacy_window_unavailable", "One or more visible legacy files cannot be read. The previous view is retained.", 409)
                bundle = normalize_metadata(self.meta)
                bundle["records"], bundle["zones"] = result.snapshot["records"], result.snapshot["zones"]
                bundle["manifest"].update(recordCount=len(bundle["records"]), revision=coverage["indexVersion"] + 1)
                bundle["manifest"]["legacy"].update(coverage=coverage, declaredRange=copy.deepcopy(domain))
                with self._index_lock:
                    self._metrics["windowReads"] += 1
                    self._metrics["bytesRead"] += result.report["bytes"]
                    self._metrics["lastWindowMs"] = round((time.monotonic() - started) * 1000, 2)
                return bundle
            finally:
                self._foreground -= 1
                self._first_query.set()

    def prefetch(self, request):
        if not self._prefetch_gate.acquire(blocking=False):
            return {"status": "busy"}
        try:
            if self._foreground:
                return {"status": "busy"}
            from ..services.preparation_control import preparation_control
            with preparation_control(self._stop, time.monotonic() + 5):
                self.capture_query_domain(request)
            with self._index_lock:
                self._metrics["prefetches"] += 1
            return {"status": "cached"}
        finally:
            self._prefetch_gate.release()

    def get_record(self, record_id, include_deleted=False):
        with self._index_lock:
            candidates = [entry for entry in self._entries.values() if record_id in entry["ids"]]
        # Records in a first cold-start page may precede their index entry.
        with self.reader._mutex:
            for _, image in self.reader._cache.values():
                for record in image["records"]:
                    if record["id"] == record_id:
                        return copy.deepcopy(record)
        sources = {source.id: source for source in self.reader.sources}
        for entry in candidates:
            source = sources[entry["sourceId"]]
            result = self.reader.scan(file_selection={source.id: [source.root / entry["file"]]}, reuse_unchanged=True)
            for record in result.snapshot["records"]:
                if record["id"] == record_id:
                    return record
        raise DomainError("record_not_found", "Record does not exist in the indexed source.", 404)

    def query_snapshot(self):
        # Full materialization remains explicit: exports never use a page cache.
        result = self.reader.scan(cancel=self._stop)
        if result.report["status"] != "current":
            raise DomainError("legacy_incomplete", "A complete export could not be verified.", 409)
        snapshot = result.snapshot
        if self.presentation:
            snapshot = apply_legacy_presentation(snapshot, self.presentation)
        return snapshot

    def snapshot(self):
        value = self.query_snapshot()
        value["manifest"]["contentSha256"] = content_checksum(value)
        return value
