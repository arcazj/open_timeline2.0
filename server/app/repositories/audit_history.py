"""Metadata-only revision chain included in the workspace's existing transaction."""
from __future__ import annotations

import copy
import hashlib
import re

from ..models.domain import DomainError, MAX_SAFE_INT, instant_ms, json_bytes, valid_id, validate_json

AUDIT_ENTRY_BYTES = 1024 * 1024
_HASH = re.compile(r"[a-f0-9]{64}")
_STATE_KEYS = {"format", "formatVersion", "workspaceId", "generation", "firstRevision", "lastRevision", "entryCount", "lastHash"}
_ENTRY_KEYS = {"format", "formatVersion", "workspaceId", "generation", "revision", "timestamp", "actorId", "commandId", "family",
               "records", "visibility", "ownerId", "previousHash", "transition", "sha256"}


def audit_hash(entry):
    return hashlib.sha256(json_bytes({key: value for key, value in entry.items() if key != "sha256"})).hexdigest()


def audit_path(revision):
    return f"audit/{revision:016d}.json"


def _entry(manifest, state, *, actor, command_id, family, records, visibility="workspace", owner_id=None, transition=None):
    entry = {"format": "timeline-audit-entry", "formatVersion": 1, "workspaceId": manifest["workspaceId"],
             "generation": manifest["generation"], "revision": manifest["revision"], "timestamp": manifest["snapshotAt"],
             "actorId": actor, "commandId": command_id, "family": family, "records": records, "visibility": visibility,
             "ownerId": owner_id, "previousHash": state["lastHash"] if state else None, "transition": transition}
    entry["sha256"] = audit_hash(entry)
    updated = {"format": "timeline-audit-state", "formatVersion": 1, "workspaceId": manifest["workspaceId"],
               "generation": manifest["generation"], "firstRevision": state["firstRevision"] if state else manifest["revision"],
               "lastRevision": manifest["revision"], "entryCount": state["entryCount"] + 1 if state else 1, "lastHash": entry["sha256"]}
    validate_json(entry)
    if len(json_bytes(entry)) > AUDIT_ENTRY_BYTES:
        raise DomainError("audit_capacity", "Audit metadata exceeds its entry byte limit.", 413)
    return {"audit-state.json": updated, audit_path(entry["revision"]): entry}


def prepare_audit(state, previous_manifest, manifest, outcome):
    if manifest["revision"] != previous_manifest["revision"] + 1 or manifest["generation"] != previous_manifest["generation"]:
        raise DomainError("audit_integrity", "Audit append requires one workspace revision in the same generation.", 503)
    if state and (state["lastRevision"] != previous_manifest["revision"] or state["generation"] != previous_manifest["generation"]):
        raise DomainError("audit_integrity", "Audit history does not reach the previous workspace revision.", 503)
    result, authorization = outcome["result"], outcome.get("authorization", {})
    records = ([result["record"]] if "record" in result else [item["record"] for item in result.get("items", [])])
    descriptors = [{key: record[key] for key in ("id", "version", "sourceId", "kind", "deletedAt")} for record in records]
    family = "records" if records else "models" if "model" in result else result.get("family", "settings")
    return _entry(manifest, state, actor=outcome["actorId"], command_id=outcome["clientCommandId"], family=family, records=descriptors,
                  visibility="personal" if authorization.get("scope") == "personal" else authorization.get("visibility", "workspace"),
                  owner_id=authorization.get("ownerId"))


def prepare_restore_audit(state, previous_manifest, manifest, backup_sha256):
    if (manifest["revision"] != previous_manifest["revision"] + 1 or manifest["generation"] == previous_manifest["generation"]
            or not isinstance(backup_sha256, str) or not _HASH.fullmatch(backup_sha256)):
        raise DomainError("audit_integrity", "Restore audit requires a fresh generation, one revision and a verified backup hash.", 503)
    if state and (state["lastRevision"] != previous_manifest["revision"] or state["generation"] != previous_manifest["generation"]):
        raise DomainError("audit_integrity", "Restore source audit does not match its workspace.", 503)
    return _entry(manifest, state, actor=None, command_id=None, family="workspace.restore", records=[],
                  transition={"fromGeneration": previous_manifest["generation"], "backupSha256": backup_sha256})


def validate_audit_history(state, documents, manifest):
    if state is None:
        if documents:
            raise DomainError("audit_integrity", "Audit entries require a complete audit state.", 503)
        return
    validate_json(state)
    if not isinstance(state, dict) or set(state) != _STATE_KEYS or state["format"] != "timeline-audit-state" or type(state["formatVersion"]) is not int or state["formatVersion"] != 1:
        raise DomainError("audit_integrity", "Audit state is malformed.", 503)
    for key in ("firstRevision", "lastRevision", "entryCount"):
        if type(state[key]) is not int or not 1 <= state[key] <= MAX_SAFE_INT:
            raise DomainError("audit_integrity", "Audit state has invalid sequence values.", 503)
    if (state["workspaceId"] != manifest["workspaceId"] or state["generation"] != manifest["generation"]
            or state["lastRevision"] != manifest["revision"] or state["entryCount"] != state["lastRevision"] - state["firstRevision"] + 1
            or state["entryCount"] != len(documents)):
        raise DomainError("audit_integrity", "Audit sequence does not match the workspace.", 503)
    previous_hash, previous_generation = None, None
    for revision in range(state["firstRevision"], state["lastRevision"] + 1):
        entry = documents.get(audit_path(revision))
        validate_json(entry)
        if not isinstance(entry, dict) or set(entry) != _ENTRY_KEYS:
            raise DomainError("audit_integrity", "Audit entry is missing or malformed.", 503)
        if (entry["format"] != "timeline-audit-entry" or type(entry["formatVersion"]) is not int or entry["formatVersion"] != 1
                or entry["revision"] != revision or type(entry["revision"]) is not int or entry["workspaceId"] != manifest["workspaceId"]
                or entry["previousHash"] != previous_hash or entry["sha256"] != audit_hash(entry)):
            raise DomainError("audit_integrity", "Audit entry sequence or checksum is invalid.", 503)
        valid_id(entry["generation"])
        instant_ms(entry["timestamp"])
        if entry["family"] not in ("records", "models", "sources", "groups", "schemas", "filters", "views", "settings", "workspace.restore"):
            raise DomainError("audit_integrity", "Audit change family is invalid.", 503)
        if entry["visibility"] not in ("workspace", "personal") or (entry["visibility"] == "personal" and not entry["ownerId"]):
            raise DomainError("audit_integrity", "Audit visibility is invalid.", 503)
        for field in ("actorId", "commandId", "ownerId"):
            value = entry[field]
            if value is not None and (not isinstance(value, str) or not 1 <= len(value) <= 128):
                raise DomainError("audit_integrity", "Audit identity metadata is invalid.", 503)
        if not isinstance(entry["records"], list) or len(entry["records"]) > 500:
            raise DomainError("audit_integrity", "Audit record descriptors exceed their limit.", 503)
        seen = set()
        for record in entry["records"]:
            if not isinstance(record, dict) or set(record) != {"id", "version", "sourceId", "kind", "deletedAt"}:
                raise DomainError("audit_integrity", "Audit record descriptor is invalid.", 503)
            valid_id(record["id"])
            if (record["id"] in seen or type(record["version"]) is not int or not 1 <= record["version"] <= MAX_SAFE_INT
                    or record["kind"] not in ("event", "session") or not isinstance(record["sourceId"], str) or not 1 <= len(record["sourceId"]) <= 128):
                raise DomainError("audit_integrity", "Audit record descriptor values are invalid.", 503)
            seen.add(record["id"])
            if record["deletedAt"] is not None:
                instant_ms(record["deletedAt"])
        transition = entry["transition"]
        if entry["family"] == "workspace.restore":
            if (not isinstance(transition, dict) or set(transition) != {"fromGeneration", "backupSha256"}
                    or not isinstance(transition["backupSha256"], str) or not _HASH.fullmatch(transition["backupSha256"])
                    or entry["generation"] == transition["fromGeneration"] or entry["records"]
                    or (previous_generation is not None and previous_generation != transition["fromGeneration"])):
                raise DomainError("audit_integrity", "Audit restore transition is invalid.", 503)
            valid_id(transition["fromGeneration"])
        elif transition is not None or (previous_generation is not None and entry["generation"] != previous_generation):
            raise DomainError("audit_integrity", "Audit generation changed without a restore transition.", 503)
        previous_hash, previous_generation = entry["sha256"], entry["generation"]
    if state["lastHash"] != previous_hash or state["generation"] != previous_generation:
        raise DomainError("audit_integrity", "Audit terminal identity is invalid.", 503)
    return copy.deepcopy(state)
