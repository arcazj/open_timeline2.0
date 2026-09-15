import hashlib
import threading
import uuid

import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from test_legacy_api import legacy, ready  # noqa: F401
from test_legacy_preferences import definition
from server.app.main import create_app


@pytest.mark.parametrize('lazy', [False, True])
def test_preferences_query_pinning_and_legacy_readonly_http(legacy, tmp_path, monkeypatch, lazy):  # noqa: F811
    options, first, second = legacy
    original = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (first, second)}
    root = tmp_path / 'state'
    options = {**options, 'preferencesRoot': str(root / 'preferences'), 'lazy': lazy}
    app = create_app(root, TOKEN, legacy_config=options)
    with TestClient(app, headers={'Authorization': 'Bearer ' + TOKEN}) as client:
        status = client.get(BASE).json()
        assert status['capabilities']['configurationManagement'] is True
        assert status['capabilities']['recordCrud'] is False
        assert status['legacy']['preferencesEnabled'] is True
        generation, revision = status['generation'], status['revision']

        def create_filter(name):
            key = str(uuid.uuid4())
            response = client.post(BASE + '/configuration/commands', json={
                'family': 'filters', 'type': 'create', 'generation': generation, 'clientCommandId': key,
                'payload': {'name': name, 'visibility': 'personal', 'definition': definition()},
            }, headers={'X-Workspace-Generation': generation, 'Idempotency-Key': key})
            assert response.status_code == 200, response.text
            return response.json()['resource']

        resource = create_filter('Pinned filter')
        key = str(uuid.uuid4())
        published = client.post(BASE + '/configuration/commands', json={
            'family': 'filters', 'type': 'publish', 'generation': generation, 'clientCommandId': key,
            'resourceId': resource['id'], 'expectedRevision': resource['revision'], 'payload': {},
        }, headers={'X-Workspace-Generation': generation, 'Idempotency-Key': key, 'If-Match': f'"{generation}:{resource["revision"]}"'})
        assert published.status_code == 200, published.text
        resource = published.json()['resource']
        assert resource['versions']
        entered, finish = threading.Event(), threading.Event()
        original_calculate = app.state.preparations._calculate

        def held(job, resources):
            entered.set()
            assert finish.wait(10)
            return original_calculate(job, resources)

        monkeypatch.setattr(app.state.preparations, '_calculate', held)
        try:
            response = client.post(BASE + '/query-sessions', json={
                'definitionVersion': 2,
                'domain': {'from': '2024-03-01T00:00:00Z', 'to': '2024-03-02T00:00:00Z'},
                'filters': {'filterId': resource['id'], 'filterVersion': 1},
            }, headers={'Prefer': 'respond-async'})
            assert response.status_code == 202, response.text
            assert entered.wait(5)
            pinned_revision = response.json()['preferencesRevision']
            create_filter('Later filter')
            assert client.get(BASE).json()['preferencesRevision'] > pinned_revision
        finally:
            finish.set()
        query = ready(client, response)
        assert query['preferencesRevision'] == pinned_revision
        assert query['revision'] == revision and query['generation'] == generation
        assert query['baseTotal'] == 2 and query['matchTotal'] == 1
        path = BASE + f'/query-sessions/{query["queryId"]}'
        response = client.post(path + '/records/query', json={})
        assert response.status_code == 200, response.text
        table = response.json()
        selected = next(item['record'] for item in table['items'] if item['record']['title'] == 'First match')
        descriptor = client.get(path + '/records/' + selected['id'])
        assert descriptor.status_code == 200, descriptor.text
        assert descriptor.json()['record']['title'] == 'First match'
        assert client.post(BASE + '/records', json={}).status_code == 403
        assert client.post(BASE + '/configuration/commands', json={'family': 'sources', 'type': 'create'}).status_code == 403
        exported = client.get(BASE + '/snapshot')
        assert exported.status_code == 200, exported.text
        assert len(exported.json()['records']) == 4
        assert exported.json()['manifest']['legacy']['readOnly'] is True
    assert all(hashlib.sha256(path.read_bytes()).hexdigest() == digest for path, digest in original.items())
