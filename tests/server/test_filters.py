import copy

import pytest

from conftest import BASE
from server.app.models.domain import DomainError
from server.app.services.filters import compile_expression, compile_search, parse_search


def expression(node):
    return compile_expression({"version": 1, "root": node})


@pytest.mark.parametrize("node,expected", [
    ({"op": "eq", "field": "/order", "value": 5}, True),
    ({"op": "ne", "field": "/order", "value": 5}, False),
    ({"op": "lt", "field": "/order", "value": 6}, True),
    ({"op": "lte", "field": "/order", "value": 5}, True),
    ({"op": "gt", "field": "/order", "value": 4}, True),
    ({"op": "gte", "field": "/order", "value": 6}, False),
    ({"op": "in", "field": "/order", "values": [None, 4, 5]}, True),
    ({"op": "contains", "field": "/title", "value": "STRASSE"}, True),
    ({"op": "contains", "field": "/title", "value": "STRASSE", "caseSensitive": True}, False),
    ({"op": "contains", "field": "/tags", "value": "BLUE"}, True),
    ({"op": "contains", "field": "/tags", "value": "blu"}, False),
    ({"op": "exists", "field": "/data/status", "value": True}, True),
    ({"op": "eq", "field": "/data/status", "value": None}, True),
    ({"op": "in", "field": "/data/status", "values": [None, "ready"]}, True),
    ({"op": "exists", "field": "/data/system", "value": False}, True),
])
def test_typed_predicates(node, expected):
    record = {"title": "Stra\u00dfe", "order": 5, "tags": ["Blue", "green"], "data": {"status": None}}
    assert expression(node)(record) is expected


def test_three_valued_missing_null_boolean_logic():
    missing = {"op": "eq", "field": "/data/status", "value": "ok"}
    true = {"op": "eq", "field": "/title", "value": "a"}
    false = {"op": "eq", "field": "/title", "value": "b"}
    record = {"title": "a", "data": {}}
    for node in [missing, {"op": "not", "arg": missing}, {"op": "and", "args": [missing, true]},
                 {"op": "or", "args": [missing, false]}, {"op": "not", "arg": {"op": "or", "args": [missing, false]}}]:
        assert expression(node)(record) is False
    assert expression({"op": "or", "args": [missing, true]})(record)
    assert expression({"op": "not", "arg": {"op": "and", "args": [missing, false]}})(record)
    null_record = {"title": "a", "data": {"status": None}}
    assert expression({"op": "exists", "field": "/data/status", "value": True})(null_record)
    assert not expression({"op": "not", "arg": {"op": "gt", "field": "/data/status", "value": "a"}})(null_record)


def test_date_and_nfc_codepoint_order():
    record = {"start": "2026-09-12T12:00:00.000Z", "title": "e\u0301", "data": {"status": "\U0001f600"}}
    assert expression({"op": "eq", "field": "/start", "value": "2026-09-12T08:00:00.000-04:00"})(record)
    assert expression({"op": "eq", "field": "/title", "value": "\u00e9"})(record)
    assert expression({"op": "gt", "field": "/data/status", "value": "\ue000"})(record)


@pytest.mark.parametrize("kind,start,end,expected", [
    ("event", "12:00", None, True), ("event", "13:00", None, False),
    ("session", "12:00", "12:00", True), ("session", "13:00", "13:00", False),
    ("session", "11:00", "12:00", False), ("session", "11:00", "14:00", True),
    ("session", "11:00", None, True),
])
def test_overlap_operator_half_open_and_duration_rules(kind, start, end, expected):
    record = {"kind": kind, "start": f"2026-09-12T{start}:00.000Z", "end": f"2026-09-12T{end}:00.000Z" if end else None}
    predicate = expression({"op": "overlaps", "from": "2026-09-12T12:00:00.000Z", "to": "2026-09-12T13:00:00.000Z"})
    assert predicate(record) is expected


@pytest.mark.parametrize("node", [
    {"op": "regex", "field": "/title", "value": "a*"},
    {"op": "eq", "field": "/data/custom", "value": "x"},
    {"op": "eq", "field": "/data/__proto__", "value": "x"},
    {"op": "eq", "field": "/order", "value": "5"},
    {"op": "eq", "field": "/order", "value": True},
    {"op": "eq", "field": "/start", "value": 1000},
    {"op": "eq", "field": "/start", "value": "2026-09-12"},
    {"op": "eq", "field": "/start", "value": "2026-09-12T00:00:00.0001Z"},
    {"op": "eq", "field": "/title"},
    {"op": "eq", "field": "/title", "value": "x", "caseSensitive": True},
    {"op": "eq", "field": "/tags", "value": ["x"]},
    {"op": "contains", "field": "/order", "value": 5},
    {"op": "contains", "field": "/title", "value": None},
    {"op": "contains", "field": "/title", "value": "x", "caseSensitive": "yes"},
    {"op": "exists", "field": "/title", "value": 1},
    {"op": "in", "field": "/title", "values": []},
    {"op": "in", "field": "/title", "values": ["x"] * 101},
    {"op": "and", "args": []},
    {"op": "not"},
    {"op": "overlaps", "from": 1, "to": 2},
    {"op": "overlaps", "from": "2026-09-12T12:00:00.000Z", "to": "2026-09-12T12:00:00.000Z"},
])
def test_invalid_expression_nodes_are_rejected(node):
    with pytest.raises(DomainError) as caught:
        expression(node)
    assert caught.value.code == "invalid_filter"


def test_expression_structure_node_and_depth_limits_and_full_type_evaluation():
    leaf = {"op": "eq", "field": "/title", "value": "x"}
    expression({"op": "and", "args": [leaf] * 99})
    with pytest.raises(DomainError):
        expression({"op": "and", "args": [leaf] * 100})
    nested = leaf
    for _ in range(7):
        nested = {"op": "not", "arg": nested}
    expression(nested)
    with pytest.raises(DomainError):
        expression({"op": "not", "arg": nested})
    assert compile_expression({"version": 1.0, "root": leaf})({"title": "x"})
    for value in [False, [], {}, {"version": True, "root": leaf}, {"version": 1, "root": leaf, "other": True}]:
        with pytest.raises(DomainError):
            compile_expression(value)
    predicate = expression({"op": "or", "args": [leaf, {"op": "eq", "field": "/data/status", "value": "ready"}]})
    with pytest.raises(DomainError):
        predicate({"title": "x", "data": {"status": {"not": "text"}}})


def test_any_all_phrase_case_and_field_search():
    record = {"title": "Alpha Stra\u00dfe", "data": {"description": "beta delta", "status": "ok"}, "order": 12}
    assert compile_search({"search": "alpha;missing"})["matches"](record)
    assert compile_search({"search": 'alpha "beta delta"', "searchMode": "all"})["matches"](record)
    assert not compile_search({"search": "alpha missing", "searchMode": "all"})["matches"](record)
    assert compile_search({"search": "  beta delta  ", "searchMode": "phrase"})["matches"](record)
    assert not compile_search({"search": "Alpha beta", "searchMode": "phrase"})["matches"](record)
    assert compile_search({"search": "STRASSE"})["matches"](record)
    assert not compile_search({"search": "STRASSE", "searchCaseSensitive": True})["matches"](record)
    assert compile_search({"search": "12", "searchFields": ["/order"]})["matches"](record)
    assert not compile_search({"search": "beta", "searchFields": ["/title"]})["matches"](record)
    assert compile_search({"search": ""})["active"] is False


def test_search_grammar_unicode_and_limits():
    assert parse_search('one;"two three" "quote\\\"" "slash\\\\"') == ["one", "two three", 'quote"', "slash\\"]
    assert parse_search("\ufeffalpha\u2003beta\u0085gamma") == ["alpha", "beta", "gamma"]
    assert parse_search("\U0001f600" * 512, "phrase") == ["\U0001f600" * 512]
    assert parse_search("a; b", "phrase") == ["a; b"]
    for text in ['"bad', "bad\\", "bad\\x", "\U0001f600" * 513, " ".join(["a"] * 21)]:
        with pytest.raises(DomainError) as caught:
            parse_search(text)
        assert caught.value.code == "invalid_search"
    for request in [{"searchMode": "exact"}, {"searchCaseSensitive": 1}, {"searchFields": []},
                    {"searchFields": ["/title", "/title"]}, {"searchFields": ["/tags"]},
                    {"searchFields": ["/data/constructor"]}]:
        with pytest.raises(DomainError):
            compile_search(request)


def test_query_expression_applies_to_all_artifacts_and_pinned_revision(client, app, bundle, write_headers):
    selected = bundle["records"][0]
    ast = {"version": 1, "root": {"op": "eq", "field": "/id", "value": selected["id"]}}
    request = {"domain": bundle["settings"]["overview"], "filters": {"expression": ast}, "search": selected["title"], "searchMode": "phrase"}
    response = client.post(BASE + "/query-sessions", json=request)
    assert response.status_code == 200, response.text
    query = response.json()
    path = BASE + "/query-sessions/" + query["queryId"]
    assert query["baseTotal"] == query["matchTotal"] == 1
    assert client.get(path + "/density").json()["total"] == 1
    assert [item["id"] for item in client.get(path + "/overview").json()["items"]] == [selected["id"]]
    table = client.post(path + "/records/query", json={}).json()
    assert [item["record"]["id"] for item in table["items"]] == [selected["id"]]
    changed = client.patch(BASE + "/records/" + selected["id"], json=[{"op": "replace", "path": "/title", "value": "Different title"}],
                           headers={**write_headers, "Content-Type": "application/json-patch+json", "If-Match": f'"{write_headers["X-Workspace-Generation"]}:{selected["version"]}"'})
    assert changed.status_code == 200
    assert client.get(path + "/overview").json()["matched"] == 1
    fresh = client.post(BASE + "/query-sessions", json=request).json()
    assert fresh["baseTotal"] == 1 and fresh["matchTotal"] == 0
    malformed = copy.deepcopy(request)
    malformed["filters"]["surprise"] = True
    failure = client.post(BASE + "/query-sessions", json=malformed)
    assert failure.status_code == 422 and failure.json()["code"] == "invalid_filter"
