"""Bounded, typed filter trees and literal search shared with the browser."""
from __future__ import annotations

import math
import re
import unicodedata
from pathlib import Path

import rfc8785

from ..models.domain import DomainError, folded, instant_ms, intersects, read_json
from .safe_regex import REGEX_CAPABILITIES, compile_regex, create_regex_budget, regex_error

FIELD_TYPES = read_json(Path(__file__).resolve().parents[3] / "shared/fixtures/filter-fields.json")
MISSING = object()
WHITESPACE = re.compile(r"[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
SEARCH_FIELDS = ["/title", "/data/description", "/data/text", "/data/system", "/data/type", "/data/status"]


def invalid(message):
    raise DomainError("invalid_filter", message, 422)


def field_value(record, path):
    value = record
    for encoded in path[1:].split("/"):
        segment = encoded.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or segment not in value:
            return MISSING
        value = value[segment]
    return value


def typed(value, kind, path):
    if value is None:
        return None
    if kind == "date":
        try:
            return instant_ms(value)
        except (DomainError, TypeError):
            invalid(f"{path} requires an offset timestamp")
    if kind == "number" and type(value) in (int, float) and math.isfinite(value):
        return value
    if kind == "boolean" and type(value) is bool:
        return value
    if kind == "string" and isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if kind == "strings" and isinstance(value, list) and all(isinstance(item, str) for item in value):
        return [unicodedata.normalize("NFC", item) for item in value]
    invalid(f"{path} has an incompatible value type")


def compile_expression(expression, *, field_types=None, regex_budget=None):
    registry = FIELD_TYPES if field_types is None else field_types
    regex_budget = create_regex_budget() if regex_budget is None else regex_budget
    if expression is None:
        return lambda record: True
    if not isinstance(expression, dict) or type(expression.get("version")) not in (int, float) or expression["version"] not in (1, 2) or set(expression) - {"version", "root"}:
        invalid("Expected a version 1 or 2 filter expression")
    count = regex_count = 0
    rule_ids, explanation_nodes = set(), []

    def compile_node(node, depth=1):
        ordinal = count + 1
        evaluate = compile_inner(node, depth)
        if expression["version"] == 2:
            explanation_nodes.append({"ruleId": node.get("ruleId", f"$node-{ordinal}"), "field": node.get("field"), "op": node["op"], "evaluate": evaluate})
        return evaluate

    def compile_inner(node, depth):
        nonlocal count, regex_count
        count += 1
        if not isinstance(node, dict) or not isinstance(node.get("op"), str) or depth > 8 or count > 100:
            invalid("Filter exceeds its structure, depth 8, or 100-node limit")
        op = node["op"]
        if expression["version"] == 2 and "ruleId" in node:
            rule_id = node["ruleId"]
            if not isinstance(rule_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", rule_id) or rule_id in rule_ids:
                invalid("Rule IDs must be unique 1-64 character identifiers")
            rule_ids.add(rule_id)

        def keys(allowed):
            if set(node) - set(allowed) - ({"ruleId"} if expression["version"] == 2 else set()):
                invalid(f"Unknown field in {op}")

        if op in ("and", "or"):
            keys(["op", "args"])
            if not isinstance(node.get("args"), list) or not 1 <= len(node["args"]) <= 100:
                invalid("Boolean groups require 1-100 expressions")
            children = [compile_node(child, depth + 1) for child in node["args"]]

            def group(record):
                values = [child(record) for child in children]
                if op == "and":
                    return False if False in values else None if None in values else True
                return True if True in values else None if None in values else False
            return group
        if op == "not":
            keys(["op", "arg"])
            child = compile_node(node.get("arg"), depth + 1)

            def negated(record):
                value = child(record)
                return None if value is None else not value
            return negated
        if op == "overlaps":
            keys(["op", "from", "to"])
            try:
                left, right = instant_ms(node.get("from")), instant_ms(node.get("to"))
            except (DomainError, TypeError):
                invalid("Overlap requires valid offset timestamps")
            if left >= right:
                invalid("Overlap interval must be positive")
            return lambda record: intersects(record, left, right)
        field = node.get("field")
        if not isinstance(field, str) or field not in registry:
            invalid("Unknown or undeclared filter field")
        kind = registry[field]
        if op == "exists":
            keys(["op", "field", "value"])
            if type(node.get("value")) is not bool:
                invalid("Exists requires a boolean value")
            return lambda record: (field_value(record, field) is not MISSING) == node["value"]
        if op == "regex" and expression["version"] == 2:
            keys(["op", "field", "pattern", "flags", "matchMode", "dialect"])
            regex_count += 1
            if regex_count > REGEX_CAPABILITIES["regexNodes"]:
                regex_error("regex_resource_limit", "Filter exceeds eight regex nodes", status=413)
            if kind != "string":
                invalid("Regex requires a declared string field")
            compiled = compile_regex(node.get("pattern"), flags=node.get("flags", []), match_mode=node.get("matchMode", "search"),
                                     dialect=node.get("dialect", REGEX_CAPABILITIES["dialect"]), budget=regex_budget, field=field, rule_id=node.get("ruleId"))

            def regex_predicate(record):
                raw = field_value(record, field)
                return None if raw is MISSING or raw is None else compiled["test"](typed(raw, kind, field))
            return regex_predicate
        if op not in ("eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"):
            invalid("Unsupported filter operator")
        keys(["op", "field", "values"] if op == "in" else ["op", "field", "value", "caseSensitive"] if op == "contains" else ["op", "field", "value"])
        if kind == "strings" and op != "contains":
            invalid("Array fields support contains and exists only")
        if kind == "boolean" and op not in ("eq", "ne", "in"):
            invalid("Boolean fields support equality, membership and exists only")
        if op == "contains" and kind not in ("string", "strings"):
            invalid("Contains requires text or a text-array field")
        if "caseSensitive" in node and type(node["caseSensitive"]) is not bool:
            invalid("caseSensitive must be boolean")
        if op == "in":
            values = node.get("values")
            if not isinstance(values, list) or not 1 <= len(values) <= 100:
                invalid("In requires 1-100 typed values")
            expected = [typed(value, kind, field) for value in values]
        else:
            if "value" not in node:
                invalid("Predicate value is required")
            expected = typed(node["value"], "string" if kind == "strings" else kind, field)
            if expected is None and op not in ("eq", "ne"):
                invalid("Null supports equality or inequality only")

        def predicate(record):
            raw = field_value(record, field)
            if raw is MISSING:
                return None
            value = typed(raw, kind, field)
            if op == "eq":
                return value == expected
            if op == "ne":
                return value != expected
            if op == "in":
                return value in expected
            if value is None:
                return None
            if op == "contains":
                normalize = (lambda text: unicodedata.normalize("NFC", text)) if node.get("caseSensitive", False) else folded
                return any(normalize(item) == normalize(expected) for item in value) if kind == "strings" else normalize(expected) in normalize(value)
            comparison = -1 if value < expected else 1 if value > expected else 0
            return {"lt": comparison < 0, "lte": comparison <= 0, "gt": comparison > 0, "gte": comparison >= 0}[op]
        return predicate

    predicate = compile_node(expression.get("root"))

    def result(record):
        return predicate(record) is True

    if expression["version"] == 2:
        def explain(record):
            if not result(record):
                return {"matched": False, "rules": [], "truncated": False}
            hits = [node for node in explanation_nodes if node["evaluate"](record) is True]
            return {"matched": True, "rules": [{"ruleId": node["ruleId"], **({"field": node["field"]} if node["field"] is not None else {}), "op": node["op"]} for node in hits[:16]], "truncated": len(hits) > 16}
        result.explain = explain
    return result


def parse_search(text, mode="any", case_sensitive=False):
    if not isinstance(text, str) or len(text) > 512 or mode not in ("any", "all", "phrase") or type(case_sensitive) is not bool:
        raise DomainError("invalid_search", "Invalid search text, mode or case option", 422)
    terms, term, quoted, escaping = [], [], False, False
    for char in text:
        if escaping:
            if char not in ('"', "\\"):
                raise DomainError("invalid_search", "Only quote and backslash may be escaped", 422)
            term.append(char)
            escaping = False
        elif char == "\\":
            escaping = True
        elif char == '"':
            quoted = not quoted
        elif mode != "phrase" and not quoted and (WHITESPACE.fullmatch(char) or char == ";"):
            if term:
                terms.append("".join(term))
                term = []
        else:
            term.append(char)
    if quoted or escaping:
        raise DomainError("invalid_search", "Unterminated search quote or escape", 422)
    text = "".join(term)
    if mode == "phrase":
        while text and WHITESPACE.fullmatch(text[0]):
            text = text[1:]
        while text and WHITESPACE.fullmatch(text[-1]):
            text = text[:-1]
    if text:
        terms.append(text)
    if len(terms) > 20:
        raise DomainError("invalid_search", "Search exceeds 20 terms", 422)
    normalize = (lambda value: unicodedata.normalize("NFC", value)) if case_sensitive else folded
    return [normalize(term) for term in terms]


def compile_search(request, *, field_types=None, regex_budget=None):
    registry = FIELD_TYPES if field_types is None else field_types
    regex_budget = create_regex_budget() if regex_budget is None else regex_budget
    version = request.get("definitionVersion", 1)
    if type(version) not in (int, float) or version not in (1, 2):
        raise DomainError("invalid_search", "Unsupported query definition version", 422)
    regex_keys = {"searchFlags", "searchMatchMode", "searchDialect"}
    if version == 1 and (request.get("searchMode") == "regex" or regex_keys & set(request)):
        raise DomainError("invalid_search", "Regex search requires query definition version 2", 422)
    if request.get("searchMode") == "regex":
        fields = request.get("searchFields", SEARCH_FIELDS)
        if not isinstance(fields, list) or not 1 <= len(fields) <= 16 or any(not isinstance(field, str) or field not in registry or registry[field] != "string" for field in fields) or len(set(fields)) != len(fields):
            raise DomainError("invalid_search", "Regex search fields must be 1-16 unique declared string fields", 422)
        if "searchCaseSensitive" in request:
            raise DomainError("invalid_search", "Regex search uses explicit flags instead of searchCaseSensitive", 422)
        compiled = compile_regex(request.get("search"), flags=request.get("searchFlags", []), match_mode=request.get("searchMatchMode", "search"),
                                 dialect=request.get("searchDialect", REGEX_CAPABILITIES["dialect"]), budget=regex_budget, rule_id="search")

        def match_fields(record):
            hits = []
            for field in fields:
                value = field_value(record, field)
                if value is MISSING or value is None:
                    continue
                if not isinstance(value, str):
                    raise DomainError("invalid_search", "Regex search field has an incompatible value type", 422)
                if compiled["test"](value, field=field):
                    hits.append(field)
            return hits

        def explain(record):
            hits = match_fields(record)
            return {"matched": bool(hits), "rules": [{"ruleId": "search", "field": field, "op": "regex"} for field in hits], "truncated": False}

        return {"active": True, "terms": [request["search"]], "regex": {key: compiled[key] for key in ("dialect", "flags", "matchMode", "emptyMatch")},
                "matches": lambda record: bool(match_fields(record)), "explain": explain}
    if version == 2 and regex_keys & set(request):
        raise DomainError("invalid_search", "Regex options require regex search mode", 422)
    mode, case_sensitive = request.get("searchMode", "any"), request.get("searchCaseSensitive", False)
    terms = parse_search(request.get("search", ""), mode, case_sensitive)
    fields = request.get("searchFields", SEARCH_FIELDS)
    if not isinstance(fields, list) or not 1 <= len(fields) <= 16 or any(not isinstance(field, str) or field not in registry or registry[field] == "strings" for field in fields) or len(set(fields)) != len(fields):
        raise DomainError("invalid_search", "Search fields must be 1-16 unique declared scalar fields", 422)
    normalize = (lambda value: unicodedata.normalize("NFC", value)) if case_sensitive else folded

    def matches_record(record):
        if not terms:
            return True
        values = [field_value(record, field) for field in fields]
        values = [normalize(value if isinstance(value, str) else rfc8785.dumps(value).decode("utf-8")) for value in values if type(value) in (str, int, float, bool)]
        hits = [any(term in value for value in values) for term in terms]
        return all(hits) if mode == "all" else any(hits)
    def explain(record):
        if not terms or not matches_record(record):
            return {"matched": False, "rules": [], "truncated": False}
        rules = []
        for index, term in enumerate(terms):
            for field in fields:
                value = field_value(record, field)
                if type(value) in (str, int, float, bool) and term in normalize(value if isinstance(value, str) else rfc8785.dumps(value).decode("utf-8")):
                    rules.append({"ruleId": f"search-term-{index + 1}", "field": field, "op": "literal"})
        return {"matched": True, "rules": rules[:16], "truncated": len(rules) > 16}
    return {"active": bool(terms), "terms": terms, "matches": matches_record, "explain": explain}
