import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverStartupCatalog, startupMessage } from '../../client/src/data/startup-discovery.js';

const catalog = { mode: 'local-read-only', sources: [{ id: 's', namespace: 'N', path: '/archive' }] };
const starting = [503, { code: 'server_starting' }];
const health = [503, { status: 'starting', phase: 'reading-legacy', filesRead: 3 }];
function fake(responses) {
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push({ path, options });
    const [status, body] = responses.shift();
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetcher, calls };
}

test('connects only after readiness, with bounded requests and sanitized progress', async () => {
  const { fetcher, calls } = fake([starting, health, [200, { status: 'ready' }], [200, catalog]]), progress = [];
  const result = await discoverStartupCatalog({ fetcher, wait: async () => {}, onProgress: value => progress.push(value) });
  assert.deepEqual(result, { state: 'ready', catalog });
  assert.deepEqual(calls.map(call => call.path), ['/api/v1/local-sources', '/health/ready', '/health/ready', '/api/v1/local-sources']);
  assert.ok(calls.every(call => call.options.signal && call.options.credentials === 'omit' && call.options.cache === 'no-store'));
  assert.match(startupMessage(progress.at(-1)), /3 files read.*Local snapshot remains active/);
  assert.doesNotMatch(startupMessage({ phase: '<private>', filesRead: -1, recordsRead: 'secret' }), /private|secret|-1/);
});

test('ready local server requires no polling; unrelated HTTP hosts are not retried', async () => {
  for (const [response, state] of [[[200, catalog], 'ready'], [[404, {}], 'unsupported'], [[401, {}], 'unsupported'], [[200, {}], 'unsupported']]) {
    const { fetcher, calls } = fake([response]);
    assert.equal((await discoverStartupCatalog({ fetcher })).state, state);
    assert.equal(calls.length, 1);
  }
});

test('failed, stopped, timed out, and cancelled startup leave no polling loop', async () => {
  for (const responses of [[starting, [503, { status: 'failed' }]], [[503, { code: 'startup_failed' }]]]) {
    assert.equal((await discoverStartupCatalog({ ...fake(responses) })).state, 'failed');
  }
  assert.equal((await discoverStartupCatalog({ fetcher: async () => { throw new Error('offline'); } })).state, 'unavailable');
  let elapsed = 0;
  assert.equal((await discoverStartupCatalog({ ...fake([starting, health]), now: () => elapsed, budgetMs: 10, wait: async () => { elapsed = 10; } })).state, 'timeout');
  const controller = new AbortController();
  assert.equal((await discoverStartupCatalog({ ...fake([starting]), signal: controller.signal, onProgress: () => controller.abort() })).state, 'cancelled');
});

test('hung fetch is cancelled by per-request timeout', async () => {
  const fetcher = (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  assert.equal((await discoverStartupCatalog({ fetcher, requestMs: 10 })).state, 'unavailable');
});
