import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';

const bundle = JSON.parse(await readFile(new URL('../../data/default-dataset.json', import.meta.url)));
const op = (record, type, payload) => ({ type, recordId: record.id, expectedVersion: record.version, ...(payload === undefined ? {} : { payload }) });

test('Local atomic mixed batch captures intent, increments once and replays without duplicates', async () => {
  const provider = new LocalProvider(bundle); await provider.initialize();
  const [first, second] = bundle.records;
  const command = { generation: provider.generation, clientCommandId: crypto.randomUUID(), operations: [op(first, 'update', { title: 'First edit' }), op(second, 'patch', [{ op: 'replace', path: '/title', value: 'Second edit' }]), { type: 'create', payload: { title: 'New batch record' } }] };
  const original = structuredClone(command), promise = provider.executeBatch(command);
  command.operations[0].payload.title = 'Caller changed after dispatch';
  const result = await promise;
  assert.equal(result.revision, 2); assert.equal(result.affectedCount, 3); assert.equal(result.items[0].record.title, 'First edit');
  assert.equal((await provider.getStatus()).recordCount, 49);
  assert.deepEqual(await provider.executeBatch(original), result);
  assert.deepEqual((await provider.getCommandOutcome(original.clientCommandId)).result, result);
  assert.equal((await provider.exportSnapshot()).records.length, 49);
  provider.dispose();
});

test('Local batch failure is atomic and cascade requires every active descendant', async () => {
  const provider = new LocalProvider(bundle); await provider.initialize();
  const command = operations => ({ generation: provider.generation, clientCommandId: crypto.randomUUID(), operations });
  const [first, second] = bundle.records;
  const before = await provider.getRecord(first.id);
  await assert.rejects(provider.executeBatch(command([op(first, 'update', { title: 'Must not persist' }), { ...op(second, 'delete'), expectedVersion: 999 }])), error => error.status === 412 && error.errors[0].index === 1);
  assert.deepEqual(await provider.getRecord(first.id), before); assert.equal(provider.revision, 1);
  const parent = (await provider.executeBatch(command([{ type: 'create', payload: { kind: 'session', title: 'Parent' } }]))).items[0].record;
  const child = (await provider.executeBatch(command([{ type: 'create', payload: { title: 'Child', parentSessionId: parent.id } }]))).items[0].record;
  await assert.rejects(provider.executeBatch(command([op(parent, 'delete')])), error => error.code === 'invalid_parent');
  const deleted = await provider.executeBatch(command([op(parent, 'delete'), op(child, 'delete')]));
  assert.ok(deleted.items.every(item => item.record.deletedAt));
  const restored = await provider.executeBatch(command(deleted.items.toReversed().map(item => op(item.record, 'restore'))));
  assert.ok(restored.items.every(item => item.record.deletedAt === null));
  await assert.rejects(provider.executeBatch(command(Array.from({ length: 501 }, () => ({ type: 'create', payload: { title: 'Too many' } })))), error => error.status === 413);
  provider.dispose();
});
