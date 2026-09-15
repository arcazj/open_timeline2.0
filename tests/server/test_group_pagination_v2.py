import copy

import pytest

from server.app.models.domain import DomainError
from server.app.services.group_pagination import collapsed_group_keys, paginate_group_rows


def layout(sizes, collapsed=()):
    rows, items, enclosures, row = [], [], [], 0
    for index, count in enumerate(sizes):
        key = f'string:SOURCE{index + 1}'
        hidden = key in collapsed
        rows.append({'row': row, 'type': 'group', 'key': key, 'name': key[7:], 'collapsed': hidden, 'recordCount': count, 'matchCount': count})
        row += 1
        start = row
        if not hidden:
            for item in range(count):
                items.append({'row': row, 'record': {'id': f'{index}:{item}'}})
                row += 1
        if not hidden and count > 1:
            enclosures.append({'parentId': items[-count]['record']['id'], 'startRow': start, 'endRow': row})
    return {'rows': rows, 'items': items, 'enclosures': enclosures, 'totalRows': row}


def test_continuation_slots_prevent_orphan_expanded_headers():
    original = layout([5, 1, 2])
    result = paginate_group_rows(copy.deepcopy(original), 3)
    assert result['totalRows'] == 15
    assert [item['row'] for item in result['items']] == [1, 2, 4, 5, 7, 10, 13, 14]
    assert [(row['row'], row['continuation']) for row in result['rows']] == [(0, False), (3, True), (6, True), (9, False), (12, False)]
    assert result['logicalGroupTotal'] == 3 and result['hiddenItemTotal'] == 0
    assert [(item['startRow'], item['endRow']) for item in result['enclosures']] == [(1, 8), (13, 15)]
    assert len({item['record']['id'] for item in result['items']}) == len(original['items'])


def test_collapse_keeps_typed_identity_and_hidden_counts():
    result = paginate_group_rows(layout([5, 1, 2], ['string:SOURCE1']), 2)
    assert result['logicalGroupTotal'] == 3 and result['collapsedGroupTotal'] == 1 and result['hiddenItemTotal'] == 5
    assert [item['row'] for item in result['items']] == [3, 5, 7]
    assert collapsed_group_keys(['string:(missing)', 'missing:'], 2) == {'string:(missing)', 'missing:'}
    assert paginate_group_rows(layout([5, 2], ['string:SOURCE1', 'string:SOURCE2']), 1)['totalRows'] == 2
    for value in [None, ['SOURCE1'], ['string:A', 'string:A'], ['string:e\u0301', 'string:\u00e9']]:
        with pytest.raises(DomainError, match='group'):
            collapsed_group_keys(value, 2)
    with pytest.raises(DomainError):
        collapsed_group_keys(['string:A'], 1)
    with pytest.raises(DomainError) as error:
        paginate_group_rows(layout([1]), 1)
    assert error.value.code == 'row_height_limit'


@pytest.mark.parametrize('capacity', [2, 3, 4, 7, 32, 100])
@pytest.mark.parametrize('sizes', [[1], [1, 1, 1], [201, 1, 15], [5, 8, 3, 1]])
def test_all_group_page_capacities_progress_with_unique_record_traversal(capacity, sizes):
    source = layout(sizes)
    result = paginate_group_rows(copy.deepcopy(source), capacity)
    seen = []
    for start in range(0, result['totalRows'], capacity):
        items = [item for item in result['items'] if start <= item['row'] < start + capacity]
        assert items
        assert any(start <= row['row'] < start + capacity for row in result['rows'])
        seen.extend(item['record']['id'] for item in items)
    assert seen == [item['record']['id'] for item in source['items']]
