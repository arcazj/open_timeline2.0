import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationBuffer, navigationTiles } from '../../client/src/timeline/navigation-buffer.js';

const tick = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const context = (id = 'query') => ({ width: 100, query: { queryId: id } });
const ready = payload => ({ status: 'ready', payload });

function harness(t, { honorAbort = false, ...options } = {}) {
  let time = 0;
  const jobs = [], notifications = [];
  const buffer = createNavigationBuffer({
    now: () => time, changed: owner => notifications.push(owner),
    prepare: (owner, index, signal) => new Promise((resolve, reject) => {
      jobs.push({ owner, index, signal, resolve, reject });
      if (honorAbort) signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }), ...options,
  });
  t.after(async () => { buffer.dispose(); for (const job of jobs) job.resolve(null); await tick(); });
  return { buffer, jobs, notifications, advance: amount => { time += amount; },
    settle: async (job, value = ready('page')) => { job.resolve(value); await tick(); } };
}

test('tile prediction prioritizes exposed space, drag direction and latency while bounding lookahead', () => {
  assert.deepEqual(navigationTiles(0, 100), [1, -1]);
  assert.deepEqual(navigationTiles(-100, 100), [1, 2]);
  assert.deepEqual(navigationTiles(-25, 100, -.5, 250), [1, 2, 3, -1]);
  assert.deepEqual(navigationTiles(25, 100, .5, 250), [-1, -2, -3, 1]);
  assert.deepEqual(navigationTiles(0, 100, -.1, 150), [1, -1]);
  assert.deepEqual(navigationTiles(0, 100, -.1, 2000), [1, 2, 3, -1]);
  for (const offset of [-399, -100, -.01, 0, .01, 100, 399]) for (const velocity of [-10, 0, 10]) {
    const indexes = navigationTiles(offset, 100, velocity, 10000);
    assert.equal(new Set(indexes).size, indexes.length); assert.ok(indexes.length <= 6);
    assert.ok(indexes.every(index => Number.isInteger(index) && index !== 0));
  }
  for (const values of [[NaN, 100], [0, 0], [0, -1], [0, 100, Infinity], [0, 100, 0, NaN]]) assert.throws(() => navigationTiles(...values), RangeError);
});

test('suspending background preparation retains ready geometry and resumes without stale publication', async t => {
  const h = harness(t), owner = context();
  h.buffer.request(owner); await tick(); await h.settle(h.jobs[0]);
  const before = h.buffer.entries(); assert.equal(h.jobs.length, 2);
  h.buffer.suspend(); assert.equal(h.jobs[1].signal.aborted, true);
  await h.settle(h.jobs[1], ready('obsolete')); await h.buffer.idle;
  assert.deepEqual(h.buffer.entries(), before);
  assert.equal(h.buffer.coverage(-25, 100).every(span => span.status === 'ready'), true);
  h.buffer.request(owner); await tick(); assert.equal(h.jobs.length, 3);
  await h.settle(h.jobs[2]); assert.equal(h.buffer.entries().length, 2);
});

test('requests deduplicate and prepare only one page at a time, then reuse render-ready pages', async t => {
  const h = harness(t), owner = context();
  h.buffer.request(owner); h.buffer.request(owner); await tick();
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].index, 1); assert.equal(h.buffer.metrics.activeRequests, 1);
  await h.settle(h.jobs[0]); assert.equal(h.jobs.length, 2); assert.equal(h.jobs[1].index, -1);
  await h.settle(h.jobs[1]); await h.buffer.idle;
  assert.equal(h.buffer.metrics.activeRequests, 0); assert.equal(h.buffer.entries().length, 2);
  h.buffer.request(owner); await tick();
  assert.equal(h.jobs.length, 2); assert.equal(h.buffer.metrics.hits, 2);
});

test('coverage distinguishes frozen base, unknown, loading and prepared spans with exact bounds', async t => {
  const h = harness(t), owner = context();
  assert.deepEqual(h.buffer.coverage(-25, 100).map(({ index, left, width, status }) => ({ index, left, width, status })), [
    { index: 0, left: 0, width: 75, status: 'ready' }, { index: 1, left: 75, width: 25, status: 'not-loaded' },
  ]);
  h.buffer.request(owner, -25); await tick();
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'loading');
  await h.settle(h.jobs[0]);
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'ready');
  assert.equal(h.buffer.entries()[0].queryKey, 'query');
});

test('preparation failure remains explicit and does not retry before the bounded backoff', async t => {
  const h = harness(t), owner = context();
  h.buffer.request(owner, 25); await tick();
  h.jobs[0].reject(new Error('Source temporarily unavailable')); await tick();
  const failed = h.buffer.coverage(25, 100).find(span => span.index === -1);
  assert.equal(failed.status, 'error'); assert.equal(failed.reason, 'Source temporarily unavailable');
  while (h.buffer.metrics.activeRequests) await h.settle(h.jobs.at(-1));
  const count = h.jobs.length;
  h.advance(1999); h.buffer.request(owner, 25); await tick(); assert.equal(h.jobs.length, count);
  h.advance(1); h.buffer.request(owner, 25); await tick(); assert.equal(h.jobs.length, count + 1);
  assert.equal(h.jobs.at(-1).index, -1);
});

test('context reset discards a late old result and starts the requested new context after old admission releases', async t => {
  const h = harness(t), oldOwner = context('old'), newOwner = context('new');
  h.buffer.request(oldOwner, -25); await tick(); const old = h.jobs[0];
  h.buffer.request(newOwner, -25); await tick();
  assert.equal(old.signal.aborted, true); assert.equal(h.jobs.length, 1);
  assert.deepEqual(h.buffer.entries(oldOwner), []);
  await h.settle(old, ready('obsolete'));
  assert.equal(h.jobs.length, 2); assert.equal(h.jobs[1].owner, newOwner);
  assert.deepEqual(h.buffer.entries(newOwner), []); assert.ok(!h.notifications.includes(oldOwner));
  await h.settle(h.jobs[1], ready('current'));
  assert.equal(h.buffer.entries(newOwner)[0].payload, 'current');
});

test('a reset does not label an old context request as loading in the new context', async t => {
  const h = harness(t);
  h.buffer.request(context('old'), -25); await tick(); h.buffer.reset(context('new'));
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'not-loaded');
});

test('direction reversal aborts irrelevant preparation and prioritizes the newly visible interval', async t => {
  const h = harness(t, { honorAbort: true }), owner = context();
  h.buffer.request(owner, -25, -2); await tick();
  assert.equal(h.jobs[0].index, 1);
  h.buffer.request(owner, 200, 2); await tick();
  assert.equal(h.jobs[0].signal.aborted, true);
  assert.equal(h.jobs[1].index, -2); assert.equal(h.buffer.metrics.activeRequests, 1);
  await h.settle(h.jobs[1]); assert.equal(h.buffer.coverage(200, 100)[0].status, 'ready');
});

test('cache entry and retained-byte budgets are hard bounds even when visible priorities compete', async t => {
  for (const options of [{ maxEntries: 1 }, { maxBytes: 200 }]) {
    const h = harness(t, options), owner = context();
    h.buffer.request(owner, -25); await tick();
    for (let n = 0; n < 4 && h.jobs[n]; n++) {
      await h.settle(h.jobs[n], ready('x'.repeat(40)));
      assert.ok(h.buffer.metrics.cachedPages <= (options.maxEntries ?? 6));
      assert.ok(h.buffer.metrics.bytes <= (options.maxBytes ?? 16 * 1024 * 1024));
      assert.ok(h.buffer.metrics.activeRequests <= 1);
    }
  }
});

test('bounded admission settles instead of endlessly refetching evicted wanted tiles', async t => {
  for (const options of [{ maxEntries: 1 }, { maxBytes: 300 }]) {
    const h = harness(t, options);
    h.buffer.request(context(), -25, -2); await tick();
    for (let count = 0; count < 12 && h.buffer.metrics.activeRequests; count++) await h.settle(h.jobs.at(-1), ready('x'.repeat(40)));
    assert.equal(h.buffer.metrics.activeRequests, 0, 'Every wanted tile must reach a retained or explicit unavailable state');
    assert.ok(h.jobs.length <= 6, 'One request per selected tile, without cache-eviction retry loops');
  }
});

test('buffer rejects invalid admission limits before any preparation starts', () => {
  for (const options of [{ maxEntries: 0 }, { maxEntries: 1.5 }, { maxBytes: -1 }, { maxBytes: Infinity }, { timeoutMs: 0 }]) {
    assert.throws(() => createNavigationBuffer({ prepare: async () => ready('page'), ...options }), RangeError);
  }
});

test('oversized preparation is reported as unavailable rather than retained above budget', async t => {
  const h = harness(t, { maxBytes: 100 }), owner = context();
  h.buffer.request(owner, -25); await tick(); await h.settle(h.jobs[0], ready('x'.repeat(100)));
  assert.equal(h.buffer.metrics.bytes, 0);
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'error');
  assert.match(h.buffer.coverage(-25, 100)[1].reason, /memory limit/i);
});

test('timeout aborts preparation and leaves an explicit retryable error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { honorAbort: true, timeoutMs: 20 }), owner = context();
  h.buffer.request(owner, -25); await tick(); h.advance(20); t.mock.timers.tick(20); await tick();
  assert.equal(h.jobs[0].signal.aborted, true);
  const span = h.buffer.coverage(-25, 100)[1]; assert.equal(span.status, 'error'); assert.match(span.reason, /timed out/i);
});

test('an abort-ignoring response cannot turn a timed-out tile into ready or trigger immediate retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { timeoutMs: 20, maxEntries: 1 }), owner = context();
  h.buffer.request(owner, -25); await tick(); h.advance(20); t.mock.timers.tick(20); await tick();
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'error');
  await h.settle(h.jobs[0], ready('late'));
  assert.equal(h.buffer.coverage(-25, 100)[1].status, 'error');
  assert.equal(h.jobs.length, 1); assert.equal(h.buffer.metrics.activeRequests, 0);
});

test('latency observations and frame counters are bounded preparation diagnostics, not fabricated rendering percentiles', async t => {
  const h = harness(t), owner = context();
  h.buffer.request(owner); await tick(); h.advance(20); await h.settle(h.jobs[0]);
  h.advance(100); await h.settle(h.jobs[1]);
  assert.equal(h.buffer.metrics.estimatedPreparationMs, 100);
  h.buffer.observeFrame(false); h.buffer.observeFrame(true); h.buffer.observeFrame(false);
  assert.equal(h.buffer.metrics.frames, 3); assert.equal(h.buffer.metrics.lateFrames, 1);
});

test('dispose suppresses late publication and never schedules replacement work', async t => {
  const h = harness(t), owner = context();
  h.buffer.request(owner); await tick(); h.buffer.dispose(); await h.settle(h.jobs[0]);
  h.buffer.request(owner); await tick();
  assert.equal(h.jobs.length, 1); assert.deepEqual(h.buffer.entries(), []); assert.deepEqual(h.notifications, []);
  assert.equal(h.buffer.metrics.activeRequests, 0);
});
