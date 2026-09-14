import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { validateSnapshot } from '../../client/src/data/snapshot.js';
import { sha256 } from '../../client/src/data/data-provider.js';
import { DEFAULT_DEFINITION, normalizeCatalog, applyModelCommand, validateDefinition } from '../../client/src/data/model-catalog.js';

const copy = value => structuredClone(value);
const definition = overrides => ({ ...DEFAULT_DEFINITION, ...overrides });
const queryInput = { domain: { from: '2026-09-12T00:00:00.000Z', to: '2026-09-13T00:00:00.000Z' }, filters: { sourceId: 'all', kind: 'all' }, search: '', scaleMode: 'uniform', bins: 128, ratio: 4 };
async function local() { const provider = new LocalProvider(copy(initial)); await provider.initialize(); return provider; }
function command(provider, type, model, payload = {}) {
  return { type, modelId: model?.id, expectedRevision: model?.revision, generation: provider.generation, clientCommandId: crypto.randomUUID(), payload };
}
async function mutate(provider, type, model, payload) { return provider.executeModelCommand(command(provider, type, model, payload)); }

test('legacy models normalize deterministically after integrity verification', async () => {
  const legacy = copy(initial);
  legacy.manifest.contentSha256 = await sha256({ records: legacy.records, zones: legacy.zones, models: legacy.models, filters: legacy.filters, settings: legacy.settings });
  const upgraded = await validateSnapshot(legacy);
  assert.equal(upgraded.settings.modelVersion, 1);
  assert.equal(upgraded.manifest.contentSha256, undefined);
  assert.deepEqual(upgraded.models, normalizeCatalog(initial.models, initial.manifest.snapshotAt));
  for (const model of upgraded.models) {
    assert.equal(model.revision, 1);
    assert.equal(model.createdAt, initial.manifest.snapshotAt);
    assert.equal(model.versions[0].publishedAt, initial.manifest.snapshotAt);
    assert.equal(model.draft, null);
    assert.equal(model.versions[0].definition.displayUnit, 'HOUR');
  }
  assert.ok(!Object.hasOwn(legacy.models[0], 'versions'));
  legacy.models[0].name = 'Tampered';
  await assert.rejects(validateSnapshot(legacy), { code: 'checksum_mismatch' });
  const noPin = copy(upgraded); delete noPin.settings.modelVersion;
  await assert.rejects(validateSnapshot(noPin), { code: 'model_version_unavailable' });
  const invalidPin = copy(upgraded); invalidPin.settings.modelVersion = 123;
  await assert.rejects(validateSnapshot(invalidPin), { code: 'model_version_unavailable' });
  const inventedHistory = copy(initial); inventedHistory.models[0].version = 2;
  await assert.rejects(validateSnapshot(inventedHistory), { code: 'invalid_snapshot' });
});

test('visual definitions are strict, bounded and have pointer-level errors', () => {
  assert.deepEqual(validateDefinition(definition()), { valid: true, errors: [] });
  assert.equal(validateDefinition(definition({ timeZone: 'America/New_York' })).valid, true);
  assert.equal(validateDefinition(definition({ timeZone: 'america/new_york' })).valid, false);
  assert.equal(validateDefinition(definition({ timeZone: 'utc' })).valid, false);
  assert.equal(validateDefinition(definition({ timeZone: 'US/Eastern' })).valid, true);
  assert.equal(validateDefinition(definition({ ratio: 32 })).valid, true);
  for (const [field, value] of [['fontSize', '13'], ['rowHeight', 31], ['rowHeight', 32.5], ['ratio', 33], ['bins', 15], ['displayUnit', 'FORTNIGHT'], ['timeZone', '+02:00'], ['timeZone', 'Invented/Nowhere'], ['groupBy', 'owner'], ['theme', 'purple']]) {
    const result = validateDefinition(definition({ [field]: value }));
    assert.equal(result.valid, false, field);
    assert.ok(result.errors.some(error => error.path === `/${field}`), field);
  }
  assert.equal(validateDefinition(definition({ rowHeight: 32, fontSize: 24 })).valid, false);
  assert.equal(validateDefinition({ ...definition(), callback: 'alert(1)' }).valid, false);
  const missing = definition(); delete missing.scaleMode;
  assert.ok(validateDefinition(missing).errors.some(error => error.path === '/scaleMode'));
});

test('Local draft publication is immutable and apply alone changes the active pin', async () => {
  const provider = await local();
  const original = await provider.getStatus();
  const records = JSON.stringify(provider.snapshot.records);
  const query = await provider.createQuery(queryInput);
  const overview = await provider.getOverview(query.queryId);
  const create = command(provider, 'create', null, { name: 'Operations', tags: ['team'], definition: definition({ theme: 'dark', groupBy: 'kind' }) });
  const first = await provider.executeModelCommand(create);
  assert.deepEqual(await provider.executeModelCommand(create), first);
  assert.equal(first.model.versions.length, 0);
  assert.equal(first.model.draft.theme, 'dark');
  assert.equal(first.durability, 'memory-only');
  let model = first.model;
  await assert.rejects(mutate(provider, 'apply', model, { version: 1 }), { code: 'model_version_unavailable' });
  let result = await mutate(provider, 'publish', model); model = result.model;
  assert.equal(model.versions.length, 1);
  assert.equal(model.draft, null);
  assert.equal(result.settings.modelId, original.settings.modelId);
  result = await mutate(provider, 'apply', model, { version: 1 });
  assert.equal(result.model.revision, model.revision);
  assert.equal(result.settings.modelId, model.id);
  assert.equal(result.settings.modelVersion, 1);
  assert.equal(result.settings.referenceTime, original.settings.referenceTime);
  const published = copy(model.versions[0]);
  result = await mutate(provider, 'update', model, { draft: definition({ theme: 'classic', displayUnit: 'DECADE', timeZone: 'America/New_York' }), name: 'Operations revised' }); model = result.model;
  result = await mutate(provider, 'publish', model); model = result.model;
  assert.deepEqual(model.versions[0], published);
  assert.equal(model.versions[1].version, 2);
  assert.equal(result.settings.modelVersion, 1);
  assert.equal(result.settings.theme, 'dark');
  result = await mutate(provider, 'apply', model, { version: 2 });
  assert.equal(result.settings.theme, 'classic');
  assert.equal(result.settings.displayUnit, 'DECADE');
  assert.equal(result.settings.timeZone, 'America/New_York');
  assert.equal(result.model.revision, model.revision);
  assert.equal((await mutate(provider, 'apply', model, { version: 1 })).settings.theme, 'dark');
  assert.deepEqual(await provider.getOverview(query.queryId), overview);
  assert.equal(JSON.stringify(provider.snapshot.records), records);
  assert.deepEqual((await provider.getModel(model.id)).usage, [{ kind: 'workspace-default', modelId: model.id, version: 1 }]);
  assert.deepEqual(await provider.getCommandOutcome(create.clientCommandId), { state: 'committed', result: first });
  provider.dispose();
});

test('Local model lifecycle, reference protection, queued revisions and preconditions', async () => {
  const provider = await local();
  let model = (await provider.getModel((await provider.getStatus()).settings.modelId)).model;
  const before = await provider.listModels();
  for (const [patch, code] of [[{ generation: undefined }, 'precondition_required'], [{ generation: 'other' }, 'generation_mismatch'], [{ clientCommandId: undefined }, 'idempotency_required'], [{ expectedRevision: undefined }, 'precondition_required'], [{ expectedRevision: 999 }, 'model_revision_conflict']]) {
    await assert.rejects(provider.executeModelCommand({ ...command(provider, 'update', model, { name: 'Changed' }), ...patch }), { code });
  }
  assert.deepEqual(await provider.listModels(), before);
  const updates = await Promise.allSettled(['First', 'Second'].map(name => mutate(provider, 'update', model, { name })));
  assert.equal(updates[0].status, 'fulfilled');
  assert.equal(updates[1].reason.code, 'model_revision_conflict');
  model = updates[0].value.model;
  await assert.rejects(mutate(provider, 'delete', model), { code: 'model_referenced' });
  model = (await mutate(provider, 'archive', model)).model;
  assert.equal((await provider.listModels({ includeArchived: false })).items.some(item => item.id === model.id), false);
  assert.equal((await provider.getStatus()).settings.modelId, model.id);
  assert.equal((await provider.getModel(model.id)).model.versions.length, 1);
  for (const type of ['update', 'publish', 'apply']) await assert.rejects(mutate(provider, type, model, type === 'apply' ? { version: 1 } : { name: 'No' }), { code: 'model_archived' });
  await assert.rejects(mutate(provider, 'archive', model), { code: 'model_lifecycle_conflict' });
  model = (await mutate(provider, 'unarchive', model)).model;
  await assert.rejects(mutate(provider, 'publish', model), { code: 'model_draft_missing' });
  for (const version of ['1', 1.5, 0, 33, true]) await assert.rejects(mutate(provider, 'apply', model, { version }), { code: 'invalid_model' });
  const unreferenced = (await mutate(provider, 'create', null, { name: 'Disposable draft', definition: definition() })).model;
  assert.equal((await mutate(provider, 'delete', unreferenced)).model, null);
  await assert.rejects(provider.getModel(unreferenced.id), { code: 'model_not_found' });
  provider.dispose();
});

test('model and record idempotency share a conflict-safe namespace', async () => {
  const provider = await local();
  const cmd = command(provider, 'create', null, { name: 'Unique', definition: definition() });
  await provider.executeModelCommand(cmd);
  const revision = provider.revision;
  await assert.rejects(provider.executeModelCommand({ ...cmd, payload: { ...cmd.payload, name: 'Different' } }), { code: 'idempotency_conflict' });
  await assert.rejects(provider.executeCommand({ type: 'create', generation: provider.generation, clientCommandId: cmd.clientCommandId, payload: { title: 'Record' } }), { code: 'idempotency_conflict' });
  assert.equal(provider.revision, revision);
  await assert.rejects(mutate(provider, 'create', null, { name: '\ud800', definition: definition() }), { code: 'invalid_json' });
  for (const payload of [null, { name: 'Invalid', definition: definition(), tags: null }, { name: 'Invalid', definition: definition(), description: null }, { name: 'Invalid', definition: definition(), revision: 2 }]) await assert.rejects(mutate(provider, 'create', null, payload), { code: 'invalid_model' });
  assert.equal(provider.revision, revision);
  provider.dispose();
});

test('queued Local model commands retain their submitted content', async () => {
  const provider = await local();
  const cmd = command(provider, 'create', null, { name: 'Submitted name', definition: definition() });
  const pending = provider.executeModelCommand(cmd);
  cmd.payload.name = 'Changed after submission';
  cmd.payload.definition.theme = 'dark';
  const result = await pending;
  assert.equal(result.model.name, 'Submitted name');
  assert.equal(result.model.draft.theme, 'light');
  provider.dispose();
});

test('Local export/import preserves draft, full publication history and archived active pin', async () => {
  const provider = await local();
  let model = (await provider.getModel((await provider.getStatus()).settings.modelId)).model;
  model = (await mutate(provider, 'update', model, { draft: definition({ theme: 'dark' }) })).model;
  model = (await mutate(provider, 'publish', model)).model;
  await mutate(provider, 'apply', model, { version: 2 });
  model = (await mutate(provider, 'update', model, { draft: definition({ scaleMode: 'adaptive', ratio: 8 }) })).model;
  model = (await mutate(provider, 'archive', model)).model;
  const exported = await provider.exportSnapshot();
  const restored = new LocalProvider(JSON.stringify(exported));
  await restored.initialize();
  assert.deepEqual((await restored.getModel(model.id)).model, model);
  assert.deepEqual((await restored.getStatus()).settings, (await provider.getStatus()).settings);
  assert.equal((await restored.getStatus()).settings.modelVersion, 2);
  assert.notEqual(restored.generation, provider.generation);
  assert.equal((await provider.getStatus()).modified, true);
  exported.models.find(item => item.id === model.id).versions[0].definition.ratio = 7;
  await assert.rejects(validateSnapshot(exported), { code: 'checksum_mismatch' });
  provider.dispose(); restored.dispose();
});

test('catalog and version capacity reject without truncating history', () => {
  const models = normalizeCatalog(initial.models, initial.manifest.snapshotAt);
  const settings = { ...initial.settings, modelVersion: 1 };
  const full = Array.from({ length: 100 }, (_, index) => ({ ...copy(models[0]), id: index === 0 ? settings.modelId : `model-${index}` }));
  assert.throws(() => applyModelCommand(full, settings, { type: 'create', payload: { name: 'Excess', definition: definition() } }), { code: 'model_capacity' });
  const model = models.find(item => item.id === settings.modelId);
  model.versions = Array.from({ length: 32 }, (_, index) => ({ ...copy(model.versions[0]), version: index + 1 }));
  model.draft = definition();
  const before = JSON.stringify(models);
  assert.throws(() => applyModelCommand(models, settings, { type: 'publish', modelId: model.id, expectedRevision: model.revision }), { code: 'model_version_capacity' });
  assert.equal(JSON.stringify(models), before);
});

test('Server model routes carry exact preconditions and keep validation read-only', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const model = normalizeCatalog(initial.models, initial.manifest.snapshotAt)[0];
  const settings = { ...initial.settings, modelVersion: 1 };
  const result = { model, settings, durability: 'server-committed', generation: 'generation', revision: 2 };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    const body = url.endsWith('/default') ? { generation: 'generation', revision: 1, settings } : url.endsWith('/validate') ? { valid: true, errors: [] } : result;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const provider = new ServerProvider({ baseUrl: 'http://127.0.0.1:9999', token: 'secret' });
  try {
    await provider.initialize();
    await provider.listModels({ includeArchived: false });
    assert.ok(requests.at(-1).url.endsWith('/models?includeArchived=false'));
    await provider.getModel(model.id);
    assert.ok(requests.at(-1).url.endsWith(`/models/${model.id}`));
    await provider.validateModel(definition());
    assert.equal(requests.at(-1).options.method, 'POST');
    assert.equal(requests.at(-1).options.headers['Idempotency-Key'], undefined);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), { definition: definition() });
    for (const [type, method, suffix] of [['create', 'POST', '/models'], ['update', 'PUT', `/models/${model.id}`], ['publish', 'POST', `/models/${model.id}/publish`], ['archive', 'POST', `/models/${model.id}/archive`], ['unarchive', 'POST', `/models/${model.id}/unarchive`], ['apply', 'POST', `/models/${model.id}/apply`], ['delete', 'DELETE', `/models/${model.id}`]]) {
      const cmd = { type, modelId: model.id, expectedRevision: 3, generation: 'generation', clientCommandId: `key-${type}`, payload: type === 'apply' ? { version: 1 } : {} };
      assert.deepEqual(await provider.executeModelCommand(cmd), result);
      const request = requests.at(-1);
      assert.ok(request.url.endsWith(suffix));
      assert.equal(request.options.method, method);
      assert.equal(request.options.headers.Authorization, 'Bearer secret');
      assert.equal(request.options.headers['Idempotency-Key'], cmd.clientCommandId);
      assert.equal(request.options.headers['X-Workspace-Generation'], 'generation');
      assert.equal(request.options.headers['If-Match'], type === 'create' ? undefined : '"generation:3"');
      if (type === 'delete') assert.equal(request.options.body, undefined);
    }
    const total = requests.length;
    await assert.rejects(provider.executeModelCommand({ type: 'create', clientCommandId: 'missing' }), { code: 'precondition_required' });
    await assert.rejects(provider.executeModelCommand({ type: 'create', generation: 'other', clientCommandId: 'foreign' }), { code: 'generation_mismatch' });
    assert.equal(requests.length, total);
    await assert.rejects(provider.executeModelCommand({ type: 'update', generation: 'generation', expectedRevision: '3', clientCommandId: 'invalid' }), { code: 'model_revision_conflict' });
    await assert.rejects(provider.executeModelCommand({ type: 'delete', modelId: model.id, generation: 'generation', expectedRevision: 3, clientCommandId: 'invalid-delete', payload: { overwrite: true } }), { code: 'invalid_model' });
    assert.deepEqual(await provider.getCommandOutcome('model-command'), { state: 'committed', result });
    globalThis.fetch = async () => { throw new TypeError('Disconnected'); };
    await assert.rejects(provider.executeModelCommand({ type: 'create', generation: 'generation', clientCommandId: 'unknown', payload: {} }), { code: 'write_outcome_unknown' });
  } finally { provider.dispose(); globalThis.fetch = previousFetch; }
});
