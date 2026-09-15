from ..models.configuration_catalog import _resource_at, filter_field_types
from ..models.domain import DomainError
from .filters import compile_expression, compile_search, create_regex_budget
from .preparation_control import checkpoint


def resolve_query_configuration(snapshot, request, access=None):
    definition_version = request.get('definitionVersion', 1)
    if type(definition_version) is not int or definition_version not in (1, 2):
        raise DomainError('unsupported_query_definition', 'Supported query definition versions are 1 and 2.')
    if definition_version == 1 and 'relationshipMode' in request:
        raise DomainError('unsupported_query_definition', 'Relationship modes require query definition version 2.')
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
    if definition_version == 1 and saved and saved.get('definitionVersion') == 2:
        raise DomainError('unsupported_query_definition', 'Version 2 saved filters require query definition version 2.')
    relationship_mode = request.get('relationshipMode', saved.get('relationshipMode', 'independent') if saved else 'independent')
    if relationship_mode not in ('independent', 'family'):
        raise DomainError('invalid_relationship_mode', 'Choose independent records or family context.')
    refs = saved["schemaRefs"] if saved is not None else filters.get("schemaRefs", [])
    if (not isinstance(refs, list) or len(refs) > 100 or any(not isinstance(pin, dict) or set(pin) != {"id", "version"}
            or not isinstance(pin["id"], str) or type(pin["version"]) is not int or pin["version"] < 1 for pin in refs)):
        raise DomainError("invalid_filter", "Schema scope requires bounded exact version pins.")
    for pin in refs:
        _resource_at(snapshot, "schemas", pin["id"], {"actor": actor})
    fields = filter_field_types(snapshot, refs)
    if definition_version == 1 and any(isinstance(value, dict) and value.get('version') == 2
                                     for value in (filters.get('expression'), saved.get('expression') if saved else None)):
        raise DomainError('unsupported_query_definition', 'Version 2 expressions require query definition version 2.')
    regex_budget = create_regex_budget(check_cancelled=checkpoint)
    predicate = compile_expression(filters.get("expression"), field_types=fields, regex_budget=regex_budget)
    saved_predicate = compile_expression(saved["expression"] if saved else None, field_types=fields, regex_budget=regex_budget)
    if saved:
        saved_search = saved['search']
        search_input = {'search': saved_search['text'], 'searchMode': saved_search['mode'], 'searchFields': saved_search['fields'],
                        **({'searchFlags': saved_search.get('flags', []), 'searchMatchMode': saved_search.get('matchMode', 'search'),
                            'searchDialect': saved_search.get('dialect', 're2-common-v1')} if saved_search['mode'] == 'regex'
                           else {'searchCaseSensitive': saved_search['caseSensitive']}), **request}
    else:
        search_input = request
    if saved and 'searchMode' in request and request['searchMode'] != saved_search['mode']:
        for key in (('searchCaseSensitive',) if request['searchMode'] == 'regex' else ('searchFlags', 'searchMatchMode', 'searchDialect')):
            if key not in request:
                search_input.pop(key, None)
    search = compile_search(search_input, field_types=fields, regex_budget=regex_budget)
    required = snapshot['manifest'].get('legacy', {}).get('configuration', {}).get('sourcePredicates', {})
    if not isinstance(required, dict) or len(required) > 100 or any(identity not in snapshot['manifest']['scope']['sourceIds'] for identity in required):
        raise DomainError('invalid_source_predicate', 'Source predicates must identify configured sources.')
    source_predicates = {identity: compile_expression(expression, field_types={**fields, '/data/namespace': 'string'}, regex_budget=regex_budget)
                         for identity, expression in required.items()}
    kind, source = filters.get("kind", "all"), filters.get("sourceId", "all")
    if kind not in ("all", "event", "session") or not isinstance(source, str):
        raise DomainError("invalid_filter", "Unknown record kind or source.")
    sources, kinds = filters.get("sourceIds"), filters.get("kinds", ["event", "session"])
    if sources is not None and (not isinstance(sources, list) or len(sources) > 100 or any(not isinstance(item, str) for item in sources) or len(set(sources)) != len(sources)):
        raise DomainError("invalid_filter", "Invalid source list.")
    if not isinstance(kinds, list) or len(kinds) > 2 or any(item not in ("event", "session") for item in kinds) or len(set(kinds)) != len(kinds):
        raise DomainError("invalid_filter", "Invalid kinds list.")
    schema_keys = {(pin["id"], pin["version"]) for pin in refs}

    def source_selected(source_id):
        return ((source == 'all' or source_id == source) and (sources is None or source_id in sources)
                and (saved is None or saved['sourceIds'] is None or source_id in saved['sourceIds']))

    def hard_predicate(record):
        return (record["deletedAt"] is None and (kind == "all" or record["kind"] == kind) and source_selected(record['sourceId']) and record["kind"] in kinds
                and (saved is None or record["kind"] in saved["kinds"])
                and (not schema_keys or (record.get("schemaId"), record.get("schemaVersion")) in schema_keys)
                and (record['sourceId'] not in source_predicates or source_predicates[record['sourceId']](record)))

    def direct_predicate(record):
        return saved_predicate(record) and predicate(record)

    return {"predicate": lambda record: hard_predicate(record) and direct_predicate(record),
            "sourceSelected": source_selected, "hardPredicate": hard_predicate, "directPredicate": direct_predicate,
            "definitionVersion": definition_version, "relationshipMode": relationship_mode,
            'explanationDefinition': {'expressions': [value for value in (saved.get('expression') if saved else None, filters.get('expression')) if value is not None], 'search': search_input},
            "search": search, "fieldTypes": fields}
