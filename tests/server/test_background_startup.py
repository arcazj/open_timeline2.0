import threading
import time

import pytest
from fastapi.testclient import TestClient

from conftest import BASE, TOKEN
from test_legacy_api import legacy as legacy
from server.app.main import create_app
from server.app.models.domain import DomainError
from server.app.repositories.legacy_repository import LegacyRepository
from server.app.services.startup import StartupStatus


@pytest.fixture
def client_html(tmp_path, monkeypatch):
    path = tmp_path / 'index.html'
    path.write_text('<!doctype html><title>Startup client fixture</title>', encoding='utf-8')
    monkeypatch.setattr('server.app.main.CLIENT_HTML', path)
    return path


def wait_state(client, status):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get('/health/ready')
        if response.json()['status'] == status:
            return response
        time.sleep(.01)
    pytest.fail(response.text)


def test_client_available_while_complete_archive_is_loading(legacy, tmp_path, monkeypatch, client_html):
    options, first, second = legacy
    original_files = [first.read_bytes(), second.read_bytes()]
    started, release = threading.Event(), threading.Event()
    original = LegacyRepository.open

    def delayed(self, *, cancel, progress):
        progress('reading-legacy', filesRead=1, recordsRead=2)
        started.set()
        while not release.wait(.01):
            if cancel.is_set():
                raise DomainError('startup_cancelled', 'Cancelled', 503)
        return original(self, cancel=cancel, progress=progress)

    monkeypatch.setattr(LegacyRepository, 'open', delayed)
    app = create_app(tmp_path / 'state', TOKEN, legacy_config=options, background_startup=True)
    with TestClient(app) as client:
        assert started.wait(2)
        response = client.get('/')
        assert response.status_code == 200 and response.text == client_html.read_text()
        assert client.get('/health/live').status_code == 200
        progress = client.get('/health/ready')
        assert progress.status_code == 503
        assert progress.json()['phase'] == 'reading-legacy'
        assert progress.json()['filesRead'] == 1
        assert str(first) not in progress.text and TOKEN not in progress.text
        assert progress.headers['retry-after'] == '1'
        for method, path in [('get', BASE), ('post', BASE + '/query-sessions'), ('post', BASE + '/records'), ('get', '/api/v1/local-sources')]:
            response = getattr(client, method)(path)
            assert response.status_code == 503
            assert response.json()['code'] == 'server_starting'
        assert client.get('/api/v1/capabilities').json()['readOnly'] is True
        release.set()
        assert wait_state(client, 'ready').status_code == 200
        response = client.get(BASE, headers={'Authorization': 'Bearer ' + TOKEN})
        assert response.status_code == 200
        assert response.json()['recordCount'] == 4
    assert [first.read_bytes(), second.read_bytes()] == original_files
    assert not app.state.repository.available


@pytest.mark.parametrize('background', [True, False])
def test_failed_startup_never_exposes_partial_data(legacy, tmp_path, monkeypatch, background, client_html):
    def fail(self, **kwargs):
        raise DomainError('bad_legacy', 'Private internal path', 409)

    monkeypatch.setattr(LegacyRepository, 'open', fail)
    app = create_app(tmp_path / 'state', TOKEN, legacy_config=legacy[0], background_startup=background)
    if not background:
        with pytest.raises(DomainError):
            with TestClient(app):
                pass
        return
    with TestClient(app) as client:
        response = wait_state(client, 'failed')
        assert response.status_code == 503 and 'Private internal path' not in response.text
        response = client.get('/')
        assert response.status_code == 200 and response.text == client_html.read_text()
        assert client.get(BASE).json()['code'] == 'startup_failed'
        assert not hasattr(app.state, 'queries')


def test_missing_client_build_returns_actionable_404(legacy, tmp_path, client_html):
    client_html.unlink()
    app = create_app(tmp_path / 'state', TOKEN, legacy_config=legacy[0])
    with TestClient(app) as client:
        response = client.get('/')
        assert response.status_code == 404
        assert response.json() == {'message': 'Client build is missing; run npm run build.'}
        assert client.get('/health/ready').status_code == 200


def test_shutdown_drains_loader_before_closing_repository(legacy, tmp_path, monkeypatch):
    started, cancelled, closed = threading.Event(), threading.Event(), threading.Event()
    original_close = LegacyRepository.close

    def delayed(self, *, cancel, progress):
        started.set()
        assert cancel.wait(5)
        cancelled.set()
        progress('reading-legacy')

    def close(self):
        assert cancelled.is_set()
        closed.set()
        original_close(self)

    monkeypatch.setattr(LegacyRepository, 'open', delayed)
    monkeypatch.setattr(LegacyRepository, 'close', close)
    app = create_app(tmp_path / 'state', TOKEN, legacy_config=legacy[0], background_startup=True)
    with TestClient(app) as client:
        assert started.wait(2)
        assert client.get('/health/live').status_code == 200
    assert closed.is_set()
    assert not app.state.startup.ready


def test_progress_exposes_only_safe_counts_and_stops_after_cancel():
    status = StartupStatus()
    status.update('reading-legacy', filesRead=4, recordsRead=7, path='private', token=TOKEN)
    assert set(status.snapshot()) == {'status', 'phase', 'elapsedMs', 'filesRead', 'recordsRead'}
    status.cancel.set()
    with pytest.raises(DomainError):
        status.complete()
    assert not status.ready
