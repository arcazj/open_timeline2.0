import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-fixture.mjs';
import { LocalProvider } from '../../client/src/data/local-provider.js';
import { ServerProvider } from '../../client/src/data/server-provider.js';

let server, local, remote;
const records = {};
const domain = { from: '2031-01-01T10:00:00.000Z', to: '2031-01-01T11:00:00.000Z' };
before(async () => {
  server = await startServer(); remote = new ServerProvider({ baseUrl: server.baseUrl, token: server.token }); await remote.initialize();
  for (const [alias, parent, sourceId] of [['P', null, 'operations'], ['C1', 'P', 'operations'], ['C2', 'P', 'operations'], ['E', null, 'verification']]) {
    records[alias] = (await remote.executeCommand({ type: 'create', generation: remote.metadata.generation, clientCommandId: crypto.randomUUID(), payload: {
      title: alias, kind: 'session', start: domain.from, end: domain.to, sourceId, parentSessionId: parent ? records[parent].id : null,
    } })).record;
  }
  local = new LocalProvider(await remote.exportSnapshot()); await local.initialize();
});
after(async () => { local?.dispose(); remote?.dispose(); await server?.stop(); });

const request = extra => ({ definitionVersion: 2, domain, filters: { expression: { version: 1, root: { op: 'eq', field: '/title', value: 'C1' } } }, search: 'C1', ...extra });
test('v2 providers agree on exact independent/family memberships, counts, density and pinned descriptor context', async () => {
  for (const mode of ['independent', 'family']) {
    const left = await local.createQuery(request({ relationshipMode: mode })), right = await remote.createQuery(request({ relationshipMode: mode }));
    try {
      for (const key of ['definitionVersion', 'relationshipMode', 'baseTotal', 'matchTotal', 'overviewTotal', 'overviewMatchTotal']) assert.deepEqual(left[key], right[key], key);
      assert.equal(left.baseTotal, mode === 'family' ? 3 : 1); assert.equal(left.matchTotal, 1);
      const l = await local.queryRecords(left.queryId), r = await remote.queryRecords(right.queryId);
      assert.deepEqual(l.items, r.items);
      assert.deepEqual(l.items.map(item => item.record.title).sort(), mode === 'family' ? ['C1', 'C2', 'P'] : ['C1', 'P']);
      assert.equal(l.baseTotal, mode === 'family' ? 3 : 1); assert.equal(l.contextTotal, mode === 'family' ? 0 : 1);
      const findings = await local.queryRecords(left.queryId, { projection: 'matches', limit: 1 });
      assert.deepEqual(findings.items.map(item => item.record.title), ['C1']);
      const ld = await local.getQueryRecord(left.queryId, records.C1.id), rd = await remote.getQueryRecord(right.queryId, records.C1.id);
      assert.deepEqual(ld, rd); assert.deepEqual(ld.ancestors.map(item => item.title), ['P']);
      assert.deepEqual(await local.getDensity(left.queryId), await remote.getDensity(right.queryId));
      assert.deepEqual(await local.getOverview(left.queryId), await remote.getOverview(right.queryId));
      assert.deepEqual((await local.getOverview(left.queryId)).items.map(item => item.title), ['C1']);
      await assert.rejects(remote.getQueryRecord(right.queryId, records.E.id), { status: 404 });
      for (const [provider, query] of [[local, left], [remote, right]]) await assert.rejects(provider.queryRecords(query.queryId, { definitionVersion: 1 }), { code: 'query_definition_mismatch' });
    } finally { await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId); }
  }
});
test('zero search findings do not remove density or context; query v1 does not accept relationship options', async () => {
  for (const provider of [local, remote]) {
    const baseline = await provider.createQuery(request()), empty = await provider.createQuery(request({ search: 'absent' }));
    try {
      assert.deepEqual(await provider.getDensity(empty.queryId), await provider.getDensity(baseline.queryId));
      assert.equal((await provider.getOverview(empty.queryId)).items.length, 0);
      assert.equal(empty.baseTotal, 1); assert.equal(empty.counts.searchFindings, 0); assert.equal(empty.counts.contextRecords, 1);
    } finally { await provider.releaseQuery(baseline.queryId); await provider.releaseQuery(empty.queryId); }
    await assert.rejects(provider.createQuery({ ...request({ relationshipMode: 'family' }), definitionVersion: 1 }), { code: 'unsupported_query_definition' });
  }
});

test('migration dry-run and cross-page findings remain identical without mutating snapshots', async () => {
  const input = { definitionVersion: 2, domain, search: 'C', searchFields: ['/title'] };
  const left = await local.createQuery(input), right = await remote.createQuery(input);
  try {
    let afterId;
    for (let index = 0; index < 3; index++) {
      const l = await local.findMatch(left.queryId, { afterId, direction: 'next' }), r = await remote.findMatch(right.queryId, { afterId, direction: 'next' });
      assert.deepEqual({ ...l, queryId: '' }, { ...r, queryId: '' });
      assert.equal(l.total, 2); assert.equal(l.wrapped, index === 2); afterId = l.record.id;
    }
    for (const draft of [{ include: 'status:Nominal' }, { include: 'status=Nominal', acknowledgements: ['help-equality-repair'] }, { include: 'title:(?=unsafe)' }]) {
      const l = await local.migrateLegacyFilter(left.queryId, draft), r = await remote.migrateLegacyFilter(right.queryId, draft);
      assert.deepEqual({ ...l, scope: {} }, { ...r, scope: {} });
    }
    assert.equal((await remote.getStatus()).revision, right.revision);
  } finally { await local.releaseQuery(left.queryId); await remote.releaseQuery(right.queryId); }
});
