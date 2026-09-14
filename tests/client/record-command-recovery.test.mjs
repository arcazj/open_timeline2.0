import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRecordCommandRecovery, RECORD_RECOVERY_KEY } from '../../client/src/data/record-command-recovery.js';

function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const options = { provider: { baseUrl: `https://${randomUUID()}.example.test/service/`, workspaceId: 'default', identity: randomUUID(), token: 'private-bearer-token' }, generation: randomUUID(), local: false, environment: { localStorage: storage, location: { protocol: 'https:', origin: 'https://client.example.test' } } };
  return { values, storage, options, create: changes => createRecordCommandRecovery({ ...options, ...changes }) };
}
const command = (generation, type = 'create') => ({ generation, type, clientCommandId: randomUUID(), ...(type === 'create' ? {} : { recordId: randomUUID(), expectedVersion: 4 }), payload: { title: 'Private title', notes: 'Private notes', token: 'must-not-be-stored' } });

test('record recovery persists only the safe identity for every record operation', () => {
  const { create, options, values } = fixture(), recovery = create();
  for (const type of ['create', 'update', 'delete', 'restore']) recovery.remember(command(options.generation, type));
  const raw = values.get(RECORD_RECOVERY_KEY), entries = JSON.parse(raw);
  assert.equal(entries.length, 4);
  for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ['baseUrl', 'workspaceId', 'generation', 'clientCommandId', 'type', ...(entry.type === 'create' ? [] : ['recordId'])].sort());
  for (const secret of ['Private', 'payload', 'token', 'expectedVersion', 'must-not']) assert.ok(!raw.includes(secret));
  assert.deepEqual(create().read(), entries);
  for (const entry of entries) recovery.clear(entry.clientCommandId);
  assert.deepEqual(create().read(), []); assert.equal(values.has(RECORD_RECOVERY_KEY), false);
});

test('record identities and confirmed tombstones are isolated by endpoint, workspace, generation and Local branch', () => {
  const { create, options } = fixture(), original = create(), operation = command(options.generation);
  original.remember(operation);
  assert.deepEqual(create({ generation: randomUUID() }).read(), []);
  assert.deepEqual(create({ provider: { ...options.provider, workspaceId: 'other' } }).read(), []);
  assert.deepEqual(create({ provider: { ...options.provider, baseUrl: 'https://other.example.test' } }).read(), []);
  const local = create({ local: true }); local.remember(operation); local.clear(operation.clientCommandId);
  assert.equal(original.read().length, 1);
  const generation = randomUUID(), other = create({ generation }); other.remember({ ...operation, generation });
  original.clear(operation.clientCommandId); assert.equal(other.read().length, 1);
});

test('storage denial warns and retains the identity only in the same memory source', () => {
  const { create, options } = fixture();
  const environment = { location: options.environment.location, get localStorage() { throw new DOMException('Denied', 'SecurityError'); } };
  const recovery = create({ environment }); recovery.remember(command(options.generation));
  assert.match(recovery.warning(), /memory-only/);
  assert.equal(create({ environment }).read().length, 1);
  assert.deepEqual(create({ environment, generation: randomUUID() }).read(), []);
});

test('file URL storage explicitly warns about browser-dependent retention', () => {
  const { create, options } = fixture();
  const recovery = create({ environment: { ...options.environment, location: { protocol: 'file:', origin: 'null' } } });
  assert.match(recovery.warning(), /file URLs is browser-dependent/);
  recovery.remember(command(options.generation)); assert.equal(recovery.read().length, 1);
});

test('unsafe stored fields are rejected and a wrong-generation command is never remembered', () => {
  const { create, options, values } = fixture();
  const recovery = create();
  assert.throws(() => recovery.remember(command(randomUUID())), /No command was sent/);
  values.set(RECORD_RECOVERY_KEY, JSON.stringify([{ ...command(options.generation), baseUrl: options.provider.baseUrl, workspaceId: 'default' }]));
  assert.deepEqual(recovery.read(), []); assert.match(recovery.warning(), /storage is unavailable/);
  const invalid = create({ provider: { ...options.provider, baseUrl: 'https://user:private@example.test/' } });
  invalid.remember(command(options.generation));
  assert.match(invalid.warning(), /memory-only/);
  assert.ok(!JSON.stringify(invalid.read()).includes('private'));
});
