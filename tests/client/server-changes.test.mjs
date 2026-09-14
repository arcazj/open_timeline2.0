import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { ProviderError } from '../../client/src/data/data-provider.js';

const generation = '11111111-1111-4111-8111-111111111111';
const scope = 'a'.repeat(64);
const page = (after, changes = [], hasMore = false, through = after) => ({ generation, scope, nextRevision: after, throughRevision: through, changes, hasMore });
const notice = revision => ({ revision, family: 'records', recordIds: ['22222222-2222-4222-8222-222222222222'], requiresReload: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };

test('change polling captures its immutable baseline and scope, drains pages sequentially without creating queries', async () => {
  const provider = new ServerProvider();
  provider.metadata = { generation, revision: 1 };
  const calls = [], events = [];
  let active = 0, peak = 0;
  provider._request = async (path, options) => {
    calls.push({ path, options }); active++; peak = Math.max(peak, active);
    await tick(); active--;
    return calls.length === 1 ? page(2, [notice(2)], true, 3) : page(3, [notice(3)]);
  };
  const stop = provider.subscribeChanges(event => events.push(event));
  provider.metadata.revision = 999;
  await waitFor(() => events.length === 2);
  stop();
  assert.equal(peak, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /afterRevision=1/);
  assert.match(calls[1].path, /afterRevision=2/);
  assert.match(calls[1].path, new RegExp(`scope=${scope}`));
  assert.ok(calls.every(call => call.path.includes('/changes?') && call.options.timeout === 5000));
  assert.deepEqual(events.map(event => event.type), ['changed', 'changed']);
  assert.equal(provider.changeSubscriptions.size, 0);
  provider.dispose();
});

for (const [status, code, expected] of [[401, 'unauthorized', 'authorization-lost'], [403, 'forbidden', 'authorization-lost'], [409, 'permission_scope_changed', 'authorization-lost'], [409, 'generation_mismatch', 'generation-changed'], [409, 'replay_gap', 'generation-changed']]) {
  test(`change polling stops on ${code}`, async () => {
    const provider = new ServerProvider();
    provider.metadata = { generation, revision: 1 };
    const events = [];
    let requests = 0;
    provider._request = async () => { requests++; throw new ProviderError(code, 'Sanitized failure', status); };
    provider.subscribeChanges(event => events.push(event));
    await tick();
    assert.equal(events[0].type, expected);
    assert.equal(requests, 1);
    assert.equal(provider.changeSubscriptions.size, 0);
    provider.dispose();
  });
}

test('outage retries only reads and recovery clears stale indication without advancing on error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new ServerProvider();
  provider.metadata = { generation, revision: 7 };
  const events = [], paths = [];
  provider._request = async path => {
    paths.push(path);
    if (paths.length === 1) throw new ProviderError('server_unavailable', 'Offline', 503);
    return page(7);
  };
  provider.subscribeChanges(event => events.push(event));
  await tick();
  assert.equal(events[0].type, 'server-unavailable');
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(events[1].type, 'changed');
  assert.equal(events[1].recovered, true);
  assert.equal(paths[0], paths[1]);
  provider.dispose();
});

test('malformed feed never advances a captured cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new ServerProvider();
  provider.metadata = { generation, revision: 1 };
  const paths = [], events = [];
  provider._request = async path => { paths.push(path); return page(4, [notice(5)]); };
  provider.subscribeChanges(event => events.push(event));
  await tick(); t.mock.timers.tick(1000); await tick();
  assert.equal(events[0].code, 'invalid_response');
  assert.equal(paths[0], paths[1]);
  provider.dispose();
});

for (const mode of ['unsubscribe', 'dispose', 'signal']) {
  test(`${mode} aborts pending polling and suppresses even an uncooperative late response`, async () => {
    const provider = new ServerProvider();
    provider.metadata = { generation, revision: 1 };
    const external = new AbortController(), events = [];
    let resolve, pendingSignal;
    provider._request = (_path, options) => { pendingSignal = options.signal; return new Promise(done => { resolve = done; }); };
    const stop = provider.subscribeChanges(event => events.push(event), { signal: external.signal });
    if (mode === 'unsubscribe') stop();
    else if (mode === 'dispose') provider.dispose();
    else external.abort();
    assert.ok(pendingSignal.aborted);
    resolve(page(2, [notice(2)]));
    await tick();
    assert.deepEqual(events, []);
    assert.equal(provider.changeSubscriptions.size, 0);
    provider.dispose();
  });
}

test('polling uses authenticated abortable HTTP reads, never credentials in query or write retries', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(page(2, [notice(2)])), { status: 200 });
  });
  const provider = new ServerProvider({ baseUrl: 'https://example.test', token: 'private-token' });
  provider.metadata = { generation, revision: 1 };
  const events = [];
  const stop = provider.subscribeChanges(event => events.push(event));
  await tick(); stop();
  assert.equal(events.length, 1);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.ok(!requests[0].url.includes('private-token'));
  assert.equal(provider.controllers.size, 0);
  provider.dispose();
});
