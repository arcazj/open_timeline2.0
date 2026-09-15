import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvider } from '../../client/src/data/server-provider.js';

const query = { queryId: 'query', snapshotId: 'snapshot', mapId: 'map', generation: 'generation', revision: 3, state: 'ready' };
const response = body => new Response(body === null ? null : JSON.stringify(body), { status: body === null ? 204 : 200 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(1);
  assert.ok(predicate(), 'Expected asynchronous request to start');
};

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

for (const kind of ['query', 'layout']) {
  test(`${kind} cleanup drain waits for both the late allocation and its DELETE acknowledgement`, async () => {
    const original = globalThis.fetch, calls = [], controller = new AbortController();
    const provider = new ServerProvider({ baseUrl: 'https://original.example', token: 'original-secret' });
    const manifest = kind === 'query' ? query : { ...query, layoutId: 'owned-layout' };
    let resolveAllocation, resolveRelease, drained = false;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'DELETE') return new Promise(resolve => { resolveRelease = resolve; });
      return new Promise(resolve => { resolveAllocation = resolve; });
    };
    try {
      const pending = kind === 'query' ? provider.createQuery({}, { signal: controller.signal }) : provider.createLayout('query', {}, { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      const draining = provider.awaitPreparationCleanup({ timeout: 1000 }).then(() => { drained = true; });
      await delay(5);
      assert.equal(drained, false);
      provider.baseUrl = 'https://replacement.example'; provider.token = 'replacement-secret';
      resolveAllocation(response({ ...manifest, state: 'preparing' }));
      await until(() => resolveRelease);
      assert.equal(drained, false);
      assert.equal(calls[1].url, `https://original.example/api/v1/workspaces/default/query-sessions/query${kind === 'layout' ? '/layouts/owned-layout' : ''}`);
      assert.equal(calls[1].options.headers.Authorization, 'Bearer original-secret');
      await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_pending' });
      assert.equal(calls.length, 2, 'No competing allocation is sent before cleanup acknowledgement');
      resolveRelease(response(null));
      await draining;
      assert.equal(provider.preparationDrains.size, 0);
      globalThis.fetch = async () => response(query);
      assert.deepEqual(await provider.createQuery({}), query);
    } finally { provider.dispose(); globalThis.fetch = original; }
  });
}

test('cleanup wait deadlines and aborts do not cancel release, and a late acknowledgement clears the gate', async () => {
  const original = globalThis.fetch, controller = new AbortController(), waiter = new AbortController();
  const provider = new ServerProvider();
  let resolveAllocation, resolveRelease, releaseSignal;
  globalThis.fetch = async (url, options) => options.method === 'POST'
    ? new Promise(resolve => { resolveAllocation = resolve; })
    : new Promise(resolve => { resolveRelease = resolve; releaseSignal = options.signal; });
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending', status: 409 });
    assert.equal(provider.requiresReconnect, false, 'A pending acknowledged cleanup is not terminal failure');
    resolveAllocation(response(query));
    await until(() => resolveRelease);
    const interrupted = provider.awaitPreparationCleanup({ signal: waiter.signal, timeout: 1000 });
    waiter.abort();
    await assert.rejects(interrupted, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    assert.equal(releaseSignal.aborted, false, 'A waiter deadline must not cancel the release request');
    assert.equal(provider.preparationDrains.size, 1);
    resolveRelease(response(null));
    await provider.awaitPreparationCleanup({ timeout: 1000 });
    assert.equal(provider.preparationDrains.size, 0);
    assert.equal(provider.requiresReconnect, false);
    await assert.rejects(provider.awaitPreparationCleanup({ signal: waiter.signal }), { name: 'AbortError' });
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('negative cleanup acknowledgement reports a terminal cleanup failure without blocking ordinary reads', async () => {
  const original = globalThis.fetch, controller = new AbortController(), provider = new ServerProvider();
  let resolveAllocation;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') return new Promise(resolve => { resolveAllocation = resolve; });
    return options.method === 'DELETE' ? new Response(null, { status: 503 }) : response(query);
  };
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    resolveAllocation(response(query));
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 1000 }), { code: 'preparation_cleanup_failed', status: 409 });
    assert.equal(provider.requiresReconnect, true);
    await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_failed' });
    assert.deepEqual(await provider.getQuery('query'), query);
    assert.equal(provider.preparationDrains.size, 1);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('definite HTTP capacity rejection retains its structured error and leaves no cleanup debt', async () => {
  const original = globalThis.fetch, provider = new ServerProvider();
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'preparation_capacity', message: 'Busy', requestId: 'request-429' }), { status: 429 });
  try {
    await assert.rejects(provider.createQuery({}), { code: 'preparation_capacity', status: 429, requestId: 'request-429' });
    await assert.rejects(provider.queryRecords('query', {}, { timeout: 5 }), { code: 'preparation_capacity', status: 429, requestId: 'request-429' });
    await provider.awaitPreparationCleanup();
    assert.equal(provider.preparationDrains.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('a lost allocation reply cannot be advertised as completed cleanup', async () => {
  const original = globalThis.fetch, provider = new ServerProvider();
  globalThis.fetch = async () => { throw new TypeError('Connection lost'); };
  try {
    await assert.rejects(provider.createQuery({}), { code: 'server_unavailable' });
    assert.equal(provider.requiresReconnect, true);
    await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
    await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_failed' });
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('only explicit release timeouts retry the same owned DELETE until a late acknowledgement', async () => {
  const original = globalThis.fetch, controller = new AbortController(), calls = [];
  const provider = new ServerProvider({ baseUrl: 'https://original.example', token: 'original-secret' });
  let resolveAllocation, resolveRelease, releases = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return new Promise(resolve => { resolveAllocation = resolve; });
    if (++releases === 1) return new Response(JSON.stringify({ code: 'preparation_release_timeout' }), { status: 503 });
    return new Promise(resolve => { resolveRelease = resolve; });
  };
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    provider.baseUrl = 'https://replacement.example'; provider.token = 'replacement-secret';
    resolveAllocation(response(query));
    await until(() => resolveRelease);
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    assert.deepEqual(calls.map(call => call.options.method), ['POST', 'DELETE', 'DELETE']);
    assert.ok(calls.slice(1).every(call => call.url === 'https://original.example/api/v1/workspaces/default/query-sessions/query' && call.options.headers.Authorization === 'Bearer original-secret' && !call.options.signal.aborted));
    resolveRelease(response(null));
    await provider.awaitPreparationCleanup({ timeout: 1000 });
    assert.equal(provider.preparationDrains.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('repeated explicit release timeouts have a bounded retry count and retain honest failure', async () => {
  const original = globalThis.fetch, controller = new AbortController(), provider = new ServerProvider();
  let resolveAllocation, releases = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') return new Promise(resolve => { resolveAllocation = resolve; });
    releases++;
    return new Response(JSON.stringify({ code: 'preparation_release_timeout' }), { status: 503 });
  };
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    resolveAllocation(response(query));
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 1000 }), error => error.code === 'preparation_cleanup_failed' && error.cause.code === 'preparation_release_timeout');
    assert.equal(releases, 6);
    await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_failed' });
  } finally { provider.dispose(); globalThis.fetch = original; }
});

for (const action of ['abort', 'dispose']) {
  test(`table ${action} rejects immediately but retains its original HTTP read until acknowledged`, async () => {
    const original = globalThis.fetch, controller = new AbortController(), calls = [];
    const provider = new ServerProvider({ baseUrl: 'https://original.example', token: 'original-secret' });
    let reply, shown = false;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Promise(resolve => { reply = resolve; });
    };
    try {
      const pending = provider.queryRecords('query', { scope: 'all' }, { signal: controller.signal }).then(result => { shown = true; return result; });
      if (action === 'abort') controller.abort(); else provider.dispose();
      await assert.rejects(pending, { name: 'AbortError' });
      provider.baseUrl = 'https://replacement.example'; provider.token = 'replacement-secret';
      await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
      assert.equal(calls[0].options.signal.aborted, false);
      assert.equal(calls[0].url, 'https://original.example/api/v1/workspaces/default/query-sessions/query/records/query');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer original-secret');
      if (action === 'abort') {
        await assert.rejects(provider.queryRecords('query'), { code: 'preparation_cleanup_pending' });
        await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_pending' });
      }
      reply(response({ items: [{ record: { id: 'obsolete' } }] }));
      await provider.awaitPreparationCleanup({ timeout: 1000 });
      assert.equal(shown, false);
      assert.equal(calls.length, 1, 'Cancellation never retries the table POST or releases its still-selected query');
      assert.equal(provider.preparationDrains.size, 0);
      assert.equal(provider.preparationWaiters.size, 0);
    } finally { provider.dispose(); globalThis.fetch = original; }
  });
}

test('a definite canceled table error clears preparation debt, but a lost reply does not', async () => {
  const original = globalThis.fetch;
  try {
    for (const lost of [false, true]) {
      const provider = new ServerProvider(), controller = new AbortController();
      let reply, fail;
      globalThis.fetch = async () => new Promise((resolve, reject) => { reply = resolve; fail = reject; });
      const pending = provider.queryRecords('query', {}, { signal: controller.signal });
      controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
      if (lost) fail(new TypeError('Connection lost'));
      else reply(new Response(JSON.stringify({ code: 'preparation_capacity', requestId: 'busy' }), { status: 429 }));
      if (lost) await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
      else { await provider.awaitPreparationCleanup(); assert.equal(provider.preparationDrains.size, 0); }
      provider.dispose();
    }
  } finally { globalThis.fetch = original; }
});

test('ordinary owned preparation failure is delivered only after cleanup acknowledgement', async () => {
  const original = globalThis.fetch, provider = new ServerProvider();
  let release, delivered = false, first = true;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') return new Promise(resolve => { release = resolve; });
    if (first) { first = false; return response({ ...query, state: 'failed', error: { code: 'invalid_filter', message: 'Invalid filter', status: 422 } }); }
    return response(query);
  };
  try {
    const pending = provider.createQuery({}).catch(error => { delivered = true; throw error; });
    const rejected = assert.rejects(pending, { code: 'invalid_filter', status: 422 });
    await until(() => release);
    await delay(5); assert.equal(delivered, false);
    release(response(null)); await rejected;
    assert.equal(provider.preparationDrains.size, 0);
    assert.deepEqual(await provider.createQuery({}), query, 'The next valid query must not race the rejected query cleanup');
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('canceling while normal failure cleanup is pending still rejects the caller promptly', async () => {
  const original = globalThis.fetch, provider = new ServerProvider(), controller = new AbortController();
  let release;
  globalThis.fetch = async (url, options) => options.method === 'DELETE' ? new Promise(resolve => { release = resolve; })
    : response({ ...query, state: 'failed', error: { code: 'invalid_filter', message: 'Invalid filter', status: 422 } });
  try {
    const pending = provider.createQuery({}, { signal: controller.signal });
    await until(() => release);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    release(response(null)); await provider.awaitPreparationCleanup();
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('pre-admission table capacity retries preserve the original source, query and request body', async () => {
  const original = globalThis.fetch, calls = [], provider = new ServerProvider({ baseUrl: 'https://original.example', token: 'original-secret' });
  const input = { scope: 'all', sort: [{ field: 'title', direction: 'asc' }] };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? new Response(JSON.stringify({ code: 'preparation_capacity', requestId: 'busy' }), { status: 429 }) : response({ items: [], total: 0 });
  };
  try {
    const pending = provider.queryRecords('original-query', input);
    input.sort[0].direction = 'desc'; provider.baseUrl = 'https://replacement.example'; provider.token = 'replacement-secret'; provider.base = '/replacement';
    assert.deepEqual(await pending, { items: [], total: 0 });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url === 'https://original.example/api/v1/workspaces/default/query-sessions/original-query/records/query'
      && call.options.headers.Authorization === 'Bearer original-secret'
      && call.options.body === JSON.stringify({ scope: 'all', sort: [{ field: 'title', direction: 'asc' }] })));
    assert.equal(provider.preparationDrains.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('canceling capacity backoff clears debt immediately and never dispatches another POST', async () => {
  const original = globalThis.fetch, provider = new ServerProvider(), controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'preparation_capacity' }), { status: 429 }); };
  try {
    const pending = provider.queryRecords('query', {}, { signal: controller.signal });
    await delay(5); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await provider.awaitPreparationCleanup({ timeout: 1000 });
    await delay(150); assert.equal(calls, 1); assert.equal(provider.preparationDrains.size, 0);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('canceling an admitted retry keeps its HTTP reply drain until completion', async () => {
  const original = globalThis.fetch, provider = new ServerProvider(), controller = new AbortController();
  let calls = 0, reply, requestSignal;
  globalThis.fetch = async (url, options) => {
    if (++calls === 1) return new Response(JSON.stringify({ code: 'preparation_capacity' }), { status: 429 });
    requestSignal = options.signal; return new Promise(resolve => { reply = resolve; });
  };
  try {
    const pending = provider.queryRecords('query', {}, { signal: controller.signal });
    for (let i = 0; i < 100 && !reply; i++) await delay(5);
    assert.ok(reply); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(provider.awaitPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
    assert.equal(requestSignal.aborted, false);
    reply(response({ items: [], total: 0 })); await provider.awaitPreparationCleanup(); assert.equal(calls, 2);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

test('table capacity retry deadline retains the last structured429 without transport or mutation retries', async () => {
  const original = globalThis.fetch, provider = new ServerProvider();
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: 'preparation_capacity', requestId: 'last-busy', message: 'Another tab is preparing' }), { status: 429 }); };
    await assert.rejects(provider.queryRecords('query', {}, { timeout: 15 }), { code: 'preparation_capacity', status: 429, requestId: 'last-busy' });
    assert.equal(calls, 1); await provider.awaitPreparationCleanup();
    for (const [status, code] of [[429, 'rate_limited'], [503, 'preparation_capacity'], [401, 'unauthorized']]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code }), { status }); };
      await assert.rejects(provider.queryRecords('query'), { code, status }); assert.equal(calls, 1);
    }
    calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('Transport failure'); };
    await assert.rejects(provider.queryRecords('query'), { code: 'server_unavailable' }); assert.equal(calls, 1);
  } finally { provider.dispose(); globalThis.fetch = original; }
});

for (const releaseFails of [false, true]) {
  test(`reconnect-only pending cleanup waits known work and retains ${releaseFails ? 'new and previous' : 'previous'} terminal debt`, async () => {
    const original = globalThis.fetch, provider = new ServerProvider(), first = new AbortController(), second = new AbortController();
    let failFirst, replySecond, release, posts = 0, settled = false;
    globalThis.fetch = async (url, options) => {
      if (options.method === 'DELETE') return new Promise(resolve => { release = resolve; });
      if (++posts === 1) return new Promise((resolve, reject) => { failFirst = reject; });
      return new Promise(resolve => { replySecond = resolve; });
    };
    try {
      const one = provider.createQuery({}, { signal: first.signal }), two = provider.createQuery({}, { signal: second.signal });
      first.abort(); second.abort();
      await assert.rejects(one, { name: 'AbortError' }); await assert.rejects(two, { name: 'AbortError' });
      failFirst(new TypeError('Unknown allocation')); replySecond(response(query));
      await until(() => release);
      await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
      const pending = provider.awaitPendingPreparationCleanup({ timeout: 1000 }).then(() => { settled = true; });
      await delay(5); assert.equal(settled, false);
      await assert.rejects(provider.awaitPendingPreparationCleanup({ timeout: 5 }), { code: 'preparation_cleanup_pending' });
      release(releaseFails ? new Response(null, { status: 503 }) : response(null));
      await pending;
      assert.equal(provider.requiresReconnect, true);
      assert.equal(provider.preparationDrains.size, releaseFails ? 2 : 1);
      await assert.rejects(provider.awaitPreparationCleanup(), { code: 'preparation_cleanup_failed' });
      await assert.rejects(provider.createQuery({}), { code: 'preparation_cleanup_failed' });
    } finally { provider.dispose(); globalThis.fetch = original; }
  });
}
