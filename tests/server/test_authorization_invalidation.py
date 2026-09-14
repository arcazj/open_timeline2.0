import os
import uuid

import pytest

from conftest import BASE, TOKEN
from server.app.models.domain import DomainError, instant_ms, iso_from_ms, now_iso
from server.app.services import identity as identity_module
from test_identity_api import create_identity


def prepare(client, bundle, headers):
    response = client.post(BASE + "/query-sessions", json={"domain": bundle["settings"]["overview"]}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def change(client, principal_id, payload):
    current = client.get("/api/v1/principals/" + principal_id)
    return client.patch("/api/v1/principals/" + principal_id, json=payload,
        headers={"X-Identity-Generation": current.json()["generation"], "If-Match": current.headers["etag"],
                 "Idempotency-Key": uuid.uuid4().hex})


def test_scope_change_purges_only_affected_principal_before_any_query_read(client, app, bundle):
    alice, _, alice_headers = create_identity(client)
    _, _, bob_headers = create_identity(client)
    old_alice = prepare(client, bundle, alice_headers)
    old_bob = prepare(client, bundle, bob_headers)
    before = app.state.queries.resource_stats()["retainedBytes"]
    result = change(client, alice["id"], {"grants": [{"workspaceId": "default", "sourceIds": [], "capabilities": []}]})
    assert result.status_code == 200, result.text
    assert old_alice["queryId"] not in app.state.queries.queries
    assert old_bob["queryId"] in app.state.queries.queries
    assert 0 < app.state.queries.resource_stats()["retainedBytes"] < before
    assert client.get(BASE + "/query-sessions/" + old_alice["queryId"], headers=alice_headers).status_code == 409


def test_name_change_and_rejected_edit_do_not_evict_pinned_queries(client, app, bundle):
    principal, _, headers = create_identity(client)
    query = prepare(client, bundle, headers)
    assert change(client, principal["id"], {"name": "Renamed viewer"}).status_code == 200
    assert query["queryId"] in app.state.queries.queries
    assert change(client, principal["id"], {"role": "unknown"}).status_code == 422
    assert query["queryId"] in app.state.queries.queries


def test_revoked_token_purges_retained_data_before_reply(client, app, bundle):
    _, created, headers = create_identity(client)
    query = prepare(client, bundle, headers)
    result = client.delete("/api/v1/tokens/" + created["token"]["id"], headers={**headers,
        "X-Identity-Generation": created["generation"], "If-Match": f'"{created["generation"]}:1"',
        "Idempotency-Key": uuid.uuid4().hex})
    assert result.status_code == 200, result.text
    assert query["queryId"] not in app.state.queries.queries
    assert app.state.queries.resource_stats()["retainedBytes"] == 0
    assert client.get(BASE, headers=headers).status_code == 401


def test_expiry_integrity_tick_purges_without_waiting_for_a_query_read(client, app, bundle, monkeypatch):
    principal, _, _ = create_identity(client)
    store = app.state.identities
    expiry = instant_ms(now_iso()) + 60000
    result = store.create_token(store.authenticate(TOKEN), {"principalId": principal["id"], "name": "Expiring",
        "expiresAt": iso_from_ms(expiry)}, store.state["generation"], store.state["revision"], uuid.uuid4().hex)
    headers = {"Authorization": "Bearer " + result.response["body"]["secret"]}
    prepare(client, bundle, headers)
    monkeypatch.setattr(identity_module, "now_iso", lambda: iso_from_ms(expiry + 1))
    store.check_integrity()
    assert not app.state.queries.queries
    assert app.state.queries.resource_stats()["retainedBytes"] == 0
    assert client.get(BASE, headers=headers).status_code == 401


def test_identity_byte_drift_clears_every_retained_principal(client, app, bundle):
    _, _, headers = create_identity(client)
    prepare(client, bundle, headers)
    prepare(client, bundle, {})
    store = app.state.identities
    with store.mutex:
        stamp = store.path.stat()
        before = store.path.read_bytes()
        after = before.replace(b'Administrator', b'Xdministrator', 1)
        assert after != before and len(after) == len(before)
        store.path.write_bytes(after)
        os.utime(store.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        with pytest.raises(DomainError):
            store.check_integrity()
        assert not app.state.queries.queries
        assert app.state.queries.resource_stats()["retainedBytes"] == 0


def test_failed_observer_freezes_reads_but_does_not_relabel_known_commit(client, app):
    principal, _, _ = create_identity(client)
    def fail(_principals):
        raise RuntimeError("Simulated cache purge failure")
    app.state.identities.subscribe_authorization(fail)
    response = change(client, principal["id"], {"enabled": False})
    assert response.status_code == 200, response.text
    assert response.json()["principal"]["enabled"] is False
    assert app.state.identities.available is False
    assert client.get(BASE).status_code == 503
