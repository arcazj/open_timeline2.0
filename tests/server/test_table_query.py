import copy
import uuid
from contextlib import contextmanager
from decimal import Decimal

import pytest
import rfc8785
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from server.app.main import create_app
from server.app.models.domain import DomainError, instant_ms, iso_from_ms
from server.app.repositories.json_repository import atomic_json
from server.app.services.query import continuous, decimal_string
from server.app.services.table_query import TABLE_ITEM_BUDGET, TABLE_RESPONSE_BYTES, prepare_table, normalize_table_input
from server.app.models.configuration_catalog import apply_configuration_command
from test_api import prepared


def create_query(client, bundle, **fields):
    response = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"], **fields})
    return prepared(client, response).json()


def table(client, query, **fields):
    return client.post(BASE + f'/query-sessions/{query["queryId"]}/records/query', json=fields)


def record(bundle, index, **fields):
    item = copy.deepcopy(bundle["records"][0])
    item.update(id=str(uuid.UUID(int=index)), title=f"Item {index}", kind="event", start="2026-09-12T12:00:00.000Z",
                end=None, parentSessionId=None, order=index, data={})
    item.update(fields)
    return item


@contextmanager
def fixture_client(tmp_path, bundle, records):
    value = copy.deepcopy(bundle)
    value["records"] = records
    value["manifest"]["recordCount"] = len(records)
    value["manifest"].pop("contentSha256", None)
    path = tmp_path / "fixture.json"
    atomic_json(path, value)
    with TestClient(create_app(tmp_path / "data", TOKEN, path), headers={"Authorization": "Bearer " + TOKEN}) as client:
        yield client


def test_table_traverses_complete_query_not_loaded_timeline_rows(client, bundle):
    query = create_query(client, bundle)
    layout = client.post(BASE + f'/query-sessions/{query["queryId"]}/layouts', json={
        "mapId": query["mapId"], **bundle["settings"]["range"], "width": 1200, "availableHeight": 64,
    }).json()
    row_page = client.get(BASE + f'/query-sessions/{query["queryId"]}/layouts/{layout["layoutId"]}/rows').json()
    assert row_page["loadedCount"] < 48
    cursor, found, pages = None, [], []
    while True:
        response = table(client, query, limit=17, cursor=cursor)
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["queryId"] == query["queryId"] and page["snapshotId"] == query["snapshotId"]
        assert page["revision"] == query["revision"]
        assert page["total"] == page["baseTotal"] == page["matchTotal"] == 48
        assert page["matchActive"] is False and page["pageComplete"] is True
        found.extend(item["record"]["id"] for item in page["items"])
        pages.append(page)
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert [len(page["items"]) for page in pages] == [17, 17, 14]
    assert len(found) == len(set(found)) == 48
    assert pages[-1]["pageIndex"] == 2 and pages[-1]["pageCount"] == 3
    previous = table(client, query, limit=17, cursor=pages[-1]["previousCursor"]).json()
    assert previous["items"] == pages[1]["items"]


def test_unicode_nfc_codepoint_sort_and_id_ties(tmp_path, bundle):
    titles = ["z", "a", "A", "\u00e9", "e\u0301", "\ue000", "\U00010000"]
    records = [record(bundle, index, title=title) for index, title in enumerate(titles, 1)]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle)
        ascending = table(client, query, sort=[{"field": "title", "direction": "asc"}]).json()
        descending = table(client, query, sort=[{"field": "title", "direction": "desc"}]).json()
        def indices(page):
            return [uuid.UUID(item["record"]["id"]).int for item in page["items"]]
        assert indices(ascending) == [3, 2, 1, 4, 5, 6, 7]
        assert indices(descending) == [7, 6, 4, 5, 1, 2, 3]


def test_null_missing_sort_last_in_both_directions_and_multisort(tmp_path, bundle):
    actor = {"id": "fixture", "capabilities": ["*"]}
    created = apply_configuration_command(bundle, {"family": "schemas", "type": "create", "generation": bundle["manifest"]["generation"],
        "clientCommandId": "fixture-create", "payload": {"name": "Nullable state", "visibility": "workspace", "definition": {"schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "additionalProperties": False,
            "properties": {"state": {"type": ["string", "null"]}}}}}}, actor=actor)
    published = apply_configuration_command(created["snapshot"], {"family": "schemas", "type": "publish", "resourceId": created["resource"]["id"],
        "expectedRevision": 1, "generation": bundle["manifest"]["generation"], "clientCommandId": "fixture-publish", "payload": {}}, actor=actor)
    bundle = published["snapshot"]
    pin = {"schemaId": created["resource"]["id"], "schemaVersion": 1}
    records = [record(bundle, 1, data={"state": "Zulu"}, **pin), record(bundle, 2, data={"state": None}, **pin),
               record(bundle, 3, **pin), record(bundle, 4, data={"state": "alpha"}, **pin),
               record(bundle, 5, data={"state": "Alpha"}, **pin), record(bundle, 6, data={"state": "Alpha"}, **pin)]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle, filters={"schemaRefs": [{"id": pin["schemaId"], "version": 1}]})
        for direction, expected in (("asc", [5, 6, 1, 4, 2, 3]), ("desc", [4, 1, 5, 6, 2, 3])):
            page = table(client, query, sort=[{"field": "/data/state", "direction": direction}]).json()
            assert [uuid.UUID(item["record"]["id"]).int for item in page["items"]] == expected
        multi = table(client, query, sort=[{"field": "/data/state", "direction": "asc"}, {"field": "order", "direction": "desc"}]).json()
        assert [uuid.UUID(item["record"]["id"]).int for item in multi["items"]] == [6, 5, 1, 4, 2, 3]


def test_dates_sort_by_instant_not_offset_spelling_and_nulls_stay_last(tmp_path, bundle):
    records = [record(bundle, 1, start="2026-09-12T12:00:00.000Z"),
               record(bundle, 2, start="2026-09-12T08:00:00.000-04:00"),
               record(bundle, 3, kind="session", end="2026-09-12T13:00:00.000Z"),
               record(bundle, 4, kind="session", end="2026-09-12T14:00:00.000Z")]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle)
        default = table(client, query).json()
        assert [uuid.UUID(item["record"]["id"]).int for item in default["items"]] == [1, 2, 3, 4]
        ended = table(client, query, sort=[{"field": "end", "direction": "desc"}]).json()
        assert [uuid.UUID(item["record"]["id"]).int for item in ended["items"]] == [4, 3, 1, 2]


def test_exact_window_half_open_edges_and_sessions_spanning_boundaries(tmp_path, bundle):
    start = instant_ms("2026-09-12T12:00:00.000Z")
    def stamp(offset):
        return iso_from_ms(start + offset)
    records = [record(bundle, 1, start=stamp(0)), record(bundle, 2, start=stamp(10)),
               record(bundle, 3, kind="session", start=stamp(-10), end=stamp(0)),
               record(bundle, 4, kind="session", start=stamp(-10), end=stamp(1)),
               record(bundle, 5, kind="session", start=stamp(10), end=stamp(20)),
               record(bundle, 6, kind="session", start=stamp(0), end=stamp(0)),
               record(bundle, 7, kind="session", start=stamp(10), end=stamp(10)),
               record(bundle, 8, kind="session", start=stamp(-10), end=None)]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle)
        page = table(client, query, scope="window", window={"from": stamp(0), "to": stamp(10)}).json()
        assert {uuid.UUID(item["record"]["id"]).int for item in page["items"]} == {1, 4, 6, 8}
        assert page["total"] == 4


def test_fractional_window_is_exact_and_defaults_normalize_cursor_identity(tmp_path, bundle):
    start = instant_ms("2026-09-12T12:00:00.000Z")
    records = [record(bundle, index + 1, start=iso_from_ms(start + index)) for index in range(3)]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle)
        request = {"scope": "window", "window": {"from": iso_from_ms(start), "to": iso_from_ms(start + 2),
                   "viewFromMs": str(start) + ".25", "viewToMs": str(start + 1) + ".25"}}
        page = table(client, query, **request).json()
        assert [uuid.UUID(item["record"]["id"]).int for item in page["items"]] == [2]
        assert page["window"]["from"] == iso_from_ms(start)
        assert page["window"]["to"] == iso_from_ms(start + 2)
        assert page["window"]["viewFromMs"] == str(start) + ".25"
        first = table(client, query).json()
        explicit = table(client, query, scope="all", window=None, projection="context",
                         sort=[{"field": "start", "direction": "asc"}], limit=100, cursor=None).json()
        assert first["tableId"] == explicit["tableId"]


def test_context_matches_and_outside_overview_scopes(tmp_path, bundle):
    records = [record(bundle, 1, title="Find me"), record(bundle, 2, title="Other"),
               record(bundle, 3, title="Find earlier", start="2026-09-11T12:00:00.000Z")]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle, search="Find")
        assert query["overviewTotal"] == 2
        context = table(client, query).json()
        assert context["total"] == context["baseTotal"] == 3 and context["matchTotal"] == 2
        matched = table(client, query, projection="matches").json()
        assert matched["total"] == 2 and matched["baseTotal"] == 3 and matched["matchActive"]
        assert all(item["match"] for item in matched["items"])
        windowed = table(client, query, projection="matches", scope="window", window=bundle["settings"]["range"]).json()
        assert windowed["total"] == 1 and windowed["baseTotal"] == 2


def test_sort_validation_covers_all_selected_records_not_only_first_page(tmp_path, bundle):
    records = [record(bundle, 1, title="Keep", data={"status": "Good"}), record(bundle, 2, title="Bad", data={"status": 12})]
    with pytest.raises(DomainError) as failure:
        with fixture_client(tmp_path, bundle, records):
            pytest.fail("Malformed built-in data reached readiness")
    assert failure.value.code == "invalid_record_data"
    query = {"records": records, "matchIds": {records[0]["id"]}}
    request = {"sort": [{"field": "data.status", "direction": "asc"}], "limit": 1}
    options, _ = normalize_table_input(request, bundle["settings"]["overview"], continuous, decimal_string)
    with pytest.raises(DomainError) as failure:
        prepare_table(query, options)
    assert failure.value.code == "invalid_table_sort"
    valid = prepare_table(query, {**options, "projection": "matches"})
    assert len(valid["records"]) == 1


def test_pinned_table_survives_live_edits_and_lru_rebuild(client, bundle, write_headers, app):
    query = create_query(client, bundle)
    first = table(client, query, limit=7).json()
    expected = table(client, query, limit=7, cursor=first["nextCursor"]).json()
    created = client.post(BASE + "/records", json={"title": "AAA newest", "start": "2026-09-12T01:00:00Z"}, headers=write_headers)
    assert created.status_code == 201
    table(client, query, sort=[{"field": "title", "direction": "asc"}])
    table(client, query, sort=[{"field": "order", "direction": "desc"}])
    assert len(app.state.queries.queries[query["queryId"]]["tables"]) == 2
    replay = table(client, query, limit=7, cursor=first["nextCursor"]).json()
    assert replay == expected and replay["revision"] == 1
    fresh = create_query(client, bundle)
    assert table(client, fresh).json()["total"] == 49
    assert table(client, fresh, limit=7, cursor=first["nextCursor"]).status_code == 400
    assert table(client, query, limit=8, cursor=first["nextCursor"]).status_code == 400
    assert table(client, query, limit=7, projection="matches", cursor=first["nextCursor"]).status_code == 400
    assert table(client, query, limit=7, cursor="altered").status_code == 400
    assert table(client, query, limit=7, sort=[{"field": "start", "direction": "desc"}], cursor=first["nextCursor"]).status_code == 400


def test_canonical_byte_pages_are_bounded_complete_and_stable(tmp_path, bundle):
    records = [record(bundle, index, extensions={"body": "x" * 185000, "numbers": [1.0] * 6000}) for index in range(1, 19)]
    with fixture_client(tmp_path, bundle, records) as client:
        query = create_query(client, bundle)
        cursor, found, page_count = None, [], None
        while True:
            response = table(client, query, limit=1000, cursor=cursor)
            assert response.status_code == 200, response.text[:300]
            page = response.json()
            assert response.content == rfc8785.dumps(page)
            assert len(response.content) <= TABLE_RESPONSE_BYTES
            assert sum(len(rfc8785.dumps(item)) + 1 for item in page["items"]) <= TABLE_ITEM_BUDGET
            assert 0 < len(page["items"]) < 18
            page_count = page_count or page["pageCount"]
            assert page["pageCount"] == page_count
            found.extend(item["record"]["id"] for item in page["items"])
            cursor = page["nextCursor"]
            if cursor is None:
                break
        assert page_count > 1
        assert len(found) == len(set(found)) == 18


@pytest.mark.parametrize("input_value", [{"limit": 0}, {"limit": 1001}, {"limit": True}, {"offset": 2}, {"scope": "bad"},
                                     {"sort": []}, {"sort": [{"field": "data.private", "direction": "asc"}]},
                                     {"sort": [{"field": "start", "direction": "asc"}, {"field": "start", "direction": "desc"}]},
                                     {"sort": [{"field": "start", "direction": "bad"}]}, {"scope": "window"},
                                     {"projection": "bad"}])
def test_table_request_validation(client, bundle, input_value):
    query = create_query(client, bundle)
    assert table(client, query, **input_value).status_code == 422


def test_empty_scope_auth_expiry_and_precision_limits(client, bundle, app):
    query = create_query(client, bundle, filters={"sourceId": "absent"})
    page = table(client, query).json()
    assert page["items"] == [] and page["total"] == 0 and page["pageCount"] == 1
    assert page["startIndex"] == page["endIndex"] == 0
    assert page["nextCursor"] is None and page["previousCursor"] is None
    denied = client.post(BASE + f'/query-sessions/{query["queryId"]}/records/query', json={}, headers={"Authorization": ""})
    assert denied.status_code == 401
    app.state.queries.queries[query["queryId"]]["expires"] = 0
    assert table(client, query).status_code == 410
    assert decimal_string(continuous("-0", 1)) == "0"
    with pytest.raises(DomainError, match="out of range"):
        continuous("1.1234567890123456789012345678901234", 1)
    assert continuous("1.123456789012345678901234567890123", 1) == Decimal("1.123456789012345678901234567890123")
