"""Complete ordinary-JSON archives and non-destructive, inactive-root restoration."""
from __future__ import annotations

import copy
import hashlib
import os
import re
import shutil
import stat
import uuid
from contextlib import contextmanager
from pathlib import Path

import portalocker

from ..models.domain import DomainError, MAX_SAFE_INT, instant_ms, json_bytes, now_iso, parse_json, validate_json, validate_snapshot
from ..repositories.audit_history import AUDIT_ENTRY_BYTES, prepare_restore_audit, validate_audit_history
from ..repositories.json_repository import JsonRepository, atomic_json, sync_directory
from ..repositories.json_shards import manifest_checksum
from .identity import IdentityStore, _checksum as identity_checksum

MAX_FILES = 250_000
MAX_TOTAL_BYTES = 4 * 1024**3
MAX_METADATA_BYTES = 32 * 1024**2
SPACE_RESERVE = 32 * 1024**2
MANIFEST_NAME = "backup-manifest.json"
PROVENANCE_NAME = "restore-provenance.json"
MARKER_NAME = "migration-incomplete.json"
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_FILE = re.compile(r"(?:workspace\.json|storage-layout\.json|restore-provenance\.json|audit-state\.json|audit/[0-9]{16}\.json|control/identities\.json|records/" + _UUID + r"\.json|outcomes/[0-9a-f]{64}\.json|shards/[0-9a-f]{1,32}\.json)")


def _fail(message, code="backup_integrity", status=503):
    raise DomainError(code, message, status)


def _checksum(document):
    return hashlib.sha256(json_bytes({key: value for key, value in document.items() if key != "checksum"})).hexdigest()


def _uuid(value):
    if not isinstance(value, str) or not re.fullmatch(_UUID, value):
        _fail("Expected a canonical UUID.")
    return value


def _plain(path, directory=False):
    value = path.lstat()
    expected = stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)
    if not expected or getattr(value, "st_file_attributes", 0) & 0x400:
        _fail("Backup paths must not contain links, reparse points, or special files.")
    return value


def _absolute(path):
    path = Path(os.path.abspath(path))
    for parent in reversed((path, *path.parents)):
        if parent.exists() or parent.is_symlink():
            _plain(parent, directory=True)
    return path


def _separate(source, destination):
    source, destination = _absolute(source), _absolute(destination)
    _plain(source, directory=True)
    if source == destination or source.is_relative_to(destination) or destination.is_relative_to(source):
        _fail("Source and destination must be separate, non-nested roots.", "backup_path_conflict", 409)
    if destination.exists():
        _fail("The destination must not exist; backup and restore never overwrite roots.", "backup_destination_exists", 409)
    _plain(destination.parent, directory=True)
    return source, destination


def _limit(relative):
    if relative.startswith("audit/") or relative == "audit-state.json":
        return AUDIT_ENTRY_BYTES
    if relative.startswith("records/"):
        return 1024**2
    if relative.startswith("shards/") or relative == "storage-layout.json":
        return 4 * 1024**2
    return MAX_METADATA_BYTES


def _read_raw(path, limit):
    _absolute(path.parent)
    first = _plain(path)
    if first.st_size > limit:
        _fail("JSON file exceeds backup byte admission.", "backup_capacity", 413)

    def identity(value):
        return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns

    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if identity(first) != identity(before):
            _fail("File changed while opening for backup.")
        raw = stream.read(before.st_size + 1)
        after, last = os.fstat(stream.fileno()), _plain(path)
    _absolute(path.parent)
    if (len(raw) != before.st_size or identity(before) != identity(after) or identity(after) != identity(last)
            or first.st_ctime_ns != last.st_ctime_ns or before.st_ctime_ns != after.st_ctime_ns):
        _fail("File changed during backup read.")
    return raw


def _read_json(path, limit=MAX_METADATA_BYTES):
    return parse_json(_read_raw(path, limit))


def _write_raw(path, raw):
    _absolute(path.parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    _absolute(path.parent)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def _inventory(root, archive=False, staging=False):
    _plain(root, directory=True)
    allowed = {"workspace.json", "records", "shards", "storage-layout.json", "outcomes", "control", "audit", "audit-state.json", PROVENANCE_NAME, ".writer.lock"}
    if archive:
        allowed |= {MANIFEST_NAME, MARKER_NAME, ".backup.lock"}
    elif staging:
        allowed.add(MARKER_NAME)
    names = set()
    for path in root.iterdir():
        if path.name == "transaction.json":
            _fail("Reconcile pending transactions with the ordinary owner before backup.", "backup_recovery_required", 409)
        if path.name not in allowed:
            _fail("Unrecognized root authority cannot be silently omitted from a backup.")
        names.add(path.name)
    required = {"workspace.json", "control"}
    if archive:
        required |= {MANIFEST_NAME, MARKER_NAME}
    if not required <= names:
        _fail("A complete root requires workspace metadata and identity control state.")
    if ("storage-layout.json" in names) != ("shards" in names) or ("storage-layout.json" in names and "records" in names):
        _fail("Storage layout is incomplete or ambiguous.")
    paths = []
    for name in sorted(names):
        path = root / name
        if name in {"records", "shards", "outcomes", "control", "audit"}:
            _plain(path, directory=True)
            for child in path.iterdir():
                _plain(child)
                relative = name + "/" + child.name
                if relative == "control/.identities.lock":
                    continue
                if not _FILE.fullmatch(relative):
                    _fail("Unrecognized or unsafe JSON member in backup inventory.")
                paths.append(relative)
                if len(paths) > MAX_FILES:
                    _fail("Backup file count exceeds capacity.", "backup_capacity", 413)
        else:
            _plain(path)
            if _FILE.fullmatch(name):
                paths.append(name)
    if "control/identities.json" not in paths or len(paths) > MAX_FILES:
        _fail("Identity metadata is missing or file capacity exceeded.", "backup_capacity", 413)
    return sorted(paths)


def _entry(relative, raw):
    return {"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _verify_entries(root, entries):
    for entry in entries:
        if _entry(entry["path"], _read_raw(root / entry["path"], _limit(entry["path"]))) != entry:
            _fail("JSON member changed from its admitted hash or byte count.")


def _capacity(total, destination):
    if total > MAX_TOTAL_BYTES:
        _fail("Complete root exceeds aggregate backup capacity.", "backup_capacity", 413)
    if shutil.disk_usage(destination.parent).free < total + SPACE_RESERVE:
        _fail("Insufficient disk space for complete backup plus reserve.", "backup_disk_capacity", 413)


def _notify(progress, cancelled, phase, completed, total):
    if cancelled is not None and cancelled():
        _fail("Backup operation cancelled; incomplete destination was retained.", "backup_cancelled", 409)
    if progress is not None:
        progress({"phase": phase, "completedFiles": completed, "totalFiles": total})


def validate_provenance(document):
    validate_json(document)
    if (not isinstance(document, dict) or set(document) != {"format", "formatVersion", "restores", "checksum"}
            or document["format"] != "openbexi-restore-provenance" or type(document["formatVersion"]) is not int
            or document["formatVersion"] != 1 or document["checksum"] != _checksum(document)
            or not isinstance(document["restores"], list) or not 1 <= len(document["restores"]) <= 100_000):
        _fail("Invalid restore provenance.")
    previous = None
    for value in document["restores"]:
        if not isinstance(value, dict) or set(value) != {"backupId", "backupChecksum", "at", "reason", "workspaceId", "previousWorkspaceGeneration", "workspaceGeneration", "previousWorkspaceRevision", "workspaceRevision", "previousIdentityGeneration", "identityGeneration", "previousIdentityRevision", "identityRevision"}:
            _fail("Invalid restore provenance entry.")
        for key in ("backupId", "previousWorkspaceGeneration", "workspaceGeneration", "previousIdentityGeneration", "identityGeneration"):
            _uuid(value[key])
        if not isinstance(value["workspaceId"], str) or not 1 <= len(value["workspaceId"]) <= 100:
            _fail("Invalid restore workspace identity.")
        for key in ("previousWorkspaceRevision", "workspaceRevision", "previousIdentityRevision", "identityRevision"):
            if type(value[key]) is not int or not 1 <= value[key] <= MAX_SAFE_INT:
                _fail("Invalid restore provenance revision.")
        if (not isinstance(value["reason"], str) or not value["reason"].strip() or len(value["reason"]) > 500
                or not isinstance(value["backupChecksum"], str) or not re.fullmatch("[0-9a-f]{64}", value["backupChecksum"])
                or value["workspaceGeneration"] == value["previousWorkspaceGeneration"]
                or value["identityGeneration"] == value["previousIdentityGeneration"]
                or value["workspaceRevision"] != value["previousWorkspaceRevision"] + 1
                or value["identityRevision"] != value["previousIdentityRevision"] + 1):
            _fail("Invalid restore provenance transition.")
        if previous is not None and (value["previousWorkspaceGeneration"] != previous["workspaceGeneration"]
                                     or value["workspaceId"] != previous["workspaceId"]):
            _fail("Broken restore provenance chain.")
        instant_ms(value["at"])
        previous = value


def _validate_outcome(relative, document, manifest):
    validate_json(document)
    required = {"clientCommandId", "actorId", "requestHash", "result"}
    if not isinstance(document, dict) or not required <= set(document) or set(document) - required - {"authorization"}:
        _fail("Invalid command outcome envelope.")
    actor, key, result = document["actorId"], document["clientCommandId"], document["result"]
    if (not isinstance(actor, str) or not actor or len(actor) > 128 or not isinstance(key, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) or not isinstance(document["requestHash"], str)
            or not re.fullmatch("[0-9a-f]{64}", document["requestHash"])):
        _fail("Invalid command outcome identity.")
    expected = hashlib.sha256((actor + "\0" + key).encode()).hexdigest()
    if relative != f"outcomes/{expected}.json" or not isinstance(result, dict):
        _fail("Command outcome filename does not match its identity.")
    _uuid(result.get("generation"))
    revision = result.get("revision")
    if type(revision) is not int or not 1 <= revision <= MAX_SAFE_INT or (result["generation"] == manifest["generation"] and revision > manifest["revision"]):
        _fail("Command outcome revision exceeds its workspace.")
    if "authorization" in document and not isinstance(document["authorization"], dict):
        _fail("Invalid command authorization metadata.")


def _validate_root(root, paths):
    repository = JsonRepository(root, root / "not-a-seed.json")
    repository.meta = _read_json(root / "workspace.json")
    repository.records = repository._load_records()
    validate_snapshot({**repository.meta, "records": list(repository.records.values())})
    state = _read_json(root / "control/identities.json")
    IdentityStore(root / "control", None)._validate(state)
    audit_state = _read_json(root / "audit-state.json", AUDIT_ENTRY_BYTES) if "audit-state.json" in paths else None
    audit_documents = {relative: _read_json(root / relative, AUDIT_ENTRY_BYTES) for relative in paths if relative.startswith("audit/")}
    validate_audit_history(audit_state, audit_documents, repository.meta["manifest"])
    repository.audit_state = audit_state
    repository.restore_provenance = None
    for relative in paths:
        if relative.startswith("outcomes/"):
            _validate_outcome(relative, _read_json(root / relative), repository.meta["manifest"])
    if PROVENANCE_NAME in paths:
        provenance = _read_json(root / PROVENANCE_NAME)
        validate_provenance(provenance)
        last = provenance["restores"][-1]
        if last["workspaceGeneration"] != repository.meta["manifest"]["generation"] or last["workspaceId"] != repository.meta["manifest"]["workspaceId"]:
            _fail("Restore provenance does not belong to the current workspace generation.")
        repository.restore_provenance = provenance
    return repository, state


def _summary(repository, state):
    manifest = repository.meta["manifest"]
    deleted = sum(record["deletedAt"] is not None for record in repository.records.values())
    return {"storageLayoutVersion": 2 if repository.layout is not None else 1,
            "workspace": {"id": manifest["workspaceId"], "generation": manifest["generation"], "revision": manifest["revision"],
                          "recordCount": len(repository.records), "activeRecordCount": len(repository.records) - deleted, "tombstoneCount": deleted},
            "identity": {"generation": state["generation"], "revision": state["revision"], "principalCount": len(state["principals"]), "tokenCount": len(state["tokens"])}}


def _validate_manifest(document):
    validate_json(document)
    fields = {"format", "formatVersion", "backupId", "createdAt", "createdBy", "captureMode", "complete", "storageLayoutVersion", "workspace", "identity", "files", "fileCount", "totalBytes", "checksum"}
    if (not isinstance(document, dict) or set(document) != fields or document["format"] != "openbexi-root-backup"
            or type(document["formatVersion"]) is not int or document["formatVersion"] != 1 or document["complete"] is not True
            or document["captureMode"] not in ("live", "offline") or document["checksum"] != _checksum(document)):
        _fail("Invalid or incomplete backup manifest.")
    _uuid(document["backupId"])
    if document["createdBy"] != "offline-operator":
        _uuid(document["createdBy"])
    instant_ms(document["createdAt"])
    if type(document["storageLayoutVersion"]) is not int or document["storageLayoutVersion"] not in (1, 2):
        _fail("Invalid backup storage layout version.")
    for key, fields, id_fields in (
        ("workspace", {"id", "generation", "revision", "recordCount", "activeRecordCount", "tombstoneCount"}, {"generation"}),
        ("identity", {"generation", "revision", "principalCount", "tokenCount"}, {"generation"}),
    ):
        value = document[key]
        if not isinstance(value, dict) or set(value) != fields:
            _fail("Invalid backup summary shape.")
        for field in id_fields:
            _uuid(value[field])
        if key == "workspace" and (not isinstance(value["id"], str) or not 1 <= len(value["id"]) <= 100):
            _fail("Invalid backup workspace identity.")
        for field in fields - id_fields - {"id"}:
            if type(value[field]) is not int or not (1 if field == "revision" else 0) <= value[field] <= MAX_SAFE_INT:
                _fail("Invalid backup summary count or revision.")
    files = document["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        _fail("Backup file count exceeds capacity.", "backup_capacity", 413)
    previous, total = "", 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            _fail("Invalid backup member.")
        relative = entry["path"]
        if not isinstance(relative, str) or not _FILE.fullmatch(relative) or relative <= previous:
            _fail("Unsafe, duplicate, or unsorted backup member path.")
        if type(entry["bytes"]) is not int or not 1 <= entry["bytes"] <= _limit(relative):
            _fail("Backup member size exceeds admission.", "backup_capacity", 413)
        if not isinstance(entry["sha256"], str) or not re.fullmatch("[0-9a-f]{64}", entry["sha256"]):
            _fail("Invalid backup member checksum.")
        previous, total = relative, total + entry["bytes"]
    if (type(document["fileCount"]) is not int or document["fileCount"] != len(files)
            or type(document["totalBytes"]) is not int or document["totalBytes"] != total or total > MAX_TOTAL_BYTES):
        _fail("Backup aggregate size/count is invalid.", "backup_capacity", 413)
    return document


@contextmanager
def _staging_destination(destination, marker):
    _absolute(destination.parent)
    destination.mkdir(exist_ok=False)
    owner = portalocker.Lock(str(destination / ".writer.lock"), mode="a+b", timeout=0,
                             flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
    try:
        owner.acquire()
        atomic_json(destination / MARKER_NAME, marker)
        yield
    finally:
        owner.release()


def _capture(repository, identities, destination, creator, mode, progress, cancelled, request_identity=None):
    source, destination = _separate(repository.root, destination)
    repository._ensure_available()
    identities.check_integrity()
    if _absolute(identities.root) != source / "control":
        _fail("Identity owner does not belong to the captured workspace root.")
    paths = _inventory(source)
    total = sum(_plain(source / relative).st_size for relative in paths)
    _capacity(total, destination)
    with _staging_destination(destination, {"formatVersion": 1, "phase": "backup-staging"}):
        return _capture_members(repository, identities, source, destination, paths, creator, mode, progress, cancelled, request_identity)


def _capture_members(repository, identities, source, destination, paths, creator, mode, progress, cancelled, request_identity):
    entries = []
    copied_bytes = 0
    for index, relative in enumerate(paths):
        _notify(progress, cancelled, "copy", index, len(paths))
        try:
            raw = _read_raw(source / relative, _limit(relative))
            parse_json(raw)
        except (DomainError, OSError):
            repository.available = False
            raise
        copied_bytes += len(raw)
        if copied_bytes > MAX_TOTAL_BYTES:
            _fail("Source growth exceeded complete backup capacity.", "backup_capacity", 413)
        _write_raw(destination / relative, raw)
        entries.append(_entry(relative, raw))
    _notify(progress, cancelled, "validate", len(paths), len(paths))
    try:
        staged, state = _validate_root(destination, paths)
    except (DomainError, OSError, RuntimeError):
        repository.available = False
        raise
    if (staged.meta != repository.meta or staged.records != repository.records or staged.layout != repository.layout or state != identities.state
            or staged.audit_state != getattr(repository, "audit_state", None)
            or staged.restore_provenance != getattr(repository, "restore_provenance", None)):
        repository.available = False
        _fail("Disk authority differs from the owner's admitted state; workspace frozen.", "external_change")
    if _inventory(source) != paths:
        repository.available = False
        _fail("Source inventory changed during backup.", "external_change")
    try:
        _verify_entries(source, entries)
    except (DomainError, OSError):
        repository.available = False
        _fail("Source bytes changed during backup.", "external_change")
    identities.check_integrity()
    _verify_entries(destination, entries)
    manifest = {"format": "openbexi-root-backup", "formatVersion": 1, "backupId": str(uuid.uuid4()), "createdAt": now_iso(),
                "createdBy": creator, "captureMode": mode, "complete": True, **_summary(staged, state),
                "files": entries, "fileCount": len(entries), "totalBytes": sum(entry["bytes"] for entry in entries)}
    manifest["checksum"] = _checksum(manifest)
    _validate_manifest(manifest)
    if len(json_bytes(manifest)) > MAX_METADATA_BYTES:
        _fail("Backup manifest exceeds 32 MiB.", "backup_capacity", 413)
    _notify(progress, cancelled, "publish", len(paths), len(paths))
    if request_identity is not None:
        identities._admin(request_identity)
    atomic_json(destination / MARKER_NAME, {"formatVersion": 1, "phase": "backup-archive", "backupId": manifest["backupId"]})
    atomic_json(destination / MANIFEST_NAME, manifest)
    return manifest


def create_live_backup(repository, identities, identity, destination, *, progress=None, cancelled=None):
    """The caller supplies a configured destination, never an untrusted HTTP path."""
    with identities.mutex, repository.mutex:
        identities._current(identity)
        identities._admin(identity)
        return _capture(repository, identities, destination, identity["id"], "live", progress, cancelled, identity)


class _InactiveSource(JsonRepository):
    def _recover(self):
        if (self.root / "transaction.json").exists():
            _fail("Offline backup never repairs a pending transaction.", "backup_recovery_required", 409)

    def _seed(self):
        _fail("Offline backup cannot seed a missing source.")


def create_offline_backup(source, destination, *, progress=None, cancelled=None):
    source, destination = _separate(source, destination)
    _inventory(source)
    identities, repository = IdentityStore(source / "control", None), _InactiveSource(source, source / "not-a-seed.json")
    try:
        identities.open()
        repository.open()
        with identities.mutex, repository.mutex:
            return _capture(repository, identities, destination, "offline-operator", "offline", progress, cancelled)
    except portalocker.exceptions.LockException:
        _fail("The source root has an active identity or workspace owner.", "backup_source_active", 409)
    finally:
        repository.close()
        identities.close()


@contextmanager
def _archive_owner(source):
    source = _absolute(source)
    _plain(source, directory=True)
    lock_path = source / ".backup.lock"
    if lock_path.exists() or lock_path.is_symlink():
        _plain(lock_path)
    owner = portalocker.Lock(str(lock_path), mode="a+b", timeout=0, flags=portalocker.LOCK_EX | portalocker.LOCK_NB)
    try:
        try:
            owner.acquire()
        except portalocker.exceptions.LockException:
            _fail("The backup is already being verified or restored.", "backup_busy", 409)
        yield source
    finally:
        owner.release()


def _verify_archive(source, progress=None, cancelled=None):
    paths = _inventory(source, archive=True)
    manifest = _validate_manifest(_read_json(source / MANIFEST_NAME))
    marker = _read_json(source / MARKER_NAME)
    if marker != {"formatVersion": 1, "phase": "backup-archive", "backupId": manifest["backupId"]}:
        _fail("Archive was not completely published.")
    if paths != [entry["path"] for entry in manifest["files"]]:
        _fail("Backup member inventory is incomplete or contains extra files.")
    for index, entry in enumerate(manifest["files"]):
        _notify(progress, cancelled, "verify", index, len(paths))
        if _entry(entry["path"], _read_raw(source / entry["path"], _limit(entry["path"]))) != entry:
            _fail("Backup member hash or byte count differs from its manifest.")
    repository, state = _validate_root(source, paths)
    if any(manifest[key] != value for key, value in _summary(repository, state).items()):
        _fail("Backup semantic counts/generations do not match its manifest.")
    _verify_entries(source, manifest["files"])
    if _read_json(source / MANIFEST_NAME) != manifest or _inventory(source, archive=True) != paths:
        _fail("Archive changed during semantic verification.")
    return manifest, repository, state


def verify_backup(source, *, progress=None, cancelled=None):
    with _archive_owner(source) as source:
        manifest, _, _ = _verify_archive(source, progress, cancelled)
        return manifest


def _restore_identity(state, backup_id, stamp):
    candidate = copy.deepcopy(state)
    if candidate["revision"] >= MAX_SAFE_INT:
        _fail("Identity revision capacity prevents restoration.", "identity_capacity", 413)
    previous_generation = candidate["generation"]
    candidate.update(formatVersion=2, generation=str(uuid.uuid4()), revision=candidate["revision"] + 1)
    candidate.setdefault("commands", [])
    candidate.setdefault("recoveryHistory", [])
    principal = min(value["id"] for value in candidate["principals"] if value["enabled"] and value["role"] == "admin")
    for token in candidate["tokens"]:
        if token["revokedAt"] is None:
            if token["revision"] >= MAX_SAFE_INT:
                _fail("Token revision capacity prevents restoration.", "identity_capacity", 413)
            token.update(revokedAt=stamp, revision=token["revision"] + 1)
    candidate["audit"].append({"revision": candidate["revision"], "at": stamp, "actorId": principal,
                               "action": "identity.recover", "targetId": principal, "generation": candidate["generation"]})
    candidate["recoveryHistory"].append({"previousGeneration": previous_generation, "generation": candidate["generation"],
                                         "at": stamp, "revision": candidate["revision"], "principalId": principal,
                                         "reason": f"Inactive restore of backup {backup_id}; all old tokens revoked; fresh local recovery required."})
    candidate["checksum"] = identity_checksum(candidate)
    return candidate


def restore_backup(source, destination, *, reason, progress=None, cancelled=None):
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
        _fail("Restore requires a nonempty operator reason of at most 500 characters.", "invalid_restore", 422)
    validate_json(reason)
    source, destination = _separate(source, destination)
    with _archive_owner(source):
        manifest, original, original_identity = _verify_archive(source, progress, cancelled)
        _capacity(manifest["totalBytes"], destination)
        if original.meta["manifest"]["revision"] >= MAX_SAFE_INT:
            _fail("Workspace revision capacity prevents restoration.", "revision_capacity", 413)
        stamp = now_iso()
        metadata = copy.deepcopy(original.meta)
        metadata["manifest"].update(generation=str(uuid.uuid4()), revision=metadata["manifest"]["revision"] + 1,
                                    bundleId=str(uuid.uuid4()), snapshotAt=stamp)
        metadata["manifest"].pop("contentSha256", None)
        identity = _restore_identity(original_identity, manifest["backupId"], stamp)
        IdentityStore(destination / "control", None)._validate(identity)
        audit_updates = prepare_restore_audit(original.audit_state, original.meta["manifest"], metadata["manifest"], manifest["checksum"])
        provenance = (_read_json(source / PROVENANCE_NAME) if (source / PROVENANCE_NAME).exists()
                      else {"format": "openbexi-restore-provenance", "formatVersion": 1, "restores": []})
        provenance["restores"].append({"backupId": manifest["backupId"], "backupChecksum": manifest["checksum"], "at": stamp, "reason": reason,
                                        "workspaceId": metadata["manifest"]["workspaceId"],
                                        "previousWorkspaceGeneration": original.meta["manifest"]["generation"], "workspaceGeneration": metadata["manifest"]["generation"],
                                        "previousWorkspaceRevision": original.meta["manifest"]["revision"], "workspaceRevision": metadata["manifest"]["revision"],
                                        "previousIdentityGeneration": original_identity["generation"], "identityGeneration": identity["generation"],
                                        "previousIdentityRevision": original_identity["revision"], "identityRevision": identity["revision"]})
        provenance["checksum"] = _checksum(provenance)
        validate_provenance(provenance)
        if len(json_bytes(provenance)) > MAX_METADATA_BYTES:
            _fail("Restore history exceeds admission; history was not truncated.", "backup_capacity", 413)
        replacements = {"workspace.json": metadata, "control/identities.json": identity, PROVENANCE_NAME: provenance, **audit_updates}
        if original.layout is not None:
            layout = copy.deepcopy(original.layout)
            layout.update(generation=metadata["manifest"]["generation"], revision=metadata["manifest"]["revision"])
            layout["checksum"] = manifest_checksum(layout)
            replacements["storage-layout.json"] = layout
        expected = {entry["path"]: entry for entry in manifest["files"]}
        for relative, document in replacements.items():
            validate_json(document)
            raw = json_bytes(document)
            if len(raw) > _limit(relative):
                _fail("Transformed restore metadata exceeds byte admission.", "backup_capacity", 413)
            expected[relative] = _entry(relative, raw)
        if len(expected) > MAX_FILES:
            _fail("Restored history exceeds complete file capacity.", "backup_capacity", 413)
        _capacity(sum(entry["bytes"] for entry in expected.values()), destination)
        with _staging_destination(destination, {"formatVersion": 1, "phase": "restore-staging", "backupId": manifest["backupId"]}):
            for index, entry in enumerate(manifest["files"]):
                _notify(progress, cancelled, "restore", index, len(manifest["files"]))
                raw = _read_raw(source / entry["path"], _limit(entry["path"]))
                if _entry(entry["path"], raw) != entry:
                    _fail("Archive changed during restoration.")
                _write_raw(destination / entry["path"], raw)
            for relative, document in replacements.items():
                atomic_json(destination / relative, document)
            paths = _inventory(destination, staging=True)
            _notify(progress, cancelled, "validate-restored", len(paths), len(paths))
            staged, staged_identity = _validate_root(destination, paths)
            if staged.meta != metadata or staged.records != original.records or staged_identity != identity:
                _fail("Restored authority differs from the validated source and planned transformation.")
            if paths != sorted(expected):
                _fail("Restored inventory differs from the complete planned inventory.")
            _verify_entries(destination, expected.values())
            _verify_entries(source, manifest["files"])
            if _read_json(source / MANIFEST_NAME) != manifest or _inventory(source, archive=True) != [entry["path"] for entry in manifest["files"]]:
                _fail("Archive inventory changed before restore completion.")
            _notify(progress, cancelled, "complete", len(paths), len(paths))
            (destination / MARKER_NAME).unlink()
            sync_directory(destination)
            return {"backupId": manifest["backupId"], "destination": str(destination), **_summary(staged, identity), "activated": False,
                    "credentialsRequired": True, "nextStep": "Keep services stopped. Run recover-identity.py against this destination, then explicitly switch the configured service root; never activate both roots."}
