import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { defaultConfigurationDefinition } from '../../client/src/data/configuration-catalog.js';
import { validateSnapshot, parseStrictJson } from '../../client/src/data/snapshot.js';
import { sha256 } from '../../client/src/data/data-provider.js';
import { snapshotContent } from '../../client/src/data/snapshot-content.js';

const seed = JSON.parse(await readFile(new URL('../../data/default-dataset.json', import.meta.url), 'utf8'));
let commandIndex = 0;
async function setup() { const provider = new LocalProvider(seed); await provider.initialize(); return provider; }
function command(provider, family, type, payload, resource, extras = {}) { return { family, type, payload, generation: provider.generation, clientCommandId: `configuration-${++commandIndex}`, ...(resource ? { resourceId: resource.id, expectedRevision: resource.revision } : {}), ...extras }; }
async function resource(provider, family, definition, visibility = 'workspace') {
  let result = await provider.mutateConfiguration(command(provider, family, 'create', { name: `New ${family}`, visibility, definition }));
  if (!result.resource.versions.length) result = await provider.mutateConfiguration(command(provider, family, 'publish', {}, result.resource));
  return result.resource;
}
const schemaDefinition = { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  properties: { approved: { type: 'boolean' }, score: { type: ['number', 'null'], minimum: 0 } }, required: ['approved', 'score'] } };

test('provider catalogs normalize complete sources and retain checksummed exports with immutable history', async () => {
  const provider = await setup();
  const sources = await provider.listConfiguration('sources');
  assert.deepEqual(new Set(sources.items.map(item => item.id)), new Set(seed.manifest.scope.sourceIds));
  assert.ok(sources.items.every(item => !('draft' in item) && !('versions' in item) && item.publishedVersions.length === 1));
  const group = await resource(provider, 'groups', defaultConfigurationDefinition('groups'));
  const exported = await provider.exportSnapshot();
  assert.equal(exported.manifest.contentSha256, await sha256(snapshotContent(exported)));
  assert.equal((await validateSnapshot(exported)).groups.find(item => item.id === group.id).versions.length, 1);
  exported.groups[0].name = 'Tampered';
  await assert.rejects(validateSnapshot(exported), { code: 'checksum_mismatch' });
  provider.dispose();
});

test('source policy rejects every write without hiding existing records and replay survives policy changes', async () => {
  const provider = await setup();
  let source = await resource(provider, 'sources', defaultConfigurationDefinition('sources'));
  const create = { type: 'create', generation: provider.generation, clientCommandId: 'source-record', payload: { title: 'Durable intent', sourceId: source.id, kind: 'event' } };
  const result = await provider.executeCommand(create);
  source = (await provider.mutateConfiguration(command(provider, 'sources', 'update', { draft: { storage: 'json', enabled: false, writable: false, defaultSchema: null } }, source))).resource;
  source = (await provider.mutateConfiguration(command(provider, 'sources', 'publish', {}, source))).resource;
  assert.deepEqual(await provider.executeCommand(create), result);
  for (const type of ['update', 'delete']) await assert.rejects(provider.executeCommand({ type, generation: provider.generation, recordId: result.record.id, expectedVersion: 1, clientCommandId: `denied-${type}`, payload: {} }), { code: 'source_read_only' });
  assert.equal((await provider.getRecord(result.record.id)).id, result.record.id);
  await assert.rejects(provider.mutateConfiguration(command(provider, 'sources', 'delete', {}, source)), { code: 'configuration_referenced' });
  provider.dispose();
});

test('pinned schema defaults validate record data, typed filters and immutable impact reports', async () => {
  const provider = await setup();
  const schema = await resource(provider, 'schemas', schemaDefinition);
  const source = await resource(provider, 'sources', { storage: 'json', enabled: true, writable: true, defaultSchema: { id: schema.id, version: 1 } });
  const create = { type: 'create', generation: provider.generation, clientCommandId: 'schema-record', payload: { sourceId: source.id, title: 'Approved item', start: seed.records[0].start, data: { approved: true, score: 3 } } };
  const result = await provider.executeCommand(create);
  assert.equal(result.record.schemaId, schema.id);
  assert.equal(result.record.schemaVersion, 1);
  const before = provider.revision;
  await assert.rejects(provider.executeCommand({ ...create, clientCommandId: 'invalid-schema-record', payload: { ...create.payload, data: { approved: 'yes', score: 3 } } }), { code: 'invalid_record_data' });
  assert.equal(provider.revision, before);
  const filter = await resource(provider, 'filters', { sourceIds: [source.id], kinds: ['event'], schemaRefs: [{ id: schema.id, version: 1 }], expression: { version: 1, root: { op: 'eq', field: '/data/approved', value: true } }, search: { text: 'Approved', mode: 'any', caseSensitive: false, fields: ['/title'] } });
  const query = await provider.createQuery({ domain: seed.settings.overview, filters: { filterId: filter.id, filterVersion: 1 } });
  assert.equal(query.baseTotal, 1); assert.equal(query.matchTotal, 1);
  assert.equal((await provider.getOverview(query.queryId)).items[0].id, result.record.id);
  const candidate = structuredClone(schemaDefinition); candidate.schema.properties.score.minimum = 10;
  const impact = await provider.previewSchemaImpact(schema.id, { definition: candidate });
  assert.equal(impact.totalAffected, 1); assert.equal(impact.totalInvalid, 1);
  assert.equal((await provider.getRecord(result.record.id)).data.score, 3);
  assert.equal((await provider.configurationUsage('schemas', schema.id, 1)).total, 3);
  await assert.rejects(provider.mutateConfiguration(command(provider, 'schemas', 'delete', {}, schema)), { code: 'configuration_referenced' });
  provider.dispose();
});

test('saved view apply changes only revision-checked personal settings and reset returns inherited values', async () => {
  const provider = await setup(), original = structuredClone(provider.snapshot.settings);
  const view = await resource(provider, 'views', { model: { id: original.modelId, version: original.modelVersion }, filter: null, settings: { theme: 'dark' } }, 'personal');
  const apply = command(provider, 'views', 'apply', { version: 1 }, view, { expectedPreferenceRevision: 0 });
  const applied = await provider.mutateConfiguration(apply);
  assert.equal(applied.effectiveSettings.values.theme, 'dark');
  assert.deepEqual(provider.snapshot.settings, original);
  assert.deepEqual(await provider.mutateConfiguration(apply), applied);
  await assert.rejects(provider.mutateConfiguration({ ...apply, clientCommandId: 'stale-preferences' }), { code: 'configuration_preference_revision_conflict' });
  const changed = await provider.mutateSettings({ scope: 'personal', type: 'patch', expectedRevision: 1, generation: provider.generation, clientCommandId: 'preferences-theme', payload: { theme: 'light' } });
  assert.equal(changed.effectiveSettings.values.theme, 'light');
  const reset = await provider.mutateSettings({ scope: 'personal', type: 'reset', expectedRevision: 2, generation: provider.generation, clientCommandId: 'preferences-reset', payload: { paths: ['/theme'] } });
  assert.equal(reset.effectiveSettings.values.theme, 'dark');
  const local = new LocalProvider(await provider.exportSnapshot()); await local.initialize();
  assert.equal((await local.getStatus()).settings.theme, 'dark');
  provider.dispose(); local.dispose();
});

test('configuration and record commands share one immutable idempotency namespace and capture queued intent', async () => {
  const provider = await setup();
  let release; provider.queue = new Promise(resolve => { release = resolve; });
  const request = command(provider, 'groups', 'create', { name: 'Captured', definition: defaultConfigurationDefinition('groups') });
  const pending = provider.mutateConfiguration(request); request.payload.name = 'Changed by caller'; release();
  const result = await pending; assert.equal(result.resource.name, 'Captured');
  await assert.rejects(provider.executeCommand({ type: 'create', generation: provider.generation, clientCommandId: request.clientCommandId, payload: { title: 'Conflicting route' } }), { code: 'idempotency_conflict' });
  assert.equal((await provider.getCommandOutcome(request.clientCommandId)).result.commandId, request.clientCommandId);
  provider.dispose();
});

test('JSON object nesting has the same 64-level boundary as arrays and rejects duplicate escaped keys', () => {
  let object = 1;
  for (let index = 0; index < 64; index++) object = { a: object };
  assert.equal(JSON.stringify(parseStrictJson(JSON.stringify(object))), JSON.stringify(object));
  assert.throws(() => parseStrictJson(JSON.stringify({ a: object })), /64 levels/);
  assert.throws(() => parseStrictJson('{"a":1,"\u0061":2}'), /Duplicate/);
});
