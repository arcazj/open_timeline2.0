"""Bounded record mutation policy around the RFC 6902 implementation."""
from __future__ import annotations

import copy
import re

import jsonpatch
import jsonpointer
import rfc8785

from .domain import DomainError, MUTABLE_FIELDS, validate_json

_UNSAFE = {"__proto__", "prototype", "constructor"}


def mutable_record(record):
    return {key: copy.deepcopy(record[key]) for key in MUTABLE_FIELDS}


def replacement(payload):
    if not isinstance(payload, dict) or set(payload) != MUTABLE_FIELDS:
        raise DomainError("incomplete_replacement", "PUT requires every mutable record field, including originalStart and originalEnd.")
    validate_json(payload)
    return copy.deepcopy(payload)


def _pointer(value):
    if not isinstance(value, str) or not value.startswith("/") or len(value) > 1024 or re.search(r"~(?![01])", value):
        raise DomainError("invalid_patch", "Patch paths must be bounded JSON Pointers.")
    parts = [part.replace("~1", "/").replace("~0", "~") for part in value[1:].split("/")]
    if parts[0] not in MUTABLE_FIELDS or any(part in _UNSAFE for part in parts):
        raise DomainError("immutable_field", "Patch paths must remain within mutable record fields.")


def patch_record(record, operations):
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        raise DomainError("invalid_patch", "JSON Patch requires 1 to 100 operations.")
    validate_json(operations)
    candidate = mutable_record(record)
    for operation in operations:
        if not isinstance(operation, dict):
            raise DomainError("invalid_patch", "Each patch operation must be an object.")
        name = operation.get("op")
        required = {"op", "path"}
        if name in ("add", "replace", "test"):
            required.add("value")
        elif name in ("move", "copy"):
            required.add("from")
        elif name != "remove":
            raise DomainError("invalid_patch", "Unsupported JSON Patch operation.")
        if set(operation) != required:
            raise DomainError("invalid_patch", "Patch operation fields do not match its operation.")
        _pointer(operation["path"])
        if "from" in operation:
            _pointer(operation["from"])
        try:
            # Python equality treats True as 1; JSON Patch equality must not.
            if name == "test":
                actual = jsonpointer.resolve_pointer(candidate, operation["path"])
                if rfc8785.dumps(actual) != rfc8785.dumps(operation["value"]):
                    raise DomainError("patch_test_failed", "JSON Patch test did not match the current value.", 409)
            else:
                candidate = jsonpatch.apply_patch(candidate, [operation], in_place=False)
        except (jsonpatch.JsonPatchException, jsonpointer.JsonPointerException, KeyError, TypeError, ValueError) as error:
            raise DomainError("invalid_patch", "JSON Patch cannot be applied to the current record.") from error
    return replacement(candidate)
