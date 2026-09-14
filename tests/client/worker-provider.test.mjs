import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { WorkerLocalProvider, createLocalProvider } from '../../client/src/data/worker-provider.js';

const raw = await readFile(new URL('../../data/default-dataset.json', import.meta.url), 'utf8');
const snapshot = JSON.parse(raw);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class LoopbackWorker {
  constructor() {
    this.listeners = new Map(); this.sent = []; this.held = []; this.hold = new Set();
    queueMicrotask(() => this.emit('message', { data: { type: 'ready' } }));
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  emit(type, event) { this.listeners.get(type)?.(event); }
  postMessage(message) {
    this.sent.push(structuredClone(message));
    if (message.type !== 'request') return;
    queueMicrotask(async () => {
      let result, error;
      try {
        if (message.method === 'initialize') { this.core = new LocalProvider(message.args[0]); result = await this.core.initialize(); }
        else result = await this.core[message.method](...message.args, message.options);
      } catch (caught) { error = { name: caught.name, code: caught.code, message: caught.message, status: caught.status }; }
      const response = { type: 'response', id: message.id, result, error, metadata: this.core && { identity: this.core.identity, generation: this.core.generation, revision: this.core.revision } };
      if (this.hold.has(message.method)) this.held.push(response);
      else this.emit('message', { data: response });
    });
  }
  flush() { for (const data of this.held.splice(0)) this.emit('message', { data }); }
  terminate() { this.terminated = true; }
}

function fixture(input = raw) {
  let worker;
  const provider = new WorkerLocalProvider(input, { workerSource: '// fixture', workerFactory: () => (worker = new LoopbackWorker()) });
  return { provider, worker: () => worker };
}

test('worker wrapper uses the same complete source core, metadata, models, CRUD and export', async () => {
  const { provider, worker } = fixture();
  try {
    const status = await provider.initialize();
    assert.equal(status.execution.mode, 'worker'); assert.equal(status.recordCount, 48);
    assert.equal(provider.identity, status.identity);
    const models = await provider.listModels();
    assert.equal(models.items.length, snapshot.models.length);
    assert.equal((await provider.getModel(models.items[0].id)).model.id, models.items[0].id);
    const changed = await provider.executeCommand({ generation: status.generation, type: 'create', clientCommandId: 'worker-record', payload: { title: 'Worker record' } });
    assert.equal((await provider.getRecord(changed.record.id)).title, 'Worker record');
    assert.equal((await provider.getCommandOutcome('worker-record')).result.record.id, changed.record.id);
    assert.equal((await provider.initialize()).revision, 2);
    const createdModel = await provider.executeModelCommand({ generation: status.generation, type: 'create', clientCommandId: 'worker-model', payload: { name: 'Worker model', definition: models.items[0].versions[0].definition } });
    assert.equal((await provider.getModel(createdModel.model.id)).model.name, 'Worker model');
    assert.equal((await provider.validateModel(models.items[0].versions[0].definition)).valid, true);
    const exported = await provider.exportSnapshot();
    assert.equal(exported.records.length, 49); assert.equal(exported.models.length, models.items.length + 1);
    assert.equal(exported.manifest.revision, 3);
    assert.equal(typeof worker().sent.find(message => message.method === 'initialize').args[0], 'string');
  } finally { provider.dispose(); }
});

test('worker boundary freezes queued command intent and caller signal options before awaiting initialization', async () => {
  const { provider, worker } = fixture();
  try {
    const status = await provider.initialize();
    const command = { type: 'create', generation: status.generation, clientCommandId: 'captured', payload: { title: 'Original', tags: ['one'] } };
    const options = { signal: new AbortController().signal };
    const result = provider.executeCommand(command, options);
    command.payload.title = 'Changed'; command.payload.tags.push('two'); command.clientCommandId = 'other';
    options.signal = AbortSignal.abort();
    assert.equal((await result).record.title, 'Original');
    assert.deepEqual((await provider.getCommandOutcome('captured')).result.record.tags, ['one']);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.executeCommand({ type: 'create', generation: status.generation, clientCommandId: 'aborted', payload: { title: 'Never sent' } }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(worker().sent.some(message => message.args?.[0]?.clientCommandId === 'aborted'), false);
  } finally { provider.dispose(); }
});

test('public reinitialization returns fresh record/model/settings metadata in worker, direct and startup-fallback modes', async () => {
  for (const mode of ['worker', 'direct', 'startup-fallback']) {
    const setup = mode === 'worker' ? fixture() : {
      provider: mode === 'direct' ? createLocalProvider(raw, { preferWorker: false }) : new WorkerLocalProvider(raw, { workerSource: 'fixture', workerFactory: () => { throw new Error('Policy blocked'); } }),
      worker: () => null,
    };
    const { provider, worker } = setup;
    try {
      const initial = await provider.initialize(), generation = initial.generation;
      const record = await provider.executeCommand({ generation, type: 'create', clientCommandId: 'fresh-record', payload: { title: 'Retained branch change' } });
      const definition = { ...initial.models[0].versions[0].definition, theme: 'dark', rowHeight: 44, groupBy: 'kind' };
      const created = await provider.executeModelCommand({ generation, type: 'create', clientCommandId: 'fresh-model', payload: { name: 'Retained branch model', definition } });
      const published = await provider.executeModelCommand({ generation, type: 'publish', clientCommandId: 'fresh-publish', modelId: created.model.id, expectedRevision: created.model.revision });
      const applied = await provider.executeModelCommand({ generation, type: 'apply', clientCommandId: 'fresh-apply', modelId: created.model.id, expectedRevision: published.model.revision, payload: { version: 1 } });
      await provider.getRecord(record.record.id);
      await provider.listModels();
      if (worker()) {
        assert.equal(worker().sent.filter(message => message.method === 'initialize').length, 1);
        assert.equal(worker().sent.filter(message => message.method === 'getStatus').length, 0, 'ordinary methods only await setup, without metadata RPCs');
      }
      const refreshed = await provider.initialize();
      assert.equal(refreshed.recordCount, initial.recordCount + 1, mode);
      assert.equal(refreshed.revision, applied.revision, mode);
      assert.equal(refreshed.modified, true, mode);
      assert.equal(refreshed.models.length, initial.models.length + 1, mode);
      assert.deepEqual(refreshed.models.find(model => model.id === created.model.id), applied.model, mode);
      assert.deepEqual(refreshed.settings, { mode: 'timeline', collapsedGroups: [], search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title', '/data/description', '/data/text', '/data/system', '/data/type', '/data/status'] }, ...applied.settings }, mode);
      assert.equal(refreshed.settings.modelId, created.model.id, mode);
      assert.equal(refreshed.settings.modelVersion, 1, mode);
      assert.equal(refreshed.settings.theme, 'dark', mode);
      assert.equal(refreshed.settings.rowHeight, 44, mode);
      assert.equal(refreshed.settings.groupBy, 'kind', mode);
      assert.equal(refreshed.identity, initial.identity, mode);
      assert.equal(refreshed.generation, generation, mode);
      if (worker()) assert.equal(worker().sent.filter(message => message.method === 'getStatus').length, 1, 'public initialize explicitly refreshes metadata');
    } finally { provider.dispose(); }
  }
});

test('a timed-out dispatched write stays unknown, original outcome remains queryable and is never replayed', async () => {
  const { provider, worker } = fixture();
  try {
    const status = await provider.initialize();
    worker().hold.add('executeCommand');
    await assert.rejects(provider.executeCommand({ type: 'create', generation: status.generation, clientCommandId: 'uncertain', payload: { title: 'Exactly once' } }, { timeout: 10 }), { code: 'write_outcome_unknown' });
    assert.equal((await provider.getCommandOutcome('uncertain')).state, 'committed');
    worker().flush();
    assert.equal((await provider.getStatus()).recordCount, 49);
    assert.equal(worker().sent.filter(message => message.method === 'executeCommand').length, 1);
  } finally { provider.dispose(); }
});

test('late successful aborted query allocation is released instead of leaking query capacity', async () => {
  const { provider, worker } = fixture();
  try {
    await provider.initialize();
    worker().hold.add('createQuery');
    const controller = new AbortController();
    const operation = provider.createQuery({ domain: snapshot.settings.overview }, { signal: controller.signal });
    const rejection = assert.rejects(operation, { name: 'AbortError' });
    await tick(); controller.abort(); await rejection;
    assert.equal(worker().core.queries.size, 1);
    worker().flush(); await tick();
    assert.equal(worker().core.queries.size, 0);
    assert.equal(worker().sent.filter(message => message.method === 'releaseQuery').length, 1);
  } finally { provider.dispose(); }
});

test('only worker startup failures fall back; runtime failure and disposal never reopen old data', async () => {
  const fallback = new WorkerLocalProvider(raw, { workerSource: 'fixture', workerFactory: () => { throw new Error('Blocked'); } });
  try {
    assert.equal((await fallback.initialize()).execution.fallbackReason, 'startup-failed');
    assert.equal(fallback.executionMode, 'direct');
  } finally { fallback.dispose(); }
  const { provider, worker } = fixture();
  await provider.initialize();
  worker().emit('error', { preventDefault() {} });
  await assert.rejects(provider.getStatus(), { code: 'local_worker_lost' });
  assert.equal(provider.direct, undefined);
  provider.dispose();
  await assert.rejects(provider.getStatus(), { code: 'provider_disposed' });
  const direct = createLocalProvider(raw, { preferWorker: false });
  try { assert.equal((await direct.initialize()).execution.mode, 'direct'); } finally { direct.dispose(); }
});

test('strict JSON rejection from a running worker is not retried in direct mode', async () => {
  const { provider, worker } = fixture('{"formatVersion":1,"formatVersion":1}');
  try {
    await assert.rejects(provider.initialize(), { code: 'duplicate_property' });
    assert.equal(provider.direct, undefined);
    assert.equal(worker().sent.filter(message => message.method === 'initialize').length, 1);
  } finally { provider.dispose(); }
});

test('source disposal rejects pending reads and makes dispatched mutations uncertain without fallback', async () => {
  const { provider, worker } = fixture();
  const status = await provider.initialize();
  worker().hold.add('getStatus'); worker().hold.add('executeModelCommand');
  const read = provider.getStatus();
  const write = provider.executeModelCommand({ type: 'create', generation: status.generation, clientCommandId: 'dispose-model', payload: { name: 'Uncertain model', definition: status.models[0].versions[0].definition } });
  const readRejected = assert.rejects(read, { name: 'AbortError' });
  const writeRejected = assert.rejects(write, { code: 'write_outcome_unknown' });
  await tick(); provider.dispose();
  await readRejected; await writeRejected;
  assert.equal(worker().terminated, true);
  assert.equal(provider.pending.size, 0); assert.equal(provider.direct, undefined);
});

test('aborted pending work consumes a bounded slot until its worker response is accounted for', async () => {
  const { provider, worker } = fixture();
  try {
    await provider.initialize(); worker().hold.add('getStatus');
    const controller = new AbortController();
    const pending = Array.from({ length: 64 }, () => assert.rejects(provider.getStatus({ signal: controller.signal }), { name: 'AbortError' }));
    await tick();
    assert.equal(provider.pending.size, 64);
    await assert.rejects(provider.getStatus(), { code: 'worker_capacity' });
    controller.abort(); await Promise.all(pending);
    assert.equal(provider.pending.size, 64);
    worker().hold.clear(); worker().flush(); await tick();
    assert.equal(provider.pending.size, 0);
    assert.equal((await provider.getStatus()).recordCount, 48);
  } finally { provider.dispose(); }
});
