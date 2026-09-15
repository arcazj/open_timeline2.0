"""Offline, deterministic contract for registered handlers, not the release wish list."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urldefrag, urljoin

from fastapi.openapi.utils import get_openapi
from fastapi import routing
from fastapi.routing import APIRoute

from ..models.domain import MUTABLE_FIELDS

ROOT = Path(__file__).resolve().parents[3]
BASE = "/api/v1/workspaces/default"
DIALECT = "https://json-schema.org/draft/2020-12/schema"
FAMILIES = ["sources", "groups", "schemas", "filters", "views"]
SAFE_INT = 9007199254740991
SCHEMA_NAMES = {
    "record.schema.json": "Record", "snapshot.schema.json": "Snapshot",
    "visual-definition.schema.json": "VisualDefinition", "visual-model.schema.json": "VisualModel",
    "record-render.schema.json": "RecordRender", "presentation.schema.json": "Presentation",
    "configuration-definition.schema.json": "ConfigurationDefinition",
    "configuration-resource.schema.json": "ConfigurationResource", "configuration-state.schema.json": "ConfigurationState",
}


def ref(name):
    return {"$ref": f"#/components/schemas/{name}"}


def obj(properties, required=(), *, additional=False, **extra):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": additional, **extra}


def array(items, **extra):
    return {"type": "array", "items": items, **extra}


def integer(minimum=0, maximum=SAFE_INT, **extra):
    return {"type": "integer", "minimum": minimum, "maximum": maximum, **extra}


def string(**extra):
    return {"type": "string", **extra}


def nullable(schema):
    return {"anyOf": [schema, {"type": "null"}]}


def enum(*values, **extra):
    return {"enum": list(values), **extra}


def shared_components():
    documents = {name: json.loads((ROOT / "shared" / "schemas" / filename).read_text(encoding="utf-8")) for filename, name in SCHEMA_NAMES.items()}
    ids = {document["$id"]: name for name, document in documents.items()}

    def rewrite(value, source_id):
        if isinstance(value, list):
            return [rewrite(item, source_id) for item in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, child in value.items():
            if key == "$id":
                continue
            if key == "$ref":
                target, fragment = urldefrag(urljoin(source_id, child))
                if target not in ids:
                    raise ValueError(f"Unbundled schema reference: {child}")
                result[key] = f"#/components/schemas/{ids[target]}" + (f"/{fragment.lstrip('/')}" if fragment else "")
            else:
                result[key] = rewrite(child, source_id)
        return result

    result = {}
    for filename, name in SCHEMA_NAMES.items():
        result[name] = rewrite(documents[name], documents[name]["$id"])
        result[name]["x-source-file"] = f"shared/schemas/{filename}"
        result[name]["x-source-sha256"] = hashlib.sha256((ROOT / "shared" / "schemas" / filename).read_bytes()).hexdigest()
    return result


def components():
    schemas = shared_components()
    boolean = {"type": "boolean"}
    number = {"type": "number"}
    instant = string(format="date-time", description="Explicit-offset ISO instant, years 0001-9999; at most millisecond precision.")
    timeline_instant = string(format="timeline-instant", description="Explicit-offset proleptic Gregorian instant, astronomical years -9999 through 9999, at most millisecond precision. Year 0000 is 1 BC; negative years use six digits (for example -000199 for 200 BC).")
    identity = string(minLength=1, maxLength=128)
    cursor = nullable(string(maxLength=4096))
    provenance = {"generation": identity, "revision": integer(1)}
    settings = ref("ConfigurationDefinition/$defs/settings")
    field = string(minLength=1, maxLength=256, description="Declared core/custom JSON Pointer; schema pins determine custom types.")
    pin = ref("ConfigurationDefinition/$defs/pin")
    scalar = {"type": ["string", "number", "boolean", "null"]}
    schemas["Problem"] = obj({"type": string(), "title": string(), "status": integer(400, 599), "detail": string(),
        'diagnostic': obj({'code': string(), 'offset': nullable(integer()), 'offsetUnit': {'const': 'unicode-codepoint'}, 'field': string(), 'ruleId': string(), 'hint': string()}, additional=True),
        "instance": string(), "code": string(), "message": string(), "requestId": nullable(string()), "errors": array(obj({}, additional=True))},
        ["type", "title", "status", "detail", "instance", "code", "message", "requestId"])
    schemas["ValidationReport"] = obj({"valid": boolean, "errors": array(obj({"path": string(), "code": string(), "message": string()}, additional=True))}, ["valid", "errors"])
    schemas["Range"] = obj({"from": timeline_instant, "to": timeline_instant}, ["from", "to"], description="Positive finite half-open interval [from,to).")
    schemas["LegacyDescriptor"] = obj({"status": enum("current", "missing", "unavailable"),
        "readOnly": {"const": True}, "sha256": string(pattern="^[0-9a-f]{64}$"), "file": string(),
        "descriptor": obj({}, additional=True), "diagnostics": array(obj({}, additional=True)), "reason": string()},
        ["status"], description="Read-only sidecar matched by source namespace and legacy ID. Authored strings are untrusted text, never executable HTML.")
    schemas["ContinuousMs"] = string(maxLength=100, pattern=r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$",
        description="decimal-view-v1 epoch milliseconds, no exponent; at most 34 significant digits, not a binary64 time coordinate.")
    schemas["FilterNode"] = {"oneOf": [
        obj({"op": enum("and", "or"), "args": array(ref("FilterNode"), minItems=1, maxItems=100)}, ["op", "args"]),
        obj({"op": {"const": "not"}, "arg": ref("FilterNode")}, ["op", "arg"]),
        obj({"op": enum("eq", "ne", "lt", "lte", "gt", "gte", "contains"), "field": field, "value": scalar, "caseSensitive": boolean}, ["op", "field", "value"]),
        obj({"op": {"const": "in"}, "field": field, "values": array(scalar, minItems=1, maxItems=100), "caseSensitive": boolean}, ["op", "field", "values"]),
        obj({"op": {"const": "exists"}, "field": field, "value": boolean}, ["op", "field", "value"]),
        obj({"op": {"const": "overlaps"}, "from": timeline_instant, "to": timeline_instant}, ["op", "from", "to"]),
    ], "description": "Additional semantic bounds: depth 8, at most 100 predicates; operators validate operand type before evaluation. Missing and null are distinct. No regex or executable code."}
    schemas["FilterExpression"] = obj({"version": {"const": 1}, "root": ref("FilterNode")}, ["version", "root"])
    v2_nodes = copy.deepcopy(schemas['FilterNode']['oneOf'])
    for node in v2_nodes:
        node['properties']['ruleId'] = string(minLength=1, maxLength=64, pattern='^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')
        if 'args' in node['properties']:
            node['properties']['args']['items'] = ref('FilterNodeV2')
        if 'arg' in node['properties']:
            node['properties']['arg'] = ref('FilterNodeV2')
    regex_properties = {'pattern': string(minLength=1, maxLength=512), 'flags': array(enum('i', 'm', 's'), maxItems=3, uniqueItems=True),
                        'matchMode': enum('search', 'full'), 'dialect': {'const': 're2-common-v1'}}
    v2_nodes.append(obj({'op': {'const': 'regex'}, 'field': field, 'ruleId': string(minLength=1, maxLength=64, pattern='^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'), **regex_properties}, ['op', 'field', 'pattern']))
    schemas['FilterNodeV2'] = {'oneOf': v2_nodes, 'description': 'Typed version2 AST; depth8,100 nodes,8 regex nodes. RE2 common subset, no lookaround/backreferences/inline flags.'}
    schemas['FilterExpression'] = {'oneOf': [schemas['FilterExpression'], obj({'version': {'const': 2}, 'root': ref('FilterNodeV2')}, ['version', 'root'])]}
    schemas["QueryFilters"] = obj({"kind": enum("all", "event", "session"), "sourceId": string(),
        "sourceIds": nullable(array(identity, maxItems=100, uniqueItems=True)), "kinds": array(enum("event", "session"), maxItems=2, uniqueItems=True),
        "schemaRefs": array(pin, maxItems=100), "filterId": nullable(identity), "filterVersion": nullable(integer(1, 32)), "expression": nullable(ref("FilterExpression"))},
        description="Explicit null kind/sourceId rejects. sourceIds:null means authorized sources; [] means none. Schema scope is exact and narrows the record set. Saved filter constraints intersect additional filters.")
    search_properties = {"search": string(maxLength=512), "searchMode": enum("any", "all", "phrase"), "searchCaseSensitive": boolean,
                         "searchFields": array(field, minItems=1, maxItems=16)}
    schemas["QueryRequest"] = obj({"domain": ref("Range"), "filters": ref("QueryFilters"), **search_properties,
        'definitionVersion': enum(1, 2), 'relationshipMode': enum('independent', 'family'),
        'searchMode': enum('any', 'all', 'phrase', 'regex'), 'searchFlags': regex_properties['flags'],
        'searchMatchMode': regex_properties['matchMode'], 'searchDialect': regex_properties['dialect'],
        "scaleMode": enum("uniform", "adaptive", default="uniform"), "ratio": {"type": "number", "minimum": 1, "maximum": 32, "default": 4},
        "fixedScale": array(ref("Presentation/definitions/scaleInterval"), maxItems=32),
        "bins": integer(16, 256, default=128)}, ["domain"], additional=True,
        description="Bounded immutable read-only query preparation. Prefer: respond-async requests immediate status; otherwise a short ready wait may return200 or202. Context C, search matches M, density C_O, overview M_O when search is active. Additional currently unconsumed members have no effect; use only declared fields.")
    schemas['QueryCounts'] = obj({'domain': ref('Range'), **provenance, 'complete': boolean,
        **{key: integer() for key in ('filterResults', 'directPredicateHits', 'searchFindings', 'contextRecords', 'visibleContextRecords')}},
        ['domain', *provenance, 'complete', 'filterResults', 'directPredicateHits', 'searchFindings', 'contextRecords', 'visibleContextRecords'])
    schemas['QueryRecordProvenance'] = obj({'role': enum('direct', 'family-context', 'ancestor-context'), 'directPredicate': boolean,
        'match': boolean, 'descendantMatchCount': integer()}, ['role', 'directPredicate', 'match', 'descendantMatchCount'])
    schemas['QueryRecord'] = obj({'record': ref('Record'), 'provenance': ref('QueryRecordProvenance'),
        'searchActive': boolean, 'explanation': obj({'rules': array(obj({'ruleId': string(), 'field': field, 'op': string()}, additional=True), maxItems=16), 'truncated': boolean}, ['rules', 'truncated']),
        'ancestors': array(obj({'id': identity, 'title': string(), 'kind': enum('event', 'session'), 'start': timeline_instant, 'end': nullable(timeline_instant)}, ['id', 'title', 'kind', 'start', 'end']), maxItems=32),
        'ancestorsTruncated': boolean}, ['record', 'ancestors', 'ancestorsTruncated'])
    schemas['FindRequest'] = obj({'afterId': nullable(identity), 'direction': enum('next', 'previous')})
    schemas['Finding'] = obj({'queryId': identity, 'record': nullable(ref('Record')), 'position': integer(), 'total': integer(), 'wrapped': boolean}, ['queryId', 'record', 'position', 'total', 'wrapped'])
    schemas['LegacyFilterMigrationRequest'] = obj({'include': string(maxLength=4096), 'exclude': string(maxLength=4096), 'sortBy': string(maxLength=4096),
        'relationshipMode': enum('independent', 'family'), 'acknowledgements': array(string(maxLength=100), maxItems=20, uniqueItems=True)})
    schemas['LegacyFilterMigration'] = obj({'format': {'const': 'legacy-filter-migration'}, 'version': {'const': 1}, 'classification': enum('exact', 'intent-repair', 'blocked'),
        'publishable': boolean, 'diagnostics': array(obj({}, additional=True)), 'requiredAcknowledgements': array(string()), 'draft': nullable(obj({}, additional=True)),
        'scope': obj({'queryId': identity, **provenance, 'domain': ref('Range'), 'complete': boolean})},
        ['format', 'version', 'classification', 'publishable', 'diagnostics', 'requiredAcknowledgements', 'draft', 'scope'])
    schemas["WindowCoverage"] = obj({"complete": boolean, "state": string(), "indexVersion": integer(),
        "checkedAt": nullable(instant), "indexedFiles": integer(), "indexedRecords": integer(),
        "rejectedFiles": integer(), "recordCount": nullable(integer())},
        ["complete", "state", "indexVersion", "checkedAt", "indexedFiles", "indexedRecords", "rejectedFiles", "recordCount"],
        description="Legacy file-index coverage pinned to this query. Provisional counts are not complete archive counts; incomplete coverage forces a uniform map.")
    schemas["QueryManifest"] = obj({**provenance, "queryId": identity, "snapshotId": identity, "mapId": identity, "coverage": ref("WindowCoverage"),
        'definitionVersion': {'const': 2}, 'relationshipMode': enum('independent', 'family'), 'counts': ref('QueryCounts'), 'preferencesRevision': integer(),
        "baseTotal": integer(), "matchTotal": integer(), "overviewTotal": integer(), "overviewMatchTotal": integer(),
        "fieldTypes": obj({}, additional=string()), "state": {"const": "ready"}},
        [*provenance, "queryId", "snapshotId", "mapId", "baseTotal", "matchTotal", "overviewTotal", "overviewMatchTotal", "fieldTypes", "state"])
    schemas["PreparationError"] = obj({"code": string(maxLength=128), "message": string(maxLength=256), "status": integer(400, 599), 'diagnostic': schemas['Problem']['properties']['diagnostic']}, ["code", "message", "status"])
    query_preparation = {**provenance, "queryId": identity, "snapshotId": identity, "mapId": identity}
    schemas["QueryPreparing"] = obj({**query_preparation, 'preferencesRevision': integer(), "state": {"const": "preparing"}}, [*query_preparation, "state"])
    schemas["QueryFailed"] = obj({**query_preparation, 'preferencesRevision': integer(), "state": {"const": "failed"}, "error": ref("PreparationError")}, [*query_preparation, "state", "error"])
    schemas["QueryStatus"] = {"oneOf": [ref("QueryManifest"), ref("QueryFailed")]}
    schemas["Density"] = obj({"bins": array(obj({"from": integer(-SAFE_INT), "to": integer(-SAFE_INT), "points": integer(),
        "overlapMs": string(pattern="^[0-9]+$"), "endpoints": integer(), "density": number}, ["from", "to", "points", "overlapMs", "endpoints", "density"]), maxItems=256),
        "complete": boolean, "total": integer()}, ["bins", "complete", "total"])
    schemas["TimeMap"] = obj({"mapId": identity, "domain": ref("Range"), "mode": enum("uniform", "adaptive", "fixed"), "ratio": number,
        "knots": array(obj({"timeMs": integer(-SAFE_INT), "u": string(pattern="^(?:0|1)(?:\\.[0-9]+)?$")}, ["timeMs", "u"]), minItems=2, maxItems=257)}, ["mapId", "domain", "mode", "ratio", "knots"])
    schemas["OverviewMark"] = obj({"id": identity, "kind": enum("event", "session"), "start": timeline_instant, "end": nullable(timeline_instant), "title": string(),
        "color": string(), "sourceId": identity, "render": ref("RecordRender"), "count": integer()}, ["id", "kind", "start", "end"], additional=True)
    schemas["Overview"] = obj({"domain": ref("Range"), "total": integer(), "matched": integer(), "matchActive": boolean, "aggregated": boolean,
        "items": array(ref("OverviewMark"), maxItems=1000), "coverage": ref("WindowCoverage")}, ["domain", "total", "matched", "matchActive", "aggregated", "items"])
    schemas["Zones"] = obj({"items": array(ref("Snapshot/properties/zones/items"), maxItems=512)}, ["items"])
    layout_properties = {"mapId": identity, "from": timeline_instant, "to": timeline_instant, "viewFromMs": ref("ContinuousMs"), "viewToMs": ref("ContinuousMs"),
        'definitionVersion': enum(1, 2), 'groupOrder': obj({'order': enum('natural', 'codepoint'), 'caseSensitive': boolean}),
        'collapsedGroups': array(string(maxLength=1024), maxItems=10000, uniqueItems=True),
        "width": {"type": "number", "minimum": 64, "maximum": 8192}, "availableHeight": {"type": "number", "minimum": 32, "maximum": 8192, "default": 480},
        "rowHeight": {"type": "number", "minimum": 32, "maximum": 192, "default": 32}, "fontSize": {"type": "number", "minimum": 10, "maximum": 32, "default": 13},
        "groupBy": enum("none", "sourceId", "kind"), "renderProfileId": {"const": "noto-sans-latin-v1"}, "theme": enum("light", "classic", "dark"),
        "displayUnit": ref("VisualDefinition/properties/displayUnit"), "presentation": ref("Presentation")}
    schemas["LayoutRequest"] = obj(layout_properties, ["mapId", "from", "to", "width"], additional=True,
        description="Effective rowHeight must fit availableHeight and all font/mark/label footprints. Legacy geometry caps rowHeight at128; presentation geometry at192. from/to are required conservative instants; continuous view bounds are exact.")
    manifest = {key: value for key, value in layout_properties.items() if key not in ("fontSize", "groupBy", "theme", "displayUnit")}
    schemas["LayoutManifest"] = obj({**manifest, "layoutId": identity, "totalRows": integer(), "detailTotal": integer(), "detailMatchTotal": integer(),
        **{key: integer() for key in ('logicalGroupTotal', 'collapsedGroupTotal', 'hiddenItemTotal')},
        "renderInstanceTotal": integer(), "pageCapacity": integer(1, 100), "enclosures": array(obj({}, additional=True))},
        ["layoutId", "mapId", "totalRows", "detailTotal", "detailMatchTotal", "renderInstanceTotal", "rowHeight", "pageCapacity", "from", "to", "viewFromMs", "viewToMs", "width", "availableHeight", "renderProfileId"])
    layout_preparation = {**provenance, "queryId": identity, "layoutId": identity, "mapId": identity}
    schemas["LayoutPreparing"] = obj({**layout_preparation, "state": {"const": "preparing"}}, [*layout_preparation, "state"])
    schemas["LayoutFailed"] = obj({**layout_preparation, "state": {"const": "failed"}, "error": ref("PreparationError")}, [*layout_preparation, "state", "error"])
    schemas["LayoutStatus"] = {"oneOf": [ref("LayoutManifest"), ref("LayoutFailed")]}
    schemas["RecordProjection"] = obj({"record": ref("Record"), "row": integer(), "match": boolean,
        **{key: number for key in ("xStart", "xEnd", "labelX", "labelWidth", "labelInkOffset", "labelLineHeight", "labelOffsetY", "geometryOffsetY", "iconX", "baselineStart", "baselineEnd", "baselineOffsetY", "footprintStart", "footprintEnd")},
        "labelLines": array(string()), "labelInkOffsets": array(number), "displayTitle": string(), "fullLabel": string(), "overflow": boolean,
        "continuesBefore": boolean, "continuesAfter": boolean, "style": obj({}, additional=True), "parentId": nullable(identity), "ancestorIds": array(identity), "depth": integer()},
        ["record", "row", "match", "xStart", "xEnd", "labelX", "labelWidth", "footprintStart", "footprintEnd"], additional=True)
    schemas["RowsPage"] = obj({"layoutId": identity, "mapId": identity, "items": array(ref("RecordProjection"), maxItems=1000),
        "rows": array(obj({"row": integer(), "type": {"const": "group"}, "name": string()}, ["row", "type", "name"], additional=True)),
        **{key: integer() for key in ("startRow", "endRow", "totalRows", "pageIndex", "pageCount", "loadedCount")},
        "previousCursor": cursor, "nextCursor": cursor, "pageComplete": {"const": True}, "enclosures": array(obj({}, additional=True))},
        ["layoutId", "mapId", "items", "rows", "startRow", "endRow", "totalRows", "pageIndex", "pageCount", "loadedCount", "previousCursor", "nextCursor", "pageComplete"])
    schemas["Placement"] = obj({"outsideLayout": boolean, "recordId": identity, "layoutId": identity, "mapId": identity, "row": integer(), "pageIndex": integer(), "cursor": string()}, ["outsideLayout", "recordId"])
    sort = array(obj({"field": string(), "direction": enum("asc", "desc"), 'order': enum('natural', 'codepoint'), 'caseSensitive': boolean}, ["field", "direction"]), minItems=1, maxItems=3)
    window = obj({**schemas["Range"]["properties"], "viewFromMs": ref("ContinuousMs"), "viewToMs": ref("ContinuousMs")}, ["from", "to"])
    table_properties = {"scope": enum("all", "window", default="all"), "window": nullable(window), "projection": enum("context", "matches", default="context"),
                        "sort": sort, "limit": integer(1, 1000, default=100)}
    schemas["TableRequest"] = obj({**table_properties, "cursor": cursor, 'definitionVersion': enum(1, 2)}, description="Complete filtered record pagination independent of row pages. Custom scalar sorts require query schemaRefs. Present, null, missing order is stable in either direction; ID ascending is final tie-breaker. Natural string ordering requires a version2 query.")
    schemas["TablePage"] = obj({**provenance, **table_properties, "queryId": identity, "snapshotId": identity, "tableId": string(),
        'definitionVersion': enum(1, 2), 'contextTotal': integer(),
        **{key: integer() for key in ("baseTotal", "total", "matchTotal", "startIndex", "endIndex", "pageIndex", "pageCount")}, "matchActive": boolean,
        "items": array(obj({"record": ref("Record"), "match": boolean, 'provenance': ref('QueryRecordProvenance')}, ["record", "match"]), maxItems=1000), "previousCursor": cursor, "nextCursor": cursor, "pageComplete": {"const": True}},
        [*provenance, *table_properties, "queryId", "snapshotId", "tableId", "baseTotal", "total", "matchTotal", "matchActive", "items", "startIndex", "endIndex", "pageIndex", "pageCount", "previousCursor", "nextCursor", "pageComplete"])
    mutable = {key: copy.deepcopy(schemas["Record"]["properties"][key]) for key in sorted(MUTABLE_FIELDS)}
    schemas["RecordCreate"] = obj(mutable, ["title"], description="Provider defaults optional canonical fields, including current start when omitted; custom data requires an exact published workspace schema pin. Typed collection enforces kind.")
    schemas["RecordReplace"] = obj(mutable, sorted(MUTABLE_FIELDS), description="Complete sixteen-field mutable representation, including explicit nullable baseline dates. Kind cannot change.")
    pointer = string(minLength=1, maxLength=1024, pattern="^/", description="JSON Pointer under a declared mutable field; root/prototype/immutable access is forbidden.")
    schemas["JsonPatch"] = array({"oneOf": [
        obj({"op": enum("add", "replace", "test"), "path": pointer, "value": {}}, ["op", "path", "value"]),
        obj({"op": enum("move", "copy"), "path": pointer, "from": pointer}, ["op", "path", "from"]),
        obj({"op": {"const": "remove"}, "path": pointer}, ["op", "path"]),
    ]}, minItems=1, maxItems=100, description="RFC6902; final canonical record must validate. Boolean and numeric test values are distinct. A failed test returns409 without mutation.")
    schemas["RecordCommit"] = obj({**provenance, "record": ref("Record"), "durability": {"const": "server-committed"}}, [*provenance, "record", "durability"])
    schemas["BatchRequest"] = obj({"operations": array({"oneOf": [
        obj({"type": {"const": "create"}, "payload": ref("RecordCreate")}, ["type", "payload"]),
        obj({"type": enum("update", "replace", "patch", "delete", "restore"), "recordId": identity, "expectedVersion": integer(1),
             "payload": {"oneOf": [obj(mutable), ref("JsonPatch")]}}, ["type", "recordId", "expectedVersion"]),
    ]}, minItems=1, maxItems=500)}, ["operations"], description="Atomic ordered mixed-record command, at most500 distinct affected IDs. Existing IDs occur once; no implicit cascades. Per-operation payload semantics follow type. Validate the complete final graph before commit; 8MiB request and32MiB recovery envelope ceilings.")
    schemas["BatchCommit"] = obj({**provenance, "status": {"const": "committed"}, "commandId": string(), "affectedCount": integer(1, 500),
        "items": array(obj({"index": integer(0, 499), "record": ref("Record")}, ["index", "record"]), maxItems=500),
        "durability": {"const": "server-committed"}}, [*provenance, "status", "commandId", "affectedCount", "items", "durability"])
    schemas["RecordList"] = obj({"revision": integer(1), "items": array(ref("Record"), maxItems=1000), "total": integer(), "nextOffset": nullable(integer())}, ["revision", "items", "total", "nextOffset"])
    schemas["EffectiveRequest"] = obj({"viewId": nullable(identity), "viewVersion": nullable(integer(1, 32)), "transient": settings}, description="Omitted view selector inherits; explicit paired null clears only this read-only preview selection.")
    schemas["EffectiveSettings"] = obj({"values": settings, "origins": obj({}, additional=string()), "preferenceRevision": integer()}, ["values", "origins", "preferenceRevision"])
    schemas["EffectiveResponse"] = obj({**provenance, **schemas["EffectiveSettings"]["properties"], "principalId": identity, "defaultsRevision": integer(1)}, [*provenance, "values", "origins", "preferenceRevision", "principalId", "defaultsRevision"])
    schemas["ConfigurationCommand"] = obj({"family": enum(*FAMILIES), "type": enum("create", "update", "publish", "archive", "unarchive", "delete", "duplicate", "apply"),
        "resourceId": identity, "generation": identity, "clientCommandId": string(pattern="^[A-Za-z0-9_-]{1,128}$"), "expectedRevision": integer(1), "expectedPreferenceRevision": integer(),
        "payload": obj({"name": string(maxLength=100), "description": string(maxLength=2000), "tags": array(string(), maxItems=20), "visibility": enum("personal", "workspace"), "definition": obj({}, additional=True), "draft": obj({}, additional=True), "version": integer(1, 32)}, additional=False)},
        ["family", "type", "generation", "clientCommandId"], description="Create has name+definition. Update replaces submitted metadata/draft only. Publication freezes a version. Apply filters/views requires version AND expectedPreferenceRevision; it changes only the acting principal's preferences. Payload members depend on operation and are semantically validated.")
    schemas["SettingsCommand"] = obj({"scope": enum("personal", "workspace"), "type": enum("patch", "replace", "reset"), "generation": identity,
        "clientCommandId": string(pattern="^[A-Za-z0-9_-]{1,128}$"), "expectedRevision": integer(), "payload": {"oneOf": [settings, obj({"paths": nullable(array(pointer, minItems=1, maxItems=100, uniqueItems=True))}, ["paths"])]}},
        ["scope", "type", "generation", "clientCommandId", "expectedRevision", "payload"], description="Personal revision0 denotes absent preferences. Reset paths must name declared settings keys or range/overview/search members. Application-scope mutation is not implemented.")
    schemas["ConfigurationCommit"] = obj({**provenance, "status": {"const": "committed"}, "commandId": string(), "durability": {"const": "json-files"}, "family": enum(*FAMILIES),
        "resource": nullable(ref("ConfigurationResource")), "settings": {"oneOf": [ref("ConfigurationState/properties/defaults"), ref("ConfigurationState/properties/preferences/items")]}, "effectiveSettings": ref("EffectiveSettings"), "resetTransientKeys": array(string())}, [*provenance, "status", "commandId", "durability"])
    schemas["ConfigurationItem"] = obj({**provenance, "family": enum(*FAMILIES), "resource": ref("ConfigurationResource"), "allowedActions": array(string())}, [*provenance, "family", "resource", "allowedActions"])
    summary = {key: value for key, value in schemas["ConfigurationResource"]["properties"].items() if key not in ("draft", "versions")}
    schemas["ConfigurationSummary"] = obj({**summary, "hasDraft": boolean, "publishedVersions": array(integer(1, 32)), "allowedActions": array(string())}, ["id", "name", "revision", "hasDraft", "publishedVersions", "allowedActions"])
    schemas["ConfigurationList"] = obj({**provenance, "family": enum(*FAMILIES), "items": array(ref("ConfigurationSummary")), "total": integer()}, [*provenance, "family", "items", "total"])
    publication = ref("ConfigurationResource/properties/versions/items")
    schemas["ConfigurationVersions"] = obj({**provenance, "family": enum(*FAMILIES), "items": array(publication)}, [*provenance, "family", "items"])
    schemas["ConfigurationVersion"] = obj({**provenance, "family": enum(*FAMILIES), "publication": publication}, [*provenance, "family", "publication"])
    schemas["ValidationRequest"] = obj({"definition": obj({}, additional=True), "context": obj({"resourceId": identity, "visibility": enum("personal", "workspace")})}, ["definition"])
    schemas["Usage"] = obj({**provenance, "family": enum(*FAMILIES), "items": array(obj({}, additional=True)), "total": integer(), "deletionBlocked": boolean, "nextCursor": cursor}, [*provenance, "family", "items", "total", "deletionBlocked", "nextCursor"], description="Only authorized descriptors/counts. Deletion protection uses the complete internal reference graph.")
    schemas["ImpactRequest"] = obj({"version": integer(1, 32), "definition": ref("ConfigurationDefinition/$defs/schemas"), "cursor": cursor, "limit": integer(1, 1000, default=100)},
        oneOf=[{"required": ["version"], "not": {"required": ["definition"]}}, {"required": ["definition"], "not": {"required": ["version"]}}])
    schemas["Impact"] = obj({**provenance, "schemaId": identity, "totalAffected": integer(), "totalInvalid": integer(), "nextCursor": cursor,
        "items": array(obj({"id": identity, "schemaId": identity, "schemaVersion": integer(1, 32), "deleted": boolean, "errors": array(obj({}, additional=True), maxItems=100)}, ["id", "schemaId", "schemaVersion", "deleted", "errors"]))},
        [*provenance, "schemaId", "totalAffected", "totalInvalid", "nextCursor", "items"], description="Read-only complete immutable analysis, two retained analyses. Later writes do not change pages; new candidate/page size or eviction rejects the cursor.")
    schemas["ModelCreate"] = obj({"name": string(minLength=1, maxLength=100), "description": string(maxLength=2000), "tags": array(string(), maxItems=20), "definition": ref("VisualDefinition")}, ["name", "definition"])
    schemas["ModelUpdate"] = obj({"name": string(minLength=1, maxLength=100), "description": string(maxLength=2000), "tags": array(string(), maxItems=20), "draft": ref("VisualDefinition")}, minProperties=1,
        description="Compatibility model endpoint: submitted fields replace metadata/draft; it is not complete-record PUT.")
    schemas["ModelCommit"] = obj({**provenance, "model": nullable(ref("VisualModel")), "settings": settings, "durability": {"const": "server-committed"}}, [*provenance, "model", "settings", "durability"])
    schemas["ModelList"] = obj({**provenance, "items": array(ref("VisualModel")), "active": obj({"modelId": identity, "version": integer(1, 32)}, ["modelId", "version"])}, [*provenance, "items", "active"])
    schemas["ModelItem"] = obj({**provenance, "model": ref("VisualModel"), "usage": array(obj({}, additional=True))}, [*provenance, "model", "usage"])
    grants = array(obj({"workspaceId": identity, "sourceIds": nullable(array(identity, maxItems=1000, uniqueItems=True)), "capabilities": array(string(), uniqueItems=True)}, ["workspaceId", "sourceIds", "capabilities"]), maxItems=100)
    principal_fields = {"id": identity, "name": string(minLength=1, maxLength=100), "role": enum("viewer", "editor", "admin"), "enabled": boolean,
        "grants": grants, "revision": integer(1), "createdAt": instant, "updatedAt": instant}
    schemas["Principal"] = obj(principal_fields, list(principal_fields))
    schemas["PrincipalCreate"] = obj({key: principal_fields[key] for key in ("name", "role", "grants")}, ["name", "role", "grants"])
    schemas["PrincipalPatch"] = obj({key: principal_fields[key] for key in ("name", "role", "enabled", "grants")}, minProperties=1)
    token_fields = {"id": identity, "principalId": identity, "name": string(maxLength=100), "createdAt": instant, "expiresAt": nullable(instant), "revokedAt": nullable(instant), "revision": integer(1)}
    schemas["Token"] = obj(token_fields, list(token_fields), additional=True, description="Metadata only; secretHash is never public.")
    schemas["TokenCreate"] = obj({key: token_fields[key] for key in ("principalId", "name", "expiresAt")}, ["principalId", "name", "expiresAt"])
    schemas["PrincipalEnvelope"] = obj({**provenance, "principal": ref("Principal"), "tokenId": identity}, ["generation", "principal"])
    schemas["PrincipalList"] = obj({**provenance, "items": array(ref("Principal"))}, [*provenance, "items"])
    schemas["TokenEnvelope"] = obj({**provenance, "token": ref("Token"), "secretUnavailable": boolean, "secret": string(readOnly=True, description="One-time creation response only. Never persist in browser storage; not replayed in durable outcomes.")}, [*provenance, "token"])
    schemas["TokenList"] = obj({**provenance, "items": array(ref("Token"))}, [*provenance, "items"])
    schemas["IdentityOutcome"] = obj({"state": {"const": "committed"}, "operation": string(), "committedAt": instant,
        "response": obj({"status": integer(200, 299), "headers": obj({}, additional=string()), "body": {"oneOf": [ref("PrincipalEnvelope"), ref("TokenEnvelope")]}}, ["status", "headers", "body"])}, ["state", "operation", "committedAt", "response"],
        description="Actor-scoped identity command outcome. Token creation outcomes never replay a raw secret.")
    schemas["WorkspaceStatus"] = obj({**provenance, "workspaceId": identity, "recordCount": nullable(integer()), "sourceIds": array(identity), "sources": array(identity),
        "sourceName": string(), "sourceKind": string(), "snapshotAt": instant, "completeness": string(), "modified": boolean, "durability": string(),
        "settings": settings, "models": array(ref("VisualModel")), "actor": obj({}, additional=True), "capabilities": obj({}, additional=True),
        "preferenceRevision": integer(), "defaultsRevision": integer(1)}, [*provenance, "recordCount", "settings", "actor", "capabilities"], additional=True)
    schemas["Health"] = obj({"status": string(), "storage": {"const": "json-files"}}, ["status"], additional=True)
    digest = string(pattern="^[a-f0-9]{64}$", minLength=64, maxLength=64)
    audit_fields = {"format": {"const": "timeline-audit-entry"}, "formatVersion": {"const": 1}, "workspaceId": identity,
        **provenance, "timestamp": instant, "actorId": nullable(identity), "commandId": nullable(identity),
        "family": enum("records", "models", *FAMILIES, "settings", "workspace.restore"),
        "records": array(obj({"id": identity, "version": integer(1), "sourceId": identity, "kind": enum("event", "session"), "deletedAt": nullable(instant)},
                             ["id", "version", "sourceId", "kind", "deletedAt"]), maxItems=500),
        "visibility": enum("workspace", "personal"), "ownerId": nullable(identity), "previousHash": nullable(digest),
        "transition": nullable(obj({"fromGeneration": identity, "backupSha256": digest}, ["fromGeneration", "backupSha256"])), "sha256": digest}
    schemas["AuditEntry"] = obj(audit_fields, list(audit_fields), description="Metadata-only committed revision chain. No title/data/credential payloads. Restore transitions identify prior generation and verified backup hash.")
    schemas["AuditPage"] = obj({"items": array(ref("AuditEntry"), maxItems=1000), "nextCursor": cursor,
        "coverage": obj({"firstRevision": nullable(integer(1)), "throughRevision": integer(1), "legacyHistoryBefore": integer()}, ["firstRevision", "throughRevision", "legacyHistoryBefore"])},
        ["items", "nextCursor", "coverage"], description="Authorized entries only, no hidden total. Cursor pins throughRevision and actor/source scope; historical coverage gaps are explicit.")
    schemas["ChangeNotice"] = obj({"revision": integer(1), "family": enum("records", "models", *FAMILIES, "settings", "workspace.restore"),
        "recordIds": array(string(format="uuid"), maxItems=500, uniqueItems=True), "requiresReload": {"const": True}}, ["revision", "family", "recordIds", "requiresReload"])
    schemas["ChangePage"] = obj({"generation": string(format="uuid"), "scope": digest, "throughRevision": integer(1), "nextRevision": integer(),
        "changes": array(ref("ChangeNotice"), maxItems=500), "hasMore": boolean}, ["generation", "scope", "throughRevision", "nextRevision", "changes", "hasMore"])
    schemas["ChangeStream"] = string(description="SSE event changes contains ChangePage JSON; heartbeat contains generation/revision; error contains sanitized code/status/message and closes. One-second authorization checks, 64 global/two per-principal leases, one-second send deadline.")
    schemas["ChangeHeartbeat"] = obj({"generation": string(format="uuid"), "revision": integer()}, ["generation", "revision"])
    schemas["ChangeStreamError"] = obj({"code": string(), "status": integer(400, 599), "message": string()}, ["code", "status", "message"])
    schemas["Capabilities"] = obj({"apiVersion": string(), "contractVersion": {"const": "3.1.1"}, "storage": {"const": "json-files"}, "transactionVersion": integer(1),
        "storageLayout": integer(1), "modes": array(enum("server", "standalone")), "state": enum("ready", "recovery-required"), "readOnly": boolean,
        "limits": obj({key: integer(1) for key in ("requestBytes", "batchRequestBytes", "batchRecords", "journalBytes", "patchOperations", "queryHandles")})},
        ["apiVersion", "contractVersion", "storage", "transactionVersion", "storageLayout", "modes", "state", "readOnly", "limits"], additional=True,
        description="Sanitized runtime capability/limit inventory; disabled features are not promises of implementation.")
    schemas["CommandOutcome"] = {"oneOf": [ref("RecordCommit"), ref("ModelCommit"), ref("ConfigurationCommit"), ref("BatchCommit")]}
    return schemas


def route_inventory(app):
    routes = routing.iter_route_contexts(app.routes) if hasattr(routing, "iter_route_contexts") else app.routes
    return sorted((route.path_format, method, route.name) for route in routes if isinstance(getattr(route, "original_route", route), APIRoute)
                  and getattr(route, "original_route", route).include_in_schema
                  for method in sorted(route.methods) if method not in ("HEAD", "OPTIONS"))


def examples(schemas):
    sample = json.loads((ROOT / "shared" / "fixtures" / "initial-snapshot.json").read_text(encoding="utf-8"))
    generation = sample["manifest"]["generation"]
    record = sample["records"][0]
    visual = {"theme": "light", "rowHeight": 40, "fontSize": 13, "groupBy": "sourceId", "displayUnit": "HOUR", "timeZone": "UTC", "scaleMode": "uniform", "ratio": 4, "bins": 128}
    values = {
        "Record": record, "RecordCreate": {"kind": "session", "title": "Operator handover", "sourceId": "operations", "start": "2026-09-12T12:00:00.000Z", "end": None},
        "RecordReplace": {key: record[key] for key in sorted(MUTABLE_FIELDS)},
        "RecordCommit": {"generation": generation, "revision": 2, "record": record, "durability": "server-committed"},
        "ChangePage": {"generation": generation, "scope": "a" * 64, "throughRevision": 2, "nextRevision": 2,
            "changes": [{"revision": 2, "family": "records", "recordIds": [record["id"]], "requiresReload": True}], "hasMore": False},
        "JsonPatch": [{"op": "replace", "path": "/end", "value": "2026-09-12T13:00:00.000Z"}],
        "BatchRequest": {"operations": [{"type": "create", "payload": {"title": "New checkpoint", "kind": "event", "sourceId": "operations", "start": "2026-09-12T12:00:00.000Z"}},
            {"type": "patch", "recordId": record["id"], "expectedVersion": 1, "payload": [{"op": "test", "path": "/title", "value": record["title"]}, {"op": "replace", "path": "/title", "value": "Updated checkpoint"}]}]},
        "QueryRequest": {"domain": sample["settings"]["overview"], "scaleMode": "adaptive", "ratio": 4, "bins": 128, "filters": {"sourceIds": ["operations"], "kinds": ["event", "session"]}, "search": "Telemetry", "searchMode": "any"},
        "LayoutRequest": {"mapId": "00000000-0000-4000-8000-000000000001", **sample["settings"]["range"], "width": 1000, "availableHeight": 480, "rowHeight": 40, "fontSize": 13, "groupBy": "sourceId"},
        "TableRequest": {"scope": "all", "projection": "context", "limit": 100, "sort": [{"field": "start", "direction": "asc"}]},
        "ModelCreate": {"name": "Operational light", "definition": visual}, "ModelUpdate": {"draft": visual}, "ModelValidation": {"definition": visual}, "ModelApply": {"version": 1},
        "ConfigurationCommand": {"family": "filters", "type": "create", "generation": generation, "clientCommandId": "example-create-filter", "payload": {"name": "Operational events", "visibility": "workspace", "definition": {
            "sourceIds": ["operations"], "kinds": ["event"], "schemaRefs": [], "expression": None, "search": {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title"]}}}},
        "SettingsCommand": {"scope": "personal", "type": "patch", "generation": generation, "clientCommandId": "example-personal-settings", "expectedRevision": 0, "payload": {"mode": "split"}},
        "EffectiveRequest": {"viewId": None, "viewVersion": None, "transient": {"mode": "table"}},
        "ImpactRequest": {"version": 1, "limit": 100},
        "ValidationRequest": {"definition": {"storage": "json", "enabled": True, "writable": True, "defaultSchema": None}, "context": {"visibility": "workspace"}},
        "PrincipalCreate": {"name": "Timeline reader", "role": "viewer", "grants": [{"workspaceId": "default", "sourceIds": ["operations"], "capabilities": []}]},
        "PrincipalPatch": {"enabled": False},
        "TokenCreate": {"principalId": "00000000-0000-4000-8000-000000000001", "name": "Expiring reader credential", "expiresAt": "2030-01-01T00:00:00.000Z"},
        "EmptyObject": {},
    }
    for name, value in values.items():
        schemas[name]["examples"] = [value]
    return values


def _operation(path, method, name):
    """All registered handlers must be assigned an explicit wire contract here."""
    suffix = path[len(BASE):] if path.startswith(BASE) else path
    if path == "/":
        return None
    if path in ("/api/v1/health", "/health/live", "/health/ready"):
        return "Health", None, 200, "operations", "Process liveness or JSON-store readiness; contains no records or secrets.", False
    if path == "/api/v1/capabilities":
        return "Capabilities", None, 200, "operations", "Read the public sanitized runtime modes, supported features and ceilings; no records, identity grants or secrets.", False
    if suffix == "/openapi.json":
        return "OpenApiDocument", None, 200, "operations", "Read this generated implemented-route contract. No pending endpoint is advertised as available.", True
    if path.startswith("/api/v1/principals"):
        if method == "POST":
            return "PrincipalEnvelope", "PrincipalCreate", 201, "identity", "Administrator creates a principal with explicit role and workspace/source grants.", True
        if method == "PATCH":
            return "PrincipalEnvelope", "PrincipalPatch", 200, "identity", "Administrator updates principal fields; disabling revokes current access.", True
        return ("PrincipalList" if path.endswith("/principals") else "PrincipalEnvelope"), None, 200, "identity", "Read authorized principal metadata and identity-generation ETag.", True
    if path.startswith("/api/v1/tokens"):
        return ("TokenList" if method == "GET" else "TokenEnvelope"), ("TokenCreate" if method == "POST" else None), (201 if method == "POST" else 200), "identity", "Issue a one-time token secret or read/revoke authorized token metadata. Hashes are never returned.", True
    if path.startswith("/api/v1/identity/commands/"):
        return "IdentityOutcome", None, 200, "identity", "Read-only recovery lookup of the original actor-scoped identity command.", True
    if suffix in ("", "/status"):
        return "WorkspaceStatus", None, 200, "workspace", "Read the current authorized default-workspace counts, effective settings and capabilities.", True
    if suffix == "/legacy/reload":
        return "WorkspaceStatus", None, 200, "workspace", "In explicitly configured legacy mode, recheck date-partitioned JSON without source writes. Requires workspace.manage. Lazy mode schedules background index verification and exposes coverage; eager mode publishes a complete/last-good file image. Existing queries remain pinned. Returns404 in managed mode.", True
    if suffix.endswith("/legacy-descriptor"):
        return "LegacyDescriptor", None, 200, "records", "Read the selected authorized legacy record sidecar on demand. Namespace/ID and path are validated. No browser-provided filesystem path is accepted. Returns404 in managed mode.", True
    if suffix == "/snapshot":
        return "Snapshot", None, 200, "workspace", "Export complete authorized source scope and visible reference-closed catalogs with integrity hash; never a row-page snapshot.", True
    if suffix == "/audit":
        return "AuditPage", None, 200, "audit", "Read metadata-only committed audit history with signed actor/scope/generation cursor pinned through one revision. Requires audit.read; no unauthorized total.", True
    if suffix in ("/changes", "/changes/stream"):
        return ("ChangeStream" if suffix.endswith("/stream") else "ChangePage"), None, 200, "changes", "Resume authorized metadata notices after a committed revision. Capture returned scope and supply it thereafter. Changed permissions/generation or uncovered replay reject409; future revisions reject422. Existing queries remain immutable.", True
    if suffix.startswith("/command-results/"):
        return "CommandOutcome", None, 200, "workspace", "Read-only original durable result; missing result does not prove an in-flight write cannot commit.", True
    if suffix in ("/query-sessions", "/records/query"):
        return "QueryStatus", "QueryRequest", 200, "queries", "Prepare an immutable authorized query with bounded admission; return ready200 or preparing202 with status Location. No canonical revision changes.", True
    if suffix.startswith("/query-snapshots/") or (suffix.startswith("/query-sessions/") and method == "DELETE"):
        return None, None, 204, "queries", "Release an owned ephemeral view handle; do not delete records.", True
    if suffix.startswith("/query-sessions/"):
        if suffix.endswith('/legacy-filter-migration'):
            return 'LegacyFilterMigration', 'LegacyFilterMigrationRequest', 200, 'queries', 'Read-only dry-run with explicit repair acknowledgements and typed AST. No source or preference files are written; publication is separate.', True
        if suffix.endswith('/find'):
            return 'Finding', 'FindRequest', 200, 'queries', 'Traverse direct search findings in stable time/ID order across all row pages in this query domain; returns one pinned record.', True
        if suffix.endswith('/records/{record_id}'):
            return 'QueryRecord', None, 200, 'queries', 'Read a pinned selected record, scoped provenance and permitted ancestor breadcrumbs. No data outside the owned query scope is exposed.', True
        for ending, response, body in (("/density", "Density", None), ("/overview", "Overview", None), ("/zones", "Zones", None),
                                      ("/records/query", "TablePage", "TableRequest"), ("/layouts", "LayoutStatus", "LayoutRequest"), ("/rows", "RowsPage", None)):
            if suffix.endswith(ending):
                return response, body, 200, "queries", "Read or prepare bounded immutable projections. Cursors never advance time or change the filter.", True
        if "/maps/" in suffix:
            return "TimeMap", None, 200, "queries", "Read exact immutable density-derived mapping knots.", True
        if "/placement/" in suffix:
            return "Placement", None, 200, "queries", "Locate an authorized record in this layout, or report outsideLayout without changing time.", True
        if "/layouts/" in suffix and suffix.count("/") == 4:
            return "LayoutStatus", None, 200, "queries", "Inspect an owned layout; return preparing202 or its ready/failed status200 without loading records.", True
        if suffix.count("/") == 2:
            return "QueryStatus", None, 200, "queries", "Read owned preparation status or a ready query manifest with exact scoped totals.", True
    if suffix == "/configuration/commands":
        return "ConfigurationCommit", "ConfigurationCommand", 200, "configuration", "Execute one captured versioned catalog command with visibility, reference, generation and revision checks.", True
    if suffix == "/settings/commands":
        return "ConfigurationCommit", "SettingsCommand", 200, "configuration", "Change revisioned personal/workspace overrides; application defaults are not implemented.", True
    if suffix == "/settings/effective":
        return "EffectiveResponse", "EffectiveRequest" if method == "POST" else None, 200, "configuration", "Resolve settings and per-leaf provenance without changing authored state.", True
    if suffix.endswith("/impact"):
        return "Impact", "ImpactRequest", 200, "configuration", "Prepare/read immutable, bounded schema-impact pages over the complete authorized record set.", True
    if suffix in ("/configuration/resource", "/configuration/usage") or suffix.startswith("/{family}"):
        if suffix.endswith("/validate"):
            return "ValidationReport", "ValidationRequest", 200, "configuration", "Validate family definition with declared visibility context; no write.", True
        if suffix.endswith("/usage"):
            return "Usage", None, 200, "configuration", "Read paginated authorized references; inaccessible private definitions and counts remain hidden.", True
        if suffix.endswith("/versions/{version}"):
            return "ConfigurationVersion", None, 200, "configuration", "Read one immutable published definition.", True
        if suffix.endswith("/versions"):
            return "ConfigurationVersions", None, 200, "configuration", "Read retained immutable publication history.", True
        return ("ConfigurationList" if suffix == "/{family}" else "ConfigurationItem"), None, 200, "configuration", "Read visible versioned catalog resources. Lists contain metadata only, never private definition bodies.", True
    if suffix.startswith("/models"):
        if suffix.endswith("/validate"):
            return "ValidationReport", "ModelValidation", 200, "models", "Validate a visual definition without persisting a draft.", True
        if method == "GET":
            return ("ModelList" if suffix == "/models" else "ModelItem"), None, 200, "models", "Read legacy-compatible visual catalog metadata and immutable history.", True
        request = "ModelCreate" if suffix == "/models" else ("ModelUpdate" if method == "PUT" else ("ModelApply" if suffix.endswith("/apply") else "EmptyObject"))
        return "ModelCommit", request, 201 if suffix == "/models" else 200, "models", "Visual-model lifecycle command. Publishing never auto-applies. Existing apply changes legacy workspace settings; generic view Apply is personal.", True
    if suffix == "/records/batch":
        return "BatchCommit", "BatchRequest", 200, "records", "Commit one bounded mixed-record transaction, all-or-nothing final graph validation and one workspace revision. Recovery retains the original actor-scoped key.", True
    if re.match(r"^/(records|events|sessions)(?:/|$)", suffix):
        if method == "GET":
            return ("RecordList" if suffix.count("/") == 1 else "Record"), None, 200, "records", "Read authorized canonical records; typed routes enforce kind, normal reads exclude tombstones.", True
        if method == "DELETE":
            return None, None, 204, "records", "Soft-delete one record; current active children block parent deletion. Recover durable result using its original command key.", True
        body = "RecordCreate" if method == "POST" and not suffix.endswith("/restore") else "EmptyObject" if suffix.endswith("/restore") else "RecordReplace" if method == "PUT" else "JsonPatch"
        return "RecordCommit", body, 201 if body == "RecordCreate" else 200, "records", "Mutate one record atomically. PUT is complete replacement; PATCH is RFC6902. Present authorization and source/schema policy are checked at commit and replay.", True
    raise ValueError(f"Registered operation has no explicit OpenAPI contract: {method} {path} ({name})")


def build_contract(app):
    inventory = route_inventory(app)
    contract = get_openapi(title="OpenBEXI Timeline implemented JSON API", version="0.1.0", openapi_version="3.1.1", routes=app.routes)
    contract["jsonSchemaDialect"] = DIALECT
    contract["info"]["description"] = "Current registered Python/JSON handlers only. Single default workspace. This artifact is not a full-release certification; pending normative routes are tracked in docs/api-contract.md."
    contract["servers"] = [{"url": "/", "description": "Same-origin API; separately configured explicit CORS origins are permitted."}]
    contract["security"] = [{"BearerAuth": []}]
    contract["components"] = {"schemas": components(), "responses": {}, "securitySchemes": {"BearerAuth": {"type": "http", "scheme": "bearer", "description": "Opaque high-entropy token. Server checks active principal, expiry/revocation and workspace/source capabilities on every request."}}}
    schemas = contract["components"]["schemas"]
    schemas["EmptyObject"] = obj({})
    schemas["ModelApply"] = obj({"version": integer(1, 32)}, ["version"])
    schemas["ModelValidation"] = obj({"definition": ref("VisualDefinition")}, ["definition"])
    schemas["OpenApiDocument"] = obj({"openapi": {"const": "3.1.1"}, "info": obj({}, additional=True), "paths": obj({}, additional=True), "components": obj({}, additional=True)}, ["openapi", "info", "paths", "components"], additional=True)
    samples = examples(schemas)
    errors = {400: "Malformed JSON/request/cursor", 401: "Missing, expired, disabled or revoked authentication", 403: "Missing capability or read-only source", 404: "Absent or inaccessible resource", 408: "Preparation publication deadline exceeded", 409: "Business/reference/generation/idempotency or expired-view conflict", 410: "Owned query expired; prepare a replacement", 412: "Stale resource or preference revision", 413: "Request, storage or retained-memory limit", 415: "Unsupported request media type", 422: "Invalid field, schema, relationship or query", 428: "Missing write precondition", 429: "Retained-query/layout capacity exhausted", 500: "Preparation failed without publishing a result", 503: "Storage integrity/recovery or service unavailable"}
    headers = {"X-Request-Id": {"schema": string(), "description": "Correlation ID; never a token."}, "Cache-Control": {"schema": {"const": "no-store"}}}
    for path, method, name in inventory:
        declared = _operation(path, method, name)
        if declared is None:
            contract["paths"].pop(path, None)
            continue
        response, request, status, tag, description, secured = declared
        operation = contract["paths"][path][method.lower()]
        operation.update(operationId=re.sub(r"[^A-Za-z0-9_]+", "_", f"{method.lower()}_{path}").strip("_"), summary=name.replace("_", " ").capitalize(),
                         description=description, tags=[tag], security=[{"BearerAuth": []}] if secured else [], **{"x-handler": name})
        operation["responses"] = {str(status): {"description": "No body" if status == 204 else "Successful committed result" if tag in ("records", "models", "configuration", "identity") and method not in ("GET",) and request not in ("ValidationRequest", "ModelValidation", "EffectiveRequest", "ImpactRequest") else "Successful read-only result", "headers": copy.deepcopy(headers)}}
        if response:
            operation["responses"][str(status)]["content"] = {"application/json": {"schema": ref(response)}}
        if response in ("QueryStatus", "LayoutStatus"):
            operation["responses"]["202"] = {"description": "Accepted ephemeral preparation; poll Location or DELETE to cancel/release.",
                "headers": {**copy.deepcopy(headers), "Location": {"schema": string()}, "Retry-After": {"schema": string()}},
                "content": {"application/json": {"schema": ref("QueryPreparing" if response == "QueryStatus" else "LayoutPreparing")}}}
        for code, text in errors.items():
            if not secured and code not in (503,):
                continue
            error_headers = copy.deepcopy(headers)
            if code == 401:
                error_headers["WWW-Authenticate"] = {"schema": {"const": "Bearer"}}
            if code in (429, 503):
                error_headers["Retry-After"] = {"schema": string(), "description": "Current server uses2seconds; recovery still requires the original command identity."}
            operation["responses"][str(code)] = {"description": text, "headers": error_headers, "content": {"application/problem+json": {"schema": ref("Problem")}}}
            if code in (400, 409, 412, 422, 428, 503):
                app_code = {400: "invalid_json", 409: "configuration_referenced", 412: "revision_conflict", 422: "invalid_record_data", 428: "precondition_required", 503: "storage_unavailable"}[code]
                operation["responses"][str(code)]["content"]["application/problem+json"]["example"] = {
                    "type": "about:blank", "title": app_code.replace("_", " ").capitalize(), "status": code, "detail": text,
                    "instance": BASE, "code": app_code, "message": text, "requestId": "00000000-0000-4000-8000-000000000001"}
            contract["components"]["responses"].setdefault(f"Problem{code}", operation["responses"][str(code)])
            operation["responses"][str(code)] = {"$ref": f"#/components/responses/Problem{code}"}
        parameters = operation.setdefault("parameters", [])
        if request in ("QueryRequest", "LayoutRequest"):
            parameters.append({"name": "Prefer", "in": "header", "required": False, "schema": {"const": "respond-async"},
                               "description": "Request immediate preparing status. Omission uses the same admission limits with a short ready wait."})
        for parameter in parameters:
            if parameter["name"] == "family":
                parameter["schema"] = enum(*FAMILIES)
            elif parameter["name"] == "limit":
                parameter["schema"].update(minimum=1, maximum=500 if tag == "changes" else 1000)
            elif parameter["name"] == "offset":
                parameter["schema"].update(minimum=0)
            elif parameter["name"] == "version":
                parameter["schema"].update(minimum=1, maximum=32)
            elif tag == "changes" and parameter["name"] == "generation":
                parameter["schema"] = string(format="uuid", pattern="^[0-9a-f-]{36}$")
            elif tag == "changes" and parameter["name"] == "afterRevision":
                parameter["schema"] = integer()
            elif tag == "changes" and parameter["name"] == "scope":
                parameter["schema"] = string(pattern="^[0-9a-f]{64}$", minLength=64, maxLength=64)
        if response == "ChangeStream":
            operation["responses"]["200"]["content"] = {"text/event-stream": {"schema": ref("ChangeStream"), "example": "event: heartbeat\ndata: {\"generation\":\"11111111-1111-4111-8111-111111111111\",\"revision\":1}\n\n"}}
            operation["x-sse-events"] = {"changes": ref("ChangePage"), "heartbeat": ref("ChangeHeartbeat"), "error": ref("ChangeStreamError")}
            operation["x-stream-limits"] = {"global": 64, "perPrincipal": 2, "leaseSeconds": 5, "sendTimeoutSeconds": 1}
        write = (tag == "records" and method != "GET") or (tag == "models" and method != "GET" and request != "ModelValidation") or (tag == "identity" and method != "GET") or request in ("ConfigurationCommand", "SettingsCommand")
        if write:
            generation_header = "X-Identity-Generation" if tag == "identity" else "X-Workspace-Generation"
            for key in (generation_header, "Idempotency-Key"):
                parameters.append({"name": key, "in": "header", "required": True, "schema": string(minLength=1, maxLength=128), "description": "Captured original command precondition; headers must agree with duplicate body fields."})
            conditional_match = request == "ConfigurationCommand"
            match = tag == "identity" or request not in ("RecordCreate", "ModelCreate", "ConfigurationCommand", "BatchRequest")
            if match or conditional_match:
                parameters.append({"name": "If-Match", "in": "header", "required": match, "schema": string(pattern='^"[^":]+:[0-9]+"$'),
                    "description": "Strong quoted generation:revision ETag. Required for every existing-resource command; configuration create alone omits it. Apply also requires expectedPreferenceRevision in its body."})
            operation["responses"][str(status)]["headers"]["ETag"] = {"schema": string(), "description": "New strong resource generation:revision; absent after permanent catalog deletion."}
            if status == 201 and request != "ModelCreate":
                operation["responses"][str(status)]["headers"]["Location"] = {"schema": string(), "description": "Created resource URL."}
            operation["x-idempotency"] = "Actor/generation-bound original key. Changed content or route conflicts. Check read-only outcome after a lost response; never assume rollback or generate a replacement key. Durable pending admission/24-hour retention are pending release gates."
        elif response in ("Record", "ModelItem", "ConfigurationItem", "PrincipalEnvelope", "PrincipalList", "TokenList"):
            operation["responses"][str(status)]["headers"]["ETag"] = {"schema": string(), "description": "Current strong generation:resource revision."}
        if request:
            media = "application/json-patch+json" if request == "JsonPatch" else "application/json"
            operation["requestBody"] = {"required": request != "EmptyObject", "content": {media: {"schema": ref(request)}}}
            if request in samples:
                operation["requestBody"]["content"][media]["example"] = copy.deepcopy(samples[request])
            operation["x-request-byte-limit"] = 8388608 if request == "BatchRequest" else 65536 if request in ("QueryRequest", "LayoutRequest", "TableRequest") else 1048576
        if response == "Health":
            operation["responses"]["503"] = {"description": "Not ready or recovery-required", "headers": copy.deepcopy(headers), "content": {"application/json": {"schema": ref("Health")}}}
        operation["x-permission-policy"] = {"identity": "Admin for principal mutation/listing and issuance for another principal; own token issuance/listing/revocation where allowed.",
            "configuration": "configuration.read plus present visibility/source scope; personal own writes need configuration.personal, workspace writes manage, workspace publication publish; Apply uses acting principal preferences.",
            "models": "configuration.read for reads; manage for model writes and publish for publication.", "records": "records.read/create/edit/delete/restore plus every affected source capability and policy.",
            "queries": "records.read with source scope rechecked on every page; changed scope invalidates entire handle.", "workspace": "records.read; snapshot additionally export and configuration.read; outcomes require current original-result authorization.",
            "operations": "Authentication where security is declared; no record payloads/secrets in health.",
            "audit": "audit.read; record entries require every referenced source; shared catalog history requires unrestricted source scope; personal entries owner/admin only.",
            "changes": "records.read and current token/grants on every poll/stream iteration; record notices require every source, personal owner/admin, shared catalog unrestricted source grants."}[tag]
    contract["paths"] = dict(sorted(contract["paths"].items()))
    contract["x-route-inventory"] = [{"path": path, "method": method, "handler": name} for path, method, name in inventory if path != "/"]
    contract["x-current-limits"] = {"workspaceIds": ["default"], "ordinaryRequestBytes": 1048576, "batchRequestBytes": 8388608, "batchRecords": 500, "journalBytes": 33554432, "queryRecords": 100000, "queryBundleBytes": 134217728,
        "queryTtlSeconds": 300, "queryHandlesPerPrincipal": 4, "queryRetainedGraphBytes": 268435456, "queryPreparationRequestBytes": 65536,
        "queryAccountingScratchBytes": 67108864, "queryAccountingBookkeepingBytes": 268435456,
        "preparationWorkers": 2, "preparationWorkersPerPrincipal": 1, "preparationQueue": 8, "preparationPublicationDeadlineSeconds": 30,
        "preparationAllowanceBytes": 8388608,
        "layoutsPerQuery": 2, "rowPageRecords": 1000, "rowAndTableResponseBytes": 2097152,
        "tablePageDefault": 100, "tablePageMaximum": 1000, "schemaImpactAnalyses": 2, "schemaImpactPageMaximum": 1000}
    contract["externalDocs"] = {"description": "Pinned OpenAPI3.1.1 interoperability baseline", "url": "https://spec.openapis.org/oas/v3.1.1.html"}
    return contract
