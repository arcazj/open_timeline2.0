"""Read-only canonical JSON file source, using the existing query/index contract."""

import copy
import math
import threading
from pathlib import Path
from types import SimpleNamespace

from .legacy_repository import LegacyRepository
from ..models.domain import DomainError, instant_ms, parse_json, validate_snapshot, content_checksum
from ..models.model_catalog import normalize_metadata
from ..services.legacy_reader import safe_read
from ..services.legacy_sources import _guard_path


class SnapshotFileRepository(LegacyRepository):
    def __init__(self, options, state_root):
        self.mutex, self._reload_lock = threading.RLock(), threading.Lock()
        self.root = Path(state_root).resolve()
        self.file = _guard_path(Path(options["snapshotFile"]).absolute())
        if self.root == self.file.parent or self.root.is_relative_to(self.file.parent) or self.file.parent.is_relative_to(self.root):
            raise DomainError("legacy_state_path", "Snapshot source and server state must be disjoint.", 403)
        self.available = False
        self.records, self.meta, self.report = {}, {}, {}
        self._index, self._starts, self._max_ends = [], [], []
        self.layout, self.audit_state, self.audit_entries = None, None, {}
        self.configuration = SimpleNamespace(sources=())
        self.reader = None
        self._checksum = None

    def reload(self, *, cancel=None, progress=None):
        if not self._reload_lock.acquire(blocking=False):
            raise DomainError("legacy_scan_busy", "A JSON reload is already running.", 429)
        try:
            snapshot = parse_json(safe_read(self.file, self.file.parent, 32 * 1024 * 1024))
            validate_snapshot(snapshot)
            if cancel is not None and cancel.is_set():
                raise DomainError("startup_cancelled", "Server startup was cancelled.", 503)
            checksum = content_checksum(snapshot)
            records = {record["id"]: record for record in snapshot["records"]}
            meta = normalize_metadata({key: value for key, value in snapshot.items() if key != "records"})
            meta["manifest"].pop("contentSha256", None)
            meta["manifest"]["legacy"] = {**meta["manifest"].get("legacy", {}), "readOnly": True,
                "status": "current", "allRecordCount": len(records), "sourceFormat": "timeline-snapshot",
                "queryScope": "overlapping-query-domain", "declaredRange": True}
            index = []
            for record in records.values():
                start = instant_ms(record["start"])
                end = instant_ms(record["end"]) if record["end"] else math.inf
                index.append((start, start + 1 if record["kind"] == "event" or end == start else end, record["id"]))
            index.sort()
            maximum, max_ends = -math.inf, []
            for _, end, _ in index:
                maximum = max(maximum, end)
                max_ends.append(maximum)
            with self.mutex:
                if self._checksum and meta["manifest"]["generation"] == self.meta["manifest"]["generation"]:
                    meta["manifest"]["revision"] = max(meta["manifest"]["revision"], self.meta["manifest"]["revision"] + int(self._checksum != checksum))
                self._checksum = checksum
                self.records, self.meta = records, meta
                self._index, self._starts, self._max_ends = index, [entry[0] for entry in index], max_ends
                self.configuration = SimpleNamespace(sources=tuple(SimpleNamespace(id=source, namespace=source, root=self.file, data_model=None)
                    for source in meta["manifest"]["scope"]["sourceIds"]))
                self.report = {"status": "complete", "diagnostics": [], "inventory": [], "recordCount": len(records)}
                self.available = True
            if progress:
                progress("indexing-timeline", recordsRead=len(records))
            return self.metadata()
        finally:
            self._reload_lock.release()

    def project_scope(self, value, source_ids):
        settings = copy.deepcopy(value.get("settings"))
        result = super().project_scope(value, source_ids)
        if settings is not None:
            result["settings"] = settings
        return result

    def metadata(self):
        result = super().metadata()
        if self.meta["manifest"].get("testDataset"):
            result["testDataset"] = copy.deepcopy(self.meta["manifest"]["testDataset"])
        return result
