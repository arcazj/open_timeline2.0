from ..models.domain import DomainError, intersects
from .preparation_control import checked, checkpoint


def resolve_relationships(records, configuration, start, end):
    """Resolve a scoped forest before soft predicates; absent parents are scope boundaries."""
    allowed = [record for record in checked(records) if configuration['hardPredicate'](record)]
    by_id = {}
    for record in allowed:
        if record['id'] in by_id:
            raise DomainError('invalid_relationship', 'Duplicate record identity in query scope.')
        by_id[record['id']] = record
    roots = {}
    for record in checked(allowed):
        path, seen, current = [], set(), record
        while current and current['id'] not in roots:
            if current['id'] in seen:
                raise DomainError('invalid_relationship', 'Session ancestry contains a cycle.')
            seen.add(current['id'])
            path.append(current['id'])
            parent = by_id.get(current.get('parentSessionId'))
            if parent and parent['kind'] != 'session':
                raise DomainError('invalid_relationship', 'A parent must be a session.')
            current = parent
        root = roots[current['id']] if current else path[-1]
        roots.update((identity, root) for identity in path)
    universe = [record for record in checked(allowed) if intersects(record, start, end)]
    direct_ids = {record['id'] for record in checked(universe) if configuration['directPredicate'](record)}
    families = {roots[identity] for identity in direct_ids}
    eligible = [record for record in universe if record['id'] in direct_ids or
                (configuration['relationshipMode'] == 'family' and roots[record['id']] in families)]
    eligible_ids = {record['id'] for record in eligible}
    matches = {record['id'] for record in checked(eligible) if configuration['search']['matches'](record)}
    ancestors, descendant_matches = set(), {}
    for record in checked(eligible):
        parent = by_id.get(record.get('parentSessionId'))
        matching = configuration['search']['active'] and record['id'] in matches
        while parent:
            checkpoint()
            visited = parent['id'] in ancestors
            ancestors.add(parent['id'])
            if matching:
                descendant_matches[parent['id']] = descendant_matches.get(parent['id'], 0) + 1
            if visited and not matching:
                break
            parent = by_id.get(parent.get('parentSessionId'))
    context_records = [record for record in allowed if record['id'] in ancestors and record['id'] not in eligible_ids]
    visible_context = [record for record in context_records if intersects(record, start, end)]

    def redact_boundary(record):
        return {**record, 'parentSessionId': None} if record.get('parentSessionId') and record['parentSessionId'] not in by_id else record

    rendered = sorted((redact_boundary(record) for record in eligible + visible_context), key=lambda record: record['id'])
    provenance = {record['id']: {
        'role': 'direct' if record['id'] in direct_ids else 'family-context' if record['id'] in eligible_ids else 'ancestor-context',
        'directPredicate': record['id'] in direct_ids, 'match': record['id'] in matches,
        'descendantMatchCount': descendant_matches.get(record['id'], 0),
    } for record in eligible + context_records}
    return {'records': rendered, 'eligibleRecords': [redact_boundary(record) for record in eligible],
            'eligibleIds': eligible_ids, 'directIds': direct_ids, 'matches': matches, 'provenance': provenance,
            'contextRecords': [redact_boundary(record) for record in context_records],
            'contextTotal': len(context_records), 'visibleContextTotal': len(visible_context)}


def scoped_query_counts(data, domain, revision, generation, complete):
    return {'domain': dict(domain), 'revision': revision, 'generation': generation, 'complete': complete,
            'filterResults': len(data['eligibleIds']), 'directPredicateHits': len(data['directIds']),
            'searchFindings': len(data['matches']) if data['hasSearch'] else 0,
            'contextRecords': data['contextTotal'], 'visibleContextRecords': data['visibleContextTotal']}
