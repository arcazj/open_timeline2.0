import test from 'node:test';
import assert from 'node:assert/strict';
import { createChangeMonitor } from '../../client/src/ui/change-monitor.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(overrides = {}) {
  let listener, stopped = 0, blocked = false, reloads = 0, latest = 1;
  const notices = [], calls = [], source = { subscribeChanges(callback) { listener = callback; return () => { stopped++; }; } };
  const host = { render: state => notices.push(state), blocked: () => blocked,
    reload: async () => { reloads++; return { generation: 'one', revision: latest }; },
    authorizationLost: event => calls.push(event.type), refreshRequired: event => calls.push(event.type), unavailable: event => calls.push(event.type), ...overrides };
  const monitor = createChangeMonitor(host, { delay: 5 }); monitor.start(source, { generation: 'one', revision: 1 });
  return { monitor, source, notices, calls, emit: event => listener(event), change(revision, changes = []) { latest = revision; listener({ type: 'changed', generation: 'one', throughRevision: revision, changes }); }, block(value) { blocked = value; }, get reloads() { return reloads; }, get stopped() { return stopped; } };
}
test('Pinned keeps the committed baseline immutable, including empty high-water advances', async () => {
  const f = fixture(); f.change(8); await pause(25);
  assert.equal(f.reloads, 0); assert.equal(f.monitor.state.baseline, 1); assert.equal(f.monitor.state.latest, 8); assert.equal(f.monitor.state.pending, true);
  assert.equal(await f.monitor.reload(), true); assert.equal(f.reloads, 1); assert.equal(f.monitor.state.baseline, 8); assert.equal(f.monitor.state.pending, false); f.monitor.dispose();
});
test('Live coalesces rapid commits and defers while gestures, drafts or query work block refresh', async () => {
  const f = fixture(); f.block(true); f.monitor.setMode('live'); for (let revision = 2; revision <= 20; revision++) f.change(revision);
  await pause(25); assert.equal(f.reloads, 0); f.block(false); await pause(25);
  assert.equal(f.reloads, 1); assert.equal(f.monitor.state.baseline, 20); f.monitor.dispose();
});
test('only one Live refresh is in flight and later revisions get a second coherent read', async () => {
  let complete, active = 0, maximum = 0, count = 0;
  const f = fixture({ reload: () => { count++; active++; maximum = Math.max(maximum, active); return new Promise(resolve => { complete = revision => { active--; resolve({ generation: 'one', revision }); }; }); } });
  f.monitor.setMode('live'); f.change(2); await pause(15); f.change(3); f.change(9); await pause(15); assert.equal(count, 1);
  complete(2); await pause(15); assert.equal(count, 2); complete(9); await pause(15);
  assert.equal(maximum, 1); assert.equal(f.monitor.state.pending, false); f.monitor.dispose();
});
test('authorization and generation errors never auto-refresh, fallback or replay writes', async () => {
  for (const event of [{ type: 'authorization-lost' }, { type: 'generation-changed', code: 'generation_mismatch' }, { type: 'generation-changed', code: 'replay_gap' }]) {
    const f = fixture(); f.monitor.setMode('live'); f.change(2); f.emit(event); await pause(20);
    assert.equal(f.reloads, 0); assert.deepEqual(f.calls, [event.type]); assert.ok(f.monitor.state.required); f.monitor.dispose();
  }
});
test('old subscriptions and stale refresh completions cannot change a replacement source', async () => {
  let complete;
  const f = fixture({ reload: () => new Promise(resolve => { complete = resolve; }) });
  f.monitor.setMode('live'); f.change(2); await pause(15);
  const oldListener = f.emit; f.monitor.start({ subscribeChanges: () => () => {} }, { generation: 'two', revision: 50 });
  oldListener({ type: 'changed', generation: 'one', throughRevision: 500 }); complete({ generation: 'one', revision: 2 }); await pause(15);
  assert.equal(f.monitor.state.generation, 'two'); assert.equal(f.monitor.state.baseline, 50); assert.equal(f.monitor.state.inFlight, false); assert.equal(f.stopped, 1); f.monitor.dispose();
});
test('failed reads cannot spin an automatic retry loop, while successful query adoption acknowledges notices', async () => {
  let count = 0; const f = fixture({ reload: async () => { count++; return null; } });
  f.monitor.setMode('live'); f.change(3); await pause(30); assert.equal(count, 1); assert.equal(f.monitor.state.required, 'refresh-required');
  f.monitor.acknowledge({ generation: 'one', revision: 3 }); assert.equal(f.monitor.state.pending, false); f.monitor.stop(); assert.equal(f.monitor.state.active, false); f.monitor.dispose();
});
test('an authorization or generation boundary takes precedence over a read already in flight', async () => {
  for (const event of [{ type: 'authorization-lost' }, { type: 'generation-changed', code: 'generation_mismatch' }, { type: 'generation-changed', code: 'replay_gap' }]) {
    let complete; const f = fixture({ reload: () => new Promise(resolve => { complete = resolve; }) });
    f.monitor.setMode('live'); f.change(2); await pause(15); f.emit(event);
    const required = f.monitor.state.required; f.monitor.acknowledge({ generation: 'one', revision: 2 }); complete({ generation: 'one', revision: 2 }); await pause(15);
    assert.equal(f.monitor.state.required, required); assert.equal(f.monitor.state.baseline, 1); assert.equal(f.monitor.state.inFlight, false); assert.deepEqual(f.calls, [event.type]); f.monitor.dispose();
  }
});

test('explicit refreshes during layout work coalesce and run once when unblocked in Pinned mode', async () => {
  const f = fixture(); f.block(true);
  const first = f.monitor.reload(), second = f.monitor.reload();
  await pause(20); assert.equal(f.reloads, 0);
  f.block(false);
  const third = f.monitor.reload();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(f.reloads, 1); f.monitor.dispose();
});

test('queued explicit refreshes cannot cross source, authorization, generation or outage boundaries', async () => {
  for (const boundary of ['source', 'dispose', 'cancel', 'authorization-lost', 'generation-changed', 'server-unavailable']) {
    const f = fixture(); f.block(true); const pending = f.monitor.reload();
    if (boundary === 'source') f.monitor.start({ subscribeChanges: () => () => {} }, { generation: 'two', revision: 8 });
    else if (boundary === 'dispose') f.monitor.dispose();
    else if (boundary === 'cancel') f.monitor.cancelQueuedReload();
    else f.emit({ type: boundary, code: 'generation_mismatch' });
    assert.equal(await pending, false); f.block(false); await pause(20);
    assert.equal(f.reloads, 0); f.monitor.dispose();
  }
});

test('an explicit refresh requested during another read waits without concurrent or repeated reloads', async () => {
  const completions = [];
  const f = fixture({ reload: () => new Promise(resolve => completions.push(resolve)) });
  const first = f.monitor.reload(), second = f.monitor.reload(), third = f.monitor.reload();
  assert.equal(completions.length, 1);
  completions[0]({ generation: 'one', revision: 2 }); assert.equal(await first, true);
  await pause(20); assert.equal(completions.length, 2);
  completions[1]({ generation: 'one', revision: 3 });
  assert.deepEqual(await Promise.all([second, third]), [true, true]);
  await pause(20); assert.equal(completions.length, 2); f.monitor.dispose();
});
