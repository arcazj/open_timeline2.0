import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { prepareServerReconnect } from '../../client/src/data/server-reconnect.js';
import { startServer } from './server-fixture.mjs';
import { startLocalPathsServer } from './local-paths-server-fixture.mjs';

test('explicit HTTP reconnect stages the same confirmed source without clearing unknown allocation debt', async () => {
  const info = { workspaceId: 'default', generation: 'generation', actor: { id: 'reader', role: 'viewer', capabilities: ['records.read'] }, sourceIds: ['real-source'] };
  const query = { queryId: 'fresh-query', snapshotId: 'snapshot', mapId: 'map', generation: 'generation', revision: 1, state: 'ready' };
  const requests = []; let drop = true, candidate;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization }); request.resume();
    if (request.method === 'POST' && drop) { drop = false; request.socket.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(request.method === 'GET' ? info : query));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ServerProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'confirmed-fixture-token' });
  const view = { domain: { from: '1900-01-01T00:00:00.000Z', to: '2200-01-01T00:00:00.000Z' }, range: { fromMs: '-2208988800000', toMs: '-2208902400000' },
    queryState: { filters: { sourceIds: ['real-source'] } }, settings: { ratio: 32 }, transient: { mode: 'split' } };
  try {
    await assert.rejects(provider.createQuery({}), { code: 'server_unavailable' });
    await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
    const result = await prepareServerReconnect({ provider, info, view }); candidate = result.provider;
    assert.equal(result.status, 'ready'); assert.deepEqual(result.view, view);
    assert.deepEqual(requests.map(request => request.method), ['POST', 'GET']);
    await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
    assert.equal(provider.disposed, false);
    assert.deepEqual(await candidate.createQuery({}), query);
    assert.deepEqual(requests.map(request => request.method), ['POST', 'GET', 'POST']);
    assert.ok(requests.every(request => request.authorization === 'Bearer confirmed-fixture-token'));
  } finally { candidate?.dispose(); provider.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('staging accepts actual Python managed-workspace authority metadata', async () => {
  const server = await startServer(), provider = new ServerProvider(server); let candidate;
  try {
    const info = await provider.initialize();
    const view = { domain: { from: '1800-01-01T00:00:00.000Z', to: '2200-01-01T00:00:00.000Z' },
      range: { fromMs: '-5364662400000', toMs: '-5364576000000' }, queryState: { filters: { sourceIds: info.sourceIds.slice(0, 1) } }, table: { scope: 'window', projection: 'matches' } };
    const result = await prepareServerReconnect({ provider, info, view }); candidate = result.provider;
    assert.equal(result.status, 'ready'); assert.deepEqual(result.view, view);
    assert.equal(result.info.actor.id, info.actor.id); assert.deepEqual(result.info.sourceIds, info.sourceIds);
    assert.equal(result.info.generation, info.generation);
  } finally { candidate?.dispose(); provider.dispose(); await server.stop(); }
});

test('staging accepts actual local-browser legacy-path metadata without bearer credentials', async () => {
  const server = await startLocalPathsServer(), originalFetch = globalThis.fetch, originalLocation = globalThis.location;
  const calls = []; let provider, candidate;
  globalThis.location = { origin: server.baseUrl, href: `${server.baseUrl}/`, protocol: 'http:' };
  globalThis.fetch = (url, options = {}) => {
    const headers = { ...options.headers, Origin: server.baseUrl, 'Sec-Fetch-Site': 'same-origin' };
    calls.push({ url, headers }); return originalFetch(url, { ...options, headers });
  };
  try {
    provider = new ServerProvider({ baseUrl: server.baseUrl, localBrowser: true });
    const info = await provider.initialize();
    const view = { range: { fromMs: '1710791100000', toMs: '1710794700000' }, queryState: { filters: { sourceIds: info.sourceIds.slice(0, 2) } },
      settings: { scaleMode: 'adaptive', ratio: 16 }, transient: { mode: 'split' } };
    const result = await prepareServerReconnect({ provider, info, view }); candidate = result.provider;
    assert.equal(result.status, 'ready'); assert.equal(result.info.legacy.readOnly, true); assert.deepEqual(result.view, view);
    assert.equal(candidate.localBrowser, true); assert.equal(candidate.token, '');
    assert.ok(calls.every(call => call.headers['X-OpenBEXI-Local'] === '1' && !call.headers.Authorization));
  } finally {
    candidate?.dispose(); provider?.dispose(); globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
    await server.stop();
  }
});
