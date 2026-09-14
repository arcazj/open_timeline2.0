import hashlib
import importlib.util
import json
import random
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from server.app.main import create_app
from server.app.models.domain import DomainError, instant_ms, iso_from_ms, validate_snapshot
from server.app.repositories.snapshot_file_repository import SnapshotFileRepository
from server.app.services.launch_configuration import load_launch_configuration
from server.app.services.fixed_scale import fixed_scale_map
from server.app.services.query import decimal_string
from test_legacy_api import ready

ROOT = Path(__file__).resolve().parents[2]
CATALOG = json.loads((ROOT / 'data/catalog.json').read_text())['datasets']


@pytest.mark.parametrize('entry', CATALOG, ids=lambda entry: entry['id'])
def test_complete_source_normalization_and_read_only_api(entry, tmp_path):
    path = ROOT / entry['file']
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    snapshot = json.loads(path.read_text())
    validate_snapshot(snapshot)
    report = json.loads((ROOT / entry['report']).read_text())
    assert len(snapshot['records']) == report['inputRecords'] == report['outputRecords']
    assert report['inputSha256'] == hashlib.sha256((ROOT / entry['original']).read_bytes()).hexdigest()
    profile = load_launch_configuration(ROOT / entry['yaml'])
    assert profile['snapshot_file'] == path
    app = create_app(tmp_path / 'state', TOKEN, legacy_config={'snapshotFile': str(path)})
    with TestClient(app, headers={'Authorization': 'Bearer ' + TOKEN}) as client:
        metadata = client.get(BASE).json()
        assert metadata['recordCount'] == report['outputRecords']
        assert metadata['capabilities']['recordCrud'] is False
        assert metadata['settings']['range'] == snapshot['settings']['range']
        request = {'domain': snapshot['settings']['overview']}
        primary = next((band for band in snapshot['settings'].get('presentation', {}).get('bandLayout', []) if band['role'] == 'primary'), {})
        if primary.get('fixedScale'):
            request['fixedScale'] = primary['fixedScale']
        query = ready(client, client.post(BASE + '/query-sessions', json=request))
        layout = ready(client, client.post(BASE + f'/query-sessions/{query["queryId"]}/layouts', json={
            'mapId': query['mapId'], **snapshot['settings']['range'], 'width': 1000, 'availableHeight': 96, 'fontSize': 11,
            **({'presentation': snapshot['settings']['presentation']} if 'presentation' in snapshot['settings'] else {})}))
        url = BASE + f'/query-sessions/{query["queryId"]}/layouts/{layout["layoutId"]}/rows'
        identities, cursor = [], None
        while True:
            response = client.get(url, params={'cursor': cursor} if cursor else {})
            assert response.status_code == 200, response.text
            page = response.json()
            identities.extend(item['record']['id'] for item in page['items'])
            cursor = page['nextCursor']
            if not cursor:
                break
        assert len(identities) == len(set(identities)) == layout['detailTotal']
        assert client.post(BASE + '/records', json={'title': 'No writes'}).status_code == 403
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_historical_dates_roundtrip_and_known_eras():
    for value in ['-009999-01-01T00:00:00.000Z', '-000199-01-01T00:00:00.000Z', '0000-02-29T12:34:56.789Z', '0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']:
        assert iso_from_ms(instant_ms(value)) == value
    rng = random.Random(71)
    for _ in range(1000):
        value = rng.randint(-377705116800000, 253402300799999)
        assert instant_ms(iso_from_ms(value)) == value
    for bad in ['-000000-01-01T00:00:00Z', '-010000-01-01T00:00:00Z', '0001-02-29T00:00:00Z']:
        with pytest.raises(DomainError):
            instant_ms(bad)


def test_conversion_rejects_active_markup_and_preserves_uncertainty():
    spec = importlib.util.spec_from_file_location('convert_tests', ROOT / 'scripts/normalize-test-data.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with pytest.raises(ValueError):
        module.parse_events(b'<!DOCTYPE x SYSTEM "file:///secret"><data/>')
    assert module.parse_events(b'<data><event title="Test" start="2000">Safe<script>unsafe()</script><br>text</event></data>')[0]['description'] == 'Safe text'
    assert module.date('200 BC') == '-000199-01-01T00:00:00.000Z'
    assert module.date('1 BC') == '0000-01-01T00:00:00.000Z'
    monet = json.loads((ROOT / 'data/monet.json').read_text())
    uncertain = next(record for record in monet['records'] if record['title'] == 'Family moved to Le Havre, Normandy')
    assert uncertain['kind'] == 'event' and uncertain['end'] is None
    assert uncertain['extensions']['uncertainty']['lateststart'].startswith('1846')


def test_fixed_intervals_use_maximum_weight_and_preserve_all_knots():
    domain = {'from': '2000-01-01T00:00:00Z', 'to': '2000-01-01T00:00:04Z'}
    mapping = fixed_scale_map(domain, [{'from': '2000-01-01T00:00:01Z', 'to': '2000-01-01T00:00:03Z', 'ratio': 3}], 'test', decimal_string)
    assert [knot['u'] for knot in mapping['knots']] == ['0', '0.125', '0.875', '1']


def test_failed_reload_keeps_previous_snapshot(tmp_path):
    folder = tmp_path / 'fixtures'
    folder.mkdir()
    path = folder / 'snapshot.json'
    path.write_bytes((ROOT / 'data/default-dataset.json').read_bytes())
    repo = SnapshotFileRepository({'snapshotFile': str(path)}, tmp_path / 'state')
    repo.open()
    previous = repo.metadata()
    path.write_text('{ invalid')
    with pytest.raises(DomainError):
        repo.reload()
    assert repo.metadata() == previous
    repo.close()


def test_reloading_unchanged_file_never_rolls_back_published_revision(tmp_path):
    folder = tmp_path / 'fixtures'
    folder.mkdir()
    path = folder / 'snapshot.json'
    snapshot = json.loads((ROOT / 'data/default-dataset.json').read_text())
    snapshot['manifest'].pop('contentSha256', None)
    path.write_text(json.dumps(snapshot))
    repo = SnapshotFileRepository({'snapshotFile': str(path)}, tmp_path / 'state')
    repo.open()
    revision = repo.metadata()['revision']
    snapshot['records'][0]['title'] = 'Updated file'
    path.write_text(json.dumps(snapshot))
    repo.reload()
    assert repo.metadata()['revision'] == revision + 1
    repo.reload()
    assert repo.metadata()['revision'] == revision + 1
    repo.close()


def test_normalization_is_byte_stable_across_python_hash_seeds():
    for seed in ('17', '83'):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/normalize-test-data.py'), '--check'],
                                env={**os.environ, 'PYTHONHASHSEED': seed}, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
