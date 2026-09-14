"""Prepare a complete candidate without performing I/O or publishing state."""
from __future__ import annotations

import copy

from .domain import DomainError, MAX_SAFE_INT, json_bytes, make_record, now_iso, valid_id, validate_json, validate_record
from .record_commands import patch_record, replacement
from .record_schema import assert_source_writable

BATCH_BYTES = 8 * 1024 * 1024
BATCH_RECORDS = 500


def batch_operations(payload):
    validate_json(payload)
    if len(json_bytes(payload)) > BATCH_BYTES:
        raise DomainError("batch_capacity", "Batch request exceeds 8 MiB.", 413)
    if not isinstance(payload, dict) or set(payload) != {"operations"}:
        raise DomainError("invalid_batch", "Batch body requires only operations.")
    operations = payload["operations"]
    if not isinstance(operations, list) or not 1 <= len(operations) <= BATCH_RECORDS:
        raise DomainError("batch_capacity", "Batch requires 1 to 500 operations.", 413)
    return operations


def prepare_batch(records, configuration, payload, actor, authorize=None):
    operations = batch_operations(payload)
    workspace = configuration["manifest"]["workspaceId"]
    candidate, changed, seen = dict(records), [], set()
    for index, operation in enumerate(operations):
        try:
            if not isinstance(operation, dict) or set(operation) - {"type", "recordId", "expectedVersion", "payload"}:
                raise DomainError("invalid_batch", "Unsupported batch operation fields.")
            kind = operation.get("type")
            if kind not in ("create", "update", "replace", "patch", "delete", "restore"):
                raise DomainError("invalid_command", "Unsupported batch operation.")
            previous = None
            if kind == "create":
                if "recordId" in operation or "expectedVersion" in operation:
                    raise DomainError("immutable_field", "Create IDs and versions are provider-owned.")
            else:
                record_id = valid_id(operation.get("recordId"))
                if record_id in seen:
                    raise DomainError("duplicate_batch_record", "A record may occur only once in a batch.")
                seen.add(record_id)
                previous = records.get(record_id)
                if previous is None:
                    raise DomainError("record_not_found", "Record does not exist.", 404)
                if authorize:
                    authorize(kind, previous)
                expected = operation.get("expectedVersion")
                if isinstance(expected, bool) or not isinstance(expected, int):
                    raise DomainError("precondition_required", "Every existing record requires expectedVersion.", 428)
                if previous["version"] != expected:
                    raise DomainError("version_conflict", "A record changed; refresh before retrying.", 412)
                if previous["version"] >= MAX_SAFE_INT:
                    raise DomainError("revision_capacity", "Record version capacity reached.", 413)
                if previous["deletedAt"] and kind != "restore":
                    raise DomainError("record_deleted", "Record is deleted.", 409)
                assert_source_writable(configuration, previous["sourceId"], kind)
            assigned = copy.deepcopy(operation.get("payload", {}))
            if kind == "patch":
                assigned = patch_record(previous, assigned)
            elif kind == "replace":
                assigned = replacement(assigned)
            if not isinstance(assigned, dict):
                raise DomainError("invalid_record", "Record payload must be an object.")
            if kind in ("delete", "restore"):
                if assigned:
                    raise DomainError("invalid_request", "Delete and restore do not accept record fields.")
                record = copy.deepcopy(previous)
                if kind == "restore" and not previous["deletedAt"]:
                    raise DomainError("record_not_deleted", "Only deleted records can be restored.", 409)
                timestamp = now_iso()
                record.update(version=record["version"] + 1, updatedAt=timestamp, updatedBy=actor,
                              deletedAt=timestamp if kind == "delete" else None)
            else:
                if kind == "create" and "sourceId" not in assigned:
                    sources = configuration["manifest"]["scope"]["sourceIds"]
                    if not sources:
                        raise DomainError("source_unavailable", "Configure a source before creating records.")
                    assigned["sourceId"] = sources[0]
                source_id = assigned.get("sourceId", previous["sourceId"] if previous else None)
                policy = assert_source_writable(configuration, source_id, "create" if previous is None else
                                                "reassign" if source_id != previous["sourceId"] else "update")
                if kind == "create" and "schemaId" not in assigned and "schemaVersion" not in assigned and policy.get("defaultSchema"):
                    assigned.update(schemaId=policy["defaultSchema"]["id"], schemaVersion=policy["defaultSchema"]["version"])
                record = make_record(assigned, actor, workspace, previous)
            if authorize:
                authorize(kind, record)
            validate_record(record, workspace=workspace, configuration=configuration)
            candidate[record["id"]] = record
            changed.append({"index": index, "record": record})
        except DomainError as error:
            error.errors = [{"index": index, "code": error.code, "message": error.message}]
            raise
    changed_ids = {item["record"]["id"]: item["index"] for item in changed}
    # Parent edits can invalidate unchanged descendants, so validate the final graph.
    from .domain import _validate_record_relationships
    for record in candidate.values():
        try:
            _validate_record_relationships(record, candidate, workspace)
        except DomainError as error:
            related = record["id"] if record["id"] in changed_ids else record.get("parentSessionId")
            error.errors = [{"index": changed_ids.get(related), "code": error.code,
                             "message": "The final batch would leave an invalid parent relationship."}]
            raise
    return candidate, changed
