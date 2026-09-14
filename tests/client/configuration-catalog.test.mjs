import test from 'node:test';
import assert from 'node:assert/strict';
import initial from '../../shared/fixtures/initial-snapshot.json' with { type: 'json' };
import { normalizeConfiguration, applyConfigurationCommand, validateResourceDefinition, configurationUsage, effectiveSettings, filterFieldTypes, resolvedDataSchema } from '../../client/src/data/configuration-catalog.js';
import { canonicalJson, sha256 } from '../../client/src/data/data-provider.js';

const actor = { id: 'admin', capabilities: ['*'] };
const personal = { id: 'alice', capabilities: ['configuration.read', 'configuration.personal'] };
const now = '2026-09-13T00:00:00.000Z';
let sequence = 0;
const createId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const normalized = () => normalizeConfiguration(structuredClone(initial), actor);
const source = () => ({ storage: 'json', enabled: true, writable: true, defaultSchema: null });
const group = () => ({ order: 0, color: '#123456', collapsed: false });
const schema = () => ({ schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { score: { type: 'number' }, flag: { type: 'boolean' } }, additionalProperties: false } });
const filter = () => ({ sourceIds: null, kinds: ['event', 'session'], schemaRefs: [], expression: null, search: { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] } });
const view = () => ({ model: { id: 'light', version: 1 }, filter: null, settings: { mode: 'split' } });
function command(snapshot, family, type, payload = {}, resource, as = actor) {
  return applyConfigurationCommand(snapshot, { family, type, generation: snapshot.manifest.generation, clientCommandId: `command-${++sequence}`, ...(resource ? { resourceId: resource.id, expectedRevision: resource.revision } : {}), ...(type === 'apply' ? { expectedPreferenceRevision: snapshot.preferences?.find(item => item.principalId === as.id)?.revision ?? 0 } : {}), payload }, { actor: as, now, createId });
}
function published(snapshot, family, definition, visibility = 'workspace', as = actor) {
  let result = command(snapshot, family, 'create', { name: `${family} resource`, visibility, definition }, null, as);
  if (!result.resource.versions.length) result = command(result.snapshot, family, 'publish', {}, result.resource, as);
  return result;
}
const code = (expected, status) => error => error.code === expected && (status === undefined || error.status === status);

test('legacy normalization preserves complete source/group scope and old hashes until content changes', async () => {
  const input = structuredClone(initial);
  input.manifest.contentSha256 = await sha256(input.records);
  input.records[0].groupIds = ['archived-group']; input.records[0].deletedAt = now;
  input.manifest.scope.sourceIds.push('empty-source');
  const before = canonicalJson(input), result = normalizeConfiguration(input, actor);
  assert.equal(canonicalJson(input), before);
  assert.deepEqual(result.sources.map(item => item.id), [...input.manifest.scope.sourceIds]);
  assert.equal(result.groups[0].id, 'archived-group');
  assert.equal(result.sources[0].ownerId, 'legacy-import');
  assert.equal(result.sources[0].versions[0].publishedAt, input.manifest.snapshotAt);
  assert.equal(result.settings.modelVersion, 1);
  assert.equal(result.manifest.contentSha256, undefined);
  result.manifest.contentSha256 = 'verified-external-hash';
  assert.deepEqual(normalizeConfiguration(result, actor), result);
  assert.throws(() => normalizeConfiguration(input), code('configuration_forbidden', 403));
});

test('strict family definitions reject unknown keys, malformed colors, storage paths and partial search', () => {
  assert.equal(validateResourceDefinition('sources', source()).valid, true);
  assert.equal(validateResourceDefinition('groups', group()).valid, true);
  assert.equal(validateResourceDefinition('groups', { ...group(), color: '#123456\n' }).valid, false);
  assert.equal(validateResourceDefinition('sources', { ...source(), path: 'C:/data' }).valid, false);
  assert.equal(validateResourceDefinition('filters', { ...filter(), search: { text: '' } }).valid, false);
  assert.equal(validateResourceDefinition('filters', { ...filter(), sourceIds: [] }).valid, true);
  assert.equal(validateResourceDefinition('filters', { ...filter(), kinds: [] }).valid, true);
  assert.equal(validateResourceDefinition('views', { ...view(), settings: { modelId: 'dark', modelVersion: 1 } }).valid, false);
  assert.equal(validateResourceDefinition('views', { ...view(), settings: { sort: [{ field: 'tags', direction: 'asc' }] } }).valid, false);
});

test('legacy source/group identities retain punctuation and Unicode without being turned into paths', () => {
  const input = structuredClone(initial), sourceId = 'legacy.source: west / station';
  input.manifest.scope.sourceIds.push(sourceId);
  input.records[0].groupIds = ['\u00e9quipe / flight:one'];
  const output = normalizeConfiguration(input, actor);
  assert.equal(output.sources.at(-1).id, sourceId);
  assert.equal(output.sources.at(-1).versions[0].definition.storage, 'json');
  assert.equal(output.groups[0].id, input.records[0].groupIds[0]);
  assert.equal(validateResourceDefinition('filters', { ...filter(), sourceIds: [sourceId] }, { snapshot: output }).valid, true);
});

test('schema compiler admits bounded local references and rejects recursion/remote/code/pattern dialects', () => {
  const value = schema();
  value.schema.$defs = { rank: { type: 'integer', minimum: 0, maximum: 10 } };
  value.schema.properties.score = { $ref: '#/$defs/rank' };
  assert.equal(validateResourceDefinition('schemas', value).valid, true);
  assert.equal(resolvedDataSchema(value).properties.status.type, 'string');
  for (const mutation of [
    input => { input.schema.properties.score = { $ref: 'https://invalid.example/schema' }; },
    input => { input.schema.$defs.rank = { $ref: '#/$defs/rank' }; },
    input => { input.schema.properties.code = { type: 'string', pattern: '(a+)+$' }; },
    input => { input.schema.$schema = 'http://json-schema.org/draft-07/schema#'; },
    input => { input.schema.properties.status = { type: 'number' }; },
    input => { input.schema.properties.code = { type: 'string', maxLength: -1 }; },
  ]) { const input = structuredClone(value); mutation(input); assert.equal(validateResourceDefinition('schemas', input).valid, false); }
});

test('create/publish/update maintain immutable history, resource revision and provider-owned workspace revision', () => {
  const input = normalized(), before = canonicalJson(input);
  let result = published(input, 'filters', filter());
  const v1 = canonicalJson(result.resource.versions[0]);
  assert.equal(result.resource.revision, 2); assert.equal(result.snapshot.manifest.revision, input.manifest.revision);
  const nextDefinition = { ...filter(), kinds: ['session'] };
  result = command(result.snapshot, 'filters', 'update', { draft: nextDefinition }, result.resource);
  result = command(result.snapshot, 'filters', 'publish', {}, result.resource);
  assert.equal(canonicalJson(result.resource.versions[0]), v1);
  assert.deepEqual(result.resource.versions[1].definition, nextDefinition);
  assert.equal(result.resource.versions[1].publishedBy, actor.id);
  assert.equal(canonicalJson(input), before);
});

test('commands require explicit generation, revision and request-local permissions', () => {
  const snapshot = normalized(), resource = snapshot.sources[0];
  const base = { family: 'sources', type: 'archive', clientCommandId: 'safe-command', resourceId: resource.id, expectedRevision: 1, generation: snapshot.manifest.generation };
  assert.throws(() => applyConfigurationCommand(snapshot, { ...base, generation: undefined }, { actor }), code('precondition_required', 428));
  assert.throws(() => applyConfigurationCommand(snapshot, { ...base, generation: 'wrong' }, { actor }), code('workspace_generation_conflict', 409));
  assert.throws(() => applyConfigurationCommand(snapshot, { ...base, expectedRevision: undefined }, { actor }), code('precondition_required', 428));
  assert.throws(() => applyConfigurationCommand(snapshot, { ...base, expectedRevision: 2 }, { actor }), code('configuration_revision_conflict', 412));
  assert.throws(() => applyConfigurationCommand(snapshot, base, { actor: personal }), code('configuration_forbidden', 403));
  assert.throws(() => command(snapshot, 'sources', 'create', { name: 'new source', definition: source() }, null, { id: 'manager', capabilities: ['configuration.manage'] }), code('configuration_forbidden', 403));
});

test('personal publication cannot be read or mutated by other owners; imported ownership grants nothing', () => {
  const result = published(normalized(), 'filters', filter(), 'personal', personal);
  const stranger = { id: 'bob', capabilities: ['configuration.read', 'configuration.personal'] };
  assert.throws(() => command(result.snapshot, 'filters', 'update', { name: 'stolen' }, result.resource, stranger), code('configuration_not_found', 404));
  assert.throws(() => command(result.snapshot, 'filters', 'update', { name: 'stolen' }, result.resource, { id: personal.id, capabilities: [] }), code('configuration_not_found', 404));
  const sharedView = { ...view(), filter: { id: result.resource.id, version: 1 } };
  assert.equal(validateResourceDefinition('views', sharedView, { snapshot: result.snapshot, actor, visibility: 'workspace' }).valid, false);
});

test('source creation/deletion changes scope atomically; active records and tombstones protect identities', () => {
  const initialState = normalized();
  let result = command(initialState, 'sources', 'create', { name: 'fresh source', definition: source() });
  assert(result.snapshot.manifest.scope.sourceIds.includes(result.resource.id));
  result = command(result.snapshot, 'sources', 'delete', {}, result.resource);
  assert.deepEqual(result.snapshot.manifest.scope.sourceIds, initialState.manifest.scope.sourceIds);
  const snapshot = normalized(); snapshot.records.forEach(record => { record.deletedAt = now; });
  assert.throws(() => command(snapshot, 'sources', 'delete', {}, snapshot.sources[0]), code('configuration_referenced', 409));
  assert(configurationUsage(snapshot, 'sources', snapshot.sources[0].id).every(item => item.kind === 'tombstone'));
});

test('schema pins from every publication, draft, source default, record and preference protect deletion', () => {
  const dataSchema = published(normalized(), 'schemas', schema());
  const pin = { id: dataSchema.resource.id, version: 1 };
  const scoped = { ...filter(), schemaRefs: [pin], expression: { version: 1, root: { op: 'gte', field: '/data/score', value: 3 } } };
  const saved = published(dataSchema.snapshot, 'filters', scoped);
  const refs = configurationUsage(saved.snapshot, 'schemas', pin.id, 1);
  assert(refs.some(item => item.family === 'filters' && item.version === 1));
  assert.throws(() => command(saved.snapshot, 'schemas', 'delete', {}, dataSchema.resource), code('configuration_referenced', 409));
  const update = command(saved.snapshot, 'filters', 'update', { draft: filter() }, saved.resource);
  assert(configurationUsage(update.snapshot, 'schemas', pin.id).length > 0);
  const archived = command(update.snapshot, 'schemas', 'archive', {}, dataSchema.resource);
  assert.deepEqual(normalizeConfiguration(archived.snapshot, actor), archived.snapshot);
  assert.equal(validateResourceDefinition('sources', { ...source(), defaultSchema: pin }, { snapshot: archived.snapshot, newReference: true }).valid, false);
});

test('schema-scoped filter fields have exact custom typing, Boolean and null semantics at admission', () => {
  const result = published(normalized(), 'schemas', schema());
  const pin = { id: result.resource.id, version: 1 };
  const registry = filterFieldTypes(result.snapshot, [pin]);
  assert.equal(registry['/data/score'], 'number'); assert.equal(registry['/data/flag'], 'boolean');
  for (const predicate of [
    { op: 'eq', field: '/data/flag', value: false }, { op: 'in', field: '/data/flag', values: [true, null] },
    { op: 'gte', field: '/data/score', value: 2 }, { op: 'eq', field: '/data/score', value: null },
  ]) assert.equal(validateResourceDefinition('filters', { ...filter(), schemaRefs: [pin], expression: { version: 1, root: predicate } }, { snapshot: result.snapshot }).valid, true);
  for (const predicate of [{ op: 'eq', field: '/data/flag', value: 1 }, { op: 'exists', field: '/data/flag', value: null }, { op: 'gt', field: '/data/flag', value: true }, { op: 'eq', field: '/data/score', value: '2' }]) assert.equal(validateResourceDefinition('filters', { ...filter(), schemaRefs: [pin], expression: { version: 1, root: predicate } }, { snapshot: result.snapshot }).valid, false);
  assert.equal(validateResourceDefinition('filters', { ...filter(), expression: { version: 1, root: { op: 'eq', field: '/data/score', value: 1 } } }, { snapshot: result.snapshot }).valid, false);
});

test('duplicate retains provenance but creates independent history and cannot mutate caller objects', () => {
  const original = published(normalized(), 'filters', filter());
  const result = command(original.snapshot, 'filters', 'duplicate', { name: 'copy' }, original.resource);
  assert.notEqual(result.resource.id, original.resource.id);
  assert.deepEqual(result.resource.copiedFrom, { family: 'filters', id: original.resource.id, version: 1 });
  assert.equal(result.resource.versions.length, 0);
  result.resource.draft.kinds.length = 0;
  assert.equal(original.resource.versions[0].definition.kinds.length, 2);
});

test('effective settings merge declared maps, replace arrays and provide leaf provenance', () => {
  const result = published(normalized(), 'views', { ...view(), settings: { rowHeight: 52, search: { text: 'view' }, collapsedGroups: [] } });
  const snapshot = result.snapshot;
  snapshot.defaults.values = { rowHeight: 48, timeZone: 'America/New_York' };
  snapshot.preferences.push({ principalId: 'alice', revision: 1, values: { rowHeight: 56, search: { mode: 'all' } } });
  const computed = effectiveSettings(snapshot, { viewId: result.resource.id, viewVersion: 1, principalId: 'alice', transient: { rowHeight: 60, search: { text: 'live' } } });
  assert.equal(computed.values.rowHeight, 60);
  assert.equal(computed.values.timeZone, 'UTC');
  assert.equal(computed.values.search.text, 'live'); assert.equal(computed.values.search.mode, 'all');
  assert.equal(computed.origins['/rowHeight'], 'transient'); assert.equal(computed.origins['/search/mode'], 'personal:alice');
  assert.equal(computed.origins['/timeZone'], 'model:light@1');
  assert.throws(() => effectiveSettings(snapshot, { transient: { serverRoot: 'C:/' } }), code('invalid_configuration', 422));
  assert.throws(() => effectiveSettings(snapshot, { transient: { range: { from: '2027-01-01T00:00:00Z', to: '2027-02-01T00:00:00Z' } } }), code('invalid_configuration', 422));
});

test('capacity and immutable version/revision checks reject atomically', () => {
  const snapshot = normalized();
  const result = published(snapshot, 'filters', filter());
  const overflow = structuredClone(result.snapshot);
  overflow.filters[0].revision = Number.MAX_SAFE_INTEGER;
  const before = canonicalJson(overflow);
  assert.throws(() => command(overflow, 'filters', 'update', { name: 'changed' }, overflow.filters[0]), code('configuration_capacity', 413));
  assert.equal(canonicalJson(overflow), before);
  assert.equal(validateResourceDefinition('schemas', { schema: { ...schema().schema, description: 'x'.repeat(65536) } }).valid, false);
  assert.throws(() => command(snapshot, 'schemas', 'create', { name: 'too large', definition: { schema: { ...schema().schema, description: 'x'.repeat(65536) } } }), code('configuration_capacity', 413));
  const broken = structuredClone(result.snapshot); broken.filters[0].versions[0].version = 2;
  assert.throws(() => normalizeConfiguration(broken, actor), code('invalid_configuration', 422));
});

test('private apply uses revision-checked personal preferences without changing shared settings or resource history', () => {
  const created = published(normalized(), 'views', view(), 'personal', personal);
  const shared = canonicalJson(created.snapshot.settings), resource = canonicalJson(created.resource);
  const result = command(created.snapshot, 'views', 'apply', { version: 1 }, created.resource, personal);
  assert.equal(canonicalJson(result.snapshot.settings), shared);
  assert.equal(canonicalJson(result.resource), resource);
  assert.equal(result.effectiveSettings.values.mode, 'split');
  assert.equal(result.effectiveSettings.preferenceRevision, 1);
  assert.equal(result.effectiveSettings.origins['/viewId'], 'personal:alice');
  assert.equal(result.effectiveSettings.origins['/viewVersion'], 'personal:alice');
  assert.equal(result.effectiveSettings.origins['/modelId'], `view:${created.resource.id}@1`);
  assert(result.resetTransientKeys.includes('mode'));
  assert.equal(result.snapshot.preferences[0].principalId, personal.id);
  assert.deepEqual(normalizeConfiguration(result.snapshot, actor), result.snapshot);
  assert.equal(effectiveSettings(result.snapshot, { principalId: 'bob' }).values.mode, 'timeline');
  const base = { family: 'views', type: 'apply', resourceId: created.resource.id, expectedRevision: created.resource.revision, generation: result.snapshot.manifest.generation, clientCommandId: 'concurrent-apply', payload: { version: 1 } };
  assert.throws(() => applyConfigurationCommand(result.snapshot, base, { actor: personal }), code('precondition_required', 428));
  assert.throws(() => applyConfigurationCommand(result.snapshot, { ...base, expectedPreferenceRevision: 0 }, { actor: personal }), code('configuration_preference_revision_conflict', 412));
  const next = command(result.snapshot, 'views', 'apply', { version: 1 }, created.resource, personal);
  assert.equal(next.effectiveSettings.preferenceRevision, 2);
  const cleared = effectiveSettings(result.snapshot, { principalId: personal.id, viewId: null, viewVersion: null });
  assert.equal(cleared.values.viewId, null); assert.equal(cleared.values.viewVersion, null);
  assert.equal(cleared.origins['/viewId'], 'preview');
  assert.equal(cleared.values.mode, 'timeline');
  const transient = effectiveSettings(result.snapshot, { principalId: personal.id, transient: { viewId: null, viewVersion: null } });
  assert.equal(transient.values.viewId, null); assert.equal(transient.origins['/viewId'], 'transient');
});

test('applying a saved filter resolves its contextual search without publishing or replacing workspace defaults', () => {
  const saved = published(normalized(), 'filters', { ...filter(), search: { text: '"Flight ready"', mode: 'phrase', caseSensitive: true, fields: ['/title'] } });
  const applied = command(saved.snapshot, 'filters', 'apply', { version: 1 }, saved.resource, personal);
  assert.equal(applied.effectiveSettings.values.search.text, '"Flight ready"');
  assert.equal(applied.effectiveSettings.origins['/search/text'], `filter:${saved.resource.id}@1`);
  assert(applied.resetTransientKeys.includes('search'));
  assert.equal(applied.snapshot.settings.filterId, undefined);
  assert.equal(effectiveSettings(applied.snapshot, { principalId: personal.id, transient: { search: { text: 'transient' } } }).values.search.text, 'transient');
});

test('present null catalogs, unknown legacy filters and forged workspace references reject without repair', () => {
  for (const key of ['sources', 'groups', 'schemas', 'views', 'defaults', 'preferences']) {
    const input = normalized(); input[key] = null;
    assert.throws(() => normalizeConfiguration(input, actor), code('invalid_configuration', 422));
  }
  const legacy = structuredClone(initial); legacy.filters = [{ name: 'old', expression: 'eval(unsafe)' }];
  assert.throws(() => normalizeConfiguration(legacy, actor), code('configuration_migration_required', 422));
  const privateSchema = published(normalized(), 'schemas', schema(), 'personal', personal);
  privateSchema.snapshot.records[0].schemaId = privateSchema.resource.id;
  privateSchema.snapshot.records[0].schemaVersion = 1;
  assert.throws(() => normalizeConfiguration(privateSchema.snapshot, actor), code('configuration_forbidden', 403));
});

test('custom fields remain schema scoped through view settings and private transient overrides', () => {
  const dataSchema = published(normalized(), 'schemas', schema());
  const saved = published(dataSchema.snapshot, 'filters', { ...filter(), schemaRefs: [{ id: dataSchema.resource.id, version: 1 }] });
  const savedView = published(saved.snapshot, 'views', { ...view(), filter: { id: saved.resource.id, version: 1 }, settings: { columns: [{ field: '/data/score', visible: true, width: 120 }], sort: [{ field: '/data/score', direction: 'asc' }] } });
  const applied = command(savedView.snapshot, 'views', 'apply', { version: 1 }, savedView.resource, personal);
  assert.equal(applied.effectiveSettings.values.columns[0].field, '/data/score');
  const state = effectiveSettings(applied.snapshot, { principalId: personal.id, transient: { search: { fields: ['/data/score'], text: '2' } } });
  assert.deepEqual(state.values.search.fields, ['/data/score']);
  assert.deepEqual(normalizeConfiguration(applied.snapshot, actor), applied.snapshot);
  const second = schema(); second.schema.properties.score.type = 'string';
  const another = published(savedView.snapshot, 'schemas', second);
  assert.throws(() => filterFieldTypes(another.snapshot, [{ id: dataSchema.resource.id, version: 1 }, { id: another.resource.id, version: 1 }]), code('invalid_configuration', 422));
});

test('1000 seeded metadata operations preserve old history and canonical hash under renormalization', async () => {
  let result = published(normalized(), 'groups', group());
  const history = canonicalJson(result.resource.versions);
  let seed = 13219;
  for (let index = 0; index < 1000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const old = result.snapshot;
    const oldRevision = result.resource.revision;
    result = command(old, 'groups', 'update', { name: `Group ${seed}`, tags: [`seed-${seed % 7}`] }, result.resource);
    assert.equal(result.resource.revision, oldRevision + 1);
    assert.equal(canonicalJson(result.resource.versions), history);
    assert.equal(old.groups.at(-1).revision, oldRevision);
    assert.equal(canonicalJson(normalizeConfiguration(result.snapshot, actor)), canonicalJson(result.snapshot));
  }
  const hash = await sha256(result.snapshot);
  assert.equal(await sha256(JSON.parse(canonicalJson(result.snapshot))), hash);
});
