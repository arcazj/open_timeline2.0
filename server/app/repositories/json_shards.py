"""Deterministic authoritative JSON shards; indexes are never another record authority."""
from __future__ import annotations

import hashlib
import re

from ..models.domain import DomainError, MAX_SAFE_INT, json_bytes, valid_id

SHARD_BYTES = 4 * 1024 * 1024
LAYOUT_BYTES = 4 * 1024 * 1024


def checksum(document):
    return hashlib.sha256(json_bytes(document)).hexdigest()


def manifest_checksum(document):
    return checksum({key: value for key, value in document.items() if key != "checksum"})


def shard_document(prefix, records):
    return {"format": "timeline-record-shard", "formatVersion": 1, "prefix": prefix,
            "records": sorted(records, key=lambda record: record["id"])}


def partition(records, prefix):
    sized = [(record, len(json_bytes(record))) for record in records]
    result = {}

    def visit(values, current):
        if not values:
            return
        overhead = len(json_bytes(shard_document(current, [])))
        if overhead + sum(size for _, size in values) + len(values) - 1 <= SHARD_BYTES:
            result[current] = shard_document(current, [record for record, _ in values])
            return
        if len(current) >= 32:
            raise DomainError("shard_capacity", "A canonical record cannot fit the shard admission limit.", 413)
        children = {}
        for record, size in values:
            child = record["id"].replace("-", "")[:len(current) + 1]
            children.setdefault(child, []).append((record, size))
        for child in sorted(children):
            visit(children[child], child)

    visit(sized, prefix)
    return result


def entry(prefix, document):
    return {"prefix": prefix, "path": f"shards/{prefix}.json", "recordCount": len(document["records"]),
            "sha256": checksum(document)}


def layout_manifest(entries, workspace_manifest):
    document = {"format": "timeline-record-layout", "formatVersion": 2,
                **{key: workspace_manifest[key] for key in ("workspaceId", "generation", "revision")},
                "recordCount": sum(value["recordCount"] for value in entries),
                "buckets": sorted(entries, key=lambda value: value["prefix"])}
    document["checksum"] = manifest_checksum(document)
    if len(json_bytes(document)) > LAYOUT_BYTES:
        raise DomainError("layout_manifest_capacity", "Storage layout manifest exceeds 4 MiB.", 413)
    return document


def build_layout(records, workspace_manifest):
    groups = {}
    for record in records:
        valid_id(record["id"])
        groups.setdefault(record["id"][0], []).append(record)
    shards = {}
    for prefix in sorted(groups):
        shards.update(partition(groups[prefix], prefix))
    return layout_manifest([entry(prefix, document) for prefix, document in shards.items()], workspace_manifest), shards


def validate_layout(document, workspace_manifest):
    if (not isinstance(document, dict) or set(document) != {"format", "formatVersion", "workspaceId", "generation", "revision",
                                                          "recordCount", "buckets", "checksum"}
            or document["format"] != "timeline-record-layout" or type(document["formatVersion"]) is not int
            or document["formatVersion"] != 2 or document["checksum"] != manifest_checksum(document)
            or type(document["revision"]) is not int or not 1 <= document["revision"] <= MAX_SAFE_INT
            or type(document["recordCount"]) is not int or not 0 <= document["recordCount"] <= MAX_SAFE_INT
            or any(document[key] != workspace_manifest[key] for key in ("workspaceId", "generation", "revision", "recordCount"))
            or not isinstance(document["buckets"], list)):
        raise DomainError("storage_layout_integrity", "Storage layout manifest is invalid or disagrees with the workspace.", 503)
    previous = None
    total = 0
    for value in document["buckets"]:
        if (not isinstance(value, dict) or set(value) != {"prefix", "path", "recordCount", "sha256"}
                or not isinstance(value["prefix"], str) or not re.fullmatch("[a-f0-9]{1,32}", value["prefix"])
                or value["path"] != f"shards/{value['prefix']}.json"
                or type(value["recordCount"]) is not int or value["recordCount"] <= 0
                or not isinstance(value["sha256"], str) or not re.fullmatch("[a-f0-9]{64}", value["sha256"])
                or (previous is not None and (value["prefix"] <= previous or value["prefix"].startswith(previous)))):
            raise DomainError("storage_layout_integrity", "Storage buckets have invalid, overlapping or unordered membership.", 503)
        previous = value["prefix"]
        total += value["recordCount"]
    if total != document["recordCount"]:
        raise DomainError("storage_layout_integrity", "Storage bucket counts are incomplete.", 503)


def validate_shard(document, bucket):
    if (not isinstance(document, dict) or set(document) != {"format", "formatVersion", "prefix", "records"}
            or document["format"] != "timeline-record-shard" or type(document["formatVersion"]) is not int
            or document["formatVersion"] != 1 or document["prefix"] != bucket["prefix"]
            or not isinstance(document["records"], list) or len(document["records"]) != bucket["recordCount"]
            or checksum(document) != bucket["sha256"]):
        raise DomainError("storage_shard_integrity", "Authoritative shard checksum, shape or membership count is invalid.", 503)
    previous = None
    for record in document["records"]:
        if not isinstance(record, dict):
            raise DomainError("storage_shard_integrity", "Shard record is not a JSON object.", 503)
        identity = valid_id(record.get("id"))
        if not identity.replace("-", "").startswith(bucket["prefix"]) or (previous is not None and identity <= previous):
            raise DomainError("storage_shard_integrity", "Shard record IDs are duplicated, unordered or outside the bucket.", 503)
        previous = identity


def apply_record_changes(layout, shards, updates, workspace_manifest):
    groups = {}
    existing_prefixes = [value["prefix"] for value in layout["buckets"]]
    for identity, record in updates.items():
        compact = identity.replace("-", "")
        prefix = next((value for value in existing_prefixes if compact.startswith(value)), None)
        if prefix is None:
            length = 1
            while any(value.startswith(compact[:length]) for value in existing_prefixes):
                length += 1
            prefix = compact[:length]
        groups.setdefault(prefix, {})[identity] = record
    replacements = {}
    entries = {value["prefix"]: value for value in layout["buckets"]}
    for prefix, changes in groups.items():
        records = {record["id"]: record for record in shards.get(prefix, {}).get("records", [])}
        for identity, record in changes.items():
            if record is None:
                records.pop(identity, None)
            else:
                records[identity] = record
        if prefix in entries:
            replacements[f"shards/{prefix}.json"] = None
            del entries[prefix]
        for child, document in partition(list(records.values()), prefix).items():
            replacements[f"shards/{child}.json"] = document
            entries[child] = entry(child, document)
    new_layout = layout_manifest(list(entries.values()), workspace_manifest)
    if new_layout["recordCount"] != workspace_manifest["recordCount"]:
        raise DomainError("storage_layout_integrity", "Proposed storage layout does not cover the complete workspace.", 503)
    replacements["storage-layout.json"] = new_layout
    return replacements
