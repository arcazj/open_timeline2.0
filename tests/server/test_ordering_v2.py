import json
from functools import cmp_to_key
from pathlib import Path

import pytest

from server.app.models.domain import DomainError
from server.app.services.string_order import compare_ordered_text, normalize_string_order
from server.app.services.presentation_layout import compare_group_keys, group_key, group_value
from server.app.services.table_query import normalize_table_input, prepare_table, table_item
from server.app.services.query import continuous, decimal_string

CASES = json.loads((Path(__file__).resolve().parents[2] / 'shared/fixtures/string-order-v2.json').read_text(encoding='utf-8'))['cases']


@pytest.mark.parametrize('fixture', CASES, ids=[value['name'] for value in CASES])
def test_v2_string_golden_order(fixture):
    options = normalize_string_order(fixture['options'], 2)
    assert sorted(fixture['values'], key=cmp_to_key(lambda a, b: compare_ordered_text(a, b, options))) == fixture['expected']


def test_normalization_huge_digits_and_comparator_laws():
    options = {'order': 'natural', 'caseSensitive': False}
    assert compare_ordered_text('e\u03012', '\u00e92', options) == 0
    assert compare_ordered_text('N' + '9' * 5000, 'N1' + '0' * 5000, options) < 0
    values = [value for fixture in CASES for value in fixture['values']]
    for left in values:
        for right in values:
            assert compare_ordered_text(left, right, options) == -compare_ordered_text(right, left, options)
    ordered = sorted(values, key=cmp_to_key(lambda a, b: compare_ordered_text(a, b, options)))
    for index, left in enumerate(ordered):
        for right in ordered[index:]:
            assert compare_ordered_text(left, right, options) <= 0


def item(index, value, missing=False):
    return {'id': f'90000000-0000-4000-8000-{index:012d}', 'kind': 'event', 'title': f'Record {index}',
            'start': '2026-09-12T12:00:00.000Z', 'end': None, 'data': {} if missing else {'status': value}}


def options(bundle, **fields):
    return normalize_table_input(fields, bundle['settings']['overview'], continuous, decimal_string)[0]


def test_table_v2_order_nulls_id_ties_and_v1_unchanged(bundle):
    records = [item(index + 1, value, missing=index == 5) for index, value in enumerate(['SOURCE2', 'SOURCE10', 'SOURCE1', 'SOURCE02', None, None, 'SOURCE2'])]
    query = {'records': records, 'matchIds': set()}
    for direction, expected in [('asc', [3, 1, 7, 4, 2, 5, 6]), ('desc', [2, 4, 1, 7, 3, 5, 6])]:
        table = prepare_table(query, options(bundle, definitionVersion=2, sort=[{'field': 'data.status', 'direction': direction, 'order': 'natural'}], limit=2))
        assert [int(record['id'][-12:]) for record in table['records']] == expected
        assert table['pageStarts'] == [0, 2, 4, 6]
    legacy = prepare_table(query, options(bundle, sort=[{'field': 'data.status', 'direction': 'asc'}]))
    assert [record['data'].get('status', 'missing') for record in legacy['records']] == ['SOURCE02', 'SOURCE1', 'SOURCE10', 'SOURCE2', 'SOURCE2', None, 'missing']


@pytest.mark.parametrize('input', [
    {'sort': [{'field': 'title', 'direction': 'asc', 'order': 'natural'}]},
    {'definitionVersion': 2, 'sort': [{'field': 'start', 'direction': 'asc', 'order': 'natural'}]},
    {'definitionVersion': 2, 'sort': [{'field': 'title', 'direction': 'asc', 'caseSensitive': 'false'}]},
    {'definitionVersion': 2, 'sort': [{'field': 'title', 'direction': 'asc', 'order': 'locale'}]},
    {'definitionVersion': None}, {'definitionVersion': 3},
])
def test_invalid_table_order(input, bundle):
    with pytest.raises(DomainError):
        options(bundle, **input)


def test_v2_context_provenance_and_counts(bundle):
    records = [item(1, 'SOURCE1'), item(2, 'SOURCE1')]
    provenance = {
        records[0]['id']: {'role': 'ancestor-context', 'directPredicate': False, 'match': False, 'descendantMatchCount': 1},
        records[1]['id']: {'role': 'direct', 'directPredicate': True, 'match': True, 'descendantMatchCount': 0},
    }
    query = {'records': records, 'manifest': {'definitionVersion': 2}, 'matchIds': {records[1]['id']}, 'eligibleIds': {records[1]['id']}, 'provenance': provenance}
    for projection in ['context', 'matches']:
        table = prepare_table(query, options(bundle, definitionVersion=2, projection=projection))
        assert table['baseTotal'] == table['contextTotal'] == table['matchTotal'] == 1
        assert len(table['records']) == (2 if projection == 'context' else 1)
        for record in table['records']:
            assert table_item(query, record)['provenance'] == provenance[record['id']]


def test_mixed_group_ranks_and_noncolliding_typed_keys():
    values = ['SOURCE2', 'SOURCE10', 'SOURCE1', 'SOURCE02', None, None, '(missing)', 2, 10, False, True]
    keys = [group_value(item(index + 1, value, missing=index == 5), '/data/status')[0] for index, value in enumerate(values)]
    for direction, expected in [
        ('asc', ['number:2', 'number:10', 'string:(missing)', 'string:SOURCE1', 'string:SOURCE2', 'string:SOURCE02', 'string:SOURCE10', 'boolean:false', 'boolean:true', 'null:', 'missing:']),
        ('desc', ['number:10', 'number:2', 'string:SOURCE10', 'string:SOURCE02', 'string:SOURCE2', 'string:SOURCE1', 'string:(missing)', 'boolean:true', 'boolean:false', 'null:', 'missing:']),
    ]:
        ordered = sorted(keys, key=cmp_to_key(lambda a, b: compare_group_keys(a, b, direction, {'order': 'natural'})))
        assert [group_key(key) for key in ordered] == expected
