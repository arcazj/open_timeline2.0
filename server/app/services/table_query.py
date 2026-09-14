from __future__ import annotations

import copy
import unicodedata
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from functools import cmp_to_key

import rfc8785

from ..models.domain import DomainError, instant_ms, intersects, iso_from_ms
from .filters import field_value, MISSING

TABLE_LIMIT_DEFAULT = 100
TABLE_LIMIT_MAX = 1000
TABLE_RESPONSE_BYTES = 2 * 1024 * 1024
TABLE_ENVELOPE_RESERVE = 16 * 1024
TABLE_ITEM_BUDGET = TABLE_RESPONSE_BYTES - TABLE_ENVELOPE_RESERVE
TABLE_CACHE_LIMIT = 2
SORT_FIELDS = {
    "start": "date", "end": "date", "title": "string", "kind": "string", "sourceId": "string",
    "order": "number", "version": "number", "createdAt": "date", "updatedAt": "date", "data.status": "string",
}


def _pointer(field):
    return field if field.startswith("/") else "/data/" + field[5:] if field.startswith("data.") else "/" + field


def _canonical_field(field):
    return next((candidate for candidate in SORT_FIELDS if _pointer(candidate) == _pointer(field)), _pointer(field))


DEFAULT_TYPES = {_pointer(field): kind for field, kind in SORT_FIELDS.items()}


def normalize_table_input(request, domain, parse_continuous, encode_decimal, field_types=None):
    field_types = DEFAULT_TYPES if field_types is None else field_types
    if not isinstance(request, dict) or set(request) - {"scope", "window", "projection", "sort", "limit", "cursor"}:
        raise DomainError("invalid_table_query", "Table input contains unsupported fields or is not an object.")
    scope = request.get("scope", "all")
    projection = request.get("projection", "context")
    if scope not in ("all", "window") or projection not in ("context", "matches"):
        raise DomainError("invalid_table_query", "Unknown table scope or projection.")
    limit = request.get("limit", TABLE_LIMIT_DEFAULT)
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not 1 <= limit <= TABLE_LIMIT_MAX or int(limit) != limit:
        raise DomainError("invalid_table_query", "Table limit must be an integer from 1 to 1000.")
    sort = request.get("sort", [{"field": "start", "direction": "asc"}])
    if not isinstance(sort, list) or not 1 <= len(sort) <= 3:
        raise DomainError("invalid_table_sort", "Supply one to three distinct table sort fields.")
    normalized_sort, seen = [], set()
    for item in sort:
        if not isinstance(item, dict) or set(item) != {"field", "direction"}:
            raise DomainError("invalid_table_sort", "Sort entries require field and direction only.")
        field, direction = item["field"], item["direction"]
        if not isinstance(field, str) or _pointer(field) not in field_types or field_types[_pointer(field)] == "strings" or _pointer(field) in seen or direction not in ("asc", "desc"):
            raise DomainError("invalid_table_sort", "Sort field, direction or repetition is unsupported.")
        normalized_sort.append({"field": _canonical_field(field), "direction": direction})
        seen.add(_pointer(field))
    window = request.get("window")
    if scope == "all":
        if window is not None:
            raise DomainError("invalid_table_query", "All-record scope cannot also carry a time window.")
        normalized_window = None
    else:
        if not isinstance(window, dict) or not {"from", "to"} <= set(window) or set(window) - {"from", "to", "viewFromMs", "viewToMs"}:
            raise DomainError("invalid_table_query", "Window scope requires from/to and optional exact view bounds.")
        left = parse_continuous(window.get("viewFromMs"), instant_ms(window["from"]))
        right = parse_continuous(window.get("viewToMs"), instant_ms(window["to"]))
        if left >= right:
            raise DomainError("invalid_table_query", "Table window must have positive duration.")
        if left < instant_ms(domain["from"]) or right > instant_ms(domain["to"]):
            raise DomainError("outside_domain", "Current-range table window must stay within the query domain.")
        normalized_window = {"from": iso_from_ms(int(left.to_integral_value(rounding=ROUND_FLOOR))),
                             "to": iso_from_ms(int(right.to_integral_value(rounding=ROUND_CEILING))),
                             "viewFromMs": encode_decimal(left), "viewToMs": encode_decimal(right)}
    cursor = request.get("cursor")
    if cursor is not None and (not isinstance(cursor, str) or not cursor):
        raise DomainError("invalid_table_cursor", "Table cursor must be a nonempty opaque string.", 400)
    return {"scope": scope, "window": normalized_window, "projection": projection,
            "sort": normalized_sort, "limit": int(limit)}, cursor


def sort_value(record, field, field_types=None):
    value = field_value(record, _pointer(field))
    if value is MISSING:
        return 2, None
    if value is None:
        return 1, None
    expected = (DEFAULT_TYPES if field_types is None else field_types)[_pointer(field)]
    if expected in ("string", "date"):
        if not isinstance(value, str):
            raise DomainError("invalid_table_sort", f"Sort field {field} contains an unsupported non-string value.")
        value = instant_ms(value) if expected == "date" else unicodedata.normalize("NFC", value)
    elif expected == "boolean":
        if type(value) is not bool:
            raise DomainError("invalid_table_sort", f"Sort field {field} contains a nonboolean value.")
    elif isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DomainError("invalid_table_sort", f"Sort field {field} contains a nonnumeric value.")
    return 0, value


def prepare_table(query, options):
    from .preparation_control import checked, checkpoint
    records = query["records"]
    window = options["window"]
    if window is not None:
        left, right = Decimal(window["viewFromMs"]), Decimal(window["viewToMs"])
        records = [record for record in checked(records) if intersects(record, left, right)]
    base_total = len(records)
    match_total = sum(record["id"] in query["matchIds"] for record in records)
    if options["projection"] == "matches":
        records = [record for record in records if record["id"] in query["matchIds"]]
    decorated = [(record, [sort_value(record, item["field"], query.get("fieldTypes")) for item in options["sort"]]) for record in checked(records)]

    def compare(left, right):
        checkpoint()
        for index, sort in enumerate(options["sort"]):
            rank_left, value_left = left[1][index]
            rank_right, value_right = right[1][index]
            if rank_left != rank_right:
                return -1 if rank_left < rank_right else 1
            if rank_left == 0 and value_left != value_right:
                sign = -1 if value_left < value_right else 1
                return sign if sort["direction"] == "asc" else -sign
        return (left[0]["id"] > right[0]["id"]) - (left[0]["id"] < right[0]["id"])

    decorated.sort(key=cmp_to_key(compare))
    ordered = [record for record, _ in decorated]
    starts, used, count = [0], 0, 0
    for index, record in enumerate(checked(ordered)):
        item = {"record": record, "match": record["id"] in query["matchIds"]}
        cost = len(rfc8785.dumps(item)) + 1
        if cost > TABLE_ITEM_BUDGET:
            raise DomainError("table_payload_limit", "A record cannot fit the table response byte budget.", 413)
        if count and (count >= options["limit"] or used + cost > TABLE_ITEM_BUDGET):
            starts.append(index)
            used, count = 0, 0
        used += cost
        count += 1
    return {"options": copy.deepcopy(options), "records": ordered, "pageStarts": starts,
            "baseTotal": base_total, "matchTotal": match_total}
