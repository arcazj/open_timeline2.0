import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerProvider } from '../../client/src/data/server-provider.js';

function providerSpy() {
  const provider = new ServerProvider({ baseUrl: 'http://127.0.0.1:8765', token: 'test-only-token' });
  provider._request = async (path, options) => ({ path, options });
  return provider;
}

test('legacy rescan waits for the 300-second server deadline plus transport margin', async () => {
  const provider = providerSpy();
  const call = await provider.reloadLegacy();
  assert.equal(call.path, '/api/v1/workspaces/default/legacy/reload');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.timeout, 330000);
});

test('legacy rescan accepts an explicit timeout and preserves cancellation options', async () => {
  const provider = providerSpy(), controller = new AbortController();
  const options = { timeout: 650000, signal: controller.signal, headers: { 'X-Test': 'preserved' } };
  const call = await provider.reloadLegacy(options);
  assert.equal(call.options.timeout, 650000);
  assert.equal(call.options.signal, controller.signal);
  assert.deepEqual(call.options.headers, options.headers);
  assert.equal(options.method, undefined);
});

test('an undefined rescan timeout cannot fall back to the normal 30-second request timeout', async () => {
  const provider = providerSpy();
  assert.equal((await provider.reloadLegacy({ timeout: undefined })).options.timeout, 330000);
  assert.equal((await provider.reloadLegacy({ timeout: null })).options.timeout, 330000);
});
