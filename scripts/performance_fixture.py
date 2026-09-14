"""Versioned, deterministic complete fixtures for release performance experiments."""
from __future__ import annotations

import copy
import hashlib
import uuid
from pathlib import Path

from server.app.models.domain import content_checksum, instant_ms, iso_from_ms, json_bytes, read_json, validate_snapshot
from server.app.models.model_catalog import normalize_catalog

ROOT = Path(__file__).resolve().parents[1]
RECIPE = "release-mixture-v1"
TIERS = {"small": 1000, "typical": 100000, "stress": 1000000}
STAMP = "2026-09-12T00:00:00.000Z"
BASE = instant_ms("2026-08-01T00:00:00.000Z")
DAY = 86400000
NAMESPACE = uuid.UUID("fbd7f730-29f5-4bd8-b590-7a31d6fa93e8")


def record_id(count, index):
    return str(uuid.uuid5(NAMESPACE, f"{RECIPE}:{count}:record:{index}"))


def catalog_entry(resource_id, name, definition):
    return {"formatVersion": 1, "id": resource_id, "name": name, "description": "", "tags": ["performance"],
            "revision": 1, "lifecycle": "active", "createdAt": STAMP, "updatedAt": STAMP,
            "ownerId": "fixture", "visibility": "workspace", "copiedFrom": None, "draft": None,
            "versions": [{"version": 1, "publishedAt": STAMP, "publishedBy": "fixture", "definition": definition}]}


def build_snapshot(tier="typical"):
    if tier not in TIERS:
        raise ValueError("Unknown performance tier")
    count = TIERS[tier]
    bundle = read_json(ROOT / "data/default-dataset.json")
    template = bundle["records"][0]
    records = []
    source_ids = [f"perf-source-{index:02d}" for index in range(10)]
    group_ids = [f"perf-group-{index:03d}" for index in range(100)]
    # Every ten-record block shares a source/group and contains a three-level tree.
    for index in range(count):
        block, slot = divmod(index, 10)
        dense = block % 5 == 0
        anchor = BASE + (15 * DAY if dense else block * 30 * DAY // (count // 10))
        start = anchor + (0 if dense else slot * 60000)
        parent = record_id(count, index - slot) if slot in (1, 3, 4) else None
        if slot == 2:
            parent = record_id(count, index - 1)
        point = slot in (2, 5)
        zero_duration = slot == 6 and block % 13 == 0
        ongoing = not point and (slot == 0 and block % 20 == 0 or slot == 8 and block % 7 == 0)
        long_session = slot == 0 and block % 17 == 0 or slot == 9 and block % 19 == 0
        if long_session:
            start -= 7 * DAY
        end = None if point or ongoing else start + (0 if zero_duration else 14 * DAY if long_session else (180 - slot * 10) * 60000)
        title = f"{'Milestone' if point else 'Activity'} {index:07d}"
        if index % 97 == 0:
            title = (title + " | instrument verification and detailed operational review" * 10)[:480]
        data = {"status": ("Ready", "Running", "Complete")[block % 3], "system": f"System {block % 8:02d}",
                "description": "Deterministic generic activity in the versioned release performance fixture."}
        if index % 11 == 0:
            data["measurement"] = {"value": index % 1000, "unit": "sample"}
        record = copy.deepcopy(template)
        record.update(id=record_id(count, index), kind="event" if point else "session", title=title,
                      start=iso_from_ms(start), end=iso_from_ms(end) if end is not None else None,
                      parentSessionId=parent, sourceId=source_ids[block % 10], groupIds=[group_ids[block % 100]],
                      order=index, tags=["performance", "dense" if dense else "distributed"], data=data,
                      extensions={"alias": f"PERF-{index:07d}", "fixtureRecipe": RECIPE}, schemaId="perf-measurement", schemaVersion=1,
                      originalStart=None, originalEnd=None, version=1, createdAt=STAMP, updatedAt=STAMP,
                      createdBy="fixture", updatedBy="fixture", deletedAt=STAMP if slot == 7 and block % 10 == 0 else None)
        if not point and not ongoing and index % 37 == 0:
            record.update(originalStart=iso_from_ms(start - 60000), originalEnd=iso_from_ms(end - 60000))
        records.append(record)
    bundle["records"] = records
    bundle["filters"] = []
    bundle["views"] = []
    bundle["schemas"] = [catalog_entry("perf-measurement", "Optional measurement", {"schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "additionalProperties": False,
        "properties": {"measurement": {"type": "object", "additionalProperties": False,
            "required": ["value", "unit"], "properties": {"value": {"type": "integer", "minimum": 0},
                                                         "unit": {"type": "string"}}}}}})]
    bundle["models"] = normalize_catalog(bundle["models"], STAMP)
    bundle["preferences"] = []
    bundle["defaults"] = {"revision": 1, "values": {}}
    bundle["sources"] = [catalog_entry(value, f"Source {index + 1}", {"storage": "json", "enabled": True,
                         "writable": True, "defaultSchema": None}) for index, value in enumerate(source_ids)]
    bundle["groups"] = [catalog_entry(value, f"Group {index + 1:03d}", {"order": index, "color": None,
                        "collapsed": False}) for index, value in enumerate(group_ids)]
    bundle["manifest"].pop("contentSha256", None)
    bundle["manifest"].update(bundleId=str(uuid.uuid5(NAMESPACE, f"{RECIPE}:{tier}:bundle")),
        generation=str(uuid.uuid5(NAMESPACE, f"{RECIPE}:{tier}:generation")), recordCount=count, revision=1,
        snapshotAt=STAMP, sourceName=f"Release performance {tier} ({RECIPE})", sourceKind="sample",
        scope={"workspaceId": "default", "sourceIds": source_ids})
    bundle["settings"].update(overview={"from": iso_from_ms(BASE), "to": iso_from_ms(BASE + 30 * DAY)},
        range={"from": iso_from_ms(BASE + 15 * DAY), "to": iso_from_ms(BASE + 15 * DAY + 6 * 3600000)},
        referenceTime=iso_from_ms(BASE + 15 * DAY), modelVersion=1)
    bundle["zones"] = [{"id": f"perf-zone-{index}", "title": title, "start": iso_from_ms(BASE + offset),
                        "end": iso_from_ms(BASE + offset + length), "color": color, "opacity": 0.15}
                       for index, (title, offset, length, color) in enumerate([
                           ("Maintenance", 15 * DAY - 3600000, 3 * 3600000, "#E89B31"),
                           ("Review", 15 * DAY + 3600000, 4 * 3600000, "#348EAF"),
                           ("Long observation", -DAY, 32 * DAY, "#68A373")])]
    validate_snapshot(bundle)
    bundle["manifest"]["contentSha256"] = content_checksum(bundle)
    return bundle


def fixture_summary(bundle, tier):
    records = bundle["records"]
    encoded = json_bytes(bundle)
    record_bytes = sum(len(json_bytes(record)) for record in records)
    return {"format": "openbexi-performance-fixture", "formatVersion": 1, "recipe": RECIPE, "tier": tier,
            "qualification": "Fixture only; no performance or supported-scale gate has been passed",
            "stressTierSupported": False, "recordCount": len(records), "sourceCount": len(bundle["sources"]),
            "groupCount": len(bundle["groups"]), "pointCount": sum(record["kind"] == "event" for record in records),
            "ongoingCount": sum(record["kind"] == "session" and record["end"] is None for record in records),
            "nestedCount": sum(record["parentSessionId"] is not None for record in records),
            "deletedCount": sum(record["deletedAt"] is not None for record in records),
            "longLabelCount": sum(len(record["title"]) > 200 for record in records),
            "sparseMeasurementCount": sum("measurement" in record["data"] for record in records),
            "averageRecordBytes": record_bytes / len(records), "snapshotBytes": len(encoded),
            "snapshotFileSha256": hashlib.sha256(encoded).hexdigest(),
            "contentSha256": bundle["manifest"]["contentSha256"],
            "recipeSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "seedSourceSha256": hashlib.sha256((ROOT / "data/default-dataset.json").read_bytes()).hexdigest()}
