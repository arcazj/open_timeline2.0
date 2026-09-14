import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const query = { queryId: 'query', snapshotId: 'snapshot', mapId: 'map', generation: 'generation', revision: 3, state: 'ready' };
const response = body => new Response(body === null ? null : JSON.stringify(body), { status: body === null ? 204 : 200 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('local-browser failed preparations release with the same local header and never a bearer token', async () => {
  const original = globalThis.fetch, previousLocation = globalThis.location, calls = [];
  globalThis.location = { origin: 'http://127.0.0.1:9876', href: 'http://127.0.0.1:9876/', protocol: 'http:' };
  const provider = new ServerProvider({ baseUrl: location.origin, localBrowser: true });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(options.method === 'DELETE' ? null : { ...query, state: 'failed', error: { code: 'invalid_presentation', message: 'Invalid model', status: 422 } });
  };
  try {
    await assert.rejects(provider.createQuery({}), { code: 'invalid_presentation' });
    assert.deepEqual(calls.map(call => call.options.method), ['POST', 'DELETE']);
    assert.ok(calls.every(call => call.options.headers['X-OpenBEXI-Local'] === '1' && !call.options.headers.Authorization));
    assert.throws(() => new ServerProvider({ baseUrl: 'http://other.test', localBrowser: true }), /same HTTP origin/);
  } finally {
    provider.dispose(); globalThis.fetch = original;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test('query and layout preparation poll their own status and resolve only ready manifests', async () => {
  const original = globalThis.fetch, calls = [];
  const provider = new ServerProvider({ baseUrl: 'https://timeline.example', token: 'test-secret' });
  const layout = { layoutId: 'layout', mapId: 'map', totalRows: 8 };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = url.includes('/layouts') ? layout : query;
    return response(options.method === 'POST' ? { ...body, state: 'preparing' } : body);
  };
  try {
    assert.deepEqual(await provider.createQuery({ domain: {} }), query);
    assert.deepEqual(await provider.createLayout('query', { mapId: 'map' }), layout);
    assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET', 'POST', 'GET']);
    assert.equal(calls[0].options.headers.Prefer, 'respond-async');
    assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer test-secret'));
    assert.equal(provider.preparationWaiters.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('failed or identity-changing preparations reject and release without submitting again', async () => {
  const original = globalThis.fetch;
  try {
    for (const result of [{ ...query, state: 'failed', error: { code: 'row_payload_limit', message: 'Too large', status: 413 } }, { ...query, revision: 4 }]) {
      const provider = new ServerProvider(), calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return response(options.method === 'DELETE' ? null : options.method === 'POST' ? { ...query, state: 'preparing' } : result);
      };
      await assert.rejects(provider.createQuery({}), { code: result.state === 'failed' ? 'row_payload_limit' : 'invalid_response' });
      assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET', 'DELETE']);
      provider.dispose();
    }
  } finally { globalThis.fetch = original; }
});

for (const action of ['abort', 'dispose']) {
  test(`${action} rejects promptly and releases a late allocation using its captured source credential`, async () => {
    const original = globalThis.fetch, calls = [], controller = new AbortController();
    const provider = new ServerProvider({ baseUrl: 'https://original.example', token: 'original-secret' });
    let resolveAllocation;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') return new Promise(resolve => { resolveAllocation = resolve; });
      return response(null);
    };
    try {
      const pending = provider.createQuery({}, { signal: controller.signal });
      if (action === 'abort') controller.abort(); else provider.dispose();
      await assert.rejects(pending, { name: 'AbortError' });
      resolveAllocation(response({ ...query, state: 'preparing' }));
      await delay(10);
      assert.deepEqual(calls.map(call => call.options.method), ['POST', 'DELETE']);
      assert.equal(calls[1].url, 'https://original.example/api/v1/workspaces/default/query-sessions/query');
      assert.equal(calls[1].options.headers.Authorization, 'Bearer original-secret');
      assert.equal(provider.preparationWaiters.size, 0);
    } finally { provider.dispose(); globalThis.fetch = original; }
  });
}

test('aborted preparation polling releases its handle without a replacement query', async () => {
  const original = globalThis.fetch, controller = new AbortController(), calls = [];
  const provider = new ServerProvider();
  let enteredPoll;
  const entered = new Promise(resolve => { enteredPoll = resolve; });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return response({ ...query, state: 'preparing' });
    if (options.method === 'DELETE') return response(null);
    enteredPoll();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    await entered;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await delay(5);
    assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET', 'DELETE']);
    assert.equal(provider.controllers.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});
