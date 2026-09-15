import copy
import hashlib
import json
import socket
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from server.app.api.openapi import BASE, DIALECT, SCHEMA_NAMES, build_contract, route_inventory
from server.app.main import create_app
from test_api import prepared

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "openapi-test-credential-not-for-deployment"


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path / "json", TOKEN)


@pytest.fixture
def contract(app):
    return build_contract(app)


def validate(contract, schema, value):
    registry = Registry().with_resource("urn:openbexi:contract", Resource.from_contents(contract, default_specification=DRAFT202012))
    validator = Draft202012Validator({"$ref": "urn:openbexi:contract#/components/schemas/" + schema}, registry=registry)
    errors = list(validator.iter_errors(value))
    assert not errors, "\n".join(f"{list(error.path)}: {error.message}" for error in errors)


def response_matches(contract, route, method, response):
    operation = contract["paths"][route][method.lower()]
    declared = operation["responses"][str(response.status_code)]
    if "$ref" in declared:
        declared = contract["components"]["responses"][declared["$ref"].rsplit("/", 1)[1]]
    if response.status_code == 204:
        assert not response.content and "content" not in declared
        return
    media = response.headers["content-type"].split(";")[0]
    schema = declared["content"][media]["schema"]["$ref"].removeprefix("#/components/schemas/")
    validate(contract, schema, response.json())


def test_contract_is_pinned_valid_offline_deterministic_and_matches_checked_in_artifact(app, contract, monkeypatch):
    monkeypatch.setattr(socket, "create_connection", lambda *_a, **_k: pytest.fail("Contract validation must be offline"))
    assert contract["openapi"] == "3.1.1" and contract["jsonSchemaDialect"] == DIALECT
    meta = json.loads((ROOT / "tests/fixtures/openapi-3.1-meta.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(meta).validate(contract)
    for schema in contract["components"]["schemas"].values():
        Draft202012Validator.check_schema(schema)
    assert build_contract(app) == contract
    assert json.loads((ROOT / "shared/openapi.json").read_text(encoding="utf-8")) == contract


def test_every_registered_api_operation_has_unique_contract_and_undocumented_routes_fail_closed(app, contract):
    actual = {(path, method, name) for path, method, name in route_inventory(app) if path != "/"}
    declared = {(item["path"], item["method"], item["handler"]) for item in contract["x-route-inventory"]}
    assert actual == declared
    operation_ids = []
    for path, method, name in actual:
        operation = contract["paths"][path][method.lower()]
        assert operation["x-handler"] == name
        operation_ids.append(operation["operationId"])
        assert operation["responses"]
    assert len(operation_ids) == len(set(operation_ids))
    assert not any(path.endswith(("/imports", "/backups", "/jobs")) for path in contract["paths"])
    assert BASE + "/changes/stream" in contract["paths"]

    @app.get("/api/v1/new-undocumented-operation")
    def undocumented():
        return {}

    with pytest.raises(ValueError, match="no explicit OpenAPI contract"):
        build_contract(app)


def test_explicitly_private_routes_do_not_break_public_contract(app, contract):
    @app.get("/api/v1/local-sources", include_in_schema=False)
    def local_sources():
        return {"sources": []}

    assert build_contract(app) == contract


def test_change_feed_wire_and_stream_contract_match_registered_handlers(app, contract):
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        metadata = client.get(BASE).json()
        params = {"generation": metadata["generation"], "afterRevision": metadata["revision"]}
        response = client.get(BASE + "/changes", params=params)
        response_matches(contract, BASE + "/changes", "GET", response)
        committed = client.post(BASE + "/records", json={"title": "Not present in metadata feed"}, headers={"X-Workspace-Generation": metadata["generation"], "Idempotency-Key": "openapi-change"})
        assert committed.status_code == 201
        response = client.get(BASE + "/changes", params={**params, "scope": response.json()["scope"]})
        response_matches(contract, BASE + "/changes", "GET", response)
        assert len(response.json()["changes"]) == 1
        invalid = client.get(BASE + "/changes/stream", params={**params, "limit": 501})
        response_matches(contract, BASE + "/changes/stream", "GET", invalid)
        assert invalid.status_code == 422
    operation = contract["paths"][BASE + "/changes/stream"]["get"]
    assert "text/event-stream" in operation["responses"]["200"]["content"]
    limits = {parameter["name"]: parameter for parameter in operation["parameters"]}
    assert limits["generation"]["required"] and limits["afterRevision"]["required"]
    assert limits["limit"]["schema"]["maximum"] == 500
    assert limits["scope"]["schema"]["minLength"] == 64


def test_shared_schema_hashes_references_and_all_examples_resolve_without_external_access(contract):
    for filename, name in SCHEMA_NAMES.items():
        schema = contract["components"]["schemas"][name]
        assert schema["x-source-sha256"] == hashlib.sha256((ROOT / "shared/schemas" / filename).read_bytes()).hexdigest()
        assert schema["$schema"] == DIALECT

    def visit(value):
        if isinstance(value, dict):
            if "$ref" in value:
                target = value["$ref"]
                assert target.startswith("#/"), target
                resolved = contract
                for segment in target[2:].split("/"):
                    resolved = resolved[segment.replace("~1", "/").replace("~0", "~")]
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(contract)
    for name, schema in contract["components"]["schemas"].items():
        for example in schema.get("examples", []):
            validate(contract, name, example)
    record = copy.deepcopy(contract["components"]["schemas"]["Record"]["examples"][0])
    record["render"]["color"] = "#123456\n"
    with pytest.raises(AssertionError):
        validate(contract, "Record", record)


def test_read_and_query_http_responses_conform_to_declared_schemas(app, contract):
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        for path in ["/health/live", "/health/ready", "/api/v1/health", "/api/v1/capabilities", BASE, BASE + "/status", BASE + "/records", BASE + "/events", BASE + "/sessions", BASE + "/models", BASE + "/snapshot", BASE + "/settings/effective", "/api/v1/principals", "/api/v1/principals/me", "/api/v1/tokens"]:
            response = client.get(path)
            assert response.status_code == 200, response.text
            response_matches(contract, path, "GET", response)
        query = client.post(BASE + "/query-sessions", json=contract["components"]["schemas"]["QueryRequest"]["examples"][0])
        response_matches(contract, BASE + "/query-sessions", "POST", query)
        query = prepared(client, query)
        q = query.json()
        prefix = BASE + f'/query-sessions/{q["queryId"]}'
        for endpoint in ["density", "overview", "zones"]:
            response_matches(contract, BASE + "/query-sessions/{query_id}/" + endpoint, "GET", client.get(prefix + "/" + endpoint))
        response_matches(contract, BASE + "/query-sessions/{query_id}/maps/{map_id}", "GET", client.get(prefix + f'/maps/{q["mapId"]}'))
        layout_input = copy.deepcopy(contract["components"]["schemas"]["LayoutRequest"]["examples"][0])
        layout_input["mapId"] = q["mapId"]
        response = client.post(prefix + "/layouts", json=layout_input)
        response_matches(contract, BASE + "/query-sessions/{query_id}/layouts", "POST", response)
        response = prepared(client, response)
        layout = response.json()
        inspected = client.get(prefix + f'/layouts/{layout["layoutId"]}')
        response_matches(contract, BASE + "/query-sessions/{query_id}/layouts/{layout_id}", "GET", inspected)
        assert inspected.json() == layout
        response_matches(contract, BASE + "/query-sessions/{query_id}/layouts/{layout_id}/rows", "GET", client.get(prefix + f'/layouts/{layout["layoutId"]}/rows'))
        response_matches(contract, BASE + "/query-sessions/{query_id}/records/query", "POST", client.post(prefix + "/records/query", json={"limit": 7}))
        response_matches(contract, BASE + "/query-sessions/{query_id}", "DELETE", client.delete(prefix))


def test_async_query_and_layout_status_responses_match_contract(app, contract, monkeypatch):
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        finish = threading.Event()
        original = app.state.preparations._calculate

        def held(job, resources):
            assert finish.wait(5)
            return original(job, resources)

        monkeypatch.setattr(app.state.preparations, "_calculate", held)
        try:
            response = client.post(BASE + "/query-sessions", json=contract["components"]["schemas"]["QueryRequest"]["examples"][0], headers={"Prefer": "respond-async"})
            assert response.status_code == 202
            response_matches(contract, BASE + "/query-sessions", "POST", response)
            location = response.headers["location"]
            response_matches(contract, BASE + "/query-sessions/{query_id}", "GET", client.get(location))
        finally:
            finish.set()
        deadline = time.monotonic() + 3
        while response.status_code == 202 and time.monotonic() < deadline:
            response = client.get(location)
            time.sleep(0.01)
        assert response.status_code == 200
        query = response.json()
        finish.clear()
        request = copy.deepcopy(contract["components"]["schemas"]["LayoutRequest"]["examples"][0])
        request["mapId"] = query["mapId"]
        try:
            response = client.post(location + "/layouts", json=request, headers={"Prefer": "respond-async"})
            assert response.status_code == 202
            response_matches(contract, BASE + "/query-sessions/{query_id}/layouts", "POST", response)
            layout_location = response.headers["location"]
            response_matches(contract, BASE + "/query-sessions/{query_id}/layouts/{layout_id}", "GET", client.get(layout_location))
        finally:
            finish.set()
        monkeypatch.setattr(app.state.preparations, "_calculate", original)
        response = client.post(BASE + "/query-sessions", json={"domain": request, "scaleMode": "invalid"}, headers={"Prefer": "respond-async"})
        location = BASE + "/query-sessions/" + response.json()["queryId"]
        deadline = time.monotonic() + 3
        while response.status_code == 202 and time.monotonic() < deadline:
            response = client.get(location)
            time.sleep(0.01)
        assert response.json()["state"] == "failed"
        response_matches(contract, BASE + "/query-sessions/{query_id}", "GET", response)


def test_record_commands_problem_details_and_native_patch_media_type_match_contract(app, contract):
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        generation = client.get(BASE).json()["generation"]
        headers = {"X-Workspace-Generation": generation, "Idempotency-Key": "openapi-create"}
        payload = contract["components"]["schemas"]["RecordCreate"]["examples"][0]
        created = client.post(BASE + "/sessions", json=payload, headers=headers)
        assert created.status_code == 201 and created.headers["location"]
        response_matches(contract, BASE + "/sessions", "POST", created)
        record = created.json()["record"]
        item = BASE + f'/sessions/{record["id"]}'
        response_matches(contract, BASE + "/sessions/{record_id}", "GET", client.get(item))
        patch_headers = {**headers, "If-Match": created.headers["etag"], "Idempotency-Key": "openapi-patch", "Content-Type": "application/json-patch+json"}
        patched = client.patch(item, json=contract["components"]["schemas"]["JsonPatch"]["examples"][0], headers=patch_headers)
        assert patched.status_code == 200
        response_matches(contract, BASE + "/sessions/{record_id}", "PATCH", patched)
        stale = client.patch(item, json=[{"op": "replace", "path": "/title", "value": "Stale"}], headers={**patch_headers, "Idempotency-Key": "openapi-stale"})
        assert stale.status_code == 412
        response_matches(contract, BASE + "/sessions/{record_id}", "PATCH", stale)
        deleted = client.delete(item, headers={**headers, "If-Match": patched.headers["etag"], "Idempotency-Key": "openapi-delete"})
        assert deleted.status_code == 204
        response_matches(contract, BASE + "/sessions/{record_id}", "DELETE", deleted)
        for response in [client.get(BASE + "/records?limit=oops"), client.post(BASE + "/records", json={}), client.post(BASE + "/query-sessions", content="{", headers={"Content-Type": "application/json"})]:
            assert response.headers["content-type"].startswith("application/problem+json")
            validate(contract, "Problem", response.json())


def test_authentication_and_write_preconditions_are_documented_without_token_examples(contract):
    for path, methods in contract["paths"].items():
        for method, operation in methods.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            public = path in ("/health/live", "/health/ready", "/api/v1/health", "/api/v1/capabilities")
            assert operation["security"] == ([] if public else [{"BearerAuth": []}])
    patch = contract["paths"][BASE + "/records/{record_id}"]["patch"]
    assert "application/json-patch+json" in patch["requestBody"]["content"]
    headers = {parameter["name"]: parameter for parameter in patch["parameters"] if parameter["in"] == "header"}
    assert all(headers[name]["required"] for name in ("If-Match", "Idempotency-Key", "X-Workspace-Generation"))
    batch = contract["paths"][BASE + "/records/batch"]["post"]
    assert batch["x-request-byte-limit"] == 8388608 and "200" in batch["responses"]
    preparing = contract["paths"][BASE + "/query-sessions"]["post"]["responses"]["202"]
    assert {"Location", "Retry-After"} <= preparing["headers"].keys()
    assert preparing["content"]["application/json"]["schema"]["$ref"].endswith("/QueryPreparing")
    assert "secretHash" not in contract["components"]["schemas"]["Token"]["properties"]


def test_native_contract_endpoint_requires_auth_and_serves_the_same_offline_document(app, contract):
    with TestClient(app) as client:
        denied = client.get(BASE + "/openapi.json")
        assert denied.status_code == 401
        validate(contract, "Problem", denied.json())
        response = client.get(BASE + "/openapi.json", headers={"Authorization": "Bearer " + TOKEN})
        assert response.status_code == 200 and response.json() == contract
        assert response.headers["cache-control"] == "no-store"


def test_configuration_lifecycle_settings_audit_and_atomic_batch_responses_conform(app, contract):
    with TestClient(app, headers={"Authorization": "Bearer " + TOKEN}) as client:
        generation = client.get(BASE).json()["generation"]
        for family in ["sources", "groups", "schemas", "filters", "views"]:
            response_matches(contract, BASE + "/{family}", "GET", client.get(BASE + "/" + family))
        source = client.get(BASE + "/sources").json()["items"][0]
        response_matches(contract, BASE + "/{family}/{resource_id}", "GET", client.get(BASE + "/sources/" + source["id"]))
        response_matches(contract, BASE + "/configuration/resource", "GET", client.get(BASE + "/configuration/resource", params={"family": "sources", "id": source["id"]}))
        response_matches(contract, BASE + "/configuration/usage", "GET", client.get(BASE + "/configuration/usage", params={"family": "sources", "id": source["id"]}))
        source_validation = contract["components"]["schemas"]["ValidationRequest"]["examples"][0]
        response_matches(contract, BASE + "/{family}/validate", "POST", client.post(BASE + "/sources/validate", json=source_validation))
        command = copy.deepcopy(contract["components"]["schemas"]["ConfigurationCommand"]["examples"][0])
        command["generation"] = generation
        headers = {"X-Workspace-Generation": generation, "Idempotency-Key": command["clientCommandId"]}
        created = client.post(BASE + "/configuration/commands", json=command, headers=headers)
        assert created.status_code == 200, created.text
        response_matches(contract, BASE + "/configuration/commands", "POST", created)
        resource = created.json()["resource"]
        publish = {**command, "type": "publish", "resourceId": resource["id"], "expectedRevision": resource["revision"], "clientCommandId": "openapi-publish", "payload": {}}
        published = client.post(BASE + "/configuration/commands", json=publish, headers={**headers, "Idempotency-Key": publish["clientCommandId"], "If-Match": created.headers["etag"]})
        response_matches(contract, BASE + "/configuration/commands", "POST", published)
        for suffix, template in [("versions", "/versions"), ("versions/1", "/versions/{version}"), ("usage", "/usage")]:
            response_matches(contract, BASE + "/{family}/{resource_id}" + template, "GET", client.get(BASE + f'/filters/{resource["id"]}/' + suffix))
        settings = copy.deepcopy(contract["components"]["schemas"]["SettingsCommand"]["examples"][0])
        settings["generation"] = generation
        response = client.post(BASE + "/settings/commands", json=settings, headers={**headers, "Idempotency-Key": settings["clientCommandId"], "If-Match": f'"{generation}:0"'})
        response_matches(contract, BASE + "/settings/commands", "POST", response)
        batch = client.post(BASE + "/records/batch", json=contract["components"]["schemas"]["BatchRequest"]["examples"][0], headers={**headers, "Idempotency-Key": "openapi-batch"})
        assert batch.status_code == 200, batch.text
        response_matches(contract, BASE + "/records/batch", "POST", batch)
        response_matches(contract, BASE + "/command-results/{command_id}", "GET", client.get(BASE + "/command-results/openapi-batch"))
        audit = client.get(BASE + "/audit", params={"limit": 2})
        assert audit.status_code == 200
        response_matches(contract, BASE + "/audit", "GET", audit)
        assert audit.json()["items"] and audit.json()["nextCursor"]
        response_matches(contract, BASE + "/audit", "GET", client.get(BASE + "/audit", params={"limit": 2, "cursor": audit.json()["nextCursor"]}))
