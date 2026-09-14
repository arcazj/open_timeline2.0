import uuid
import time

import pytest

from conftest import BASE
from server.app.models.domain import content_checksum


def prepared(client, response, *, headers=None):
    deadline = time.monotonic() + 5
    while response.status_code == 202 and time.monotonic() < deadline:
        time.sleep(0.01)
        response = client.get(response.headers["location"], headers=headers)
    assert response.status_code == 200, response.text
    assert response.json().get("state", "ready") == "ready", response.text
    return response


def query(client, bundle, **kwargs):
    response = prepared(client, client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"], **kwargs}))
    return response.json()


def layout(client, bundle, query_manifest, **kwargs):
    response = client.post(BASE + f'/query-sessions/{query_manifest["queryId"]}/layouts', json={
        "mapId": query_manifest["mapId"], **bundle["settings"]["range"], "width": 1200,
        "availableHeight": 64, "rowHeight": 32, "fontSize": 13, "groupBy": "none", **kwargs,
    })
    return prepared(client, response).json()


def test_auth_and_health(client):
    assert client.get("/api/v1/health", headers={"Authorization": ""}).status_code == 200
    denied = client.get(BASE, headers={"Authorization": "Bearer invalid"})
    assert denied.status_code == 401
    assert denied.headers["www-authenticate"] == "Bearer"
    assert denied.headers["cache-control"] == "no-store"
    assert client.get(BASE).json()["recordCount"] == 48
    assert client.get(BASE + "/openapi.json").status_code == 200


def test_crud_versions_retries_outcomes_and_restore(client, write_headers):
    payload = {"title": "Created test", "kind": "event", "start": "2026-09-12T12:00:00.000Z"}
    created = client.post(BASE + "/records", json=payload, headers=write_headers)
    assert created.status_code == 201, created.text
    record = created.json()["record"]
    assert record["version"] == 1
    assert created.json()["durability"] == "server-committed"
    same = client.post(BASE + "/records", json=payload, headers=write_headers)
    assert same.json() == created.json()
    assert client.get(BASE).json()["revision"] == 2
    changed = client.post(BASE + "/records", json={**payload, "title": "Different"}, headers=write_headers)
    assert changed.status_code == 409
    assert client.get(BASE + "/command-results/test-command").json() == created.json()
    fetched = client.get(BASE + "/records/" + record["id"])
    assert fetched.headers["etag"] == created.headers["etag"]
    headers = {**write_headers, "Idempotency-Key": "update-command", "If-Match": fetched.headers["etag"]}
    updated = client.patch(BASE + "/records/" + record["id"], json=[{"op": "replace", "path": "/title", "value": "Updated test"}], headers={**headers, "Content-Type": "application/json-patch+json"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["record"]["version"] == 2
    stale = client.put(BASE + "/records/" + record["id"], json={"title": "Stale"}, headers={**headers, "Idempotency-Key": "stale-command"})
    assert stale.status_code == 412
    deleted = client.delete(BASE + "/records/" + record["id"], headers={**headers, "Idempotency-Key": "delete-command", "If-Match": updated.headers["etag"]})
    assert deleted.status_code == 204
    assert not deleted.content
    assert client.get(BASE + "/records/" + record["id"]).status_code == 404
    assert client.get(BASE + "/records/" + record["id"] + "?includeDeleted=true").json()["deletedAt"]
    restored = client.post(BASE + "/records/" + record["id"] + "/restore", json={}, headers={**headers, "Idempotency-Key": "restore-command", "If-Match": deleted.headers["etag"]})
    assert restored.status_code == 200
    assert restored.json()["record"]["version"] == 4
    assert restored.json()["record"]["deletedAt"] is None


def test_preconditions_and_generation(client, write_headers):
    assert client.post(BASE + "/records", json={"title": "Missing"}).status_code == 428
    assert client.post(BASE + "/records", json={"title": "Wrong generation"}, headers={**write_headers, "X-Workspace-Generation": "old"}).status_code == 409
    assert client.get(BASE + "/command-results/unknown").status_code == 404
    assert client.get(BASE).json()["revision"] == 1


@pytest.mark.parametrize("body", [
    '{"title":"one","title":"two"}', '{"title":"bad","data":{"value":NaN}}',
    '{"title":"bad","data":{"value":Infinity}}', '{"title":"\\ud800"}',
    '{"title":"bad","data":{"value":9007199254740992}}',
    '{"title":"bad","data":{"value":9007199254740992.0}}',
])
def test_strict_json_rejects_unsafe_members(client, write_headers, body):
    response = client.post(BASE + "/records", content=body, headers={**write_headers, "Content-Type": "application/json"})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_json"


@pytest.mark.parametrize("payload", [
    {"title": "Invalid", "start": "2026-09-12T12:00:00"},
    {"title": "Invalid", "start": "2026-02-30T12:00:00Z"},
    {"title": "Invalid", "start": "2026-09-12T12:00:00.0001Z"},
    {"title": "Invalid", "start": "2026-09-12T12:00:00+00:99"},
    {"title": "Invalid", "end": "2026-09-12T13:00:00Z"},
    {"title": "Invalid", "render": {"color": "url(javascript:alert(1))"}},
    {"title": "Invalid", "render": {"color": 123}},
    {"title": "Invalid", "unexpected": True},
    {"title": "Invalid", "parentSessionId": str(uuid.uuid4())},
])
def test_invalid_records(client, write_headers, payload):
    response = client.post(BASE + "/records", json=payload, headers=write_headers)
    assert response.status_code == 422, response.text
    assert client.get(BASE).json()["revision"] == 1


def test_search_preserves_density_context_and_overview_matches(client, bundle):
    first = query(client, bundle, scaleMode="adaptive")
    second = query(client, bundle, scaleMode="adaptive", search="Telemetry")
    first_base = BASE + "/query-sessions/" + first["queryId"]
    second_base = BASE + "/query-sessions/" + second["queryId"]
    assert client.get(first_base + "/density").json() == client.get(second_base + "/density").json()
    assert second["baseTotal"] == 48
    assert 0 < second["matchTotal"] < 48
    overview = client.get(second_base + "/overview").json()
    assert len(overview["items"]) == second["overviewMatchTotal"]
    assert overview["total"] == 48
    detail = layout(client, bundle, second)
    assert detail["detailTotal"] == 48
    assert detail["detailMatchTotal"] == second["matchTotal"]


def test_global_row_paging_preserves_map_and_exact_items(client, bundle):
    manifest = query(client, bundle, scaleMode="adaptive")
    allocation = layout(client, bundle, manifest)
    path = BASE + f'/query-sessions/{manifest["queryId"]}/layouts/{allocation["layoutId"]}/rows'
    cursor, items, pages = None, [], []
    while True:
        page = client.get(path, params={"cursor": cursor} if cursor else {}).json()
        assert page["pageComplete"]
        assert page["mapId"] == manifest["mapId"]
        assert page["endRow"] - page["startRow"] <= 2
        items.extend(page["items"])
        pages.append(page)
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert len({item["record"]["id"] for item in items}) == len(items) == 48
    assert pages[-1]["endRow"] == allocation["totalRows"]
    for index, item in enumerate(items):
        for other in items[index + 1:]:
            if item["row"] == other["row"]:
                assert item["footprintEnd"] + 4 <= other["footprintStart"] or other["footprintEnd"] + 4 <= item["footprintStart"]
    assert client.get(path, params={"cursor": "changed"}).status_code == 400
    target = items[-1]
    placement = client.get(path.replace("/rows", "/placement/") + target["record"]["id"]).json()
    assert placement["row"] == target["row"]


def test_group_headers_and_height_capacity(client, bundle):
    manifest = query(client, bundle)
    allocation = layout(client, bundle, manifest, groupBy="sourceId")
    first = client.get(BASE + f'/query-sessions/{manifest["queryId"]}/layouts/{allocation["layoutId"]}/rows').json()
    assert first["rows"][0] == {"row": 0, "type": "group", "name": "operations"}
    assert all(item["row"] >= 1 for item in first["items"])


def test_query_snapshot_does_not_change_after_mutation(client, bundle, write_headers):
    manifest = query(client, bundle)
    density_before = client.get(BASE + f'/query-sessions/{manifest["queryId"]}/density').json()
    response = client.post(BASE + "/records", json={"title": "New event", "start": "2026-09-12T12:00:00Z"}, headers=write_headers)
    assert response.status_code == 201
    assert client.get(BASE + f'/query-sessions/{manifest["queryId"]}/density').json() == density_before
    assert query(client, bundle)["baseTotal"] == 49
    export = client.get(BASE + "/snapshot").json()
    assert export["manifest"]["recordCount"] == len(export["records"]) == 49


def test_handles_are_bounded_and_releasable(client, bundle, app):
    manifests = [query(client, bundle) for _ in range(4)]
    assert client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}).status_code == 429
    path = BASE + "/query-sessions/" + manifests[0]["queryId"]
    assert client.delete(path).status_code == 204
    assert client.get(path + "/density").status_code == 404
    fresh = query(client, bundle)
    app.state.queries.queries[fresh["queryId"]]["expires"] = 0
    assert client.get(BASE + f'/query-sessions/{fresh["queryId"]}/density').status_code == 410


def test_query_and_layout_validation(client, bundle):
    assert client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"], "bins": 0}).status_code == 422
    assert client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"], "search": '"bad'}).status_code == 422
    manifest = query(client, bundle)
    request = {"mapId": manifest["mapId"], **bundle["settings"]["range"], "width": 1200, "availableHeight": 10}
    path = BASE + f'/query-sessions/{manifest["queryId"]}/layouts'
    assert client.post(path, json=request).status_code == 422
    request.update(availableHeight=64, viewFromMs="1e10")
    assert client.post(path, json=request).status_code == 422


def test_parent_delete_is_not_implicit_cascade(client, write_headers):
    parent = client.post(BASE + "/records", json={"title": "Parent", "kind": "session", "start": "2026-09-12T10:00:00Z"}, headers=write_headers)
    child = client.post(BASE + "/records", json={"title": "Child", "start": "2026-09-12T11:00:00Z", "parentSessionId": parent.json()["record"]["id"]}, headers={**write_headers, "Idempotency-Key": "child"})
    assert child.status_code == 201
    deleted = client.delete(BASE + "/records/" + parent.json()["record"]["id"], headers={**write_headers, "Idempotency-Key": "parent-delete", "If-Match": parent.headers["etag"]})
    assert deleted.status_code == 409
    assert deleted.json()["code"] == "active_children"


def test_public_export_integrity_cannot_be_disabled_by_query_parameters(client):
    response = client.get(BASE + "/snapshot?checksum=false&includeChecksum=false")
    assert response.status_code == 200
    exported = response.json()
    assert exported["manifest"]["contentSha256"] == content_checksum(exported)
