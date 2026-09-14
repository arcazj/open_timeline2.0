import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferedWindow, createWindowLoader, startupTarget } from '../../client/src/data/window-loading.js';

const range = { fromMs: String(Date.parse('2024-03-18T12:00:00Z')), toMs: String(Date.parse('2024-03-18T13:00:00Z')) };
test('window buffer stays small, favors travel direction, and clamps supported years', () => {
  assert.deepEqual(bufferedWindow(range), { from: '2024-03-18T11:45:00.000Z', to: '2024-03-18T13:15:00.000Z' });
  assert.equal(bufferedWindow(range, .25, 1, 3).to, '2024-03-18T13:30:00.000Z');
  assert.equal(bufferedWindow(range, .25, -1, 3).from, '2024-03-18T11:30:00.000Z');
  assert.equal(bufferedWindow({ fromMs: '-377705116800000', toMs: '-377705113200000' }).from, '-009999-01-01T00:00:00.000Z');
  assert.throws(() => bufferedWindow(range, 2));
});

test('prefetch is single-flight, replaces pending intent, and reuses bounded coverage', async () => {
  let callback, release, time = 0;
  const calls = [];
  const loader = createWindowLoader({ prefetchWindow(input, options) {
    calls.push({ input, options }); return new Promise(resolve => { release = () => resolve({ status: 'cached' }); });
  } }, { now: () => time, setTimer: fn => { callback = fn; return 1; }, clearTimer: () => { callback = null; } });
  loader.request(range, { sourceIds: ['a'] });
  const first = callback();
  loader.request(range, { sourceIds: ['a'] });
  assert.equal(calls.length, 1);
  release(); await first; await callback();
  assert.equal(calls.length, 1);
  time = 16000;
  loader.request(range, { sourceIds: ['b'] });
  const next = callback();
  assert.equal(calls.length, 2);
  loader.dispose();
  assert.equal(calls[1].options.signal.aborted, true);
  release(); await next;
});

test('file mode performs no HTTP discovery; configured failure never becomes demo mode', async () => {
  assert.equal((await startupTarget({ protocol: 'file:', fetcher: () => assert.fail('No request allowed') })).mode, 'standalone');
  assert.equal((await startupTarget({ protocol: 'http:', fetcher: async () => { throw new Error('offline'); } })).mode, 'unavailable');
  assert.equal((await startupTarget({ protocol: 'http:', fetcher: async () => ({ status: 404 }) })).mode, 'standalone');
  const target = { mode: 'configured-server', localBrowser: true, sourceName: 'REAL' };
  assert.deepEqual(await startupTarget({ protocol: 'http:', fetcher: async () => ({ ok: true, json: async () => target }) }), target);
});
