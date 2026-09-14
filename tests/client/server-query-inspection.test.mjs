import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvider } from '../../client/src/data/server-provider.js';

test('Server layout inspection uses an authenticated read and forwards cancellation', async () => {
  const fetch = globalThis.fetch;
  const provider = new ServerProvider({ baseUrl: 'https://timeline.example', token: 'inspection-test-token' });
  const controller = new AbortController();
  const requests = [];
  const manifest = { layoutId: 'layout', mapId: 'map', pageCapacity: 12 };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(manifest));
  };
  try {
    assert.deepEqual(await provider.getLayout('query/identity', 'layout identity', { signal: controller.signal }), manifest);
    assert.equal(requests[0].url, 'https://timeline.example/api/v1/workspaces/default/query-sessions/query%2Fidentity/layouts/layout%20identity');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.body, undefined);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer inspection-test-token');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(provider.controllers.size, 0);
    globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const pending = provider.getLayout('query', 'layout', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(provider.controllers.size, 0);
  } finally {
    provider.dispose();
    globalThis.fetch = fetch;
  }
});

test('Server layout inspection preserves expiry and never starts another preparation', async () => {
  const fetch = globalThis.fetch;
  const provider = new ServerProvider();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ code: 'query_expired', message: 'Prepare a new query.' }), { status: 410 });
  };
  try {
    await assert.rejects(provider.getLayout('expired-query', 'layout'), { code: 'query_expired', status: 410 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, 'GET');
  } finally {
    provider.dispose();
    globalThis.fetch = fetch;
  }
});
