import json
from pathlib import Path

import pytest

from server.app.models.domain import DomainError
from server.app.services import safe_regex
from server.app.services.filters import compile_expression, compile_search
from server.app.services.safe_regex import compile_regex, create_regex_budget

CORPUS = json.loads((Path(__file__).resolve().parents[2] / "shared/fixtures/regex-cases.json").read_text())


@pytest.mark.parametrize("item", CORPUS["cases"], ids=lambda item: item["id"])
def test_common_dialect(item):
    def operation():
        return compile_regex(item["pattern"], flags=item.get("flags", []), match_mode=item.get("matchMode", "search"))
    if "error" in item:
        with pytest.raises(DomainError) as failure:
            operation()
        assert failure.value.code == item["error"]
        assert failure.value.diagnostic["offset"] == item["offset"]
        assert failure.value.diagnostic["offsetUnit"] == "unicode-codepoint"
    else:
        compiled = operation()
        assert [compiled["test"](value) for value in item["subjects"]] == item["expected"]
        assert compiled["emptyMatch"] == item.get("emptyMatch", False)


def node(**changes):
    return {"op": "regex", "ruleId": "title-match", "field": "/title", "pattern": "^Activity_(5_1|0_3)$", **changes}


def test_predicate_ids_unknown_truth_and_explanations():
    root = node()
    predicate = compile_expression({"version": 2, "root": root})
    assert predicate({"title": "Activity_5_1"})
    assert not predicate({"title": "Activity_0_3_read_descriptor"})
    assert not predicate({}) and not predicate({"title": None})
    negated = compile_expression({"version": 2, "root": {"op": "not", "arg": root}})
    assert not negated({}) and not negated({"title": None})
    assert predicate.explain({"title": "Activity_5_1"}) == {"matched": True, "rules": [{"ruleId": "title-match", "field": "/title", "op": "regex"}], "truncated": False}
    for expression in [{"version": 1, "root": root}, {"version": 2, "root": {"op": "or", "args": [root, root]}}, {"version": 2, "root": node(field="/order")}]:
        with pytest.raises(DomainError):
            compile_expression(expression)


def test_explicit_v2_search_fields_and_flags():
    request = {"definitionVersion": 2, "searchMode": "regex", "search": "Activity_[05]_[13]", "searchFields": ["/title"], "searchMatchMode": "full"}
    search = compile_search(request)
    assert search["matches"]({"title": "Activity_5_1"})
    assert not search["matches"]({"title": "Activity_5_1_suffix"})
    assert search["explain"]({"title": "Activity_5_1"}) == {"matched": True, "rules": [{"ruleId": "search", "field": "/title", "op": "regex"}], "truncated": False}
    for changes in [{"definitionVersion": 1}, {"search": ""}, {"searchFields": ["/order"]}, {"searchCaseSensitive": False}, {"searchFlags": None}]:
        with pytest.raises(DomainError):
            compile_search({**request, **changes})
    for request in [{"searchFlags": []}, {"definitionVersion": 2, "searchFlags": []}]:
        with pytest.raises(DomainError):
            compile_search(request)
    assert compile_search({"search": "STRASSE"})["matches"]({"title": "Stra\u00dfe"})
    assert not compile_search({"definitionVersion": 2, "searchMode": "regex", "search": "STRASSE", "searchFlags": ["i"]})["matches"]({"title": "Stra\u00dfe"})


def test_bounded_nodes_bytes_work_and_cancellation():
    with pytest.raises(DomainError):
        compile_regex("x" * 513)
    compile_regex("\U0001f680" * 512)
    assert compile_regex(".{1000}", match_mode="full")["test"]("a" * 1000)
    with pytest.raises(DomainError) as nodes:
        compile_expression({"version": 2, "root": {"op": "and", "args": [node(ruleId=f"r{i}") for i in range(9)]}})
    assert nodes.value.code == "regex_resource_limit"
    budget = create_regex_budget(max_work=3)
    first, second = compile_regex("a", budget=budget), compile_regex("b", budget=budget)
    first["test"]("aa")
    second["test"]("b")
    assert budget.usage == {"bytes": 3, "work": 3}
    with pytest.raises(DomainError) as work:
        second["test"]("b")
    assert work.value.code == "regex_resource_limit" and work.value.status == 413
    with pytest.raises(DomainError):
        compile_regex(".", budget=create_regex_budget(max_bytes=3))["test"]("\U0001f680")

    def cancelled():
        raise DomainError("query_cancelled", "Cancelled", 409)
    with pytest.raises(DomainError) as cancel:
        compile_regex("a", budget=create_regex_budget(check_cancelled=cancelled))["test"]("a")
    assert cancel.value.code == "query_cancelled"
    with pytest.raises(DomainError) as unicode:
        compile_regex(".", flags=["i"])["test"]("\u1c8a")
    assert unicode.value.code == "regex_unicode_version"


def test_engine_failure_has_no_native_regex_fallback(monkeypatch):
    def broken(*args):
        raise RuntimeError("injected engine initialization failure")
    monkeypatch.setattr(safe_regex, "_engine", broken)
    with pytest.raises(DomainError) as failure:
        compile_regex("engine-initialization-probe")
    assert failure.value.code == "regex_engine_failure"


def test_literal_explanations_are_field_scoped_and_bounded():
    search = compile_search({"search": "alpha beta", "searchMode": "all", "searchFields": ["/title", "/data/description"]})
    assert search["explain"]({"title": "Alpha", "data": {"description": "Beta"}}) == {"matched": True, "rules": [{"ruleId": "search-term-1", "field": "/title", "op": "literal"}, {"ruleId": "search-term-2", "field": "/data/description", "op": "literal"}], "truncated": False}
    assert search["explain"]({"title": "Alpha"}) == {"matched": False, "rules": [], "truncated": False}
    assert compile_search({})["explain"]({"title": "Alpha"}) == {"matched": False, "rules": [], "truncated": False}
    bounded = compile_search({"search": " ".join(["x"] * 20), "searchFields": ["/title"]})["explain"]({"title": "x"})
    assert len(bounded["rules"]) == 16 and bounded["truncated"]
