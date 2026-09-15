"""App-owned JSON preferences; never a writer for legacy authorities."""
from __future__ import annotations

import copy
import hashlib
import sys
from pathlib import Path

import portalocker

from ..models.configuration_catalog import normalize_configuration
from ..models.domain import DomainError, MAX_SAFE_INT, json_bytes, parse_json
from ..services.legacy_reader import safe_read
from ..services.legacy_sources import _guard_path
from .json_repository import JsonRepository, atomic_json

_ACTOR = {"id": "legacy-preferences-validation", "capabilities": ["*"]}
_BYTES = 16 * 1024 * 1024
_OUTCOMES = 256
_WRITABLE = ("filters", "views", "defaults", "preferences")


class LegacyPreferencesRepository:
    """ConfigurationService adapter with an independently revisioned atomic file."""

    def __init__(self, base, root):
        self.base, self.mutex = base, base.mutex
        self.root = _guard_path(Path(root).absolute())
        state_root = _guard_path(base.root)
        if self.root == state_root or not self.root.is_relative_to(state_root):
            raise DomainError("preferences_path", "Preferences must use a dedicated child directory of the application state root.", 403)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        _guard_path(self.root)
        self.path = self.root / "preferences.json"
        self._lock = portalocker.Lock(str(_guard_path(self.root / "preferences.lock")), mode="a+b", timeout=0, flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
        self._owner = None
        self._recovery = False
        self._cached_base_key = self._cached_base = None
        self.authorities = hashlib.sha256(json_bytes([
            [source.id, str(source.root), source.data_model] for source in base.configuration.sources
        ])).hexdigest()
        try:
            self._owner = self._lock.acquire()
            if self.path.exists():
                self.document = self._read()
            else:
                self.document = {"format": "openbexi-legacy-preferences", "version": 1,
                                 "workspaceId": base.meta["manifest"]["workspaceId"], "authorities": self.authorities,
                                 "revision": 0, "catalogs": {"filters": [], "views": []},
                                 "defaults": copy.deepcopy(self._base_metadata()["defaults"]),
                                 "preferences": copy.deepcopy(self._base_metadata()["preferences"]), "outcomes": {}}
                self._validate(self.document)
                atomic_json(self.path, self._sealed(self.document))
        except Exception:
            self.close()
            raise

    @staticmethod
    def _sealed(document):
        return {**document, "sha256": hashlib.sha256(json_bytes(document)).hexdigest()}

    def _base_metadata(self):
        manifest = self.base.meta["manifest"]
        key = (manifest["generation"], manifest["revision"])
        if key != self._cached_base_key:
            value = normalize_configuration({**self.base.meta, "records": []}, _ACTOR)
            self._cached_base = {key: item for key, item in value.items() if key != "records"}
            self._cached_base_key = key
        return self._cached_base

    def _read(self):
        value = parse_json(safe_read(_guard_path(self.path), self.root, _BYTES))
        if not isinstance(value, dict):
            raise DomainError("preferences_integrity", "Preferences must contain one JSON document.", 503)
        checksum = value.pop("sha256", None)
        if checksum != hashlib.sha256(json_bytes(value)).hexdigest():
            raise DomainError("preferences_integrity", "Preferences checksum does not match.", 503)
        self._validate(value)
        return value

    def _validate(self, document):
        required = {"format", "version", "workspaceId", "authorities", "revision", "catalogs", "defaults", "preferences", "outcomes"}
        if (set(document) != required or document["format"] != "openbexi-legacy-preferences" or type(document["version"]) is not int or document["version"] != 1
                or type(document["revision"]) is not int or not 0 <= document["revision"] < MAX_SAFE_INT
                or document["workspaceId"] != self.base.meta["manifest"]["workspaceId"] or document["authorities"] != self.authorities
                or not isinstance(document["catalogs"], dict) or set(document["catalogs"]) != {"filters", "views"}
                or not isinstance(document["outcomes"], dict) or len(document["outcomes"]) > _OUTCOMES):
            raise DomainError("preferences_integrity", "Preferences have an invalid shape or belong to other legacy authorities.", 503)
        for key, outcome in document["outcomes"].items():
            if (len(key) != 64 or any(char not in "0123456789abcdef" for char in key) or not isinstance(outcome, dict)
                    or set(outcome) != {"clientCommandId", "actorId", "requestHash", "result", "authorization"}
                    or not isinstance(outcome["result"], dict) or not isinstance(outcome["authorization"], dict)
                    or not isinstance(outcome["actorId"], str) or not isinstance(outcome["requestHash"], str)):
                raise DomainError("preferences_integrity", "Preferences contain an invalid command outcome.", 503)
        metadata = copy.deepcopy(self._base_metadata())
        for family in ("filters", "views"):
            values = document["catalogs"][family]
            if not isinstance(values, list):
                raise DomainError("preferences_integrity", "Preference catalogs must be arrays.", 503)
            base_ids = {item["id"] for item in metadata[family]}
            if any(not isinstance(item, dict) or item.get("id") in base_ids for item in values):
                raise DomainError("legacy_read_only", "An application preference cannot replace a legacy catalog item.", 403)
            metadata[family].extend(copy.deepcopy(values))
        metadata["defaults"], metadata["preferences"] = copy.deepcopy(document["defaults"]), copy.deepcopy(document["preferences"])
        normalize_configuration({**metadata, "records": []}, _ACTOR)
        if len(json_bytes(self._sealed(document))) > _BYTES:
            raise DomainError("preferences_capacity", "Preferences exceed the 16 MiB document capacity; export and archive unused definitions.", 413)

    def _ensure_available(self):
        self.base._ensure_available()
        if self._owner is None:
            raise DomainError("preferences_unavailable", "Preferences storage is closed.", 503)
        _guard_path(self.root)
        if self._recovery:
            self.document = self._read()
            self._recovery = False

    @property
    def revision(self):
        return self.document["revision"]

    def capture(self):
        with self.mutex:
            self._ensure_available()
            return {key: copy.deepcopy(self.document[key]) for key in ("revision", "catalogs", "defaults", "preferences")}

    def capture_admission(self):
        """Measure container copies before allocating captured/applied preferences."""
        with self.mutex:
            self._ensure_available()
            source = {key: self.document[key] for key in ("revision", "catalogs", "defaults", "preferences")}
            containers, size = 0, 0
            stack = [iter((source,))]
            while stack:
                try:
                    value = next(stack[-1])
                except StopIteration:
                    stack.pop()
                    continue
                if isinstance(value, (dict, list)):
                    containers += 1
                    size += sys.getsizeof(value)
                    stack.append(iter(value.values() if isinstance(value, dict) else value))
            # Two copies, dictionary growth headroom, and deepcopy memo bookkeeping.
            return source, 4 * size + 256 * containers

    def apply(self, snapshot, captured_state=None):
        """Retain data revision/generation; add a separate preference revision."""
        with self.mutex:
            self._ensure_available()
            selected = self.document if captured_state is None else captured_state
            result = {**self._base_metadata(), **snapshot}
            for family in ("filters", "views"):
                base_ids = {item["id"] for item in self._base_metadata()[family]}
                result[family] = [*[item for item in result[family] if item["id"] in base_ids], *copy.deepcopy(selected["catalogs"][family])]
            for key in ("defaults", "preferences"):
                result[key] = copy.deepcopy(selected[key])
            result["manifest"] = {**result["manifest"], "preferencesRevision": selected["revision"],
                                  "legacy": {**result["manifest"].get("legacy", {}), "readOnly": True, "preferencesEnabled": True,
                                             "preferencesSource": "application-json", "preferencesRevision": selected["revision"],
                                             "preferencesCatalogIds": {family: [item["id"] for item in selected["catalogs"][family]] for family in ("filters", "views")}}}
            result["manifest"].pop("contentSha256", None)
            return result

    @property
    def meta(self):
        result = self.apply(self.base.meta)
        # Config API revision describes this file; data queries retain data revision.
        result["manifest"]["revision"] = self.revision + 1
        return result

    @meta.setter
    def meta(self, value):
        if value["manifest"]["revision"] != self.revision + 1:
            raise DomainError("preferences_integrity", "Committed preferences revision is inconsistent.", 503)

    @property
    def records(self):
        return self.base.records

    def query_snapshot(self, *args, **kwargs):
        return self.apply(self.base.query_snapshot(*args, **kwargs))

    def project_scope(self, snapshot, source_ids):
        return self.base.project_scope(snapshot, source_ids)

    @property
    def lazy(self):
        return getattr(self.base, "lazy", False)

    def _outcome_path(self, principal, command_id):
        return JsonRepository._outcome_path(self, principal, command_id)

    def _read_target(self, relative):
        path = Path(relative)
        if path.parent.as_posix() != "outcomes" or path.suffix != ".json":
            raise DomainError("preferences_path", "Unknown preferences target.", 403)
        return copy.deepcopy(self.document["outcomes"].get(path.stem))

    def _commit_files(self, files):
        self._ensure_available()
        current = self.meta
        metadata = files.get("workspace.json")
        outcomes = [(name, value) for name, value in files.items() if name != "workspace.json"]
        if not isinstance(metadata, dict) or len(outcomes) != 1:
            raise DomainError("preferences_path", "Preferences commits require metadata and one command outcome.", 403)
        for key in set(current) | set(metadata):
            if key not in (*_WRITABLE, "manifest") and metadata.get(key) != current.get(key):
                raise DomainError("legacy_read_only", "Legacy models, schemas, sources and settings are immutable.", 403)
        for key in set(current["manifest"]) | set(metadata["manifest"]):
            if key not in ("revision", "snapshotAt", "contentSha256") and metadata["manifest"].get(key) != current["manifest"].get(key):
                raise DomainError("legacy_read_only", "Legacy data metadata is immutable.", 403)
        if metadata["manifest"]["revision"] != current["manifest"]["revision"] + 1:
            raise DomainError("preferences_revision_conflict", "Preferences changed; reload before editing.", 412)
        path, outcome = outcomes[0]
        if path != self._outcome_path(outcome["actorId"], outcome["clientCommandId"]).relative_to(self.root).as_posix():
            raise DomainError("preferences_path", "Invalid outcome identity.", 403)
        document = copy.deepcopy(self.document)
        for family in ("filters", "views"):
            base = self._base_metadata()[family]
            ids = {item["id"] for item in base}
            if [item for item in metadata[family] if item["id"] in ids] != base:
                raise DomainError("legacy_read_only", "Legacy catalog publications are immutable.", 403)
            document["catalogs"][family] = [item for item in metadata[family] if item["id"] not in ids]
        for key in ("defaults", "preferences"):
            document[key] = metadata[key]
        document["revision"] += 1
        document["outcomes"][Path(path).stem] = outcome
        if len(document["outcomes"]) > _OUTCOMES:
            raise DomainError("preferences_capacity", "Preferences command history is full; export before rotating the application preferences directory.", 413)
        self._validate(document)
        if self._read() != self.document:
            raise DomainError("preferences_integrity", "Preferences changed outside this server; restart after reviewing the file.", 503)
        try:
            atomic_json(_guard_path(self.path), self._sealed(document))
        except OSError:
            self._recovery = True
            raise
        self.document = copy.deepcopy(document)

    def close(self):
        if self._owner is not None:
            self._lock.release()
            self._owner = None
