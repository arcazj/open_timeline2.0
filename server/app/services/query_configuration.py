from ..models.configuration_catalog import _resource_at, filter_field_types
from ..models.domain import DomainError
from .filters import compile_expression, compile_search


def resolve_query_configuration(snapshot, request, access=None):
    actor = access["actor"] if access else {"id": "internal", "capabilities": ["*"]}
    filters = request.get("filters", {})
    if not isinstance(filters, dict) or set(filters) - {"kind", "sourceId", "expression", "sourceIds", "kinds", "schemaRefs", "filterId", "filterVersion"}:
        raise DomainError("invalid_filter", "Unknown filter field.")
    if (filters.get("filterId") is None) != (filters.get("filterVersion") is None):
        raise DomainError("invalid_filter", "Filter ID and version must occur together.")
    saved = None
    if filters.get("filterId") is not None:
        resource = _resource_at(snapshot, "filters", filters["filterId"], {"actor": actor})
        saved = next((item["definition"] for item in resource["versions"] if type(filters["filterVersion"]) is int and item["version"] == filters["filterVersion"]), None)
        if saved is None:
            raise DomainError("configuration_version_unavailable", "Saved filter publication is unavailable.", 409)
        if access and saved["sourceIds"] is not None and any(source not in access["sourceIds"] for source in saved["sourceIds"]):
            raise DomainError("configuration_not_found", "Configuration resource is unavailable.", 404)
        if "schemaRefs" in filters and filters["schemaRefs"] != saved["schemaRefs"]:
            raise DomainError("invalid_filter", "A saved filter retains its published schema scope.")
    refs = saved["schemaRefs"] if saved is not None else filters.get("schemaRefs", [])
    if (not isinstance(refs, list) or len(refs) > 100 or any(not isinstance(pin, dict) or set(pin) != {"id", "version"}
            or not isinstance(pin["id"], str) or type(pin["version"]) is not int or pin["version"] < 1 for pin in refs)):
        raise DomainError("invalid_filter", "Schema scope requires bounded exact version pins.")
    for pin in refs:
        _resource_at(snapshot, "schemas", pin["id"], {"actor": actor})
    fields = filter_field_types(snapshot, refs)
    predicate = compile_expression(filters.get("expression"), field_types=fields)
    saved_predicate = compile_expression(saved["expression"] if saved else None, field_types=fields)
    search_input = {"search": saved["search"]["text"], "searchMode": saved["search"]["mode"],
                    "searchCaseSensitive": saved["search"]["caseSensitive"], "searchFields": saved["search"]["fields"], **request} if saved else request
    search = compile_search(search_input, field_types=fields)
    kind, source = filters.get("kind", "all"), filters.get("sourceId", "all")
    if kind not in ("all", "event", "session") or not isinstance(source, str):
        raise DomainError("invalid_filter", "Unknown record kind or source.")
    sources, kinds = filters.get("sourceIds"), filters.get("kinds", ["event", "session"])
    if sources is not None and (not isinstance(sources, list) or len(sources) > 100 or any(not isinstance(item, str) for item in sources) or len(set(sources)) != len(sources)):
        raise DomainError("invalid_filter", "Invalid source list.")
    if not isinstance(kinds, list) or len(kinds) > 2 or any(item not in ("event", "session") for item in kinds) or len(set(kinds)) != len(kinds):
        raise DomainError("invalid_filter", "Invalid kinds list.")
    schema_keys = {(pin["id"], pin["version"]) for pin in refs}

    def matches(record):
        return (record["deletedAt"] is None and (kind == "all" or record["kind"] == kind) and (source == "all" or record["sourceId"] == source)
                and (sources is None or record["sourceId"] in sources) and record["kind"] in kinds
                and (saved is None or ((saved["sourceIds"] is None or record["sourceId"] in saved["sourceIds"]) and record["kind"] in saved["kinds"]))
                and (not schema_keys or (record.get("schemaId"), record.get("schemaVersion")) in schema_keys)
                and saved_predicate(record) and predicate(record))

    return {"predicate": matches, "search": search, "fieldTypes": fields}
