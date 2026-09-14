import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { validateSnapshot } from '../../client/src/data/snapshot.js';

async function reader() {
  const snapshot = structuredClone(initial);
  delete snapshot.manifest.contentSha256;
  snapshot.manifest.legacy = { readOnly: true, declaredRange: snapshot.settings.overview, status: 'current' };
  const provider = new LocalProvider(snapshot); await provider.initialize();
  return provider;
}

test('legacy Local metadata and catalogs expose read access without editing actions', async () => {
  const provider = await reader();
  const status = await provider.getStatus();
  assert.equal(status.legacy.readOnly, true); assert.equal(status.durability, 'read-only-snapshot');
  assert.deepEqual(status.actor.capabilities, ['records.read', 'configuration.read', 'export']);
  for (const key of ['recordCrud', 'modelManagement', 'modelPublication', 'configurationManagement']) assert.equal(status.capabilities[key], false);
  assert.equal(status.capabilities.importExport, true);
  const sources = await provider.listConfiguration('sources'); assert.ok(sources.items.length);
  for (const source of sources.items) {
    assert.deepEqual(source.allowedActions, []);
    assert.deepEqual((await provider.getConfiguration('sources', source.id)).allowedActions, []);
  }
  assert.ok((await provider.listModels()).items.length);
  assert.ok((await provider.getEffectiveSettings()).values.modelId);
  const query = await provider.createQuery({ domain: initial.settings.overview, scaleMode: 'uniform', bins: 16, ratio: 1 });
  assert.ok((await provider.getOverview(query.queryId)).items.length);
  assert.equal((await provider.getRecord(initial.records[0].id)).id, initial.records[0].id);
  status.legacy.readOnly = false;
  assert.equal((await provider.getStatus()).legacy.readOnly, true);
  provider.dispose();
});

test('every legacy record, batch, model, configuration and settings command rejects before mutation', async () => {
  const provider = await reader(), before = structuredClone(provider.snapshot), status = await provider.getStatus();
  let notices = 0; provider.subscribeChanges(() => { notices++; });
  const command = { generation: status.generation, clientCommandId: 'legacy-read-only-command', payload: {} };
  for (const type of ['create', 'update', 'patch', 'replace', 'delete', 'restore']) {
    await assert.rejects(provider.executeCommand({ ...command, type }), { code: 'legacy_read_only', status: 403 });
  }
  await assert.rejects(provider.executeBatch({ ...command, operations: [] }), { code: 'legacy_read_only', status: 403 });
  for (const type of ['create', 'update', 'publish', 'apply', 'archive', 'unarchive', 'delete']) {
    await assert.rejects(provider.executeModelCommand({ ...command, type }), { code: 'legacy_read_only', status: 403 });
    await assert.rejects(provider.mutateConfiguration({ ...command, family: 'sources', type }), { code: 'legacy_read_only', status: 403 });
  }
  await assert.rejects(provider.mutateSettings(command), { code: 'legacy_read_only', status: 403 });
  assert.deepEqual(provider.snapshot, before); assert.equal(provider.revision, status.revision);
  assert.equal(provider.modified, false); assert.equal(notices, 0);
  assert.deepEqual(await provider.getCommandOutcome(command.clientCommandId), { state: 'not-found' });
  provider.dispose();
});

test('complete legacy export and reimport preserve read-only policy and original snapshot time', async () => {
  const provider = await reader(), before = await provider.getStatus();
  const exported = await validateSnapshot(await provider.exportSnapshot());
  assert.equal(exported.manifest.snapshotAt, before.snapshotAt);
  assert.ok(exported.manifest.exportedAt); assert.equal(exported.manifest.legacy.readOnly, true);
  assert.equal(exported.records.length, initial.records.length);
  const restored = new LocalProvider(exported); const status = await restored.initialize();
  assert.equal(status.capabilities.recordCrud, false);
  await assert.rejects(restored.mutateSettings({}), { code: 'legacy_read_only', status: 403 });
  restored.dispose(); provider.dispose();
});

test('normal Local snapshots retain their editing capabilities and commands', async () => {
  const provider = new LocalProvider(structuredClone(initial)), status = await provider.initialize();
  assert.equal(status.capabilities.recordCrud, true); assert.deepEqual(status.actor.capabilities, ['*']);
  const result = await provider.executeCommand({ type: 'create', generation: status.generation, clientCommandId: 'normal-local-create',
    payload: { title: 'Writable local record', start: initial.settings.range.from } });
  assert.equal(result.record.title, 'Writable local record'); assert.equal((await provider.getStatus()).modified, true);
  provider.dispose();
});
