import hashlib
import json
from pathlib import Path

import pytest

from server.app.models.domain import json_bytes
from server.app.services.legacy_filter_migration import migrate_legacy_filter
from server.app.services.legacy_sources import load_legacy_sources
from server.app.services.query_configuration import resolve_query_configuration

CASES = json.loads((Path(__file__).resolve().parents[2] / 'shared/fixtures/legacy-filter-migration-cases.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_migration_is_explicit_bounded_and_never_changes_input(case):
    original = json.dumps(case['input'])
    report = migrate_legacy_filter(case['input'])
    assert report['classification'] == case['classification']
    assert report['publishable'] is case['publishable']
    if case['classification'] == 'blocked':
        assert report['draft'] is None
    else:
        assert (report['draft']['expression']['root']['op'] if report['draft']['expression'] else None) == case['root']
    assert json.dumps(case['input']) == original


def test_source_filter_requires_bound_approval_and_only_filters_its_own_source(tmp_path, bundle):
    data = tmp_path / 'data'
    data.mkdir()
    filters = {'include': 'status:Nominal', 'exclude': ''}
    expression = {'version': 2, 'root': {'op': 'eq', 'field': '/data/status', 'value': 'Nominal'}}
    entry = {'namespace': 'A', 'type': 'json_file', 'enable': True, 'data_model': str(data) + '/yyyy/mm/dd', 'filter': filters}
    def load():
        return load_legacy_sources(tmp_path / 'sources.yml', legacy_root=tmp_path, allow_roots=[data], document={'data_sources': [entry]})
    assert any(item['code'] == 'legacy_source_filter_unsupported' for item in load().diagnostics)
    entry['approved_filter'] = {'definitionVersion': 2, 'approved': True, 'originalSha256': hashlib.sha256(json_bytes(filters)).hexdigest(), 'expression': expression}
    approved = load()
    assert len(approved.sources) == 1 and len(approved.approved_predicates) == 1
    bundle['manifest']['legacy'] = {'configuration': {'sourcePredicates': {'operations': expression}}}
    resolved = resolve_query_configuration(bundle, {'definitionVersion': 2})
    template = bundle['records'][0]
    assert not resolved['hardPredicate']({**template, 'sourceId': 'operations', 'data': {'status': 'Failure'}})
    assert resolved['hardPredicate']({**template, 'sourceId': 'verification', 'data': {'status': 'Failure'}})
    assert resolved['hardPredicate']({**template, 'sourceId': 'operations', 'data': {'status': 'Nominal'}})
    entry['filter']['include'] = 'status:Failure'
    assert any(item['code'] == 'legacy_source_filter_approval_invalid' for item in load().diagnostics)
