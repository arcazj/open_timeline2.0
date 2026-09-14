import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchRecord, recordReplacement, MUTABLE_RECORD_FIELDS } from '../../client/src/data/record-commands.js';
import { LocalProvider } from '../../client/src/data/local-provider.js';

const bundle = JSON.parse(await readFile(new URL('../../data/default-dataset.json', import.meta.url)));

test('JSON Patch array moves, copies, escapes and explicit null are atomic', () => {
  const record = structuredClone(bundle.records[0]);
  record.tags = ['a', 'b']; record.extensions = { flag: true, 'a/b': 'escaped' };
  const before = structuredClone(record);
  const result = patchRecord(record, [{ op: 'test', path: '/extensions/flag', value: true }, { op: 'add', path: '/tags/-', value: 'c' },
    { op: 'move', from: '/tags/0', path: '/tags/2' }, { op: 'copy', from: '/extensions/a~1b', path: '/extensions/copy' },
    { op: 'remove', path: '/extensions/flag' }, { op: 'replace', path: '/originalStart', value: null }]);
  assert.deepEqual(result.tags, ['b', 'c', 'a']);
  assert.deepEqual(result.extensions, { 'a/b': 'escaped', copy: 'escaped' });
  assert.deepEqual(record, before);
});

test('bounded patch policy rejects identity paths, prototype changes, missing fields and bool-number test confusion', () => {
  const record = structuredClone(bundle.records[0]); record.extensions = { flag: true };
  const cases = [
    [[{ op: 'replace', path: '/id', value: 'changed' }], 'immutable_field'],
    [[{ op: 'add', path: '/extensions/__proto__/bad', value: true }], 'immutable_field'],
    [[{ op: 'remove', path: '/originalStart' }], 'incomplete_replacement'],
    [[{ op: 'replace', path: '/extensions/missing', value: true }], 'invalid_patch'],
    [[{ op: 'test', path: '/extensions/flag', value: 1 }], 'patch_test_failed'],
    [[{ op: 'copy', from: '/createdBy', path: '/title' }], 'immutable_field'],
    [[{ op: 'test', path: '/title~2', value: 'bad' }], 'invalid_patch'], [[], 'invalid_patch'],
  ];
  for (const [operations, code] of cases) assert.throws(() => patchRecord(record, operations), error => error.code === code);
  assert.throws(() => recordReplacement({ title: 'partial' }), error => error.code === 'incomplete_replacement');
});

test('Local patch and complete replacement preserve versioned retry semantics', async () => {
  const provider = new LocalProvider(bundle); const metadata = await provider.initialize();
  const record = bundle.records[0];
  const command = { type: 'patch', recordId: record.id, generation: metadata.generation, expectedVersion: record.version,
    clientCommandId: crypto.randomUUID(), payload: [{ op: 'replace', path: '/title', value: 'Patched locally' }] };
  const result = await provider.executeCommand(command);
  assert.equal(result.record.title, 'Patched locally');
  assert.deepEqual(await provider.executeCommand(command), result);
  const payload = Object.fromEntries(MUTABLE_RECORD_FIELDS.map(key => [key, result.record[key]])); payload.tags = [];
  const replaced = await provider.executeCommand({ ...command, type: 'replace', expectedVersion: result.record.version, clientCommandId: crypto.randomUUID(), payload });
  assert.equal(replaced.record.version, record.version + 2);
  await provider.dispose();
});

test('Local malformed commands reject without changing data, revision or outcomes', async () => {
  const provider = new LocalProvider(bundle); const metadata = await provider.initialize();
  const record = bundle.records[0];
  const base = { type: 'update', recordId: record.id, generation: metadata.generation, expectedVersion: record.version,
    clientCommandId: crypto.randomUUID(), payload: { title: 'Should not be accepted' } };
  const cases = [
    [{ ...base, payload: {} }, 'invalid_patch'],
    [{ ...base, payload: null }, 'invalid_record'],
    [{ ...base, clientCommandId: '../escape' }, 'invalid_command_id'],
    [{ ...base, clientCommandId: 123 }, 'invalid_command_id'],
    [{ ...base, type: 'delete' }, 'invalid_record'],
  ];
  for (const [command, code] of cases) await assert.rejects(provider.executeCommand(command), error => error.code === code);
  await assert.rejects(provider.executeBatch({ generation: metadata.generation, clientCommandId: 'x'.repeat(129), operations: [] }), error => error.code === 'invalid_command_id');
  assert.deepEqual(await provider.getRecord(record.id), record);
  assert.equal((await provider.getStatus()).revision, metadata.revision);
  assert.equal(provider.outcomes.size, 0);
  await provider.dispose();
});
