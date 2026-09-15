import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fixture from '../../shared/fixtures/sorting-acceptance-v2.json' with { type: 'json' };
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';
import { filterFieldTypes } from '../../client/src/data/configuration-catalog.js';
import { startLegacyServer } from './legacy-server-fixture.mjs';

let server, local, remote, snapshot;
const eq = (field, value) => ({ op: 'eq', field, value });
const expression = root => ({ filters: { expression: { version: 2, root } } });
const expectedIds = aliases => aliases.map(alias => fixture.canonicalIds[alias]).sort();
const recordIds = items => items.map(item => item.record.id).sort();
const all = fixture.expected.T01.eligible;

async function waitForIndex(provider) {
  const deadline = Date.now() + 10000;
  while (!(await provider.getLoadingStatus()).complete) {
    assert.ok(Date.now() < deadline, 'Bounded exact-fixture index preparation');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
before(async () => {
  server = await startLegacyServer({ recordsBySource: fixture.recordsBySource });
  remote = new ServerProvider(server); await remote.initialize();
  snapshot = await remote.exportSnapshot(); await waitForIndex(remote);
  local = new LocalProvider(snapshot); await local.initialize();
  assert.equal(snapshot.records.length, 6);
  for (const record of snapshot.records) assert.equal(record.id, fixture.canonicalIds[record.extensions.legacy.id]);
  for (const alias of ['C1', 'C2']) {
    const child = snapshot.records.find(record => record.id === fixture.canonicalIds[alias]);
    assert.equal(child.parentSessionId, fixture.canonicalIds.P1);
    assert.equal(child.data.namespace, 'SOURCE1');
  }
  const fields = filterFieldTypes(snapshot, [{ id: snapshot.schemas[0].id, version: 1 }]);
  for (const [name, schema] of Object.entries(fixture.fieldSchema.properties)) assert.equal(fields[`/data/${name}`], schema.type);
});
after(async () => {
  try { for (const [file, bytes] of server?.originals ?? []) assert.deepEqual(await readFile(file), bytes, 'Legacy fixture authority is unchanged'); }
  finally { local?.dispose(); remote?.dispose(); await server?.stop(); }
});

async function table(provider, query, projection = 'context') {
  const items = []; let cursor;
  do {
    const page = await provider.queryRecords(query.queryId, { projection, limit: 2, cursor });
    items.push(...page.items); cursor = page.nextCursor;
    assert.ok(items.length <= 6, 'Pagination makes bounded progress without duplicate identities');
  } while (cursor);
  assert.equal(new Set(recordIds(items)).size, items.length);
  return items;
}
async function both(input, verify) {
  const queries = [];
  try {
    for (const provider of [local, remote]) queries.push(await provider.createQuery({ definitionVersion: 2, domain: fixture.domain, ...input,
      filters: { schemaRefs: [{ id: snapshot.schemas[0].id, version: 1 }], ...input.filters } }));
    const items = [await table(local, queries[0]), await table(remote, queries[1])];
    assert.deepEqual(items[0], items[1]);
    for (const field of ['baseTotal', 'matchTotal', 'overviewTotal', 'overviewMatchTotal', 'hasSearch', 'counts']) {
      if (field === 'counts') {
        for (const key of ['filterResults', 'directPredicateHits', 'searchFindings', 'contextRecords', 'visibleContextRecords', 'complete']) assert.deepEqual(queries[0].counts[key], queries[1].counts[key], key);
      } else assert.deepEqual(queries[0][field], queries[1][field], field);
    }
    assert.deepEqual(await local.getDensity(queries[0].queryId), await remote.getDensity(queries[1].queryId));
    const overview = [await local.getOverview(queries[0].queryId), await remote.getOverview(queries[1].queryId)];
    assert.equal(overview[1].coverage.complete, true);
    for (const key of ['total', 'matched', 'matchActive', 'aggregated', 'domain']) assert.deepEqual(overview[0][key], overview[1][key]);
    assert.deepEqual(overview[0].items, overview[1].items);
    const selected = new Set(overview[0].items.map(item => item.id));
    assert.deepEqual(overview[0].items.map(item => item.id), fixture.overviewTemporalOrder.map(alias => fixture.canonicalIds[alias]).filter(id => selected.has(id)));
    for (let index = 0; index < 2; index++) await verify([local, remote][index], queries[index], items[index]);
  } finally {
    for (let index = 0; index < queries.length; index++) await [local, remote][index].releaseQuery(queries[index].queryId);
  }
}
function membership(id, query, items) {
  const expectation = fixture.expected[id];
  const eligible = items.filter(item => item.provenance.role !== 'ancestor-context');
  assert.deepEqual(recordIds(eligible), expectedIds(expectation.eligible));
  assert.equal(query.baseTotal, expectation.eligible.length);
  assert.deepEqual(recordIds(items.filter(item => item.provenance.role === 'ancestor-context')), expectedIds(expectation.ancestors ?? []));
}

test('T01 empty independent filter returns exactly six unique real-adapter records', async () => {
  await both({}, async (_, query, items) => membership('T01', query, items));
});
test('T02 type inclusion returns only E1 and E2', async () => {
  await both(expression({ op: 'in', field: '/data/type', values: ['type0', 'type1'] }), async (_, query, items) => membership('T02', query, items));
});
test('T03 equality help syntax requires explicit repair; proposed equality has reviewed membership', async () => {
  await both({}, async (provider, query) => {
    const before = await provider.getStatus();
    const draft = await provider.migrateLegacyFilter(query.queryId, { include: 'status=SCHEDULE' });
    assert.equal(draft.publishable, false);
    assert.ok(draft.diagnostics.some(item => item.code === fixture.expected.T03.migrationDiagnostic));
    assert.equal((await provider.getStatus()).revision, before.revision);
    assert.equal(draft.draft.expression.root.op, 'eq');
  });
  await both(expression(eq('/data/status', 'SCHEDULE')), async (_, query, items) => membership('T03', query, items));
});
test('T04 overlapping OR branches emit E1 once', async () => {
  await both(expression({ op: 'or', args: [eq('/data/type', 'type0'), { op: 'and', args: [eq('/data/status', 'SCHEDULE'), eq('/data/type', 'type0')] }] }), async (_, query, items) => membership('T04', query, items));
});
test('T05 independent child predicate returns C1 plus P1 as separate ancestor context', async () => {
  await both(expression(eq('/data/type', 'type9')), async (_, query, items) => {
    membership('T05', query, items); assert.equal(query.counts.directPredicateHits, 1); assert.equal(query.counts.contextRecords, 1);
  });
});
test('T06 family mode keeps P1/C1/C2 while only C1 is a predicate hit', async () => {
  await both({ ...expression(eq('/data/type', 'type9')), relationshipMode: 'family' }, async (_, query, items) => {
    membership('T06', query, items);
    assert.deepEqual(recordIds(items.filter(item => item.provenance.directPredicate)), expectedIds(fixture.expected.T06.direct));
    assert.deepEqual(recordIds(items.filter(item => item.provenance.role === 'family-context')), expectedIds(fixture.expected.T06.family));
    assert.equal(query.counts.directPredicateHits, 1);
  });
});
for (const [id, input] of [
  ['T07', { search: '5_1', searchFields: ['/title'] }],
  ['T08', { search: 'SCHEDULE', searchFields: ['/data/status'] }],
  ['T09', { search: fixture.expected.T09.pattern, searchFields: ['/title'], searchMode: 'regex', searchFlags: [], searchMatchMode: 'search', searchDialect: 're2-common-v1' }],
]) test(`${id} scoped search has exact independent findings and a findings-only overview`, async () => {
  await both(input, async (provider, query, items) => {
    assert.deepEqual(recordIds(items), expectedIds(all));
    const findings = await table(provider, query, 'matches');
    assert.deepEqual(recordIds(findings), expectedIds(fixture.expected[id].matches));
    assert.equal(query.counts.searchFindings, fixture.expected[id].matches.length);
    assert.deepEqual((await provider.getOverview(query.queryId)).items.map(item => item.id).sort(), expectedIds(fixture.expected[id].matches));
    assert.equal((await provider.getZones(query.queryId)).items.length, 1);
    if (id === 'T07') {
      const yellow = items.find(item => item.record.id === fixture.canonicalIds.E2);
      assert.equal(yellow.record.render.backgroundColor, '#F8DF09'); assert.equal(yellow.match, false);
    }
  });
});
test('T10 clearing search restores all overview records without altering authored styles', async () => {
  for (const provider of [local, remote]) {
    const searched = await provider.createQuery({ definitionVersion: 2, domain: fixture.domain, search: '5_1', searchFields: ['/title'] });
    try { assert.equal(searched.counts.searchFindings, 2); } finally { await provider.releaseQuery(searched.queryId); }
  }
  await both({ search: '' }, async (provider, query, items) => {
    membership('T10', query, items); assert.equal(query.counts.searchFindings, 0);
    assert.deepEqual((await provider.getOverview(query.queryId)).items.map(item => item.id).sort(), expectedIds(all));
    assert.deepEqual(items.map(item => ({ id: item.record.id, render: item.record.render })).sort((a, b) => a.id.localeCompare(b.id)),
      snapshot.records.map(record => ({ id: record.id, render: record.render })).sort((a, b) => a.id.localeCompare(b.id)));
  });
});
for (const [id, order] of [['T11', 'codepoint'], ['T12', 'natural']]) test(`${id} namespace group ordering changes only presentation`, async () => {
  const outputs = [];
  await both({}, async (provider, query) => {
    const layout = await provider.createLayout(query.queryId, { mapId: query.mapId, ...fixture.domain, width: 1500,
      availableHeight: 160, rowHeight: 32, fontSize: 12, groupOrder: { order },
      presentation: { version: 1, grouping: { field: '/data/namespace', direction: 'asc' } } });
    const headers = [], records = []; let cursor;
    do {
      const page = await provider.getRows(query.queryId, layout.layoutId, { cursor });
      headers.push(...page.rows.filter(row => row.type === 'group' && !row.continuation).map(row => row.name));
      records.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(headers, fixture.expected[id].groups);
    assert.equal(new Set(recordIds(records)).size, 6); assert.equal(records.length, 6);
    for (const [namespace, aliases] of Object.entries(fixture.groupMembers)) assert.deepEqual(recordIds(records.filter(item => item.record.data.namespace === namespace)), expectedIds(aliases));
    outputs.push(records.map(item => ({ id: item.record.id, xStart: item.xStart, xEnd: item.xEnd })).sort((a, b) => a.id.localeCompare(b.id)));
  });
  assert.deepEqual(outputs[0], outputs[1]);
});
test('T13 real legacy date adapter and both providers use the same half-open overlap oracle', async () => {
  const dateServer = await startLegacyServer({ recordsBySource: fixture.dateRecordsBySource });
  const dateRemote = new ServerProvider(dateServer); let dateLocal;
  try {
    await dateRemote.initialize(); const dateSnapshot = await dateRemote.exportSnapshot(); await waitForIndex(dateRemote);
    dateLocal = new LocalProvider(dateSnapshot); await dateLocal.initialize();
    for (const record of dateSnapshot.records) assert.equal(record.id, fixture.canonicalIds[record.extensions.legacy.id]);
    for (const provider of [dateLocal, dateRemote]) {
      const query = await provider.createQuery({ definitionVersion: 2, domain: fixture.dateDomain });
      try { assert.deepEqual(recordIds(await table(provider, query)), expectedIds(fixture.expected.T13.eligible)); }
      finally { await provider.releaseQuery(query.queryId); }
    }
    for (const [file, bytes] of dateServer.originals) assert.deepEqual(await readFile(file), bytes);
  } finally { dateLocal?.dispose(); dateRemote.dispose(); await dateServer.stop(); }
});
test('T14 overlapping OR source scopes deduplicate identity but retain equal-title E1 and C1', async () => {
  const sourceId = snapshot.records.find(record => record.id === fixture.canonicalIds.E1).sourceId;
  await both(expression({ op: 'or', args: [eq('/sourceId', sourceId), { op: 'and', args: [eq('/sourceId', sourceId), eq('/data/namespace', 'SOURCE1')] }] }), async (_, query, items) => {
    membership('T14', query, items);
    assert.equal(items.filter(item => item.record.title === 'Activity_5_1').length, 2);
  });
});
test('T15 zero findings preserve membership, density, map domain and zones', async () => {
  for (const provider of [local, remote]) {
    const baseline = await provider.createQuery({ definitionVersion: 2, domain: fixture.domain });
    const empty = await provider.createQuery({ definitionVersion: 2, domain: fixture.domain, search: 'NO-SUCH-RECORD', searchFields: ['/title'] });
    try {
      membership('T15', empty, await table(provider, empty));
      assert.deepEqual(recordIds(await table(provider, empty, 'matches')), []);
      assert.deepEqual(await provider.getDensity(empty.queryId), await provider.getDensity(baseline.queryId));
      assert.deepEqual((await provider.getOverview(empty.queryId)).items, []);
      assert.deepEqual(await provider.getZones(empty.queryId), await provider.getZones(baseline.queryId));
      const map = await provider.getMap(empty.queryId, empty.mapId), reference = await provider.getMap(baseline.queryId, baseline.mapId);
      assert.deepEqual(map.knots, reference.knots); assert.deepEqual(map.domain, fixture.domain);
      assert.equal((await provider.getZones(empty.queryId)).items.length, 1);
    } finally { await provider.releaseQuery(baseline.queryId); await provider.releaseQuery(empty.queryId); }
  }
});
