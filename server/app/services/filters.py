"""Bounded, typed filter trees and literal search shared with the browser."""
from __future__ import annotations

import math
import re
import unicodedata
from pathlib import Path

import rfc8785

from ..models.domain import DomainError, folded, instant_ms, intersects, read_json

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


def compile_expression(expression, *, field_types=None):
    registry = FIELD_TYPES if field_types is None else field_types
    if expression is None:
        return lambda record: True
    if not isinstance(expression, dict) or type(expression.get("version")) not in (int, float) or expression["version"] != 1 or set(expression) - {"version", "root"}:
        invalid("Expected a version 1 filter expression")
    count = 0

    def compile_node(node, depth=1):
        nonlocal count
        count += 1
        if not isinstance(node, dict) or not isinstance(node.get("op"), str) or depth > 8 or count > 100:
            invalid("Filter exceeds its structure, depth 8, or 100-node limit")
        op = node["op"]

        def keys(allowed):
            if set(node) - set(allowed):
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
    return lambda record: predicate(record) is True


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


def compile_search(request, *, field_types=None):
    registry = FIELD_TYPES if field_types is None else field_types
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
    return {"active": bool(terms), "terms": terms, "matches": matches_record}
