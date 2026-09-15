import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationAdmission } from '../../client/src/data/preparation-admission.js';
import { ProviderError } from '../../client/src/data/data-provider.js';

const tick = () => Promise.resolve();
const isAbort = error => error.name === 'AbortError';

test('an admission is counted immediately and grants one owner until its release', async () => {
  const gate = createPreparationAdmission();
  assert.equal(gate.active, false); assert.equal(gate.pendingCount, 0);
  const first = gate.acquire();
  assert.equal(gate.active, true); assert.equal(gate.pendingCount, 1);
  const release = await first;
  release(); assert.equal(gate.active, false); assert.equal(gate.pendingCount, 0);
});

test('foreground ownership queues a rendered table before the next foreground query', async () => {
  const gate = createPreparationAdmission(), order = [];
  const releaseForeground = await gate.acquire(); order.push('foreground');
  const table = gate.acquire().then(release => { order.push('table'); return release; });
  const query = gate.acquire().then(release => { order.push('query'); return release; });
  assert.equal(gate.pendingCount, 3);
  await tick(); assert.deepEqual(order, ['foreground']);
  releaseForeground();
  const releaseTable = await table;
  assert.deepEqual(order, ['foreground', 'table']); assert.equal(gate.pendingCount, 2);
  await tick(); assert.deepEqual(order, ['foreground', 'table']);
  releaseTable(); const releaseQuery = await query;
  assert.deepEqual(order, ['foreground', 'table', 'query']); assert.equal(gate.pendingCount, 1);
  releaseQuery(); assert.equal(gate.pendingCount, 0);
});

test('canceling a middle queued waiter rejects promptly without breaking either neighbor', async () => {
  const gate = createPreparationAdmission(), controller = new AbortController(), order = [];
  const releaseOwner = await gate.acquire();
  const first = gate.acquire().then(release => { order.push('first'); return release; });
  const canceled = gate.acquire({ signal: controller.signal });
  const rejected = assert.rejects(canceled, isAbort);
  const last = gate.acquire().then(release => { order.push('last'); return release; });
  controller.abort(); await rejected;
  assert.equal(gate.pendingCount, 3); assert.equal(gate.active, true); assert.deepEqual(order, []);
  releaseOwner(); const releaseFirst = await first;
  assert.deepEqual(order, ['first']); releaseFirst();
  const releaseLast = await last; assert.deepEqual(order, ['first', 'last']); releaseLast();
  assert.equal(gate.pendingCount, 0);
});

test('canceling the queued head lets the next live waiter follow the active owner', async () => {
  const gate = createPreparationAdmission(), controller = new AbortController();
  const releaseOwner = await gate.acquire();
  const rejected = assert.rejects(gate.acquire({ signal: controller.signal }), isAbort);
  let nextGranted = false;
  const next = gate.acquire().then(release => { nextGranted = true; return release; });
  controller.abort(); await rejected;
  assert.equal(nextGranted, false); assert.equal(gate.pendingCount, 2);
  releaseOwner(); const releaseNext = await next; assert.equal(nextGranted, true);
  releaseNext(); assert.equal(gate.pendingCount, 0);
});

test('pre-aborted callers never take a slot even when admission is at capacity', async () => {
  const gate = createPreparationAdmission({ maxPending: 1 }), controller = new AbortController();
  controller.abort();
  await assert.rejects(gate.acquire({ signal: controller.signal }), isAbort);
  assert.equal(gate.pendingCount, 0);
  const release = await gate.acquire();
  await assert.rejects(gate.acquire({ signal: controller.signal }), isAbort);
  assert.equal(gate.pendingCount, 1); release();
});

test('canceling an active lease cannot admit another operation before its owner finally releases', async () => {
  const gate = createPreparationAdmission(), controller = new AbortController();
  const release = await gate.acquire({ signal: controller.signal });
  let granted = false;
  const next = gate.acquire().then(done => { granted = true; return done; });
  controller.abort(); await tick();
  assert.equal(granted, false); assert.equal(gate.active, true); assert.equal(gate.pendingCount, 2);
  release(); const releaseNext = await next;
  assert.equal(granted, true); releaseNext();
});

test('abort after synchronous grant but before await still leaves release responsibility with the owner', async () => {
  const gate = createPreparationAdmission(), controller = new AbortController();
  const acquired = gate.acquire({ signal: controller.signal }); controller.abort();
  assert.equal(gate.active, true); assert.equal(gate.pendingCount, 1);
  const release = await acquired;
  release(); assert.equal(gate.pendingCount, 0);
});

test('capacity includes active and queued work and a canceled waiter frees only its own slot', async () => {
  const gate = createPreparationAdmission({ maxPending: 2 }), controller = new AbortController();
  const releaseOwner = await gate.acquire();
  const rejected = assert.rejects(gate.acquire({ signal: controller.signal }), isAbort);
  await assert.rejects(gate.acquire(), error => error instanceof ProviderError && error.code === 'preparation_capacity' && error.status === 429);
  assert.equal(gate.pendingCount, 2);
  controller.abort(); await rejected;
  assert.equal(gate.pendingCount, 1);
  const next = gate.acquire(); assert.equal(gate.pendingCount, 2);
  releaseOwner(); const releaseNext = await next; releaseNext();
  assert.equal(gate.pendingCount, 0);
});

test('an idempotent old release cannot release the next owner', async () => {
  const gate = createPreparationAdmission();
  const releaseFirst = await gate.acquire(), next = gate.acquire();
  releaseFirst(); const releaseNext = await next;
  const last = gate.acquire();
  releaseFirst(); releaseFirst();
  assert.equal(gate.active, true); assert.equal(gate.pendingCount, 2);
  releaseNext(); const releaseLast = await last;
  releaseNext(); assert.equal(gate.active, true); assert.equal(gate.pendingCount, 1);
  releaseLast(); releaseLast(); assert.equal(gate.pendingCount, 0);
});

test('an operation error releases admission through finally and leaves the FIFO usable', async () => {
  const gate = createPreparationAdmission(), order = [];
  const failure = (async () => {
    const release = await gate.acquire();
    try { order.push('failure'); throw new Error('Controlled preparation failure'); }
    finally { release(); }
  })();
  const rejected = assert.rejects(failure, /Controlled preparation failure/);
  const successor = gate.acquire().then(release => { order.push('success'); release(); });
  await Promise.all([rejected, successor]);
  assert.deepEqual(order, ['failure', 'success']); assert.equal(gate.pendingCount, 0);
});

test('queued acquisitions remain FIFO across asynchronous owner completions', async () => {
  const gate = createPreparationAdmission(), order = [];
  let concurrent = 0, maximum = 0;
  const work = Array.from({ length: 64 }, (_, index) => (async () => {
    const release = await gate.acquire();
    try {
      concurrent++; maximum = Math.max(maximum, concurrent); order.push(index);
      await tick(); await tick();
    } finally { concurrent--; release(); }
  })());
  assert.equal(gate.pendingCount, 64);
  await Promise.all(work);
  assert.deepEqual(order, Array.from({ length: 64 }, (_, index) => index));
  assert.equal(maximum, 1); assert.equal(gate.pendingCount, 0); assert.equal(gate.active, false);
});

test('abort listeners are removed on both queued cancellation and successful grant', async () => {
  const gate = createPreparationAdmission(), controller = new AbortController(), signal = controller.signal;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal), listeners = new Set();
  signal.addEventListener = (name, listener, options) => { listeners.add(listener); add(name, listener, options); };
  signal.removeEventListener = (name, listener) => { listeners.delete(listener); remove(name, listener); };
  const releaseOwner = await gate.acquire();
  const next = gate.acquire({ signal }); assert.equal(listeners.size, 1);
  releaseOwner(); const releaseNext = await next; assert.equal(listeners.size, 0); releaseNext();
  const releaseOther = await gate.acquire();
  const rejected = assert.rejects(gate.acquire({ signal }), isAbort);
  controller.abort(); await rejected; assert.equal(listeners.size, 0); releaseOther();
});

test('invalid limits are rejected before a queue can be created', () => {
  for (const maxPending of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '64', null]) {
    assert.throws(() => createPreparationAdmission({ maxPending }), RangeError);
  }
});
