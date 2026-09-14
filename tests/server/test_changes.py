import asyncio
import json
import socket
import threading
import time
import uuid

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from server.app.api.changes import BoundedStreamResponse
from server.app.main import create_app
from server.app.models.domain import DomainError
from test_audit import create
from test_identity_api import create_identity


def poll(client, metadata, after=None, **kwargs):
    params = {"generation": metadata["generation"], "afterRevision": metadata["revision"] if after is None else after, **kwargs.pop("params", {})}
    return client.get(BASE + "/changes", params=params, **kwargs)


def test_snapshot_resume_batch_replay_and_concurrent_pinned_queries(client, app, write_headers, bundle):
    metadata = client.get(BASE).json()
    first = poll(client, metadata).json()
    assert first["changes"] == [] and first["nextRevision"] == metadata["revision"]
    query = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}).json()
    headers = {**write_headers, "Idempotency-Key": str(uuid.uuid4())}
    body = {"operations": [{"type": "create", "payload": {"title": "Never exposed one"}}, {"type": "create", "payload": {"title": "Never exposed two"}}]}
    batch = client.post(BASE + "/records/batch", headers=headers, json=body)
    assert batch.status_code == 200, batch.text
    assert client.post(BASE + "/records/batch", headers=headers, json=body).json() == batch.json()
    page = poll(client, metadata, params={"scope": first["scope"]}).json()
    assert len(page["changes"]) == 1
    assert len(page["changes"][0]["recordIds"]) == 2
    assert page["changes"][0]["family"] == "records"
    assert set(page) == {"generation", "scope", "throughRevision", "nextRevision", "changes", "hasMore"}
    assert set(page["changes"][0]) == {"revision", "family", "recordIds", "requiresReload"}
    assert "Never exposed" not in str(page)
    assert client.get(BASE + "/query-sessions/" + query["queryId"]).json() == query
    assert poll(client, metadata, page["nextRevision"], params={"scope": page["scope"]}).json()["changes"] == []


def test_hidden_entries_advance_without_counts_and_scope_changes_stop_resume(client, write_headers):
    principal, _, reader = create_identity(client, ["operations"])
    metadata = client.get(BASE, headers=reader).json()
    initial = poll(client, metadata, headers=reader).json()
    create(client, write_headers, "verification")
    visible = create(client, write_headers, "operations")
    create(client, write_headers, "verification")
    page = poll(client, metadata, headers=reader, params={"limit": 1, "scope": initial["scope"]}).json()
    assert page["changes"] == [{"revision": visible["revision"], "family": "records", "recordIds": [visible["record"]["id"]], "requiresReload": True}]
    assert not page["hasMore"] and page["nextRevision"] == visible["revision"] + 1
    current = client.get("/api/v1/principals/" + principal["id"])
    changed = client.patch("/api/v1/principals/" + principal["id"], json={"grants": [{"workspaceId": "default", "sourceIds": [], "capabilities": []}]},
        headers={"X-Identity-Generation": current.json()["generation"], "If-Match": current.headers["etag"], "Idempotency-Key": uuid.uuid4().hex})
    assert changed.status_code == 200, changed.text
    response = poll(client, metadata, page["nextRevision"], headers=reader, params={"scope": page["scope"]})
    assert response.status_code == 409 and response.json()["code"] == "permission_scope_changed"


def test_private_owner_notice_visible_under_restricted_source_grants(client, write_headers):
    _, _, alice = create_identity(client, ["operations"])
    _, _, bob = create_identity(client, ["operations"])
    metadata = client.get(BASE).json()
    command = {"family": "filters", "type": "create", "clientCommandId": uuid.uuid4().hex, "generation": metadata["generation"],
        "payload": {"name": "Private name never in feed", "visibility": "personal", "definition": {"sourceIds": None, "kinds": ["event", "session"], "schemaRefs": [], "expression": None, "search": {"text": "", "mode": "any", "caseSensitive": False, "fields": ["/title"]}}}}
    response = client.post(BASE + "/configuration/commands", json=command, headers={**alice, **write_headers, "Idempotency-Key": command["clientCommandId"]})
    assert response.status_code == 200, response.text
    owner = poll(client, metadata, headers=alice).json()
    assert len(owner["changes"]) == 1 and owner["changes"][0]["family"] == "filters"
    assert owner["changes"][0]["recordIds"] == []
    assert poll(client, metadata, headers=bob).json()["changes"] == []
    assert "Private name" not in str(owner)


def test_paged_catchup_restart_and_revision_errors(tmp_path):
    root = tmp_path / "data"
    with TestClient(create_app(root, TOKEN), headers={"Authorization": "Bearer " + TOKEN}) as client:
        metadata = client.get(BASE).json()
        headers = {"X-Workspace-Generation": metadata["generation"]}
        for _ in range(3):
            create(client, headers)
        first = poll(client, metadata, params={"limit": 1}).json()
        assert first["hasMore"] and first["nextRevision"] == metadata["revision"] + 1
    with TestClient(create_app(root, TOKEN), headers={"Authorization": "Bearer " + TOKEN}) as client:
        second = poll(client, metadata, first["nextRevision"], params={"scope": first["scope"]}).json()
        assert len(second["changes"]) == 2
        for params, code, status in [({"afterRevision": 0}, "replay_gap", 409), ({"afterRevision": 999}, "invalid_revision", 422),
                ({"generation": str(uuid.uuid4())}, "generation_mismatch", 409), ({"generation": metadata["generation"].upper()}, "invalid_generation", 422),
                ({"scope": "bad"}, "invalid_scope", 422), ({"limit": 501}, "invalid_page", 422)]:
            response = poll(client, metadata, params=params)
            assert response.status_code == status and response.json()["code"] == code, response.text


def test_stream_admission_limits_ttl_and_no_record_loads(client, app, monkeypatch):
    service = app.state.changes
    identity = app.state.identities.authenticate(TOKEN)
    metadata = client.get(BASE).json()
    monkeypatch.setattr(app.state.repository, "snapshot", lambda: pytest.fail("Feed must not load a full snapshot"))
    leases = [service.admit_stream(identity, metadata["generation"], metadata["revision"])["lease"] for _ in range(2)]
    response = client.get(BASE + "/changes/stream", params={"generation": metadata["generation"], "afterRevision": metadata["revision"]})
    assert response.status_code == 429 and response.json()["code"] == "stream_capacity"
    service.leases[leases[0]]["expires"] = 0
    replacement = service.admit_stream(identity, metadata["generation"], metadata["revision"])["lease"]
    with pytest.raises(DomainError, match="expired"):
        service.stream_page(leases[0], identity, metadata["generation"], metadata["revision"])
    service.release_stream(replacement)
    service.release_stream(leases[1])
    assert service.leases == {}
    service.STREAM_LIMIT = 0
    with pytest.raises(DomainError) as error:
        service.admit_stream(identity, metadata["generation"], metadata["revision"])
    assert error.value.code == "stream_capacity"


@pytest.mark.parametrize("mode", ["disconnect", "slow-send", "send-error", "slow-body", "body-error", "disconnect-body"])
def test_stream_asgi_cleanup_is_bounded_even_before_generator_start(mode):
    released, closed = [], []

    async def content():
        try:
            while True:
                yield "event: heartbeat\ndata: {}\n\n"
                await asyncio.sleep(0.01)
        finally:
            closed.append(True)

    async def run():
        response = BoundedStreamResponse(content(), lambda: released.append(True))
        async def receive():
            if mode == "disconnect-body":
                await asyncio.sleep(0.03)
            return {"type": "http.disconnect"}
        async def send(message):
            if mode == "slow-send":
                await asyncio.sleep(5)
            elif mode == "send-error":
                raise OSError("Disconnected")
            elif mode == "slow-body" and message["type"] == "http.response.body":
                await asyncio.sleep(5)
            elif mode == "body-error" and message["type"] == "http.response.body":
                raise OSError("Disconnected body")
            else:
                await asyncio.sleep(0)
        await response({"type": "http", "asgi": {"spec_version": "2.0" if mode.startswith("disconnect") else "2.4"}}, receive, send)

    started = time.monotonic()
    asyncio.run(run())
    assert released and time.monotonic() - started < 2
    if mode in ("slow-body", "body-error", "disconnect-body"):
        assert closed == [True]


@pytest.fixture
def live_changes(tmp_path):
    app = create_app(tmp_path / "live", TOKEN)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    address = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="on", timeout_graceful_shutdown=2))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    try:
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert server.started
        with httpx.Client(base_url=address, headers={"Authorization": "Bearer " + TOKEN}, timeout=5) as client:
            yield client, app
    finally:
        server.should_exit = True
        thread.join(5)
        sock.close()
        assert not thread.is_alive()


def event(lines):
    name, data = None, None
    for line in lines:
        if line.startswith("event: "):
            name = line[7:]
        elif line.startswith("data: "):
            data = json.loads(line[6:])
        elif not line and name:
            return name, data
    raise AssertionError("Stream ended before an event")


def test_real_http_sse_heartbeat_revocation_disconnect_and_resume(live_changes):
    client, app = live_changes
    _, token, reader = create_identity(client)
    metadata = client.get(BASE, headers=reader).json()
    params = {"generation": metadata["generation"], "afterRevision": metadata["revision"]}
    with client.stream("GET", BASE + "/changes/stream", params=params, headers=reader) as response:
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/event-stream")
        lines = response.iter_lines()
        name, initial = event(lines)
        assert name == "changes" and initial["changes"] == []
        assert event(lines)[0] == "heartbeat"
        create(client, {"X-Workspace-Generation": metadata["generation"]})
        name, changed = event(lines)
        assert name == "changes" and len(changed["changes"]) == 1
        assert event(lines)[0] == "heartbeat"
        current = client.get("/api/v1/tokens")
        revoked = client.delete("/api/v1/tokens/" + token["token"]["id"], headers={"X-Identity-Generation": current.json()["generation"], "If-Match": f'"{current.json()["generation"]}:{token["token"]["revision"]}"', "Idempotency-Key": uuid.uuid4().hex})
        assert revoked.status_code == 200, revoked.text
        name, failure = event(lines)
        assert name == "error" and failure["status"] == 401
        assert set(failure) == {"code", "status", "message"}
    deadline = time.monotonic() + 2
    while app.state.changes.leases and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not app.state.changes.leases
    response = client.get(BASE + "/changes", params={**params, "afterRevision": changed["nextRevision"]})
    assert response.status_code == 200 and response.json()["changes"] == []
    with client.stream("GET", BASE + "/changes/stream", params={**params, "afterRevision": changed["nextRevision"]}) as response:
        assert event(response.iter_lines())[0] == "changes"
    deadline = time.monotonic() + 2
    while app.state.changes.leases and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not app.state.changes.leases
