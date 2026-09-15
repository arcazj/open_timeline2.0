"""An in-memory, read-only view of operator-configured legacy JSON authorities."""

from __future__ import annotations

import copy
import threading
import bisect
import math
import os
from pathlib import Path

from ..models.domain import DomainError, instant_ms, iso_from_ms, MIN_INSTANT_MS
from ..models.model_catalog import normalize_metadata
from ..services.legacy_reader import LegacyLimits, LegacyReader, safe_read
from ..services.legacy_json import parse_legacy_json
from ..services.legacy_presentation import adapt_legacy_presentation, apply_legacy_presentation
from ..services.legacy_sources import load_legacy_sources
from .json_repository import JsonRepository




class LegacyRepository:
    read_only = True

    def __init__(self, options, state_root):
        self.mutex = threading.RLock()
        self._reload_lock = threading.Lock()
        self.available = False
        self.meta, self.records, self.report = {}, {}, {}
        self._index, self._starts, self._max_ends = [], [], []
        self.layout, self.audit_state, self.audit_entries = None, None, {}
        self.root = Path(state_root).resolve()
        self.configuration = load_legacy_sources(
            options["yaml"], legacy_root=options["legacyRoot"], allow_roots=options["allowRoots"],
            path_maps=options.get("pathMaps"), timezone=options.get("timezone", "UTC"),
            dialect=options.get("dialect", "strict"), document=options.get("sourceDocument"))
        if any(item["severity"] == "error" for item in self.configuration.diagnostics):
            raise DomainError("legacy_configuration_incomplete", "Enabled legacy source configuration is unsupported or unavailable. Inspect the YAML conversion report before serving.", 409)
        # Identity and application state may be written, but never inside an authority tree.
        protected = [Path(options["legacyRoot"]).resolve(), *[Path(p).resolve() for p in options["allowRoots"]]]
        if any(self.root == p or self.root.is_relative_to(p) or p.is_relative_to(self.root) for p in protected):
            raise DomainError("legacy_state_path", "Server state and legacy authority roots must be disjoint.", 403)
        self.reader = LegacyReader(self.configuration.sources, allow_roots=options["allowRoots"],
                                   source_name=options.get("name", "Read-only legacy JSON"),
                                   limits=LegacyLimits(max_seconds=options.get("maxSeconds", 300)))
        self.presentation = None
        if options.get("model"):
            # Keep the configured path spelling; safe_read checks aliases and reparse points.
            legacy_root = Path(os.path.abspath(options["legacyRoot"]))
            model_path = Path(options["model"])
            if not model_path.is_absolute():
                model_path = legacy_root / model_path
            raw = safe_read(model_path, legacy_root, 1024 * 1024)
            model, _ = parse_legacy_json(raw, "strict")
            self.presentation = adapt_legacy_presentation(
                model, source_bindings=self.configuration.render_sources,
                namespace_grouping=options.get("namespaceGrouping"))

    def open(self, *, cancel=None, progress=None):
        self.reload(cancel=cancel, progress=progress)

    def reload(self, *, cancel=None, progress=None):
        if not self._reload_lock.acquire(blocking=False):
            raise DomainError("legacy_scan_busy", "A legacy source scan is already running.", 429)
        try:
            result = self.reader.scan(cancel=cancel, progress=progress)
            if result.report["status"] == "incomplete":
                raise DomainError("legacy_incomplete", "Legacy files were rejected. Run import-legacy.py with --report to inspect diagnostics; the previous snapshot was not replaced.", 409)
            snapshot = result.snapshot
            if progress:
                progress("indexing-timeline", recordsRead=len(snapshot["records"]))
            if self.presentation:
                # Reader.scan already validated the complete record graph. Model
                # adaptation changes metadata only; avoid revalidating the archive.
                records = snapshot["records"]
                metadata = {key: copy.deepcopy(value) for key, value in snapshot.items() if key != "records"}
                metadata["records"] = []
                metadata["manifest"]["recordCount"] = 0
                snapshot = apply_legacy_presentation(metadata, self.presentation)
                snapshot["records"] = records
                snapshot["manifest"]["recordCount"] = len(records)
            records = {record["id"]: record for record in snapshot["records"]}
            meta = normalize_metadata({key: value for key, value in snapshot.items() if key != "records"})
            meta["manifest"]["legacy"]["configuration"] = self.configuration.metadata()
            meta["manifest"]["legacy"]["queryScope"] = "overlapping-query-domain"
            if result.report["domain"]:
                end = instant_ms(result.report["domain"]["to"])
                meta["settings"]["range"] = {"from": iso_from_ms(max(MIN_INSTANT_MS, end - 3600000)), "to": iso_from_ms(end)}
                meta["settings"]["overview"] = {"from": iso_from_ms(max(MIN_INSTANT_MS, end - 86400000)), "to": iso_from_ms(end)}
            index = []
            for position, record in enumerate(records.values()):
                if position % 256 == 0 and cancel is not None and cancel.is_set():
                    raise DomainError("startup_cancelled", "Server startup was cancelled.", 503)
                start = instant_ms(record["start"])
                end = instant_ms(record["end"]) if record["end"] else math.inf
                point = record["kind"] == "event" or end == start
                index.append((start, start + 1 if point else end, record["id"]))
            index.sort()
            maximum, max_ends = -math.inf, []
            for _, end, _ in index:
                maximum = max(maximum, end)
                max_ends.append(maximum)
            with self.mutex:
                self.records, self.meta, self.report = records, meta, result.report
                self._index, self._starts, self._max_ends = index, [item[0] for item in index], max_ends
                self.available = True
            return self.metadata()
        finally:
            self._reload_lock.release()

    def close(self):
        with self.mutex:
            self.available = False

    def _ensure_available(self):
        if not self.available:
            raise DomainError("legacy_unavailable", "Legacy source scan has not completed.", 503)

    def metadata(self):
        result = JsonRepository.metadata(self)
        result.update(legacy=copy.deepcopy(self.meta["manifest"]["legacy"]), durability="read-only-files")
        result["capabilities"].update(write=False, recordCrud=False, modelManagement=False,
                                      modelPublication=False, configurationManagement=False, importExport=False,
                                      changeFeed=False, legacyReload=True)
        return result

    query_snapshot = JsonRepository.query_snapshot
    capture_query_snapshot = JsonRepository.capture_query_snapshot
    snapshot = JsonRepository.snapshot
    list_models = JsonRepository.list_models
    get_model = JsonRepository.get_model

    def project_scope(self, value, source_ids):
        """Project owned metadata/capture containers without altering record images."""
        allowed = set(source_ids)
        if allowed.issuperset(self.meta["manifest"]["scope"]["sourceIds"]):
            return value
        visible = [record for record in self.records.values()
                   if record["sourceId"] in allowed and record["deletedAt"] is None]
        zones = [zone for zone in self.meta.get("zones", [])
                 if zone.get("legacy", {}).get("sourceId") in allowed]
        starts, ends = [], []
        for record in visible:
            start = instant_ms(record["start"])
            end = instant_ms(record["end"]) if record["end"] else start + 1
            starts.append(start)
            ends.append(max(start + 1, end))
        for zone in zones:
            starts.append(instant_ms(zone["start"]))
            ends.append(instant_ms(zone["end"]))
        domain = {"from": iso_from_ms(min(starts)), "to": iso_from_ms(max(ends))} if starts else None
        diagnostics = [item for item in self.report.get("diagnostics", []) if item.get("sourceId") in allowed]
        stale = sum(item["stale"] for item in self.report.get("inventory", []) if item["sourceId"] in allowed)

        def presentation(node):
            if isinstance(node, dict):
                for key, child in node.items():
                    if key == "sourceStyles" and isinstance(child, list):
                        node[key] = [style for style in child if style.get("sourceId") in allowed]
                    else:
                        presentation(child)
            elif isinstance(node, list):
                for child in node:
                    presentation(child)

        def legacy(node):
            node.update(scopeRestricted=True, allRecordCount=len(visible), domain=copy.deepcopy(domain),
                        staleFiles=stale, rejectedFiles=0,
                        missingFiles=sum(item.get("code") == "legacy_file_removed" for item in diagnostics),
                        status="stale" if stale else "current")
            node.pop("presentationDiagnostics", None)
            configuration = node.get("configuration")
            if configuration:
                configuration["sources"] = [source for source in configuration["sources"]
                                            if source.get("sourceId", source.get("id")) in allowed]
                configuration["diagnostics"] = []

        for name in ("settings", "models", "model", "defaults", "preferences", "views", "values", "layers"):
            if name in value:
                presentation(value[name])
        if "items" in value:
            presentation(value["items"])
        if "resource" in value:
            presentation(value["resource"])
        if "legacy" in value:
            legacy(value["legacy"])
        manifest = value.get("manifest")
        if manifest:
            manifest["scope"]["sourceIds"] = sorted(allowed)
            if "legacy" in manifest:
                legacy(manifest["legacy"])
            manifest.pop("contentSha256", None)
        if "records" in value:
            value["records"] = [record for record in value["records"] if record["sourceId"] in allowed]
            if manifest:
                manifest["recordCount"] = len(value["records"])
        if "zones" in value:
            value["zones"] = [zone for zone in value["zones"] if zone.get("legacy", {}).get("sourceId") in allowed]
        if "sources" in value:
            value["sources"] = [source for source in value["sources"]
                                if (source if isinstance(source, str) else source["id"]) in allowed]
        if "sourceIds" in value:
            value["sourceIds"] = sorted(allowed)
        if "recordCount" in value:
            value["recordCount"] = len(visible)
        if "settings" in value:
            fallback = {"from": "2024-01-01T00:00:00.000Z", "to": "2024-01-02T00:00:00.000Z"}
            selected = domain or fallback
            end = instant_ms(selected["to"])
            value["settings"].update(range={"from": iso_from_ms(max(MIN_INSTANT_MS, end - 3600000)), "to": selected["to"]},
                                     overview={"from": iso_from_ms(max(MIN_INSTANT_MS, end - 86400000)), "to": selected["to"]},
                                     referenceTime=selected["from"])
        return value

    def capture_query_domain(self, request):
        domain = request.get("domain")
        if not isinstance(domain, dict):
            raise DomainError("invalid_query", "Query requires a finite domain.")
        low, high = instant_ms(domain.get("from")), instant_ms(domain.get("to"))
        if low >= high:
            raise DomainError("invalid_query", "Query domain end must follow its start.")
        with self.mutex:
            self._ensure_available()
            chosen = set()
            position = bisect.bisect_left(self._starts, high) - 1
            # Prefix maxima keep sessions stored in earlier date folders discoverable.
            while position >= 0 and self._max_ends[position] > low:
                _, end, identity = self._index[position]
                if end > low:
                    chosen.add(identity)
                position -= 1
            for identity in tuple(chosen):
                parent = self.records[identity]["parentSessionId"]
                while parent and parent not in chosen:
                    chosen.add(parent)
                    parent = self.records[parent]["parentSessionId"]
            bundle = normalize_metadata(self.meta)
            bundle["records"] = [self.records[identity] for identity in sorted(chosen)]
            bundle["zones"] = [zone for zone in bundle.get("zones", [])
                               if instant_ms(zone["start"]) < high and instant_ms(zone["end"]) > low]
            bundle["manifest"]["recordCount"] = len(chosen)
            bundle["manifest"]["legacy"]["declaredRange"] = copy.deepcopy(domain)
            return bundle

    def get_record(self, record_id, include_deleted=False):
        with self.mutex:
            self._ensure_available()
            record = self.records.get(record_id)
            if record is None:
                raise DomainError("record_not_found", "Record does not exist.", 404)
            return copy.deepcopy(record)

    def command_outcome(self, *args):
        raise DomainError("command_not_found", "Read-only legacy sources have no write commands.", 404)

    def mutate(self, *args, **kwargs):
        raise DomainError("legacy_read_only", "Legacy JSON sources are read-only.", 403)

    mutate_batch = mutate
    mutate_model = mutate
    _commit_files = mutate
