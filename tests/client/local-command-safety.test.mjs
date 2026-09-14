import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LOCAL_LIMITS } from '../../client/src/data/snapshot.js';

async function local() { const provider = new LocalProvider(structuredClone(initial)); await provider.initialize(); return provider; }
function update(provider, record, payload) { return { type: 'update', generation: provider.generation, recordId: record.id, expectedVersion: record.version, payload, clientCommandId: crypto.randomUUID() }; }

test('Local records capture immediate and delayed queued command content before returning', async () => {
  const provider = await local();
  const first = await provider.getRecord(initial.records[0].id), second = await provider.getRecord(initial.records[1].id);
  const command = update(provider, first, { title: 'Captured immediately', tags: ['original'] });
  const pending = provider.executeCommand(command);
  command.payload.title = 'Mutated title'; command.payload.tags.push('mutated'); command.recordId = second.id; command.clientCommandId = 'mutated-key';
  const result = await pending;
  assert.equal(result.record.id, first.id); assert.equal(result.record.title, 'Captured immediately'); assert.deepEqual(result.record.tags, ['original']);
  let release; provider.queue = new Promise(resolve => { release = resolve; });
  const delayed = update(provider, result.record, { title: 'Captured while queued' });
  const snapshot = structuredClone(delayed), queued = provider.executeCommand(delayed);
  delayed.payload.title = 'Late edit'; delayed.recordId = second.id; delayed.expectedVersion = 999;
  release(); const saved = await queued;
  assert.equal(saved.record.title, 'Captured while queued'); assert.deepEqual((await provider.getCommandOutcome(snapshot.clientCommandId)).result, saved);
  assert.equal((await provider.getRecord(second.id)).title, second.title);
  provider.dispose();
});

test('queued record and model commands capture the original abort signal, not mutable options', async () => {
  const provider = await local(); const original = await provider.getRecord(initial.records[0].id);
  for (const modelCommand of [false, true]) {
    let release; provider.queue = new Promise(resolve => { release = resolve; });
    const controller = new AbortController(), options = { signal: controller.signal };
    const command = modelCommand ? { type: 'create', generation: provider.generation, clientCommandId: crypto.randomUUID(), payload: { name: 'Must not create', definition: {} } } : update(provider, original, { title: 'Must not save' });
    const pending = modelCommand ? provider.executeModelCommand(command, options) : provider.executeCommand(command, options);
    options.signal = new AbortController().signal; controller.abort(); release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await provider.getCommandOutcome(command.clientCommandId)).state, 'not-found');
  }
  assert.equal((await provider.getRecord(original.id)).title, original.title); assert.equal(provider.revision, 1); provider.dispose();
});

test('both providers require an explicit source generation before record dispatch', async () => {
  const provider = await local();
  await assert.rejects(provider.executeCommand({ type: 'create', clientCommandId: 'missing-generation', payload: {} }), { code: 'precondition_required', status: 428 });
  assert.equal(provider.revision, 1); provider.dispose();
  const remote = new ServerProvider(); remote.metadata = { generation: 'known' };
  let requests = 0; remote._request = async () => { requests++; };
  await assert.rejects(remote.executeCommand({ type: 'create', clientCommandId: 'missing-generation', payload: {} }), { code: 'precondition_required', status: 428 });
  assert.equal(requests, 0); remote.dispose();
});

test('workspace revision capacity preserves replay outcomes and blocks new record/model commits', async () => {
  const provider = await local(), original = await provider.getRecord(initial.records[0].id);
  const command = update(provider, original, { title: 'Last accepted before capacity test' });
  const result = await provider.executeCommand(command);
  provider.revision = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await provider.executeCommand(command), result);
  await assert.rejects(provider.executeCommand(update(provider, result.record, { title: 'Cannot commit' })), { code: 'revision_capacity', status: 413 });
  await assert.rejects(provider.executeModelCommand({ type: 'create', generation: provider.generation, clientCommandId: crypto.randomUUID(), payload: { name: 'Cannot create', definition: {} } }), { code: 'revision_capacity', status: 413 });
  assert.equal(provider.revision, Number.MAX_SAFE_INTEGER); assert.equal((await provider.getRecord(original.id)).title, result.record.title); provider.dispose();
});

test('restoring an active record rejects without consuming a version or command outcome', async () => {
  const provider = await local(), record = await provider.getRecord(initial.records[0].id);
  const command = { ...update(provider, record, {}), type: 'restore' };
  await assert.rejects(provider.executeCommand(command), { code: 'record_not_deleted', status: 409 });
  assert.deepEqual(await provider.getRecord(record.id), record); assert.equal(provider.revision, 1);
  assert.equal((await provider.getCommandOutcome(command.clientCommandId)).state, 'not-found'); provider.dispose();
});

test('full candidate bundle capacity is checked before a Local record commit', async () => {
  const input = structuredClone(initial);
  input.records = input.records.slice(0, 1); input.manifest.recordCount = 1; delete input.manifest.contentSha256;
  input.manifest.testPadding = 'x'.repeat(LOCAL_LIMITS.bundleBytes - Buffer.byteLength(JSON.stringify(input)) - 20000);
  const provider = new LocalProvider(input); await provider.initialize();
  const record = await provider.getRecord(input.records[0].id), command = update(provider, record, { data: { description: 'y'.repeat(30000) } });
  await assert.rejects(provider.executeCommand(command), { code: 'snapshot_size_limit', status: 413 });
  assert.equal(provider.revision, 1); assert.equal(provider.modified, false); assert.deepEqual(await provider.getRecord(record.id), record);
  assert.equal((await provider.getCommandOutcome(command.clientCommandId)).state, 'not-found'); provider.dispose();
});
