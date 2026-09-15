import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { prepareServerReconnect } from '../../client/src/data/server-reconnect.js';

const info = { workspaceId: 'default', generation: 'generation', revision: 2, actor: { id: 'reader', role: 'viewer', capabilities: ['records.read'] }, sourceIds: ['source-a', 'source-b'] };
const view = { domain: { from: '1900-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
  range: { fromMs: '-2208988800000', toMs: '-2208902400000' }, selectedId: 'selected-record', model: { id: 'model', version: 7 },
  queryState: { definitionVersion: 2, filters: { sourceIds: ['source-b'], schemaRefs: [{ id: 'schema', version: 3 }] }, search: 'generic', relationshipMode: 'family' },
  settings: { ratio: 16, scaleMode: 'adaptive' }, presentation: { labels: { visible: true } },
  table: { scope: 'window', projection: 'matches', columns: [{ field: '/title', width: 250 }], sort: [{ field: '/title', direction: 'desc' }] },
  transient: { mode: 'split' } };
const response = metadata => new Response(JSON.stringify(metadata), { status: 200 });

test('staged reconnect preserves the full configuration without clearing old unknown cleanup or releasing handles', async () => {
  const original = globalThis.fetch, calls = [], provider = new ServerProvider({ baseUrl: 'https://confirmed.example', token: 'confirmed-secret' });
  const debt = { needsCleanup: true, error: new Error('Unknown allocation') }; provider.preparationDrains.add(debt);
  const input = structuredClone(view), expected = structuredClone(view);
  let reply, result;
  provider.releaseQuery = async () => { throw new Error('Staging must not release the displayed query'); };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Promise(resolve => { reply = resolve; }); };
  try {
    const pending = prepareServerReconnect({ provider, info, view: input });
    input.range.fromMs = '0'; input.table.sort[0].direction = 'asc'; provider.baseUrl = 'https://other.example'; provider.token = 'other-secret';
    reply(response({ ...info, sourceIds: ['source-b', 'source-a'], settings: { range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' } } }));
    result = await pending;
    assert.equal(result.status, 'ready'); assert.deepEqual(result.view, expected);
    assert.notEqual(result.provider, provider); assert.equal(provider.disposed, false);
    assert.equal(provider.preparationDrains.size, 1); assert.equal(provider.preparationDrains.has(debt), true);
    assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].url, 'https://confirmed.example/api/v1/workspaces/default');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer confirmed-secret');
    assert.equal(result.provider.preparationDrains.size, 0);
  } finally { result?.provider.dispose(); provider.dispose(); globalThis.fetch = original; }
});

test('authorization and generation changes return distinct outcomes without transferring the old view or candidate', async () => {
  const original = globalThis.fetch;
  try {
    for (const [patch, expected] of [
      [{ generation: 'restored-generation' }, 'generation-changed'],
      [{ actor: { ...info.actor, id: 'different-reader' } }, 'authorization-changed'],
      [{ actor: { ...info.actor, capabilities: [] } }, 'authorization-changed'],
      [{ sourceIds: ['source-a'] }, 'authorization-changed'],
    ]) {
      const provider = new ServerProvider(); globalThis.fetch = async () => response({ ...info, ...patch });
      const result = await prepareServerReconnect({ provider, info, view });
      assert.equal(result.status, expected); assert.equal(result.provider, undefined); assert.equal(result.view, undefined);
      assert.equal(provider.disposed, false); provider.dispose();
    }
  } finally { globalThis.fetch = original; }
});

test('failed, stale, aborted and timed-out staging leaves the original source intact', async () => {
  const original = globalThis.fetch;
  try {
    for (const mode of ['failure', 'stale', 'stale-failure', 'abort', 'timeout', 'workspace']) {
      const provider = new ServerProvider(), controller = new AbortController();
      let reply, current = true;
      globalThis.fetch = async () => new Promise(resolve => { reply = resolve; });
      const pending = prepareServerReconnect({ provider, info, view, signal: controller.signal, isCurrent: () => current, timeout: mode === 'timeout' ? 5 : 1000 });
      if (mode === 'failure') reply(new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 }));
      if (mode === 'stale') { current = false; reply(response(info)); }
      if (mode === 'stale-failure') { current = false; reply(new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 })); }
      if (mode === 'abort') controller.abort();
      if (mode === 'workspace') reply(response({ ...info, workspaceId: 'other' }));
      await assert.rejects(pending, mode === 'failure' ? { code: 'unauthorized' } : mode === 'timeout' ? { code: 'reconnect_timeout' } : mode === 'workspace' ? { code: 'permission_scope_changed' } : { name: 'AbortError' });
      assert.equal(provider.disposed, false);
      if (mode === 'abort' || mode === 'timeout') { reply(response(info)); await new Promise(resolve => setImmediate(resolve)); }
      provider.dispose();
    }
  } finally { globalThis.fetch = original; }
});

test('reconnect rejects runtime handles before any network request', async () => {
  const original = globalThis.fetch, provider = new ServerProvider(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response(info); };
  try {
    for (const key of ['query', 'layoutId', 'selectedContext', 'preparationDrains']) {
      await assert.rejects(prepareServerReconnect({ provider, info, view: { ...view, [key]: {} } }), { code: 'invalid_reconnect_view' });
    }
    assert.equal(calls, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('unadopted staged candidates are disposed for changed authority and failed metadata', async () => {
  const originalFetch = globalThis.fetch, originalInitialize = ServerProvider.prototype.initialize;
  const provider = new ServerProvider(); let candidate;
  ServerProvider.prototype.initialize = function (...args) { candidate = this; return originalInitialize.apply(this, args); };
  try {
    globalThis.fetch = async () => response({ ...info, generation: 'replacement' });
    assert.equal((await prepareServerReconnect({ provider, info, view })).status, 'generation-changed');
    assert.notEqual(candidate, provider); assert.equal(candidate.disposed, true); assert.equal(candidate.token, '');
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 });
    await assert.rejects(prepareServerReconnect({ provider, info, view }), { code: 'unauthorized' });
    assert.equal(candidate.disposed, true); assert.equal(provider.disposed, false);
  } finally { provider.dispose(); globalThis.fetch = originalFetch; ServerProvider.prototype.initialize = originalInitialize; }
});
