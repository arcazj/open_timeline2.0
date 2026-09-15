import copy
import threading
import time
from concurrent.futures import ThreadPoolExecutor

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


@pytest.mark.parametrize("release_kind", ["query", "layout", "snapshot"])
def test_release_acknowledges_only_after_matching_work_and_reservations_exit(coordinator, app, bundle, monkeypatch, release_kind):
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    identity = actor(app)
    if release_kind == "layout":
        query = ready(coordinator, identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}))
    monkeypatch.setattr(coordinator, "_calculate", held)
    with ThreadPoolExecutor(max_workers=1) as executor:
        try:
            if release_kind == "layout":
                manifest = coordinator.dispatch(identity, "create_layout", query["queryId"],
                    {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000}, prefer_async=True)
                args, job_id = (query["queryId"], manifest["layoutId"]), manifest["layoutId"]
            else:
                manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
                args, job_id = (manifest["snapshotId" if release_kind == "snapshot" else "queryId"],), manifest["queryId"]
            assert entered.wait(2)
            job = coordinator.jobs[job_id]
            release = executor.submit(coordinator.dispatch, identity, "release_" + release_kind, *args)
            assert job.cancelled.wait(2)
            assert not release.done() and not job.done.is_set()
            assert app.state.queries.resources.retained_bytes >= coordinator.preparation_allowance_bytes
            # These calls acquire both locks needed by publication. DELETE must not hold either while waiting.
            assert coordinator.stats()["active"] == 1
            assert actor(app)["id"] == identity["id"]
        finally:
            finish.set()
        assert release.result(timeout=3) is None
    assert job.done.is_set() and coordinator.stats()["active"] == 0
    if release_kind == "layout":
        # The acknowledged cancellation frees admission for an immediately following, uncached table.
        assert coordinator.dispatch(identity, "query_records", query["queryId"], {})["queryId"] == query["queryId"]
        coordinator.dispatch(identity, "release_query", query["queryId"])
    assert not coordinator.jobs and app.state.queries.resources.retained_bytes == 0
    assert not app.state.queries.queries


@pytest.mark.parametrize("release_kind", ["query", "layout", "snapshot"])
def test_release_timeout_and_repeated_delete_wait_for_the_same_cancelled_job(coordinator, app, bundle, monkeypatch, release_kind):
    identity = actor(app)
    if release_kind == "layout":
        query = ready(coordinator, identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}))
    entered, finish = threading.Event(), threading.Event()
    original = coordinator._calculate

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    monkeypatch.setattr(coordinator, "_calculate", held)
    coordinator.release_wait_seconds = 0.02
    with ThreadPoolExecutor(max_workers=1) as executor:
        try:
            if release_kind == "layout":
                manifest = coordinator.dispatch(identity, "create_layout", query["queryId"],
                    {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000}, prefer_async=True)
                args, job_id = (query["queryId"], manifest["layoutId"]), manifest["layoutId"]
            else:
                manifest = coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}, prefer_async=True)
                args, job_id = (manifest["snapshotId" if release_kind == "snapshot" else "queryId"],), manifest["queryId"]
            assert entered.wait(2)
            job = coordinator.jobs[job_id]
            started = time.monotonic()
            with pytest.raises(DomainError) as error:
                coordinator.dispatch(identity, "release_" + release_kind, *args)
            assert error.value.code == "preparation_release_timeout" and error.value.status == 503
            assert time.monotonic() - started < 1
            assert job.cancelled.is_set() and not job.done.is_set()
            assert not coordinator._present(job)
            assert coordinator.stats()["active"] == 1
            coordinator.release_wait_seconds = 2
            waiting = threading.Event()
            original_wait = coordinator._wait_released

            def observed_wait(*values):
                waiting.set()
                return original_wait(*values)

            monkeypatch.setattr(coordinator, "_wait_released", observed_wait)
            retry = executor.submit(coordinator.dispatch, identity, "release_" + release_kind, *args)
            assert waiting.wait(1) and not retry.done()
        finally:
            finish.set()
        assert retry.result(timeout=3) is None
    assert job.done.is_set() and not coordinator.jobs and coordinator.stats()["active"] == 0
    coordinator.dispatch(identity, "release_query", manifest["queryId"])
    assert app.state.queries.resources.retained_bytes == 0


@pytest.mark.parametrize("release_kind", ["query", "snapshot"])
def test_release_waits_for_synchronous_table_cleanup(coordinator, app, bundle, monkeypatch, release_kind):
    identity = actor(app)
    query = ready(coordinator, identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}))
    entered, finish = threading.Event(), threading.Event()
    original = coordinator.access.query

    def held(current, operation, *args):
        result = original(current, operation, *args)
        if operation == "query_records":
            entered.set()
            assert finish.wait(5)
        return result

    monkeypatch.setattr(coordinator.access, "query", held)
    with ThreadPoolExecutor(max_workers=2) as executor:
        try:
            table = executor.submit(coordinator.dispatch, identity, "query_records", query["queryId"], {})
            assert entered.wait(2)
            work = next(iter(coordinator.synchronous.values()))
            release = executor.submit(coordinator.dispatch, identity, "release_" + release_kind,
                                      query["snapshotId" if release_kind == "snapshot" else "queryId"])
            assert work["cancelled"].wait(2)
            assert not release.done() and not work["done"].is_set()
            assert coordinator.stats()["active"] == 1
            assert app.state.queries.resources.retained_bytes >= coordinator.preparation_allowance_bytes
        finally:
            finish.set()
        with pytest.raises(DomainError) as error:
            table.result(timeout=3)
        assert error.value.code == "preparation_cancelled"
        assert release.result(timeout=3) is None
    assert work["done"].is_set() and not coordinator.synchronous
    assert coordinator.stats()["active"] == 0 and app.state.queries.resources.retained_bytes == 0


def test_http_delete_waits_without_blocking_health_and_absent_layout_ack(coordinator, client, app, bundle, monkeypatch):
    identity = actor(app)
    query = ready(coordinator, identity, coordinator.dispatch(identity, "create_query", {"domain": bundle["settings"]["overview"]}))
    entered, finish, waiting = threading.Event(), threading.Event(), threading.Event()
    original, original_wait = coordinator._calculate, coordinator._wait_released

    def held(job, resources):
        entered.set()
        assert finish.wait(5)
        return original(job, resources)

    def observed_wait(current, operation, args):
        if operation == "release_layout":
            waiting.set()
        return original_wait(current, operation, args)

    monkeypatch.setattr(coordinator, "_calculate", held)
    monkeypatch.setattr(coordinator, "_wait_released", observed_wait)
    with ThreadPoolExecutor(max_workers=3) as executor:
        try:
            layout = coordinator.dispatch(identity, "create_layout", query["queryId"],
                {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000}, prefer_async=True)
            assert entered.wait(2)
            job = coordinator.jobs[layout["layoutId"]]
            url = BASE + "/query-sessions/" + query["queryId"]
            release = executor.submit(client.delete, url)
            assert job.cancelled.wait(2)
            absent_layout = executor.submit(client.delete, url + "/layouts/" + layout["layoutId"])
            assert waiting.wait(2)
            assert not release.done() and not absent_layout.done()
            assert executor.submit(client.get, "/api/v1/health").result(timeout=2).status_code == 200
        finally:
            finish.set()
        assert release.result(timeout=3).status_code == 204
        assert absent_layout.result(timeout=3).status_code == 404
    assert job.done.is_set() and coordinator.stats()["active"] == 0
    assert app.state.queries.resources.retained_bytes == 0


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
        for identity, manifest in handles[2:]:
            coordinator.dispatch(identity, "release_query", manifest["queryId"])
        assert coordinator.stats()["queued"] == 0
    finally:
        finish.set()
    for identity, manifest in handles[:2]:
        coordinator.dispatch(identity, "release_query", manifest["queryId"])
    assert not coordinator.jobs and app.state.queries.resources.retained_bytes == 0
