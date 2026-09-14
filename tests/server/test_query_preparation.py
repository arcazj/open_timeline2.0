import copy
import threading
import time

import pytest

from conftest import BASE, TOKEN
from server.app.models.domain import DomainError
from server.app.services.query_preparation import QueryPreparationCoordinator
from test_identity_api import create_identity


@pytest.fixture
def coordinator(client, app):
    value = app.state.preparations
    try:
        yield value
    finally:
        value.close()


def actor(app, token=TOKEN):
    return app.state.identities.authenticate(token)


def ready(coordinator, identity, manifest, query_id=None):
    deadline = time.monotonic() + 5
    while manifest.get("state") == "preparing" and time.monotonic() < deadline:
        time.sleep(0.01)
        manifest = coordinator.dispatch(identity, "get_layout", query_id, manifest["layoutId"]) if query_id else coordinator.dispatch(identity, "get_query", manifest["queryId"])
    assert manifest.get("state", "ready") == "ready", manifest
    return manifest


def test_async_query_layout_are_coherent_reserved_and_fully_released(coordinator, app, bundle):
    identity = actor(app)
    manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
    query = ready(coordinator, identity, manifest)
    assert query["queryId"] == manifest["queryId"] and query["snapshotId"] == manifest["snapshotId"] and query["mapId"] == manifest["mapId"]
    request = {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000, "availableHeight": 480}
    manifest = coordinator.dispatch(identity, "create_layout", query["queryId"], request, prefer_async=True)
    layout = ready(coordinator, identity, manifest, query["queryId"])
    assert layout["layoutId"] == manifest["layoutId"]
    assert coordinator.dispatch(identity, "rows", query["queryId"], layout["layoutId"])["mapId"] == query["mapId"]
    coordinator.dispatch(identity, "release_query", query["queryId"])
    assert app.state.queries.resources.retained_bytes == 0
    assert coordinator.stats()["active"] == 0 and coordinator.stats()["queued"] == 0


def test_release_cancels_active_work_without_early_reservation_release(coordinator, app, bundle, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    identity = actor(app)
    try:
        manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
        assert entered.wait(2)
        coordinator.dispatch(identity, "release_query", manifest["queryId"])
        assert app.state.queries.resources.retained_bytes >= coordinator.preparation_allowance_bytes
        assert coordinator.stats()["active"] == 1
    finally:
        finish.set()
    deadline = time.monotonic() + 3
    while coordinator.jobs and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not coordinator.jobs and app.state.queries.resources.retained_bytes == 0
    assert not app.state.queries.queries


def test_failed_preparation_is_explicit_and_releases_working_inputs(coordinator, app, bundle):
    identity = actor(app)
    manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"], "scaleMode": "invalid"}, prefer_async=True)
    deadline = time.monotonic() + 3
    while manifest.get("state") == "preparing" and time.monotonic() < deadline:
        time.sleep(0.01)
        manifest = coordinator.dispatch(identity, "get_query", manifest["queryId"])
    assert manifest["state"] == "failed" and manifest["error"]["code"] == "invalid_query"
    assert app.state.queries.resources.retained_bytes < coordinator.preparation_allowance_bytes
    coordinator.dispatch(identity, "release_query", manifest["queryId"])
    assert app.state.queries.resources.retained_bytes == 0


def test_reservation_failure_publishes_no_handle_or_job(coordinator, app, bundle):
    app.state.queries.resources.limit_bytes = 100
    with pytest.raises(DomainError) as error:
        coordinator.dispatch(actor(app), "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
    assert error.value.code == "query_memory_capacity"
    assert not coordinator.jobs and not coordinator.queue and not app.state.queries.queries
    assert app.state.queries.resources.retained_bytes == 0


def test_two_global_workers_and_one_active_per_principal(coordinator, client, app, bundle, monkeypatch):
    _, _, alice = create_identity(client)
    _, _, bob = create_identity(client)
    identities = [actor(app, headers["Authorization"].removeprefix("Bearer ")) for headers in (alice, bob)]
    finish = threading.Event()
    entered = []
    original = coordinator._calculate

    def held(job, resources):
        with coordinator.condition:
            entered.append(job.scope["principalId"])
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    handles = []
    try:
        for identity in identities:
            for _ in range(2):
                handles.append((identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)))
        deadline = time.monotonic() + 2
        while len(entered) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(entered) == 2 and len(set(entered)) == 2
        assert coordinator.stats()["active"] == 2 and coordinator.stats()["queued"] == 2
    finally:
        finish.set()
    for identity, manifest in handles:
        query = ready(coordinator, identity, manifest)
        coordinator.dispatch(identity, "release_query", query["queryId"])
    assert app.state.queries.resources.retained_bytes == 0


def test_admitted_query_pins_data_before_queue_execution(coordinator, app, bundle, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    identity = actor(app)
    try:
        manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
        assert entered.wait(2)
        captured = copy.deepcopy(coordinator.jobs[manifest["queryId"]].captured)
        app.state.access.mutate(identity, "create", None, {"title": "Later record"}, manifest["generation"], None, "async-later-record")
    finally:
        finish.set()
    query = ready(coordinator, identity, manifest)
    assert query["revision"] == captured["manifest"]["revision"]
    assert query["baseTotal"] == len([record for record in captured["records"] if record["deletedAt"] is None])
    coordinator.dispatch(identity, "release_query", query["queryId"])


def test_deadline_rejects_late_publication_and_keeps_slot_until_actual_exit(coordinator, app, bundle, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    coordinator.deadline_seconds = 0.05
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    identity = actor(app)
    try:
        manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
        assert entered.wait(2)
        time.sleep(0.08)
        failed = coordinator.dispatch(identity, "get_query", manifest["queryId"])
        assert failed["state"] == "failed" and failed["error"]["code"] == "preparation_timeout"
        assert coordinator.stats()["active"] == 1
        assert app.state.queries.resources.retained_bytes >= coordinator.preparation_allowance_bytes
    finally:
        finish.set()
    deadline = time.monotonic() + 3
    while coordinator.jobs and time.monotonic() < deadline:
        time.sleep(0.01)
    failed = coordinator.dispatch(identity, "get_query", manifest["queryId"])
    assert failed["state"] == "failed" and failed["error"]["code"] == "preparation_timeout"
    coordinator.dispatch(identity, "release_query", manifest["queryId"])
    assert app.state.queries.resources.retained_bytes == 0


def test_http_async_status_locations_and_completed_sync_failure(coordinator, client, app, bundle, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    try:
        created = client.post(BASE + "/query-sessions", headers={"Prefer": "respond-async"}, json={"domain": bundle["settings"]["overview"]})
        assert created.status_code == 202, created.text
        assert entered.wait(2)
        assert created.headers["location"] == BASE + "/query-sessions/" + created.json()["queryId"]
        assert created.headers["retry-after"] == "1"
        inspected = client.get(created.headers["location"])
        assert inspected.status_code == 202 and inspected.json() == created.json()
    finally:
        finish.set()
    ready(coordinator, actor(app), created.json())
    assert client.get(created.headers["location"]).status_code == 200
    assert client.delete(created.headers["location"]).status_code == 204
    monkeypatch.setattr(coordinator, "_calculate", original)
    coordinator.ready_wait_seconds = 1
    invalid = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"], "scaleMode": "unknown"})
    assert invalid.status_code == 422 and invalid.json()["code"] == "invalid_query"
    assert not app.state.queries.queries and not coordinator.jobs


def test_table_preparation_cannot_bypass_an_active_principal(coordinator, app, bundle, monkeypatch):
    identity = actor(app)
    query = ready(coordinator, identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}))
    first = coordinator.dispatch(identity, "query_records", query["queryId"], {"limit": 2})
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    try:
        pending = coordinator.dispatch(identity, "create_layout", query["queryId"], {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000}, prefer_async=True)
        assert entered.wait(2)
        visits = app.state.queries.resources.graph_visits
        assert coordinator.dispatch(identity, "query_records", query["queryId"], {"limit": 2, "cursor": first["nextCursor"]})["startIndex"] == 2
        assert app.state.queries.resources.graph_visits == visits
        with pytest.raises(DomainError) as error:
            coordinator.dispatch(identity, "query_records", query["queryId"], {})
        assert error.value.code == "preparation_capacity" and error.value.status == 429
    finally:
        finish.set()
    ready(coordinator, identity, pending, query["queryId"])
    assert coordinator.dispatch(identity, "query_records", query["queryId"], {})["queryId"] == query["queryId"]
    coordinator.dispatch(identity, "release_query", query["queryId"])


def test_invalidation_cancels_queued_and_running_work_and_cannot_publish(coordinator, app, bundle, monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    identity = actor(app)
    try:
        handles = [coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True) for _ in range(2)]
        assert entered.wait(2)
        app.state.queries.invalidate_principal(identity["id"])
        assert not app.state.queries.queries and not coordinator.queue
        assert coordinator.stats()["active"] == 1
    finally:
        finish.set()
    deadline = time.monotonic() + 3
    while coordinator.jobs and time.monotonic() < deadline:
        time.sleep(0.01)
    assert app.state.queries.resources.retained_bytes == 0
    for handle in handles:
        with pytest.raises(DomainError) as error:
            coordinator.dispatch(identity, "get_query", handle["queryId"])
        assert error.value.code == "permission_scope_changed"


def test_failed_second_worker_start_joins_first_and_restores_release_hook(client, app, monkeypatch):
    prior = app.state.queries.on_release
    started = []
    original = threading.Thread.start

    def start(worker):
        if worker.name.startswith("timeline-preparation-"):
            if started:
                raise RuntimeError("Injected second worker start failure")
            original(worker)
            started.append(worker)
        else:
            original(worker)

    monkeypatch.setattr(threading.Thread, "start", start)
    with pytest.raises(RuntimeError, match="second worker start"):
        QueryPreparationCoordinator(app.state.queries, app.state.access)
    assert len(started) == 1 and not started[0].is_alive()
    assert app.state.queries.on_release == prior


def test_queue_ceiling_eight_rejects_without_allocating_or_evicting(coordinator, client, app, bundle, monkeypatch):
    identities = []
    for _ in range(3):
        _, _, headers = create_identity(client)
        identities.append(actor(app, headers["Authorization"].removeprefix("Bearer ")))
    entered, finish = [], threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.append(job.key)
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    handles = []
    request = {"domain": bundle["settings"]["overview"]}
    try:
        for identity in identities[:2]:
            handles.append((identity, coordinator.dispatch(identity, "create_query", request, prefer_async=True)))
        deadline = time.monotonic() + 2
        while len(entered) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(entered) == 2
        for identity, count in ((identities[0], 3), (identities[1], 3), (identities[2], 2)):
            for _ in range(count):
                handles.append((identity, coordinator.dispatch(identity, "create_query", request, prefer_async=True)))
        assert coordinator.stats()["queued"] == coordinator.queue_capacity == 8
        before = app.state.queries.resources.retained_bytes
        with pytest.raises(DomainError) as error:
            coordinator.dispatch(identities[2], "create_query", request, prefer_async=True)
        assert error.value.code == "preparation_capacity" and error.value.status == 429
        assert app.state.queries.resources.retained_bytes == before and len(coordinator.jobs) == 10
        for identity, manifest in handles:
            coordinator.dispatch(identity, "release_query", manifest["queryId"])
    finally:
        finish.set()
    deadline = time.monotonic() + 3
    while coordinator.jobs and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not coordinator.jobs and app.state.queries.resources.retained_bytes == 0
