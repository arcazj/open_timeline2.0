"""Pure, versioned configuration catalogs shared with the Local JavaScript provider."""
from __future__ import annotations

import copy
import json
import re
import unicodedata
import uuid
from functools import lru_cache
from pathlib import Path

import rfc8785

from .domain import DomainError, MAX_SAFE_INT, _compile_schema, instant_ms, now_iso, read_json, validate_json
from .model_catalog import definition_errors, integer, normalize_catalog
from .presentation import presentation_errors
from ..services.filters import FIELD_TYPES, compile_expression, compile_search, parse_search

FAMILIES = ("sources", "groups", "schemas", "filters", "views")
LIMITS = {"resources": 100, "versions": 32, "definitionBytes": 65536, "schemaNodes": 256, "schemaDepth": 16}
DEFAULT_DEFINITION = {"theme": "light", "rowHeight": 32, "fontSize": 13, "groupBy": "none", "displayUnit": "HOUR", "timeZone": "UTC", "scaleMode": "uniform", "ratio": 4, "bins": 128}
BUILT_IN_DATA = {"description": "string", "text": "string", "system": "string", "type": "string", "status": "string", "priority": "number"}
REGISTRY_BASE = {**FIELD_TYPES, "/data/priority": "number"}
SCHEMA_ROOT = Path(__file__).resolve().parents[3] / "shared" / "schemas"
DOCUMENTS = [read_json(SCHEMA_ROOT / f"configuration-{name}.schema.json") for name in ("definition", "resource", "state")]
DEFINITIONS, RESOURCE_SCHEMA, STATE_SCHEMA = DOCUMENTS
VALIDATORS = {family: _compile_schema({"$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": f"{DEFINITIONS['$id']}#/$defs/{family}"}, DOCUMENTS) for family in FAMILIES}
CHECK_ENVELOPE = _compile_schema(RESOURCE_SCHEMA, DOCUMENTS)
CHECK_STATE = _compile_schema(STATE_SCHEMA, DOCUMENTS)
CHECK_SETTINGS = _compile_schema({"$schema": "https://json-schema.org/draft/2020-12/schema", "$ref": f"{DEFINITIONS['$id']}#/$defs/settings"}, DOCUMENTS)
_UNSET = object()


def _bad(message, code="invalid_configuration", status=422, errors=None):
    error = DomainError(code, message, status)
    if errors is not None:
        error.errors = errors
    raise error


def _pointer(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def _schema_errors(validator, value):
    errors = []
    for error in validator.iter_errors(value):
        path = list(error.instance_path)
        if getattr(error.kind, "name", "") == "Required":
            path.append(error.kind.property)
        errors.append({"path": "/" + "/".join(_pointer(part) for part in path),
                       "code": str(error.schema_path[-1]) if error.schema_path else "schema", "message": error.message})
    return errors


def _assert_shape(value, validator, message):
    errors = _schema_errors(validator, value)
    if errors:
        _bad(message, errors=errors)


def _require_actor(actor):
    if not isinstance(actor, dict) or not isinstance(actor.get("id"), str) or not actor["id"].strip() or len(actor["id"]) > 128 or not isinstance(actor.get("capabilities"), list) or any(not isinstance(value, str) for value in actor["capabilities"]):
        _bad("An explicit authenticated actor is required", "configuration_forbidden", 403)
    return actor


def _has(actor, capability):
    return "*" in actor["capabilities"] or capability in actor["capabilities"]


def _readable(resource, actor):
    return (actor is None or _has(actor, "configuration.manage")
            or (_has(actor, "configuration.read") and resource.get("visibility") != "personal")
            or (resource.get("ownerId") == actor["id"] and _has(actor, "configuration.personal")))


def _family_name(family):
    if family not in (*FAMILIES, "models"):
        _bad("Unknown configuration resource family")


def _resource_at(snapshot, family, resource_id, context=None):
    context = context or {}
    _family_name(family)
    resource = next((item for item in (snapshot or {}).get(family, []) if item["id"] == resource_id), None)
    if resource is None or not _readable(resource, context.get("actor")):
        _bad("Configuration resource is unavailable", "configuration_not_found", 404)
    if context.get("newReference") and resource["lifecycle"] == "archived":
        _bad("New references to archived resources are not permitted", "configuration_archived", 409)
    if resource.get("visibility") == "personal" and (context.get("visibility") == "workspace" or (context.get("ownerId") and resource["ownerId"] != context["ownerId"])):
        _bad("A reference cannot expose a private resource", "configuration_forbidden", 403)
    return resource


def _publication(snapshot, family, pin, context=None):
    resource = _resource_at(snapshot, family, pin.get("id"), context)
    version = next((item for item in resource["versions"] if type(pin.get("version")) in (int, float) and item["version"] == pin["version"]), None)
    if version is None:
        _bad("Published configuration version is unavailable", "configuration_version_unavailable", 409)
    return version["definition"]


def _payload_keys(payload, allowed, required=()):
    if not isinstance(payload, dict) or set(payload) - set(allowed) or set(required) - set(payload):
        _bad("Invalid configuration command payload")


def _timestamp(value):
    try:
        instant_ms(value)
    except DomainError:
        _bad("Configuration timestamps must be offset timestamps with millisecond precision")


def _definition_size(value):
    validate_json(value)
    if len(rfc8785.dumps(value)) > LIMITS["definitionBytes"]:
        _bad("Definition exceeds 64 KiB", "configuration_capacity", 413)


def default_configuration_definition(family, snapshot=None):
    if family == "sources":
        return {"storage": "json", "enabled": True, "writable": True, "defaultSchema": None}
    if family == "groups":
        return {"order": 0, "color": None, "collapsed": False}
    if family == "schemas":
        return {"schema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {}, "additionalProperties": False}}
    if family == "filters":
        return {"sourceIds": None, "kinds": ["event", "session"], "schemaRefs": [], "expression": None, "search": {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title"]}}
    if family == "views":
        return {"model": {"id": snapshot["settings"]["modelId"], "version": snapshot["settings"]["modelVersion"]}, "filter": None, "settings": {}}
    _bad("Unknown configuration family")


@lru_cache(maxsize=64)
def _data_validator(canonical_bytes):
    schema = json.loads(canonical_bytes)
    schema.setdefault("$schema", "https://json-schema.org/draft/2020-12/schema")
    return _compile_schema(schema, [])


def resolved_data_schema(definition):
    _definition_size(definition)
    root = copy.deepcopy(definition.get("schema"))
    if not isinstance(root, dict) or root.get("type") != "object" or not isinstance(root.get("properties"), dict) or root.get("additionalProperties") is not False:
        _bad("Data schema requires an object root, properties and additionalProperties:false")
    keywords = {"$schema", "$defs", "$ref", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "title", "description"}
    count = 0

    def visit(node, depth=1, stack=()):
        nonlocal count
        count += 1
        if not isinstance(node, dict) or depth > 16 or count > 256:
            _bad("Data schema exceeds its node/depth bounds")
        if set(node) - keywords:
            _bad("Unsupported data schema keyword")
        if "$schema" in node and node["$schema"] != "https://json-schema.org/draft/2020-12/schema":
            _bad("Only JSON Schema 2020-12 is accepted")
        if "$ref" in node:
            if len(node) != 1 or not isinstance(node["$ref"], str) or not re.fullmatch(r"#/\$defs/[A-Za-z0-9_-]+", node["$ref"]):
                _bad("Only an isolated local $defs reference is accepted")
            name = node["$ref"][8:]
            if name not in root.get("$defs", {}) or name in stack:
                _bad("Data schema has a missing or recursive reference")
            visit(root["$defs"][name], depth + 1, (*stack, name))
            return
        types = node.get("type") if isinstance(node.get("type"), list) else [node.get("type")]
        if not types or any(not isinstance(kind, str) or kind not in ("object", "array", "string", "number", "integer", "boolean", "null") for kind in types) or len(set(types)) != len(types) or len(types) > 2 or (len(types) == 2 and "null" not in types):
            _bad("Data schema requires one supported type, optionally nullable")
        if "additionalProperties" in node and type(node["additionalProperties"]) is not bool:
            _bad("additionalProperties must be boolean")
        if "enum" in node and (not isinstance(node["enum"], list) or len(node["enum"]) > 100):
            _bad("An enum supports at most 100 values")
        if "properties" in node:
            if not isinstance(node["properties"], dict) or len(node["properties"]) > 100:
                _bad("An object supports at most 100 properties")
            for child in node["properties"].values():
                visit(child, depth + 1, stack)
        if "items" in node:
            visit(node["items"], depth + 1, stack)
        if "$defs" in node:
            if node is not root or not isinstance(node["$defs"], dict) or any(not re.fullmatch(r"[A-Za-z0-9_-]+", key) for key in node["$defs"]):
                _bad("$defs is restricted to named root definitions")
            for name, child in node["$defs"].items():
                visit(child, depth + 1, (*stack, name))

    visit(root)
    for field, kind in BUILT_IN_DATA.items():
        if field in root["properties"] and root["properties"][field].get("type") != kind:
            _bad(f"Built-in data field {field} must retain type {kind}")
        root["properties"].setdefault(field, {"type": kind})
    try:
        _data_validator(rfc8785.dumps(root))
    except (ValueError, TypeError) as error:
        _bad(f"Data schema cannot be compiled within the supported dialect: {error}")
    return root


def filter_field_types(snapshot, schema_refs=None):
    schema_refs = [] if schema_refs is None else schema_refs
    if not isinstance(schema_refs, list):
        _bad("Schema scope must be an array")
    registry, shared, seen = dict(REGISTRY_BASE), None, set()
    for pin in schema_refs:
        key = (pin.get("id"), pin.get("version"))
        if key in seen:
            _bad("Duplicate schema scope pin")
        seen.add(key)
        root = resolved_data_schema(_publication(snapshot, "schemas", pin))
        fields = {}

        def visit(node, path):
            if "$ref" in node:
                return visit(root["$defs"][node["$ref"][8:]], path)
            kind = next((kind for kind in node["type"] if kind != "null"), None) if isinstance(node["type"], list) else node["type"]
            if kind == "object":
                for key, child in node.get("properties", {}).items():
                    visit(child, path + "/" + _pointer(key))
            elif kind in ("string", "number", "integer", "boolean"):
                fields[path] = "number" if kind == "integer" else kind
            elif kind == "array" and node.get("items", {}).get("type") == "string":
                fields[path] = "strings"

        visit(root, "/data")
        if shared is None:
            shared = fields
        else:
            for field, kind in list(shared.items()):
                if field in fields and fields[field] != kind:
                    _bad("Schema scope contains incompatible field types")
                if field not in fields:
                    del shared[field]
    registry.update(shared or {})
    return registry


def _validate_expression(expression, registry):
    if expression is None:
        return
    if isinstance(expression, dict) and expression.get("version") == 2:
        compile_expression(expression, field_types=registry)
        return
    if not isinstance(expression, dict) or not integer(expression.get("version"), 1, 1) or set(expression) - {"version", "root"}:
        _bad("Expected a version 1 filter expression")
    count = 0

    def visit(node, depth=1):
        nonlocal count
        count += 1
        if not isinstance(node, dict) or count > 100 or depth > 8:
            _bad("Filter exceeds 100 nodes or depth 8")
        op = node.get("op")
        if op in ("and", "or"):
            _payload_keys(node, ("op", "args"), ("op", "args"))
            if not isinstance(node["args"], list) or not 1 <= len(node["args"]) <= 100:
                _bad("Boolean groups require 1-100 children")
            for child in node["args"]:
                visit(child, depth + 1)
            return
        if op == "not":
            _payload_keys(node, ("op", "arg"), ("op", "arg"))
            visit(node["arg"], depth + 1)
            return
        if op == "overlaps":
            compile_expression({"version": 1, "root": node})
            return
        field = node.get("field")
        if not isinstance(field, str) or field not in registry:
            _bad("Filter field is not declared in every scoped schema")
        kind = registry[field]
        if kind == "boolean":
            if op not in ("exists", "eq", "ne", "in"):
                _bad("Boolean fields support equality, membership and exists")
            _payload_keys(node, ("op", "field", "values") if op == "in" else ("op", "field", "value"))
            values = node.get("values") if op == "in" else [node.get("value")]
            if not isinstance(values, list) or not 1 <= len(values) <= 100 or "value" not in node and op != "in" or any(type(value) is not bool and (value is not None or op == "exists") for value in values):
                _bad("Boolean predicate has an invalid value")
            return
        substitute = {"string": "/title", "number": "/order", "date": "/start", "strings": "/tags"}[kind]
        compile_expression({"version": 1, "root": {**node, "field": substitute}})

    visit(expression.get("root"))


def _validate_search(search, registry, partial=False, definition_version=1):
    if definition_version == 2:
        value = search if search.get("mode") == "regex" or not partial else {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title"], **search}
        request = {"definitionVersion": definition_version, "search": value.get("text", ""), "searchMode": value.get("mode", "any"), "searchFields": value.get("fields", ["/title"])}
        for source, target in (("caseSensitive", "searchCaseSensitive"), ("flags", "searchFlags"), ("matchMode", "searchMatchMode"), ("dialect", "searchDialect")):
            if source in value:
                request[target] = value[source]
        compile_search(request, field_types=registry)
        return
    value = {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title"], **search} if partial else search
    parse_search(value["text"], value["mode"], value["caseSensitive"])
    fields = value["fields"]
    if not isinstance(fields, list) or not 1 <= len(fields) <= 16 or any(not isinstance(field, str) or field not in registry or registry[field] == "strings" for field in fields) or len(set(fields)) != len(fields):
        _bad("Search requires declared scalar fields")


def _settings_pins(values):
    pins = []
    for stem, family in (("model", "models"), ("filter", "filters"), ("view", "views")):
        a, b = stem + "Id", stem + "Version"
        if (a in values) != (b in values) or (a in values and ((values[a] is None) != (values[b] is None))):
            _bad("Setting references require paired IDs and versions")
        if a in values and values[a] is not None:
            pins.append((family, {"id": values[a], "version": values[b]}))
    return pins


def _settings_registry(values, context):
    if "registry" in context:
        return context["registry"]
    snapshot = context.get("snapshot")
    if snapshot is None:
        return REGISTRY_BASE
    personal = next((item["values"] for item in snapshot.get("preferences", []) if item["principalId"] == context.get("ownerId")), {})
    selection = {**snapshot["settings"], **snapshot.get("defaults", {}).get("values", {}), **personal, **values}
    pin = None if selection.get("filterId") is None else {"id": selection["filterId"], "version": selection.get("filterVersion")}
    if selection.get("viewId") is not None:
        pin = _publication(snapshot, "views", {"id": selection["viewId"], "version": selection.get("viewVersion")}, context)["filter"]
    saved_filter = _publication(snapshot, "filters", pin, context) if pin else None
    return filter_field_types(snapshot, saved_filter["schemaRefs"]) if saved_filter else REGISTRY_BASE


def _validate_settings(values, context=None, allow_pins=True):
    context = context or {}
    _assert_shape(values, CHECK_SETTINGS, "Invalid settings override")
    pins = _settings_pins(values)
    if not allow_pins and any(key in values for key in ("modelId", "modelVersion", "filterId", "filterVersion", "viewId", "viewVersion")):
        _bad("View settings cannot contain resource pins")
    for family, pin in pins:
        if context.get("snapshot") is not None:
            _publication(context["snapshot"], family, pin, context)
    for key in ("range", "overview"):
        if key in values:
            for value in values[key].values():
                _timestamp(value)
            if values[key].get("from") and values[key].get("to") and instant_ms(values[key]["from"]) >= instant_ms(values[key]["to"]):
                _bad("Time range must be positive")
    if "referenceTime" in values:
        _timestamp(values["referenceTime"])
    visual = {key: values[key] for key in DEFAULT_DEFINITION if key in values}
    definition = {**DEFAULT_DEFINITION, **visual}
    if "fontSize" in visual and "rowHeight" not in visual:
        definition["rowHeight"] = max(DEFAULT_DEFINITION["rowHeight"], visual["fontSize"] + 19)
    errors = definition_errors(definition)
    if errors:
        _bad("Invalid visual settings", errors=errors)
    if "presentation" in values:
        errors = presentation_errors(values["presentation"])
        if errors:
            _bad("Invalid presentation settings", errors=errors)
    registry = _settings_registry(values, context)
    for key in ("columns", "sort"):
        if key not in values:
            continue
        fields = [item["field"] for item in values[key]]
        paths = [field if field.startswith("/") else "/" + re.sub(r"^data\.", "data/", field) for field in fields]
        if len(set(fields)) != len(fields) or any(path not in registry for path in paths):
            _bad("Table fields must be unique declared fields")
        if key == "sort" and any(registry[path] == "strings" for path in paths):
            _bad("Table sort requires scalar fields")
        if key == "sort" and values.get("definitionVersion") == 2 and any(("order" in item or "caseSensitive" in item) and registry[path] != "string" for item, path in zip(values["sort"], paths)):
            _bad("Natural ordering and case options require declared string fields")
    if "search" in values:
        _validate_search(values["search"], registry, True, values.get("definitionVersion", 1))
    if values.get("definitionVersion") == 2:
        keys = values.get("collapsedGroups", [])
        normalized = [unicodedata.normalize("NFC", key) for key in keys]
        if keys != normalized or len(set(normalized)) != len(keys):
            _bad("Collapsed group keys must be distinct NFC identities")
    else:
        for group_id in values.get("collapsedGroups", []):
            if context.get("snapshot") is not None:
                _resource_at(context["snapshot"], "groups", group_id, context)


def validate_resource_definition(family, definition, context=None):
    context, errors = context or {}, []
    try:
        if family not in FAMILIES:
            _bad("Unknown configuration family")
        _definition_size(definition)
        errors = _schema_errors(VALIDATORS[family], definition)
        if errors:
            return {"valid": False, "errors": errors}
        if context.get("actor") is not None:
            _require_actor(context["actor"])

        def reference(target, pin):
            return _publication(context["snapshot"], target, pin, context) if context.get("snapshot") is not None else None

        if family == "sources" and definition["defaultSchema"] is not None:
            reference("schemas", definition["defaultSchema"])
        if family == "schemas":
            resolved_data_schema(definition)
        if family == "filters":
            for source_id in definition["sourceIds"] or []:
                if context.get("snapshot") is not None:
                    _resource_at(context["snapshot"], "sources", source_id, context)
            for pin in definition["schemaRefs"]:
                reference("schemas", pin)
            if definition["schemaRefs"] and context.get("snapshot") is None:
                _bad("Schema-scoped validation requires the catalog context")
            registry = filter_field_types(context.get("snapshot"), definition["schemaRefs"])
            _validate_expression(definition["expression"], registry)
            _validate_search(definition["search"], registry, definition_version=definition.get("definitionVersion", 1))
        if family == "views":
            reference("models", definition["model"])
            saved_filter = reference("filters", definition["filter"]) if definition["filter"] is not None else None
            if definition.get("definitionVersion", 1) == 1 and saved_filter and saved_filter.get("definitionVersion") == 2:
                _bad("A version 1 view cannot pin a version 2 filter; explicitly upgrade the view")
            registry = filter_field_types(context["snapshot"], saved_filter["schemaRefs"]) if saved_filter else REGISTRY_BASE
            _validate_settings(definition["settings"], {**context, "registry": registry}, False)
    except DomainError as error:
        errors.extend(getattr(error, "errors", [{"path": "/", "code": error.code, "message": error.message}]))
    return {"valid": not errors, "errors": errors}


def _require_definition(family, definition, context):
    _definition_size(definition)
    result = validate_resource_definition(family, definition, context)
    if result["valid"]:
        return
    statuses = {"configuration_forbidden": 403, "configuration_not_found": 404, "configuration_version_unavailable": 409, "configuration_archived": 409, "configuration_capacity": 413}
    for error in result["errors"]:
        if error["code"] in statuses:
            _bad(error["message"], error["code"], statuses[error["code"]])
    _bad("Configuration definition is invalid", "invalid_configuration_definition", errors=result["errors"])


def _validate_envelope(resource, family):
    _assert_shape(resource, CHECK_ENVELOPE, "Invalid configuration envelope")
    if not resource["name"].strip() or any(not tag.strip() for tag in resource["tags"]) or not resource["ownerId"].strip():
        _bad("Configuration metadata cannot be blank")
    if family in ("sources", "groups") and (resource["visibility"] != "workspace" or not resource["versions"]):
        _bad("Sources and groups require a shared published definition")
    if not resource["versions"] and resource["draft"] is None:
        _bad("Resource requires a draft or publication")
    _timestamp(resource["createdAt"])
    _timestamp(resource["updatedAt"])
    for index, version in enumerate(resource["versions"], 1):
        if not integer(version["version"], index, index):
            _bad("Publication versions must be contiguous from one")
        _timestamp(version["publishedAt"])


def _new_resource(resource_id, name, definition, family, actor_id, now, visibility):
    published = family in ("sources", "groups")
    return {"formatVersion": 1, "id": resource_id, "name": name, "description": "", "tags": [], "revision": 1,
            "lifecycle": "active", "createdAt": now, "updatedAt": now, "ownerId": actor_id, "visibility": visibility,
            "copiedFrom": None, "draft": None if published else copy.deepcopy(definition),
            "versions": [{"version": 1, "publishedAt": now, "publishedBy": actor_id, "definition": copy.deepcopy(definition)}] if published else []}


def normalize_configuration(input_snapshot, actor):
    return _normalize_configuration(input_snapshot, actor)


def validate_configuration(input_snapshot, actor):
    """Run all configuration checks without copying or fingerprinting unchanged records."""
    _normalize_configuration(input_snapshot, actor, validation_only=True)


def _normalize_configuration(input_snapshot, actor, *, validation_only=False):
    _require_actor(actor)
    if validation_only:
        # Configuration normalization never mutates records. Own metadata, borrow
        # records for reference checks, and discard the normalized result.
        snapshot = copy.deepcopy({key: value for key, value in input_snapshot.items() if key != "records"})
        snapshot["records"] = input_snapshot["records"]
    else:
        snapshot, before = copy.deepcopy(input_snapshot), rfc8785.dumps(input_snapshot)
    original = next((model for model in snapshot["models"] if model["id"] == snapshot["settings"]["modelId"]), None)
    snapshot["models"] = normalize_catalog(snapshot["models"], snapshot["manifest"]["snapshotAt"])
    if "modelVersion" not in snapshot["settings"] and original is not None and "versions" not in original:
        snapshot["settings"]["modelVersion"] = 1
    if original is None:
        _bad("The selected model is missing", "missing_model")
    if not integer(snapshot["settings"].get("modelVersion"), 1, 32):
        _bad("Settings must pin an existing published model version", "model_version_unavailable", 409)
    selected = next(model for model in snapshot["models"] if model["id"] == snapshot["settings"]["modelId"])
    if not any(item["version"] == snapshot["settings"]["modelVersion"] for item in selected["versions"]):
        _bad("Settings must pin an existing published model version", "model_version_unavailable", 409)
    now = snapshot["manifest"]["snapshotAt"]

    def legacy_name(resource_id, label):
        return resource_id[:100] if isinstance(resource_id, str) and resource_id.strip() else label

    if "sources" not in snapshot:
        snapshot["sources"] = [_new_resource(resource_id, legacy_name(resource_id, "Imported source"), default_configuration_definition("sources"), "sources", "legacy-import", now, "workspace") for resource_id in snapshot["manifest"]["scope"]["sourceIds"]]
    if "groups" not in snapshot:
        group_ids = {group_id for record in snapshot["records"] for group_id in record.get("groupIds", [])}
        snapshot["groups"] = [_new_resource(resource_id, legacy_name(resource_id, "Imported group"), {"order": order, "color": None, "collapsed": False}, "groups", "legacy-import", now, "workspace") for order, resource_id in enumerate(sorted(group_ids, key=lambda value: value.encode("utf-16-be")))]
    for field, default in (("schemas", []), ("views", []), ("defaults", {"revision": 1, "values": {}}), ("preferences", [])):
        if field not in snapshot:
            snapshot[field] = default
    if not isinstance(snapshot.get("filters"), list) or any(not isinstance(item, dict) or not integer(item.get("formatVersion"), 1, 1) or "versions" not in item for item in snapshot["filters"]):
        _bad("Noncanonical filters require an explicit legacy migration report", "configuration_migration_required")
    validate_json(snapshot)
    _assert_shape({key: snapshot[key] for key in (*FAMILIES, "defaults", "preferences")}, CHECK_STATE, "Invalid portable configuration")
    for family in FAMILIES:
        seen = set()
        for resource in snapshot[family]:
            _validate_envelope(resource, family)
            if resource["id"] in seen:
                _bad("Duplicate configuration identity")
            seen.add(resource["id"])
    scope = snapshot["manifest"]["scope"]["sourceIds"]
    if len(set(scope)) != len(scope) or len(snapshot["sources"]) != len(scope) or any(item["id"] not in scope for item in snapshot["sources"]):
        _bad("Source catalog and complete source scope differ")
    for family in FAMILIES:
        for resource in snapshot[family]:
            context = {"snapshot": snapshot, "visibility": resource["visibility"], "ownerId": resource["ownerId"]}
            definitions = [item["definition"] for item in resource["versions"]] + ([] if resource["draft"] is None else [resource["draft"]])
            for definition in definitions:
                _require_definition(family, definition, context)
    principals = set()
    _validate_settings(snapshot["settings"], {"snapshot": snapshot, "visibility": "workspace"})
    _validate_settings(snapshot["defaults"]["values"], {"snapshot": snapshot, "visibility": "workspace"})
    for preference in snapshot["preferences"]:
        if preference["principalId"] in principals:
            _bad("Duplicate principal preference")
        principals.add(preference["principalId"])
        _validate_settings(preference["values"], {"snapshot": snapshot, "visibility": "personal", "ownerId": preference["principalId"]})
    for record in snapshot["records"]:
        _resource_at(snapshot, "sources", record["sourceId"])
        for group_id in record.get("groupIds", []):
            _resource_at(snapshot, "groups", group_id)
        if (record.get("schemaId") is None) != (record.get("schemaVersion") is None):
            _bad("Record schema pins must appear together")
        if record.get("schemaId") is not None:
            _publication(snapshot, "schemas", {"id": record["schemaId"], "version": record["schemaVersion"]}, {"visibility": "workspace"})
    effective_settings(snapshot)
    for preference in snapshot["preferences"]:
        effective_settings(snapshot, principal_id=preference["principalId"])
    if not validation_only and rfc8785.dumps(snapshot) != before:
        snapshot["manifest"].pop("contentSha256", None)
    return snapshot


def configuration_usage(snapshot, family, resource_id, version=None):
    _family_name(family)
    references = []

    def add(target, pin, descriptor):
        if target == family and pin is not None and pin.get("id") == resource_id and (version is None or pin.get("version") == version):
            references.append(descriptor)

    for record in snapshot.get("records", []):
        descriptor = {"kind": "tombstone" if record.get("deletedAt") else "record", "id": record["id"]}
        add("sources", {"id": record["sourceId"]}, {**descriptor, "path": "/sourceId"})
        for group_id in record.get("groupIds", []):
            add("groups", {"id": group_id}, {**descriptor, "path": "/groupIds"})
        add("schemas", {"id": record.get("schemaId"), "version": record.get("schemaVersion")}, {**descriptor, "path": "/schemaId"})

    def from_settings(values, descriptor):
        for target, pin in _settings_pins(values):
            add(target, pin, {**descriptor, "path": {"models": "/modelId", "filters": "/filterId", "views": "/viewId"}[target]})
        if values.get("definitionVersion") != 2:
            for group_id in values.get("collapsedGroups", []):
                add("groups", {"id": group_id}, {**descriptor, "path": "/collapsedGroups"})

    for source_family in FAMILIES:
        for resource in snapshot.get(source_family, []):
            versions = resource["versions"] + ([] if resource["draft"] is None else [{"version": None, "definition": resource["draft"]}])
            for item in versions:
                descriptor = {"kind": "resource", "family": source_family, "id": resource["id"], "version": item["version"], "visibility": resource["visibility"], "ownerId": resource["ownerId"]}
                definition = item["definition"]
                if source_family == "sources":
                    add("schemas", definition["defaultSchema"], {**descriptor, "path": "/defaultSchema"})
                if source_family == "filters":
                    for source_id in definition["sourceIds"] or []:
                        add("sources", {"id": source_id}, {**descriptor, "path": "/sourceIds"})
                    for pin in definition["schemaRefs"]:
                        add("schemas", pin, {**descriptor, "path": "/schemaRefs"})
                if source_family == "views":
                    add("models", definition["model"], {**descriptor, "path": "/model"})
                    add("filters", definition["filter"], {**descriptor, "path": "/filter"})
                    from_settings(definition["settings"], descriptor)
    from_settings(snapshot["settings"], {"kind": "active-settings"})
    from_settings(snapshot.get("defaults", {}).get("values", {}), {"kind": "workspace-defaults"})
    for preference in snapshot.get("preferences", []):
        from_settings(preference["values"], {"kind": "personal-preferences", "principalId": preference["principalId"]})
    return references


def _merge_settings(target, source, origins, origin):
    def record(value, path):
        if isinstance(value, dict):
            for key, child in value.items():
                record(child, path + "/" + _pointer(key))
        else:
            origins[path] = origin

    for key, value in source.items():
        if key == "search" and isinstance(value, dict) and (value.get("mode") == "regex" or target.get("search", {}).get("mode") == "regex" and "mode" in value and value["mode"] != "regex"):
            for path in list(origins):
                if path.startswith("/search/"):
                    del origins[path]
            target["search"] = copy.deepcopy(value)
            record(value, "/search")
            continue
        if key in ("range", "overview", "search", "table") and isinstance(value, dict):
            target[key] = {**target.get(key, {}), **copy.deepcopy(value)}
            for child, item in value.items():
                record(item, "/" + _pointer(key) + "/" + _pointer(child))
        else:
            for path in list(origins):
                if path == "/" + _pointer(key) or path.startswith("/" + _pointer(key) + "/"):
                    del origins[path]
            target[key] = copy.deepcopy(value)
            record(value, "/" + _pointer(key))


def effective_settings(snapshot, *, view_id=_UNSET, view_version=_UNSET, principal_id=None, transient=_UNSET):
    transient = {} if transient is _UNSET else transient
    values, origins = {}, {}
    preference = next((item for item in snapshot.get("preferences", []) if item["principalId"] == principal_id), None)
    personal = preference["values"] if preference else {}
    _validate_settings(transient, {"snapshot": snapshot, "visibility": "personal", "ownerId": principal_id})
    selector, selector_origins = {}, {}
    _merge_settings(selector, snapshot["settings"], selector_origins, "workspace-active")
    _merge_settings(selector, snapshot.get("defaults", {}).get("values", {}), selector_origins, "workspace-defaults")
    _merge_settings(selector, personal, selector_origins, f"personal:{principal_id}")
    _merge_settings(selector, transient, selector_origins, "transient")
    if view_id is not _UNSET or view_version is not _UNSET:
        if view_id is _UNSET or view_version is _UNSET:
            _bad("Explicit view selection requires paired identity and version")
        _merge_settings(selector, {"viewId": view_id, "viewVersion": view_version}, selector_origins, "preview")
    _settings_pins(selector)
    context = {"visibility": "personal" if principal_id else "workspace", "ownerId": principal_id}
    view = _publication(snapshot, "views", {"id": selector["viewId"], "version": selector["viewVersion"]}, context) if selector.get("viewId") is not None else None
    model_pin = view["model"] if view else {"id": selector.get("modelId"), "version": selector.get("modelVersion")}
    model = _publication(snapshot, "models", model_pin, context)
    filter_pin = view["filter"] if view else None if selector.get("filterId") is None else {"id": selector["filterId"], "version": selector["filterVersion"]}
    selected_filter = _publication(snapshot, "filters", filter_pin, context) if filter_pin else None
    _merge_settings(values, {**DEFAULT_DEFINITION, "mode": "timeline", "collapsedGroups": [], "search": {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title", "/data/description", "/data/text", "/data/system", "/data/type", "/data/status"]}}, origins, "application")
    _merge_settings(values, snapshot["settings"], origins, "workspace-active")
    _merge_settings(values, snapshot.get("defaults", {}).get("values", {}), origins, "workspace-defaults")
    _merge_settings(values, model, origins, f"model:{model_pin['id']}@{model_pin['version']}")
    if selected_filter:
        versioned = {"definitionVersion": 2, "relationshipMode": selected_filter.get("relationshipMode", "independent")} if selected_filter.get("definitionVersion") == 2 else {}
        _merge_settings(values, {**versioned, "search": selected_filter["search"]}, origins, f"filter:{filter_pin['id']}@{filter_pin['version']}")
    if view:
        if view.get("definitionVersion", 1) == 1 and selected_filter and selected_filter.get("definitionVersion") == 2:
            _bad("A version 1 view cannot pin a version 2 filter; explicitly upgrade the view")
        versioned = {"definitionVersion": 2} if view.get("definitionVersion") == 2 else {}
        _merge_settings(values, {**versioned, **view["settings"]}, origins, f"view:{selector['viewId']}@{selector['viewVersion']}")
    _merge_settings(values, personal, origins, f"personal:{principal_id}")
    _merge_settings(values, transient, origins, "transient")
    pins = {"modelId": model_pin["id"], "modelVersion": model_pin["version"]}
    if view:
        pins.update(filterId=view["filter"]["id"] if view["filter"] else None, filterVersion=view["filter"]["version"] if view["filter"] else None)
    for key, value in pins.items():
        _merge_settings(values, {key: value}, origins, f"view:{selector['viewId']}@{selector['viewVersion']}" if view else selector_origins.get("/" + key))
    if "viewId" in selector:
        for key in ("viewId", "viewVersion"):
            _merge_settings(values, {key: selector[key]}, origins, selector_origins["/" + key])
    saved_filter = _publication(snapshot, "filters", {"id": values["filterId"], "version": values["filterVersion"]}, context) if values.get("filterId") is not None else None
    registry = filter_field_types(snapshot, saved_filter["schemaRefs"]) if saved_filter else REGISTRY_BASE
    _validate_settings(values, {"snapshot": snapshot, **context, "registry": registry})
    detail, overview = values.get("range", {}), values.get("overview", {})
    if all(detail.get(key) and overview.get(key) for key in ("from", "to")) and (instant_ms(detail["from"]) < instant_ms(overview["from"]) or instant_ms(detail["to"]) > instant_ms(overview["to"])):
        _bad("Detail range must be contained by the overview")
    return {"values": values, "origins": origins, "preferenceRevision": preference["revision"] if preference else 0}


def _authorize_mutation(resource, actor, publish=False):
    permitted = _has(actor, "configuration.manage") or (resource["visibility"] == "personal" and resource["ownerId"] == actor["id"] and _has(actor, "configuration.personal"))
    if not permitted or (publish and resource["visibility"] == "workspace" and not _has(actor, "configuration.publish")):
        _bad("Configuration permission is required", "configuration_forbidden", 403)


def apply_configuration_command(input_snapshot, input_command, *, actor, now=None, create_id=None):
    _require_actor(actor)
    now, create_id = now or now_iso(), create_id or (lambda: str(uuid.uuid4()))
    command = copy.deepcopy(input_command)
    validate_json(command)
    _timestamp(now)
    _payload_keys(command, ("family", "type", "resourceId", "expectedRevision", "expectedPreferenceRevision", "generation", "clientCommandId", "payload"), ("family", "type", "clientCommandId"))
    if command["family"] not in FAMILIES:
        _bad("Unknown configuration family")
    if command.get("generation") is None:
        _bad("Workspace generation is required", "precondition_required", 428)
    if command["generation"] != input_snapshot["manifest"]["generation"]:
        _bad("Workspace generation changed", "workspace_generation_conflict", 409)
    if not isinstance(command["clientCommandId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", command["clientCommandId"]):
        _bad("A valid client command identity is required")
    snapshot = normalize_configuration(input_snapshot, actor)
    family, operation = command["family"], command["type"]
    payload = {} if command.get("payload") is None else command["payload"]
    resource = None

    def create(definition, copied_from=None):
        nonlocal resource
        if len(snapshot[family]) >= 100:
            _bad("Configuration catalog is full", "configuration_capacity", 413)
        visibility = payload.get("visibility", "workspace" if family in ("sources", "groups") else "personal")
        if visibility not in ("workspace", "personal"):
            _bad("Invalid visibility")
        resource = _new_resource(create_id(), payload["name"], definition, family, actor["id"], now, visibility)
        if not isinstance(resource["id"], str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", resource["id"]) or any(item["id"] == resource["id"] for item in snapshot[family]):
            _bad("Provider must assign a fresh UUID")
        _authorize_mutation(resource, actor, family in ("sources", "groups"))
        _require_definition(family, definition, {"snapshot": snapshot, "actor": actor, "visibility": visibility, "ownerId": actor["id"], "newReference": True})
        resource["copiedFrom"] = copied_from
        snapshot[family].append(resource)
        if family == "sources":
            snapshot["manifest"]["scope"]["sourceIds"].append(resource["id"])

    if operation == "create":
        _payload_keys(payload, ("name", "description", "tags", "visibility", "definition"), ("name", "definition"))
        create(payload["definition"])
        for key in ("description", "tags"):
            if key in payload:
                resource[key] = copy.deepcopy(payload[key])
    else:
        if operation not in ("update", "publish", "archive", "unarchive", "delete", "duplicate", "apply"):
            _bad("Unsupported configuration command")
        resource = _resource_at(snapshot, family, command.get("resourceId"), {"actor": actor})
        if command.get("expectedRevision") is None:
            _bad("Expected resource revision is required", "precondition_required", 428)
        if not integer(command["expectedRevision"], 1, MAX_SAFE_INT) or command["expectedRevision"] != resource["revision"]:
            _bad("Configuration resource changed", "configuration_revision_conflict", 412)
        if operation not in ("duplicate", "apply"):
            _authorize_mutation(resource, actor, operation == "publish")
        if resource["lifecycle"] == "archived" and operation in ("update", "publish", "apply"):
            _bad("Unarchive the resource before this operation", "configuration_archived", 409)
        context = {"snapshot": snapshot, "actor": actor, "visibility": resource["visibility"], "ownerId": resource["ownerId"], "newReference": True}
        if operation == "update":
            _payload_keys(payload, ("name", "description", "tags", "draft"))
            if not payload:
                _bad("An update requires a mutable field")
            if "draft" in payload:
                _require_definition(family, payload["draft"], context)
            resource.update(copy.deepcopy(payload))
        elif operation == "duplicate":
            _payload_keys(payload, ("name", "version", "visibility"), ("name",))
            old = resource
            version = payload["version"] if "version" in payload else None if old["draft"] is not None else old["versions"][-1]["version"]
            if version is not None and not integer(version, 1, 32):
                _bad("Invalid duplicate version")
            definition = old["draft"] if version is None else _publication(snapshot, family, {"id": old["id"], "version": version}, {"actor": actor})
            create(definition, {"family": family, "id": old["id"], "version": version})
        elif operation == "apply":
            _payload_keys(payload, ("version",), ("version",))
            if family not in ("filters", "views"):
                _bad("Only filters and views can be applied")
            if not _has(actor, "configuration.personal") and not _has(actor, "configuration.manage"):
                _bad("Applying settings requires configuration permission", "configuration_forbidden", 403)
            if not integer(payload["version"], 1, 32):
                _bad("Invalid published version")
            definition = _publication(snapshot, family, {"id": resource["id"], "version": payload["version"]}, context)
            _require_definition(family, definition, context)
            preference = next((item for item in snapshot["preferences"] if item["principalId"] == actor["id"]), None)
            if command.get("expectedPreferenceRevision") is None:
                _bad("Expected preference revision is required", "precondition_required", 428)
            if not integer(command["expectedPreferenceRevision"], 0, MAX_SAFE_INT) or command["expectedPreferenceRevision"] != (preference["revision"] if preference else 0):
                _bad("Personal preferences changed", "configuration_preference_revision_conflict", 412)
            if preference:
                if preference["revision"] == MAX_SAFE_INT:
                    _bad("Preference revision capacity reached", "configuration_capacity", 413)
                preference["revision"] += 1
            else:
                if len(snapshot["preferences"]) >= 100:
                    _bad("Preference catalog is full", "configuration_capacity", 413)
                preference = {"principalId": actor["id"], "revision": 1, "values": {}}
                snapshot["preferences"].append(preference)
            if family == "filters":
                preference["values"].update(filterId=resource["id"], filterVersion=payload["version"], viewId=None, viewVersion=None)
            else:
                preference["values"].update(modelId=definition["model"]["id"], modelVersion=definition["model"]["version"], filterId=definition["filter"]["id"] if definition["filter"] else None, filterVersion=definition["filter"]["version"] if definition["filter"] else None, viewId=resource["id"], viewVersion=payload["version"])
        else:
            _payload_keys(payload, ())
            if operation == "publish":
                if resource["draft"] is None:
                    _bad("Save a draft before publishing", "configuration_draft_missing", 409)
                if len(resource["versions"]) >= 32:
                    _bad("Publication history is full", "configuration_capacity", 413)
                _require_definition(family, resource["draft"], context)
                resource["versions"].append({"version": len(resource["versions"]) + 1, "publishedAt": now, "publishedBy": actor["id"], "definition": copy.deepcopy(resource["draft"])})
                resource["draft"] = None
            elif operation in ("archive", "unarchive"):
                lifecycle = "archived" if operation == "archive" else "active"
                if resource["lifecycle"] == lifecycle:
                    _bad("Resource already has this lifecycle", "configuration_lifecycle_conflict", 409)
                resource["lifecycle"] = lifecycle
            else:
                if configuration_usage(snapshot, family, resource["id"]):
                    _bad("Resource is referenced", "configuration_referenced", 409)
                snapshot[family].remove(resource)
                if family == "sources":
                    snapshot["manifest"]["scope"]["sourceIds"] = [resource_id for resource_id in snapshot["manifest"]["scope"]["sourceIds"] if resource_id != resource["id"]]
                resource = None
        if resource is not None and operation not in ("duplicate", "apply"):
            if resource["revision"] == MAX_SAFE_INT:
                _bad("Configuration revision capacity reached", "configuration_capacity", 413)
            resource["revision"] += 1
            resource["updatedAt"] = now
    if resource is not None:
        _validate_envelope(resource, family)
    snapshot["manifest"].pop("contentSha256", None)
    result = {"snapshot": snapshot, "resource": resource}
    if operation == "apply":
        result["effectiveSettings"] = effective_settings(snapshot, principal_id=actor["id"])
        definition = next(item["definition"] for item in resource["versions"] if item["version"] == payload["version"])
        keys = ["filterId", "filterVersion", "viewId", "viewVersion", "search", *(["definitionVersion", "relationshipMode"] if definition.get("definitionVersion") == 2 else [])] if family == "filters" else ["modelId", "modelVersion", "filterId", "filterVersion", "viewId", "viewVersion", *(["search"] if definition["filter"] else []), *definition["settings"]]
        result["resetTransientKeys"] = list(dict.fromkeys(keys))
    return result
