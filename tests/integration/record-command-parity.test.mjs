import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { MUTABLE_RECORD_FIELDS } from '../../client/src/data/record-commands.js';

let server, remote, local, first, second;
const mutable = record => Object.fromEntries(MUTABLE_RECORD_FIELDS.map(key => [key, record[key]]));
const command = (provider, operations, clientCommandId = crypto.randomUUID()) => ({ generation: provider.metadata?.generation ?? provider.generation, clientCommandId, operations });

before(async () => {
  server = await startServer(); remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  const exported = await remote.exportSnapshot(); [first, second] = exported.records;
  local = new LocalProvider(exported); await local.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

test('real HTTP and Local apply identical JSON Patch array/null/escape operations and reject failed tests atomically', async () => {
  const payload = [{ op: 'replace', path: '/tags', value: ['a', 'b'] }, { op: 'add', path: '/tags/-', value: 'c' },
    { op: 'move', from: '/tags/0', path: '/tags/2' }, { op: 'add', path: '/extensions/a~1b', value: true },
    { op: 'copy', from: '/extensions/a~1b', path: '/extensions/copy' }, { op: 'replace', path: '/originalStart', value: null }];
  const values = [];
  for (const provider of [local, remote]) {
    const intent = { type: 'patch', recordId: first.id, expectedVersion: first.version, payload, generation: provider.metadata?.generation ?? provider.generation, clientCommandId: crypto.randomUUID() };
    const result = await provider.executeCommand(intent); values.push(result.record);
    assert.deepEqual(await provider.executeCommand(intent), result);
    const previous = await provider.getRecord(first.id);
    for (const [operations, status] of [
      [[{ op: 'replace', path: '/title', value: 'Must not commit' }, { op: 'test', path: '/extensions/copy', value: 1 }], 409],
      [[{ op: 'copy', from: '/createdBy', path: '/title' }], 422],
      [[{ op: 'remove', path: '/originalEnd' }], 422],
      [[{ op: 'add', path: '/extensions/__proto__/bad', value: true }], 422],
    ]) {
      await assert.rejects(provider.executeCommand({ ...intent, expectedVersion: previous.version, clientCommandId: crypto.randomUUID(), payload: operations }), error => error.status === status);
      assert.deepEqual(await provider.getRecord(first.id), previous);
    }
  }
  assert.deepEqual(mutable(values[0]), mutable(values[1])); first = values[0];
});

test('mixed record batches commit once, reject stale or duplicate members, and retain the exact Server result after restart', async () => {
  const operations = [{ type: 'update', recordId: first.id, expectedVersion: first.version, payload: { title: 'Atomic first' } },
    { type: 'replace', recordId: second.id, expectedVersion: second.version, payload: { ...mutable(second), title: 'Atomic second' } }];
  const results = [], intents = [];
  for (const provider of [local, remote]) {
    const intent = command(provider, operations); intents.push(intent);
    const before = (await provider.getStatus()).revision, result = await provider.executeBatch(intent); results.push(result);
    assert.equal(result.revision, before + 1); assert.equal(result.affectedCount, 2);
    assert.deepEqual(await provider.executeBatch(intent), result);
    await assert.rejects(provider.executeBatch(command(provider, operations)), error => error.status === 412);
    const updated = result.items[0].record;
    const repeated = { type: 'update', recordId: updated.id, expectedVersion: updated.version, payload: { title: 'Must not commit' } };
    await assert.rejects(provider.executeBatch(command(provider, [repeated, repeated])), error => error.code === 'duplicate_batch_record');
    assert.deepEqual(await provider.getRecord(updated.id), updated);
  }
  assert.deepEqual(results[0].items.map(item => mutable(item.record)), results[1].items.map(item => mutable(item.record)));
  await server.restart(); await remote.initialize();
  assert.deepEqual(await remote.executeBatch(intents[1]), results[1]);
  assert.deepEqual((await remote.getCommandOutcome(intents[1].clientCommandId)).result, results[1]);
});

test('body-free Server deletion resolves its original outcome and restores with the same Local record semantics', async () => {
  const records = [];
  for (const provider of [local, remote]) {
    const record = await provider.getRecord(second.id);
    const intent = { type: 'delete', recordId: record.id, expectedVersion: record.version, generation: provider.metadata?.generation ?? provider.generation, clientCommandId: crypto.randomUUID() };
    const deleted = await provider.executeCommand(intent);
    assert.ok(deleted.record.deletedAt);
    assert.deepEqual(await provider.executeCommand(intent), deleted);
    const restored = await provider.executeCommand({ ...intent, type: 'restore', expectedVersion: deleted.record.version, clientCommandId: crypto.randomUUID() });
    assert.equal(restored.record.deletedAt, null); records.push(restored.record);
  }
  assert.deepEqual(mutable(records[0]), mutable(records[1]));
});
