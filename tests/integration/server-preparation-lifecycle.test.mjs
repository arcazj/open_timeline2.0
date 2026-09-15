import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
};

test('HTTP cancellation drains a delayed allocation and release before admitting the next view', async () => {
  const allocated = deferred(), deliverAllocation = deferred(), releasing = deferred(), acknowledgeRelease = deferred();
  const controller = new AbortController();
  const manifest = { queryId: 'owned', snapshotId: 'snapshot', mapId: 'map', generation: 'generation', revision: 1, state: 'ready' };
  const requests = [];
  let occupied = false, first = true;
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    if (request.method === 'DELETE') {
      releasing.resolve();
      await acknowledgeRelease.promise;
      occupied = false;
      response.writeHead(204).end();
      return;
    }
    if (occupied) {
      response.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'preparation_capacity', message: 'Occupied', requestId: 'capacity' }));
      return;
    }
    occupied = true;
    if (first) {
      first = false;
      allocated.resolve();
      await deliverAllocation.promise;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(manifest));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ServerProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-only-token' });
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    await allocated.promise;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    deliverAllocation.resolve();
    await releasing.promise;
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_pending' });
    assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE']);
    acknowledgeRelease.resolve();
    await provider.awaitPreparationCleanup({ timeout: 1000 });
    assert.deepEqual(await provider.createQuery({}), manifest);
    assert.deepEqual(requests.map(request => request.method), ['POST', 'DELETE', 'POST']);
    assert.ok(requests.every(request => request.authorization === 'Bearer fixture-only-token'));
    assert.equal(provider.preparationDrains.size, 0);
  } finally {
    deliverAllocation.resolve(); acknowledgeRelease.resolve(); provider.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP table cancellation waits for completed server computation before the next table read', async () => {
  const entered = deferred(), complete = deferred(), controller = new AbortController();
  const requests = [], result = { queryId: 'query', items: [{ record: { id: 'fixture-record' } }], total: 1 };
  let occupied = false, first = true, published = false;
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    if (occupied) {
      response.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'preparation_capacity', message: 'Occupied' }));
      return;
    }
    occupied = true;
    if (first) { first = false; entered.resolve(); await complete.promise; }
    occupied = false;
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ServerProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-table-token' });
  try {
    const pending = provider.queryRecords('query', { scope: 'all' }, { signal: controller.signal }).then(value => { published = true; return value; });
    await entered.promise;
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    await assert.rejects(provider.queryRecords('query'), { code: 'preparation_cleanup_pending' });
    assert.equal(occupied, true); assert.equal(requests.length, 1);
    complete.resolve();
    await provider.awaitPreparationCleanup({ timeout: 1000 });
    assert.equal(published, false);
    assert.deepEqual(await provider.queryRecords('query', { scope: 'all' }), result);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === 'POST' && request.url.endsWith('/query-sessions/query/records/query') && request.authorization === 'Bearer fixture-table-token'));
    assert.equal(provider.preparationDrains.size, 0);
  } finally {
    complete.resolve(); provider.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('two HTTP providers sharing a principal retry only explicit pre-admission table capacity', async () => {
  const entered = deferred(), releaseWriter = deferred(), busy = deferred(), requests = [];
  let activePrincipal = null;
  const server = createServer(async (request, response) => {
    request.resume(); const principal = request.headers.authorization;
    requests.push({ url: request.url, principal });
    if (activePrincipal === principal) {
      busy.resolve(); response.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'preparation_capacity', message: 'Another view is preparing', requestId: 'busy-reader' })); return;
    }
    activePrincipal = principal;
    if (request.url.includes('/writer/')) { entered.resolve(); await releaseWriter.promise; }
    activePrincipal = null;
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ items: [], total: 0 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'same-fixture-principal' };
  const writer = new ServerProvider(options), reader = new ServerProvider(options);
  try {
    const writing = writer.queryRecords('writer'); await entered.promise;
    const reading = reader.queryRecords('reader'); await busy.promise;
    assert.equal(requests.length, 2); releaseWriter.resolve();
    assert.deepEqual(await writing, { items: [], total: 0 });
    assert.deepEqual(await reading, { items: [], total: 0 });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].url, requests[2].url);
    assert.ok(requests.every(request => request.principal === 'Bearer same-fixture-principal'));
    assert.equal(reader.preparationDrains.size, 0);
  } finally {
    releaseWriter.resolve(); writer.dispose(); reader.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
