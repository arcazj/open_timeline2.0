from __future__ import annotations

import copy
import hashlib
import os
import re
import stat
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from itertools import batched
from pathlib import Path

import portalocker

from ..models.domain import DomainError, MAX_SAFE_INT, content_checksum, json_bytes, make_record, now_iso, parse_json, read_json, valid_id, validate_json, validate_record, validate_snapshot
from ..models.model_catalog import apply_model_command, model_id, normalize_metadata
from ..models.record_schema import assert_source_writable
from .json_shards import LAYOUT_BYTES, SHARD_BYTES, apply_record_changes, validate_layout, validate_shard
from .audit_history import AUDIT_ENTRY_BYTES, prepare_audit, validate_audit_history
from .integrity_monitor import WorkspaceIntegrity, open_observation, validate_root_path

_READ_WORKERS = 32
_READ_BATCH_SIZE = 256
_READ_PARALLEL_THRESHOLD = 128
_RECORD_FILE_BYTES = 1024 * 1024
_JOURNAL_BYTES = 32 * 1024 * 1024


def _file_identity(value):
    # Windows path-stat and descriptor-stat can disagree on creation time after replace.
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def _plain_file(value):
    return stat.S_ISREG(value.st_mode) and not (getattr(value, "st_file_attributes", 0) & 0x400)


def _read_bounded_json(path, limit, capacity_code, receipt=None):
    initial = path.lstat()
    if not _plain_file(initial):
        raise DomainError("storage_integrity", "Storage JSON must be a regular file, not a link or reparse point.", 503)
    with open_observation(path) as stream:
        before = os.fstat(stream.fileno())
        if not _plain_file(before) or _file_identity(initial) != _file_identity(before):
            raise DomainError("storage_integrity", "Storage file changed while opening.", 503)
        if before.st_size > limit:
            raise DomainError(capacity_code, "Storage JSON file exceeds its raw byte admission limit.", 413)
        data = stream.read(before.st_size + 1)
        after = os.fstat(stream.fileno())
        current = path.lstat()
        if (len(data) != before.st_size or not _plain_file(current)
                or _file_identity(before) != _file_identity(after)
                or _file_identity(after) != _file_identity(current)
                or before.st_ctime_ns != after.st_ctime_ns or initial.st_ctime_ns != current.st_ctime_ns):
            raise DomainError("storage_integrity", "Storage file changed during its read.", 503)
    document = parse_json(data)
    if receipt is not None:
        receipt(path, hashlib.sha256(data).digest(), current)
    return document


def _read_record_file(path, receipt=None):
    return _read_bounded_json(path, _RECORD_FILE_BYTES, "record_file_capacity", receipt)


def _document_image(document):
    return {"exists": document is not None, "document": document,
            "sha256": hashlib.sha256(json_bytes(document)).hexdigest() if document is not None else None}


def _journal_checksum(journal):
    return hashlib.sha256(json_bytes({key: value for key, value in journal.items() if key != "checksum"})).hexdigest()


def sync_directory(path: Path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(json_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


class JsonRepository:
    """One owner; complete before/after preparation precedes installs and the commit marker."""

    def __init__(self, root: Path, seed_path: Path, actor: str = "api-user"):
        self.root, self.seed_path, self.actor = Path(root), Path(seed_path), actor
        self.mutex = threading.RLock()
        self.owner = None
        self.available = False
        self.meta = {}
        self.records = {}
        self.layout = None
        self.shards = {}
        self.audit_state = None
        self.integrity = None
        self._admitting_reads = False
        self.audit_entries = {}

    def open(self):
        if self.owner is not None:
            raise RuntimeError("This JSON repository already has an active writer.")
        validate_root_path(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / ".writer.lock"
        try:
            lock_stat = lock_path.lstat()
        except FileNotFoundError:
            lock_stat = None
        if lock_stat is not None and not _plain_file(lock_stat):
            raise DomainError("storage_integrity", "Writer ownership path must be a regular file.", 503)
        self.owner = portalocker.Lock(str(lock_path), mode="a+b", timeout=0,
                                     flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
        try:
            descriptor = self.owner.acquire()
        except portalocker.exceptions.LockException as error:
            self.owner = None
            raise RuntimeError("The JSON data root already has an active writer.") from error
        except BaseException:
            self.owner.release()
            self.owner = None
            raise
        try:
            validate_root_path(self.root)
            current, opened = lock_path.lstat(), os.fstat(descriptor.fileno())
            if (not _plain_file(current) or not _plain_file(opened)
                    or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                    or (lock_stat is not None and (lock_stat.st_dev, lock_stat.st_ino) != (opened.st_dev, opened.st_ino))):
                raise DomainError("storage_integrity", "Writer ownership path changed while opening.", 503)
            if (self.root / "migration-incomplete.json").exists():
                raise RuntimeError("Storage migration is incomplete; this destination cannot become ready.")
            self._recover()
            if not (self.root / "workspace.json").exists():
                if any(path.name != ".writer.lock" for path in self.root.iterdir()):
                    raise RuntimeError("Workspace metadata is missing from a nonempty data root; refusing to reseed existing data.")
                self._seed()
            self.integrity = WorkspaceIntegrity(self)
            self._admitting_reads = True
            self.meta = _read_bounded_json(self.root / "workspace.json", _JOURNAL_BYTES, "storage_file_capacity", self._receipt())
            self.records = self._load_records()
            validate_snapshot({**self.meta, "records": list(self.records.values())})
            self._load_audit()
            self._load_restore_provenance()
            self._load_outcomes()
            self.integrity.initialize()
            self._admitting_reads = False
            self.available = True
            self.integrity.start()
            return self
        except BaseException:
            self.close()
            raise

    def _load_audit(self):
        self.audit_state = self._read_target("audit-state.json")
        self._checked_path("audit/0000000000000001.json")
        self.audit_entries = {}
        if (self.root / "audit").exists():
            for path in sorted((self.root / "audit").iterdir()):
                relative = path.relative_to(self.root).as_posix()
                self.audit_entries[relative] = self._read_target(relative)
        validate_audit_history(self.audit_state, self.audit_entries, self.meta["manifest"])

    def _receipt(self):
        if self.integrity is None:
            return None
        return self.integrity.capture if self._admitting_reads else self.integrity.check_receipt

    def _load_outcomes(self):
        from ..services.backup import _validate_outcome
        self._checked_path("outcomes/" + "0" * 64 + ".json")
        if (self.root / "outcomes").exists():
            for path in sorted((self.root / "outcomes").iterdir()):
                relative = path.relative_to(self.root).as_posix()
                _validate_outcome(relative, self._read_target(relative), self.meta["manifest"])

    def _load_restore_provenance(self):
        from ..services.backup import _absolute, validate_provenance
        path = _absolute(self.root) / "restore-provenance.json"
        self.restore_provenance = None
        if not path.exists() and not path.is_symlink():
            return
        document = _read_bounded_json(path, _JOURNAL_BYTES, "restore_provenance_capacity", self._receipt())
        validate_provenance(document)
        last = document["restores"][-1]
        if last["workspaceGeneration"] != self.meta["manifest"]["generation"] or last["workspaceId"] != self.meta["manifest"]["workspaceId"]:
            raise DomainError("storage_integrity", "Restore provenance does not match the current workspace.", 503)
        self.restore_provenance = document

    def _load_records(self):
        if (self.root / "storage-layout.json").exists():
            return self._load_shards()
        if (self.root / "shards").exists():
            raise RuntimeError("Shard files require an explicit storage layout manifest; refusing ambiguous storage.")
        self.layout, self.shards = None, {}
        self._checked_path("records/00000000-0000-0000-0000-000000000000.json")
        paths = sorted((self.root / "records").glob("*.json"))
        records = {}

        def accept(path, record):
            if not isinstance(record, dict) or path.stem != record.get("id"):
                raise RuntimeError("Record filename and canonical ID do not match.")
            if record["id"] in records:
                raise DomainError("duplicate_id", "Data root contains duplicate canonical record IDs.")
            records[record["id"]] = record

        if len(paths) < _READ_PARALLEL_THRESHOLD:
            for path in paths:
                accept(path, _read_record_file(path, self._receipt()))
            return records
        executor = ThreadPoolExecutor(max_workers=_READ_WORKERS, thread_name_prefix="timeline-json-read")
        try:
            for batch in batched(paths, _READ_BATCH_SIZE):
                pending = [executor.submit(_read_record_file, path, self._receipt()) for path in batch]
                # Consume in filename order, including failures, regardless of completion order.
                for path, future in zip(batch, pending):
                    accept(path, future.result())
        finally:
            # Drain reads before open() can release the writer lock or permit recovery.
            executor.shutdown(wait=True, cancel_futures=True)
        return records

    def _load_shards(self):
        if (self.root / "records").exists():
            raise RuntimeError("Legacy record storage and authoritative shards cannot coexist in one root.")
        layout = self._read_target("storage-layout.json")
        validate_layout(layout, self.meta["manifest"])
        self._checked_path("shards/0.json")
        expected = {value["path"] for value in layout["buckets"]}
        actual = {"shards/" + path.name for path in (self.root / "shards").glob("*.json")}
        if actual != expected:
            raise DomainError("storage_layout_integrity", "Missing or unexpected authoritative shard files.", 503)
        records, shards = {}, {}
        for bucket in layout["buckets"]:
            document = self._read_target(bucket["path"])
            validate_shard(document, bucket)
            shards[bucket["prefix"]] = document
            for record in document["records"]:
                if record["id"] in records:
                    raise DomainError("duplicate_id", "Record ID occurs in multiple authoritative shards.")
                records[record["id"]] = record
        self.layout, self.shards = layout, shards
        return records

    def close(self):
        self.available = False
        if self.integrity is not None:
            self.integrity.close()
        with self.mutex:
            self.integrity = None
            self._admitting_reads = False
            if self.owner:
                self.owner.release()
                self.owner = None

    def _seed(self):
        bundle = read_json(self.seed_path)
        validate_snapshot(bundle)
        records = bundle["records"]
        meta = copy.deepcopy({key: value for key, value in bundle.items() if key != "records"})
        meta["manifest"]["sourceKind"] = "server"
        meta["manifest"].pop("contentSha256", None)
        # Initial installation uses the same bounded before/after transaction protocol.
        after = {f"records/{record['id']}.json": record for record in records}
        after["workspace.json"] = meta
        self._commit_files(after)

    def _recover(self):
        journal_path = self.root / "transaction.json"
        if not journal_path.exists():
            if self.integrity is not None and not self._admitting_reads and "transaction.json" in self.integrity.expected:
                self.integrity._freeze("transaction.json", "admitted recovery journal disappeared")
            return
        journal = _read_bounded_json(journal_path, _JOURNAL_BYTES, "journal_capacity", self._receipt())
        if not isinstance(journal, dict) or journal.get("state") not in ("prepared", "committed"):
            raise RuntimeError("Invalid recovery journal; manual recovery is required.")
        version = journal.get("formatVersion", 1)
        if type(version) is not int or version not in (1, 2):
            raise RuntimeError("Unsupported recovery journal version; evidence has been preserved.")
        if version == 1:
            if not isinstance(journal.get("after"), dict):
                raise RuntimeError("Invalid legacy recovery journal.")
            for relative, document in journal["after"].items():
                self._checked_path(relative)
                if not isinstance(document, dict):
                    raise RuntimeError("Invalid legacy recovery document.")
            if journal["state"] == "committed":
                for relative, document in journal["after"].items():
                    self._install(relative, document)
        else:
            self._validate_journal(journal)
            # Classify every target before touching one; never overwrite an unrelated/newer state.
            for relative in journal["after"]:
                current = self._read_target(relative)
                image = _document_image(current)
                if image["exists"] and image not in (journal["before"][relative], journal["after"][relative]):
                    raise RuntimeError("Recovery target conflicts with both journal images; evidence has been preserved.")
            selected = journal["after"] if journal["state"] == "committed" else journal["before"]
            for relative, image in selected.items():
                self._install(relative, image["document"] if image["exists"] else None)
        self._cleanup_journal()
        if self.integrity is not None and not self._admitting_reads:
            restored = journal["after"] if version == 1 else {relative: image["document"] if image["exists"] else None for relative, image in selected.items()}
            self.integrity.committed(restored)

    def _checked_path(self, relative):
        allowed = isinstance(relative, str) and (relative in ("workspace.json", "storage-layout.json", "audit-state.json") or bool(re.fullmatch(
            r"records/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json|outcomes/[a-f0-9]{64}\.json|shards/[a-f0-9]{1,32}\.json|audit/[0-9]{16}\.json", relative)))
        if not allowed:
            raise RuntimeError("Recovery journal references an invalid path.")
        validate_root_path(self.root)
        path = self.root / relative
        root = self.root.resolve()
        if not path.resolve().is_relative_to(root):
            raise RuntimeError("Recovery journal references an invalid path.")
        candidate = self.root
        for part in Path(relative).parts:
            candidate = candidate / part
            try:
                info = candidate.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise RuntimeError("Storage paths cannot contain symlinks or reparse points.")
            if candidate == path and not stat.S_ISREG(info.st_mode):
                raise RuntimeError("Storage target must be a regular JSON file.")
        return path

    def _read_target(self, relative):
        try:
            path = self._checked_path(relative)
            limit = AUDIT_ENTRY_BYTES if relative.startswith("audit/") or relative == "audit-state.json" else _RECORD_FILE_BYTES if relative.startswith("records/") else (
                SHARD_BYTES if relative.startswith("shards/") else (LAYOUT_BYTES if relative == "storage-layout.json" else _JOURNAL_BYTES))
            document = _read_bounded_json(path, limit, "storage_file_capacity", self._receipt())
            if not isinstance(document, dict):
                raise DomainError("storage_integrity", "Authoritative storage documents must be JSON objects.", 503)
            return document
        except FileNotFoundError:
            if self.integrity is not None and not self._admitting_reads and relative in self.integrity.expected:
                self.integrity._freeze(relative, "admitted file is missing")
            return None
        except (DomainError, RuntimeError, OSError):
            if self.integrity is not None and not self._admitting_reads:
                if self.integrity.failure is None:
                    self.integrity._freeze(relative, "storage authority could not be safely read")
                self.available = False
            raise

    def _validate_journal(self, journal):
        if (set(journal) != {"formatVersion", "transactionId", "state", "before", "after", "checksum"}
                or journal.get("formatVersion") != 2 or journal.get("state") not in ("prepared", "committed")
                or not isinstance(journal.get("before"), dict) or not isinstance(journal.get("after"), dict)
                or set(journal["before"]) != set(journal["after"]) or "workspace.json" not in journal["after"]):
            raise RuntimeError("Invalid v2 recovery envelope.")
        valid_id(journal["transactionId"])
        if journal.get("checksum") != _journal_checksum(journal):
            raise RuntimeError("Recovery envelope checksum mismatch.")
        for relative in journal["after"]:
            self._checked_path(relative)
            for images in (journal["before"], journal["after"]):
                image = images[relative]
                if (not isinstance(image, dict) or set(image) != {"exists", "document", "sha256"}
                        or type(image["exists"]) is not bool
                        or (image["exists"] and not isinstance(image["document"], dict))
                        or image != _document_image(image["document"])):
                    raise RuntimeError("Recovery image is malformed or has a checksum mismatch.")
                if image["exists"] and relative.startswith("records/"):
                    if image["document"].get("id") != Path(relative).stem:
                        raise RuntimeError("Recovery record identity does not match its path.")
        if "storage-layout.json" in journal["after"]:
            for side in ("before", "after"):
                layout_image = journal[side]["storage-layout.json"]
                if not layout_image["exists"]:
                    raise RuntimeError("A live transaction cannot change its storage layout version.")
                validate_layout(layout_image["document"], journal[side]["workspace.json"]["document"]["manifest"])
                entries = {value["path"]: value for value in layout_image["document"]["buckets"]}
                for relative, image in journal[side].items():
                    if relative.startswith("shards/") and image["exists"]:
                        if relative not in entries:
                            raise RuntimeError("Recovery shard is absent from its layout manifest.")
                        validate_shard(image["document"], entries[relative])
        elif any(relative.startswith("shards/") for relative in journal["after"]):
            raise RuntimeError("Recovery shard changes require their complete layout manifest.")
        previous, following = journal["before"]["workspace.json"], journal["after"]["workspace.json"]
        if not following["exists"]:
            raise RuntimeError("A transaction cannot remove its workspace manifest.")
        target = following["document"].get("manifest", {})
        if (not isinstance(target, dict) or type(target.get("revision")) is not int
                or not 1 <= target["revision"] <= MAX_SAFE_INT or not isinstance(target.get("generation"), str)
                or not isinstance(target.get("workspaceId"), str)):
            raise RuntimeError("Recovery target manifest is malformed.")
        if previous["exists"]:
            base = previous["document"].get("manifest", {})
            if (not isinstance(base, dict) or type(base.get("revision")) is not int
                    or target["revision"] != base["revision"] + 1
                    or any(base.get(key) != target[key] for key in ("workspaceId", "generation"))):
                raise RuntimeError("Recovery manifest revision sequence is invalid.")

    def _install(self, relative: str, document):
        path = self._checked_path(relative)
        if document is not None:
            atomic_json(path, document)
        elif path.exists():
            path.unlink()
            sync_directory(path.parent)

    def _cleanup_journal(self):
        (self.root / "transaction.json").unlink()
        sync_directory(self.root)
        for name in ("records", "outcomes", "shards"):
            directory = self.root / name
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
                sync_directory(self.root)

    def _write_journal(self, journal):
        journal["checksum"] = _journal_checksum(journal)
        if len(json_bytes(journal)) > _JOURNAL_BYTES:
            raise DomainError("journal_capacity", "Complete transaction envelope exceeds 32 MiB.", 413)
        atomic_json(self.root / "transaction.json", journal)

    def _commit_files(self, after: dict):
        with self.mutex:
            if self.integrity is not None:
                # Windows atomic replacement needs the destination's observation handle closed.
                with self.integrity.observation_lock:
                    return self._commit_files_owned(after)
            return self._commit_files_owned(after)

    def _commit_files_owned(self, after: dict):
        journal = {"formatVersion": 2, "transactionId": str(uuid.uuid4()), "state": "prepared", "before": {}, "after": {}}
        prepared = False
        try:
            self._recover()
            outcomes = [document for relative, document in after.items() if relative.startswith("outcomes/")]
            if self.meta and outcomes:
                if len(outcomes) != 1:
                    raise DomainError("audit_integrity", "One workspace transaction requires one command outcome.", 503)
                after = {**after, **prepare_audit(self.audit_state, self.meta["manifest"], after["workspace.json"]["manifest"], outcomes[0])}
            if self.layout is not None:
                updates = {Path(relative).stem: document for relative, document in after.items() if relative.startswith("records/")}
                after = {**{relative: document for relative, document in after.items() if not relative.startswith("records/")},
                         **apply_record_changes(self.layout, self.shards, updates, after["workspace.json"]["manifest"])}
            if self.integrity is not None:
                self.integrity.admit(after)
            approximate_bytes = 1024
            for relative, document in after.items():
                validate_json(document)
                existing = self._read_target(relative)
                if relative == "workspace.json":
                    expected = self.meta or None
                elif relative == "storage-layout.json":
                    expected = self.layout
                elif relative == "audit-state.json":
                    expected = self.audit_state
                elif relative.startswith("audit/"):
                    expected = self.audit_entries.get(relative)
                elif relative.startswith("shards/"):
                    expected = self.shards.get(Path(relative).stem)
                else:
                    expected = self.records.get(Path(relative).stem) if relative.startswith("records/") else None
                if _document_image(existing) != _document_image(expected):
                    raise DomainError("storage_integrity", "Storage target changed outside the repository; writes are frozen.", 503)
                before_image, after_image = _document_image(existing), _document_image(document)
                approximate_bytes += len(json_bytes(before_image)) + len(json_bytes(after_image)) + 2 * len(relative.encode()) + 16
                if approximate_bytes > _JOURNAL_BYTES:
                    raise DomainError("journal_capacity", "Complete transaction envelope exceeds 32 MiB.", 413)
                journal["before"][relative], journal["after"][relative] = before_image, after_image
            journal["checksum"] = _journal_checksum(journal)
            try:
                validate_json(journal)
            except DomainError as error:
                raise DomainError("journal_capacity", "Complete transaction envelope exceeds the JSON nesting limit.", 413) from error
            self._validate_journal(journal)
            self._write_journal(journal)
            prepared = True
            for relative, image in journal["after"].items():
                self._install(relative, image["document"] if image["exists"] else None)
            journal["state"] = "committed"
            self._write_journal(journal)
        except DomainError as error:
            if prepared or error.code not in ("journal_capacity", "audit_capacity", "integrity_capacity"):
                self.available = False
            raise
        except BaseException:
            self.available = False
            raise
        try:
            self._cleanup_journal()
        except OSError:
            # The flushed commit marker establishes success; the next mutation reconciles it.
            pass
        if "audit-state.json" in after:
            self.audit_state = after["audit-state.json"]
            self.audit_entries.update({relative: document for relative, document in after.items() if relative.startswith("audit/")})
        if self.layout is not None:
            self.layout = after["storage-layout.json"]
            for relative, document in after.items():
                if relative.startswith("shards/"):
                    if document is None:
                        self.shards.pop(Path(relative).stem, None)
                    else:
                        self.shards[Path(relative).stem] = document
        if self.integrity is not None:
            self.integrity.committed(after, journal)

    def _ensure_available(self):
        if not self.available:
            if self.integrity is not None and self.integrity.failure is not None:
                raise DomainError("external_change", "Workspace integrity failed; the repository requires restart and recovery before access.", 503)
            raise DomainError("repository_unavailable", "Repository requires restart and recovery before reads or writes.", 503)

    def metadata(self):
        with self.mutex:
            self._ensure_available()
            normalized = normalize_metadata(self.meta)
            manifest = normalized["manifest"]
            return {
                "identity": "server:" + manifest["workspaceId"] + ":" + str(manifest["generation"]),
                "sourceName": manifest["sourceName"], "sourceKind": "server", "workspaceId": manifest["workspaceId"],
                "generation": manifest["generation"], "revision": manifest["revision"],
                "snapshotAt": manifest["snapshotAt"], "recordCount": len([r for r in self.records.values() if not r["deletedAt"]]),
                "completeness": "complete-for-declared-universe", "settings": normalized["settings"],
                "models": normalized["models"],
                "sources": sorted({record["sourceId"] for record in self.records.values() if not record["deletedAt"]}),
                "sourceIds": copy.deepcopy(manifest["scope"]["sourceIds"]),
                "durability": "server-committed", "modified": False,
                "capabilities": {"read": True, "write": True, "export": True, "durable": True, "admin": False,
                                 "recordCrud": True, "importExport": True, "modelManagement": True,
                                 "modelPublication": True, "serverAdministration": False},
            }

    def snapshot(self):
        bundle = self.query_snapshot()
        bundle["manifest"]["contentSha256"] = content_checksum(bundle)
        return bundle

    def query_snapshot(self):
        """Internal pinned copy; integrity encoding remains mandatory for exports."""
        with self.mutex:
            self._ensure_available()
            bundle = normalize_metadata(self.meta)
            bundle["records"] = copy.deepcopy(sorted(self.records.values(), key=lambda record: record["id"]))
            bundle["manifest"]["recordCount"] = len(bundle["records"])
            bundle["manifest"]["bundleId"] = str(uuid.uuid4())
            return bundle

    def capture_query_snapshot(self):
        """Internal capture: copied metadata, immutable borrowed record references.

        Query workers must never modify the records or their nested values. Published
        records are copy-on-write, so later commands cannot change this pinned view.
        This is not an export or response payload; use query_snapshot for owned copies.
        """
        with self.mutex:
            self._ensure_available()
            bundle = normalize_metadata(self.meta)
            bundle["records"] = list(self.records.values())
            bundle["manifest"]["recordCount"] = len(bundle["records"])
            bundle["manifest"]["bundleId"] = str(uuid.uuid4())
            return bundle

    def list_models(self, include_archived=True):
        with self.mutex:
            self._ensure_available()
            normalized = normalize_metadata(self.meta)
            models = normalized["models"]
            settings, manifest = normalized["settings"], normalized["manifest"]
            return {"items": [model for model in models if include_archived or model["lifecycle"] != "archived"],
                    "active": {"modelId": settings["modelId"], "version": settings["modelVersion"]},
                    "generation": manifest["generation"], "revision": manifest["revision"]}

    def get_model(self, target_id):
        model_id(target_id)
        with self.mutex:
            catalog = self.list_models()
            model = next((value for value in catalog["items"] if value["id"] == target_id), None)
            if model is None:
                raise DomainError("model_not_found", "Model does not exist.", 404)
            usage = []
            if catalog["active"]["modelId"] == target_id:
                usage.append({"kind": "workspace-default", "modelId": target_id, "version": catalog["active"]["version"]})
            return {"model": model, "usage": usage, "generation": catalog["generation"], "revision": catalog["revision"]}

    def mutate_model(self, operation, target_id, payload, generation, if_match, command_id, principal):
        if not generation or not command_id or (operation != "create" and not if_match):
            raise DomainError("precondition_required", "Model writes require generation, idempotency key and existing-model If-Match.", 428)
        if operation != "create":
            model_id(target_id)
        with self.mutex:
            self._ensure_available()
            if generation != str(self.meta["manifest"]["generation"]):
                raise DomainError("generation_conflict", "Workspace generation has changed.", 409)
            outcome_path = self._outcome_path(principal, command_id)
            fingerprint = hashlib.sha256(json_bytes({"resource": "model", "operation": operation, "modelId": target_id,
                                                     "payload": payload, "generation": generation, "ifMatch": if_match})).hexdigest()
            outcome = self._read_target(outcome_path.relative_to(self.root).as_posix())
            if outcome is not None:
                if outcome["requestHash"] != fingerprint:
                    raise DomainError("idempotency_conflict", "This command key was used for different content.", 409)
                return copy.deepcopy(outcome["result"])
            expected_revision = None
            if operation != "create":
                match = re.fullmatch('"' + re.escape(generation) + r':([1-9][0-9]*)"', if_match)
                if not match or len(match[1]) > 16 or int(match[1]) > MAX_SAFE_INT:
                    raise DomainError("model_revision_conflict", "If-Match must identify this generation and model revision.", 412)
                expected_revision = int(match[1])
            meta, model = apply_model_command(self.meta, operation, target_id, payload, expected_revision)
            if meta["manifest"]["revision"] == MAX_SAFE_INT:
                raise DomainError("revision_capacity", "Workspace revision capacity reached.", 413)
            meta["manifest"]["revision"] += 1
            meta["manifest"]["snapshotAt"] = now_iso()
            result = {"model": model, "settings": meta["settings"], "durability": "server-committed",
                      "generation": meta["manifest"]["generation"], "revision": meta["manifest"]["revision"]}
            after = {"workspace.json": meta, str(outcome_path.relative_to(self.root)).replace("\\", "/"):
                     {"clientCommandId": command_id, "actorId": principal, "requestHash": fingerprint, "result": result}}
            try:
                self._commit_files(after)
            except OSError as error:
                raise DomainError("commit_outcome_unknown", "Model commit requires recovery; retain the original command key.", 503) from error
            self.meta = meta
            return copy.deepcopy(result)

    def get_record(self, record_id: str, include_deleted: bool = False):
        valid_id(record_id)
        with self.mutex:
            self._ensure_available()
            record = self.records.get(record_id)
            if record is None or (record["deletedAt"] and not include_deleted):
                raise DomainError("record_not_found", "Record does not exist.", 404)
            return copy.deepcopy(record)

    def _outcome_path(self, principal: str, command_id: str):
        if not isinstance(command_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command_id):
            raise DomainError("invalid_idempotency_key", "Idempotency-Key requires 1-128 letters, digits, underscores or hyphens.", 400)
        key = hashlib.sha256((principal + "\0" + command_id).encode()).hexdigest()
        return self.root / "outcomes" / f"{key}.json"

    def command_outcome(self, principal: str, command_id: str):
        with self.mutex:
            self._ensure_available()
            path = self._outcome_path(principal, command_id)
            stored = self._read_target(path.relative_to(self.root).as_posix())
            if stored is None:
                raise DomainError("command_not_found", "No committed outcome is known for this command key.", 404)
            if stored["result"].get("generation") != self.meta["manifest"]["generation"]:
                raise DomainError("generation_conflict", "This historical outcome belongs to a previous workspace generation.", 409)
            return copy.deepcopy(stored["result"])

    def mutate(self, operation: str, record_id: str | None, payload: dict, generation: str | None,
               if_match: str | None, command_id: str | None, principal: str, *, expected_kind=None,
               request_route=None, authorize_record=None):
        from ..models.record_commands import patch_record, replacement
        if not generation or not command_id or (operation != "create" and not if_match):
            raise DomainError("precondition_required", "Writes require generation, idempotency key and item If-Match for existing records.", 428)
        if operation != "create":
            valid_id(record_id)
        with self.mutex:
            self._ensure_available()
            current_generation = str(self.meta["manifest"]["generation"])
            if generation != current_generation:
                raise DomainError("generation_conflict", "Workspace generation has changed.", 409)
            outcome_path = self._outcome_path(principal, command_id)
            request_identity = {"operation": operation, "recordId": record_id,
                                "payload": payload, "generation": generation, "ifMatch": if_match}
            if request_route is not None:
                request_identity["route"] = request_route
            request_hash = hashlib.sha256(json_bytes(request_identity)).hexdigest()
            outcome = self._read_target(outcome_path.relative_to(self.root).as_posix())
            if outcome is not None:
                if outcome["requestHash"] != request_hash:
                    raise DomainError("idempotency_conflict", "This command key was used for a different request.", 409)
                if authorize_record:
                    authorize_record(outcome["result"]["record"])
                return copy.deepcopy(outcome["result"])
            if self.meta["manifest"]["revision"] >= MAX_SAFE_INT:
                raise DomainError("revision_capacity", "Workspace revision capacity reached.", 413)
            previous = self.records.get(record_id) if record_id else None
            if operation != "create":
                if previous is None or (expected_kind is not None and previous["kind"] != expected_kind):
                    raise DomainError("record_not_found", "Record does not exist.", 404)
                if if_match != f'"{current_generation}:{previous["version"]}"':
                    raise DomainError("version_conflict", "Record was changed; refresh before retrying.", 412)
                if operation != "restore" and previous["deletedAt"]:
                    raise DomainError("record_deleted", "Record is deleted.", 409)
                assert_source_writable(self.meta, previous["sourceId"], operation)
            if operation in ("create", "update", "replace", "patch"):
                assigned = (patch_record(previous, payload) if operation == "patch" else
                            replacement(payload) if operation == "replace" else copy.deepcopy(payload))
                if not isinstance(assigned, dict):
                    raise DomainError("invalid_record", "Record payload must be an object.")
                if expected_kind is not None and assigned.get("kind", expected_kind) != expected_kind:
                    raise DomainError("invalid_record", "Record kind must match the typed collection.")
                if operation == "create" and expected_kind is not None:
                    assigned["kind"] = expected_kind
                if operation == "create" and "sourceId" not in assigned:
                    sources = self.meta["manifest"]["scope"]["sourceIds"]
                    if not sources:
                        raise DomainError("scope_mismatch", "Configure a source before creating records in this workspace.")
                    assigned["sourceId"] = sources[0]
                source = assert_source_writable(self.meta, assigned.get("sourceId", previous["sourceId"] if previous else None),
                                                "create" if operation == "create" else (
                                                    "reassign" if assigned.get("sourceId", previous["sourceId"]) != previous["sourceId"] else "update"))
                if operation == "create" and "schemaId" not in assigned and "schemaVersion" not in assigned and source.get("defaultSchema"):
                    assigned["schemaId"] = source["defaultSchema"]["id"]
                    assigned["schemaVersion"] = source["defaultSchema"]["version"]
                record = make_record(assigned, principal, self.meta["manifest"]["workspaceId"], previous)
            else:
                record = copy.deepcopy(previous)
                record.update(version=previous["version"] + 1, updatedAt=now_iso(), updatedBy=principal)
                if operation == "delete":
                    if any(r.get("parentSessionId") == record_id and not r["deletedAt"] for r in self.records.values()):
                        raise DomainError("active_children", "Delete or reparent active children first.", 409)
                    record["deletedAt"] = record["updatedAt"]
                elif operation == "restore":
                    if not previous["deletedAt"]:
                        raise DomainError("record_not_deleted", "Only deleted records can be restored.", 409)
                    record["deletedAt"] = None
                else:
                    raise DomainError("invalid_command", "Unsupported mutation.")
            if authorize_record:
                authorize_record(record)
            if not record["deletedAt"]:
                if record["sourceId"] not in self.meta["manifest"]["scope"]["sourceIds"]:
                    raise DomainError("scope_mismatch", "Record source is outside this workspace's declared source catalog.")
                candidate = {**self.records, record["id"]: record}
                validate_record(record, candidate, self.meta["manifest"]["workspaceId"], configuration=self.meta)
                descendants = [record["id"]]
                while descendants:
                    parent_id = descendants.pop()
                    for child in candidate.values():
                        if child["parentSessionId"] == parent_id:
                            validate_record(child, candidate, self.meta["manifest"]["workspaceId"], configuration=self.meta)
                            descendants.append(child["id"])
            else:
                validate_record(record, workspace=self.meta["manifest"]["workspaceId"], configuration=self.meta)
            meta = normalize_metadata(self.meta)
            meta["manifest"]["revision"] += 1
            meta["manifest"]["snapshotAt"] = now_iso()
            meta["manifest"].pop("contentSha256", None)
            meta["manifest"]["recordCount"] = len(self.records) + (1 if operation == "create" else 0)
            result = {"record": record, "durability": "server-committed", "generation": meta["manifest"]["generation"],
                      "revision": meta["manifest"]["revision"]}
            outcome = {"clientCommandId": command_id, "actorId": principal, "requestHash": request_hash, "result": result}
            after = {f"records/{record['id']}.json": record, "workspace.json": meta,
                     str(outcome_path.relative_to(self.root)).replace("\\", "/"): outcome}
            try:
                self._commit_files(after)
            except OSError as error:
                raise DomainError("commit_outcome_unknown", "Commit outcome requires recovery; use the same command key for outcome lookup after restart.", 503) from error
            self.records[record["id"]] = record
            self.meta = meta
            return copy.deepcopy(result)

    def mutate_batch(self, payload, generation, command_id, principal, *, request_route, authorize_record):
        from ..models.record_batch import prepare_batch
        if not generation or not command_id:
            raise DomainError("precondition_required", "Batch requires workspace generation and idempotency key.", 428)
        with self.mutex:
            self._ensure_available()
            if generation != self.meta["manifest"]["generation"]:
                raise DomainError("generation_conflict", "Workspace generation has changed.", 409)
            path = self._outcome_path(principal, command_id)
            fingerprint = hashlib.sha256(json_bytes({"operation": "batch", "payload": payload, "generation": generation,
                                                      "route": request_route})).hexdigest()
            outcome = self._read_target(path.relative_to(self.root).as_posix())
            if outcome is not None:
                if outcome["requestHash"] != fingerprint:
                    raise DomainError("idempotency_conflict", "This command key was used for a different request.", 409)
                for item in outcome["result"]["items"]:
                    authorize_record(payload["operations"][item["index"]]["type"], item["record"])
                return copy.deepcopy(outcome["result"])
            if self.meta["manifest"]["revision"] >= MAX_SAFE_INT:
                raise DomainError("revision_capacity", "Workspace revision capacity reached.", 413)
            candidate, changed = prepare_batch(self.records, self.meta, payload, principal, authorize_record)
            meta = normalize_metadata(self.meta)
            meta["manifest"].update(revision=meta["manifest"]["revision"] + 1, snapshotAt=now_iso(), recordCount=len(candidate))
            meta["manifest"].pop("contentSha256", None)
            result = {"status": "committed", "commandId": command_id, "generation": generation,
                      "revision": meta["manifest"]["revision"], "affectedCount": len(changed),
                      "items": changed, "durability": "server-committed"}
            outcome = {"clientCommandId": command_id, "actorId": principal, "requestHash": fingerprint, "result": result}
            after = {f'records/{item["record"]["id"]}.json': item["record"] for item in changed}
            after.update({"workspace.json": meta, path.relative_to(self.root).as_posix(): outcome})
            try:
                self._commit_files(after)
            except OSError as error:
                raise DomainError("commit_outcome_unknown", "Batch outcome requires original-key recovery after restart.", 503) from error
            self.records, self.meta = candidate, meta
            return copy.deepcopy(result)
