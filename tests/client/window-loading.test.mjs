import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferedWindow, predictiveWindow, createWindowLoader, startupTarget } from '../../client/src/data/window-loading.js';

const range = { fromMs: String(Date.parse('2024-03-18T12:00:00Z')), toMs: String(Date.parse('2024-03-18T13:00:00Z')) };
const shifted = minutes => ({ fromMs: String(Number(range.fromMs) + minutes * 60000), toMs: String(Number(range.toMs) + minutes * 60000) });
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
function clock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, delay) => { const id = sequence++; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
    get pending() { return timers.size; },
    async tick(ms) {
      const until = time + ms;
      for (let iterations = 0; iterations < 1000; iterations++) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= until);
        if (!next) { time = until; await flush(); return; }
        timers.delete(next[0]); time = next[1].at; void next[1].fn(); await flush();
      }
      throw new Error('Runaway timer scheduling');
    },
  };
}
test('window buffer stays small, favors travel direction, and clamps supported years', () => {
  assert.deepEqual(bufferedWindow(range), { from: '2024-03-18T11:45:00.000Z', to: '2024-03-18T13:15:00.000Z' });
  assert.equal(bufferedWindow(range, .25, 1, 3).to, '2024-03-18T13:30:00.000Z');
  assert.equal(bufferedWindow(range, .25, -1, 3).from, '2024-03-18T11:30:00.000Z');
  assert.equal(bufferedWindow({ fromMs: '-377705116800000', toMs: '-377705113200000' }).from, '-009999-01-01T00:00:00.000Z');
  assert.throws(() => bufferedWindow(range, 2));
});

test('prefetch is single-flight, replaces pending intent, and reuses bounded coverage', async () => {
  const time = clock();
  let release;
  const calls = [];
  const loader = createWindowLoader({ prefetchWindow(input, options) {
    calls.push({ input, options }); return new Promise(resolve => { release = () => resolve({ status: 'cached' }); });
  } }, time);
  loader.request(range, { sourceIds: ['a'] });
  await time.tick(180);
  loader.request(range, { sourceIds: ['a'] });
  assert.equal(calls.length, 1);
  release(); await flush(); await time.tick(180);
  assert.equal(calls.length, 1);
  await time.tick(16000);
  loader.request(range, { sourceIds: ['b'] });
  await time.tick(180);
  assert.equal(calls.length, 2);
  loader.dispose();
  assert.equal(calls[1].options.signal.aborted, true);
  release(); await flush();
});

test('latency and viewport-normalized velocity predict bounded directional lead', () => {
  const slow = predictiveWindow(range, { direction: 1, speed: .2, viewportWidth: 1000, latencyMs: 100 });
  const delayed = predictiveWindow(range, { direction: 1, speed: .2, viewportWidth: 1000, latencyMs: 1000 });
  assert.ok(Date.parse(delayed.domain.to) > Date.parse(slow.domain.to));
  assert.equal(slow.domain.from, delayed.domain.from);
  const reverse = predictiveWindow(range, { direction: -1, speed: 100, viewportWidth: 390, latencyMs: 10000 });
  assert.equal(reverse.leadMs, 1600); assert.equal(reverse.leadRatio, 1.5);
  assert.equal(reverse.domain.from, '2024-03-18T10:15:00.000Z');
  assert.equal(reverse.domain.to, '2024-03-18T13:15:00.000Z');
  assert.equal(predictiveWindow(range, { direction: 1, speed: 3 }).domain.to, bufferedWindow(range, .25, 1, 3).to);
  assert.equal(predictiveWindow({ fromMs: '-377705116800000', toMs: '-377705113200000' }, { direction: -1, speed: 100, viewportWidth: 1 }).domain.from, '-009999-01-01T00:00:00.000Z');
  assert.throws(() => predictiveWindow(range, { latencyMs: NaN }));
});

test('coverage canonicalizes filter keys and requires matching source generation and revision', async () => {
  const time = clock(), calls = [], statuses = [];
  const loader = createWindowLoader({ identity: 'provider-A', prefetchWindow: async input => { calls.push(input); return { status: 'cached' }; } }, { ...time, onStatus: status => statuses.push(status) });
  const scope = { generation: 'generation-A', revision: 1, preferencesRevision: 2, querySignature: 'filter-view-A' };
  loader.request(range, { kind: 'all', sourceIds: ['a'] }, { scope }); await time.tick(180);
  loader.request(range, { sourceIds: ['a'], kind: 'all' }, { scope: { querySignature: 'filter-view-A', preferencesRevision: 2, revision: 1, generation: 'generation-A' } }); await time.tick(180);
  assert.equal(calls.length, 1);
  assert.equal(loader.getCoverage(range, { sourceIds: ['a'], kind: 'all' }, { scope }).coverage, 'warm');
  assert.equal(loader.getCoverage(range, { sourceIds: ['a'], kind: 'all' }, { scope: { ...scope, revision: 2 } }).coverage, 'not-loaded');
  assert.equal(loader.getStatus().renderReady, false);
  assert.equal(loader.getStatus().layer, 'server-record-cache');
  loader.request(range, { sourceIds: ['a'], kind: 'all' }, { scope: { ...scope, revision: 2 } }); await time.tick(180);
  assert.equal(calls.length, 2);
  assert.ok(statuses.some(value => value.state === 'warming'));
  assert.equal(statuses.at(-1).active, false);
  loader.dispose();
});

test('one active request coalesces successive overlapping pending windows', async () => {
  const time = clock(), calls = [];
  const loader = createWindowLoader({ prefetchWindow: (input, options) => new Promise(resolve => calls.push({ input, options, resolve })) }, time);
  loader.request(range, {}); await time.tick(180);
  loader.request(shifted(10), {});
  loader.request(shifted(20), {});
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, false);
  calls[0].resolve({ status: 'cached' }); await flush(); await time.tick(180);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input.domain.from, '2024-03-18T11:55:00.000Z');
  assert.equal(calls[1].input.domain.to, '2024-03-18T13:35:00.000Z');
  calls[1].resolve({ status: 'cached' }); await flush();
  assert.equal(loader.getStatus().state, 'warm'); assert.ok(loader.getStatus().metrics.coalesced > 0);
  loader.dispose();
});

test('coverage unions contiguous windows, expires, and never exceeds six entries', async () => {
  const time = clock(), calls = [];
  const loader = createWindowLoader({ prefetchWindow: async input => { calls.push(input); return { status: 'cached' }; } }, { ...time, ratio: 0, delayMs: 0, ttlMs: 1000 });
  loader.request(range, {}); await time.tick(0);
  loader.request(shifted(60), {}); await time.tick(0);
  const union = { fromMs: range.fromMs, toMs: shifted(60).toMs };
  loader.request(union, {}); await time.tick(0);
  assert.equal(calls.length, 2); assert.equal(loader.getStatus().coverage, 'warm');
  await time.tick(1001);
  assert.equal(loader.getStatus().state, 'not-loaded'); assert.equal(loader.getStatus().reason, 'coverage-expired');
  for (let index = 0; index < 8; index++) { loader.request(shifted(index * 120), {}); await time.tick(0); }
  assert.equal(loader.getStatus().cacheEntries, 6);
  assert.equal(loader.getCoverage(range, {}).coverage, 'not-loaded');
  loader.dispose();
});

test('obsolete work aborts promptly and late responses cannot overwrite current coverage', async () => {
  const time = clock(), calls = [];
  const loader = createWindowLoader({ prefetchWindow: (input, options) => new Promise(resolve => calls.push({ input, options, resolve })) }, { ...time, delayMs: 0 });
  loader.request(range, {}, { scope: { revision: 1 } }); await time.tick(0);
  loader.request(shifted(1440), {}, { scope: { revision: 2 } }); await flush(); await time.tick(0);
  assert.equal(calls[0].options.signal.aborted, true); assert.equal(calls.length, 2);
  calls[1].resolve({ status: 'cached' }); await flush();
  const current = loader.getStatus();
  calls[0].resolve({ status: 'cached' }); await flush();
  assert.deepEqual(loader.getStatus(), current);
  assert.equal(current.cacheEntries, 1); assert.equal(current.state, 'warm');
  loader.dispose();
});

test('busy and transport failures stay explicit, with bounded retry backoff', async () => {
  const time = clock(), states = [];
  let calls = 0;
  const loader = createWindowLoader({ prefetchWindow: async () => { calls++; return { status: 'busy' }; } }, { ...time, delayMs: 0, retryMs: 100, maxRetries: 2, onStatus: status => states.push(status) });
  loader.request(range, {}); await time.tick(0);
  assert.equal(calls, 1); assert.equal(loader.getStatus().reason, 'busy'); assert.equal(loader.getStatus().coverage, 'not-loaded');
  await time.tick(99); assert.equal(calls, 1);
  await time.tick(1); assert.equal(calls, 2);
  await time.tick(199); assert.equal(calls, 2);
  await time.tick(1); assert.equal(calls, 3);
  assert.equal(time.pending, 0); assert.equal(loader.getStatus().state, 'not-loaded');
  assert.ok(states.every(value => value.renderReady === false));
  loader.dispose();
  const failed = createWindowLoader({ prefetchWindow: async () => { throw Object.assign(new Error('Connection unavailable'), { code: 'offline' }); } }, { ...time, delayMs: 0, maxRetries: 0 });
  failed.request(range, {}); await time.tick(0);
  assert.equal(failed.getStatus().state, 'error'); assert.equal(failed.getStatus().error.code, 'offline'); assert.equal(failed.getStatus().coverage, 'not-loaded');
  failed.dispose();
});

test('a stalled provider has a deadline even when it ignores abort', async () => {
  const time = clock(), calls = [];
  const loader = createWindowLoader({ prefetchWindow: (input, options) => new Promise(resolve => calls.push({ input, options, resolve })) }, { ...time, delayMs: 0, timeoutMs: 500, maxRetries: 0 });
  loader.request(range, {}); await time.tick(0); await time.tick(499);
  assert.equal(calls[0].options.signal.aborted, false);
  await time.tick(1);
  assert.equal(calls[0].options.signal.aborted, true); assert.equal(loader.getStatus().reason, 'timeout'); assert.equal(loader.getStatus().active, false);
  loader.request(shifted(120), {}); await time.tick(0);
  calls[1].resolve({ status: 'cached' }); await flush();
  calls[0].resolve({ status: 'cached' }); await flush();
  assert.equal(loader.getStatus().cacheEntries, 1);
  loader.dispose(); assert.equal(time.pending, 0);
});

test('foreground latency observations adapt prediction without dropping resource bounds', async () => {
  const time = clock();
  const loader = createWindowLoader({ prefetchWindow: async () => ({ status: 'cached' }) }, { ...time, maxWindowRatio: 2 });
  loader.observeLatency(1000);
  const status = loader.request(range, {}, { direction: 1, speed: 20, viewportWidth: 390 });
  assert.equal(status.estimatedLatencyMs, 1200); assert.equal(status.leadRatio, .5);
  assert.equal(Date.parse(status.requestedDomain.to) - Date.parse(status.requestedDomain.from), 2 * 3600000);
  const updated = loader.observeLatency(100);
  assert.ok(updated.estimatedLatencyMs > 100); assert.equal(updated.latencySamples, 2);
  assert.equal(loader.observeLatency(NaN).latencySamples, 2);
  loader.pause(); await time.tick(10000);
  assert.equal(loader.getStatus().state, 'paused'); assert.equal(loader.getStatus().metrics.requests, 0);
  loader.dispose();
});

test('in-flight dedup retains failure retry and disposal fences all late observations', async () => {
  const time = clock(), calls = [], statuses = [];
  const loader = createWindowLoader({ prefetchWindow: (input, options) => new Promise(resolve => calls.push({ input, options, resolve })) }, { ...time, delayMs: 0, retryMs: 10, maxRetries: 1, onStatus: status => statuses.push(status) });
  const filters = { sourceIds: ['a'] };
  loader.request(range, filters); filters.sourceIds.push('b'); await time.tick(0);
  assert.deepEqual(calls[0].input.filters, { sourceIds: ['a'] });
  loader.request(range, { sourceIds: ['a'] });
  calls[0].resolve({ status: 'busy' }); await flush(); await time.tick(10);
  assert.equal(calls.length, 2);
  loader.dispose(); const count = statuses.length;
  calls[1].resolve({ status: 'cached' }); await flush(); await time.tick(10000);
  assert.equal(statuses.length, count); assert.equal(time.pending, 0); assert.equal(loader.getStatus().cacheEntries, 0);
});

test('file mode performs no HTTP discovery; configured failure never becomes demo mode', async () => {
  assert.equal((await startupTarget({ protocol: 'file:', fetcher: () => assert.fail('No request allowed') })).mode, 'standalone');
  assert.equal((await startupTarget({ protocol: 'http:', fetcher: async () => { throw new Error('offline'); } })).mode, 'unavailable');
  assert.equal((await startupTarget({ protocol: 'http:', fetcher: async () => ({ status: 404 }) })).mode, 'standalone');
  const target = { mode: 'configured-server', localBrowser: true, sourceName: 'REAL' };
  assert.deepEqual(await startupTarget({ protocol: 'http:', fetcher: async () => ({ ok: true, json: async () => target }) }), target);
});

test('bootstrap accepts a cold response after two seconds without waiting the full deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const target = { mode: 'configured-server', localBrowser: true, sourceName: 'REAL' };
  let signal;
  const pending = startupTarget({ protocol: 'http:', fetcher: (_url, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    setTimeout(() => resolve({ ok: true, json: async () => target }), 2500);
  }) });
  t.mock.timers.tick(2500);
  assert.deepEqual(await pending, target);
  t.mock.timers.tick(5000);
  assert.equal(signal.aborted, false);
});

test('bootstrap still aborts a stalled request at its five-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = startupTarget({ protocol: 'http:', fetcher: (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  t.mock.timers.tick(4999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.equal((await pending).mode, 'unavailable');
});
