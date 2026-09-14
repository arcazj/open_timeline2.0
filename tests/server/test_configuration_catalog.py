import copy
import hashlib
import json
import subprocess
from pathlib import Path

import pytest
import rfc8785

from server.app.models.configuration_catalog import (
    apply_configuration_command, configuration_usage, default_configuration_definition,
    effective_settings, filter_field_types, normalize_configuration, resolved_data_schema,
    validate_resource_definition, validate_configuration,
)
from server.app.models.domain import DomainError, MAX_SAFE_INT, read_json
from server.app.models.settings_commands import apply_settings_command

ROOT = Path(__file__).resolve().parents[2]
ACTOR = {"id": "admin", "capabilities": ["*"]}
PERSONAL = {"id": "alice", "capabilities": ["configuration.read", "configuration.personal"]}
NOW = "2026-09-13T00:00:00.000Z"


def sample():
    return read_json(ROOT / "shared/fixtures/initial-snapshot.json")


def normalized():
    return normalize_configuration(sample(), ACTOR)


@pytest.mark.parametrize('problem', [None, 'source', 'group', 'schema', 'model', 'json'])
def test_validation_only_matches_normalization_without_mutation(problem, monkeypatch):
    snapshot = normalized()
    if problem == 'source':
        snapshot['records'][0]['sourceId'] = 'missing'
    if problem == 'group':
        snapshot['records'][0]['groupIds'] = ['missing']
    if problem == 'schema':
        snapshot['records'][0].update(schemaId='missing', schemaVersion=1)
    if problem == 'model':
        snapshot['settings']['modelVersion'] = 32
    if problem == 'json':
        snapshot['records'][0]['extensions']['bad'] = MAX_SAFE_INT + 1
    before = copy.deepcopy(snapshot)
    expected = None
    try:
        normalize_configuration(snapshot, ACTOR)
    except DomainError as error:
        expected = error.code
    except rfc8785.IntegerDomainError:
        expected = 'invalid_json'
    # Fingerprinting an entire record archive is unnecessary for validation.
    original_dumps = rfc8785.dumps
    def dumps(value):
        assert not isinstance(value, dict) or 'records' not in value
        return original_dumps(value)
    monkeypatch.setattr(rfc8785, 'dumps', dumps)
    actual = None
    try:
        validate_configuration(snapshot, ACTOR)
    except DomainError as error:
        actual = error.code
    assert actual == expected
    assert snapshot == before


def command(snapshot, family, operation, payload=None, resource=None, actor=ACTOR, identity=1):
    value = {"family": family, "type": operation, "generation": snapshot["manifest"]["generation"], "clientCommandId": f"command-{identity}", "payload": payload or {}}
    if resource:
        value.update(resourceId=resource["id"], expectedRevision=resource["revision"])
    if operation == "apply":
        value["expectedPreferenceRevision"] = next((item["revision"] for item in snapshot["preferences"] if item["principalId"] == actor["id"]), 0)
    return value


def apply(snapshot, family, operation, payload=None, resource=None, actor=ACTOR, identity=1):
    return apply_configuration_command(snapshot, command(snapshot, family, operation, payload, resource, actor, identity), actor=actor, now=NOW, create_id=lambda: f"00000000-0000-4000-8000-{identity:012}")


def publish(snapshot, family, definition=None, actor=ACTOR, visibility="workspace", identity=1):
    definition = default_configuration_definition(family, snapshot) if definition is None else definition
    result = apply(snapshot, family, "create", {"name": family, "definition": definition, "visibility": visibility}, actor=actor, identity=identity)
    if not result["resource"]["versions"]:
        result = apply(result["snapshot"], family, "publish", resource=result["resource"], actor=actor, identity=identity + 1)
    return result


def javascript(requests):
    result = subprocess.run(["node", str(ROOT / "tests/client/fixtures/configuration-runner.mjs")], input=json.dumps({"requests": requests}), text=True, encoding="utf-8", capture_output=True, cwd=ROOT, check=True, timeout=60)
    return json.loads(result.stdout)


def python_result(request):
    try:
        method = request["method"]
        if method == "normalize":
            result = normalize_configuration(request["snapshot"], request["actor"])
        elif method == "apply":
            result = apply_configuration_command(request["snapshot"], request["command"], actor=request["actor"], now=request["now"], create_id=lambda: request["createId"])
        elif method == "effective":
            keys = {"viewId": "view_id", "viewVersion": "view_version", "principalId": "principal_id", "transient": "transient"}
            result = effective_settings(request["snapshot"], **{keys[key]: value for key, value in request.get("options", {}).items()})
        elif method == "settings":
            result = apply_settings_command(request["snapshot"], request["command"], request["actor"])
        elif method == "validate":
            result = {"valid": validate_resource_definition(request["family"], request["definition"], request.get("context"))["valid"]}
        elif method == "usage":
            result = configuration_usage(request["snapshot"], request["family"], request["id"], request.get("version"))
        elif method == "fields":
            result = filter_field_types(request["snapshot"], request.get("schemaRefs"))
        elif method == "schema":
            result = resolved_data_schema(request["definition"])
        elif method == "hash":
            result = hashlib.sha256(rfc8785.dumps(request["value"])).hexdigest()
        else:
            raise AssertionError(method)
        return {"result": result}
    except DomainError as error:
        return {"error": {"code": error.code, "status": error.status}}


def assert_parity(requests):
    actual = javascript(requests)
    for index, (request, result) in enumerate(zip(requests, actual, strict=True)):
        expected = python_result(request)
        assert result == expected, f"Case {index}: {request['method']}"


def test_normalization_checksums_complete_scope_and_timestamps():
    original = sample()
    original["manifest"]["contentSha256"] = "prior-verified-hash"
    original["manifest"]["scope"]["sourceIds"].append("empty.source / north")
    original["records"][0]["groupIds"] = ["\U00010000", "\ue000", "group:one"]
    original["records"][0]["deletedAt"] = NOW
    before = copy.deepcopy(original)
    result = normalize_configuration(original, ACTOR)
    assert original == before
    assert len(result["sources"]) == 3
    assert [item["id"] for item in result["groups"]] == ["group:one", "\U00010000", "\ue000"]
    assert result["sources"][0]["createdAt"] == original["manifest"]["snapshotAt"]
    assert "contentSha256" not in result["manifest"]
    result["manifest"]["contentSha256"] = "new-verified-hash"
    assert normalize_configuration(result, ACTOR) == result
    assert_parity([{"method": "normalize", "snapshot": original, "actor": ACTOR}, {"method": "normalize", "snapshot": result, "actor": ACTOR}, {"method": "hash", "value": result}])


@pytest.mark.parametrize("family", ["sources", "groups", "schemas", "filters", "views"])
def test_resource_lifecycle_and_pure_command_parity(family):
    snapshot = normalized()
    definition = default_configuration_definition(family, snapshot)
    requests = []
    actions = [("create", {"name": "Mission \U0001f680", "description": "Canonical \u00e9 / e\u0301", "definition": definition, "visibility": "workspace"}),
               ("update", {"name": "Revised name", "draft": definition}), ("publish", {}), ("archive", {}), ("unarchive", {}), ("duplicate", {"name": "Independent copy"})]
    resource = None
    for index, (operation, payload) in enumerate(actions, 1):
        value = command(snapshot, family, operation, payload, resource, identity=index)
        request = {"method": "apply", "snapshot": snapshot, "command": value, "actor": ACTOR, "now": NOW, "createId": f"00000000-0000-4000-8000-{index:012}"}
        requests.append(request)
        result = python_result(request)["result"]
        snapshot, resource = result["snapshot"], result["resource"]
    assert resource["copiedFrom"]["family"] == family
    assert_parity(requests)


def test_immutable_publications_private_visibility_and_personal_apply():
    result = publish(normalized(), "views", actor=PERSONAL, visibility="personal")
    resource, snapshot = result["resource"], result["snapshot"]
    original_settings, original_resource = copy.deepcopy(snapshot["settings"]), copy.deepcopy(resource)
    value = command(snapshot, "views", "apply", {"version": 1}, resource, PERSONAL)
    applied = apply_configuration_command(snapshot, value, actor=PERSONAL, now=NOW)
    assert applied["snapshot"]["settings"] == original_settings
    assert applied["resource"] == original_resource
    assert applied["effectiveSettings"]["preferenceRevision"] == 1
    assert applied["effectiveSettings"]["origins"]["/viewId"] == "personal:alice"
    assert normalize_configuration(applied["snapshot"], ACTOR) == applied["snapshot"]
    requests = [{"method": "apply", "snapshot": snapshot, "command": value, "actor": PERSONAL, "now": NOW},
                {"method": "effective", "snapshot": applied["snapshot"], "options": {"principalId": "alice"}},
                {"method": "effective", "snapshot": applied["snapshot"], "options": {"principalId": "bob"}},
                {"method": "effective", "snapshot": applied["snapshot"], "options": {"principalId": "alice", "viewId": None, "viewVersion": None}},
                {"method": "effective", "snapshot": applied["snapshot"], "options": {"principalId": "alice", "transient": {"viewId": None, "viewVersion": None}}},
                {"method": "effective", "snapshot": applied["snapshot"], "options": {"principalId": "alice", "viewId": resource["id"]}},
                {"method": "usage", "snapshot": applied["snapshot"], "family": "views", "id": resource["id"], "version": 1}]
    stranger = {"id": "bob", "capabilities": ["configuration.personal", "configuration.read"]}
    requests.append({"method": "apply", "snapshot": snapshot, "command": value, "actor": stranger, "now": NOW})
    stale = copy.deepcopy(value)
    requests.append({"method": "apply", "snapshot": applied["snapshot"], "command": stale, "actor": PERSONAL, "now": NOW})
    missing = copy.deepcopy(value)
    del missing["expectedPreferenceRevision"]
    requests.append({"method": "apply", "snapshot": snapshot, "command": missing, "actor": PERSONAL, "now": NOW})
    assert_parity(requests)


def test_every_reference_edge_and_tombstone_survives_archive_and_blocks_delete():
    data = default_configuration_definition("schemas")
    data["schema"]["properties"]["score"] = {"type": "number"}
    result = publish(normalized(), "schemas", data)
    schema_id, snapshot = result["resource"]["id"], result["snapshot"]
    pin = {"id": schema_id, "version": 1}
    definition = default_configuration_definition("filters")
    definition["schemaRefs"] = [pin]
    definition["expression"] = {"version": 1, "root": {"op": "gte", "field": "/data/score", "value": 2}}
    saved = publish(snapshot, "filters", definition, identity=3)
    snapshot = saved["snapshot"]
    snapshot["records"][0].update(schemaId=schema_id, schemaVersion=1, deletedAt=NOW)
    source = apply(snapshot, "sources", "update", {"draft": {**default_configuration_definition("sources"), "defaultSchema": pin}}, snapshot["sources"][0], identity=5)
    snapshot = source["snapshot"]
    usages = configuration_usage(snapshot, "schemas", schema_id)
    assert {item["kind"] for item in usages} == {"resource", "tombstone"}
    assert any(item.get("version") is None and item.get("family") == "sources" for item in usages)
    request = {"method": "apply", "snapshot": snapshot, "command": command(snapshot, "schemas", "delete", resource=result["resource"]), "actor": ACTOR, "now": NOW}
    assert python_result(request) == {"error": {"code": "configuration_referenced", "status": 409}}
    assert_parity([request, {"method": "usage", "snapshot": snapshot, "family": "schemas", "id": schema_id, "version": 1}])


def test_bounded_data_schema_native_validation_and_admission_parity():
    valid = default_configuration_definition("schemas")
    valid["schema"]["$defs"] = {"score": {"type": "integer", "minimum": 0, "maximum": 10}}
    valid["schema"]["properties"] = {"score": {"$ref": "#/$defs/score"}, "flag": {"type": ["boolean", "null"]}}
    definitions = [valid]
    for path, value in [("recursive", {"$ref": "#/$defs/score"}), ("remote", {"$ref": "https://example.invalid/schema"}), ("pattern", {"type": "string", "pattern": "(a+)+$"}), ("malformed", {"type": "string", "maxLength": -1}), ("boolean", False)]:
        invalid = copy.deepcopy(valid)
        if path == "recursive":
            invalid["schema"]["$defs"]["score"] = value
        else:
            invalid["schema"]["properties"]["invalid"] = value
        definitions.append(invalid)
    assert validate_resource_definition("schemas", valid)["valid"]
    assert all(not validate_resource_definition("schemas", item)["valid"] for item in definitions[1:])
    assert_parity([{"method": "validate", "family": "schemas", "definition": item} for item in definitions] + [{"method": "schema", "definition": valid}])


def test_scoped_custom_fields_settings_search_and_provenance_match_javascript():
    definition = default_configuration_definition("schemas")
    definition["schema"]["properties"] = {"score": {"type": "number"}, "flag": {"type": "boolean"}, "nested": {"type": "object", "properties": {"a/b": {"type": "string"}}, "additionalProperties": False}}
    data = publish(normalized(), "schemas", definition)
    pin = {"id": data["resource"]["id"], "version": 1}
    saved_filter = default_configuration_definition("filters")
    saved_filter.update(schemaRefs=[pin], expression={"version": 1, "root": {"op": "eq", "field": "/data/flag", "value": False}})
    saved_filter["search"]["text"] = '"Flight ready"'
    saved = publish(data["snapshot"], "filters", saved_filter, identity=3)
    view = default_configuration_definition("views", saved["snapshot"])
    view.update(filter={"id": saved["resource"]["id"], "version": 1}, settings={"columns": [{"field": "/data/score", "visible": True, "width": 140}], "rowHeight": 52})
    saved_view = publish(saved["snapshot"], "views", view, identity=5)
    applied = apply(saved_view["snapshot"], "views", "apply", {"version": 1}, saved_view["resource"], PERSONAL)
    snapshot = applied["snapshot"]
    assert filter_field_types(snapshot, [pin])["/data/nested/a~1b"] == "string"
    assert effective_settings(snapshot, principal_id="alice")["values"]["search"]["text"] == '"Flight ready"'
    requests = [{"method": "fields", "snapshot": snapshot, "schemaRefs": [pin]},
                {"method": "effective", "snapshot": snapshot, "options": {"principalId": "alice", "transient": {"search": {"text": "2", "fields": ["/data/score"]}, "rowHeight": 60}}},
                {"method": "normalize", "snapshot": snapshot, "actor": ACTOR}]
    for predicate in ({"op": "eq", "field": "/data/flag", "value": True}, {"op": "eq", "field": "/data/flag", "value": None}, {"op": "eq", "field": "/data/flag"}, {"op": "in", "field": "/data/flag", "values": [True, None]}, {"op": "gt", "field": "/data/flag", "value": True}, {"op": "eq", "field": "/data/score", "value": "2"}):
        value = copy.deepcopy(saved_filter)
        value["expression"]["root"] = predicate
        requests.append({"method": "validate", "family": "filters", "definition": value, "context": {"snapshot": snapshot}})
    assert_parity(requests)


@pytest.mark.parametrize("field,value", [("generation", None), ("generation", "wrong"), ("expectedRevision", None), ("expectedRevision", True), ("expectedRevision", 2), ("payload", []), ("payload", False)])
def test_command_error_parity_and_atomic_inputs(field, value):
    snapshot = normalized()
    request = {"method": "apply", "snapshot": snapshot, "command": command(snapshot, "sources", "archive", resource=snapshot["sources"][0]), "actor": ACTOR, "now": NOW}
    request["command"][field] = value
    before = copy.deepcopy(request)
    assert "error" in python_result(request)
    assert request == before
    assert_parity([request])


def test_capacity_and_private_schema_record_refs_cannot_be_forged():
    result = publish(normalized(), "schemas", actor=PERSONAL, visibility="personal")
    result["snapshot"]["records"][0].update(schemaId=result["resource"]["id"], schemaVersion=1)
    assert_parity([{"method": "normalize", "snapshot": result["snapshot"], "actor": ACTOR}])
    with pytest.raises(DomainError, match="private") as error:
        normalize_configuration(result["snapshot"], ACTOR)
    assert error.value.status == 403
    snapshot = normalized()
    snapshot["sources"][0]["revision"] = MAX_SAFE_INT
    before = copy.deepcopy(snapshot)
    with pytest.raises(DomainError) as error:
        apply(snapshot, "sources", "update", {"name": "new"}, snapshot["sources"][0])
    assert error.value.status == 413
    assert snapshot == before


def test_one_thousand_seeded_mutations_preserve_publication_hashes_and_input_revisions():
    result = publish(normalized(), "groups")
    history = rfc8785.dumps(result["resource"]["versions"])
    seed = 13219
    for index in range(1000):
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        previous = result
        result = apply(previous["snapshot"], "groups", "update", {"name": f"Group {seed}", "tags": [f"seed-{seed % 7}"]}, previous["resource"], identity=index + 10)
        assert result["resource"]["revision"] == previous["resource"]["revision"] + 1
        assert rfc8785.dumps(result["resource"]["versions"]) == history
        assert rfc8785.dumps(normalize_configuration(result["snapshot"], ACTOR)) == rfc8785.dumps(result["snapshot"])
    assert_parity([{"method": "normalize", "snapshot": result["snapshot"], "actor": ACTOR}, {"method": "hash", "value": result["snapshot"]}])


def test_settings_patch_replace_reset_and_invalid_preconditions_match_javascript():
    snapshot, requests = normalized(), []
    for index, (operation, payload) in enumerate([
        ("patch", {"rowHeight": 52, "search": {"mode": "all", "text": "needle"}}),
        ("patch", {"search": {"text": "updated"}}),
        ("reset", {"paths": ["/search/text", "/rowHeight"]}),
        ("replace", {"fontSize": 15, "rowHeight": 48}),
        ("reset", {"paths": None}),
    ]):
        value = {"scope": "personal", "type": operation, "expectedRevision": index, "generation": snapshot["manifest"]["generation"], "clientCommandId": f"settings-{index}", "payload": payload}
        request = {"method": "settings", "snapshot": snapshot, "command": value, "actor": PERSONAL}
        requests.append(request)
        snapshot = python_result(request)["result"]["snapshot"]
    for field, value in [("scope", "application"), ("scope", "workspace"), ("expectedRevision", 0), ("expectedRevision", None), ("generation", "stale"), ("payload", {"paths": ["/constructor"]}), ("payload", {"paths": ["/search/text", "/search/text"]}), ("payload", {"paths": ["/search/~9"]}), ("payload", {"paths": ["/unknown"]}), ("payload", {"paths": ["/search/unknown"]}), ("payload", {"paths": ["/range/day"]})]:
        invalid = {"scope": "personal", "type": "reset", "expectedRevision": 5, "generation": snapshot["manifest"]["generation"], "clientCommandId": "invalid-settings", "payload": {"paths": None}, field: value}
        requests.append({"method": "settings", "snapshot": snapshot, "command": invalid, "actor": PERSONAL})
    assert_parity(requests)
