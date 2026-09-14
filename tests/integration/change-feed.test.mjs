import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';

test('real Python feed invalidates a visible-to-hidden source move without revealing record IDs, then permits an authorized replacement query', async () => {
  const server = await startServer();
  const admin = new ServerProvider({ baseUrl: server.baseUrl, token: server.token });
  let reader;
  try {
    const info = await admin.initialize();
    const snapshot = await admin.exportSnapshot();
    const created = await admin.executeCommand({ type: 'create', generation: info.generation, clientCommandId: crypto.randomUUID(),
      payload: { title: 'Must disappear after move', sourceId: 'operations', start: snapshot.settings.range.from } });
    const call = async (path, options = {}) => {
      const response = await fetch(server.baseUrl + path, { ...options, headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', ...options.headers } });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return { value, etag: response.headers.get('etag') };
    };
    let state = await call('/api/v1/principals');
    const principal = await call('/api/v1/principals', { method: 'POST', headers: { 'X-Identity-Generation': state.value.generation, 'If-Match': state.etag, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ name: 'Source-scoped reader', role: 'viewer', grants: [{ workspaceId: 'default', sourceIds: ['operations'], capabilities: [] }] }) });
    state = await call('/api/v1/tokens');
    const token = await call('/api/v1/tokens', { method: 'POST', headers: { 'X-Identity-Generation': state.value.generation, 'If-Match': state.etag, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ principalId: principal.value.principal.id, name: 'Read-only test', expiresAt: null }) });
    reader = new ServerProvider({ baseUrl: server.baseUrl, token: token.value.secret });
    const baseline = await reader.initialize();
    const query = await reader.createQuery({ domain: snapshot.settings.overview });
    assert.ok((await reader.getOverview(query.queryId)).items.some(item => item.id === created.record.id));
    let stop, timer;
    const changed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('No source-removal invalidation arrived')), 6000);
      stop = reader.subscribeChanges(event => {
        if (event.type === 'changed') { clearTimeout(timer); stop(); resolve(event); }
      }, { generation: baseline.generation, afterRevision: baseline.revision });
    });
    try {
      await admin.executeCommand({ type: 'update', recordId: created.record.id, expectedVersion: created.record.version, generation: info.generation,
        clientCommandId: crypto.randomUUID(), payload: { sourceId: 'verification' } });
      const event = await changed;
      assert.ok(event.nextRevision > baseline.revision);
      assert.deepEqual(event.changes, []);
      assert.ok(!JSON.stringify(event).includes(created.record.id));
      assert.ok(!JSON.stringify(event).includes('verification'));
      const replacement = await reader.createQuery({ domain: snapshot.settings.overview });
      assert.ok(!(await reader.getOverview(replacement.queryId)).items.some(item => item.id === created.record.id));
      assert.equal((await reader.getQuery(query.queryId)).revision, query.revision);
      await reader.releaseQuery(query.queryId);
      await reader.releaseQuery(replacement.queryId);
    } finally { clearTimeout(timer); stop?.(); }
  } finally {
    reader?.dispose(); admin.dispose(); await server.stop();
  }
});
