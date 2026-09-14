import copy
import random
import sys
import time

import pytest

from conftest import BASE, ROOT
from server.app.models.domain import DomainError
from server.app.services.query import QueryEngine
from server.app.services.query_access import query_access
from server.app.services.query_resources import QueryResourceLedger, children
from test_identity_api import create_identity
from test_presentation import SnapshotRepository


def measured(roots):
    seen, stack, total = set(), list(roots), 0
    while stack:
        value = stack.pop()
        if id(value) not in seen:
            seen.add(id(value))
            total += sys.getsizeof(value)
            stack.extend(children(value))
    return total


def test_shared_graph_is_counted_once_and_failed_admission_rolls_back_exactly():
    shared = {"title": "Shared payload", "data": [1, 2, 3]}
    first, second = [shared, shared], {"record": shared}
    ledger = QueryResourceLedger()
    ledger.reserve("first", first)
    ledger.reserve("second", second)
    assert ledger.retained_bytes == measured([first, second])
    before, objects = ledger.retained_bytes, len(ledger.nodes)
    ledger.limit_bytes = before + 64
    with pytest.raises(DomainError) as error:
        ledger.reserve("too-large", {"shared": shared, "other": "x" * 1000})
    assert error.value.code == "query_memory_capacity"
    assert ledger.retained_bytes == before and len(ledger.nodes) == objects
    ledger.release("first")
    assert ledger.retained_bytes == measured([second])
    ledger.release("second")
    assert ledger.retained_bytes == 0 and ledger.nodes == {} and ledger.roots == {}


def test_accounting_journal_and_index_have_explicit_bounds_and_cycles_reject():
    for options in ({"scratch_limit_bytes": 1}, {"bookkeeping_limit_bytes": 1}):
        ledger = QueryResourceLedger(**options)
        with pytest.raises(DomainError) as error:
            ledger.reserve("bounded", [str(index) for index in range(1000)])
        assert error.value.code == "query_accounting_capacity"
        assert ledger.retained_bytes == 0 and not ledger.nodes and not ledger.roots
    ledger = QueryResourceLedger()
    cycle = []
    cycle.append(cycle)
    with pytest.raises(DomainError) as error:
        ledger.reserve("cycle", cycle)
    assert error.value.code == "invalid_query_artifact" and not ledger.nodes


def test_rejected_cycle_and_bookkeeping_admissions_preserve_existing_shared_roots():
    shared = {"items": [1, 2, "retained"]}
    ledger = QueryResourceLedger()
    ledger.reserve("existing", shared)
    before = ledger.retained_bytes
    references = {identity: node.references for identity, node in ledger.nodes.items()}
    cycle = [shared]
    cycle.append(cycle)
    with pytest.raises(DomainError) as error:
        ledger.reserve("cycle", cycle)
    assert error.value.code == "invalid_query_artifact"
    assert ledger.retained_bytes == before
    assert {identity: node.references for identity, node in ledger.nodes.items()} == references
    ledger.bookkeeping_limit_bytes = 1
    with pytest.raises(DomainError) as error:
        ledger.reserve("bounded", {"shared": shared})
    assert error.value.code == "query_accounting_capacity"
    assert ledger.retained_bytes == before
    assert {identity: node.references for identity, node in ledger.nodes.items()} == references
    ledger.release("existing")
    ledger.release("existing")
    assert not ledger.nodes and not ledger.roots and ledger.retained_bytes == 0


def test_transactional_replacement_credits_only_declared_overhead_and_preserves_old_root_on_failure():
    shared = {"retained": [1, 2, 3]}
    first = {"shared": shared, "state": "preparing"}
    ledger = QueryResourceLedger()
    ledger.reserve("handle", first, overhead=8192)
    ledger.limit_bytes = ledger.retained_bytes
    replacement = {"shared": shared, "state": "failed", "error": {"code": "invalid_query"}}
    ledger.replace("handle", replacement)
    assert ledger.retained_bytes == measured([replacement])
    before = ledger.retained_bytes
    ledger.limit_bytes = before
    with pytest.raises(DomainError):
        ledger.replace("handle", {"other": "x" * 10000})
    assert ledger.retained_bytes == before and ledger.roots["handle"][0] is replacement
    ledger.release("handle")
    assert ledger.retained_bytes == 0 and not ledger.nodes


def test_one_thousand_seeded_shared_graph_retain_release_oracles():
    rng = random.Random(629)
    values = [{"index": index, "values": [index, str(index)]} for index in range(100)]
    ledger, active = QueryResourceLedger(), {}
    for step in range(1000):
        if active and rng.random() < 0.45:
            key = rng.choice(list(active))
            ledger.release(key)
            del active[key]
        else:
            root = [rng.choice(values) for _ in range(rng.randrange(1, 12))]
            ledger.reserve(step, root)
            active[step] = root
        assert ledger.retained_bytes == measured(active.values())
    for key in active:
        ledger.release(key)
    assert ledger.retained_bytes == 0


def test_four_queries_per_trusted_principal_not_four_globally(client, bundle, app):
    _, _, alice = create_identity(client)
    _, _, bob = create_identity(client)
    handles = []
    for headers in (alice, bob):
        for _ in range(4):
            result = client.post(BASE + "/query-sessions", headers=headers, json={"domain": bundle["settings"]["overview"]})
            assert result.status_code == 200, result.text
            handles.append((headers, result.json()))
        rejected = client.post(BASE + "/query-sessions", headers=headers, json={"domain": bundle["settings"]["overview"]})
        assert rejected.status_code == 429 and rejected.json()["code"] == "query_capacity"
    assert len(app.state.queries.queries) == 8
    for headers, handle in handles:
        assert client.get(BASE + "/query-sessions/" + handle["queryId"], headers=headers).json() == handle
        assert client.delete(BASE + "/query-sessions/" + handle["queryId"], headers=headers).status_code == 204
    assert app.state.queries.resource_stats()["retainedBytes"] == 0


def test_http_layout_inspection_is_immutable_owned_and_reports_expiry(client, bundle, app):
    _, _, alice = create_identity(client)
    _, _, bob = create_identity(client)
    query = client.post(BASE + "/query-sessions", headers=alice, json={"domain": bundle["settings"]["overview"]}).json()
    prefix = BASE + "/query-sessions/" + query["queryId"]
    request = {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000, "availableHeight": 480}
    created = client.post(prefix + "/layouts", headers=alice, json=request)
    assert created.status_code == 200, created.text
    manifest = created.json()
    path = prefix + "/layouts/" + manifest["layoutId"]
    response = client.get(path, headers=alice)
    assert response.status_code == 200 and response.json() == manifest
    assert client.get(path, headers=bob).status_code == 404
    visits = app.state.queries.resources.graph_visits
    assert client.get(path, headers=alice).json() == manifest
    assert app.state.queries.resources.graph_visits == visits
    assert client.get(prefix + "/layouts/00000000-0000-4000-8000-000000000000", headers=alice).status_code == 404
    with app.state.queries.mutex:
        app.state.queries.queries[query["queryId"]]["expires"] = 0
    expired = client.get(path, headers=alice)
    assert expired.status_code == 410 and expired.json()["code"] == "query_expired"
    assert client.get(path, headers=bob).status_code == 404
    assert app.state.queries.resources.retained_bytes == 0


@pytest.fixture
def engine(bundle):
    value = QueryEngine(SnapshotRepository(bundle), ROOT / "shared/fixtures/font-metrics.json", cleanup_interval_seconds=0)
    try:
        yield value
    finally:
        value.close()


def prepare(engine, bundle):
    query = engine.create_query({"domain": bundle["settings"]["overview"]})
    request = {**bundle["settings"]["range"], "mapId": query["mapId"], "width": 1000, "availableHeight": 480}
    return query, request


def test_layout_inspection_retains_shared_records_and_page_reads_never_rescan_accounting(engine, bundle):
    query, request = prepare(engine, bundle)
    layout = engine.create_layout(query["queryId"], request)
    assert engine.get_layout(query["queryId"], layout["layoutId"]) == layout
    stored = engine.queries[query["queryId"]]
    records = {record["id"]: record for record in stored["records"]}
    assert all(item["record"] is records[item["record"]["id"]] for item in stored["layouts"][layout["layoutId"]]["items"])
    engine.query_records(query["queryId"], {"limit": 10})
    visits = engine.resources.graph_visits
    for _ in range(10):
        page = engine.rows(query["queryId"], layout["layoutId"])
        if page["items"]:
            page["items"][0]["record"]["title"] = "Caller mutation"
        engine.query_records(query["queryId"], {"limit": 10})
        engine.get_layout(query["queryId"], layout["layoutId"])
    assert engine.resources.graph_visits == visits
    assert all(record["title"] != "Caller mutation" for record in records.values())
    inspected = engine.get_layout(query["queryId"], layout["layoutId"])
    inspected["width"] = 50
    assert engine.get_layout(query["queryId"], layout["layoutId"]) == layout
    engine.release_query(query["queryId"])
    assert engine.resources.retained_bytes == 0 and not engine.resources.roots


def test_query_layout_and_table_failure_publish_nothing_and_evict_no_live_handles(engine, bundle):
    query, request = prepare(engine, bundle)
    before = engine.resources.retained_bytes
    engine.resources.limit_bytes = before
    for operation in (lambda: engine.create_query({"domain": bundle["settings"]["overview"]}),
                      lambda: engine.create_layout(query["queryId"], request),
                      lambda: engine.query_records(query["queryId"], {"limit": 10})):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "query_memory_capacity"
        assert engine.resources.retained_bytes == before
        assert list(engine.queries) == [query["queryId"]]
        assert not engine.queries[query["queryId"]]["layouts"] and not engine.queries[query["queryId"]]["tables"]
    assert engine.get_query(query["queryId"]) == query


def test_table_cache_replacement_releases_only_reconstructible_index(engine, bundle):
    query, _ = prepare(engine, bundle)
    for field in ("start", "title", "end"):
        engine.query_records(query["queryId"], {"sort": [{"field": field, "direction": "asc"}]})
    assert len(engine.queries[query["queryId"]]["tables"]) == 2
    assert len(engine.resources.roots) == 3
    engine.release_snapshot(query["snapshotId"])
    assert engine.resources.retained_bytes == 0


def test_expiry_and_permission_invalidation_release_all_artifacts_without_foreign_disclosure(engine, bundle):
    alice = {"principalId": "alice", "fingerprint": "old", "sourceIds": ["operations"], "actor": {"id": "alice", "capabilities": ["*"]}}
    with query_access(alice):
        query, request = prepare(engine, bundle)
        engine.create_layout(query["queryId"], request)
        engine.query_records(query["queryId"], {})
    with query_access({**alice, "fingerprint": "new"}):
        with pytest.raises(DomainError) as error:
            engine.get_query(query["queryId"])
        assert error.value.code == "permission_scope_changed"
    assert engine.resources.retained_bytes == 0
    with query_access({**alice, "principalId": "bob"}):
        with pytest.raises(DomainError) as error:
            engine.get_query(query["queryId"])
        assert error.value.status == 404
    query, request = prepare(engine, bundle)
    engine.create_layout(query["queryId"], request)
    engine.queries[query["queryId"]]["expires"] = 0
    engine._expire()
    assert engine.resources.retained_bytes == 0
    with pytest.raises(DomainError) as error:
        engine.get_query(query["queryId"])
    assert error.value.status == 410


def test_idle_expiry_and_shutdown_stop_maintenance(bundle):
    engine = QueryEngine(SnapshotRepository(bundle), ROOT / "shared/fixtures/font-metrics.json", ttl_seconds=0.1, cleanup_interval_seconds=0.02)
    try:
        engine.create_query({"domain": bundle["settings"]["overview"]})
        deadline = time.monotonic() + 2
        while engine.resources.retained_bytes and time.monotonic() < deadline:
            time.sleep(0.02)
        assert engine.resources.retained_bytes == 0
    finally:
        engine.close()
    assert not engine._maintenance.is_alive()


def test_preparation_input_bound_is_64k_and_oversize_rejects_before_publication(engine, bundle):
    with pytest.raises(DomainError) as error:
        engine.create_query({"domain": bundle["settings"]["overview"], "extra": "x" * 65536})
    assert error.value.code == "query_request_limit" and not engine.queries
    query, request = prepare(engine, bundle)
    before = copy.deepcopy(engine.resource_stats())
    with pytest.raises(DomainError) as error:
        engine.create_layout(query["queryId"], {**request, "extra": "x" * 65536})
    assert error.value.code == "query_request_limit"
    assert engine.resource_stats() == before
    with pytest.raises(DomainError) as error:
        engine.query_records(query["queryId"], {"extra": "x" * 65536})
    assert error.value.code == "query_request_limit"
    assert engine.resource_stats() == before


def test_closed_engine_rejects_preparation_and_reads_and_releases_every_artifact(engine, bundle):
    query, request = prepare(engine, bundle)
    layout = engine.create_layout(query["queryId"], request)
    engine.query_records(query["queryId"], {})
    engine.close()
    engine.close()
    for operation in (lambda: engine.create_query({"domain": bundle["settings"]["overview"]}),
                      lambda: engine.get_query(query["queryId"]),
                      lambda: engine.get_layout(query["queryId"], layout["layoutId"]),
                      lambda: engine.create_layout(query["queryId"], request),
                      lambda: engine.query_records(query["queryId"], {})):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "query_service_closed" and error.value.status == 503
    assert not engine.queries and not engine.tombstones
    assert not engine.resources.nodes and not engine.resources.roots and engine.resources.retained_bytes == 0
