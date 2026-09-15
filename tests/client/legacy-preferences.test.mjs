import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { validateSnapshot } from '../../client/src/data/snapshot.js';
import { exportWithPersonalPreferences } from '../../client/src/ui/view-settings.js';

const definition = { definitionVersion: 2, relationshipMode: 'family', sourceIds: null, kinds: ['event', 'session'], schemaRefs: [],
  expression: { version: 2, root: { op: 'regex', field: '/title', pattern: 'Activity' } },
  search: { text: 'Activity', mode: 'regex', fields: ['/title'], flags: [] } };
let sequence = 0;
async function create(provider, name = 'App-owned search') {
  return provider.mutateConfiguration({ type: 'create', family: 'filters', generation: provider.generation, clientCommandId: `preference-${++sequence}`,
    payload: { name, visibility: 'personal', definition } });
}
async function local() {
  const snapshot = structuredClone(initial);
  delete snapshot.manifest.contentSha256;
  snapshot.manifest.legacy = { readOnly: true, preferencesEnabled: true, preferencesRevision: 0, preferencesSource: 'application-json', preferencesCatalogIds: { filters: [], views: [] } };
  const provider = new LocalProvider(snapshot); await provider.initialize();
  return provider;
}

test('explicit local preferences flag enables metadata only and persists ownership across export', async () => {
  const provider = await local(), before = structuredClone(provider.snapshot), status = await provider.getStatus();
  assert.equal(status.capabilities.configurationManagement, true);
  assert.equal(status.preferencesDurability, 'memory-only');
  assert.equal(status.capabilities.recordCrud, false);
  assert.equal(status.capabilities.modelManagement, false);
  assert.ok(status.actor.capabilities.includes('configuration.personal'));
  const created = await create(provider), id = created.resource.id;
  assert.ok((await provider.getConfiguration('filters', id)).allowedActions.includes('update'));
  await provider.mutateSettings({ type: 'patch', scope: 'personal', generation: provider.generation, clientCommandId: 'local-preference-setting', expectedRevision: 0,
    payload: { definitionVersion: 2, groupOrder: { order: 'natural', caseSensitive: true } } });
  assert.deepEqual(provider.snapshot.records, before.records);
  assert.deepEqual(provider.snapshot.models, before.models);
  assert.deepEqual(provider.snapshot.sources, before.sources);
  assert.equal(provider.snapshot.manifest.legacy.preferencesSource, 'local-memory');
  assert.equal(provider.snapshot.manifest.preferencesRevision, 2);
  const exported = await validateSnapshot(await provider.exportSnapshot());
  assert.equal(exported.manifest.snapshotAt, before.manifest.snapshotAt);
  assert.deepEqual(exported.manifest.legacy.preferencesCatalogIds.filters, [id]);
  const restored = new LocalProvider(exported); await restored.initialize();
  assert.ok((await restored.getConfiguration('filters', id)).allowedActions.includes('update'));
  assert.deepEqual(restored.snapshot.records, before.records);
  restored.dispose(); provider.dispose();
});

test('legacy preferences never unlock record, model, source, or imported definition writes', async () => {
  const provider = await local();
  const resource = (await create(provider)).resource;
  const imported = await validateSnapshot(await provider.exportSnapshot());
  imported.manifest.legacy.preferencesCatalogIds.filters = [];
  delete imported.manifest.contentSha256;
  const restored = new LocalProvider(imported); await restored.initialize();
  assert.deepEqual((await restored.getConfiguration('filters', resource.id)).allowedActions, ['duplicate']);
  const command = { generation: restored.generation, clientCommandId: 'immutable-legacy' };
  await assert.rejects(restored.mutateConfiguration({ ...command, family: 'filters', type: 'update', resourceId: resource.id, expectedRevision: resource.revision, payload: { name: 'Forbidden' } }), { code: 'legacy_read_only' });
  for (const family of ['sources', 'groups', 'schemas', 'models']) await assert.rejects(restored.mutateConfiguration({ ...command, family, type: 'create' }), { code: 'legacy_read_only' });
  await assert.rejects(restored.executeCommand({ ...command, type: 'create' }), { code: 'legacy_read_only' });
  await assert.rejects(restored.executeBatch({ ...command, operations: [] }), { code: 'legacy_read_only' });
  await assert.rejects(restored.executeModelCommand({ ...command, type: 'update' }), { code: 'legacy_read_only' });
  const duplicate = await restored.mutateConfiguration({ ...command, type: 'duplicate', family: 'filters', resourceId: resource.id, expectedRevision: resource.revision, payload: { name: 'Editable copy' } });
  assert.ok((await restored.getConfiguration('filters', duplicate.resource.id)).allowedActions.includes('update'));
  restored.dispose(); provider.dispose();
});

test('server export reopens the named personal preferences as an unverified local author', async () => {
  const source = await local(), actor = { id: 'server-personal-owner', capabilities: ['*'] };
  const exported = await exportWithPersonalPreferences(source.snapshot, { definitionVersion: 2, search: definition.search, table: { scope: 'window', projection: 'matches', limit: 50 } }, actor);
  assert.equal(exported.manifest.localPreferencesPrincipalId, actor.id);
  assert.equal(exported.manifest.legacy.preferencesSource, 'local-export');
  assert.equal(exported.manifest.legacy.serverPreferencesRevision, 0);
  assert.equal(exported.manifest.preferencesRevision, 1);
  const restored = new LocalProvider(exported), status = await restored.initialize();
  assert.equal(status.actor.id, actor.id);
  assert.equal(status.actor.verified, false);
  assert.equal(status.capabilities.serverAdministration, false);
  assert.deepEqual(status.settings.search, definition.search);
  assert.equal(status.settings.table.limit, 50);
  assert.deepEqual(restored.snapshot.records, source.snapshot.records);
  assert.equal(source.snapshot.preferences.length, 0);
  assert.equal(source.snapshot.manifest.localPreferencesPrincipalId, undefined);
  restored.dispose(); source.dispose();
});

test('portable local principal marker is bounded and does not enable disabled legacy preferences', async () => {
  for (const value of [null, 1, '', ' ', 'x'.repeat(129)]) {
    const snapshot = structuredClone(initial);
    delete snapshot.manifest.contentSha256;
    snapshot.manifest.localPreferencesPrincipalId = value;
    const provider = new LocalProvider(snapshot);
    await assert.rejects(provider.initialize(), { code: 'invalid_snapshot' });
    provider.dispose();
  }
  const snapshot = structuredClone(initial);
  delete snapshot.manifest.contentSha256;
  snapshot.manifest.legacy = { readOnly: true };
  await assert.rejects(exportWithPersonalPreferences(snapshot, { theme: 'dark' }, { id: 'reader', capabilities: ['*'] }), { code: 'legacy_read_only' });
});
