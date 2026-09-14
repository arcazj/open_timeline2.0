import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { sha256 } from '../../client/src/data/data-provider.js';
import { snapshotContent } from '../../client/src/data/snapshot-content.js';
import { configurationCommand, publishConfiguration, publishSchema, schemaPin } from './configuration-fixture.mjs';

let server, remote, local, schema, saved, alternate;
const records = [];
const domain = { from: '2032-01-01T00:00:00.000Z', to: '2032-01-02T00:00:00.000Z' };
const search = { text: '', mode: 'any', caseSensitive: false, fields: ['/title'] };
const definition = { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
  properties: { score: { type: ['number', 'null'] }, flag: { type: ['boolean', 'null'] }, label: { type: ['string', 'null'] },
    nested: { type: 'object', properties: { code: { type: 'string' } }, additionalProperties: false }, readings: { type: 'array', items: { type: 'number' } } } } };
const expression = root => ({ version: 1, root });
const queryInput = root => ({ domain, filters: { schemaRefs: [{ id: schema.id, version: 1 }], ...(root ? { expression: expression(root) } : {}) }, bins: 16, scaleMode: 'adaptive', ratio: 4 });

before(async () => {
  server = await startServer(); remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  schema = await publishConfiguration(remote, 'schemas', 'Typed parity data', definition);
  alternate = await publishSchema(remote, 'Incompatible string score', { score: { type: 'string' } });
  const data = [
    { score: 2, flag: true, label: 'Stra\u00dfe', nested: { code: 'B' }, readings: [0.1, 1e-7] },
    { score: null, flag: false, label: null }, {},
    { score: -1, flag: null, label: 'e\u0301lan', nested: { code: 'A' } },
    { score: 2, flag: true, label: '\u00c9lan' },
  ];
  for (let index = 0; index < data.length; index++) {
    records.push((await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: {
      title: `Typed parity ${index}`, start: domain.from, end: index === 4 ? domain.to : null, kind: index === 4 ? 'session' : 'event',
      sourceId: index === 3 ? 'verification' : 'operations', order: index, data: data[index], ...schemaPin(schema),
    } })).record);
  }
  saved = await publishConfiguration(remote, 'filters', 'Pinned typed filter', { sourceIds: ['operations'], kinds: ['event', 'session'],
    schemaRefs: [{ id: schema.id, version: 1 }], expression: expression({ op: 'gte', field: '/data/score', value: 0 }), search: { ...search, text: 'STRASSE', fields: ['/data/label'] } });
  local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

async function compareQuery(input, expected, { sort = [{ field: 'order', direction: 'asc' }], matches = expected } = {}) {
  const queries = [];
  try {
    for (const provider of [local, remote]) queries.push([provider, await provider.createQuery(input)]);
    const pages = [];
    for (const [provider, query] of queries) {
      let cursor; const items = [];
      do {
        const page = await provider.queryRecords(query.queryId, { sort, limit: 2, cursor }); items.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(items.map(item => item.record.id), expected.map(index => records[index].id));
      assert.deepEqual(items.filter(item => item.match).map(item => item.record.id), matches.map(index => records[index].id));
      pages.push(items);
    }
    assert.deepEqual(pages[0], pages[1]);
    assert.deepEqual(queries[0][1].fieldTypes, queries[1][1].fieldTypes);
    assert.deepEqual(await local.getDensity(queries[0][1].queryId), await remote.getDensity(queries[1][1].queryId));
  } finally { for (const [provider, query] of queries) await provider.releaseQuery(query.queryId); }
}

test('published nullable schemas drive exact numeric/boolean/nested predicates and complete custom table ordering', async () => {
  const cases = [
    [{ op: 'eq', field: '/data/score', value: 2 }, [0, 4]],
    [{ op: 'in', field: '/data/score', values: [null, -1] }, [1, 3]],
    [{ op: 'not', arg: { op: 'gt', field: '/data/score', value: 0 } }, [3]],
    [{ op: 'eq', field: '/data/flag', value: false }, [1]],
    [{ op: 'not', arg: { op: 'eq', field: '/data/flag', value: true } }, [1, 3]],
    [{ op: 'exists', field: '/data/flag', value: false }, [2]],
    [{ op: 'eq', field: '/data/nested/code', value: 'A' }, [3]],
  ];
  for (const [root, ids] of cases) await compareQuery(queryInput(root), ids);
  const tied = [0, 4].sort((a, b) => records[a].id < records[b].id ? -1 : 1);
  await compareQuery(queryInput(), [3, ...tied, 1, 2], { sort: [{ field: 'data.score', direction: 'asc' }] });
  await compareQuery(queryInput(), [...tied, 3, 1, 2], { sort: [{ field: 'data.score', direction: 'desc' }] });
  await compareQuery({ ...queryInput(), search: 'strasse', searchFields: ['/data/label'] }, [0, 1, 2, 3, 4], { matches: [0] });
});

test('saved filters intersect transient source/kind/expression scope and keep their immutable schema/search publication', async () => {
  const input = { domain, filters: { filterId: saved.id, filterVersion: 1 } };
  await compareQuery(input, [0, 4], { matches: [0] });
  await compareQuery({ ...input, filters: { ...input.filters, kinds: ['event'], expression: expression({ op: 'eq', field: '/data/flag', value: true }) } }, [0]);
  await compareQuery({ ...input, filters: { ...input.filters, sourceIds: ['verification'] } }, []);
  await compareQuery({ ...input, filters: { ...input.filters, sourceIds: [] } }, []);
  await compareQuery({ ...input, search: '', filters: { ...input.filters, kind: 'session' } }, [4]);
  for (const provider of [local, remote]) {
    await assert.rejects(provider.createQuery({ ...input, filters: { ...input.filters, schemaRefs: [] } }), { code: 'invalid_filter', status: 422 });
    await assert.rejects(provider.createQuery({ ...queryInput(), filters: { schemaRefs: [{ id: schema.id, version: 1 }, { id: alternate.id, version: 1 }] } }), error => error.status === 422);
    await assert.rejects(provider.createQuery({ ...queryInput(), filters: { expression: expression({ op: 'eq', field: '/data/score', value: 2 }) } }), error => error.status === 422);
    await assert.rejects(provider.createQuery(queryInput({ op: 'eq', field: '/data/flag', value: 'false' })), error => error.status === 422);
  }
});

test('schema version history is immutable and wrong custom/built-in/unknown values never commit in either provider', async () => {
  for (const provider of [local, remote]) {
    const status = await provider.getStatus();
    for (const patch of [{ data: { score: '2' }, ...schemaPin(schema) }, { data: { flag: 1 }, ...schemaPin(schema) },
      { data: { nested: { code: 3 } }, ...schemaPin(schema) }, { data: { readings: ['2'] }, ...schemaPin(schema) },
      { data: { status: null }, ...schemaPin(schema) }, { data: { undeclared: 1 }, ...schemaPin(schema) }, { data: { score: 2 } }]) {
      await assert.rejects(provider.executeCommand({ type: 'create', generation: status.generation, clientCommandId: crypto.randomUUID(), payload: {
        title: 'Rejected typed value', kind: 'event', start: domain.from, end: null, sourceId: 'operations', ...patch,
      } }), error => error.status === 422);
    }
    assert.equal((await provider.getStatus()).revision, status.revision);
    const original = (await provider.getConfiguration('schemas', schema.id)).resource;
    const changed = structuredClone(definition); changed.schema.properties.score.maximum = 1;
    let result = await configurationCommand(provider, 'schemas', 'update', original, { draft: changed });
    result = await configurationCommand(provider, 'schemas', 'publish', result.resource);
    assert.deepEqual(result.resource.versions[0], original.versions[0]); assert.equal(result.resource.versions[1].version, 2);
    assert.deepEqual((await provider.getRecord(records[0].id)).data, records[0].data);
    await assert.rejects(provider.executeCommand({ type: 'update', recordId: records[0].id, expectedVersion: records[0].version,
      generation: status.generation, clientCommandId: crypto.randomUUID(), payload: { schemaVersion: 2 } }), error => error.status === 422);
    await assert.rejects(configurationCommand(provider, 'schemas', 'delete', result.resource), { code: 'configuration_referenced', status: 409 });
  }
});

test('all configuration families expose revisioned lifecycle, metadata-only lists and actor-bound idempotent outcomes', async () => {
  for (const provider of [local, remote]) {
    const definitions = {
      sources: { storage: 'json', enabled: true, writable: true, defaultSchema: null },
      groups: { order: 0, color: '#123456', collapsed: false }, schemas: definition,
      filters: { sourceIds: null, kinds: ['event', 'session'], schemaRefs: [], expression: null, search },
      views: { model: { id: 'light', version: 1 }, filter: null, settings: { mode: 'split' } },
    };
    for (const [family, value] of Object.entries(definitions)) {
      const before = await provider.getStatus();
      assert.equal((await provider.validateConfiguration(family, value, { visibility: 'workspace' })).valid, true);
      assert.equal((await provider.getStatus()).revision, before.revision);
      const key = crypto.randomUUID();
      let result = await configurationCommand(provider, family, 'create', null, { name: `Parity ${family}`, definition: value, visibility: 'workspace' }, { clientCommandId: key });
      const original = result.resource;
      assert.equal((await provider.getCommandOutcome(key)).state, 'committed');
      assert.equal((await configurationCommand(provider, family, 'create', null, { name: `Parity ${family}`, definition: value, visibility: 'workspace' }, { clientCommandId: key })).resource.id, original.id);
      await assert.rejects(configurationCommand(provider, family, 'create', null, { name: 'Changed replay', definition: value, visibility: 'workspace' }, { clientCommandId: key }), { status: 409, code: 'idempotency_conflict' });
      const summary = (await provider.listConfiguration(family)).items.find(item => item.id === original.id);
      assert.equal(Object.hasOwn(summary, 'draft'), false); assert.equal(Object.hasOwn(summary, 'versions'), false);
      if (!result.resource.versions.length) result = await configurationCommand(provider, family, 'publish', result.resource);
      const v1 = structuredClone(result.resource.versions[0]);
      result = await configurationCommand(provider, family, 'update', result.resource, { name: `Renamed ${family}` });
      await assert.rejects(configurationCommand(provider, family, 'update', original, { name: 'Stale edit' }), { status: 412 });
      assert.deepEqual(result.resource.versions[0], v1);
      result = await configurationCommand(provider, family, 'archive', result.resource);
      assert.equal((await provider.listConfiguration(family, { includeArchived: false })).items.some(item => item.id === original.id), false);
      result = await configurationCommand(provider, family, 'unarchive', result.resource);
      result = await configurationCommand(provider, family, 'delete', result.resource);
      assert.equal(result.resource, null);
      await assert.rejects(provider.getConfiguration(family, original.id), { status: 404 });
    }
  }
});

test('view Apply preserves shared settings, uses two revision guards, and explicit preview/reset retains provenance', async () => {
  for (const provider of [local, remote]) {
    const view = await publishConfiguration(provider, 'views', 'Personal view selection', { model: { id: 'light', version: 1 }, filter: { id: saved.id, version: 1 }, settings: { mode: 'table', fontSize: 15, rowHeight: 48 } });
    const before = await provider.exportSnapshot(), effective = await provider.getEffectiveSettings();
    const options = { expectedPreferenceRevision: effective.preferenceRevision };
    const applied = await configurationCommand(provider, 'views', 'apply', view, { version: 1 }, options);
    assert.equal(applied.effectiveSettings.values.viewId, view.id);
    assert.equal(applied.effectiveSettings.origins['/viewId'], `personal:${effective.principalId}`);
    assert.equal(applied.effectiveSettings.values.search.text, 'STRASSE');
    assert.deepEqual((await provider.exportSnapshot()).settings, before.settings);
    await assert.rejects(configurationCommand(provider, 'views', 'apply', view, { version: 1 }, options), { status: 412 });
    const preview = await provider.getEffectiveSettings({ viewId: null, viewVersion: null });
    assert.equal(preview.values.viewId, null); assert.equal(preview.values.viewVersion, null); assert.equal(preview.origins['/viewId'], 'preview');
    assert.equal((await provider.getEffectiveSettings()).values.viewId, view.id);
    const status = await provider.getStatus();
    const reset = await provider.mutateSettings({ scope: 'personal', type: 'reset', generation: status.generation, expectedRevision: applied.effectiveSettings.preferenceRevision,
      clientCommandId: crypto.randomUUID(), payload: { paths: ['/viewId', '/viewVersion', '/filterId', '/filterVersion', '/modelId', '/modelVersion'] } });
    assert.notEqual(reset.effectiveSettings.values.viewId, view.id);
    const revision = (await provider.getStatus()).revision;
    await assert.rejects(provider.mutateSettings({ scope: 'personal', type: 'reset', generation: status.generation, expectedRevision: reset.effectiveSettings.preferenceRevision,
      clientCommandId: crypto.randomUUID(), payload: { paths: ['/search/typo'] } }), { status: 422 });
    assert.equal((await provider.getStatus()).revision, revision);
  }
});

test('schema impact scans complete affected records and keeps paged analyses pinned through unrelated configuration changes', async () => {
  for (const provider of [local, remote]) {
    const input = { version: 2, limit: 2 };
    const first = await provider.previewSchemaImpact(schema.id, input);
    assert.equal(first.totalAffected, 5); assert.equal(first.totalInvalid, 2); assert.ok(first.nextCursor);
    await publishConfiguration(provider, 'groups', 'Mutation after immutable schema analysis', { order: 1, color: null, collapsed: false });
    const items = [...first.items]; let cursor = first.nextCursor;
    while (cursor) {
      const page = await provider.previewSchemaImpact(schema.id, { ...input, cursor });
      assert.equal(page.revision, first.revision); assert.equal(page.totalInvalid, 2); items.push(...page.items); cursor = page.nextCursor;
    }
    assert.deepEqual(items.map(item => item.id), records.map(item => item.id).sort());
    assert.deepEqual(items.filter(item => item.errors.length).map(item => item.id).sort(), [records[0].id, records[4].id].sort());
    for (const item of items) { assert.equal(item.schemaId, schema.id); assert.equal(item.schemaVersion, 1); assert.equal(item.deleted, false); }
  }
});

test('impact cursors bind candidate, page size and provider and expire when their bounded analysis is evicted', async () => {
  const left = await local.previewSchemaImpact(schema.id, { version: 2, limit: 2 });
  await assert.rejects(remote.previewSchemaImpact(schema.id, { version: 2, limit: 2, cursor: left.nextCursor }), { status: 400, code: 'invalid_cursor' });
  for (const provider of [local, remote]) {
    const first = await provider.previewSchemaImpact(schema.id, { version: 2, limit: 2 });
    for (const patch of [{ limit: 3 }, { version: 1 }]) {
      await assert.rejects(provider.previewSchemaImpact(schema.id, { version: 2, limit: 2, cursor: first.nextCursor, ...patch }), { status: 409 });
    }
    await assert.rejects(provider.previewSchemaImpact(schema.id, { version: 2, limit: 2, cursor: first.nextCursor + 'x' }), { status: 400, code: 'invalid_cursor' });
    const before = (await provider.getStatus()).revision;
    await assert.rejects(provider.previewSchemaImpact(schema.id, null), { status: 400, code: 'invalid_request' });
    for (const input of [{}, { version: 2, definition }, { version: '2' }, { version: 2, limit: null }, { definition: null }]) {
      await assert.rejects(provider.previewSchemaImpact(schema.id, input), { status: 422 });
    }
    assert.equal((await provider.getStatus()).revision, before);
    const copy = structuredClone(first.items); first.items[0].errors.push({ message: 'Caller mutation' });
    const continued = await provider.previewSchemaImpact(schema.id, { version: 2, limit: 2, cursor: first.nextCursor });
    assert.equal(continued.items.some(item => item.errors.some(error => error.message === 'Caller mutation')), false);
    assert.notDeepEqual(first.items, copy);
    await provider.previewSchemaImpact(schema.id, { version: 1, limit: 2 });
    await provider.previewSchemaImpact(schema.id, { version: 2, limit: 2 });
    await assert.rejects(provider.previewSchemaImpact(schema.id, { version: 2, limit: 2, cursor: first.nextCursor }), { status: 409 });
  }
});

test('expanded portable checksums and immutable catalog publications survive export/import and server restart', async () => {
  const before = await remote.exportSnapshot();
  assert.equal(before.manifest.contentSha256, await sha256(snapshotContent(before)));
  const imported = new LocalProvider(before); await imported.initialize();
  try {
    for (const family of ['sources', 'groups', 'schemas', 'filters', 'views']) {
      assert.deepEqual((await imported.exportSnapshot())[family], before[family]);
    }
  } finally { imported.dispose(); }
  await server.restart(); await remote.initialize();
  const after = await remote.exportSnapshot();
  for (const key of ['sources', 'groups', 'schemas', 'filters', 'views', 'preferences', 'defaults', 'records']) assert.deepEqual(after[key], before[key], key);
  const tampered = structuredClone(after); tampered.schemas[0].versions[0].definition.schema.title = 'Tampered';
  const invalid = new LocalProvider(tampered);
  try { await assert.rejects(invalid.initialize(), /integrity|checksum/i); } finally { invalid.dispose(); }
});
