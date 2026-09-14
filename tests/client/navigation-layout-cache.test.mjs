import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationLayoutCache } from '../../client/src/timeline/navigation-layout-cache.js';

test('only one provisional layout is retained and an exact final range adopts it', async () => {
  const released = [], owner = {}, value = { layout: 'prepared' };
  const cache = createNavigationLayoutCache({ prepare: async () => value, release: item => released.push(item) });
  assert.equal(cache.request(owner, 'range-a', {}), true);
  assert.equal(cache.request(owner, 'range-b', {}), false);
  assert.equal(await cache.take(owner, 'range-a'), value); assert.equal(cache.pending, false); assert.deepEqual(released, []);
});

test('a mismatched range aborts and releases even a late allocation', async () => {
  const released = [], owner = {}; let complete, signal;
  const cache = createNavigationLayoutCache({ prepare: async (_owner, _range, token) => { signal = token; return new Promise(resolve => { complete = resolve; }); }, release: item => released.push(item) });
  cache.request(owner, 'range-a', {}); await Promise.resolve();
  const result = cache.take(owner, 'range-b'); assert.equal(signal.aborted, true);
  const value = { layout: 'late' }; complete(value);
  assert.equal(await result, null); assert.deepEqual(released, [value]);
});

test('cancel before scheduling performs no request and cannot leak an old source result', async () => {
  let calls = 0; const cache = createNavigationLayoutCache({ prepare: async () => { calls++; return {}; }, release: () => {} });
  cache.request({}, 'a', {}); await cache.discard(); assert.equal(calls, 0);
  const first = {}, second = {}; cache.request(first, 'same-range', {});
  assert.equal(await cache.take(second, 'same-range'), null); assert.equal(cache.pending, false);
});
