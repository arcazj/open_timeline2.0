import pytest

from conftest import BASE
from server.app.models.domain import DomainError
from test_api import query, layout
from test_presentation import engine_records, layout as engine_layout


@pytest.mark.parametrize('version', [1, 2])
def test_direct_pages_preserve_cursor_pages_and_authorization(client, bundle, version):
    manifest = query(client, bundle, definitionVersion=version)
    allocation = layout(client, bundle, manifest, availableHeight=132,
                        presentation={'version': 1, 'grouping': {'field': '/sourceId'}})
    path = BASE + f'/query-sessions/{manifest["queryId"]}/layouts/{allocation["layoutId"]}/rows'
    count = max(1, (allocation['totalRows'] + allocation['pageCapacity'] - 1) // allocation['pageCapacity'])
    last = client.get(path, params={'pageIndex': count - 1})
    assert last.status_code == 200, last.text
    cursor, pages = None, []
    while True:
        response = client.get(path, params={'cursor': cursor} if cursor else {})
        assert response.status_code == 200, response.text
        pages.append(response.json())
        cursor = pages[-1]['nextCursor']
        if cursor is None:
            break
    assert count == len(pages) > 1
    assert last.json() == pages[-1]
    for index in reversed(range(count)):
        assert client.get(path, params={'pageIndex': index}).json() == pages[index]
    assert client.get(path, params={'pageIndex': count}).json()['code'] == 'invalid_page_index'
    assert client.get(path, params={'pageIndex': 0}, headers={'Authorization': ''}).status_code == 401
    assert client.get(path.replace(allocation['layoutId'], 'foreign'), params={'pageIndex': 0}).status_code == 404
    if version == 2:
        assert any(row.get('continuation') for page in pages for row in page['rows'])


def test_direct_page_http_rejects_unsafe_and_ambiguous_values(client, bundle):
    manifest = query(client, bundle)
    allocation = layout(client, bundle, manifest)
    path = BASE + f'/query-sessions/{manifest["queryId"]}/layouts/{allocation["layoutId"]}/rows'
    for value in ['-1', '1.0', '1.2', 'NaN', 'Infinity', 'true', 'null', '', ' 1', '+1', '1e0', '9007199254740992', '\u0661']:
        response = client.get(path, params={'pageIndex': value})
        assert response.status_code == 422, (value, response.text)
        assert response.json()['code'] == 'invalid_page_index'
    for cursor in ['', 'foreign']:
        response = client.get(path, params={'pageIndex': 0, 'cursor': cursor})
        assert response.status_code == 422
        assert response.json()['code'] == 'invalid_pagination'
    response = client.get(path, params={'pageIndex': 9007199254740991})
    assert response.status_code == 400
    assert response.json()['code'] == 'invalid_page_index'


def test_empty_layout_page_zero_and_engine_type_validation(bundle):
    engine, value = engine_records(bundle, count=0)
    try:
        query_manifest, allocation, first = engine_layout(engine, value, None)
        args = (query_manifest['queryId'], allocation['layoutId'])
        assert engine.rows(*args, page_index=0) == first
        assert first['pageCount'] == 1 and first['items'] == []
        for value in [-1, 0.5, True, '1', 9007199254740992]:
            with pytest.raises(DomainError) as error:
                engine.rows(*args, page_index=value)
            assert error.value.code == 'invalid_page_index'
        with pytest.raises(DomainError) as error:
            engine.rows(*args, page_index=1)
        assert error.value.code == 'invalid_page_index'
        with pytest.raises(DomainError) as error:
            engine.rows(*args, cursor='', page_index=0)
        assert error.value.code == 'invalid_pagination'
    finally:
        engine.close()
